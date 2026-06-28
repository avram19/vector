# GitHub Actions Center — Plan 3b: Trigger + Controls + Deploy-from-PR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the write side of Actions: trigger a workflow_dispatch with a typed input form, re-run (all/failed) and cancel runs, and a Deploy button on PR rows that opens the trigger modal prefilled with the PR's repo + branch.

**Architecture:** Backend `actions.rs` gains `workflow_inputs` (fetch+parse the workflow file's `workflow_dispatch.inputs` with `serde_yaml`), `dispatch`, `rerun`, `cancel`. A reusable `TriggerModal.tsx` (workflow picker + ref + typed inputs) is hosted by `GithubPanel` and opened from both `ActionsView` (per-workflow Trigger) and `PrInboxView` (per-PR Deploy). Re-run/Cancel are inline run controls.

**Tech Stack:** Rust (`gh api`, `serde_json`, **`serde_yaml` (new dep)**), React 18 + TS. Builds on Plan 3a.

## Global Constraints

- **No test suite.** Test cycle: `cargo check --manifest-path src-tauri/Cargo.toml` + `npx tsc --noEmit` + `npm run build`, then manual verification in `npm run tauri dev`.
- **Spec:** `docs/superpowers/specs/2026-06-27-github-actions-design.md`.
- **Builds on Plans 0–3a.** Available: `github::client::run_gh`, `github::actions` (Workflow/Run/Job + list fns), `ActionsView` (controlled `repo`/`onRepo`, favorites), `PrInboxView` (`PullRequest` with `repo`/`headRef`), `GithubPanel` (owns sub-views, `repoFilter`, `actionsRepo`; renders ReposView/PrInboxView/ActionsView), the `--gh-*` tokens.
- **New dependency:** `serde_yaml = "0.9"` in `src-tauri/Cargo.toml` — required to parse workflow_dispatch inputs; justified, flagged.
- **Data layer:** `gh api` only via `client::run_gh`. No webview token handling.
- **Dispatch inputs** are sent as `-f inputs[<name>]=<value>` (the API takes string values even for boolean/number inputs). `ref` via `-f ref=<branch>`.
- **YAML gotcha:** the workflow `on:` key may parse as the string `"on"` (serde_yaml 0.9 / YAML 1.2). Navigate by `"on"` and fall back to the boolean `true` key for robustness.
- **camelCase across Rust↔TS.** Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `feat/github-sidebar`.

---

### Task 1: Backend — workflow inputs, dispatch, rerun, cancel

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `serde_yaml = "0.9"`)
- Modify: `src-tauri/src/github/actions.rs` (DispatchInput struct + `workflow_inputs`, `dispatch`, `rerun`, `cancel`)
- Modify: `src-tauri/src/github/mod.rs` (commands)
- Modify: `src-tauri/src/main.rs` (`generate_handler!`)

**Interfaces:**
- Produces: `actions::DispatchInput { name, description: Option<String>, required: bool, input_type: String (camel `type`? NO — see note), default: Option<String>, options: Vec<String> }`. **Serialize field rename:** the JSON field for `input_type` must be `type` for the frontend — use `#[serde(rename = "type")] pub input_type: String`. Other fields camelCase.
- `actions::workflow_inputs(repo, path) -> Result<Vec<DispatchInput>, String>`
- `actions::dispatch(repo, workflow: &str, git_ref: &str, inputs: Vec<(String,String)>) -> Result<(), String>`
- `actions::rerun(repo, run_id: u64, failed_only: bool) -> Result<(), String>`
- `actions::cancel(repo, run_id: u64) -> Result<(), String>`
- Commands: `github_workflow_inputs(repo, path)`, `github_dispatch(repo, workflow, gitRef, inputs)`, `github_rerun(repo, runId, failedOnly)`, `github_cancel(repo, runId)`.

- [ ] **Step 1: Add the dependency.** In `src-tauri/Cargo.toml`, under `[dependencies]`, add (keep alphabetical near `serde_json`):

```toml
serde_yaml = "0.9"
```

- [ ] **Step 2: Add to `actions.rs`** (after the `job_log_loading` fn). The struct + four fns:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInput {
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    #[serde(rename = "type")]
    pub input_type: String,
    pub default: Option<String>,
    pub options: Vec<String>,
}

/// Fetch a workflow file and parse its `on.workflow_dispatch.inputs` schema.
pub fn workflow_inputs(repo: &str, path: &str) -> Result<Vec<DispatchInput>, String> {
    // contents API returns base64 in `.content`.
    let v = api(&format!("repos/{repo}/contents/{path}"))?;
    let b64: String = v["content"].as_str().unwrap_or_default().split_whitespace().collect();
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let doc: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| format!("yaml: {e}"))?;

    // `on:` may parse as the string "on" or the bool true — try both.
    let on = doc.get("on").or_else(|| doc.get(serde_yaml::Value::Bool(true)));
    let inputs = on
        .and_then(|o| o.get("workflow_dispatch"))
        .and_then(|wd| wd.get("inputs"));
    let mut out = Vec::new();
    if let Some(serde_yaml::Value::Mapping(map)) = inputs {
        for (k, spec) in map {
            let name = k.as_str().unwrap_or_default().to_string();
            if name.is_empty() { continue; }
            let opts = spec.get("options").and_then(|o| o.as_sequence()).map(|seq| {
                seq.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
            }).unwrap_or_default();
            let default = spec.get("default").map(|d| match d {
                serde_yaml::Value::Bool(b) => b.to_string(),
                serde_yaml::Value::Number(n) => n.to_string(),
                serde_yaml::Value::String(s) => s.clone(),
                _ => String::new(),
            });
            out.push(DispatchInput {
                name,
                description: spec.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                required: spec.get("required").and_then(|r| r.as_bool()).unwrap_or(false),
                input_type: spec.get("type").and_then(|t| t.as_str()).unwrap_or("string").to_string(),
                default,
                options: opts,
            });
        }
    }
    Ok(out)
}

fn post_ok(args: &[&str]) -> Result<(), String> {
    client::run_gh(args).map(|_| ())
}

/// Trigger a workflow_dispatch on `git_ref` with string inputs.
pub fn dispatch(repo: &str, workflow: &str, git_ref: &str, inputs: Vec<(String, String)>) -> Result<(), String> {
    let path = format!("repos/{repo}/actions/workflows/{workflow}/dispatches");
    let mut owned: Vec<String> = vec![
        "api".into(), "-X".into(), "POST".into(), path,
        "-f".into(), format!("ref={git_ref}"),
    ];
    for (k, val) in &inputs {
        owned.push("-f".into());
        owned.push(format!("inputs[{k}]={val}"));
    }
    let refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
    post_ok(&refs)
}

pub fn rerun(repo: &str, run_id: u64, failed_only: bool) -> Result<(), String> {
    let ep = if failed_only { "rerun-failed-jobs" } else { "rerun" };
    post_ok(&["api", "-X", "POST", &format!("repos/{repo}/actions/runs/{run_id}/{ep}")])
}

pub fn cancel(repo: &str, run_id: u64) -> Result<(), String> {
    post_ok(&["api", "-X", "POST", &format!("repos/{repo}/actions/runs/{run_id}/cancel")])
}
```

Add the base64 import: `base64` is already an indirect dep via tauri, but to use it directly add `base64 = "0.22"` to Cargo.toml as well (Step 1) OR decode without it. **Simpler: avoid the base64 crate** — request the raw file instead. Replace the contents fetch with the raw endpoint to skip base64 entirely:

Replace the first 8 lines of `workflow_inputs` (through `let text = …`) with:

```rust
pub fn workflow_inputs(repo: &str, path: &str) -> Result<Vec<DispatchInput>, String> {
    // Fetch the raw file (Accept: raw) so we skip base64 decoding.
    let text = client::run_gh(&["api", &format!("repos/{repo}/contents/{path}"), "-H", "Accept: application/vnd.github.raw"])?;
    let doc: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| format!("yaml: {e}"))?;
```

(Drop the `use base64` block and the `let v`/`b64`/`bytes` lines — and do NOT add the base64 crate.)

- [ ] **Step 3: Commands in `mod.rs`** (append after `prepare_github_job_log`):

```rust
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
```

- [ ] **Step 4: Register in `main.rs`** (after `github::prepare_github_job_log,`):

```rust
            github::prepare_github_job_log,
            github::github_workflow_inputs,
            github::github_dispatch,
            github::github_rerun,
            github::github_cancel,
```

- [ ] **Step 5: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors (serde_yaml downloads on first build). `cargo` lockfile updates — that's expected.

- [ ] **Step 6: Smoke-test inputs parse** on a workflow that has dispatch inputs (or any workflow; empty result is fine):

Run: `gh api repos/avram19/vector/contents/.github/workflows/$(gh api repos/avram19/vector/actions/workflows --jq '.workflows[0].path' | xargs basename) -H "Accept: application/vnd.github.raw" | head -5`
Expected: raw YAML text (confirms the raw fetch works).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/github/actions.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): Actions write backend — workflow inputs (serde_yaml), dispatch, rerun, cancel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — TriggerModal

**Files:**
- Create: `src/github/TriggerModal.tsx`
- Modify: `src/index.css` (modal styles)

**Interfaces:**
- Consumes: `invoke<Workflow[]>("list_github_workflows",{repo})`, `invoke<DispatchInput[]>("github_workflow_inputs",{repo,path})`, `invoke("github_dispatch",{repo,workflow,gitRef,inputs})`.
- Produces: `TriggerModal` — props `{ repo: string; presetRef?: string; presetWorkflowId?: number; onClose: () => void }`; types `DispatchInput`.

- [ ] **Step 1: Create `src/github/TriggerModal.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workflow } from "./ActionsView";

export type DispatchInput = {
  name: string; description: string | null; required: boolean;
  type: string; default: string | null; options: string[];
};

export function TriggerModal({ repo, presetRef, presetWorkflowId, onClose }: {
  repo: string;
  presetRef?: string;
  presetWorkflowId?: number;
  onClose: () => void;
}) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [wfId, setWfId] = useState<number | null>(presetWorkflowId ?? null);
  const [inputs, setInputs] = useState<DispatchInput[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [gitRef, setGitRef] = useState(presetRef ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Workflow[]>("list_github_workflows", { repo })
      .then((ws) => { setWorkflows(ws); if (!gitRef && ws.length) setGitRef(""); })
      .catch((e) => setError(String(e)));
  }, [repo]);

  const wf = useMemo(() => workflows?.find((w) => w.id === wfId) ?? null, [workflows, wfId]);

  useEffect(() => {
    if (!wf) { setInputs(null); return; }
    setInputs(null);
    invoke<DispatchInput[]>("github_workflow_inputs", { repo, path: wf.path })
      .then((ins) => {
        setInputs(ins);
        const init: Record<string, string> = {};
        ins.forEach((i) => { init[i.name] = i.default ?? (i.type === "boolean" ? "false" : ""); });
        setValues(init);
      })
      .catch((e) => setError(String(e)));
  }, [wf, repo]);

  const run = () => {
    if (!wf) return;
    const ref = gitRef.trim();
    if (!ref) { setError("Enter a branch/ref to run on."); return; }
    setBusy(true); setError(null);
    const tuples = (inputs ?? []).map((i) => [i.name, values[i.name] ?? ""] as [string, string]);
    invoke("github_dispatch", { repo, workflow: String(wf.id), gitRef: ref, inputs: tuples })
      .then(() => {
        const summary = tuples.length ? tuples.map(([k, v]) => `${k}=${v}`).join(", ") : "no inputs";
        setDone(`Dispatched ${wf.name} on ${ref} — ${summary}`);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="gh-modal-backdrop" onClick={onClose}>
      <div className="gh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gh-modal-h">
          <span>Run workflow — {repo}</span>
          <button className="gh-icobtn" onClick={onClose} title="Close">✕</button>
        </div>
        {done ? (
          <div className="gh-modal-body">
            <p className="gh-modal-ok">✓ {done}</p>
            <button className="gh-modal-run" onClick={onClose}>Close</button>
          </div>
        ) : (
          <div className="gh-modal-body">
            {error && <div className="gh-actions-err">{error}</div>}
            <label className="gh-field">
              <span>Workflow</span>
              <select value={wfId ?? ""} onChange={(e) => setWfId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Select a workflow…</option>
                {workflows?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="gh-field">
              <span>Branch / ref</span>
              <input value={gitRef} onChange={(e) => setGitRef(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
            </label>
            {wf && inputs === null && <div className="gh-placeholder">Loading inputs…</div>}
            {inputs?.map((i) => (
              <label className="gh-field" key={i.name}>
                <span>{i.name}{i.required ? " *" : ""}{i.description ? ` — ${i.description}` : ""}</span>
                {i.type === "boolean" ? (
                  <select value={values[i.name] ?? "false"} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                ) : i.type === "choice" && i.options.length ? (
                  <select value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                    {i.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} autoComplete="off" spellCheck={false} />
                )}
              </label>
            ))}
            <button className="gh-modal-run" disabled={!wf || busy} onClick={run}>{busy ? "Running…" : "Run workflow"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append modal CSS to `src/index.css`**

```css
/* ── GitHub trigger modal ─────────────────────────────────── */
.gh-modal-backdrop { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
.gh-modal { width: 380px; max-width: 90vw; max-height: 85vh; overflow: auto; background: var(--gh-pop-bg); border: 1px solid var(--gh-border); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
.gh-modal-h { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--gh-border); font-size: 13px; font-weight: 600; color: var(--gh-fg); }
.gh-modal-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.gh-field { display: flex; flex-direction: column; gap: 4px; }
.gh-field > span { font-size: 11px; color: var(--gh-muted); }
.gh-field input, .gh-field select { background: var(--gh-input-bg); color: var(--gh-fg); border: 1px solid var(--gh-border); border-radius: 6px; padding: 5px 8px; font-size: 12px; outline: 0; }
.gh-modal-run { background: var(--gh-accent-solid); color: #fff; border: 0; border-radius: 7px; padding: 7px 12px; font-size: 12px; cursor: pointer; }
.gh-modal-run:disabled { opacity: 0.5; cursor: default; }
.gh-modal-ok { color: #2ea043; font-size: 12px; }
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: no errors (TriggerModal unused until Task 3 — fine).

- [ ] **Step 4: Commit**

```bash
git add src/github/TriggerModal.tsx src/index.css
git commit -m "feat(github): TriggerModal — workflow picker + ref + typed inputs + dispatch confirm

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire Trigger/Re-run/Cancel into ActionsView + host the modal

**Files:**
- Modify: `src/github/ActionsView.tsx` (Trigger button per workflow; Re-run/Cancel per run; `onTrigger` prop)
- Modify: `src/github/GithubPanel.tsx` (host `TriggerModal` via a `triggerTarget` state; pass `onTrigger` to ActionsView)

**Interfaces:**
- Consumes: `invoke("github_rerun",{repo,runId,failedOnly})`, `invoke("github_cancel",{repo,runId})`; `onTrigger({ repo, presetWorkflowId? })`.

- [ ] **Step 1: ActionsView — add `onTrigger` prop.** Extend the props destructure + type:

```tsx
  repo, onRepo, onTrigger,
}: {
  ...
  repo: string | null;
  onRepo: (r: string | null) => void;
  onTrigger: (target: { repo: string; presetWorkflowId?: number }) => void;
}) {
```

- [ ] **Step 2: ActionsView — Trigger button on each workflow header.** In the `gh-wf-h` row, after the favorite star span, add:

```tsx
              <button className="gh-job-log" onClick={(e) => { e.stopPropagation(); onTrigger({ repo: repo!, presetWorkflowId: wf.id }); }}>Run ▸</button>
```

- [ ] **Step 3: ActionsView — Re-run/Cancel on each run row.** Add a `rerun`/`cancel` helper near `openLog`:

```tsx
  const refreshRuns = (wfId: number) => {
    if (!repo) return;
    invoke<Run[]>("list_github_runs", { repo, workflow: String(wfId), perPage: 15 })
      .then((rs) => setRunsByWf((m) => ({ ...m, [wfId]: rs }))).catch((e) => setError(String(e)));
  };
  const rerun = (run: Run, failedOnly: boolean) => {
    invoke("github_rerun", { repo: run.repo, runId: run.id, failedOnly })
      .then(() => refreshRuns(run.workflowId)).catch((e) => setError(String(e)));
  };
  const cancel = (run: Run) => {
    invoke("github_cancel", { repo: run.repo, runId: run.id })
      .then(() => refreshRuns(run.workflowId)).catch((e) => setError(String(e)));
  };
```

In the run row (the `gh-run` inside the workflow drill-down), add a controls span after `gh-run-main`:

```tsx
                  <span className="gh-run-actions" onClick={(e) => e.stopPropagation()}>
                    {run.status !== "completed"
                      ? <button className="gh-job-log" onClick={() => cancel(run)}>Cancel</button>
                      : <>
                          <button className="gh-job-log" onClick={() => rerun(run, false)}>Re-run</button>
                          {run.conclusion === "failure" && <button className="gh-job-log" onClick={() => rerun(run, true)}>Re-run failed</button>}
                        </>}
                  </span>
```

- [ ] **Step 4: GithubPanel — host the modal.** Add state + import:

```tsx
import { ActionsView } from "./ActionsView";
import { TriggerModal } from "./TriggerModal";
```
```tsx
  const [triggerTarget, setTriggerTarget] = useState<{ repo: string; presetRef?: string; presetWorkflowId?: number } | null>(null);
```

Pass `onTrigger` to ActionsView:

```tsx
            repo={actionsRepo}
            onRepo={setActionsRepo}
            onTrigger={(t) => setTriggerTarget(t)}
          />
```

Render the modal at the end of the authed `gh-panel` return (just before the closing `</div>` of `.gh-panel`):

```tsx
      {triggerTarget && (
        <TriggerModal
          repo={triggerTarget.repo}
          presetRef={triggerTarget.presetRef}
          presetWorkflowId={triggerTarget.presetWorkflowId}
          onClose={() => setTriggerTarget(null)}
        />
      )}
```

- [ ] **Step 5: Add `.gh-run-actions` CSS** to `src/index.css`:

```css
.gh-run-actions { display: flex; gap: 4px; flex: 0 0 auto; }
```

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10` (no errors); `npm run build 2>&1 | tail -2` (`✓ built`).

```bash
git add src/github/ActionsView.tsx src/github/GithubPanel.tsx src/index.css
git commit -m "feat(github): wire Trigger/Re-run/Cancel into Actions; host TriggerModal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Deploy-from-PR

**Files:**
- Modify: `src/github/PrInboxView.tsx` (Deploy button → `onTrigger`)
- Modify: `src/github/GithubPanel.tsx` (pass `onTrigger` to PrInboxView)

**Interfaces:**
- Consumes: `onTrigger({ repo, presetRef })`.

- [ ] **Step 1: PrInboxView — add `onTrigger` prop.** Extend the destructure + type:

```tsx
export function PrInboxView({ repoFilter, onRepoFilter, login, onTrigger }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
  login: string;
  onTrigger: (target: { repo: string; presetRef?: string }) => void;
}) {
```

- [ ] **Step 2: PrInboxView — Deploy button in `PrRow`.** `PrRow` needs `onTrigger`; thread it. Change the `PrRow` signature to `function PrRow({ pr, onTrigger }: { pr: PullRequest; onTrigger: (t: { repo: string; presetRef?: string }) => void })` and add, in `gh-pr-bot` after the spacer (before Avatar), a Deploy button for OPEN PRs:

```tsx
        {pr.state === "OPEN" && (
          <button className="gh-pr-deploy" title={`Run a workflow on ${pr.headRef}`}
            onClick={(e) => { e.stopPropagation(); onTrigger({ repo: pr.repo, presetRef: pr.headRef }); }}>Deploy</button>
        )}
```

Update every `<PrRow key=... pr={p} />` usage to `<PrRow key={p.url} pr={p} onTrigger={onTrigger} />` (there are several — in each subsection map and the Team list).

- [ ] **Step 3: Deploy button CSS** in `src/index.css`:

```css
.gh-pr-deploy { background: transparent; border: 1px solid var(--gh-border); color: var(--gh-accent); border-radius: 6px; padding: 0 7px; font-size: 10px; cursor: pointer; flex: 0 0 auto; }
.gh-pr-deploy:hover { background: var(--gh-row-hover); }
```

- [ ] **Step 4: GithubPanel — pass `onTrigger` to PrInboxView:**

```tsx
        {active === "prs" && <PrInboxView repoFilter={repoFilter} onRepoFilter={setRepoFilter} login={auth.login ?? ""} onTrigger={(t) => setTriggerTarget(t)} />}
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10` (no errors); `npm run build 2>&1 | tail -2` (`✓ built`).

```bash
git add src/github/PrInboxView.tsx src/github/GithubPanel.tsx src/index.css
git commit -m "feat(github): Deploy button on PR rows opens TriggerModal prefilled with the PR branch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end manual verification

**Files:** none.

- [ ] **Step 1:** `npm run tauri dev` → GitHub → Actions. Pick a repo, expand a workflow, click **Run ▸** → modal opens; pick the workflow (preset), enter a ref, fill any typed inputs → **Run workflow** → success line "Dispatched … — k=v, …".
- [ ] **Step 2: Re-run/Cancel.** On a completed run → **Re-run** (and **Re-run failed** if it failed); on an in-progress run → **Cancel**. The run list refreshes.
- [ ] **Step 3: Typed inputs.** Trigger a workflow that declares `workflow_dispatch.inputs` → the form shows string fields, boolean dropdowns, and choice dropdowns with the right defaults.
- [ ] **Step 4: Deploy-from-PR.** GitHub → Pull Requests → an open PR row → **Deploy** → the modal opens prefilled with that PR's repo and head branch as the ref; pick a workflow + run.
- [ ] **Step 5: Light theme** — modal + controls readable.

If a fix was needed, commit it with a `fix(github):` message + the trailer.

---

## Self-Review

**Spec coverage (3b slice):**
- Trigger workflow_dispatch with typed inputs (string/boolean/choice) + ref → Tasks 1 (`workflow_inputs`,`dispatch`), 2 (TriggerModal). ✓
- "Dispatched with: …" confirmation → Task 2 (`done` summary). ✓
- Re-run (all/failed) + cancel → Tasks 1, 3. ✓
- Deploy-from-PR (prefilled repo+branch, no tab switch — modal overlay) → Task 4. ✓
- serde_yaml dep + YAML `on:` gotcha + raw-file fetch (no base64 crate) → Task 1. ✓

**Placeholder scan:** complete code; loading/error/success states concrete. The Step 2 base64→raw correction is explicit (use raw fetch, don't add base64). ✓

**Type consistency:** `DispatchInput` JSON `type` field (via `#[serde(rename="type")]`) matches the TS `type` field. Commands `github_workflow_inputs{repo,path}`, `github_dispatch{repo,workflow,gitRef,inputs}`, `github_rerun{repo,runId,failedOnly}`, `github_cancel{repo,runId}` match invoke sites. `onTrigger({repo,presetRef?,presetWorkflowId?})` is consistent across ActionsView, PrInboxView, GithubPanel, TriggerModal. ✓
