# GitHub Actions Center — Plan 3a: View + Logs + Favorites

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the Actions sub-tab (read-only): a favorited-workflows dashboard, per-repo drill-down (workflows → runs → jobs → steps), and per-job logs opened in the preview pane.

**Architecture:** New `github/actions.rs` fetches workflows/runs/jobs and downloads a completed job's log to a temp file (via `gh api`). `ActionsView.tsx` renders a favorited dashboard + a repo combobox drill-down; clicking a completed job opens its log in the existing preview pane (logs threaded via `onOpenPreview`). Write actions (trigger/re-run/cancel) and Deploy-from-PR are Plan 3b.

**Tech Stack:** Rust (`gh api`, `serde_json`, `spawn_blocking`), React 18 + TS. Reuses `RepoFilterDropdown`, the `--gh-*` tokens, and the preview pane. No new deps in 3a (`serde_yaml` arrives in 3b).

## Global Constraints

- **No test suite.** Test cycle: `cargo check --manifest-path src-tauri/Cargo.toml` (backend), `npx tsc --noEmit` + `npm run build` (frontend), then manual verification in `npm run tauri dev`. Never claim a task passes without running these.
- **Spec:** `docs/superpowers/specs/2026-06-27-github-actions-design.md`.
- **Builds on Plans 0–2.5.** Available: `github::client::run_gh(&[&str]) -> Result<String,String>`, `github::{CachedResponse,GithubState}`, `AppState.github`, `GithubPanel` (owns `subview`/`onSubview`/`repoState`/`onRepoUpdate`, renders the `actions` placeholder), `RepoFilterDropdown`, the `--gh-*` CSS tokens, and `onOpenPreview(path, line?, col?, { pin })` already threaded `App.tsx → Sidebar`.
- **Data layer:** `gh api` only via `client::run_gh`. No new cargo/npm deps in 3a.
- **Reality:** no public live-log API. Per-job logs are fetched once a job completes (progressive); an in-progress job's Logs control is disabled.
- **camelCase across Rust↔TS** for all returned structs.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feat/github-sidebar`.

---

### Task 1: Backend — actions.rs (workflows, runs, jobs, job log)

**Files:**
- Create: `src-tauri/src/github/actions.rs`

**Interfaces:**
- Produces (all `#[serde(rename_all="camelCase")]`, derive `Serialize, Deserialize, Clone`):
  - `Workflow { id: u64, name, path, state }`
  - `Run { id: u64, run_number: u64, workflow_id: u64, workflow_name, status, conclusion: Option<String>, branch, event, actor, head_sha, created_at, repo }`
  - `Step { name, status, conclusion: Option<String>, number: u64 }`
  - `Job { id: u64, name, status, conclusion: Option<String>, started_at: Option<String>, completed_at: Option<String>, steps: Vec<Step> }`
  - fns: `list_workflows(repo) -> Result<Vec<Workflow>,String>`, `list_runs(repo, workflow: Option<&str>, per_page: u32) -> Result<Vec<Run>,String>`, `list_jobs(repo, run_id: u64) -> Result<Vec<Job>,String>`, `favorite_runs(favorites: &[String]) -> Result<Vec<Run>,String>`, `job_log(repo, job_id: u64) -> Result<String,String>` (returns a temp-file path).

- [ ] **Step 1: Create `src-tauri/src/github/actions.rs`**

```rust
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
```

- [ ] **Step 2: Verify (will warn unused until Task 2 wires it)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: errors that module `actions` is not declared — that's added in Task 2. Do not commit yet.

- [ ] **Step 3: Smoke-test the endpoints** (you are authed):

Run:
```
gh api repos/avram19/vector/actions/runs?per_page=1 --jq '.workflow_runs[0] | {id, run_number, name, status, conclusion, head_branch, event, actor:.actor.login}'
```
Expected: a JSON object with those fields (confirms field names used in `parse_run`).

---

### Task 2: Backend — commands + registration

**Files:**
- Modify: `src-tauri/src/github/mod.rs` (`pub mod actions;` + commands)
- Modify: `src-tauri/src/main.rs` (`generate_handler!`)

**Interfaces:**
- Produces commands: `list_github_workflows(repo)`, `list_github_runs(repo, workflow: Option<String>, per_page: u32)`, `list_github_jobs(repo, run_id: u64)`, `list_github_favorite_runs(favorites: Vec<String>)`, `get_github_job_log(repo, job_id: u64) -> String` (temp path).

- [ ] **Step 1: Add module + commands to `src-tauri/src/github/mod.rs`** — add `pub mod actions;` under `pub mod prs;`, then append:

```rust
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
```

- [ ] **Step 2: Register in `src-tauri/src/main.rs`** — after `github::list_github_repo_prs,`:

```rust
            github::list_github_repo_prs,
            github::list_github_workflows,
            github::list_github_runs,
            github::list_github_jobs,
            github::list_github_favorite_runs,
            github::get_github_job_log,
```

- [ ] **Step 3: Verify compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors (pre-existing warnings OK).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/github/actions.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): Actions backend — workflows, runs, jobs, per-job logs, favorite runs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Backend — persist favorited workflows

**Files:**
- Modify: `src-tauri/src/config.rs` (`UiConfig` + `Default`)
- Modify: `src-tauri/src/main.rs` (`SidebarConfigPatch` + `update_sidebar_config`)

**Interfaces:**
- Produces `UiConfig.github_favorited_workflows: Vec<String>` (`#[serde(default)]`), settable via `update_sidebar_config`.

- [ ] **Step 1: Add the field to `UiConfig`** (after `github_collapsed_groups`):

```rust
    #[serde(default)]
    pub github_collapsed_groups: Vec<String>,
    #[serde(default)]
    pub github_favorited_workflows: Vec<String>,
```

- [ ] **Step 2: Add to the `Default` impl** (after `github_collapsed_groups: Vec::new(),`):

```rust
            github_collapsed_groups: Vec::new(),
            github_favorited_workflows: Vec::new(),
```

- [ ] **Step 3: Extend `SidebarConfigPatch` in `main.rs`** (after `github_collapsed_groups: Option<Vec<String>>,`):

```rust
    github_collapsed_groups: Option<Vec<String>>,
    github_favorited_workflows: Option<Vec<String>>,
```

- [ ] **Step 4: Apply in `update_sidebar_config`** (before `config::save_ui_config`):

```rust
    if let Some(v) = patch.github_collapsed_groups { cfg.github_collapsed_groups = v; }
    if let Some(v) = patch.github_favorited_workflows { cfg.github_favorited_workflows = v; }
    config::save_ui_config(&cfg).map_err(|e| e.to_string())
```

- [ ] **Step 5: Verify + commit**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -2` (Expected: `Finished`.)

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs
git commit -m "feat(github): persist favorited workflows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — ActionsView (dashboard + drill-down + logs)

**Files:**
- Create: `src/github/ActionsView.tsx`
- Modify: `src/sidebar/sidebarState.ts` (add `github_favorited_workflows`)
- Modify: `src/index.css` (Actions styles)

**Interfaces:**
- Consumes: `invoke<Workflow[]>("list_github_workflows",{repo})`, `invoke<Run[]>("list_github_runs",{repo,workflow,perPage})`, `invoke<Job[]>("list_github_jobs",{repo,runId})`, `invoke<Run[]>("list_github_favorite_runs",{favorites})`, `invoke<string>("get_github_job_log",{repo,jobId})`; props `favorites: string[]`, `onFavorites: (next: string[]) => void`, `onOpenPreview: (path: string, line: number|undefined, col: number|undefined, opts: { pin: boolean }) => void`.
- Produces: `ActionsView`; TS types `Workflow`, `Run`, `Job`, `Step`.

- [ ] **Step 1: Add the state field in `src/sidebar/sidebarState.ts`** — to `SidebarState` (after `github_collapsed_groups`) and `DEFAULT`:

```ts
  github_collapsed_groups: string[];
  github_favorited_workflows: string[];
```
```ts
  github_collapsed_groups: [],
  github_favorited_workflows: [],
```

- [ ] **Step 2: Create `src/github/ActionsView.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RepoFilterDropdown } from "./RepoFilterDropdown";

export type Workflow = { id: number; name: string; path: string; state: string };
export type Step = { name: string; status: string; conclusion: string | null; number: number };
export type Job = { id: number; name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; steps: Step[] };
export type Run = {
  id: number; runNumber: number; workflowId: number; workflowName: string;
  status: string; conclusion: string | null; branch: string; event: string;
  actor: string; headSha: string; createdAt: string; repo: string;
};

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d`;
  return `${Math.floor(d / 7)}w`;
}

function StatusGlyph({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== "completed") return <span className="gh-run-spin" title={status} />;
  if (conclusion === "success") return <span className="gh-run-ico ok" title="success">✔</span>;
  if (conclusion === "failure" || conclusion === "timed_out") return <span className="gh-run-ico bad" title={conclusion}>✖</span>;
  if (conclusion === "cancelled") return <span className="gh-run-ico dim" title="cancelled">⊘</span>;
  return <span className="gh-run-ico dim" title={conclusion ?? "done"}>•</span>;
}

function favKey(repo: string, path: string) { return `${repo}:${path.split("/").pop()}`; }

export function ActionsView({ favorites, onFavorites, onOpenPreview }: {
  favorites: string[];
  onFavorites: (next: string[]) => void;
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
}) {
  const [favRuns, setFavRuns] = useState<Run[] | null>(null);
  const [allRepos, setAllRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runsByWf, setRunsByWf] = useState<Record<number, Run[]>>({});
  const [jobsByRun, setJobsByRun] = useState<Record<number, Job[]>>({});
  const [openWf, setOpenWf] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFavRuns = useCallback(() => {
    if (favorites.length === 0) { setFavRuns([]); return; }
    invoke<Run[]>("list_github_favorite_runs", { favorites }).then(setFavRuns).catch((e) => setError(String(e)));
  }, [favorites]);

  useEffect(() => { loadFavRuns(); }, [loadFavRuns]);

  useEffect(() => {
    invoke<{ nameWithOwner: string }[]>("get_cached_github_repos")
      .then((rs) => setAllRepos(rs.map((r) => r.nameWithOwner)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!repo) { setWorkflows(null); return; }
    setWorkflows(null); setRunsByWf({}); setOpenWf(null); setJobsByRun({}); setOpenRun(null);
    invoke<Workflow[]>("list_github_workflows", { repo }).then(setWorkflows).catch((e) => setError(String(e)));
  }, [repo]);

  const toggleWf = (wf: Workflow) => {
    if (openWf === wf.id) { setOpenWf(null); return; }
    setOpenWf(wf.id);
    if (!runsByWf[wf.id] && repo) {
      invoke<Run[]>("list_github_runs", { repo, workflow: String(wf.id), perPage: 15 })
        .then((rs) => setRunsByWf((m) => ({ ...m, [wf.id]: rs })))
        .catch((e) => setError(String(e)));
    }
  };

  const toggleRun = (run: Run) => {
    if (openRun === run.id) { setOpenRun(null); return; }
    setOpenRun(run.id);
    if (!jobsByRun[run.id]) {
      invoke<Job[]>("list_github_jobs", { repo: run.repo, runId: run.id })
        .then((js) => setJobsByRun((m) => ({ ...m, [run.id]: js })))
        .catch((e) => setError(String(e)));
    }
  };

  const openLog = (run: Run, job: Job) => {
    invoke<string>("get_github_job_log", { repo: run.repo, jobId: job.id })
      .then((path) => onOpenPreview(path, undefined, undefined, { pin: false }))
      .catch((e) => setError(`Log not available yet: ${e}`));
  };

  const isFav = (repo: string, path: string) => favorites.includes(favKey(repo, path));
  const toggleFav = (repo: string, path: string) => {
    const k = favKey(repo, path);
    onFavorites(favorites.includes(k) ? favorites.filter((x) => x !== k) : [...favorites, k]);
  };

  const repoOptions = useMemo(() => [...allRepos].sort(), [allRepos]);

  return (
    <div className="gh-actions">
      {error && <div className="gh-actions-err" onClick={() => setError(null)}>{error}</div>}

      <div className="gh-act-section">
        <div className="gh-act-h"><span className="gh-star">★</span> Favorited workflows</div>
        {favRuns === null && <div className="gh-placeholder">Loading…</div>}
        {favRuns !== null && favRuns.length === 0 && <div className="gh-placeholder">Star a workflow below to track it here.</div>}
        {favRuns?.map((r) => (
          <div className="gh-run" key={`${r.repo}-${r.id}`} onClick={() => { setRepo(r.repo); }}>
            <StatusGlyph status={r.status} conclusion={r.conclusion} />
            <div className="gh-run-main">
              <div className="gh-run-l1"><span className="gh-run-wf">{r.workflowName}</span> <span className="gh-run-n">#{r.runNumber}</span></div>
              <div className="gh-run-l2"><span className="gh-run-repo">{r.repo}</span> · <span className="gh-run-branch">{r.branch}</span> · {r.event} · {relTime(r.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="gh-act-section">
        <div className="gh-act-h">Repository</div>
        <div className="gh-pr-repofilter">
          <RepoFilterDropdown value={repo} options={repoOptions} onChange={setRepo} />
        </div>
        {repo && workflows === null && <div className="gh-placeholder">Loading workflows…</div>}
        {workflows?.length === 0 && <div className="gh-placeholder">No workflows.</div>}
        {workflows?.map((wf) => (
          <div className="gh-wf" key={wf.id}>
            <div className="gh-wf-h" onClick={() => toggleWf(wf)}>
              <span className="gh-caret">{openWf === wf.id ? "▾" : "▸"}</span>
              <span className="gh-wf-name">{wf.name}</span>
              <span
                className="gh-pin"
                title={isFav(repo!, wf.path) ? "Unfavorite" : "Favorite"}
                onClick={(e) => { e.stopPropagation(); toggleFav(repo!, wf.path); }}
              >{isFav(repo!, wf.path) ? "★" : "☆"}</span>
            </div>
            {openWf === wf.id && (runsByWf[wf.id] ?? []).map((run) => (
              <div className="gh-run-wrap" key={run.id}>
                <div className="gh-run" onClick={() => toggleRun(run)}>
                  <span className="gh-caret">{openRun === run.id ? "▾" : "▸"}</span>
                  <StatusGlyph status={run.status} conclusion={run.conclusion} />
                  <div className="gh-run-main">
                    <div className="gh-run-l1"><span className="gh-run-n">#{run.runNumber}</span> <span className="gh-run-branch">{run.branch}</span></div>
                    <div className="gh-run-l2">{run.event} · {run.actor} · {relTime(run.createdAt)}</div>
                  </div>
                </div>
                {openRun === run.id && (jobsByRun[run.id] ?? []).map((job) => (
                  <div className="gh-job" key={job.id}>
                    <StatusGlyph status={job.status} conclusion={job.conclusion} />
                    <span className="gh-job-name">{job.name}</span>
                    {job.status === "completed" ? (
                      <button className="gh-job-log" onClick={() => openLog(run, job)}>Logs</button>
                    ) : (
                      <span className="gh-job-running">running…</span>
                    )}
                  </div>
                ))}
                {openRun === run.id && !jobsByRun[run.id] && <div className="gh-placeholder">Loading jobs…</div>}
              </div>
            ))}
            {openWf === wf.id && !runsByWf[wf.id] && <div className="gh-placeholder">Loading runs…</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Append styles to `src/index.css`**

```css
/* ── GitHub Actions ───────────────────────────────────────── */
.gh-actions { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: auto; padding-bottom: 12px; }
.gh-actions-err { margin: 6px 10px; padding: 6px 8px; font-size: 11px; color: #f85149; border: 1px solid rgba(248,81,73,0.4); border-radius: 6px; cursor: pointer; }
.gh-act-section { margin-top: 8px; }
.gh-act-h { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--gh-muted); }
.gh-run { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 7px; cursor: pointer; }
.gh-run:hover { background: var(--gh-row-hover); }
.gh-run-wrap { padding-left: 14px; }
.gh-run-main { min-width: 0; flex: 1; }
.gh-run-l1 { display: flex; gap: 6px; align-items: baseline; color: var(--gh-fg); font-size: 12.5px; }
.gh-run-wf { font-weight: 600; }
.gh-run-n { color: var(--gh-faint); font-size: 11px; }
.gh-run-l2 { color: var(--gh-faint); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-run-repo { color: var(--gh-muted); }
.gh-run-branch { color: var(--gh-accent); }
.gh-run-ico { flex: 0 0 auto; width: 14px; text-align: center; font-size: 12px; }
.gh-run-ico.ok { color: #2ea043; }
.gh-run-ico.bad { color: #f85149; }
.gh-run-ico.dim { color: var(--gh-faint); }
.gh-run-spin { flex: 0 0 auto; width: 11px; height: 11px; border: 2px solid var(--gh-border); border-top-color: var(--gh-accent); border-radius: 50%; animation: gh-spin 0.8s linear infinite; }
@keyframes gh-spin { to { transform: rotate(360deg); } }
.gh-wf { margin: 0 4px; }
.gh-wf-h { display: flex; align-items: center; gap: 6px; padding: 6px 6px; border-radius: 7px; cursor: pointer; }
.gh-wf-h:hover { background: var(--gh-row-hover); }
.gh-wf-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gh-fg); font-size: 12.5px; }
.gh-job { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 28px; font-size: 12px; color: var(--gh-muted); }
.gh-job-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gh-job-log { background: transparent; border: 1px solid var(--gh-border); color: var(--gh-accent); border-radius: 6px; padding: 1px 8px; font-size: 11px; cursor: pointer; flex: 0 0 auto; }
.gh-job-log:hover { background: var(--gh-row-hover); }
.gh-job-running { color: var(--gh-faint); font-size: 11px; flex: 0 0 auto; }
```

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: errors ONLY about `ActionsView`'s call site / `sidebarState` consumers needing the new field (fixed in Task 5). `ActionsView.tsx` itself should be clean.

- [ ] **Step 5: Commit**

```bash
git add src/github/ActionsView.tsx src/sidebar/sidebarState.ts src/index.css
git commit -m "feat(github): ActionsView — favorited dashboard + per-repo runs/jobs + log links

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Mount ActionsView + thread favorites & onOpenPreview

**Files:**
- Modify: `src/github/GithubPanel.tsx` (props + mount)
- Modify: `src/sidebar/Sidebar.tsx` (pass `onOpenPreview` into `GithubPanel`)

**Interfaces:**
- Consumes: `ActionsView`; `state.github_favorited_workflows` + `update`; `onOpenPreview` (already a `Sidebar` prop).

- [ ] **Step 1: Extend `GithubPanel` props + import.** Add the import after the `PrInboxView` import:

```tsx
import { PrInboxView } from "./PrInboxView";
import { ActionsView } from "./ActionsView";
```

Add to the `GithubPanel({ … })` destructure + type:

```tsx
  favoritedWorkflows,
  onFavoritedWorkflows,
  onOpenPreview,
```
```tsx
  favoritedWorkflows: string[];
  onFavoritedWorkflows: (next: string[]) => void;
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
```

- [ ] **Step 2: Replace the actions placeholder** in `GithubPanel`:

```tsx
        {active === "actions" && (
          <ActionsView
            favorites={favoritedWorkflows}
            onFavorites={(next) => onFavoritedWorkflows(next)}
            onOpenPreview={onOpenPreview}
          />
        )}
```

- [ ] **Step 3: Pass props from `Sidebar.tsx`** — update the `<GithubPanel … />` render to add:

```tsx
                onRepoUpdate={(patch) => update(patch)}
                favoritedWorkflows={state.github_favorited_workflows}
                onFavoritedWorkflows={(next) => update({ github_favorited_workflows: next })}
                onOpenPreview={onOpenPreview}
              />
```

(`onOpenPreview` is already a prop of `Sidebar` — thread it straight through. If TypeScript complains that it may be `undefined`, guard with `onOpenPreview={onOpenPreview ?? (() => {})}`.)

- [ ] **Step 4: Verify types + build**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10` (Expected: no errors.)
Run: `npm run build 2>&1 | tail -2` (Expected: `✓ built`.)

- [ ] **Step 5: Commit**

```bash
git add src/github/GithubPanel.tsx src/sidebar/Sidebar.tsx
git commit -m "feat(github): mount ActionsView; thread favorites + onOpenPreview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end manual verification

**Files:** none.

- [ ] **Step 1:** `npm run tauri dev` → GitHub → **Actions**.
- [ ] **Step 2: Per-repo drill-down.** Pick a repo in the combobox → workflows list; expand a workflow → recent runs (status glyph: spinner for in-progress, ✔/✖/⊘ for done); expand a run → jobs with per-status.
- [ ] **Step 3: Logs.** On a **completed** job click **Logs** → the job log opens in the preview pane. An in-progress job shows "running…" with no Logs button.
- [ ] **Step 4: Favorites.** Click the ☆ on a workflow → it fills (★) and appears in the **Favorited workflows** dashboard at top (latest run); quit + relaunch → still favorited (persisted). Unstar removes it.
- [ ] **Step 5: Light theme.** Switch to Solarized Light → Actions list, glyphs, log button readable.

If a fix was needed, commit it with a `fix(github):` message + the trailer.

---

## Self-Review

**Spec coverage (3a slice):**
- Favorited dashboard (cross-repo, latest run, persisted) → Tasks 1 (`favorite_runs`), 3, 4. ✓
- Per-repo workflows → runs → jobs/steps → Tasks 1, 4. ✓
- Per-job logs in preview pane (completed jobs; progressive) → Task 1 (`job_log` temp file), 4 (`openLog` → `onOpenPreview`), 5 (threading). ✓
- Reality (no live tail; running job log disabled) → Task 4 (`job.status === "completed"` gate). ✓
- Trigger / re-run / cancel / Deploy-from-PR → Plan 3b (out of 3a scope). ✓

**Placeholder scan:** concrete loading/empty/error states; no TBDs. Trigger/controls intentionally deferred to 3b. ✓

**Type consistency:** `Workflow/Run/Job/Step` camelCase identical Rust↔TS. Commands: `list_github_workflows{repo}`, `list_github_runs{repo,workflow,perPage}`, `list_github_jobs{repo,runId}`, `list_github_favorite_runs{favorites}`, `get_github_job_log{repo,jobId}` — args match the invoke call sites. `github_favorited_workflows` field name identical across `UiConfig`/`SidebarConfigPatch`/`SidebarState`. `favKey` = `"owner/repo:filename"` matches `favorite_runs` split on `:`. New `GithubPanel` props threaded from `Sidebar` in Task 5. ✓
