# PR Inbox Revamp + Incremental Loading — Design Spec

**Status:** Approved design, pre-implementation
**Date:** 2026-06-27
**Target:** revision on top of Plans 1–2 (branch `feat/github-sidebar`, toward v0.3.5)
**Builds on:** Repos view (Plan 1) and PR inbox (Plan 2).

## Summary

Three coordinated changes to the GitHub panel: (A) incremental/progressive loading for Repos and PRs so the UI paints fast and fills in as data arrives; (B) a restructured PR inbox (My PRs with readiness subsections + Team PRs) with collapsible sections and lifecycle status badges; (C) cross-tab wiring so a repo's PR-count badge jumps to a filtered PR view.

## A. Incremental loading

**Repos — frontend-driven cursor pagination.**
- New backend command `list_github_repos_page(cursor: Option<String>) -> ReposPage { repos: Vec<Repo>, next_cursor: Option<String> }` (page size 50). The existing all-at-once `list_github_repos` is replaced by this paged form; `repos::list_repos` becomes `repos::list_repos_page(cursor)`.
- `ReposView` loops: render page 1, append each subsequent page as it resolves, stop when `next_cursor` is null. A small "loading more" indicator (the 3-dot animation) shows while paging.
- SWR preserved: `get_cached_github_repos` paints the disk cache instantly on launch; the page loop refreshes it and rewrites the disk cache after the final page.

**PRs — phased by section.**
- Split the single inbox fetch into two commands: `list_github_my_prs(force) -> MyPrs { authored, recently_closed }` and `list_github_team_prs(force) -> Vec<PullRequest>` (review-requested:@me, open). Each has its own 60s in-memory TTL + disk cache + `get_cached_*` companion.
- `PrInboxView` fetches My PRs first (renders the My PRs section immediately), then Team PRs (renders the Team PRs section). SWR paints both from disk cache first.

## B. PR inbox restructure

Replaces the old flat four-bucket layout. Two top-level sections, each collapsible; subsections collapsible too (collapse state is local component state, not persisted; "Done" starts collapsed, all else expanded):

- **My PRs** (authored):
  - **Needs Action** — `reviewDecision === CHANGES_REQUESTED` ∨ `ciStatus ∈ {FAILURE, ERROR}` ∨ `mergeable === CONFLICTING`. Takes precedence over the other open subsections.
  - **Ready to Merge** — `reviewDecision === APPROVED` ∧ `mergeable === MERGEABLE` ∧ `ciStatus ∈ {SUCCESS, null}` ∧ `!isDraft`.
  - **Waiting for Review/Checks** — remaining open authored PRs.
  - **Done** — authored PRs merged/closed in the last ~7 days; badged Merged/Closed.
- **Team PRs** — open PRs where I'm requested as reviewer (`review-requested:@me`). Flat, collapsible.

**Status badge per row (lifecycle-aware):**
- `state === MERGED` → "Merged" (purple chip); `state === CLOSED` → "Closed" (grey chip).
- Open PRs keep the existing chips (merge conflict / CI failed / changes requested / approved / draft) and CI dot.

The standalone "Recently merged/closed" section and the old `attention/review/authored/closed` flat buckets are removed.

## C. Cross-tab wiring

- `GithubPanel` owns a `repoFilter: string | null` state (the repo to filter the PR inbox by).
- **Repos view:** the per-repo PR-count badge becomes a button → sets `repoFilter = nameWithOwner` and switches the sub-tab to `prs` (via the existing `onSubview`).
- **PR inbox:** a repo `<select>` dropdown at the top — options are "All repos" plus every repo present in the currently-fetched PRs (union of My + Team), sorted. It filters all sections. When `repoFilter` is set (from a badge click), the dropdown is auto-selected to it; the user can change or clear it.

## Out of scope (deferred)

- **Deploy button per PR** → Plan 3 (needs the Actions tab + `workflow_dispatch`).
- **PR↔worktree linking** → Plan 2b.
- Persisting PR-section collapse state across restarts (local state for now).

## Data shapes (Rust ↔ TS, camelCase)

- `ReposPage { repos: Repo[]; nextCursor: string | null }`
- `MyPrs { authored: PullRequest[]; recentlyClosed: PullRequest[] }`
- `PullRequest` gains nothing new — `state` (`OPEN|MERGED|CLOSED`) already present drives the lifecycle badge.

## Module boundaries

- `repos.rs`: `list_repos_page(cursor)` (pure fetch of one page) + disk cache (unchanged).
- `prs.rs`: `list_my_prs()` + `list_team_prs()` (two pure fetches) + per-kind disk cache; the old `list_prs`/`PrInbox` are removed.
- `github/mod.rs`: paged repos command + two PR commands + their `get_cached_*`.
- `ReposView.tsx`: incremental page loop + clickable PR badge.
- `PrInboxView.tsx`: section/subsection model, repo dropdown, collapsible UI, phased fetch.
- `GithubPanel.tsx`: `repoFilter` state + threading.

## Verification (no test suite)

`cargo check` + `tsc`/`npm run build`, then in the running app: repos stream in page-by-page; PRs show My-then-Team; subsections categorize correctly (force a conflict / approval); collapse toggles work; clicking a repo's PR badge lands on the PRs tab filtered to that repo; the dropdown filters and auto-selects; merged/closed PRs show the right badge; light theme intact.
