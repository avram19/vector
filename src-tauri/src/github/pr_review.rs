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
