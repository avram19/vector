# v0.3.8 — PR review UX improvements

Four minor UX improvements to the GitHub PR review surface (list + review tab/window).

## Context

- **PR list** — `src/github/PrInboxView.tsx`. Already has a manual refresh (`load(true)`)
  and SWR caching. `PrRow` renders `<Avatar>` with `pr.author` available. Only mounted
  while the GitHub sidebar's "PRs" sub-tab is active.
- **PR review** — `src/github/PrReviewView.tsx`. Rendered in two places:
  - an in-app tab (`src/App.tsx`, `PrReviewLeaf`), and
  - a standalone OS webview window (`src/main.tsx` → `open_pr_review_window` in
    `src-tauri/src/main.rs`).
  Has a `load()` that refetches details/diff/threads/comments, plus `standalone` and
  `onCloseTab` props. `doMerge` currently only closes the merge dialog.
- **Backend** — `get_pr_details` (`src-tauri/src/github/pr_review.rs`) returns
  `{title, body, reviewers}` only. No author / head branch / base branch.
- Background tabs stay **mounted** (`display:none`); `tabVisible={t.id===activeId}` is
  already threaded to the tab renderer, so polling can be gated on it.

## Requirements → design

### 1. Refresh button + 10s auto-refresh (review view)

- Add a refresh icon button to the `prv-head` header, calling the existing `load()`.
- Add a `setInterval(load, 10_000)` in `PrReviewView`, **paused when the view is not
  visible**:
  - standalone window → gate on `!document.hidden`.
  - in-app tab → thread `tabVisible` down to `PrReviewView` as an `active` prop so a
    background PR tab does not poll.
- `load()` updates state in place (no remount), so scroll position, open drafts, and
  reply text are preserved across a refresh.

### 2. Actions update the PR list immediately

The standalone review window is a separate webview from the main window that hosts the
list, so a direct callback won't reach it. Use Tauri's global event bus:

- Emit `"pr:mutated"` (via `@tauri-apps/api/event` `emit`) after every successful
  mutation in `PrReviewView`: review submit (comment / request-changes / approve),
  top-level comment post, and merge.
- `PrInboxView` adds a `listen("pr:mutated")` that calls `load(true)` and, when in
  repo-filter mode, re-fetches the repo's PRs.
- `emit` broadcasts to all windows, so this covers both the in-app tab and the
  standalone-window cases with one mechanism.

The list refresh is a full `load(true)` refetch (same as the manual refresh button),
not an optimistic local edit — simplest and always correct.

### 3. Merge closes the PR tab/window

In `doMerge`, on success:
1. emit `"pr:mutated"`,
2. if `standalone` → `getCurrentWindow().close()`, else `onCloseTab()`.

### 4. Author + branch names visible

- **List:** add `title={pr.author}` to `<Avatar>` (both the `<img>` and the fallback
  `<span>`) so the author shows on hover.
- **Review header:** extend backend `get_pr_details` and its GraphQL query to also
  return `author`, `headRef`, `baseRef`. Render in `prv-h1`:
  - `{title} #number` followed by `by {author}` (muted), and
  - a muted branch chip `{headRef} → {baseRef}`.
- Standalone window: update the OS window title once details load to include the
  author (`getCurrentWindow().setTitle(...)`).

## Files touched

- `src-tauri/src/github/pr_review.rs` — add `author` / `head_ref` / `base_ref` to
  `PrDetails` + `DETAILS_QUERY`.
- `src/github/PrReviewView.tsx` — refresh button, auto-refresh interval, `active` prop,
  `pr:mutated` emits, merge-closes-view, header author/branch rendering, OS-title update.
- `src/github/PrInboxView.tsx` — avatar `title`, `listen("pr:mutated")`.
- `src/App.tsx` — thread `tabVisible` into the `prReview` pane as `active`.
- `src/index.css` — styling for the header author/branch metadata.
- Version bump (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) at
  release time.

## Non-goals

- No change to the tab-strip label (`#number · repo`) — branch names are too long there.
- No optimistic list mutation; a full refetch is acceptable.
- No general multi-window event framework; `pr:mutated` is a single narrow event.
