use serde::{Deserialize, Serialize};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name_with_owner: String,
    pub owner: String,
    pub is_private: bool,
    pub pushed_at: Option<String>,
    pub default_branch: Option<String>,
    pub open_pr_count: u32,
}

const QUERY: &str = r#"query($endCursor: String) {
  viewer {
    repositories(first: 100, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}, after: $endCursor) {
      nodes {
        nameWithOwner
        isPrivate
        pushedAt
        owner { login }
        defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}"#;

/// Fetch every repository the viewer can see (owner / collaborator / org member),
/// newest-push first, following GraphQL cursor pagination. Blocking.
pub fn list_repos() -> Result<Vec<Repo>, String> {
    let mut out: Vec<Repo> = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let query_arg = format!("query={QUERY}");
        let mut args: Vec<String> = vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            query_arg,
        ];
        if let Some(c) = &cursor {
            args.push("-f".into());
            args.push(format!("endCursor={c}"));
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let raw = client::run_gh(&arg_refs)?;

        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
        let conn = &v["data"]["viewer"]["repositories"];

        if let Some(nodes) = conn["nodes"].as_array() {
            for n in nodes {
                out.push(Repo {
                    name_with_owner: n["nameWithOwner"].as_str().unwrap_or_default().to_string(),
                    owner: n["owner"]["login"].as_str().unwrap_or_default().to_string(),
                    is_private: n["isPrivate"].as_bool().unwrap_or(false),
                    pushed_at: n["pushedAt"].as_str().map(|s| s.to_string()),
                    default_branch: n["defaultBranchRef"]["name"].as_str().map(|s| s.to_string()),
                    open_pr_count: n["pullRequests"]["totalCount"].as_u64().unwrap_or(0) as u32,
                });
            }
        }

        if conn["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
            match conn["pageInfo"]["endCursor"].as_str() {
                Some(c) => cursor = Some(c.to_string()),
                None => break,
            }
        } else {
            break;
        }
    }

    Ok(out)
}
