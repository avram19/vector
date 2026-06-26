# GitHub Sidebar — Plan 2: PR Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "PR inbox — coming in Plan 2" placeholder with a global, account-wide pull-request inbox: one batched `gh api graphql` search across all repos, sorted into four buckets, with CI/review/conflict/draft chips, All/Pinned + text filters, and click-to-open-on-GitHub.

**Architecture:** A new `github/prs.rs` runs a single GraphQL query with three `search` aliases (authored / review-requested / recently-closed), parses them into a `PrInbox`, and caches it (in-memory 60s + on-disk for instant startup, mirroring `repos.rs`). `list_github_prs` / `get_cached_github_prs` commands expose it. The frontend `PrInboxView` derives the four buckets, renders rows, and mounts into `GithubPanel`'s `prs` sub-body.

**Tech Stack:** Rust (`serde_json::Value`, `spawn_blocking`, `parking_lot::Mutex`), React 18 + TypeScript. Reuses the `open_path` command and the `--gh-*` CSS tokens. No new dependencies.

## Global Constraints

- **No test suite.** Test cycle: `cargo check --manifest-path src-tauri/Cargo.toml` (backend) and `npx tsc --noEmit` + `npm run build` (frontend), then manual verification in `npm run tauri dev`. Never claim a task passes without running these.
- **Builds on Plans 0–1 (merged into this branch).** Available: `github::client::run_gh(&[&str]) -> Result<String,String>`, `github::CachedResponse`, `github::GithubState { cache }`, `AppState.github`, the `repos.rs` disk-cache pattern (`read_disk_cache`/`write_disk_cache` writing to `dirs::cache_dir()/vector/`), `GithubPanel`'s `active === "prs"` slot, and `GithubRepoState` (carries `pinned: string[]`).
- **Data layer:** `gh api graphql` only, via `client::run_gh`. No reqwest, no token handling, no new cargo/npm deps.
- **Account-global:** the inbox uses GitHub `search` with `author:@me` / `review-requested:@me`, which span every repo the user can see — no per-repo iteration, no dependency on the Repos list.
- **Caps:** `first: 50` for authored + review searches, `first: 30` for closed (the account can have hundreds of review requests; the text/Pinned filters narrow them).
- **Persistence:** PR content is cached to the OS cache dir for SWR (deliberate, consistent with the repo-list cache from Plan 1's user-requested change). No credentials cached.
- **Visual source of truth:** `docs/superpowers/specs/assets/2026-06-24-github-sidebar-mockup.html` (PRs sub-tab): buckets ⚠ Needs attention / 👀 Needs my review / ✎ Authored / ✔ Recently merged (collapsed); rows show a CI dot, `#num`, title, repo, review/conflict/draft chips, author initials/avatar, relative time.
- **Bucket precedence (each PR appears once):** an authored PR that needs attention shows ONLY under Needs attention, not also under Authored.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feat/github-sidebar`.

---

### Task 1: Backend — fetch the PR inbox via GraphQL search

**Files:**
- Create: `src-tauri/src/github/prs.rs`

**Interfaces:**
- Produces:
  - `github::prs::PullRequest` — serializes camelCase: `repo, number, title, url, author, authorAvatar, headRef, isDraft, state, reviewDecision, mergeable, ciStatus, updatedAt`. Derives `Serialize, Deserialize, Clone`.
  - `github::prs::PrInbox { authored, review, recently_closed }` (camelCase: `authored`, `review`, `recentlyClosed`). Derives `Serialize, Deserialize, Clone, Default`.
  - `github::prs::list_prs() -> Result<PrInbox, String>` (blocking).
  - `github::prs::read_disk_cache() -> PrInbox`, `github::prs::write_disk_cache(&PrInbox)`.

- [ ] **Step 1: Create `src-tauri/src/github/prs.rs`**

```rust
use std::path::PathBuf;

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
pub struct PrInbox {
    pub authored: Vec<PullRequest>,
    pub review: Vec<PullRequest>,
    pub recently_closed: Vec<PullRequest>,
}

// One round-trip: three search aliases sharing a fragment. `author:@me` /
// `review-requested:@me` span every repo the viewer can see.
const QUERY: &str = r#"fragment prFields on PullRequest {
  number title url isDraft state headRefName reviewDecision mergeable updatedAt
  repository { nameWithOwner }
  author { login avatarUrl }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
query {
  authored: search(query: "is:pr is:open author:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
  review: search(query: "is:pr is:open review-requested:@me sort:updated-desc", type: ISSUE, first: 50) { nodes { ...prFields } }
  closed: search(query: "is:pr author:@me is:closed sort:updated-desc", type: ISSUE, first: 30) { nodes { ...prFields } }
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

/// Fetch the viewer's PR inbox (authored / review-requested / recently-closed)
/// in one GraphQL round-trip. Blocking.
pub fn list_prs() -> Result<PrInbox, String> {
    let q = format!("query={QUERY}");
    let raw = client::run_gh(&["api", "graphql", "-f", &q])?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;

    let collect = |alias: &str| -> Vec<PullRequest> {
        v["data"][alias]["nodes"]
            .as_array()
            .map(|nodes| nodes.iter().map(parse_pr).collect())
            .unwrap_or_default()
    };

    Ok(PrInbox {
        authored: collect("authored"),
        review: collect("review"),
        recently_closed: collect("closed"),
    })
}

// ── disk cache (stale-while-revalidate), mirroring repos.rs ──
fn cache_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("vector").join("prs.json"))
}

pub fn read_disk_cache() -> PrInbox {
    let Some(p) = cache_path() else { return PrInbox::default() };
    let Ok(text) = std::fs::read_to_string(&p) else { return PrInbox::default() };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn write_disk_cache(inbox: &PrInbox) {
    let Some(p) = cache_path() else { return };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(inbox) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}
```

- [ ] **Step 2: Verify it compiles (will warn about unused until Task 2 wires it)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: it will error that `prs` module is not declared (added in Task 2) — so this step's real check happens after Task 2. Do not commit yet.

- [ ] **Step 3: Smoke-test the query shape against real gh** (you are authed):

Run:
```
gh api graphql -f query='query{ authored: search(query:"is:pr is:open author:@me", type:ISSUE, first:1){ nodes{ ... on PullRequest { number repository{nameWithOwner} mergeable reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } }' --jq '.data.authored.nodes[0] | {repo:.repository.nameWithOwner, number, mergeable, reviewDecision, ci:.commits.nodes[0].commit.statusCheckRollup.state}'
```
Expected: a JSON object with `repo`, `number`, `mergeable`, `reviewDecision`, `ci` — confirming the fields resolve.

---

### Task 2: Backend — commands + registration

**Files:**
- Modify: `src-tauri/src/github/mod.rs` (`pub mod prs;`, two commands)
- Modify: `src-tauri/src/main.rs` (`generate_handler!`)

**Interfaces:**
- Consumes: `prs::PrInbox`, `prs::list_prs`, `prs::{read,write}_disk_cache`.
- Produces:
  - `github::list_github_prs(state, force) -> Result<prs::PrInbox, String>` — in-memory 60s TTL cache keyed `"prs"`, persists fresh results to disk.
  - `github::get_cached_github_prs(state) -> Result<prs::PrInbox, String>` — returns the disk cache instantly.

- [ ] **Step 1: Add the module + commands to `src-tauri/src/github/mod.rs`**

Add under `pub mod repos;`:

```rust
pub mod prs;
```

Then add after `get_cached_github_repos`:

```rust
#[tauri::command]
pub async fn list_github_prs(
    state: State<'_, AppState>,
    force: bool,
) -> Result<prs::PrInbox, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);

    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("prs").and_then(|c| {
                if c.fetched_at.elapsed() < TTL {
                    serde_json::from_str::<prs::PrInbox>(&c.body).ok()
                } else {
                    None
                }
            })
        };
        if let Some(hit) = cached {
            return Ok(hit);
        }
    }

    let fresh = tauri::async_runtime::spawn_blocking(prs::list_prs)
        .await
        .map_err(|e| e.to_string())??;

    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert(
            "prs".to_string(),
            CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() },
        );
    }

    let to_disk = fresh.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || prs::write_disk_cache(&to_disk)).await;

    Ok(fresh)
}

#[tauri::command]
pub async fn get_cached_github_prs(
    _state: State<'_, AppState>,
) -> Result<prs::PrInbox, String> {
    tauri::async_runtime::spawn_blocking(prs::read_disk_cache)
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register in `src-tauri/src/main.rs`**

After `github::get_cached_github_repos,`:

```rust
            github::get_cached_github_repos,
            github::list_github_prs,
            github::get_cached_github_prs,
```

- [ ] **Step 3: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors (pre-existing warnings OK).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/github/prs.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): fetch PR inbox via gh GraphQL search (cached + SWR)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — PrInboxView (buckets, rows, filters)

**Files:**
- Create: `src/github/PrInboxView.tsx`
- Modify: `src/index.css` (append PR-inbox styles)

**Interfaces:**
- Consumes: `invoke<PrInbox>("get_cached_github_prs")`, `invoke<PrInbox>("list_github_prs", { force })`, `invoke("open_path", { path })`; prop `pinned: string[]`.
- Produces: `PrInboxView` component; types `PullRequest`, `PrInbox`.

- [ ] **Step 1: Create `src/github/PrInboxView.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatar: string | null;
  headRef: string;
  isDraft: boolean;
  state: string;
  reviewDecision: string | null;
  mergeable: string;
  ciStatus: string | null;
  updatedAt: string;
};

export type PrInbox = { authored: PullRequest[]; review: PullRequest[]; recentlyClosed: PullRequest[] };

const EMPTY: PrInbox = { authored: [], review: [], recentlyClosed: [] };

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

function needsAttention(p: PullRequest): boolean {
  return p.reviewDecision === "CHANGES_REQUESTED"
    || p.ciStatus === "FAILURE" || p.ciStatus === "ERROR"
    || p.mergeable === "CONFLICTING";
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
  if (pr.mergeable === "CONFLICTING") chips.push({ label: "merge conflict", cls: "conflict" });
  if (pr.ciStatus === "FAILURE" || pr.ciStatus === "ERROR") chips.push({ label: "CI failed", cls: "conflict" });
  if (pr.reviewDecision === "CHANGES_REQUESTED") chips.push({ label: "changes requested", cls: "req" });
  if (pr.reviewDecision === "APPROVED") chips.push({ label: "approved", cls: "ok" });
  if (pr.isDraft) chips.push({ label: "draft", cls: "draft" });

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

export function PrInboxView({ pinned }: { pinned: string[] }) {
  const [inbox, setInbox] = useState<PrInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback((force: boolean) => {
    setRefreshing(true);
    invoke<PrInbox>("list_github_prs", { force })
      .then((r) => { setInbox(r); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<PrInbox>("get_cached_github_prs")
      .then((cached) => {
        const any = cached.authored.length || cached.review.length || cached.recentlyClosed.length;
        if (alive && any) { setInbox(cached); setLoading(false); }
      })
      .catch(() => {})
      .finally(() => { if (alive) load(false); });
    return () => { alive = false; };
  }, [load]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const buckets = useMemo(() => {
    const data = inbox ?? EMPTY;
    const q = filter.trim().toLowerCase();
    const visible = (p: PullRequest) =>
      (!pinnedOnly || pinnedSet.has(p.repo)) &&
      (!q || p.title.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q));

    const attention = data.authored.filter((p) => needsAttention(p) && visible(p));
    const authored = data.authored.filter((p) => !needsAttention(p) && visible(p));
    const review = data.review.filter(visible);
    const weekAgo = Date.now() - 7 * 86400_000;
    const closed = data.recentlyClosed.filter((p) => visible(p) && new Date(p.updatedAt).getTime() >= weekAgo);
    return { attention, review, authored, closed };
  }, [inbox, filter, pinnedOnly, pinnedSet]);

  if (error && !inbox) {
    return (
      <div className="gh-empty">
        <p><b>Couldn't load pull requests</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={() => load(true)}>Retry</button>
      </div>
    );
  }
  if (!inbox && loading) return <div className="gh-empty">Loading pull requests…</div>;

  const total = buckets.attention.length + buckets.review.length + buckets.authored.length;

  return (
    <div className="gh-prs">
      <div className="gh-search">
        <input placeholder="Search PRs…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {refreshing && <span className="gh-dots" title="Updating…"><span /><span /><span /></span>}
        <button className={`gh-chip-btn${pinnedOnly ? " on" : ""}`} onClick={() => setPinnedOnly((v) => !v)} title="Only pinned repos">Pinned</button>
        <button className="gh-icobtn" title="Refresh" onClick={() => load(true)}><RefreshIcon /></button>
      </div>
      <div className="gh-pr-list">
        <Bucket label="⚠ Needs attention" tone="warn" prs={buckets.attention} />
        <Bucket label="👀 Needs my review" prs={buckets.review} />
        <Bucket label="✎ Authored" prs={buckets.authored} />
        <div className="gh-pr-bucket">
          <div className="gh-pr-bucket-h" onClick={() => setShowClosed((v) => !v)}>
            <span className="gh-caret">{showClosed ? "▾" : "▸"}</span>
            ✔ Recently merged/closed <span className="gh-pr-count">{buckets.closed.length}</span>
          </div>
          {showClosed && buckets.closed.map((p) => <PrRow key={p.url} pr={p} />)}
        </div>
        {total === 0 && <div className="gh-placeholder">No open pull requests. 🎉</div>}
      </div>
    </div>
  );
}

function Bucket({ label, prs, tone }: { label: string; prs: PullRequest[]; tone?: "warn" }) {
  if (prs.length === 0) return null;
  return (
    <div className="gh-pr-bucket">
      <div className={`gh-pr-bucket-h${tone === "warn" ? " warn" : ""}`}>
        {label} <span className="gh-pr-count">{prs.length}</span>
      </div>
      {prs.map((p) => <PrRow key={p.url} pr={p} />)}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
```

- [ ] **Step 2: Append styles to `src/index.css`** (after the repos-tree block)

```css
/* ── GitHub PR inbox ──────────────────────────────────────── */
.gh-prs { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.gh-pr-list { flex: 1; overflow: auto; min-height: 0; padding: 4px 6px 12px; }
.gh-chip-btn { appearance: none; -webkit-appearance: none; font-size: 11px; color: var(--gh-muted); background: transparent; border: 1px solid var(--gh-border); border-radius: 20px; padding: 2px 9px; cursor: pointer; flex: 0 0 auto; }
.gh-chip-btn.on { color: #fff; background: #3a5f8a; border-color: #3a5f8a; }
.gh-pr-bucket { margin-top: 8px; }
.gh-pr-bucket-h { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 12px; font-weight: 600; color: var(--gh-fg); cursor: default; }
.gh-pr-bucket-h.warn { color: #e0913f; }
.gh-pr-count { margin-left: 4px; color: var(--gh-dim); font-weight: 500; font-size: 11px; }
.gh-pr-row { display: flex; flex-direction: column; gap: 3px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
.gh-pr-row:hover { background: var(--gh-row-hover); }
.gh-pr-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.gh-ci-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
.gh-ci-dot.ci-pass { background: #2ea043; }
.gh-ci-dot.ci-fail { background: #f85149; }
.gh-ci-dot.ci-run { background: #d9a23a; }
.gh-ci-dot.ci-none { background: #888; }
.gh-pr-num { color: var(--gh-faint); font-variant-numeric: tabular-nums; flex: 0 0 auto; font-size: 12px; }
.gh-pr-title { color: var(--gh-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 12.5px; }
.gh-pr-bot { display: flex; align-items: center; gap: 7px; padding-left: 16px; flex-wrap: wrap; }
.gh-pr-repo { color: var(--gh-muted); font-size: 11px; }
.gh-pr-spacer { flex: 1 1 auto; }
.gh-pr-chip { font-size: 10px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--gh-border); color: var(--gh-muted); }
.gh-pr-chip.conflict { color: #f85149; border-color: rgba(248,81,73,0.4); }
.gh-pr-chip.req { color: #e0913f; border-color: rgba(224,145,63,0.4); }
.gh-pr-chip.ok { color: #2ea043; border-color: rgba(46,160,67,0.4); }
.gh-pr-chip.draft { color: var(--gh-faint); }
.gh-pr-avatar { width: 16px; height: 16px; border-radius: 50%; flex: 0 0 auto; }
.gh-pr-avatar--fallback { display: inline-grid; place-items: center; font-size: 8px; font-weight: 700; color: var(--gh-fg); background: var(--gh-hover); }
.gh-pr-time { color: var(--gh-dim); font-size: 10px; flex: 0 0 auto; }
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: no errors. (`PrInboxView` is unused until Task 4 — fine.)

- [ ] **Step 4: Commit**

```bash
git add src/github/PrInboxView.tsx src/index.css
git commit -m "feat(github): PrInboxView — 4 buckets, chips, filters, SWR

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mount PrInboxView in GithubPanel

**Files:**
- Modify: `src/github/GithubPanel.tsx`

**Interfaces:**
- Consumes: `PrInboxView` (Task 3); `repoState.pinned` (already on `GithubPanel`).

- [ ] **Step 1: Import + mount.** Add the import after the `ReposView` import:

```tsx
import { ReposView, RepoUpdate } from "./ReposView";
import { PrInboxView } from "./PrInboxView";
```

Replace the PRs placeholder line:

```tsx
        {active === "prs" && <PrInboxView pinned={repoState.pinned} />}
```

- [ ] **Step 2: Verify types + build**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: no errors.
Run: `npm run build 2>&1 | tail -2`
Expected: `✓ built`.

- [ ] **Step 3: Commit**

```bash
git add src/github/GithubPanel.tsx
git commit -m "feat(github): mount PrInboxView in the PRs sub-tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end manual verification

**Files:** none.

- [ ] **Step 1:** `npm run tauri dev` → GitHub tab → **PRs**.
- [ ] **Step 2: Buckets.** PRs load grouped into ⚠ Needs attention / 👀 Needs my review / ✎ Authored / ✔ Recently merged (collapsed). An authored PR with a merge conflict or failing CI or changes-requested appears under **Needs attention** and NOT under Authored.
- [ ] **Step 3: Rows.** Each row shows a CI dot (green/red/yellow/gray), `#num`, title, repo, the right chips (merge conflict / CI failed / changes requested / approved / draft), an author avatar (or initials fallback), and a relative time. Clicking a row opens the PR on GitHub.
- [ ] **Step 4: Filters.** Toggle **Pinned** → only PRs from pinned repos show. Type in **Search PRs…** → buckets filter by title/repo. Expand **Recently merged/closed** → shows PRs closed in the last 7 days.
- [ ] **Step 5: SWR.** Quit + relaunch → PRs appear instantly from cache with the 3-dot spinner while revalidating. `ls ~/Library/Caches/vector/prs.json` exists.
- [ ] **Step 6: Light theme.** Switch to Solarized Light (⌘,) → the inbox (chips, dots, text) is readable.

If a fix was needed, commit it with a `fix(github):` message + the trailer.

---

## Self-Review

**Spec coverage (spec §5 PR inbox):**
- Single batched GraphQL search across all repos → Task 1 (3 aliases, one round-trip). ✓
- Four buckets, top-down precedence (attention excludes from authored) → Task 3 `buckets` memo. ✓
- Needs-attention rule = CHANGES_REQUESTED ∨ CI failure ∨ CONFLICTING → `needsAttention`. ✓
- Row: CI dot, #num, title, repo, chips, author, updated time → `PrRow`. ✓
- All/Pinned + text filter, sort by updated (search `sort:updated-desc`) → Task 3. ✓
- Click → open on GitHub → `open_path`. ✓
- Recently-merged collapsible, low priority, ~7-day window → Task 3. ✓
- Worktree linking + open-diff-in-preview → DEFERRED to Plan 2b (per scoping decision). ✓ (out of scope)

**Placeholder scan:** Concrete loading/error/empty states; no TBDs. Actions sub-body remains a Plan 3 stub by design. ✓

**Type consistency:** `PullRequest`/`PrInbox` camelCase fields identical Rust↔TS (`authorAvatar`, `headRef`, `ciStatus`, `reviewDecision`, `recentlyClosed`). `list_github_prs` takes `{ force: boolean }`; `get_cached_github_prs` no args. `PrInboxView` prop `pinned: string[]` threaded from `repoState.pinned`. ✓
