use serde::{Deserialize, Serialize};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: u64,
    pub run_number: u64,
    pub workflow_id: u64,
    pub workflow_name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub branch: String,
    pub event: String,
    pub actor: String,
    pub head_sha: String,
    pub created_at: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub steps: Vec<Step>,
}

fn api(path: &str) -> Result<serde_json::Value, String> {
    let raw = client::run_gh(&["api", path])?;
    serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))
}

pub fn list_workflows(repo: &str) -> Result<Vec<Workflow>, String> {
    let v = api(&format!("repos/{repo}/actions/workflows?per_page=100"))?;
    let mut out = Vec::new();
    if let Some(items) = v["workflows"].as_array() {
        for w in items {
            out.push(Workflow {
                id: w["id"].as_u64().unwrap_or(0),
                name: w["name"].as_str().unwrap_or_default().to_string(),
                path: w["path"].as_str().unwrap_or_default().to_string(),
                state: w["state"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    Ok(out)
}

fn parse_run(r: &serde_json::Value, repo: &str) -> Run {
    Run {
        id: r["id"].as_u64().unwrap_or(0),
        run_number: r["run_number"].as_u64().unwrap_or(0),
        workflow_id: r["workflow_id"].as_u64().unwrap_or(0),
        workflow_name: r["name"].as_str().unwrap_or_default().to_string(),
        status: r["status"].as_str().unwrap_or_default().to_string(),
        conclusion: r["conclusion"].as_str().map(|s| s.to_string()),
        branch: r["head_branch"].as_str().unwrap_or_default().to_string(),
        event: r["event"].as_str().unwrap_or_default().to_string(),
        actor: r["actor"]["login"].as_str().unwrap_or_default().to_string(),
        head_sha: r["head_sha"].as_str().unwrap_or_default().to_string(),
        created_at: r["created_at"].as_str().unwrap_or_default().to_string(),
        repo: repo.to_string(),
    }
}

/// Recent runs for a repo, or for one workflow (by id or filename) when given.
pub fn list_runs(repo: &str, workflow: Option<&str>, per_page: u32) -> Result<Vec<Run>, String> {
    let path = match workflow {
        Some(w) => format!("repos/{repo}/actions/workflows/{w}/runs?per_page={per_page}"),
        None => format!("repos/{repo}/actions/runs?per_page={per_page}"),
    };
    let v = api(&path)?;
    let mut out = Vec::new();
    if let Some(items) = v["workflow_runs"].as_array() {
        for r in items {
            out.push(parse_run(r, repo));
        }
    }
    Ok(out)
}

pub fn list_jobs(repo: &str, run_id: u64) -> Result<Vec<Job>, String> {
    let v = api(&format!("repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"))?;
    let mut out = Vec::new();
    if let Some(items) = v["jobs"].as_array() {
        for j in items {
            let steps = j["steps"].as_array().map(|ss| {
                ss.iter().map(|s| Step {
                    name: s["name"].as_str().unwrap_or_default().to_string(),
                    status: s["status"].as_str().unwrap_or_default().to_string(),
                    conclusion: s["conclusion"].as_str().map(|x| x.to_string()),
                    number: s["number"].as_u64().unwrap_or(0),
                }).collect()
            }).unwrap_or_default();
            out.push(Job {
                id: j["id"].as_u64().unwrap_or(0),
                name: j["name"].as_str().unwrap_or_default().to_string(),
                status: j["status"].as_str().unwrap_or_default().to_string(),
                conclusion: j["conclusion"].as_str().map(|s| s.to_string()),
                started_at: j["started_at"].as_str().map(|s| s.to_string()),
                completed_at: j["completed_at"].as_str().map(|s| s.to_string()),
                steps,
            });
        }
    }
    Ok(out)
}

/// Latest run for each favorited workflow ("owner/repo:filename"), newest first.
pub fn favorite_runs(favorites: &[String]) -> Result<Vec<Run>, String> {
    let mut out = Vec::new();
    for fav in favorites {
        let Some((repo, file)) = fav.split_once(':') else { continue };
        // Best-effort: skip a favorite whose repo/workflow errors, don't fail all.
        if let Ok(mut runs) = list_runs(repo, Some(file), 1) {
            if let Some(run) = runs.drain(..).next() {
                out.push(run);
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Download a (completed) job's log to a temp file; return its path for the
/// preview pane. Errors (e.g. job still running) propagate so the UI can say so.
pub fn job_log(repo: &str, job_id: u64) -> Result<String, String> {
    // gh follows the 302 to blob storage and returns the plain-text log.
    let text = client::run_gh(&["api", &format!("repos/{repo}/actions/jobs/{job_id}/logs")])?;
    let dir = dirs::cache_dir()
        .map(|d| d.join("vector").join("logs"))
        .ok_or("no cache dir")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("job-{job_id}.log"));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
