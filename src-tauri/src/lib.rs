use tauri::Emitter;
use std::io::{Read, Write};

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
async fn oauth_listen(app: tauri::AppHandle) -> Result<u16, String> {
    let port: u16 = 19847;
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind port {}: {}", port, e))?;

    // Set a timeout so the thread doesn't hang forever
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("Failed to set blocking: {}", e))?;

    std::thread::spawn(move || {
        // Accept one connection (the OAuth callback)
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
                            let html = r#"<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa;}
.c{text-align:center;padding:2em 3em;border-radius:16px;background:white;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
h2{margin:0 0 8px;color:#1a1a1a;font-size:1.3em;}
p{color:#666;margin:0;font-size:0.95em;}
</style></head><body><div class="c"><h2>Signed in successfully</h2><p>You can close this tab and return to MarkFlow.</p></div></body></html>"#;
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                html.len(),
                                html
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
                            let _ = app.emit("oauth-callback", auth_code);
                        } else if let Some(err) = error {
                            let html = format!(
                                "<!DOCTYPE html><html><body><p>Authentication error: {}</p></body></html>",
                                err
                            );
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                html.len(),
                                html
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
                            let _ = app.emit("oauth-error", err);
                        }
                    }
                }
            }
        }
    });

    Ok(port)
}

#[tauri::command]
async fn print_html(html: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let path = temp_dir.join("markflow-print.html");
    std::fs::write(&path, &html).map_err(|e| e.to_string())?;
    std::process::Command::new("/usr/bin/open")
        .arg(path.to_str().ok_or("Invalid path")?)
        .spawn()
        .map_err(|e| e.to_string())?;
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

/// Upload image bytes to Firebase Storage via REST API (bypasses WKWebView CORS issues).
/// Returns the public download URL.
#[tauri::command]
async fn upload_image_cloud(
    data: Vec<u8>,
    ext: String,
    uid: String,
    token: String,
    bucket: String,
) -> Result<String, String> {
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
        .invoke_handler(tauri::generate_handler![oauth_listen, fetch_ogp, print_html, save_image, copy_image_file, read_file_bytes, upload_image_cloud, upload_image_from_path, upload_image_from_base64])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
