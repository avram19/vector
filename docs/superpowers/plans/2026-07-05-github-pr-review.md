# In-App PR Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let PRs be reviewed fully in-app — view the remote diff, read/add inline comments (batched into a pending review), submit Approve/Request Changes/Comment, resolve threads, and merge — opened as a new tab (not a pane split), with an option to pop the review out into a minimal standalone window.

**Architecture:** A new backend module `github/pr_review.rs` fetches the diff (`gh api` diff media type) and review threads (`gh api graphql`), and exposes mutation commands (`gh api graphql` mutations + `gh pr merge`) through the existing `client::run_gh` choke point. On the frontend, a new `PrReviewLeaf` pane-tree kind (parallel to the existing `PreviewLeaf`) backs a dedicated tab; `PrReviewView` renders the diff (extending `DiffRenderer`'s parsing for remote-diff text) with inline gutter comment threads and a bottom review-action bar. A new Tauri command + `main.tsx` bootstrap branch support popping the same `PrReviewView` out into a standalone `WebviewWindow`.

**Tech Stack:** Rust (Tauri commands, `gh api graphql`/`gh pr merge` via `client::run_gh`), React/TypeScript (`App.tsx` pane model, `src/github/*.tsx`, `src/preview/DiffRenderer.tsx`, `src/main.tsx`).

## Global Constraints

- No test suite in this repo (per `CLAUDE.md`) — verification is `cargo check` / `npm run tauri dev` + manually exercising the flow against a real (ideally low-stakes) PR.
- `#[serde(rename_all = "camelCase")]` on all new Rust DTOs, matching every existing struct in `github/`.
- All `gh` calls go through `client::run_gh` (the existing single choke point) — no new `Command::new` call sites.
- Follow `docs/superpowers/specs/2026-07-05-github-pr-review-design.md` exactly; this plan implements it in full, including the tab-not-split-pane entry point and the standalone-window pop-out.
- Merge and review-submission are irreversible/externally-visible actions — every UI path to them must go through an explicit confirmation dialog (already designed in the spec); do not add a way to trigger them without one.

---

### Task 1: Backend — `pr_review.rs` fetch commands (diff + threads)

**Files:**
- Create: `src-tauri/src/github/pr_review.rs`
- Modify: `src-tauri/src/github/mod.rs` (add `pub mod pr_review;` + two command wrappers)
- Modify: `src-tauri/src/main.rs` (register the two new commands)

**Interfaces:**
- Produces: `pr_review::get_pr_diff(repo: &str, number: u64) -> Result<String, String>`, `pr_review::get_pr_review_threads(repo: &str, number: u64) -> Result<Vec<ReviewThread>, String>`, and the public structs `ReviewComment { id, author, author_avatar, body, created_at }` / `ReviewThread { id, path, line, is_resolved, comments }`. Tauri commands `get_pr_diff`, `get_pr_review_threads`. Task 4 (frontend `PrReviewView`) calls both.

- [ ] **Step 1: Create `pr_review.rs` with the diff fetch**

```rust
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
```

- [ ] **Step 2: Register the module and two Tauri commands in `mod.rs`**

In `src-tauri/src/github/mod.rs`, add to the top:

```rust
pub mod pr_review;
```

And add, alongside the other command wrappers (e.g. after `list_github_notifications`):

```rust
#[tauri::command]
pub async fn get_pr_diff(_state: State<'_, AppState>, repo: String, number: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::get_pr_diff(&repo, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_pr_review_threads(_state: State<'_, AppState>, repo: String, number: u64) -> Result<Vec<pr_review::ReviewThread>, String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::get_pr_review_threads(&repo, number))
        .await
        .map_err(|e| e.to_string())?
}
```

- [ ] **Step 3: Register both commands in `main.rs`'s `generate_handler!`**

In `src-tauri/src/main.rs`, add to the `tauri::generate_handler![...]` list (after `github::list_github_notifications,`):

```rust
            github::get_pr_diff,
            github::get_pr_review_threads,
```

- [ ] **Step 4: `cargo check`**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 5: Manually verify against a real PR**

Since there's no test suite, verify with a throwaway `gh` call from a terminal (outside the app) first, to confirm the exact CLI invocation works before trusting the Rust wrapper:

Run: `gh api repos/<owner>/<repo>/pulls/<number> -H "Accept: application/vnd.github.v3.diff" | head -20`
Expected: unified diff text (`diff --git a/... b/...` lines).

Run: `gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:5){nodes{id isResolved path line}}}}}' -f owner=<owner> -f name=<repo> -F number=<number>`
Expected: JSON with a `reviewThreads.nodes` array (empty array is fine if the PR has no review comments yet).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/github/pr_review.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): add PR diff + review thread fetch commands"
```

---

### Task 2: Backend — review mutations (comment, resolve, submit, merge)

**Files:**
- Modify: `src-tauri/src/github/pr_review.rs` (add mutation functions)
- Modify: `src-tauri/src/github/mod.rs` (add 5 command wrappers)
- Modify: `src-tauri/src/main.rs` (register 5 commands)

**Interfaces:**
- Consumes: `client::run_gh` (existing), `ReviewThread`/`ReviewComment` (Task 1).
- Produces: Tauri commands `start_or_get_pending_review`, `add_review_comment`, `resolve_review_thread`, `submit_pr_review`, `merge_pr`. Task 5 (`PrReviewView`'s action bar) calls all five.

- [ ] **Step 1: Add the mutation functions to `pr_review.rs`**

```rust
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
```

- [ ] **Step 2: Add 5 command wrappers to `mod.rs`**

```rust
#[tauri::command]
pub async fn start_or_get_pending_review(_state: State<'_, AppState>, repo: String, number: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::start_pending_review(&repo, number))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_review_comment(_state: State<'_, AppState>, review_id: String, path: String, line: u32, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::add_review_comment(&review_id, &path, line, &body))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_review_thread(_state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::resolve_review_thread(&thread_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn submit_pr_review(_state: State<'_, AppState>, review_id: String, event: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::submit_pr_review(&review_id, &event, &body))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn merge_pr(_state: State<'_, AppState>, repo: String, number: u64, method: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pr_review::merge_pr(&repo, number, &method))
        .await
        .map_err(|e| e.to_string())?
}
```

- [ ] **Step 3: Register all 5 in `main.rs`**

```rust
            github::start_or_get_pending_review,
            github::add_review_comment,
            github::resolve_review_thread,
            github::submit_pr_review,
            github::merge_pr,
```

- [ ] **Step 4: `cargo check`**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/github/pr_review.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): add PR review mutation commands (comment, resolve, submit, merge)"
```

---

### Task 3: Frontend — `PrReviewLeaf` pane kind + `openPrReviewTab`

**Files:**
- Modify: `src/App.tsx` (pane type union, tab-opening callback, tab-strip title rendering)

**Interfaces:**
- Consumes: `Tab`, `PaneNode`, `findLeaf`, existing pane-tree helpers (`src/App.tsx:107-270`).
- Produces: `PrReviewLeaf` type, `openPrReviewTab(repo: string, number: number): void` (exposed via a new prop threaded down to `Sidebar` → `GithubPanel` → `PrInboxView` in Task 5).

- [ ] **Step 1: Add the `PrReviewLeaf` type to the pane-leaf union**

In `src/App.tsx`, near `PreviewLeaf` (`src/App.tsx:128-139`):

```ts
type PrReviewLeaf = {
  kind: "prReview";
  id: string;
  repo: string;
  number: number;
};

type PaneLeaf = PtyLeaf | PreviewLeaf | PrReviewLeaf;

function isPrReviewLeaf(leaf: PaneLeaf): leaf is PrReviewLeaf {
  return leaf.kind === "prReview";
}
```

(Update the existing `isPtyLeaf`/`isPreviewLeaf` type guards' neighbors — no changes needed to their bodies, just noting `PaneLeaf` now has a third member.)

- [ ] **Step 2: Handle the new leaf kind in `migrateNodeDroppingPreviews`**

`PrReviewLeaf` should never be persisted (it's ephemeral, tied to a live PR review session) — treat it exactly like `PreviewLeaf` in the migration/restore path, so a saved-tabs restore never resurrects a half-finished review tab. In `src/App.tsx:331-357`, add a branch:

```ts
function migrateNodeDroppingPreviews(node: any): PaneNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.kind === "leaf") {
    return {
      kind: "pty",
      id: node.id,
      agentId: node.agentId,
      cwd: node.cwd,
      resumeId: node.resumeId,
      continueLatest: node.continueLatest,
      epoch: typeof node.epoch === "number" ? node.epoch : 0,
      profileOverride: node.profileOverride,
      userTitle: node.userTitle,
    } as PtyLeaf;
  }
  if (node.kind === "pty") return node as PtyLeaf;
  if (node.kind === "preview") return null;
  if (node.kind === "prReview") return null;
  if (node.kind === "split") {
    const a = migrateNodeDroppingPreviews(node.children?.[0]);
    const b = migrateNodeDroppingPreviews(node.children?.[1]);
    if (a && b) return { ...node, children: [a, b] } as PaneSplit;
    if (a) return a;
    if (b) return b;
    return null;
  }
  return null;
}
```

- [ ] **Step 3: Add `openPrReviewTab` alongside `openPreview`**

In `src/App.tsx`, near `openPreview` (`src/App.tsx:1029-1079`), add a new callback (a PR review tab is always a single, unsplit leaf — no pane-tree surgery needed, just a new `Tab` appended):

```tsx
const openPrReviewTab = useCallback((repo: string, number: number) => {
  setTabs((prev) => {
    const existingIdx = prev.findIndex((t) => {
      const leaf = t.root.kind !== "split" ? t.root : null;
      return leaf && isPrReviewLeaf(leaf) && leaf.repo === repo && leaf.number === number;
    });
    if (existingIdx !== -1) {
      setActiveId(prev[existingIdx].id);
      return prev;
    }
    const leaf: PrReviewLeaf = { kind: "prReview", id: crypto.randomUUID(), repo, number };
    const newTab: Tab = { id: crypto.randomUUID(), root: leaf, activePaneId: leaf.id };
    setActiveId(newTab.id);
    return [...prev, newTab];
  });
}, []);
```

- [ ] **Step 4: Give PR-review tabs a title and dot color in the tab strip**

In the tab-strip render (`src/App.tsx:1452-1464`), extend the title-derivation block to special-case a lone `PrReviewLeaf` root:

```tsx
{tabs.map((t, i) => {
  const activeLeaf = findLeaf(t.root, t.activePaneId);
  const activePtyLeaf = activeLeaf && isPtyLeaf(activeLeaf) ? activeLeaf : null;
  const prReviewLeaf = t.root.kind !== "split" && isPrReviewLeaf(t.root) ? t.root : null;
  const tabAgentId = activePtyLeaf?.agentId ?? "__shell__";
  const tabCwd = activeLeaf?.cwd ?? "";
  const agent = agents.find((a) => a.id === tabAgentId);
  const agentLabel = agent?.label ?? (tabAgentId === "__shell__" ? "shell" : tabAgentId);
  const rawTitle = paneTitles[t.activePaneId] || "";
  const stripped = rawTitle
    .replace(new RegExp(`^\\s*${agentLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[–—\\-:·|·]?\\s*`, "i"), "")
    .trim();
  const title = prReviewLeaf
    ? `#${prReviewLeaf.number} · ${prReviewLeaf.repo}`
    : (t.userTitle || activePtyLeaf?.userTitle || stripped || basename(tabCwd));
```

And in the dot-rendering spot right above `{isRenaming ? (` (`src/App.tsx:1493` today renders `<span className="agent-chip"><AgentIcon id={tabAgentId} size={14} /></span>` unconditionally) — swap to a conditional:

```tsx
{prReviewLeaf
  ? <span className="tab-dot tab-dot-pr" title="PR review" />
  : <span className="agent-chip"><AgentIcon id={tabAgentId} size={14} /></span>}
```

Add the CSS (same stylesheet located in Task 4 of the profile-scoping plan — grep `.agent-chip` to find it):

```css
.tab-dot-pr{width:7px;height:7px;border-radius:50%;background:#7aa7e0;flex:0 0 auto;margin-right:2px}
```

- [ ] **Step 5: Verify manually (without a real PR yet — just the plumbing)**

Since `openPrReviewTab` has no caller until Task 5, verify via the dev console: run `npm run tauri dev`, open the webview devtools, and call the debug hook pattern already used for `openPreview` (`src/App.tsx:1081-1087`) — add a matching temporary debug hook:

```tsx
useEffect(() => {
  if (!import.meta.env.DEV) return;
  (window as any).__openPrReviewTab = openPrReviewTab;
}, [openPrReviewTab]);
```

In the devtools console: `window.__openPrReviewTab("someorg/somerepo", 1)`.
Expected: a new tab appears titled `#1 · someorg/somerepo` with the blue dot, becomes active; calling it again with the same args focuses the existing tab instead of creating a second one.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/index.css
git commit -m "feat(github): add PrReviewLeaf pane kind and openPrReviewTab"
```

---

### Task 4: Frontend — `PrReviewView` component (diff, threads, review bar, merge dialog)

**Files:**
- Create: `src/github/PrReviewView.tsx`
- Modify: `src/preview/DiffRenderer.tsx` (extract the diff-line parser for reuse)
- Modify: `src/App.tsx` (render `PrReviewView` for a `PrReviewLeaf` in the pane-tree renderer)

**Interfaces:**
- Consumes: `parseDiff(text: string): DiffLine[]` (extracted from `DiffRenderer.tsx` in Step 1), Tauri commands from Tasks 1–2 (`get_pr_diff`, `get_pr_review_threads`, `start_or_get_pending_review`, `add_review_comment`, `resolve_review_thread`, `submit_pr_review`, `merge_pr`), `PrReviewLeaf` (Task 3).
- Produces: `PrReviewView({ repo, number }: { repo: string; number: number })` — a self-contained component, reused unchanged by the standalone-window shell in Task 6.

- [ ] **Step 1: Export `parseDiff` from `DiffRenderer.tsx` for reuse**

`parseDiff` (`src/preview/DiffRenderer.tsx:137-166`) already does exactly the parsing `PrReviewView` needs for remote diff text — just add `export`:

```ts
export function parseDiff(text: string): DiffLine[] {
```

And export the `DiffLine` type it returns (`src/preview/DiffRenderer.tsx:29-34`):

```ts
export type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string };
```

No other change to `DiffRenderer.tsx` — its own local-worktree-diff path (`worktree_diff` command) is untouched, per the spec's explicit "no changes to the existing worktree-diff path" requirement.

- [ ] **Step 2: `cargo`-equivalent frontend typecheck / smoke build**

Run: `npm run tauri dev` (fastest way to catch a TS error in this repo, since there's no standalone typecheck script — check `package.json` first in case one exists and prefer it)
Expected: no new errors; app still launches and existing diff previews (open a file's diff from the Worktrees tab) still render.

- [ ] **Step 3: Write `PrReviewView.tsx` — data loading**

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseDiff, DiffLine } from "../preview/DiffRenderer";

type ReviewComment = { id: string; author: string; authorAvatar: string | null; body: string; createdAt: string };
type ReviewThread = { id: string; path: string; line: number | null; isResolved: boolean; comments: ReviewComment[] };
type DraftComment = { path: string; line: number; body: string };

type FileDiff = { path: string; lines: DiffLine[] };

function splitIntoFiles(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const rawLine of raw.split("\n")) {
    if (rawLine.startsWith("diff --git")) {
      const m = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = { path: m ? m[2] : rawLine, lines: [] };
      files.push(current);
    }
    if (current) current.lines.push(...parseDiff(rawLine));
  }
  return files;
}

export function PrReviewView({ repo, number }: { repo: string; number: number }) {
  const [diffFiles, setDiffFiles] = useState<FileDiff[] | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftComment[]>([]);

  const load = useCallback(() => {
    setError(null);
    invoke<string>("get_pr_diff", { repo, number })
      .then((raw) => setDiffFiles(splitIntoFiles(raw)))
      .catch((e) => setError(String(e)));
    invoke<ReviewThread[]>("get_pr_review_threads", { repo, number })
      .then(setThreads)
      .catch((e) => setError(String(e)));
  }, [repo, number]);

  useEffect(() => { load(); }, [load]);

  const threadsByLine = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      if (t.line == null) continue;
      const key = `${t.path}:${t.line}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [threads]);
```

- [ ] **Step 4: Add draft-comment + review-submission + merge logic to `PrReviewView`**

Continue the same component body:

```tsx
  const ensureReviewId = useCallback(async (): Promise<string> => {
    if (reviewId) return reviewId;
    const id = await invoke<string>("start_or_get_pending_review", { repo, number });
    setReviewId(id);
    return id;
  }, [reviewId, repo, number]);

  const addDraft = (path: string, line: number) => {
    setDrafts((prev) => [...prev, { path, line, body: "" }]);
  };
  const updateDraft = (idx: number, body: string) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, body } : d)));
  };
  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const resolveThread = async (threadId: string) => {
    setResolvingIds((prev) => new Set(prev).add(threadId));
    try {
      await invoke("resolve_review_thread", { threadId });
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, isResolved: true } : t)));
    } catch (e) {
      setError(String(e));
    } finally {
      setResolvingIds((prev) => { const next = new Set(prev); next.delete(threadId); return next; });
    }
  };

  const [reviewDialog, setReviewDialog] = useState<{ event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitReview = async (summaryBody: string) => {
    if (!reviewDialog) return;
    setSubmitting(true);
    try {
      const id = await ensureReviewId();
      for (const d of drafts) {
        if (d.body.trim()) await invoke("add_review_comment", { reviewId: id, path: d.path, line: d.line, body: d.body });
      }
      await invoke("submit_pr_review", { reviewId: id, event: reviewDialog.event, body: summaryBody });
      setDrafts([]);
      setReviewDialog(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [merging, setMerging] = useState(false);
  const doMerge = async () => {
    setMerging(true);
    try {
      await invoke("merge_pr", { repo, number, method: mergeMethod });
      setMergeDialogOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };
```

- [ ] **Step 5: Add the render (header, diff body with gutter markers, review bar, dialogs)**

Continue the same component body, replacing the placeholder rest of the function:

```tsx
  if (error && !diffFiles) {
    return (
      <div className="prv-empty">
        <p><b>Couldn't load PR #{number}</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!diffFiles) return <div className="prv-empty">Loading PR #{number}…</div>;

  return (
    <div className="prv">
      <div className="prv-head">
        <div className="prv-h1">
          <span className="t">PR #{number}</span>
          <a className="ext-link" onClick={() => invoke("open_path", { path: `https://github.com/${repo}/pull/${number}` })}>↗ Open on GitHub</a>
        </div>
        {error && <div className="prv-error" onClick={() => setError(null)}>{error}</div>}
      </div>
      <div className="prv-body">
        {diffFiles.map((f) => (
          <div className="diff-file" key={f.path}>
            <div className="diff-fh">{f.path}</div>
            {f.lines.map((line, i) => {
              if (line.kind === "hunk" || line.kind === "meta") {
                return <div key={i} className={`diff-line diff-${line.kind}`}>{line.text}</div>;
              }
              const lineMatches = threadsByLine.get(`${f.path}:${i}`) ?? [];
              return (
                <div key={i} className="diff-line-wrap">
                  <div className={`diff-line diff-${line.kind}`} onClick={() => addDraft(f.path, i)}>
                    <span className="diff-gutter">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                    <span className="diff-content">{line.text}</span>
                    <span className="diff-addc" onClick={(e) => { e.stopPropagation(); addDraft(f.path, i); }}>+</span>
                  </div>
                  {lineMatches.map((t) => (
                    <div className={`thread${t.isResolved ? " resolved" : ""}`} key={t.id}>
                      <div className="thread-h">
                        <span>{t.comments.length} comment{t.comments.length === 1 ? "" : "s"}</span>
                        {!t.isResolved && (
                          <button className="rs" disabled={resolvingIds.has(t.id)} onClick={() => resolveThread(t.id)}>
                            {resolvingIds.has(t.id) ? "Resolving…" : "Resolve"}
                          </button>
                        )}
                        {t.isResolved && <span className="resolved-tag">✓ Resolved</span>}
                      </div>
                      {t.comments.map((c) => (
                        <div className="cmt" key={c.id}>
                          <div><b>{c.author}</b> <span className="when">{c.createdAt}</span><div className="body2">{c.body}</div></div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {drafts.map((d, di) => d.path === f.path && d.line === i ? (
                    <div className="draft-note" key={di}>
                      <textarea value={d.body} onChange={(e) => updateDraft(di, e.target.value)} placeholder="Pending comment…" />
                      <button onClick={() => removeDraft(di)}>Remove</button>
                    </div>
                  ) : null)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="prv-bar">
        <span className="cnt2">{drafts.length} pending comment{drafts.length === 1 ? "" : "s"}</span>
        <button className="btn-review" onClick={() => setReviewDialog({ event: "COMMENT" })}>Comment</button>
        <button className="btn-review request" onClick={() => setReviewDialog({ event: "REQUEST_CHANGES" })}>Request changes</button>
        <button className="btn-review approve" onClick={() => setReviewDialog({ event: "APPROVE" })}>Approve</button>
        <button className="btn-merge" onClick={() => setMergeDialogOpen(true)}>Merge…</button>
      </div>

      {reviewDialog && (
        <ReviewSummaryDialog
          kind={reviewDialog.event}
          submitting={submitting}
          onCancel={() => setReviewDialog(null)}
          onSubmit={submitReview}
        />
      )}
      {mergeDialogOpen && (
        <MergeDialog
          repo={repo}
          number={number}
          method={mergeMethod}
          onMethod={setMergeMethod}
          merging={merging}
          onCancel={() => setMergeDialogOpen(false)}
          onConfirm={doMerge}
        />
      )}
    </div>
  );
}

function ReviewSummaryDialog({ kind, submitting, onCancel, onSubmit }: {
  kind: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const titles: Record<string, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Comment" };
  return (
    <div className="prv-overlay">
      <div className="prv-dialog">
        <h3>Submit review — {titles[kind]}</h3>
        <textarea placeholder="Summary comment (optional)…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="prv-dialog-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" disabled={submitting} onClick={() => onSubmit(body)}>
            {submitting ? "Submitting…" : "Submit review"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MergeDialog({ repo, number, method, onMethod, merging, onCancel, onConfirm }: {
  repo: string;
  number: number;
  method: "merge" | "squash" | "rebase";
  onMethod: (m: "merge" | "squash" | "rebase") => void;
  merging: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const labels: Record<string, string> = { merge: "Merge commit", squash: "Squash & merge", rebase: "Rebase" };
  return (
    <div className="prv-overlay">
      <div className="prv-dialog">
        <h3>Merge pull request</h3>
        <div className="pr-ref">#{number} · {repo}</div>
        <div className="methodrow">
          {(["squash", "merge", "rebase"] as const).map((m) => (
            <div key={m} className={`method${method === m ? " sel" : ""}`} onClick={() => onMethod(m)}>{labels[m]}</div>
          ))}
        </div>
        <div className="prv-dialog-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-merge" disabled={merging} onClick={onConfirm}>
            {merging ? "Merging…" : `${labels[method]} #${number}`}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add the CSS classes used above**

Add to the same stylesheet located in earlier tasks (grep `.gh-subtabs` or `.diff-renderer` to confirm the file), reusing the mockup's class names/visual language from `docs/superpowers/specs/assets/2026-07-05-v037-mockups.html` (`.prv*`, `.diff-file`, `.diff-fh`, `.thread*`, `.cmt`, `.draft-note`, `.method*` — copy the rule bodies from that mockup file's `<style>` block, they were built against this exact class naming for this exact purpose).

- [ ] **Step 7: Render `PrReviewView` in the pane-tree leaf renderer**

The per-leaf render walk in `src/App.tsx` is an `if (leaf.kind === "preview") { return (...); }` block at `src/App.tsx:3354-3424`, falling through to a second `return (...)` for PTY leaves starting at `:3425`. Add a new `if` branch for `"prReview"` right after the `preview` block closes (i.e. immediately after line 3424's closing `}`, before line 3425's `return (`):

```tsx
        if (leaf.kind === "prReview") {
          return (
            <div
              key={leaf.id}
              className={`pane${isActive ? " pane-active" : ""}${single ? " pane-solo" : ""}`}
              style={{
                position: "absolute",
                left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`,
                borderRadius: `${tl} ${tr} ${br} ${bl}`,
                overflow: "hidden",
              }}
              onMouseDown={() => onFocusPane(leaf.id)}
            >
              <PrReviewView repo={leaf.repo} number={leaf.number} />
            </div>
          );
        }
```

This mirrors the `preview` branch's outer wrapper div (position/sizing/rounding are identical since a `PrReviewLeaf`'s tab always has exactly one leaf, so `single` is always `true` here) but skips `PreviewPaneTitleBar` and drag-and-drop handlers, since a PR review tab is never split and has its own in-component header instead.

Add the import at the top of `src/App.tsx`:

```tsx
import { PrReviewView } from "./github/PrReviewView";
```

- [ ] **Step 8: Verify manually against a real PR**

Run: `npm run tauri dev`
Steps: using the devtools debug hook from Task 3 Step 5 (`window.__openPrReviewTab("owner/repo", N)` for a real PR you can safely interact with), confirm: diff renders per-file with add/del coloring, clicking a line opens a draft comment box, existing threads render inline with Resolve working, submitting as "Comment" (safest, doesn't change review state) actually posts — verify on github.com that the comment appears — and the Merge dialog's method buttons switch the confirm button's label (don't necessarily complete a real merge unless you have a disposable test repo/PR for that step, per the spec's testing guidance).
Expected: full loop working end-to-end for at least the "Comment" review path; Approve/Request Changes exercised at your discretion given they have real effects on the PR.

- [ ] **Step 9: Commit**

```bash
git add src/github/PrReviewView.tsx src/preview/DiffRenderer.tsx src/App.tsx src/index.css
git commit -m "feat(github): add PrReviewView with inline comments and review actions"
```

---

### Task 5: Frontend — wire up the entry point (PR row click → new tab)

**Files:**
- Modify: `src/github/PrInboxView.tsx` (row click handler)
- Modify: `src/github/GithubPanel.tsx` (thread `onOpenPrReview` down)
- Modify: `src/sidebar/Sidebar.tsx` (thread `onOpenPrReview` down)
- Modify: `src/App.tsx` (pass `openPrReviewTab` into `<Sidebar>`)

**Interfaces:**
- Consumes: `openPrReviewTab` (Task 3).
- Produces: nothing further downstream in this plan (Task 6 adds the new-window path independently, off `PrReviewView`'s own header).

- [ ] **Step 1: Thread `onOpenPrReview` from `App.tsx` down to `Sidebar`**

In `src/App.tsx`, at the `<Sidebar>` call site (already modified once in the profile-scoping plan's Task 3 — add alongside those props):

```tsx
<Sidebar
  onOpenSettings={() => { setSettingsSection("appearance"); setSettingsOpen(true); }}
  projectRoot={activeLeaf?.cwd ?? null}
  scopedProfile={resolveProfileForCwd(claudeProfiles, activeLeaf?.cwd ?? "")}
  onOpenPrReview={openPrReviewTab}
  sessionId={
```

In `src/sidebar/Sidebar.tsx`, add the prop and forward it:

```tsx
export function Sidebar({
  onOpenSettings,
  projectRoot,
  scopedProfile,
  onOpenPrReview,
  sessionId,
  ...
}: {
  onOpenSettings?: () => void;
  projectRoot?: string | null;
  scopedProfile: ClaudeProfileDto | null;
  onOpenPrReview: (repo: string, number: number) => void;
  sessionId?: string | null;
  ...
}) {
```

And pass it into the `GithubPanel` render call:

```tsx
<GithubPanel
  ...
  scopedProfile={scopedProfile}
  onOpenPrReview={onOpenPrReview}
/>
```

- [ ] **Step 2: Accept and forward in `GithubPanel.tsx`**

```tsx
export function GithubPanel({
  ...
  scopedProfile,
  onOpenPrReview,
}: {
  ...
  scopedProfile: ClaudeProfileDto | null;
  onOpenPrReview: (repo: string, number: number) => void;
}) {
```

```tsx
{active === "prs" && (
  <PrInboxView
    repoFilter={repoFilter}
    onRepoFilter={setRepoFilter}
    login={auth.login ?? ""}
    onTrigger={(t) => setTriggerTarget(t)}
    notifications={notifications}
    scopeFilter={effectiveRepoFilter}
    onOpenPrReview={onOpenPrReview}
  />
)}
```

- [ ] **Step 3: Change the PR row click in `PrInboxView.tsx`**

In `src/github/PrInboxView.tsx`, add the prop:

```tsx
export function PrInboxView({ repoFilter, onRepoFilter, login, onTrigger, notifications, scopeFilter, onOpenPrReview }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
  login: string;
  onTrigger: (target: { repo: string; presetRef?: string }) => void;
  notifications: { repo: string; number: number; updatedAt: string }[];
  scopeFilter: Set<string> | null;
  onOpenPrReview: (repo: string, number: number) => void;
}) {
```

Thread it into `PrRow` and change its click handler (`src/github/PrInboxView.tsx:48-81`):

```tsx
function PrRow({ pr, onTrigger, unreadSet, onOpenPrReview }: {
  pr: PullRequest;
  onTrigger: (t: { repo: string; presetRef?: string }) => void;
  unreadSet: Set<string>;
  onOpenPrReview: (repo: string, number: number) => void;
}) {
  const unread = unreadSet.has(`${pr.repo}#${pr.number}`);
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
    <div className="gh-pr-row" onClick={() => onOpenPrReview(pr.repo, pr.number)} title={pr.title}>
      <div className="gh-pr-top">
        {unread && <span className="gh-pr-unread" title="Unread activity" />}
        <span className={`gh-ci-dot ${ciClass(pr.ciStatus)}`} />
        <span className="gh-pr-num">#{pr.number}</span>
        <span className="gh-pr-title">{pr.title}</span>
      </div>
      <div className="gh-pr-bot">
        <span className="gh-pr-repo">{pr.repo}</span>
        {chips.map((c) => <span key={c.label} className={`gh-pr-chip ${c.cls}`}>{c.label}</span>)}
        <span className="gh-pr-spacer" />
        {pr.state === "OPEN" && (
          <button className="gh-pr-deploy" title={`Run a workflow on ${pr.headRef}`}
            onClick={(e) => { e.stopPropagation(); onTrigger({ repo: pr.repo, presetRef: pr.headRef }); }}>Deploy</button>
        )}
        <button
          className="gh-pr-extlink"
          title="Open on GitHub"
          onClick={(e) => { e.stopPropagation(); invoke("open_path", { path: pr.url }); }}
        >↗</button>
        <Avatar pr={pr} />
        <span className="gh-pr-time">{relTime(pr.updatedAt)}</span>
      </div>
    </div>
  );
}
```

Then pass `onOpenPrReview` through every `<PrRow ...>` call site in this file (there are 6 — search `<PrRow key=`) by adding `onOpenPrReview={onOpenPrReview}` to each.

- [ ] **Step 4: Add the CSS for `.gh-pr-extlink`**

```css
.gh-pr-extlink{background:transparent;border:0;color:var(--faint,rgba(170,172,190,0.4));cursor:pointer;font-size:11px;padding:1px 3px}
.gh-pr-extlink:hover{color:var(--muted,rgba(170,172,190,0.62))}
```

- [ ] **Step 5: Verify manually**

Run: `npm run tauri dev`
Steps: open the PR inbox, click a PR row — confirm it opens `PrReviewView` in a new tab (not a split pane) instead of launching a browser; click the same PR row again from the inbox (or via the debug hook) while its tab is still open — confirm it focuses the existing tab rather than opening a duplicate; click the small "↗" button on a row — confirm that one still opens the browser.
Expected: row click and "↗" button are cleanly separated actions.

- [ ] **Step 6: Commit**

```bash
git add src/github/PrInboxView.tsx src/github/GithubPanel.tsx src/sidebar/Sidebar.tsx src/App.tsx src/index.css
git commit -m "feat(github): open PR review as a new tab from the PR inbox"
```

---

### Task 6: Frontend + Backend — "Open in new window" standalone pop-out

**Files:**
- Modify: `src-tauri/src/main.rs` (new `open_pr_review_window` command + registration)
- Modify: `src/main.tsx` (bootstrap branch)
- Modify: `src/github/PrReviewView.tsx` (add the "⧉ New window" header button, hidden when already standalone)

**Interfaces:**
- Consumes: `PrReviewView` (Task 4), Tauri `WebviewWindowBuilder`.
- Produces: nothing consumed further — this is the last task in the plan.

- [ ] **Step 1: Add the `open_pr_review_window` command**

In `src-tauri/src/main.rs`, add (near the other window/app-level commands — e.g. close to `open_path`):

```rust
#[tauri::command]
async fn open_pr_review_window(app: tauri::AppHandle, repo: String, number: u64) -> Result<(), String> {
    let sanitized_repo = repo.replace('/', "-");
    let label = format!("pr-review-{sanitized_repo}-{number}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let url = format!("index.html?prReview={}%2F{}", repo.replace('/', "%2F"), number);
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(format!("PR #{number} · {repo}"))
        .inner_size(900.0, 700.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

Register it in `generate_handler!`:

```rust
            open_pr_review_window,
```

- [ ] **Step 2: `cargo check`**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: succeeds. If `WebviewUrl`/`WebviewWindowBuilder` aren't already imported in `main.rs`, add `use tauri::{WebviewUrl, WebviewWindowBuilder};` (check the top of the file first — `tauri::` fully-qualified paths are used inline above so no import may be strictly required, but confirm against whatever import style the rest of `main.rs` already uses for `tauri::` items).

- [ ] **Step 3: Add the `main.tsx` bootstrap branch**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PrReviewView } from "./github/PrReviewView";
import "./index.css";

const prReviewParam = new URLSearchParams(location.search).get("prReview");

function PrReviewStandalone({ param }: { param: string }) {
  const [repo, numberStr] = param.split("/");
  return (
    <div className="prv-standalone">
      <PrReviewView repo={repo} number={Number(numberStr)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {prReviewParam ? <PrReviewStandalone param={prReviewParam} /> : <App />}
  </React.StrictMode>
);
```

- [ ] **Step 4: Add the "⧉ New window" header button to `PrReviewView`**

In `src/github/PrReviewView.tsx`'s header (added in Task 4 Step 5), add a prop to suppress the button when already standalone, and the button itself:

```tsx
export function PrReviewView({ repo, number, standalone }: { repo: string; number: number; standalone?: boolean }) {
```

```tsx
<div className="prv-h1">
  <span className="t">PR #{number}</span>
  {!standalone && (
    <a className="ext-link" onClick={() => invoke("open_pr_review_window", { repo, number })}>⧉ New window</a>
  )}
  <a className="ext-link" onClick={() => invoke("open_path", { path: `https://github.com/${repo}/pull/${number}` })}>↗ Open on GitHub</a>
</div>
```

Pass `standalone` from both call sites: in `src/main.tsx`'s `PrReviewStandalone`, `<PrReviewView repo={repo} number={Number(numberStr)} standalone />`; the in-tab render added in Task 4 Step 7 (`src/App.tsx`) stays as `<PrReviewView repo={leaf.repo} number={leaf.number} />` (defaults to `standalone` falsy).

- [ ] **Step 5: Add minimal window-chrome CSS for the standalone shell**

```css
.prv-standalone{height:100vh;display:flex;flex-direction:column;background:var(--bg,#0c0c12)}
```

- [ ] **Step 6: Verify manually**

Run: `npm run tauri dev`
Steps: open a PR review tab, click "⧉ New window" — confirm a second, smaller OS window opens showing only the PR review UI (no tab strip/sidebar), with its own "Open on GitHub" but no "New window" button (can't pop out a pop-out); interact with it (add a draft comment) — confirm it works independently of the in-tab version; close the popped-out window — confirm the original in-tab review is untouched; click "⧉ New window" again for the *same* PR — confirm it focuses the existing standalone window instead of opening a second one (per the `label`-based `get_webview_window` check in Step 1).
Expected: two independent clients of the same backend commands, no shared frontend state, no crash on either window closing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/main.rs src/main.tsx src/github/PrReviewView.tsx src/index.css
git commit -m "feat(github): add standalone pop-out window for PR review"
```
