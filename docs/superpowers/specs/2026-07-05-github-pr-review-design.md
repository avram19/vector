# In-App PR Review — Design Spec (v0.3.7)

**Status:** Approved design, pre-implementation
**Date:** 2026-07-05
**Target release:** v0.3.7

---

## 1. Summary

The v0.3.5 GitHub sidebar design explicitly deferred "review a PR" functionality — clicking a PR row today opens `pr.url` externally via `open_path`. This spec adds a full in-app PR review flow: view the diff, read and add inline comments, resolve threads, and submit a review (Approve / Request Changes / Comment), plus merge the PR — all without leaving Vector.

This is independent of the profile-scoping work in `2026-07-05-github-profile-scoping-design.md`; it only touches the PR inbox's row-click destination and adds a new view, with no interaction with the repo-visibility filter beyond inheriting whatever the PR inbox already shows.

### In scope

1. Clicking a PR row in `PrInboxView` opens a new in-app `PrReviewView` (diff + comments + review actions) instead of opening externally. An explicit "Open on GitHub" affordance remains for jumping out.
2. Diff fetched directly from GitHub (not requiring a local worktree checkout) via `gh api .../pulls/{n}` with the diff media type.
3. Existing review threads (path, line, resolved state, comment bodies) fetched via GraphQL and rendered inline in the diff gutter.
4. Adding inline comments accumulates into a client-side pending review draft; nothing is sent to GitHub until the user submits.
5. Submitting a review: Approve, Request Changes, or Comment-only, each with an optional summary comment, bundling any pending inline comments (matches GitHub's native "start a review" → "submit review" model).
6. Resolving an existing thread (`resolveReviewThread` mutation).
7. Merge action: confirmation dialog with a merge-method selector (merge / squash / rebase, filtered to what the repo allows) before executing `gh pr merge`.

### Out of scope / deferred

- "Review this PR with Claude" (already deferred in the original v0.3.5 spec; unrelated to this).
- Persisting an in-progress pending review draft across app restarts — if the app closes mid-review, the unsent draft is lost (same as losing an unsaved GitHub review page on refresh).
- Diffing against a local worktree checkout — this flow is remote-diff-only; the existing `worktree_diff`/`DiffRenderer` local-file-compare path is untouched and unrelated.
- Issue comments / non-review PR conversation replies (this spec covers the *review* flow specifically: diff comments + approve/request-changes/comment + merge).

---

## 2. Backend — new `src-tauri/src/github/pr_review.rs`

Follows the existing module pattern (`repos.rs`, `prs.rs`, `actions.rs`): all calls go through `client::run_gh`, one file per PR-review concern.

### Fetching

| Command | Mechanism | Notes |
|---|---|---|
| `get_pr_diff(repo, number)` | `gh api repos/{repo}/pulls/{number}` with `Accept: application/vnd.github.v3.diff` | Raw unified diff text. Not available via GraphQL. |
| `get_pr_review_threads(repo, number)` | `gh api graphql` | `reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 50) { nodes { id author { login avatarUrl } body createdAt } } } }`. Paginate if `first: 100` is ever exceeded (deferred — no repo in practice has 100+ threads on one PR; add pagination if it becomes a real limit). |

### Mutations

| Command | Mechanism | Notes |
|---|---|---|
| `start_or_get_pending_review(repo, number)` | `gh api graphql` mutation `addPullRequestReview(input: { pullRequestId })` with no `event` | Creates (or the frontend already knows the id if one exists client-side this session) the draft review GitHub tracks server-side once the user adds their first inline comment. |
| `add_review_comment(review_id, path, line, body)` | `gh api graphql` mutation `addPullRequestReviewThread` scoped to `pullRequestReviewId: review_id` | Attaches a comment to the pending review at a specific diff line. |
| `resolve_review_thread(thread_id)` | `gh api graphql` mutation `resolveReviewThread(input: { threadId })` | |
| `submit_review(review_id, event, body)` | `gh api graphql` mutation `submitPullRequestReview(input: { pullRequestReviewId: review_id, event, body })` | `event` ∈ `APPROVE \| REQUEST_CHANGES \| COMMENT`. |
| `merge_pr(repo, number, method)` | `gh pr merge {number} --repo {repo} --{method}` | `method` ∈ `merge \| squash \| rebase`. `gh` itself validates against branch protection / allowed methods and returns a typed error on rejection — surfaced as-is in the confirmation dialog's error state. |

### Data shapes (new, `#[serde(rename_all = "camelCase")]` per existing convention)

```rust
pub struct ReviewComment { pub id: String, pub author: String, pub author_avatar: Option<String>, pub body: String, pub created_at: String }
pub struct ReviewThread { pub id: String, pub path: String, pub line: Option<u32>, pub is_resolved: bool, pub comments: Vec<ReviewComment> }
pub struct PrDetail { pub diff: String, pub threads: Vec<ReviewThread>, pub pending_review_id: Option<String> }
```

No new persistence — everything here is fetched fresh per view-open; no on-disk cache entry (diffs/threads change too fast during an active review to benefit from the existing TTL cache pattern used for repo/PR lists).

---

## 3. Frontend — new `src/github/PrReviewView.tsx`

### Entry point

`PrInboxView.tsx`'s row click (currently `invoke("open_path", { path: pr.url })`) changes to open `PrReviewView` for that `(repo, number)` in-app. A small icon/menu item on the row (or within `PrReviewView`'s header) keeps `open_path(pr.url)` available as an explicit "Open on GitHub" escape hatch.

### Layout

- **Header**: PR title, number, author, state/CI badges (reusing existing badge rendering from `PrInboxView`), "Open on GitHub" link.
- **Diff body**: extends `DiffRenderer` to accept a `source: "worktree" | "remote"` discriminant — when `"remote"`, it parses the fetched unified diff text directly (same `diff --git` parsing already present in `DiffRenderer.tsx:141`) instead of calling `worktree_diff`. No changes to the existing worktree-diff path.
- **Gutter markers**: each diff line checks `threads` for a match on `path` + `line`; matched lines show a marker that expands the thread(s) inline (comments, resolve button, reply box). Unmatched lines show a "+" on hover to start a new comment, which appends to the local pending-review draft state (not sent yet).
- **Review action bar**: fixed at the bottom — "Approve", "Request Changes", "Comment" buttons. Clicking any opens a small summary-comment textarea (optional body) with a final "Submit" that calls `submit_review` (creating the pending review first via `start_or_get_pending_review` if no draft exists yet, then flushing any locally-queued inline comments via `add_review_comment` before submitting).
- **Merge button**: separate from the review bar (merging isn't a review action). Opens a confirmation dialog: PR title, target branch, a method selector populated from what the repo allows (read via the existing `mergeable` field / a repo-settings check — if unavailable, default to offering `merge` only and let `gh`'s own error surface if squash/rebase isn't permitted), and a final confirm button that calls `merge_pr`.

### Local pending-review state

A single in-memory `PendingReviewDraft { threadDrafts: { path, line, body }[] }` inside `PrReviewView`, cleared on submit or on navigating away. No `ui.toml` persistence (per the "lost on restart" decision in scope).

---

## 4. Edge cases

- **PR already has CHANGES_REQUESTED / is already merged/closed**: the review action bar and merge button are still shown but `gh`'s own mutation errors (e.g., "can't review your own PR", "already merged") surface inline as a dismissible error banner rather than being pre-validated client-side — avoids duplicating GitHub's business rules.
- **Network/auth failure mid-review** (e.g., losing `gh` auth after opening the view): matches the existing GitHub-tab degraded-state pattern (retry affordance, non-blocking) — the pending local draft is preserved in memory so retrying "Submit" doesn't lose typed comments.
- **Merge method not permitted by repo settings**: `gh pr merge --{method}` returns a typed error; shown in the confirmation dialog rather than blocking the button pre-emptively (keeps the client from needing to fully replicate GitHub's branch-protection rules).

---

## 5. Testing

No test suite in this repo. Verification plan for implementation: run `npm run tauri dev`, open a real PR (ideally one in a low-stakes repo/branch) from the PR inbox, confirm the diff renders correctly, add an inline comment and confirm it stays local until submit, submit as "Comment" (safest state to test end-to-end without altering review status), confirm it posts and the thread reflects on github.com, then separately test resolve-thread on an existing thread, and finally test the merge confirmation dialog's method selector (without necessarily completing a real merge against a production repo — use a disposable test repo/PR for that final step).
