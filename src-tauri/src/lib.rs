use tauri::Emitter;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri_plugin_updater::UpdaterExt;

/// Flag set by frontend to indicate it's alive and handling updates itself.
/// If this remains false after a timeout, Rust auto-installs any available update.
static FRONTEND_ALIVE: AtomicBool = AtomicBool::new(false);

/// Pending OAuth code from iOS in-webview flow
static PENDING_OAUTH_CODE: Mutex<Option<String>> = Mutex::new(None);

/// Open SFSafariViewController on iOS using ObjC runtime
#[cfg(target_os = "ios")]
static SAFARI_VC: Mutex<Option<usize>> = Mutex::new(None);

#[cfg(target_os = "ios")]
#[link(name = "System", kind = "dylib")]
extern "C" {
    fn dispatch_async_f(queue: *mut std::ffi::c_void, context: *mut std::ffi::c_void, work: extern "C" fn(*mut std::ffi::c_void));
}

#[cfg(target_os = "ios")]
extern "C" {
    // dispatch_get_main_queue is actually _dispatch_main_q (a global variable)
    #[link_name = "_dispatch_main_q"]
    static _dispatch_main_q: std::ffi::c_void;
}

#[cfg(target_os = "ios")]
fn get_main_queue() -> *mut std::ffi::c_void {
    unsafe { &_dispatch_main_q as *const _ as *mut _ }
}

/// UIEdgeInsets for ObjC interop
#[cfg(target_os = "ios")]
#[repr(C)]
#[derive(Copy, Clone)]
struct UIEdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

#[cfg(target_os = "ios")]
unsafe impl objc2::encode::Encode for UIEdgeInsets {
    const ENCODING: objc2::encode::Encoding = objc2::encode::Encoding::Struct(
        "UIEdgeInsets",
        &[
            objc2::encode::Encoding::Double,
            objc2::encode::Encoding::Double,
            objc2::encode::Encoding::Double,
            objc2::encode::Encoding::Double,
        ],
    );
}

#[cfg(target_os = "ios")]
unsafe impl objc2::encode::RefEncode for UIEdgeInsets {
    const ENCODING_REF: objc2::encode::Encoding =
        objc2::encode::Encoding::Pointer(&<Self as objc2::encode::Encode>::ENCODING);
}

/// Negate the bottom safe area inset so the WKWebView extends behind the home indicator.
/// This eliminates the gap between the app content and the physical screen bottom.
#[cfg(target_os = "ios")]
extern "C" fn setup_fullscreen_webview_work(_ctx: *mut std::ffi::c_void) {
    use objc2::runtime::{AnyObject, Bool as ObjcBool};
    use objc2::msg_send;
    use std::ptr;

    unsafe {
        let app: *mut AnyObject = msg_send![objc2::class!(UIApplication), sharedApplication];
        if app.is_null() { return; }

        let scenes: *mut AnyObject = msg_send![app, connectedScenes];
        let enumerator: *mut AnyObject = msg_send![scenes, objectEnumerator];
        let mut root_vc: *mut AnyObject = ptr::null_mut();

        loop {
            let scene: *mut AnyObject = msg_send![enumerator, nextObject];
            if scene.is_null() { break; }
            let windows: *mut AnyObject = msg_send![scene, windows];
            let count: usize = msg_send![windows, count];
            for i in 0..count {
                let window: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                let is_key: ObjcBool = msg_send![window, isKeyWindow];
                if is_key.as_bool() {
                    root_vc = msg_send![window, rootViewController];
                    break;
                }
            }
            if !root_vc.is_null() { break; }
        }

        if root_vc.is_null() { return; }

        let view: *mut AnyObject = msg_send![root_vc, view];
        if view.is_null() { return; }

        let insets: UIEdgeInsets = msg_send![view, safeAreaInsets];

        // Set negative bottom to cancel out the device safe area
        let additional = UIEdgeInsets {
            top: 0.0,
            left: 0.0,
            bottom: -insets.bottom,
            right: 0.0,
        };
        let _: () = msg_send![root_vc, setAdditionalSafeAreaInsets: additional];

        let _: () = msg_send![view, setNeedsLayout];
        let _: () = msg_send![view, layoutIfNeeded];
    }
}

#[cfg(target_os = "ios")]
extern "C" fn present_safari_vc_work(ctx: *mut std::ffi::c_void) {
    use objc2::runtime::{AnyObject, Bool as ObjcBool};
    use objc2::msg_send;
    use std::ptr;

    let svc = ctx as *mut AnyObject;
    unsafe {
        let app: *mut AnyObject = msg_send![objc2::class!(UIApplication), sharedApplication];
        let scenes: *mut AnyObject = msg_send![app, connectedScenes];
        let enumerator: *mut AnyObject = msg_send![scenes, objectEnumerator];
        let mut root_vc: *mut AnyObject = ptr::null_mut();

        loop {
            let scene: *mut AnyObject = msg_send![enumerator, nextObject];
            if scene.is_null() { break; }
            let windows: *mut AnyObject = msg_send![scene, windows];
            let count: usize = msg_send![windows, count];
            for i in 0..count {
                let window: *mut AnyObject = msg_send![windows, objectAtIndex: i];
                let is_key: ObjcBool = msg_send![window, isKeyWindow];
                if is_key.as_bool() {
                    root_vc = msg_send![window, rootViewController];
                    break;
                }
            }
            if !root_vc.is_null() { break; }
        }

        if root_vc.is_null() { return; }

        // Find topmost presented VC
        loop {
            let presented: *mut AnyObject = msg_send![root_vc, presentedViewController];
            if presented.is_null() { break; }
            root_vc = presented;
        }

        let _: () = msg_send![root_vc, presentViewController: svc animated: ObjcBool::YES completion: ptr::null::<AnyObject>()];
    }
}

#[cfg(target_os = "ios")]
extern "C" fn dismiss_vc_work(ctx: *mut std::ffi::c_void) {
    use objc2::runtime::{AnyObject, Bool as ObjcBool};
    use objc2::msg_send;
    let svc = ctx as *mut AnyObject;
    unsafe {
        let _: () = msg_send![svc, dismissViewControllerAnimated: ObjcBool::YES completion: std::ptr::null::<AnyObject>()];
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn open_safari_vc(url: String) {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::NSString;

    let url_str = NSString::from_str(&url);
    let ns_url: *mut AnyObject = unsafe { msg_send![objc2::class!(NSURL), URLWithString: &*url_str] };
    if ns_url.is_null() { return; }

    let svc_class = AnyClass::get(c"SFSafariViewController").unwrap();
    let svc: *mut AnyObject = unsafe { msg_send![svc_class, alloc] };
    let svc: *mut AnyObject = unsafe { msg_send![svc, initWithURL: ns_url] };
    if svc.is_null() { return; }

    *SAFARI_VC.lock().unwrap() = Some(svc as usize);

    unsafe {
        dispatch_async_f(get_main_queue(), svc as *mut std::ffi::c_void, present_safari_vc_work);
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn dismiss_safari_vc() {
    let svc_ptr = SAFARI_VC.lock().unwrap().take();
    if let Some(ptr) = svc_ptr {
        unsafe {
            dispatch_async_f(get_main_queue(), ptr as *mut std::ffi::c_void, dismiss_vc_work);
        }
    }
}

// Desktop stubs
#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn open_safari_vc(_url: String) {}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
fn dismiss_safari_vc() {}

#[derive(serde::Serialize, Default)]
struct OgpData {
    title: String,
    description: String,
    image: String,
    site_name: String,
    url: String,
}

/// Extract content from an OGP meta tag: <meta property="og:X" content="Y">
fn extract_og_tag(html: &str, property: &str) -> String {
    let patterns = [
        format!(r#"property="{}" content=""#, property),
        format!(r#"property='{}' content='"#, property),
        format!(r#"content=" property="{}""#, property),
        // name= variant (used by some sites for description)
        format!(r#"name="{}" content=""#, property),
    ];
    for pat in &patterns {
        if let Some(start) = html.find(pat.as_str()) {
            let after = &html[start + pat.len()..];
            let quote = if pat.contains('"') { '"' } else { '\'' };
            if let Some(end) = after.find(quote) {
                return html_decode(&after[..end]);
            }
        }
    }
    String::new()
}

/// Decode basic HTML entities
fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

/// Extract <title> tag content as fallback
fn extract_title(html: &str) -> String {
    if let Some(start) = html.find("<title") {
        let after = &html[start..];
        if let Some(tag_end) = after.find('>') {
            let content = &after[tag_end + 1..];
            if let Some(close) = content.find("</title") {
                return html_decode(content[..close].trim());
            }
        }
    }
    String::new()
}

#[tauri::command]
async fn fetch_ogp(url: String) -> Result<OgpData, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("User-Agent", "MarkFlow/1.0 (OGP Fetcher)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    // Only parse HTML responses
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if !content_type.contains("text/html") {
        return Err("Not an HTML page".into());
    }

    // Read up to 100KB to find OGP tags (they're in <head>)
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let html = String::from_utf8_lossy(&bytes[..bytes.len().min(100_000)]);

    let og_title = extract_og_tag(&html, "og:title");
    let og_desc = extract_og_tag(&html, "og:description");
    let og_image = extract_og_tag(&html, "og:image");
    let og_site = extract_og_tag(&html, "og:site_name");
    let og_url = extract_og_tag(&html, "og:url");

    // Fallbacks
    let title = if og_title.is_empty() { extract_title(&html) } else { og_title };
    let description = if og_desc.is_empty() {
        extract_og_tag(&html, "description")
    } else {
        og_desc
    };

    Ok(OgpData {
        title,
        description,
        image: og_image,
        site_name: og_site,
        url: if og_url.is_empty() { url } else { og_url },
    })
}

#[tauri::command]
async fn oauth_listen(app: tauri::AppHandle, ios: Option<bool>) -> Result<u16, String> {
    let port: u16 = 19847;
    let is_ios = ios.unwrap_or(false);
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind port {}: {}", port, e))?;

    listener
        .set_nonblocking(false)
        .map_err(|e| format!("Failed to set blocking: {}", e))?;

    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            if let Ok(n) = stream.read(&mut buf) {
                let request = String::from_utf8_lossy(&buf[..n]);
                if let Some(query_start) = request.find("/callback?") {
                    let query_part = &request[query_start + 10..];
                    if let Some(end) = query_part.find(' ') {
                        let query_str = &query_part[..end];
                        let mut code = None;
                        let mut error = None;
                        for param in query_str.split('&') {
                            let mut kv = param.splitn(2, '=');
                            match (kv.next(), kv.next()) {
                                (Some("code"), Some(v)) => {
                                    code = Some(urlencoding::decode(v).unwrap_or_default().to_string())
                                }
                                (Some("error"), Some(v)) => {
                                    error = Some(urlencoding::decode(v).unwrap_or_default().to_string())
                                }
                                _ => {}
                            }
                        }

                        if let Some(auth_code) = code {
                            if is_ios {
                                // iOS: respond with success HTML, emit event, dismiss SFSafariVC
                                let html = r#"<!DOCTYPE html><html><body><p>Signing in...</p></body></html>"#;
                                let response = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    html.len(), html
                                );
                                let _ = stream.write_all(response.as_bytes());
                                let _ = stream.flush();
                                let _ = app.emit("oauth-callback", auth_code);
                                #[cfg(target_os = "ios")]
                                {
                                    let svc_ptr = SAFARI_VC.lock().unwrap().take();
                                    if let Some(ptr) = svc_ptr {
                                        unsafe {
                                            dispatch_async_f(get_main_queue(), ptr as *mut std::ffi::c_void, dismiss_vc_work);
                                        }
                                    }
                                }
                            } else {
                                // Desktop: show success page and emit event
                                let html = r#"<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa;}
.c{text-align:center;padding:2em 3em;border-radius:16px;background:white;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
h2{margin:0 0 8px;color:#1a1a1a;font-size:1.3em;}
p{color:#666;margin:0;font-size:0.95em;}
</style></head><body><div class="c"><h2>Signed in successfully</h2><p>You can close this tab and return to MarkFlow.</p></div></body></html>"#;
                                let response = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    html.len(), html
                                );
                                let _ = stream.write_all(response.as_bytes());
                                let _ = stream.flush();
                                let _ = app.emit("oauth-callback", auth_code);
                            }
                        } else if let Some(err) = error {
                            if is_ios {
                                let html = format!("<!DOCTYPE html><html><body><p>Error: {}</p></body></html>", err);
                                let response = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    html.len(), html
                                );
                                let _ = stream.write_all(response.as_bytes());
                                let _ = stream.flush();
                                let _ = app.emit("oauth-error", err);
                                #[cfg(target_os = "ios")]
                                {
                                    let svc_ptr = SAFARI_VC.lock().unwrap().take();
                                    if let Some(ptr) = svc_ptr {
                                        unsafe {
                                            dispatch_async_f(get_main_queue(), ptr as *mut std::ffi::c_void, dismiss_vc_work);
                                        }
                                    }
                                }
                            } else {
                                let html = format!(
                                    "<!DOCTYPE html><html><body><p>Authentication error: {}</p></body></html>", err
                                );
                                let response = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    html.len(), html
                                );
                                let _ = stream.write_all(response.as_bytes());
                                let _ = stream.flush();
                                let _ = app.emit("oauth-error", err);
                            }
                        }
                    }
                }
            }
        }
    });

    Ok(port)
}

#[tauri::command]
fn get_pending_oauth_code() -> Option<String> {
    PENDING_OAUTH_CODE.lock().unwrap().take()
}

/// Called by frontend to signal it's alive and will handle updates via UI.
/// Prevents Rust failsafe from auto-installing.
#[tauri::command]
fn cancel_auto_update() {
    FRONTEND_ALIVE.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn print_html(html: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let path = temp_dir.join("markflow-print.html");
    std::fs::write(&path, &html).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "ios"))]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(path.to_str().ok_or("Invalid path")?)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    // iOS: print is handled in JS via window.print() or WKWebView
    Ok(())
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn copy_image_file(app: tauri::AppHandle, source: String) -> Result<String, String> {
    use tauri::Manager;

    let src_path = std::path::Path::new(&source);
    if !src_path.exists() {
        return Err(format!("File not found: {}", source));
    }

    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let images_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;

    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let dest = images_dir.join(&filename);
    std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_image(app: tauri::AppHandle, data: Vec<u8>, ext: String) -> Result<String, String> {
    use tauri::Manager;

    // Validate extension
    let ext = ext.to_lowercase();
    let valid = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
    if !valid.contains(&ext.as_str()) {
        return Err(format!("Unsupported image format: {}", ext));
    }

    let images_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;

    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let path = images_dir.join(&filename);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

/// Convert image bytes to WebP format for smaller file size.
/// Returns (webp_bytes, "webp") on success, or the original (data, ext) if conversion
/// fails or is unnecessary (GIF, SVG, already WebP, or WebP is larger).
fn try_convert_to_webp(data: Vec<u8>, ext: &str) -> (Vec<u8>, String) {
    match ext {
        "png" | "jpg" | "jpeg" | "bmp" => {}
        _ => return (data, ext.to_string()),
    }
    match image::load_from_memory(&data) {
        Ok(img) => {
            let mut buf = std::io::Cursor::new(Vec::new());
            match img.write_to(&mut buf, image::ImageFormat::WebP) {
                Ok(_) => {
                    let webp_data = buf.into_inner();
                    if webp_data.len() < data.len() {
                        (webp_data, "webp".to_string())
                    } else {
                        (data, ext.to_string())
                    }
                }
                Err(_) => (data, ext.to_string()),
            }
        }
        Err(_) => (data, ext.to_string()),
    }
}

/// Upload image bytes to Firebase Storage via REST API (bypasses WKWebView CORS issues).
/// Automatically converts PNG/JPEG/BMP to WebP when it reduces file size.
/// Returns the public download URL.
#[tauri::command]
async fn upload_image_cloud(
    data: Vec<u8>,
    ext: String,
    uid: String,
    token: String,
    bucket: String,
) -> Result<String, String> {
    let (data, ext) = try_convert_to_webp(data, &ext);
    let id = uuid::Uuid::new_v4().to_string();
    let object_path = format!("images/{}/{}.{}", uid, id, ext);
    let content_type = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };

    let upload_url = format!(
        "https://firebasestorage.googleapis.com/v0/b/{}/o?name={}",
        bucket,
        urlencoding::encode(&object_path),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&upload_url)
        .header("Authorization", format!("Firebase {}", token))
        .header("Content-Type", content_type)
        .header("X-Goog-Upload-Protocol", "raw")
        .header("X-Goog-Upload-Command", "upload, finalize")
        .body(data)
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Upload failed (HTTP {}): {}", status, body));
    }

    // Parse response to extract downloadTokens for authenticated URL
    let body = resp.text().await.unwrap_or_default();
    let encoded_path = urlencoding::encode(&object_path);

    let download_url = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(token) = json.get("downloadTokens").and_then(|t| t.as_str()) {
            format!(
                "https://firebasestorage.googleapis.com/v0/b/{}/o/{}?alt=media&token={}",
                bucket, encoded_path, token
            )
        } else {
            format!(
                "https://firebasestorage.googleapis.com/v0/b/{}/o/{}?alt=media",
                bucket, encoded_path
            )
        }
    } else {
        format!(
            "https://firebasestorage.googleapis.com/v0/b/{}/o/{}?alt=media",
            bucket, encoded_path
        )
    };

    Ok(download_url)
}

/// Upload image from a file path — reads file and uploads in Rust (no IPC byte transfer).
#[tauri::command]
async fn upload_image_from_path(
    path: String,
    uid: String,
    token: String,
    bucket: String,
) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let data = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    upload_image_cloud(data, ext, uid, token, bucket).await
}

/// Upload image from base64 string — avoids massive JSON number array over IPC.
#[tauri::command]
async fn upload_image_from_base64(
    base64_data: String,
    ext: String,
    uid: String,
    token: String,
    bucket: String,
) -> Result<String, String> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    upload_image_cloud(data, ext, uid, token, bucket).await
}

#[derive(serde::Serialize)]
struct UpdateCheckResult {
    version: String,
    body: Option<String>,
}

const STABLE_ENDPOINT: &str =
    "https://github.com/momocham922/markflow/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/momocham922/markflow/releases/download/beta/beta.json";

#[tauri::command]
async fn check_for_update(
    app: tauri::AppHandle,
    channel: String,
) -> Result<Option<UpdateCheckResult>, String> {
    let endpoint = match channel.as_str() {
        "beta" => BETA_ENDPOINT,
        _ => STABLE_ENDPOINT,
    };

    let url: url::Url = endpoint.parse().map_err(|e: url::ParseError| e.to_string())?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateCheckResult {
            version: update.version.clone(),
            body: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    let endpoint = match channel.as_str() {
        "beta" => BETA_ENDPOINT,
        _ => STABLE_ENDPOINT,
    };

    let url: url::Url = endpoint.parse().map_err(|e: url::ParseError| e.to_string())?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    update
        .download_and_install(
            |_chunk_len: usize, _content_len: Option<u64>| {},
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Force-install the latest stable version, even if it's a "downgrade" from beta.
/// Bypasses semver comparison so beta users can switch back to stable.
#[tauri::command]
async fn force_install_stable(app: tauri::AppHandle) -> Result<String, String> {
    let url: url::Url = STABLE_ENDPOINT
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .version_comparator(|_current, _remote| true) // always treat as newer
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No stable release available".to_string())?;

    let version = update.version.clone();

    update
        .download_and_install(
            |_chunk_len: usize, _content_len: Option<u64>| {},
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(version)
}

// ── Voice recording — Rust-side audio capture (bypasses WKWebView getUserMedia restriction) ──

static VOICE_BUFFER: Mutex<Vec<f32>> = Mutex::new(Vec::new());
static VOICE_ACTIVE: AtomicBool = AtomicBool::new(false);
static VOICE_STREAM_RAW: Mutex<usize> = Mutex::new(0);
static VOICE_SAMPLE_RATE: AtomicU32 = AtomicU32::new(16000);
static VOICE_CHANNELS: AtomicU32 = AtomicU32::new(1);

/// Voice chunk returned to frontend: raw PCM base64 + sample rate.
#[derive(serde::Serialize)]
struct VoiceChunkData {
    audio: String,
    sample_rate: u32,
}

/// Stop active recording and free the cpal Stream.
fn stop_voice_recording_inner() {
    VOICE_ACTIVE.store(false, Ordering::SeqCst);
    let ptr = {
        let mut guard = VOICE_STREAM_RAW.lock().unwrap();
        let p = *guard;
        *guard = 0;
        p
    };
    if ptr != 0 {
        // SAFETY: ptr was created by Box::into_raw in start_voice_recording.
        // We clear the stored value above to prevent double-free.
        unsafe {
            drop(Box::from_raw(ptr as *mut cpal::Stream));
        }
    }
}

/// Request microphone permission via AVFoundation (triggers macOS system dialog).
/// cpal uses CoreAudio directly and does NOT trigger the permission prompt on its own.
#[cfg(target_os = "macos")]
fn ensure_microphone_permission() -> Result<(), String> {
    extern "C" {
        fn request_microphone_permission() -> i32;
    }
    let result = unsafe { request_microphone_permission() };
    match result {
        1 => Ok(()),
        0 => Err("マイクへのアクセスが拒否されています。\nSystem Settings > Privacy & Security > Microphone で MarkFlow を許可してください。".into()),
        _ => Err("マイク権限リクエストがタイムアウトしました。".into()),
    }
}

/// Start capturing audio from the default input device via CoreAudio (cpal).
#[tauri::command]
fn start_voice_recording() -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    // Request microphone permission first (macOS only).
    // Without this, cpal silently receives no audio data.
    #[cfg(target_os = "macos")]
    ensure_microphone_permission()?;

    stop_voice_recording_inner();

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("マイクが見つかりません。System Settings > Privacy & Security > Microphone で MarkFlow を許可してください。")?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("マイク設定エラー: {}。マイク権限を確認してください。", e))?;

    println!("[voice] Device: {:?}, format: {:?}, rate: {}, ch: {}",
        device.name().unwrap_or_default(),
        supported.sample_format(),
        supported.sample_rate().0,
        supported.channels());

    let sample_format = supported.sample_format();
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as u32;

    VOICE_SAMPLE_RATE.store(sample_rate, Ordering::Relaxed);
    VOICE_CHANNELS.store(channels, Ordering::Relaxed);
    VOICE_BUFFER.lock().unwrap().clear();
    VOICE_ACTIVE.store(true, Ordering::SeqCst);

    let config: cpal::StreamConfig = supported.into();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                &config,
                |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !VOICE_ACTIVE.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut buf) = VOICE_BUFFER.try_lock() {
                        buf.extend_from_slice(data);
                    }
                },
                |err| eprintln!("[voice] Stream error: {}", err),
                None,
            )
            .map_err(|e| format!("録音開始失敗: {}。マイク権限を確認してください。", e))?,
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                &config,
                |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !VOICE_ACTIVE.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut buf) = VOICE_BUFFER.try_lock() {
                        for &s in data {
                            buf.push(s as f32 / 32768.0);
                        }
                    }
                },
                |err| eprintln!("[voice] Stream error: {}", err),
                None,
            )
            .map_err(|e| format!("録音開始失敗: {}。マイク権限を確認してください。", e))?,
        fmt => return Err(format!("未対応のオーディオ形式: {:?}", fmt)),
    };

    stream
        .play()
        .map_err(|e| format!("Failed to play stream: {}", e))?;

    // Keep stream alive by leaking — freed in stop_voice_recording_inner
    let ptr = Box::into_raw(Box::new(stream)) as usize;
    *VOICE_STREAM_RAW.lock().unwrap() = ptr;

    Ok(())
}

#[tauri::command]
fn stop_voice_recording() {
    stop_voice_recording_inner();
}

/// Drain the audio buffer and return raw LINEAR16 PCM as base64, plus sample rate.
/// Audio is resampled to 16 kHz mono for optimal STT quality.
#[tauri::command]
fn get_voice_chunk() -> Result<Option<VoiceChunkData>, String> {
    use base64::Engine;

    let samples: Vec<f32> = {
        let mut buf = VOICE_BUFFER.lock().unwrap();
        std::mem::take(&mut *buf)
    };

    if samples.is_empty() {
        return Ok(None);
    }

    let sample_rate = VOICE_SAMPLE_RATE.load(Ordering::Relaxed);
    let channels = VOICE_CHANNELS.load(Ordering::Relaxed);
    let raw_sample_count = samples.len();

    // Mix to mono if multi-channel
    let mono: Vec<f32> = if channels > 1 {
        samples
            .chunks(channels as usize)
            .map(|ch| ch.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        samples
    };

    // Resample to 16 kHz for optimal STT quality
    const TARGET_RATE: u32 = 16000;
    let resampled = if sample_rate > TARGET_RATE {
        let ratio = sample_rate as f64 / TARGET_RATE as f64;
        let new_len = (mono.len() as f64 / ratio) as usize;
        let mut out = Vec::with_capacity(new_len);
        for i in 0..new_len {
            let src = i as f64 * ratio;
            let idx = src as usize;
            let frac = src - idx as f64;
            // Linear interpolation for better quality
            let s0 = mono[idx.min(mono.len() - 1)];
            let s1 = mono[(idx + 1).min(mono.len() - 1)];
            out.push(s0 + (s1 - s0) * frac as f32);
        }
        out
    } else {
        mono
    };
    let output_rate = if sample_rate > TARGET_RATE { TARGET_RATE } else { sample_rate };

    // Skip chunks shorter than 0.3 seconds (too short for useful STT)
    let min_samples = (output_rate as usize) * 3 / 10;
    if resampled.len() < min_samples {
        return Ok(None);
    }

    // Voice Activity Detection: skip silence to avoid STT hallucinations
    // ("はい。はい。" loops, number strings, etc.)
    let rms = (resampled.iter().map(|s| s * s).sum::<f32>() / resampled.len() as f32).sqrt();
    if rms < 0.005 {
        println!("[voice] Skipping silent chunk (RMS={:.6})", rms);
        return Ok(None);
    }

    println!("[voice] Chunk: {} raw @ {}Hz → {} @ {}Hz ({:.1}s, RMS={:.4})",
        raw_sample_count, sample_rate, resampled.len(), output_rate,
        resampled.len() as f64 / output_rate as f64, rms);

    // f32 → i16 (LINEAR16 PCM)
    let mut pcm_bytes = Vec::with_capacity(resampled.len() * 2);
    for &s in &resampled {
        let sample = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        pcm_bytes.extend_from_slice(&sample.to_le_bytes());
    }

    Ok(Some(VoiceChunkData {
        audio: base64::engine::general_purpose::STANDARD.encode(&pcm_bytes),
        sample_rate: output_rate,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:markflow.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "create initial tables",
                            sql: "CREATE TABLE IF NOT EXISTS documents (
                                id TEXT PRIMARY KEY,
                                title TEXT NOT NULL DEFAULT 'Untitled',
                                content TEXT NOT NULL DEFAULT '',
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL,
                                is_dirty INTEGER NOT NULL DEFAULT 1,
                                synced_at INTEGER
                            );
                            CREATE TABLE IF NOT EXISTS settings (
                                key TEXT PRIMARY KEY,
                                value TEXT NOT NULL
                            );
                            CREATE TABLE IF NOT EXISTS offline_queue (
                                id TEXT PRIMARY KEY,
                                action TEXT NOT NULL,
                                payload TEXT NOT NULL,
                                created_at INTEGER NOT NULL
                            );",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "add versions table",
                            sql: "CREATE TABLE IF NOT EXISTS versions (
                                id TEXT PRIMARY KEY,
                                document_id TEXT NOT NULL,
                                content TEXT NOT NULL,
                                title TEXT NOT NULL,
                                message TEXT,
                                created_at INTEGER NOT NULL,
                                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
                            );
                            CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(document_id, created_at DESC);",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 3,
                            description: "add folder and tags columns",
                            sql: "ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT '/';
                            ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "ios")]
            {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    unsafe {
                        dispatch_async_f(
                            get_main_queue(),
                            std::ptr::null_mut(),
                            setup_fullscreen_webview_work,
                        );
                    }
                });
            }

            // Failsafe auto-updater: runs independently of frontend.
            // If the frontend crashes (e.g. React hooks violation → black screen),
            // it can't check for updates. This Rust-side task ensures the app
            // still self-heals by auto-installing any available update.
            #[cfg(not(target_os = "ios"))]
            {
                let update_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Wait for frontend to boot. If healthy, it calls cancel_auto_update
                    // within ~5 seconds of mounting.
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;

                    if FRONTEND_ALIVE.load(Ordering::Relaxed) {
                        return; // Frontend is alive — it handles updates via UI
                    }

                    // Frontend didn't respond. It's likely crashed.
                    // Determine update channel from current version.
                    let version = update_handle
                        .config()
                        .version
                        .as_deref()
                        .unwrap_or("");
                    let endpoint = if version.contains("beta") {
                        BETA_ENDPOINT
                    } else {
                        STABLE_ENDPOINT
                    };

                    let url: url::Url = match endpoint.parse() {
                        Ok(u) => u,
                        Err(_) => return,
                    };

                    let updater = match update_handle
                        .updater_builder()
                        .endpoints(vec![url])
                    {
                        Ok(b) => match b.build() {
                            Ok(u) => u,
                            Err(_) => return,
                        },
                        Err(_) => return,
                    };

                    match updater.check().await {
                        Ok(Some(update)) => {
                            // Give frontend one more chance (total ~15s from startup)
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                            if FRONTEND_ALIVE.load(Ordering::Relaxed) {
                                return;
                            }

                            eprintln!(
                                "[failsafe] Frontend unresponsive. Auto-installing update v{}",
                                update.version
                            );
                            if let Err(e) =
                                update.download_and_install(|_, _| {}, || {}).await
                            {
                                eprintln!("[failsafe] Install failed: {}", e);
                                return;
                            }
                            // Restart app with updated binary
                            update_handle.restart();
                        }
                        _ => {
                            // No update available or check failed — nothing to do
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![oauth_listen, get_pending_oauth_code, open_safari_vc, dismiss_safari_vc, fetch_ogp, print_html, save_image, copy_image_file, read_file_bytes, upload_image_cloud, upload_image_from_path, upload_image_from_base64, check_for_update, install_update, force_install_stable, cancel_auto_update, start_voice_recording, stop_voice_recording, get_voice_chunk])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
