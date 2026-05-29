fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        cc::Build::new()
            .file("src/mic_permission.m")
            .flag("-fobjc-arc")
            .compile("mic_permission");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        // Weak-link ScreenCaptureKit so it's optional at runtime (macOS 13+).
        // Without this, the app crashes on launch on macOS < 13.
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=ScreenCaptureKit");
    }

    tauri_build::build()
}
