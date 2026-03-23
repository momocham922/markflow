#import <AVFoundation/AVFoundation.h>

// Returns: 1 = authorized, 0 = denied/restricted, -1 = timeout
int request_microphone_permission(void) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];

    if (status == AVAuthorizationStatusAuthorized) return 1;
    if (status == AVAuthorizationStatusDenied || status == AVAuthorizationStatusRestricted) return 0;

    // Status is NotDetermined — trigger the system permission dialog
    __block int result = -1;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        result = granted ? 1 : 0;
        dispatch_semaphore_signal(sem);
    }];

    // Wait up to 60 seconds for user to respond to the dialog
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 60LL * NSEC_PER_SEC));
    return result;
}

// Returns current authorization status without prompting:
// 0 = NotDetermined, 1 = Restricted, 2 = Denied, 3 = Authorized
int check_microphone_status(void) {
    return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}
