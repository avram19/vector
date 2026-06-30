# GitHub Activity Notifications — Design Spec (Plan 4)

**Status:** Approved design, pre-implementation
**Date:** 2026-06-30
**Target:** branch `feat/github-sidebar`, toward v0.3.5
**Builds on:** Plans 0–3 (foundation, repos, PR inbox, Actions).

## Summary

Near-real-time, in-app activity notifications for the GitHub sidebar: a Rust background thread polls the user's GitHub notifications, filtered to PR threads where the user is the author or a requested reviewer, and emits them to the frontend. The GitHub rail icon shows a badge counting activity since the user last opened the panel; PR inbox rows show a dot when they have unread activity. No macOS banners (in-app only).

## Architecture

**Backend — `src-tauri/src/github/notifications.rs`:**
- `Notification { thread_id, repo, number, title, reason, updated_at }` (camelCase). `number` is parsed from `subject.url`'s trailing path segment; `repo` from the thread's `repository.full_name`.
- `list_notifications() -> Result<Vec<Notification>, String>` → `gh api notifications` (unread threads). Keep only `subject.type == "PullRequest"` AND `reason ∈ {"author", "review_requested"}`.
- A `list_github_notifications` Tauri command wraps it (for the frontend's initial state before the first poll tick).

**Backend — poller thread:**
- Spawned once in `main.rs` `setup()` with the `AppHandle`. Loop: if `gh` is authed, fetch + `app.emit("github-activity", &notifications)`; then sleep **45s when focused, 300s when unfocused**. On auth loss or fetch error, emit an empty list and keep looping. Single thread → no overlapping requests.
- Focus is tracked in Rust: a `WindowEvent::Focused(bool)` handler updates `GithubState.focused: AtomicBool` (initialized `true`). No frontend focus plumbing.
- `GithubState` gains `focused: AtomicBool`; its `Default` is implemented manually (`cache` empty, `focused = true`).

**Frontend:**
- `Sidebar` (always mounted) listens to the `github-activity` event and does one initial `list_github_notifications` fetch; holds the notification list in state.
- Rail GitHub icon badge = count of notifications with `updatedAt > seenAt`.
- Opening the GitHub panel (clicking its rail icon to activate it) sets `seenAt = now`, persisted via `update_sidebar_config` (`github_notifications_seen_at`).
- The notification list is threaded `Sidebar → GithubPanel → PrInboxView`; a PR row shows a dot when its `repo#number` is in the set (the current unread set, independent of `seenAt`).

## Badge vs dot (the two signals)

- **Rail badge** — "new since you last opened the panel": `notifications.filter(n => n.updatedAt > seenAt).length`. Clears when you open the GitHub panel (`seenAt = now`). Persists across restart.
- **PR row dot** — "this PR has unread activity": the PR appears in the current unread notification set (GitHub's own unread state). Persists until the thread is read on GitHub (the next poll drops it). Not affected by `seenAt`.

Both derive from the same `github-activity` payload.

## Persistence

`ui.toml` gains `github_notifications_seen_at: String` (ISO-8601, empty default = everything counts as new). Mirrored in `SidebarState`.

## Reality / constraints

- **No macOS banners** — in-app badge + dot only (explicit choice).
- We do **not** mutate GitHub read state (no marking notifications read). `seenAt` is a local, Vector-only marker.
- `gh api notifications` returns unread threads by default; rate is trivial (one call per poll, ~80/hr worst case focused, far under 5000/hr).
- No live push (GitHub has no public push channel) — this is polling, as designed.

## Data shapes (camelCase across Rust↔TS)

- `Notification { threadId: string, repo: string, number: number, title: string, reason: string, updatedAt: string }`
- Event `github-activity` payload: `Notification[]`.

## Module boundaries

- `notifications.rs`: the filtered fetch + the `Notification` type (one responsibility).
- The poller spawn + focus handler live in `main.rs` `setup()` (app lifecycle).
- `Sidebar` owns the event subscription, badge, and `seenAt`; `PrInboxView` consumes the unread set for row dots.

## Verification (no test suite)

`cargo check` + `tsc`/`npm run build`, then in the running app: with an unread review-request/author PR notification present, the GitHub rail icon shows a badge; opening the GitHub panel clears it (and stays cleared after restart until new activity); a PR in the inbox with unread activity shows a dot; reading it on github.com makes the dot disappear within a poll cycle; unfocusing the window slows the poll. Light theme intact.
