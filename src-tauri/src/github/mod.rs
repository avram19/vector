pub mod client;

use std::collections::HashMap;
use tauri::State;

use crate::AppState;

/// A cached `gh api` response. Reserved for Plans 1–4 (repos/PRs/actions); the
/// foundation only constructs the empty map.
pub struct CachedResponse {
    pub etag: Option<String>,
    pub body: String,
    pub fetched_at: std::time::Instant,
}

/// In-memory only — never serialized to disk. Holds the ETag response cache and
/// (in later plans) the activity poller handle.
#[derive(Default)]
pub struct GithubState {
    pub cache: parking_lot::Mutex<HashMap<String, CachedResponse>>,
}

#[tauri::command]
pub async fn gh_auth_status(_state: State<'_, AppState>) -> Result<client::AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(client::auth_status)
        .await
        .map_err(|e| e.to_string())
}
