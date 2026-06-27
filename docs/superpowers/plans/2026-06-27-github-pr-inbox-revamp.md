# GitHub PR Inbox Revamp + Incremental Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Repos and PRs load progressively, restructure the PR inbox into My PRs (with readiness subsections) + Team PRs with collapsible sections and lifecycle badges, and wire a repo's PR-count badge to a filtered PR view.

**Architecture:** Repos switch to frontend-driven cursor pagination (`list_github_repos_page`); the frontend accumulates pages, rendering each as it arrives, then persists via `set_cached_github_repos`. PRs split into two phased fetches (`list_github_my_prs`, `list_github_team_prs`), each SWR-cached. The PR inbox UI is rebuilt around My/Team sections; `GithubPanel` owns a `repoFilter` for cross-tab navigation.

**Tech Stack:** Rust (Tauri commands, `serde_json`, `spawn_blocking`, `parking_lot`), React 18 + TS. Reuses `open_path`, the `--gh-*` tokens, and the SWR pattern. No new deps.

## Global Constraints

- **No test suite.** Test cycle: `cargo check --manifest-path src-tauri/Cargo.toml` (backend), `npx tsc --noEmit` + `npm run build` (frontend), then manual verification in `npm run tauri dev`. Never claim a task passes without running these.
- **Spec:** `docs/superpowers/specs/2026-06-27-pr-inbox-revamp-design.md` is the source of truth.
- **Builds on Plans 0–2 (this branch).** Available: `github::client::run_gh`, `github::CachedResponse`/`GithubState`, `repos.rs` (`Repo` with `is_archived`, disk cache), `prs.rs` (`PullRequest`, `parse_pr`, GraphQL-error check), the `--gh-*` CSS tokens, `GithubPanel` (owns `subview`/`onSubview`, `repoState`, `onRepoUpdate`; renders `ReposView` + `PrInboxView`).
- **Data layer:** `gh api graphql` only via `client::run_gh`. No new cargo/npm deps. Cache lock guard must NOT be held across `.await` (scope the read into an inner block, re-lock to insert) — mirror existing commands.
- **camelCase across Rust↔TS:** `ReposPage { repos, nextCursor }`; `MyPrs { authored, recentlyClosed }`; `PullRequest.state` is `OPEN|MERGED|CLOSED`.
- **Subsection rules (My PRs, open authored):** Needs Action = `reviewDecision==="CHANGES_REQUESTED" || ciStatus==="FAILURE" || ciStatus==="ERROR" || mergeable==="CONFLICTING"` (precedence); Ready to Merge = `reviewDecision==="APPROVED" && mergeable==="MERGEABLE" && (ciStatus==="SUCCESS" || ciStatus===null) && !isDraft`; Waiting = the rest. Done = merged/closed in last 7 days.
- **Team PRs** = `review-requested:@me` open.
- **Out of scope:** Deploy button (Plan 3), worktree linking (Plan 2b), persisted PR-collapse.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feat/github-sidebar`.

---

### Task 1: Backend — Repos cursor pagination

**Files:**
- Modify: `src-tauri/src/github/repos.rs` (replace `list_repos` with `list_repos_page`)
- Modify: `src-tauri/src/github/mod.rs` (replace `list_github_repos` with `list_github_repos_page`; add `set_cached_github_repos`; keep `get_cached_github_repos`)
- Modify: `src-tauri/src/main.rs` (`generate_handler!`)

**Interfaces:**
- Produces: `repos::ReposPage { repos: Vec<Repo>, next_cursor: Option<String> }` (camelCase `repos`, `nextCursor`); `repos::list_repos_page(cursor: Option<String>) -> Result<ReposPage, String>`; commands `list_github_repos_page(cursor: Option<String>)`, `set_cached_github_repos(repos: Vec<Repo>)`.
- Removes: `repos::list_repos`, command `list_github_repos`.

- [ ] **Step 1: In `repos.rs`, change the query page size and replace `list_repos`.** The `QUERY` const already takes `$endCursor`; change `repositories(first: 100,` to `repositories(first: 50,`. Then replace the entire `pub fn list_repos() -> Result<Vec<Repo>, String> { ... }` function with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReposPage {
    pub repos: Vec<Repo>,
    pub next_cursor: Option<String>,
}

/// Fetch ONE page of repositories (after `cursor`). Returns the page + the next
/// cursor (None when exhausted) so the frontend can render progressively.
pub fn list_repos_page(cursor: Option<String>) -> Result<ReposPage, String> {
    let query_arg = format!("query={QUERY}");
    let mut args: Vec<String> = vec!["api".into(), "graphql".into(), "-f".into(), query_arg];
    if let Some(c) = &cursor {
        args.push("-f".into());
        args.push(format!("endCursor={c}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let raw = client::run_gh(&arg_refs)?;

    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()).filter(|a| !a.is_empty()) {
        let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error");
        return Err(msg.to_string());
    }
    let conn = &v["data"]["viewer"]["repositories"];

    let mut repos: Vec<Repo> = Vec::new();
    if let Some(nodes) = conn["nodes"].as_array() {
        for n in nodes {
            repos.push(Repo {
                name_with_owner: n["nameWithOwner"].as_str().unwrap_or_default().to_string(),
                owner: n["owner"]["login"].as_str().unwrap_or_default().to_string(),
                is_private: n["isPrivate"].as_bool().unwrap_or(false),
                is_archived: n["isArchived"].as_bool().unwrap_or(false),
                pushed_at: n["pushedAt"].as_str().map(|s| s.to_string()),
                default_branch: n["defaultBranchRef"]["name"].as_str().map(|s| s.to_string()),
                open_pr_count: n["pullRequests"]["totalCount"].as_u64().unwrap_or(0) as u32,
            });
        }
    }
    let next_cursor = if conn["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
        conn["pageInfo"]["endCursor"].as_str().map(|s| s.to_string())
    } else {
        None
    };

    Ok(ReposPage { repos, next_cursor })
}
```

Leave `read_disk_cache` / `write_disk_cache` unchanged.

- [ ] **Step 2: In `mod.rs`, replace the `list_github_repos` command** (the whole `pub async fn list_github_repos(...) { ... }`) with the paged command + a disk-cache setter. Keep `get_cached_github_repos` as-is.

```rust
#[tauri::command]
pub async fn list_github_repos_page(
    _state: State<'_, AppState>,
    cursor: Option<String>,
) -> Result<repos::ReposPage, String> {
    tauri::async_runtime::spawn_blocking(move || repos::list_repos_page(cursor))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_cached_github_repos(
    _state: State<'_, AppState>,
    repos: Vec<repos::Repo>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || repos::write_disk_cache(&repos))
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: In `main.rs`, update `generate_handler!`** — replace `github::list_github_repos,` with:

```rust
            github::list_github_repos_page,
            github::set_cached_github_repos,
            github::get_cached_github_repos,
```

- [ ] **Step 4: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors. (The in-memory `cache` keyed `"repos"` is no longer written here — that's fine; disk cache is the SWR source now. If an unused-import warning appears for something you removed, clean it.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/github/repos.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): paginate repos fetch (one page at a time)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — split PR inbox into My PRs + Team PRs

**Files:**
- Modify: `src-tauri/src/github/prs.rs` (replace `PrInbox`/`list_prs` with `MyPrs`/`list_my_prs`/`list_team_prs` + per-kind disk cache)
- Modify: `src-tauri/src/github/mod.rs` (replace `list_github_prs`/`get_cached_github_prs` with four commands)
- Modify: `src-tauri/src/main.rs` (`generate_handler!`)

**Interfaces:**
- Produces: `prs::MyPrs { authored: Vec<PullRequest>, recently_closed: Vec<PullRequest> }` (camelCase `recentlyClosed`); `prs::list_my_prs() -> Result<MyPrs,String>`; `prs::list_team_prs() -> Result<Vec<PullRequest>,String>`; disk helpers `read_my_prs_cache`/`write_my_prs_cache`/`read_team_prs_cache`/`write_team_prs_cache`; commands `list_github_my_prs(force)`, `get_cached_github_my_prs()`, `list_github_team_prs(force)`, `get_cached_github_team_prs()`.
- Removes: `prs::PrInbox`, `prs::list_prs`, `prs::read_disk_cache`, `prs::write_disk_cache`, commands `list_github_prs`/`get_cached_github_prs`.
- Keeps: `prs::PullRequest`, `prs::parse_pr`.

- [ ] **Step 1: In `prs.rs`, replace `PrInbox` and `list_prs`** (and the old single disk cache) with two queries + `MyPrs`. Keep `PullRequest` and `parse_pr` unchanged. Replace the `PrInbox` struct, the `QUERY` const, `list_prs`, and the disk-cache fns with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MyPrs {
    pub authored: Vec<PullRequest>,
    pub recently_closed: Vec<PullRequest>,
}

const MY_QUERY: &str = r#"fragment prFields on PullRequest {
  number title url isDraft state headRefName reviewDecision mergeable updatedAt
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
query {
  authored: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
  closed: search(query: "is:pr author:@me is:closed sort:updated-desc", type: ISSUE, first: 30) { nodes { ...prFields } }
}"#;

const TEAM_QUERY: &str = r#"fragment prFields on PullRequest {
  number title url isDraft state headRefName reviewDecision mergeable updatedAt
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
query {
  review: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
}"#;

fn run_search(query: &str) -> Result<serde_json::Value, String> {
    let q = format!("query={query}");
    let raw = client::run_gh(&["api", "graphql", "-f", &q])?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
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

/// My authored PRs (open) + my recently closed/merged PRs. One round-trip.
pub fn list_my_prs() -> Result<MyPrs, String> {
    let v = run_search(MY_QUERY)?;
    Ok(MyPrs {
        authored: collect(&v, "authored"),
        recently_closed: collect(&v, "closed"),
    })
}

/// Open PRs where I'm a requested reviewer. One round-trip.
pub fn list_team_prs() -> Result<Vec<PullRequest>, String> {
    let v = run_search(TEAM_QUERY)?;
    Ok(collect(&v, "review"))
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

fn write_json<T: Serialize>(name: &str, val: &T) {
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
pub fn write_team_prs_cache(v: &[PullRequest]) { write_json("team-prs.json", &v.to_vec()) }
```

Also remove the now-unused `use std::path::PathBuf;` import at the top of `prs.rs` if present (the new code uses fully-qualified `std::path::PathBuf`). Run `cargo check` in Step 4 to catch it.

- [ ] **Step 2: In `mod.rs`, replace the two PR commands** (`list_github_prs`, `get_cached_github_prs`) with four. Pattern mirrors the repos cache command (60s TTL keyed per kind; lock dropped before await):

```rust
#[tauri::command]
pub async fn list_github_my_prs(
    state: State<'_, AppState>,
    force: bool,
) -> Result<prs::MyPrs, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);
    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("my_prs").and_then(|c| {
                if c.fetched_at.elapsed() < TTL { serde_json::from_str::<prs::MyPrs>(&c.body).ok() } else { None }
            })
        };
        if let Some(hit) = cached { return Ok(hit); }
    }
    let fresh = tauri::async_runtime::spawn_blocking(prs::list_my_prs).await.map_err(|e| e.to_string())??;
    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert("my_prs".to_string(), CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() });
    }
    let to_disk = fresh.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || prs::write_my_prs_cache(&to_disk)).await;
    Ok(fresh)
}

#[tauri::command]
pub async fn get_cached_github_my_prs(_state: State<'_, AppState>) -> Result<prs::MyPrs, String> {
    tauri::async_runtime::spawn_blocking(prs::read_my_prs_cache).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_github_team_prs(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<prs::PullRequest>, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);
    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("team_prs").and_then(|c| {
                if c.fetched_at.elapsed() < TTL { serde_json::from_str::<Vec<prs::PullRequest>>(&c.body).ok() } else { None }
            })
        };
        if let Some(hit) = cached { return Ok(hit); }
    }
    let fresh = tauri::async_runtime::spawn_blocking(prs::list_team_prs).await.map_err(|e| e.to_string())??;
    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert("team_prs".to_string(), CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() });
    }
    let to_disk = fresh.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || prs::write_team_prs_cache(&to_disk)).await;
    Ok(fresh)
}

#[tauri::command]
pub async fn get_cached_github_team_prs(_state: State<'_, AppState>) -> Result<Vec<prs::PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(prs::read_team_prs_cache).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 3: In `main.rs`, update `generate_handler!`** — replace `github::list_github_prs,` and `github::get_cached_github_prs,` with:

```rust
            github::list_github_my_prs,
            github::get_cached_github_my_prs,
            github::list_github_team_prs,
            github::get_cached_github_team_prs,
```

- [ ] **Step 4: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -4`
Expected: `Finished`, no errors. Fix any unused-import warning from the removed `PathBuf` import.

- [ ] **Step 5: Smoke-test both queries** (you are authed):

Run: `gh api graphql -f query='query{ review: search(query:"is:pr is:open review-requested:@me", type:ISSUE, first:1){ issueCount } }' --jq '.data.review.issueCount'`
Expected: a number (your review-requested count).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/github/prs.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): split PR inbox into My PRs + Team PRs (phased, SWR)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — Repos incremental load + clickable PR badge

**Files:**
- Modify: `src/github/ReposView.tsx`

**Interfaces:**
- Consumes: `invoke<ReposPage>("list_github_repos_page", { cursor })`, `invoke("set_cached_github_repos", { repos })`, `invoke<Repo[]>("get_cached_github_repos")`; new prop `onOpenPrs: (repo: string) => void`.
- Produces: `ReposView` accepts `onOpenPrs`.

- [ ] **Step 1: Add `onOpenPrs` to the props.** In the `ReposView({ ... }: { ... })` signature add `onOpenPrs: (repo: string) => void;` and destructure `onOpenPrs`.

- [ ] **Step 2: Replace the load logic with incremental paging.** Replace the existing `load` callback + the mount `useEffect` with:

```tsx
  const load = useCallback(async (force: boolean) => {
    setRefreshing(true);
    setError(null);
    try {
      const all: Repo[] = [];
      let cursor: string | null = null;
      // First page replaces; subsequent pages append — the view fills in live.
      do {
        const page = await invoke<{ repos: Repo[]; nextCursor: string | null }>(
          "list_github_repos_page", { cursor }
        );
        all.push(...page.repos);
        setRepos([...all]);
        cursor = page.nextCursor;
      } while (cursor);
      await invoke("set_cached_github_repos", { repos: all }).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<Repo[]>("get_cached_github_repos")
      .then((cached) => { if (alive && cached.length) { setRepos(cached); setLoading(false); } })
      .catch(() => {})
      .finally(() => { if (alive) load(false); });
    return () => { alive = false; };
  }, [load]);
```

(Note: `force` is accepted for the Retry/⋮-Refresh callers; paging always refetches from the first page.)

- [ ] **Step 3: Make the PR-count badge clickable.** Find the row meta where the pill renders (`{r.openPrCount > 0 && <span className="gh-pill">{r.openPrCount} PR…</span>}`) and replace that span with a button that opens the filtered PR view:

```tsx
                    {r.openPrCount > 0 && (
                      <button
                        className="gh-pill gh-pill-btn"
                        title={`Show ${r.openPrCount} open PR${r.openPrCount > 1 ? "s" : ""} for ${r.nameWithOwner}`}
                        onClick={(e) => { e.stopPropagation(); onOpenPrs(r.nameWithOwner); }}
                      >{r.openPrCount} PR{r.openPrCount > 1 ? "s" : ""}</button>
                    )}
```

- [ ] **Step 4: Add the button reset style.** Append to `src/index.css` (under the repos tree block):

```css
.gh-pill-btn { appearance: none; -webkit-appearance: none; border: 0; cursor: pointer; font: inherit; }
.gh-pill-btn:hover { filter: brightness(1.15); }
```

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: errors ONLY about `ReposView` now requiring `onOpenPrs` at its call site in `GithubPanel` (fixed in Task 5). If other errors appear, fix them. To confirm this file itself is clean, it should not report errors inside `ReposView.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/github/ReposView.tsx src/index.css
git commit -m "feat(github): incremental repo paging + clickable PR-count badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — rebuild PrInboxView (sections, dropdown, collapsible, phased)

**Files:**
- Modify: `src/github/PrInboxView.tsx` (full rewrite)
- Modify: `src/index.css` (PR section styles)

**Interfaces:**
- Consumes: `invoke<MyPrs>("get_cached_github_my_prs")`, `invoke<MyPrs>("list_github_my_prs", { force })`, `invoke<PullRequest[]>("get_cached_github_team_prs")`, `invoke<PullRequest[]>("list_github_team_prs", { force })`, `invoke("open_path", { path })`; props `repoFilter: string | null`, `onRepoFilter: (r: string | null) => void`.
- Produces: `PrInboxView` with the new props.

- [ ] **Step 1: Replace the entire contents of `src/github/PrInboxView.tsx`** with:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PullRequest = {
  repo: string; number: number; title: string; url: string;
  author: string; authorAvatar: string | null; headRef: string;
  isDraft: boolean; state: string; reviewDecision: string | null;
  mergeable: string; ciStatus: string | null; updatedAt: string;
};
type MyPrs = { authored: PullRequest[]; recentlyClosed: PullRequest[] };

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
function ciClass(ci: string | null): string {
  if (ci === "SUCCESS") return "ci-pass";
  if (ci === "FAILURE" || ci === "ERROR") return "ci-fail";
  if (ci === "PENDING" || ci === "EXPECTED") return "ci-run";
  return "ci-none";
}
function needsAction(p: PullRequest): boolean {
  return p.reviewDecision === "CHANGES_REQUESTED" || p.ciStatus === "FAILURE" || p.ciStatus === "ERROR" || p.mergeable === "CONFLICTING";
}
function readyToMerge(p: PullRequest): boolean {
  return p.reviewDecision === "APPROVED" && p.mergeable === "MERGEABLE" && (p.ciStatus === "SUCCESS" || p.ciStatus === null) && !p.isDraft;
}
function initials(login: string): string {
  return login.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function Avatar({ pr }: { pr: PullRequest }) {
  const [failed, setFailed] = useState(false);
  if (pr.authorAvatar && !failed) {
    return <img className="gh-pr-avatar" src={pr.authorAvatar} alt={pr.author} onError={() => setFailed(true)} />;
  }
  return <span className="gh-pr-avatar gh-pr-avatar--fallback">{initials(pr.author)}</span>;
}

function PrRow({ pr }: { pr: PullRequest }) {
  const chips: { label: string; cls: string }[] = [];
  if (pr.state === "MERGED") chips.push({ label: "Merged", cls: "merged" });
  else if (pr.state === "CLOSED") chips.push({ label: "Closed", cls: "closed" });
  else {
    if (pr.mergeable === "CONFLICTING") chips.push({ label: "merge conflict", cls: "conflict" });
    if (pr.ciStatus === "FAILURE" || pr.ciStatus === "ERROR") chips.push({ label: "CI failed", cls: "conflict" });
    if (pr.reviewDecision === "CHANGES_REQUESTED") chips.push({ label: "changes requested", cls: "req" });
    if (pr.reviewDecision === "APPROVED") chips.push({ label: "approved", cls: "ok" });
    if (pr.isDraft) chips.push({ label: "draft", cls: "draft" });
  }
  return (
    <div className="gh-pr-row" onClick={() => invoke("open_path", { path: pr.url })} title={pr.title}>
      <div className="gh-pr-top">
        <span className={`gh-ci-dot ${ciClass(pr.ciStatus)}`} />
        <span className="gh-pr-num">#{pr.number}</span>
        <span className="gh-pr-title">{pr.title}</span>
      </div>
      <div className="gh-pr-bot">
        <span className="gh-pr-repo">{pr.repo}</span>
        {chips.map((c) => <span key={c.label} className={`gh-pr-chip ${c.cls}`}>{c.label}</span>)}
        <span className="gh-pr-spacer" />
        <Avatar pr={pr} />
        <span className="gh-pr-time">{relTime(pr.updatedAt)}</span>
      </div>
    </div>
  );
}

function Section({ title, count, children, defaultOpen = true, level = 0 }: {
  title: string; count: number; children: React.ReactNode; defaultOpen?: boolean; level?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`gh-pr-section level-${level}`}>
      <div className="gh-pr-section-h" onClick={() => setOpen((v) => !v)}>
        <span className="gh-caret">{open ? "▾" : "▸"}</span>
        <span className="gh-pr-section-title">{title}</span>
        <span className="gh-pr-count">{count}</span>
      </div>
      {open && <div className="gh-pr-section-body">{children}</div>}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v5h-5" />
    </svg>
  );
}

export function PrInboxView({ repoFilter, onRepoFilter }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
}) {
  const [mine, setMine] = useState<MyPrs | null>(null);
  const [team, setTeam] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback((force: boolean) => {
    setRefreshing(true);
    // My PRs first (fast), then Team PRs (the big one) — renders in two phases.
    const p1 = invoke<MyPrs>("list_github_my_prs", { force })
      .then((r) => { setMine(r); setLoading(false); })
      .catch((e) => setError(String(e)));
    const p2 = invoke<PullRequest[]>("list_github_team_prs", { force })
      .then((r) => setTeam(r))
      .catch((e) => setError(String(e)));
    Promise.allSettled([p1, p2]).finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      invoke<MyPrs>("get_cached_github_my_prs").then((c) => { if (alive && (c.authored.length || c.recentlyClosed.length)) { setMine(c); setLoading(false); } }),
      invoke<PullRequest[]>("get_cached_github_team_prs").then((c) => { if (alive && c.length) setTeam(c); }),
    ]).finally(() => { if (alive) load(false); });
    return () => { alive = false; };
  }, [load]);

  // Repos present across all fetched PRs, for the dropdown.
  const repoOptions = useMemo(() => {
    const set = new Set<string>();
    (mine?.authored ?? []).forEach((p) => set.add(p.repo));
    (mine?.recentlyClosed ?? []).forEach((p) => set.add(p.repo));
    (team ?? []).forEach((p) => set.add(p.repo));
    return [...set].sort();
  }, [mine, team]);

  const match = useCallback((p: PullRequest) => {
    const q = filter.trim().toLowerCase();
    return (!repoFilter || p.repo === repoFilter)
      && (!q || p.title.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q));
  }, [filter, repoFilter]);

  const groups = useMemo(() => {
    const authored = (mine?.authored ?? []).filter(match);
    const weekAgo = Date.now() - 7 * 86400_000;
    const done = (mine?.recentlyClosed ?? []).filter((p) => match(p) && new Date(p.updatedAt).getTime() >= weekAgo);
    const action = authored.filter(needsAction);
    const ready = authored.filter((p) => !needsAction(p) && readyToMerge(p));
    const waiting = authored.filter((p) => !needsAction(p) && !readyToMerge(p));
    const teamPrs = (team ?? []).filter(match);
    return { action, ready, waiting, done, teamPrs };
  }, [mine, team, match]);

  if (error && !mine && !team) {
    return (
      <div className="gh-empty">
        <p><b>Couldn't load pull requests</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={() => load(true)}>Retry</button>
      </div>
    );
  }
  if (!mine && !team && loading) return <div className="gh-empty">Loading pull requests…</div>;

  const myTotal = groups.action.length + groups.ready.length + groups.waiting.length + groups.done.length;

  return (
    <div className="gh-prs">
      <div className="gh-search">
        <input placeholder="Search PRs…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {refreshing && <span className="gh-dots" title="Updating…"><span /><span /><span /></span>}
        <button className="gh-icobtn" title="Refresh" onClick={() => load(true)}><RefreshIcon /></button>
      </div>
      <div className="gh-pr-repofilter">
        <select value={repoFilter ?? ""} onChange={(e) => onRepoFilter(e.target.value || null)}>
          <option value="">All repos</option>
          {repoOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="gh-pr-list">
        <Section title="My PRs" count={myTotal} level={0}>
          {groups.action.length > 0 && <Section title="Needs Action" count={groups.action.length} level={1}>{groups.action.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {groups.ready.length > 0 && <Section title="Ready to Merge" count={groups.ready.length} level={1}>{groups.ready.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {groups.waiting.length > 0 && <Section title="Waiting for Review/Checks" count={groups.waiting.length} level={1}>{groups.waiting.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {groups.done.length > 0 && <Section title="Done" count={groups.done.length} level={1} defaultOpen={false}>{groups.done.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {myTotal === 0 && <div className="gh-placeholder">Nothing here. 🎉</div>}
        </Section>
        <Section title="Team PRs" count={groups.teamPrs.length} level={0}>
          {groups.teamPrs.length > 0 ? groups.teamPrs.map((p) => <PrRow key={p.url} pr={p} />) : <div className="gh-placeholder">No review requests.</div>}
        </Section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append/adjust CSS in `src/index.css`.** The PR-row, CI-dot, chip, avatar styles from Plan 2 remain. Add the section + dropdown + new-chip styles:

```css
.gh-pr-repofilter { padding: 4px 10px 6px; }
.gh-pr-repofilter select { width: 100%; background: var(--gh-input-bg); color: var(--gh-fg); border: 1px solid var(--gh-border); border-radius: 6px; padding: 4px 6px; font-size: 12px; outline: 0; }
.gh-pr-section.level-0 { margin-top: 6px; }
.gh-pr-section.level-1 { margin-top: 2px; }
.gh-pr-section-h { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; user-select: none; }
.gh-pr-section.level-0 > .gh-pr-section-h { font-size: 12px; font-weight: 700; color: var(--gh-fg); text-transform: uppercase; letter-spacing: 0.03em; }
.gh-pr-section.level-1 > .gh-pr-section-h { font-size: 11px; font-weight: 600; color: var(--gh-muted); }
.gh-pr-section.level-1 > .gh-pr-section-body { padding-left: 8px; }
.gh-pr-count { margin-left: 4px; color: var(--gh-dim); font-weight: 500; font-size: 11px; }
.gh-pr-chip.merged { color: #a371f7; border-color: rgba(163,113,247,0.4); }
.gh-pr-chip.closed { color: var(--gh-faint); border-color: var(--gh-border); }
```

(If any old `.gh-pr-bucket*` rules are now unused, leave them — harmless — or remove them for tidiness.)

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: errors ONLY about `PrInboxView`'s call site in `GithubPanel` needing the new props (fixed in Task 5). `PrInboxView.tsx` itself should be clean.

- [ ] **Step 4: Commit**

```bash
git add src/github/PrInboxView.tsx src/index.css
git commit -m "feat(github): rebuild PR inbox — My/Team sections, subsections, repo filter, lifecycle badges

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — GithubPanel cross-tab wiring

**Files:**
- Modify: `src/github/GithubPanel.tsx`

**Interfaces:**
- Consumes: `ReposView` (now needs `onOpenPrs`), `PrInboxView` (now needs `repoFilter`/`onRepoFilter`).
- Produces: `repoFilter` state owned by `GithubPanel`.

- [ ] **Step 1: Add `repoFilter` state.** Near the other `useState` hooks in `GithubPanel`:

```tsx
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
```

- [ ] **Step 2: Pass `onOpenPrs` to ReposView.** In the `active === "repos"` render, add the prop:

```tsx
            onUpdate={onRepoUpdate}
            onOpenPrs={(repo) => { setRepoFilter(repo); onSubview("prs"); }}
          />
```

- [ ] **Step 3: Pass filter props to PrInboxView.** Replace the PRs mount with:

```tsx
        {active === "prs" && <PrInboxView repoFilter={repoFilter} onRepoFilter={setRepoFilter} />}
```

- [ ] **Step 4: Verify types + build**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: no errors.
Run: `npm run build 2>&1 | tail -2`
Expected: `✓ built`.

- [ ] **Step 5: Commit**

```bash
git add src/github/GithubPanel.tsx
git commit -m "feat(github): wire repo PR-badge → filtered PRs tab via repoFilter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end manual verification

**Files:** none.

- [ ] **Step 1:** `npm run tauri dev` → GitHub tab.
- [ ] **Step 2: Repos incremental.** First launch: repos fill in page-by-page (the 3-dot spinner shows while paging). Relaunch: instant from cache, then refreshes.
- [ ] **Step 3: PRs phased + sections.** PRs tab shows **My PRs** (Needs Action / Ready to Merge / Waiting / Done-collapsed) appearing before **Team PRs**. Force an authored PR with a conflict/failed-CI → lands in Needs Action; an approved+green one → Ready to Merge.
- [ ] **Step 4: Collapse.** Every section and subsection collapses/expands on click.
- [ ] **Step 5: Lifecycle badges.** A merged PR under Done shows a purple **Merged** chip; a closed one shows **Closed**.
- [ ] **Step 6: Cross-tab.** On Repos, click a repo's **PR-count badge** → switches to PRs tab with the repo dropdown auto-selected to that repo, showing only its PRs. Change the dropdown to "All repos" → all PRs return.
- [ ] **Step 7: Light theme.** Solarized Light → sections, dropdown, chips readable.

If a fix was needed, commit it with a `fix(github):` message + the trailer.

---

## Self-Review

**Spec coverage:**
- A. Incremental: Repos cursor paging (Tasks 1, 3); PRs phased My-then-Team (Tasks 2, 4). ✓
- B. Restructure: My PRs + subsections + Done, Team PRs, collapsible, lifecycle badges (Tasks 2, 4). ✓
- C. Cross-tab: clickable PR badge + repoFilter + dropdown auto-select (Tasks 3, 4, 5). ✓
- Out of scope (deploy, worktree, persisted collapse): not built. ✓

**Placeholder scan:** No TBDs; all code blocks complete; subsection rules spelled out in `needsAction`/`readyToMerge`. ✓

**Type consistency:** `ReposPage{repos,nextCursor}`, `MyPrs{authored,recentlyClosed}`, `PullRequest` fields match Rust↔TS. New props: `ReposView.onOpenPrs(repo)`, `PrInboxView.repoFilter`/`onRepoFilter` — all threaded in Task 5. Commands renamed consistently (`list_github_repos_page`, `set_cached_github_repos`, `list_github_my_prs`/`get_cached_github_my_prs`/`list_github_team_prs`/`get_cached_github_team_prs`) and registered in main.rs (Tasks 1–2). ✓
