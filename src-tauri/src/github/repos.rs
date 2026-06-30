use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::client;

/// On-disk cache of the repo list, so the tree can render instantly on startup
/// while a fresh copy is fetched in the background (stale-while-revalidate).
/// Lives in the OS cache dir (regenerable data), not config.
fn cache_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("vector").join("repos.json"))
}

pub fn read_disk_cache() -> Vec<Repo> {
    let Some(p) = cache_path() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&p) else { return Vec::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn write_disk_cache(repos: &[Repo]) {
    let Some(p) = cache_path() else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(repos) {
        // Atomic write: tmp + rename, matching config.rs.
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name_with_owner: String,
    pub owner: String,
    pub is_private: bool,
    pub is_archived: bool,
    pub pushed_at: Option<String>,
    pub default_branch: Option<String>,
    pub open_pr_count: u32,
}

// NOTE: `ownerAffiliations` is required, not just `affiliations`. `affiliations`
// sets the viewer's relationship to a repo, but `ownerAffiliations` controls
// which owners' repos are included and DEFAULTS to [OWNER, COLLABORATOR] —
// excluding ORGANIZATION_MEMBER. Without it, org-owned repos are silently
// dropped (e.g. a member's org repos never appear).
const QUERY: &str = r#"query($endCursor: String) {
  viewer {
    repositories(first: 50, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}, after: $endCursor) {
      nodes {
        nameWithOwner
        isPrivate
        isArchived
        pushedAt
        owner { login }
        defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReposPage {
    pub repos: Vec<Repo>,
    pub next_cursor: Option<String>,
}

/// Fetch ONE page of repositories (after `cursor`). Returns the page + the next
/// cursor (None when exhausted) so the frontend can render progressively.
pub fn list_repos_page(cursor: Option<String>) -> Result<ReposPage, String> {
    let query_arg = format!("query={QUERY}");
    let mut args: Vec<String> = vec!["api".into(), "graphql".into(), "-f".into(), query_arg];
    if let Some(c) = &cursor {
        args.push("-f".into());
        args.push(format!("endCursor={c}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let raw = client::run_gh(&arg_refs)?;

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let conn = &v["data"]["viewer"]["repositories"];

    let mut repos: Vec<Repo> = Vec::new();
    if let Some(nodes) = conn["nodes"].as_array() {
        for n in nodes {
            repos.push(Repo {
                name_with_owner: n["nameWithOwner"].as_str().unwrap_or_default().to_string(),
                owner: n["owner"]["login"].as_str().unwrap_or_default().to_string(),
                is_private: n["isPrivate"].as_bool().unwrap_or(false),
                is_archived: n["isArchived"].as_bool().unwrap_or(false),
                pushed_at: n["pushedAt"].as_str().map(|s| s.to_string()),
                default_branch: n["defaultBranchRef"]["name"].as_str().map(|s| s.to_string()),
                open_pr_count: n["pullRequests"]["totalCount"].as_u64().unwrap_or(0) as u32,
            });
        }
    }
    let next_cursor = if conn["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
        conn["pageInfo"]["endCursor"].as_str().map(|s| s.to_string())
    } else {
        None
    };

    Ok(ReposPage { repos, next_cursor })
}
