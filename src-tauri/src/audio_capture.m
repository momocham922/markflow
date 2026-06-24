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

const char* get_last_audio_error(void) { return _lastError; }

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
}
@end

static AVCaptureSession *_session = nil;
static AudioDelegate *_delegate = nil;

// Returns: 1=OK, 0=permission, -1=no device, -2=session error, -3=exception
int start_av_audio_capture(void) {
    if (_session && _session.isRunning) return 1;

    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status != AVAuthorizationStatusAuthorized) {
        snprintf(_lastError, sizeof(_lastError), "Permission status: %d", (int)status);
        return 0;
    }

#if TARGET_OS_IOS
    // Configure AVAudioSession for background recording + screen-off
    NSError *sessionErr = nil;
    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    [audioSession setCategory:AVAudioSessionCategoryPlayAndRecord
                  withOptions:AVAudioSessionCategoryOptionDefaultToSpeaker |
                              AVAudioSessionCategoryOptionAllowBluetooth
                        error:&sessionErr];
    if (sessionErr) {
        NSLog(@"[audio] AVAudioSession setCategory error: %@", sessionErr);
    }
    [audioSession setActive:YES error:&sessionErr];
    if (sessionErr) {
        NSLog(@"[audio] AVAudioSession setActive error: %@", sessionErr);
    }
    NSLog(@"[audio] AVAudioSession configured for background recording");
#endif

    @try {
        _audioBuf = [NSMutableData new];
        _audioLock = [NSLock new];

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

        // Get sample rate from device format
        CMFormatDescriptionRef fmtDesc = (CMFormatDescriptionRef)CFBridgingRetain(mic.activeFormat.formatDescription);
        // Note: we retain then immediately use, no need to release since ARC manages the source
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
    if (_session) {
        [_session stopRunning];
        _session = nil;
        _delegate = nil;
        NSLog(@"[audio] AVCaptureSession stopped");
    }
#if TARGET_OS_IOS
    NSError *err = nil;
    [[AVAudioSession sharedInstance] setActive:NO
                                   withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                         error:&err];
#endif
    [_audioLock lock];
    [_audioBuf setLength:0];
    [_audioLock unlock];
}
