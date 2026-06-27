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
pub struct MyPrs {
    pub authored: Vec<PullRequest>,
    pub recently_closed: Vec<PullRequest>,
}

/// One page of a paginated PR search: the PRs plus the cursor for the next page
/// (None when exhausted), so the frontend can offer a "View more" button.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrPage {
    pub prs: Vec<PullRequest>,
    pub next_cursor: Option<String>,
}

const PR_FRAGMENT: &str = r#"fragment prFields on PullRequest {
  number title url isDraft state headRefName reviewDecision mergeable updatedAt
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}"#;

const MY_BODY: &str = r#"query {
  authored: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
  closed: search(query: "is:pr author:@me is:closed sort:updated-desc", type: ISSUE, first: 30) { nodes { ...prFields } }
}"#;

const TEAM_BODY: &str = r#"query($endCursor: String) {
  review: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 50, after: $endCursor) {
    nodes { ...prFields }
    pageInfo { hasNextPage endCursor }
  }
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

fn run_search(query: &str, after: Option<&str>) -> Result<serde_json::Value, String> {
    let q = format!("query={query}");
    let mut args: Vec<String> = vec!["api".into(), "graphql".into(), "-f".into(), q];
    if let Some(c) = after {
        args.push("-f".into());
        args.push(format!("endCursor={c}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let raw = client::run_gh(&arg_refs)?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    // GraphQL reports errors (token scope, SSO) with HTTP 200 + an `errors`
    // array. Surface them instead of silently returning an empty result.
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    Ok(v)
}

fn collect(v: &serde_json::Value, alias: &str) -> Vec<PullRequest> {
    v["data"][alias]["nodes"]
        .as_array()
        .map(|nodes| nodes.iter().map(parse_pr).collect())
        .unwrap_or_default()
}

fn collect_page(v: &serde_json::Value, alias: &str) -> PrPage {
    let info = &v["data"][alias]["pageInfo"];
    let next_cursor = if info["hasNextPage"].as_bool().unwrap_or(false) {
        info["endCursor"].as_str().map(|s| s.to_string())
    } else {
        None
    };
    PrPage { prs: collect(v, alias), next_cursor }
}

/// My authored PRs (open) + my recently closed/merged PRs. One round-trip.
pub fn list_my_prs() -> Result<MyPrs, String> {
    let v = run_search(&format!("{PR_FRAGMENT}\n{MY_BODY}"), None)?;
    Ok(MyPrs {
        authored: collect(&v, "authored"),
        recently_closed: collect(&v, "closed"),
    })
}

/// One page of open PRs where I'm a requested reviewer.
pub fn list_team_prs(after: Option<&str>) -> Result<PrPage, String> {
    let v = run_search(&format!("{PR_FRAGMENT}\n{TEAM_BODY}"), after)?;
    Ok(collect_page(&v, "review"))
}

/// One page of all open PRs in a specific repo (regardless of author/reviewer),
/// so a repo's PR-count badge always reflects real PRs in the inbox.
pub fn list_repo_prs(repo: &str, after: Option<&str>) -> Result<PrPage, String> {
    // `repo` is a GitHub nameWithOwner from our own data; embed it in the search.
    let body = format!(
        "query($endCursor: String) {{ search(query: \"repo:{repo} is:pr is:open sort:updated-desc\", type: ISSUE, first: 50, after: $endCursor) {{ nodes {{ ...prFields }} pageInfo {{ hasNextPage endCursor }} }} }}"
    );
    let v = run_search(&format!("{PR_FRAGMENT}\n{body}"), after)?;
    Ok(collect_page(&v, "search"))
}

// ── disk caches (SWR), one file per kind ──
fn cache_file(name: &str) -> Option<std::path::PathBuf> {
    dirs::cache_dir().map(|d| d.join("vector").join(name))
}

fn read_json<T: serde::de::DeserializeOwned + Default>(name: &str) -> T {
    let Some(p) = cache_file(name) else { return T::default() };
    let Ok(text) = std::fs::read_to_string(&p) else { return T::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_json<T: Serialize + ?Sized>(name: &str, val: &T) {
    let Some(p) = cache_file(name) else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(val) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

pub fn read_my_prs_cache() -> MyPrs { read_json("my-prs.json") }
pub fn write_my_prs_cache(v: &MyPrs) { write_json("my-prs.json", v) }
pub fn read_team_prs_cache() -> Vec<PullRequest> { read_json("team-prs.json") }
pub fn write_team_prs_cache(v: &[PullRequest]) { write_json("team-prs.json", v) }
