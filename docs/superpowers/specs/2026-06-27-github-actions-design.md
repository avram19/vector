# GitHub Actions Center — Design Spec (Plan 3)

**Status:** Approved design, pre-implementation
**Date:** 2026-06-27
**Target:** branch `feat/github-sidebar`, toward v0.3.5
**Builds on:** Plans 0–2 (foundation, repos, PR inbox) + the cross-tab `repoFilter`/combobox patterns.

## Summary

Fill the Actions sub-tab with a full Actions center: a cross-repo **favorited-workflows dashboard**, **per-repo** drill-down (workflows → runs → jobs → steps), **per-job logs** opened in the preview pane, and the write actions **trigger (workflow_dispatch with typed inputs)**, **re-run** (all/failed), and **cancel**. The PR inbox gains a **Deploy** action that opens the trigger modal prefilled with the PR's repo + head branch.

## Architecture

All GitHub access goes through `gh` via the existing `github::client::run_gh`.

**Backend — `src-tauri/src/github/actions.rs`:**
- `list_workflows(repo)` → `gh api repos/{repo}/actions/workflows` → `Vec<Workflow { id, name, path, state }>`.
- `list_runs(repo, workflow_id?, per_page)` → `gh api repos/{repo}/actions/runs` (or `.../workflows/{id}/runs`) → `Vec<Run>`.
- `list_jobs(repo, run_id)` → `gh api repos/{repo}/actions/runs/{run_id}/jobs` → `Vec<Job { id, name, status, conclusion, steps: Vec<Step> }>`.
- `job_log(repo, job_id)` → `gh api repos/{repo}/actions/jobs/{job_id}/logs` (gh follows the redirect, returns text); write to a temp file in the cache dir, return its path. Available once the job completes; in-progress → error/404, surfaced as "still running".
- `workflow_inputs(repo, path)` → `gh api repos/{repo}/contents/{path}` (base64), decode, parse `on.workflow_dispatch.inputs` with **`serde_yaml`** → `Vec<DispatchInput { name, description?, required, type, default?, options? }>`.
- `dispatch(repo, workflow_id, ref, inputs)` → `gh api -X POST repos/{repo}/actions/workflows/{workflow_id}/dispatches -f ref=… -f inputs[k]=v` (inputs as field map).
- `rerun(repo, run_id, failed_only)` → `gh api -X POST repos/{repo}/actions/runs/{run_id}/rerun` (or `/rerun-failed-jobs`).
- `cancel(repo, run_id)` → `gh api -X POST repos/{repo}/actions/runs/{run_id}/cancel`.
- Commands in `github/mod.rs`; favorited-workflow runs for the dashboard fetched per favorite (cached short TTL).

**New dependency:** `serde_yaml` (workflow_dispatch input parsing) — a deliberate, justified addition; deps are otherwise pinned/frozen.

**Frontend:**
- `ActionsView.tsx` — the Actions sub-tab: favorited dashboard + a repo combobox (reuse `RepoFilterDropdown`) → workflows → runs → jobs/steps, with controls.
- `TriggerModal.tsx` — reusable overlay: workflow picker (when not preset) + ref/branch field + typed inputs (string/boolean/choice/environment) + Run. Used by the Actions view AND the PR Deploy button.
- Logs open in the **existing preview pane**: backend writes the job log to a temp file and returns its path; the frontend calls `onOpenPreview(path)`. `onOpenPreview` is threaded `App.tsx → Sidebar → GithubPanel → ActionsView` (and into PrInbox if needed). No new renderer.

## Views

**Favorited dashboard (top of Actions):** latest run for each `favorited_workflows` entry (`"owner/repo:workflow.yml"`), across repos, newest first. Star/unstar a workflow anywhere to add/remove; persisted in `ui.toml` (`github_favorited_workflows: Vec<String>`).

**Per-repo:** repo combobox → workflows list → expand a workflow → recent runs → expand a run → jobs (+ per-step status). Run row: status spinner / conclusion glyph, run #, branch, triggering event, actor, relative time, SHA.

**Refresh:** in-progress runs visible on screen poll on a short interval (~5–8s) and update status; a completed job flips its Logs control from disabled to enabled.

## Controls

- **Per job:** **Logs** → fetch `job_log` once the job is completed → open in preview pane. Failed job → same path (the log shows the failure). Disabled while the job is running.
- **Per run:** **Re-run** (all jobs) / **Re-run failed**; **Cancel** (in-progress only).
- **Per workflow:** **Trigger ▸** → `TriggerModal` (ref + typed inputs).
- **Favorite star** on workflows (dashboard membership).

## Deploy from PR

A **Deploy** action on each PR row opens `TriggerModal` prefilled with the PR's `repo` and `headRef` as the ref. The user picks the workflow (the modal lists the repo's workflows), fills inputs, and runs — triggering straight from the PR without a tab switch.

## Reality caveats (baked in)

- **No public live-streaming logs API.** GitHub's web UI uses a private channel; `gh`/REST cannot tail an in-flight job line-by-line.
- **Per-job logs** are fetched the moment a job completes (progressive across a run), via the jobs `/logs` endpoint — not deferred to whole-run completion. Granularity is per-job (a job log includes all its steps); GitHub exposes no per-step log.
- In-progress jobs show step status (polled); their Logs control is disabled until completion.
- `serde_yaml` added for input parsing.

## Data shapes (camelCase across Rust↔TS)

- `Workflow { id, name, path, state }`
- `Run { id, runNumber, workflowId, workflowName, status, conclusion, branch, event, actor, headSha, createdAt, repo }`
- `Job { id, name, status, conclusion, startedAt, completedAt, steps: Step[] }`
- `Step { name, status, conclusion, number }`
- `DispatchInput { name, description?, required, type, default?, options? }`
- `JobLog { path }` (temp file path for the preview pane)

## Persistence

`ui.toml` gains `github_favorited_workflows: Vec<String>` (`"owner/repo:filename"`). Mirrored in `SidebarState`.

## Module boundaries

- `actions.rs`: one fetch/action fn per concern (workflows/runs/jobs/log/inputs/dispatch/rerun/cancel); pure, returning typed structs.
- `mod.rs`: thin command wrappers (spawn_blocking; lock-not-across-await for any cached ones).
- `ActionsView.tsx` (view + controls), `TriggerModal.tsx` (reusable trigger), each focused.

## Verification (no test suite)

`cargo check` + `tsc`/`npm run build`, then in the running app: dashboard shows favorited runs; per-repo drill-down to jobs/steps; click a completed job → log opens in preview pane; re-run/cancel a real run; trigger a `workflow_dispatch` with inputs; Deploy from a PR opens the modal prefilled with the PR's repo+branch; light theme intact.
