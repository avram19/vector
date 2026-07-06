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

const THREADS_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved path line
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
        .map(|t| ReviewThread {
            id: t["id"].as_str().unwrap_or_default().to_string(),
            path: t["path"].as_str().unwrap_or_default().to_string(),
            line: t["line"].as_u64().map(|n| n as u32),
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
        })
        .collect();
    Ok(threads)
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
    let (owner, name) = repo.split_once('/').ok_or_else(|| format!("bad repo slug: {repo}"))?;
    let id_raw = client::run_gh(&[
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
    let id_v: serde_json::Value = serde_json::from_str(&id_raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    let pr_node_id = id_v["data"]["repository"]["pullRequest"]["id"]
        .as_str()
        .ok_or("could not resolve PR node id")?
        .to_string();

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

const ADD_COMMENT_MUTATION: &str = r#"mutation($reviewId: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, path: $path, line: $line, body: $body }) {
    thread { id }
  }
}"#;

pub fn add_review_comment(review_id: &str, path: &str, line: u32, body: &str) -> Result<(), String> {
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

/// `method` must be one of "merge" | "squash" | "rebase".
pub fn merge_pr(repo: &str, number: u64, method: &str) -> Result<(), String> {
    let flag = match method {
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => "--merge",
    };
    client::run_gh(&["pr", "merge", &number.to_string(), "--repo", repo, flag]).map(|_| ())
}
