pub mod client;
pub mod repos;

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

#[tauri::command]
pub async fn list_github_repos(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<repos::Repo>, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);

    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("repos").and_then(|c| {
                if c.fetched_at.elapsed() < TTL {
                    serde_json::from_str::<Vec<repos::Repo>>(&c.body).ok()
                } else {
                    None
                }
            })
        };
        if let Some(hit) = cached {
            return Ok(hit);
        }
    }

    let fresh = tauri::async_runtime::spawn_blocking(repos::list_repos)
        .await
        .map_err(|e| e.to_string())??;

    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert(
            "repos".to_string(),
            CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() },
        );
    }

    Ok(fresh)
}
