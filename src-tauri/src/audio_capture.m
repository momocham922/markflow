#import <AVFoundation/AVFoundation.h>

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

// ── AVAudioEngine-based audio capture ──

static AVAudioEngine *_engine = nil;
static NSMutableData *_audioBuf = nil;
static NSLock *_audioLock = nil;
static double _sampleRate = 0;
static int _channels = 0;
static char _lastError[512] = {0};

const char* get_last_audio_error(void) { return _lastError; }

// Returns: 1=OK, 0=permission denied, -1=bad format, -2=engine start fail, -3=exception
int start_av_audio_capture(void) {
    if (_engine) return 1;

    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    NSLog(@"[audio] Mic permission status: %d", (int)status);
    if (status != AVAuthorizationStatusAuthorized) {
        NSLog(@"[audio] Microphone not authorized (status=%d)", (int)status);
        return 0;
    }

    @try {
        _engine = [[AVAudioEngine alloc] init];
        _audioBuf = [NSMutableData new];
        _audioLock = [NSLock new];

        // Force engine to build its internal graph (input → mixer → output)
        AVAudioMixerNode *mixer = [_engine mainMixerNode];
        mixer.outputVolume = 0;

        AVAudioInputNode *input = [_engine inputNode];
        AVAudioFormat *fmt = [input outputFormatForBus:0];
        NSLog(@"[audio] Format: %@", fmt);
        if (!fmt || fmt.sampleRate == 0) {
            strlcpy(_lastError, "No valid audio format", sizeof(_lastError));
            _engine = nil;
            return -1;
        }
        _sampleRate = fmt.sampleRate;
        _channels = 1;

        [input installTapOnBus:0 bufferSize:4096 format:nil
            block:^(AVAudioPCMBuffer *buffer, __unused AVAudioTime *when) {
                if (!buffer.floatChannelData) return;
                float *ch0 = buffer.floatChannelData[0];
                NSUInteger frames = buffer.frameLength;
                [_audioLock lock];
                [_audioBuf appendBytes:ch0 length:frames * sizeof(float)];
                [_audioLock unlock];
            }];

        [_engine prepare];
        NSError *err = nil;
        if (![_engine startAndReturnError:&err]) {
            NSString *msg = [NSString stringWithFormat:@"%@ (code=%ld)", err.localizedDescription, (long)err.code];
            NSLog(@"[audio] AVAudioEngine start failed: %@", msg);
            strlcpy(_lastError, [msg UTF8String], sizeof(_lastError));
            [[_engine inputNode] removeTapOnBus:0];
            _engine = nil;
            return -2;
        }
        NSLog(@"[audio] AVAudioEngine started: %.0f Hz, %d ch", _sampleRate, _channels);
        return 1;
    } @catch (NSException *e) {
        NSString *msg = [NSString stringWithFormat:@"%@: %@", e.name, e.reason];
        NSLog(@"[audio] AVAudioEngine exception: %@", msg);
        strlcpy(_lastError, [msg UTF8String], sizeof(_lastError));
        _engine = nil;
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
int get_av_channels(void) { return _channels; }

void stop_av_audio_capture(void) {
    if (!_engine) return;
    [[_engine inputNode] removeTapOnBus:0];
    [_engine stop];
    _engine = nil;
    [_audioLock lock];
    [_audioBuf setLength:0];
    [_audioLock unlock];
    NSLog(@"[audio] AVAudioEngine stopped");
}
