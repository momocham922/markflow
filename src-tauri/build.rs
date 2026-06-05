fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" || target_os == "ios" {
        cc::Build::new()
            .file("src/audio_capture.m")
            .flag("-fobjc-arc")
            .compile("audio_capture");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
    }
    if target_os == "macos" {
        // Weak-link ScreenCaptureKit so it's optional at runtime (macOS 13+).
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=ScreenCaptureKit");
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}
