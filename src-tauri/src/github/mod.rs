pub mod actions;
pub mod client;
pub mod notifications;
pub mod prs;
pub mod repos;

use std::collections::HashMap;
use tauri::State;

use crate::AppState;

/// A cached `gh api` response. Reserved for Plans 1–4 (repos/PRs/actions); the
/// foundation only constructs the empty map.
pub struct CachedResponse {
    pub body: String,
    pub fetched_at: std::time::Instant,
}

/// In-memory only — never serialized to disk. Holds the response cache and
/// (in later plans) the activity poller handle.
pub struct GithubState {
    pub cache: parking_lot::Mutex<HashMap<String, CachedResponse>>,
    /// Window focus — drives the poller cadence (45s focused / 300s unfocused).
    pub focused: std::sync::atomic::AtomicBool,
}

impl Default for GithubState {
    fn default() -> Self {
        Self {
            cache: parking_lot::Mutex::new(HashMap::new()),
            focused: std::sync::atomic::AtomicBool::new(true),
        }
    }
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
        state.github.cache.lock().insert("my_prs".to_string(), CachedResponse { body, fetched_at: std::time::Instant::now() });
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
    _state: State<'_, AppState>,
    after: Option<String>,
) -> Result<prs::PrPage, String> {
    let is_first = after.is_none();
    let page = tauri::async_runtime::spawn_blocking(move || prs::list_team_prs(after.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    // Disk-cache only the first page, for instant paint on next launch.
    if is_first {
        let to_disk = page.prs.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || prs::write_team_prs_cache(&to_disk)).await;
    }
    Ok(page)
}

#[tauri::command]
pub async fn get_cached_github_team_prs(_state: State<'_, AppState>) -> Result<Vec<prs::PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(prs::read_team_prs_cache).await.map_err(|e| e.to_string())
}

/// All open PRs in one repo (any author) — used when the inbox is filtered to a
/// specific repo, so a repo's PR-count badge always shows real PRs.
#[tauri::command]
pub async fn list_github_repo_prs(
    _state: State<'_, AppState>,
    repo: String,
    after: Option<String>,
) -> Result<prs::PrPage, String> {
    tauri::async_runtime::spawn_blocking(move || prs::list_repo_prs(&repo, after.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_github_workflows(_state: State<'_, AppState>, repo: String) -> Result<Vec<actions::Workflow>, String> {
    tauri::async_runtime::spawn_blocking(move || actions::list_workflows(&repo)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_github_runs(_state: State<'_, AppState>, repo: String, workflow: Option<String>, per_page: u32) -> Result<Vec<actions::Run>, String> {
    tauri::async_runtime::spawn_blocking(move || actions::list_runs(&repo, workflow.as_deref(), per_page)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_github_jobs(_state: State<'_, AppState>, repo: String, run_id: u64) -> Result<Vec<actions::Job>, String> {
    tauri::async_runtime::spawn_blocking(move || actions::list_jobs(&repo, run_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_github_favorite_runs(_state: State<'_, AppState>, favorites: Vec<String>) -> Result<Vec<actions::Run>, String> {
    tauri::async_runtime::spawn_blocking(move || actions::favorite_runs(&favorites)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_github_job_log(_state: State<'_, AppState>, repo: String, job_id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || actions::job_log(&repo, job_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prepare_github_job_log(_state: State<'_, AppState>, job_id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || actions::job_log_loading(job_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_workflow_inputs(_state: State<'_, AppState>, repo: String, path: String) -> Result<Vec<actions::DispatchInput>, String> {
    tauri::async_runtime::spawn_blocking(move || actions::workflow_inputs(&repo, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_dispatch(_state: State<'_, AppState>, repo: String, workflow: String, git_ref: String, inputs: Vec<(String, String)>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || actions::dispatch(&repo, &workflow, &git_ref, inputs)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_rerun(_state: State<'_, AppState>, repo: String, run_id: u64, failed_only: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || actions::rerun(&repo, run_id, failed_only)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_cancel(_state: State<'_, AppState>, repo: String, run_id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || actions::cancel(&repo, run_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_github_notifications(_state: State<'_, AppState>) -> Result<Vec<notifications::Notification>, String> {
    tauri::async_runtime::spawn_blocking(notifications::list_notifications).await.map_err(|e| e.to_string())?
}
