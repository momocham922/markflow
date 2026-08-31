#import <AVFoundation/AVFoundation.h>
#import <TargetConditionals.h>

#if TARGET_OS_OSX
#define DEVICE_TYPES @[AVCaptureDeviceTypeBuiltInMicrophone, AVCaptureDeviceTypeExternalUnknown]
#else
#define DEVICE_TYPES @[AVCaptureDeviceTypeBuiltInMicrophone]
#endif

// ── Microphone permission ──

int request_microphone_permission(void) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status == AVAuthorizationStatusAuthorized) return 1;
    if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) return 0;

    __block int result = -1;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        result = granted ? 1 : 0;
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 60LL * NSEC_PER_SEC));
    return result;
}

int check_microphone_status(void) {
    return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

// ── AVCaptureSession-based audio capture ──

static NSString *_requestedDeviceName = nil;
static NSMutableData *_audioBuf = nil;
static NSLock *_audioLock = nil;
static double _sampleRate = 0;
static char _lastError[512] = {0};

// ── Background-loss diagnostics ──
// Cumulative mono samples appended by the capture delegate. On iOS this reveals
// whether AVCaptureSession keeps delivering audio while backgrounded / screen
// off: if this keeps climbing in the background the capture layer is alive and
// any data loss is downstream (JS drain loop stall + ~120s buffer cap); if it
// plateaus, capture itself was suspended by the OS. Only the (serial) delegate
// queue mutates these, so no lock is needed for the counter itself.
static unsigned long long _totalSamplesAppended = 0;
static unsigned long long _lastLoggedSamples = 0;

const char* get_last_audio_error(void) { return _lastError; }

// Total mono samples captured since the session started (see diagnostics above).
unsigned long long get_av_total_samples(void) { return _totalSamplesAppended; }

void set_audio_device_name(const char *name) {
    _requestedDeviceName = name ? [NSString stringWithUTF8String:name] : nil;
}

// Returns JSON array of device names: ["Device1","Device2"]
const char* list_av_audio_devices(void) {
    static char buf[2048];
    AVCaptureDeviceDiscoverySession *disc = [AVCaptureDeviceDiscoverySession
        discoverySessionWithDeviceTypes:DEVICE_TYPES
        mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified];
    NSMutableArray *names = [NSMutableArray new];
    for (AVCaptureDevice *d in disc.devices) {
        [names addObject:d.localizedName];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:names options:0 error:nil];
    NSString *str = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"[]";
    strlcpy(buf, [str UTF8String], sizeof(buf));
    return buf;
}

@interface AudioDelegate : NSObject <AVCaptureAudioDataOutputSampleBufferDelegate>
@end

@implementation AudioDelegate
- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) return;

    size_t totalBytes = CMBlockBufferGetDataLength(blockBuffer);
    if (totalBytes == 0) return;

    // Get audio format info
    CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt);
    if (!asbd) return;

    char *dataPtr = NULL;
    CMBlockBufferGetDataPointer(blockBuffer, 0, NULL, NULL, &dataPtr);
    if (!dataPtr) return;

    int sampleCount;
    float tempBuf[8192];

    if (asbd->mFormatFlags & kAudioFormatFlagIsFloat) {
        // Float32
        sampleCount = (int)(totalBytes / sizeof(float));
        float *src = (float *)dataPtr;
        int channels = asbd->mChannelsPerFrame;
        if (channels > 1) {
            // Mix to mono
            int frames = sampleCount / channels;
            sampleCount = frames < 8192 ? frames : 8192;
            for (int i = 0; i < sampleCount; i++) {
                float sum = 0;
                for (int c = 0; c < channels; c++) sum += src[i * channels + c];
                tempBuf[i] = sum / channels;
            }
        } else {
            sampleCount = sampleCount < 8192 ? sampleCount : 8192;
            memcpy(tempBuf, src, sampleCount * sizeof(float));
        }
    } else if (asbd->mBitsPerChannel == 16) {
        // Int16
        int totalSamples = (int)(totalBytes / sizeof(int16_t));
        int16_t *src = (int16_t *)dataPtr;
        int channels = asbd->mChannelsPerFrame;
        int frames = totalSamples / channels;
        sampleCount = frames < 8192 ? frames : 8192;
        for (int i = 0; i < sampleCount; i++) {
            float sum = 0;
            for (int c = 0; c < channels; c++) sum += src[i * channels + c] / 32768.0f;
            tempBuf[i] = sum / channels;
        }
    } else {
        return; // unsupported format
    }

    [_audioLock lock];
    [_audioBuf appendBytes:tempBuf length:sampleCount * sizeof(float)];
    [_audioLock unlock];

    // Liveness heartbeat (~every 10s of captured audio). Watch these in
    // Console.app while backgrounded to see if capture keeps running.
    _totalSamplesAppended += (unsigned long long)sampleCount;
    double rate = _sampleRate > 0 ? _sampleRate : 44100;
    if (_totalSamplesAppended - _lastLoggedSamples >=
        (unsigned long long)(rate * 10.0)) {
        _lastLoggedSamples = _totalSamplesAppended;
        NSLog(@"[audio][capture-alive] %.1fs total captured (%.0f Hz)",
              _totalSamplesAppended / rate, rate);
    }
}
@end

#if TARGET_OS_IOS
// ── iOS: AVAudioEngine-based capture (background-capable) ──
// AVCaptureSession stops delivering audio buffers in the background even with
// UIBackgroundModes:[audio] + an active PlayAndRecord session; AVAudioEngine's
// input-node tap keeps running while backgrounded / screen-off. So iOS captures
// via the engine instead of AVCaptureSession. The C ABI (drain_av_audio_buffer /
// get_av_sample_rate / get_av_channels / get_av_total_samples) and the shared
// _audioBuf/_audioLock/_totalSamplesAppended statics are unchanged, so the Rust
// poll thread that writes the Refine archive is unaffected.
static AVAudioEngine *_engine = nil;
static id _interruptionObserver = nil;
static id _configChangeObserver = nil;
static id _mediaResetObserver = nil;
static BOOL _iosCapturing = NO;

// Append an incoming (float, possibly multi-channel, non-interleaved) PCM buffer
// as mono float into _audioBuf. Runs on the tap's realtime render thread.
static void ios_append_buffer(AVAudioPCMBuffer *pcm) {
    AVAudioFrameCount frames = pcm.frameLength;
    if (frames == 0) return;
    float * const *ch = pcm.floatChannelData;
    if (!ch) return; // non-float tap format — should not happen for the engine
    AVAudioChannelCount channels = pcm.format.channelCount;
    static float tempBuf[8192];
    AVAudioFrameCount off = 0;
    while (off < frames) {
        int n = (int)MIN((AVAudioFrameCount)8192, frames - off);
        if (channels > 1) {
            for (int i = 0; i < n; i++) {
                float sum = 0;
                for (AVAudioChannelCount c = 0; c < channels; c++) sum += ch[c][off + i];
                tempBuf[i] = sum / (float)channels;
            }
        } else {
            memcpy(tempBuf, ch[0] + off, (size_t)n * sizeof(float));
        }
        [_audioLock lock];
        [_audioBuf appendBytes:tempBuf length:(NSUInteger)n * sizeof(float)];
        [_audioLock unlock];
        _totalSamplesAppended += (unsigned long long)n;
        off += (AVAudioFrameCount)n;
    }
    double rate = _sampleRate > 0 ? _sampleRate : 44100;
    if (_totalSamplesAppended - _lastLoggedSamples >= (unsigned long long)(rate * 10.0)) {
        _lastLoggedSamples = _totalSamplesAppended;
        NSLog(@"[audio][capture-alive] %.1fs total captured (%.0f Hz)",
              _totalSamplesAppended / rate, rate);
    }
}

// (Re)install the input tap on the current hardware format and start the engine.
// Sets _sampleRate on success; writes _lastError and returns NO on failure.
static BOOL ios_install_tap_and_start(void) {
    if (!_engine) return NO;
    AVAudioInputNode *input = _engine.inputNode;
    AVAudioFormat *fmt = [input inputFormatForBus:0];
    if (!fmt || fmt.sampleRate <= 0) {
        strlcpy(_lastError, "マイク入力フォーマットを取得できません（他のアプリがマイクを使用中の可能性）", sizeof(_lastError));
        return NO;
    }
    _sampleRate = fmt.sampleRate;
    @try { [input removeTapOnBus:0]; } @catch (__unused NSException *e) {}
    [input installTapOnBus:0 bufferSize:4096 format:fmt
                     block:^(AVAudioPCMBuffer *buf, __unused AVAudioTime *when) {
        ios_append_buffer(buf);
    }];
    [_engine prepare];
    NSError *startErr = nil;
    if (![_engine startAndReturnError:&startErr]) {
        snprintf(_lastError, sizeof(_lastError), "AVAudioEngine起動失敗: %s",
                 startErr ? [[startErr localizedDescription] UTF8String] : "unknown");
        return NO;
    }
    return YES;
}
#else
static AVCaptureSession *_session = nil;
static AudioDelegate *_delegate = nil;
#endif

// Returns: 1=OK, 0=permission, -1=no device, -2=session error, -3=exception
int start_av_audio_capture(void) {
#if TARGET_OS_IOS
    if (_iosCapturing && _engine && _engine.isRunning) return 1;

    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status != AVAuthorizationStatusAuthorized) {
        snprintf(_lastError, sizeof(_lastError), "Permission status: %d", (int)status);
        return 0;
    }

    // PlayAndRecord + UIBackgroundModes:[audio] keeps the mic alive while
    // backgrounded / screen-off; the engine tap keeps delivering (the reason we
    // use AVAudioEngine instead of AVCaptureSession on iOS).
    NSError *sessionErr = nil;
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    [audioSession setCategory:AVAudioSessionCategoryPlayAndRecord
                         mode:AVAudioSessionModeDefault
                      options:AVAudioSessionCategoryOptionDefaultToSpeaker |
                              AVAudioSessionCategoryOptionAllowBluetooth
                        error:&sessionErr];
    if (sessionErr) NSLog(@"[audio] setCategory error: %@", sessionErr);
    sessionErr = nil;
    [audioSession setActive:YES error:&sessionErr];
    if (sessionErr) {
        snprintf(_lastError, sizeof(_lastError), "AVAudioSession setActive失敗: %s",
                 [[sessionErr localizedDescription] UTF8String]);
        return -2;
    }

    @try {
        _audioBuf = [NSMutableData new];
        _audioLock = [NSLock new];
        _totalSamplesAppended = 0;
        _lastLoggedSamples = 0;
        _engine = [[AVAudioEngine alloc] init];

        if (!ios_install_tap_and_start()) {
            _engine = nil;
            return -2;
        }
        _iosCapturing = YES;

        // Restart the engine when an interruption (phone call, Siri) ends.
        _interruptionObserver = [[NSNotificationCenter defaultCenter]
            addObserverForName:AVAudioSessionInterruptionNotification
                        object:audioSession
                         queue:[NSOperationQueue mainQueue]
                    usingBlock:^(NSNotification *note) {
            NSUInteger type = [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
            if (type == AVAudioSessionInterruptionTypeBegan) {
                NSLog(@"[audio] interruption began — paused by system");
            } else if (type == AVAudioSessionInterruptionTypeEnded && _iosCapturing) {
                NSError *e = nil;
                [[AVAudioSession sharedInstance] setActive:YES error:&e];
                if (_engine && !_engine.isRunning) {
                    if (ios_install_tap_and_start())
                        NSLog(@"[audio] engine restarted after interruption");
                    else
                        NSLog(@"[audio] engine restart after interruption failed: %s", _lastError);
                }
            }
        }];

        // Route/config change (headphones, Bluetooth) stops rendering — reinstall
        // the tap on the new input format and restart. object:nil so the observer
        // survives an engine rebuild (media reset) without re-registration.
        _configChangeObserver = [[NSNotificationCenter defaultCenter]
            addObserverForName:AVAudioEngineConfigurationChangeNotification
                        object:nil
                         queue:[NSOperationQueue mainQueue]
                    usingBlock:^(__unused NSNotification *note) {
            if (!_iosCapturing || !_engine) return;
            NSLog(@"[audio] engine configuration changed — reinstalling tap");
            @try { if (_engine.isRunning) [_engine stop]; } @catch (__unused NSException *e) {}
            if (!ios_install_tap_and_start())
                NSLog(@"[audio] engine restart after config change failed: %s", _lastError);
        }];

        // Media services reset (rare) — rebuild session + engine.
        _mediaResetObserver = [[NSNotificationCenter defaultCenter]
            addObserverForName:AVAudioSessionMediaServicesWereResetNotification
                        object:nil
                         queue:[NSOperationQueue mainQueue]
                    usingBlock:^(__unused NSNotification *note) {
            if (!_iosCapturing) return;
            NSLog(@"[audio] media services reset — rebuilding engine");
            NSError *e = nil;
            AVAudioSession *s = [AVAudioSession sharedInstance];
            [s setCategory:AVAudioSessionCategoryPlayAndRecord
                      mode:AVAudioSessionModeDefault
                   options:AVAudioSessionCategoryOptionDefaultToSpeaker |
                           AVAudioSessionCategoryOptionAllowBluetooth error:&e];
            [s setActive:YES error:&e];
            _engine = [[AVAudioEngine alloc] init];
            if (!ios_install_tap_and_start())
                NSLog(@"[audio] engine rebuild after media reset failed: %s", _lastError);
        }];

        NSLog(@"[audio] AVAudioEngine started: %.0f Hz (background-capable)", _sampleRate);
        return 1;
    } @catch (NSException *e) {
        NSString *msg = [NSString stringWithFormat:@"%@: %@", e.name, e.reason];
        strlcpy(_lastError, [msg UTF8String], sizeof(_lastError));
        _engine = nil;
        _iosCapturing = NO;
        return -3;
    }
#else
    // ===== macOS: AVCaptureSession (unchanged) =====
    if (_session && _session.isRunning) return 1;

    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status != AVAuthorizationStatusAuthorized) {
        snprintf(_lastError, sizeof(_lastError), "Permission status: %d", (int)status);
        return 0;
    }

    @try {
        _audioBuf = [NSMutableData new];
        _audioLock = [NSLock new];
        _totalSamplesAppended = 0;
        _lastLoggedSamples = 0;

        AVCaptureDevice *mic = nil;
        NSString *requestedDevice = _requestedDeviceName;
        if (requestedDevice.length > 0) {
            // Find specific device by name
            AVCaptureDeviceDiscoverySession *disc = [AVCaptureDeviceDiscoverySession
                discoverySessionWithDeviceTypes:DEVICE_TYPES
                mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified];
            for (AVCaptureDevice *d in disc.devices) {
                if ([d.localizedName isEqualToString:requestedDevice]) { mic = d; break; }
            }
        }
        if (!mic) {
            mic = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
        }
        if (!mic) {
            AVCaptureDeviceDiscoverySession *disc = [AVCaptureDeviceDiscoverySession
                discoverySessionWithDeviceTypes:DEVICE_TYPES
                mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified];
            mic = disc.devices.firstObject;
        }
        if (!mic) {
            strlcpy(_lastError, "マイクが見つかりません。外部マイクを接続するか、iPhoneを近づけてContinuity Microphoneを有効にしてください。", sizeof(_lastError));
            return -1;
        }
        NSLog(@"[audio] Device: %@", mic.localizedName);

        NSError *err = nil;
        AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:mic error:&err];
        if (!input) {
            snprintf(_lastError, sizeof(_lastError), "Input error: %s", [[err localizedDescription] UTF8String]);
            return -2;
        }

        AVCaptureAudioDataOutput *output = [[AVCaptureAudioDataOutput alloc] init];
        _delegate = [[AudioDelegate alloc] init];
        dispatch_queue_t queue = dispatch_queue_create("com.markflow.audio", DISPATCH_QUEUE_SERIAL);
        [output setSampleBufferDelegate:_delegate queue:queue];

        _session = [[AVCaptureSession alloc] init];
        if ([_session canAddInput:input]) [_session addInput:input];
        else {
            strlcpy(_lastError, "Cannot add audio input to session", sizeof(_lastError));
            return -2;
        }
        if ([_session canAddOutput:output]) [_session addOutput:output];
        else {
            strlcpy(_lastError, "Cannot add audio output to session", sizeof(_lastError));
            return -2;
        }

        // Get sample rate from device format (formatDescription returns CF type directly, no bridging needed)
        CMFormatDescriptionRef fmtDesc = mic.activeFormat.formatDescription;
        const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc);
        _sampleRate = asbd ? asbd->mSampleRate : 44100;

        [_session startRunning];
        NSLog(@"[audio] AVCaptureSession started: %.0f Hz, device=%@", _sampleRate, mic.localizedName);
        return 1;
    } @catch (NSException *e) {
        NSString *msg = [NSString stringWithFormat:@"%@: %@", e.name, e.reason];
        strlcpy(_lastError, [msg UTF8String], sizeof(_lastError));
        _session = nil;
        return -3;
    }
#endif
}

int drain_av_audio_buffer(float *dest, int maxSamples) {
    if (!_audioBuf || !_audioLock) return 0;
    [_audioLock lock];
    int available = (int)(_audioBuf.length / sizeof(float));
    int toCopy = available < maxSamples ? available : maxSamples;
    if (toCopy > 0) {
        memcpy(dest, _audioBuf.bytes, toCopy * sizeof(float));
        [_audioBuf replaceBytesInRange:NSMakeRange(0, toCopy * sizeof(float)) withBytes:NULL length:0];
    }
    [_audioLock unlock];
    return toCopy;
}

double get_av_sample_rate(void) { return _sampleRate; }
int get_av_channels(void) { return 1; } // always mono output

void stop_av_audio_capture(void) {
#if TARGET_OS_IOS
    _iosCapturing = NO;
    if (_engine) {
        @try {
            [_engine.inputNode removeTapOnBus:0];
            if (_engine.isRunning) [_engine stop];
        } @catch (NSException *e) {
            NSLog(@"[audio] engine stop exception: %@", e);
        }
        _engine = nil;
    }
    if (_interruptionObserver) {
        [[NSNotificationCenter defaultCenter] removeObserver:_interruptionObserver];
        _interruptionObserver = nil;
    }
    if (_configChangeObserver) {
        [[NSNotificationCenter defaultCenter] removeObserver:_configChangeObserver];
        _configChangeObserver = nil;
    }
    if (_mediaResetObserver) {
        [[NSNotificationCenter defaultCenter] removeObserver:_mediaResetObserver];
        _mediaResetObserver = nil;
    }
    NSError *err = nil;
    [[AVAudioSession sharedInstance] setActive:NO
                                   withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                         error:&err];
    NSLog(@"[audio] AVAudioEngine stopped");
#else
    if (_session) {
        [_session stopRunning];
        _session = nil;
        _delegate = nil;
        NSLog(@"[audio] AVCaptureSession stopped");
    }
#endif
    [_audioLock lock];
    [_audioBuf setLength:0];
    [_audioLock unlock];
}
