fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        cc::Build::new()
            .file("src/audio_capture.m")
            .flag("-fobjc-arc")
            .compile("audio_capture");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        // Weak-link ScreenCaptureKit so it's optional at runtime (macOS 13+).
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=ScreenCaptureKit");
        // screencapturekit crate depends on Swift concurrency runtime.
        // Add rpath so the dynamic linker can find libswift_Concurrency.dylib.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}
