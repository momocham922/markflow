use tauri::Emitter;
use std::io::{Read, Write};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
                    ],
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![oauth_listen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
