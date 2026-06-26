use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub author_avatar: Option<String>,
    pub head_ref: String,
    pub is_draft: bool,
    pub state: String,
    pub review_decision: Option<String>,
    pub mergeable: String,
    pub ci_status: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrInbox {
    pub authored: Vec<PullRequest>,
    pub review: Vec<PullRequest>,
    pub recently_closed: Vec<PullRequest>,
}

// One round-trip: three search aliases sharing a fragment. `author:@me` /
// `review-requested:@me` span every repo the viewer can see.
const QUERY: &str = r#"fragment prFields on PullRequest {
  number title url isDraft state headRefName reviewDecision mergeable updatedAt
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
query {
  authored: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
  review: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
  closed: search(query: "is:pr author:@me is:closed sort:updated-desc", type: ISSUE, first: 30) { nodes { ...prFields } }
}"#;

fn parse_pr(n: &serde_json::Value) -> PullRequest {
    PullRequest {
        repo: n["repository"]["nameWithOwner"].as_str().unwrap_or_default().to_string(),
        number: n["number"].as_u64().unwrap_or(0),
        title: n["title"].as_str().unwrap_or_default().to_string(),
        url: n["url"].as_str().unwrap_or_default().to_string(),
        author: n["author"]["login"].as_str().unwrap_or_default().to_string(),
        author_avatar: n["author"]["avatarUrl"].as_str().map(|s| s.to_string()),
        head_ref: n["headRefName"].as_str().unwrap_or_default().to_string(),
        is_draft: n["isDraft"].as_bool().unwrap_or(false),
        state: n["state"].as_str().unwrap_or_default().to_string(),
        review_decision: n["reviewDecision"].as_str().map(|s| s.to_string()),
        mergeable: n["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
        ci_status: n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"]
            .as_str()
            .map(|s| s.to_string()),
        updated_at: n["updatedAt"].as_str().unwrap_or_default().to_string(),
    }
}

/// Fetch the viewer's PR inbox (authored / review-requested / recently-closed)
/// in one GraphQL round-trip. Blocking.
pub fn list_prs() -> Result<PrInbox, String> {
    let q = format!("query={QUERY}");
    let raw = client::run_gh(&["api", "graphql", "-f", &q])?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;

    let collect = |alias: &str| -> Vec<PullRequest> {
        v["data"][alias]["nodes"]
            .as_array()
            .map(|nodes| nodes.iter().map(parse_pr).collect())
            .unwrap_or_default()
    };

    Ok(PrInbox {
        authored: collect("authored"),
        review: collect("review"),
        recently_closed: collect("closed"),
    })
}

// ── disk cache (stale-while-revalidate), mirroring repos.rs ──
fn cache_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("vector").join("prs.json"))
}

pub fn read_disk_cache() -> PrInbox {
    let Some(p) = cache_path() else { return PrInbox::default() };
    let Ok(text) = std::fs::read_to_string(&p) else { return PrInbox::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn write_disk_cache(inbox: &PrInbox) {
    let Some(p) = cache_path() else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(inbox) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}
