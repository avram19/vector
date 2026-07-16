use serde::{Deserialize, Serialize};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub author: String,
    pub author_avatar: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    /// "LEFT" (comment on a deleted/old-file line) or "RIGHT" (added/context,
    /// new-file line) — GitHub tracks these as separate line spaces, so a
    /// thread's `line` must be paired with `side` to know which one it means.
    pub side: String,
    pub is_resolved: bool,
    pub comments: Vec<ReviewComment>,
}

/// Raw unified diff text for a PR. Not available via GraphQL — REST only, via
/// the `application/vnd.github.v3.diff` media type.
pub fn get_pr_diff(repo: &str, number: u64) -> Result<String, String> {
    client::run_gh(&[
        "api",
        &format!("repos/{repo}/pulls/{number}"),
        "-H",
        "Accept: application/vnd.github.v3.diff",
    ])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerStatus {
    pub login: String,
    /// "APPROVED" or "CHANGES_REQUESTED" only — GraphQL's
    /// `latestOpinionatedReviews` already excludes COMMENTED/PENDING/DISMISSED,
    /// i.e. it's each reviewer's current opinionated stance, not their full
    /// review history.
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetails {
    pub title: String,
    /// PR description — empty string if the author left it blank.
    pub body: String,
    /// PR author login, for the review header ("by …").
    pub author: String,
    /// Source branch (the PR's own branch).
    pub head_ref: String,
    /// Target branch the PR merges into.
    pub base_ref: String,
    pub reviewers: Vec<ReviewerStatus>,
    /// GitHub's merge-state: "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" |
    /// "UNSTABLE" | "HAS_HOOKS" | "UNKNOWN". Always "UNKNOWN" for closed/merged
    /// PRs — GitHub only computes it for open ones, so no retry is warranted.
    pub merge_state_status: String,
    /// Whether the viewer may bypass branch protection. This is a *permission*:
    /// it is true even on a CLEAN PR, so it must be paired with
    /// `merge_state_status` before offering an override.
    pub viewer_can_merge_as_admin: bool,
}

const DETAILS_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title
      body
      author { login }
      headRefName
      baseRefName
      mergeStateStatus
      viewerCanMergeAsAdmin
      latestOpinionatedReviews(last: 25) {
        nodes { author { login } state }
      }
    }
  }
}"#;

/// Title + description + each reviewer's current approve/request-changes
/// stance, for the review header and status bar.
pub fn get_pr_details(repo: &str, number: u64) -> Result<PrDetails, String> {
    let (owner, name) = repo.split_once('/').ok_or_else(|| format!("bad repo slug: {repo}"))?;
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={DETAILS_QUERY}"),
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
        "-F",
        &format!("number={number}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let pr = &v["data"]["repository"]["pullRequest"];
    let reviewers = pr["latestOpinionatedReviews"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|r| ReviewerStatus {
            login: r["author"]["login"].as_str().unwrap_or_default().to_string(),
            state: r["state"].as_str().unwrap_or_default().to_string(),
        })
        .collect();
    Ok(PrDetails {
        title: pr["title"].as_str().unwrap_or_default().to_string(),
        body: pr["body"].as_str().unwrap_or_default().to_string(),
        author: pr["author"]["login"].as_str().unwrap_or_default().to_string(),
        head_ref: pr["headRefName"].as_str().unwrap_or_default().to_string(),
        base_ref: pr["baseRefName"].as_str().unwrap_or_default().to_string(),
        reviewers,
        merge_state_status: pr["mergeStateStatus"].as_str().unwrap_or("UNKNOWN").to_string(),
        viewer_can_merge_as_admin: pr["viewerCanMergeAsAdmin"].as_bool().unwrap_or(false),
    })
}

const THREADS_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved path line originalLine diffSide
          comments(first: 50) {
            nodes { id body createdAt author { login avatarUrl } }
          }
        }
      }
    }
  }
}"#;

pub fn get_pr_review_threads(repo: &str, number: u64) -> Result<Vec<ReviewThread>, String> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| format!("bad repo slug: {repo}"))?;
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={THREADS_QUERY}"),
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
        "-F",
        &format!("number={number}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let nodes = v["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let threads = nodes
        .iter()
        .map(|t| {
            let side = t["diffSide"].as_str().unwrap_or("RIGHT").to_string();
            // GitHub only populates `line` for RIGHT-side threads and
            // `originalLine` for LEFT-side (deleted-line) threads.
            let line = if side == "LEFT" {
                t["originalLine"].as_u64().map(|n| n as u32)
            } else {
                t["line"].as_u64().map(|n| n as u32)
            };
            ReviewThread {
            id: t["id"].as_str().unwrap_or_default().to_string(),
            path: t["path"].as_str().unwrap_or_default().to_string(),
            line,
            side,
            is_resolved: t["isResolved"].as_bool().unwrap_or(false),
            comments: t["comments"]["nodes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|c| ReviewComment {
                    id: c["id"].as_str().unwrap_or_default().to_string(),
                    author: c["author"]["login"].as_str().unwrap_or_default().to_string(),
                    author_avatar: c["author"]["avatarUrl"].as_str().map(|s| s.to_string()),
                    body: c["body"].as_str().unwrap_or_default().to_string(),
                    created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
                })
                .collect(),
            }
        })
        .collect();
    Ok(threads)
}

/// PR node id, needed by mutations that take a `subjectId`/`pullRequestId`
/// rather than a `repo`+`number` pair (`addPullRequestReview`, `addComment`).
fn resolve_pr_node_id(repo: &str, number: u64) -> Result<String, String> {
    let (owner, name) = repo.split_once('/').ok_or_else(|| format!("bad repo slug: {repo}"))?;
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}",
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
        "-F",
        &format!("number={number}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    v["data"]["repository"]["pullRequest"]["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "could not resolve PR node id".to_string())
}

const PR_COMMENTS_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100) {
        nodes { id body createdAt author { login avatarUrl } }
      }
    }
  }
}"#;

/// PR-level "conversation" comments — top-level, not tied to any file/line,
/// distinct from inline review-thread comments (`get_pr_review_threads`).
pub fn get_pr_comments(repo: &str, number: u64) -> Result<Vec<ReviewComment>, String> {
    let (owner, name) = repo.split_once('/').ok_or_else(|| format!("bad repo slug: {repo}"))?;
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={PR_COMMENTS_QUERY}"),
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
        "-F",
        &format!("number={number}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let nodes = v["data"]["repository"]["pullRequest"]["comments"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(nodes
        .iter()
        .map(|c| ReviewComment {
            id: c["id"].as_str().unwrap_or_default().to_string(),
            author: c["author"]["login"].as_str().unwrap_or_default().to_string(),
            author_avatar: c["author"]["avatarUrl"].as_str().map(|s| s.to_string()),
            body: c["body"].as_str().unwrap_or_default().to_string(),
            created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

const ADD_PR_COMMENT_MUTATION: &str = r#"mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id body createdAt author { login avatarUrl } } }
  }
}"#;

/// Posts immediately (top-level PR comments aren't part of the pending-review
/// batch — same reasoning as replying to an existing review thread).
pub fn add_pr_comment(repo: &str, number: u64, body: &str) -> Result<ReviewComment, String> {
    let pr_node_id = resolve_pr_node_id(repo, number)?;
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={ADD_PR_COMMENT_MUTATION}"),
        "-f",
        &format!("subjectId={pr_node_id}"),
        "-f",
        &format!("body={body}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let c = &v["data"]["addComment"]["commentEdge"]["node"];
    Ok(ReviewComment {
        id: c["id"].as_str().unwrap_or_default().to_string(),
        author: c["author"]["login"].as_str().unwrap_or_default().to_string(),
        author_avatar: c["author"]["avatarUrl"].as_str().map(|s| s.to_string()),
        body: c["body"].as_str().unwrap_or_default().to_string(),
        created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
    })
}

const START_REVIEW_MUTATION: &str = r#"mutation($pullRequestId: ID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId }) {
    pullRequestReview { id }
  }
}"#;

/// Look up the PR's node id (needed by `addPullRequestReview`) then start a
/// pending review. GitHub allows only one pending review per viewer per PR —
/// if one already exists this mutation errors, which the caller surfaces as-is
/// (the frontend only calls this once per PrReviewView session, on first
/// inline comment).
pub fn start_pending_review(repo: &str, number: u64) -> Result<String, String> {
    let pr_node_id = resolve_pr_node_id(repo, number)?;

    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={START_REVIEW_MUTATION}"),
        "-f",
        &format!("pullRequestId={pr_node_id}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    v["data"]["addPullRequestReview"]["pullRequestReview"]["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "no review id returned".to_string())
}

const ADD_COMMENT_MUTATION: &str = r#"mutation($reviewId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, path: $path, line: $line, side: $side, body: $body }) {
    thread { id }
  }
}"#;

/// `side` must be "LEFT" (a deleted/old-file line) or "RIGHT" (added/context,
/// new-file line) — matches `ReviewThread.side`'s semantics.
pub fn add_review_comment(review_id: &str, path: &str, line: u32, side: &str, body: &str) -> Result<(), String> {
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={ADD_COMMENT_MUTATION}"),
        "-f",
        &format!("reviewId={review_id}"),
        "-f",
        &format!("path={path}"),
        "-F",
        &format!("line={line}"),
        "-f",
        &format!("side={side}"),
        "-f",
        &format!("body={body}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    Ok(())
}

const RESOLVE_THREAD_MUTATION: &str = r#"mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}"#;

pub fn resolve_review_thread(thread_id: &str) -> Result<(), String> {
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={RESOLVE_THREAD_MUTATION}"),
        "-f",
        &format!("threadId={thread_id}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    Ok(())
}

const UNRESOLVE_THREAD_MUTATION: &str = r#"mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}"#;

pub fn unresolve_review_thread(thread_id: &str) -> Result<(), String> {
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={UNRESOLVE_THREAD_MUTATION}"),
        "-f",
        &format!("threadId={thread_id}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    Ok(())
}

const REPLY_MUTATION: &str = r#"mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id body createdAt author { login avatarUrl } }
  }
}"#;

/// Replying to an EXISTING thread posts immediately (matches GitHub's own
/// behavior) — unlike starting a brand-new thread, which batches into the
/// viewer's pending review. No review id needed here.
pub fn reply_to_review_thread(thread_id: &str, body: &str) -> Result<ReviewComment, String> {
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={REPLY_MUTATION}"),
        "-f",
        &format!("threadId={thread_id}"),
        "-f",
        &format!("body={body}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let c = &v["data"]["addPullRequestReviewThreadReply"]["comment"];
    Ok(ReviewComment {
        id: c["id"].as_str().unwrap_or_default().to_string(),
        author: c["author"]["login"].as_str().unwrap_or_default().to_string(),
        author_avatar: c["author"]["avatarUrl"].as_str().map(|s| s.to_string()),
        body: c["body"].as_str().unwrap_or_default().to_string(),
        created_at: c["createdAt"].as_str().unwrap_or_default().to_string(),
    })
}

const SUBMIT_REVIEW_MUTATION: &str = r#"mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String!) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
    pullRequestReview { id }
  }
}"#;

/// `event` must be one of "APPROVE" | "REQUEST_CHANGES" | "COMMENT" (validated
/// by the frontend's fixed action-bar buttons, not re-validated here — GitHub's
/// own mutation will error on an invalid enum value regardless).
pub fn submit_pr_review(review_id: &str, event: &str, body: &str) -> Result<(), String> {
    let raw = client::run_gh(&[
        "api",
        "graphql",
        "-f",
        &format!("query={SUBMIT_REVIEW_MUTATION}"),
        "-f",
        &format!("reviewId={review_id}"),
        "-f",
        &format!("event={event}"),
        "-f",
        &format!("body={body}"),
    ])?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    Ok(())
}

/// `method` must be one of "merge" | "squash" | "rebase". `admin` passes
/// `--admin`, GitHub's branch-protection bypass. It is only meaningful when the
/// viewer holds admin rights AND the PR is BLOCKED/BEHIND — it cannot bypass a
/// merge conflict, so the frontend never offers it on a DIRTY PR.
pub fn merge_pr(repo: &str, number: u64, method: &str, admin: bool) -> Result<(), String> {
    let flag = match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    let num = number.to_string();
    let mut args: Vec<&str> = vec!["pr", "merge", &num, "--repo", repo, flag];
    if admin {
        args.push("--admin");
    }
    client::run_gh(&args).map(|_| ())
}
