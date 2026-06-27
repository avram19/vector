pub mod client;
pub mod prs;
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
pub async fn list_github_repos_page(
    _state: State<'_, AppState>,
    cursor: Option<String>,
) -> Result<repos::ReposPage, String> {
    tauri::async_runtime::spawn_blocking(move || repos::list_repos_page(cursor))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_cached_github_repos(
    _state: State<'_, AppState>,
    repos: Vec<repos::Repo>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || repos::write_disk_cache(&repos))
        .await
        .map_err(|e| e.to_string())
}

/// Return the on-disk cached repo list immediately (no network). Empty if there
/// is no cache yet. The frontend renders this instantly, then calls
/// `list_github_repos_page` to revalidate in the background.
#[tauri::command]
pub async fn get_cached_github_repos(
    _state: State<'_, AppState>,
) -> Result<Vec<repos::Repo>, String> {
    tauri::async_runtime::spawn_blocking(repos::read_disk_cache)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_github_my_prs(
    state: State<'_, AppState>,
    force: bool,
) -> Result<prs::MyPrs, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);
    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("my_prs").and_then(|c| {
                if c.fetched_at.elapsed() < TTL { serde_json::from_str::<prs::MyPrs>(&c.body).ok() } else { None }
            })
        };
        if let Some(hit) = cached { return Ok(hit); }
    }
    let fresh = tauri::async_runtime::spawn_blocking(prs::list_my_prs).await.map_err(|e| e.to_string())??;
    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert("my_prs".to_string(), CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() });
    }
    let to_disk = fresh.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || prs::write_my_prs_cache(&to_disk)).await;
    Ok(fresh)
}

#[tauri::command]
pub async fn get_cached_github_my_prs(_state: State<'_, AppState>) -> Result<prs::MyPrs, String> {
    tauri::async_runtime::spawn_blocking(prs::read_my_prs_cache).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_github_team_prs(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<prs::PullRequest>, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);
    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("team_prs").and_then(|c| {
                if c.fetched_at.elapsed() < TTL { serde_json::from_str::<Vec<prs::PullRequest>>(&c.body).ok() } else { None }
            })
        };
        if let Some(hit) = cached { return Ok(hit); }
    }
    let fresh = tauri::async_runtime::spawn_blocking(prs::list_team_prs).await.map_err(|e| e.to_string())??;
    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert("team_prs".to_string(), CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() });
    }
    let to_disk = fresh.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || prs::write_team_prs_cache(&to_disk)).await;
    Ok(fresh)
}

#[tauri::command]
pub async fn get_cached_github_team_prs(_state: State<'_, AppState>) -> Result<Vec<prs::PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(prs::read_team_prs_cache).await.map_err(|e| e.to_string())
}
