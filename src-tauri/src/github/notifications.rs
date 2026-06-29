use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub thread_id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub reason: String,
    pub updated_at: String,
}

/// Unread PR notifications where I'm the author or a requested reviewer.
pub fn list_notifications() -> Result<Vec<Notification>, String> {
    let raw = client::run_gh(&["api", "notifications?per_page=50"])?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    let mut out = Vec::new();
    if let Some(items) = v.as_array() {
        for t in items {
            let reason = t["reason"].as_str().unwrap_or_default();
            if t["subject"]["type"].as_str().unwrap_or_default() != "PullRequest" {
                continue;
            }
            if reason != "author" && reason != "review_requested" {
                continue;
            }
            let url = t["subject"]["url"].as_str().unwrap_or_default();
            let number = url.rsplit('/').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            out.push(Notification {
                thread_id: t["id"].as_str().unwrap_or_default().to_string(),
                repo: t["repository"]["full_name"].as_str().unwrap_or_default().to_string(),
                number,
                title: t["subject"]["title"].as_str().unwrap_or_default().to_string(),
                reason: reason.to_string(),
                updated_at: t["updated_at"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    Ok(out)
}

/// Background poller: emit `github-activity` (the filtered notifications) on an
/// interval — 45s focused, 300s unfocused. Best-effort: emits empty on error
/// (e.g. not authed) and keeps looping. Lives for the process lifetime.
pub fn spawn_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::sync::atomic::Ordering;
        loop {
            let notifs = list_notifications().unwrap_or_default();
            let _ = app.emit("github-activity", &notifs);
            let focused = app
                .state::<crate::AppState>()
                .github
                .focused
                .load(Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_secs(if focused { 45 } else { 300 }));
        }
    });
}
