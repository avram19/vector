# GitHub Sidebar — Design Spec (v0.3.5)

**Status:** Approved design, pre-implementation
**Date:** 2026-06-24
**Target release:** v0.3.5
**Visual source of truth:** [`assets/2026-06-24-github-sidebar-mockup.html`](./assets/2026-06-24-github-sidebar-mockup.html) — the implemented UI must match this mockup exactly (layout, density, color, iconography).

---

## 1. Summary

Add a third sidebar tab to Vector — **GitHub** — that turns Vector from an agent terminal into an agent terminal + GitHub cockpit. It surfaces the user's repos, a global PR inbox, near-real-time activity badges, and a full Actions control center, all authenticated through the user's existing `gh` CLI login (inheriting their exact scopes and org SSO). Its differentiating value over github.com is tight integration with what Vector already knows: worktrees and diff preview.

Unlike Files and Worktrees (scoped to the focused tab's project), the **GitHub tab is account-global** — it reflects the user across all of GitHub, independent of the active project tab.

### In scope (v0.3.5)

1. **Repos view** — repos the user is part of, with pin-to-favorites, auto org/owner grouping, and user-defined custom groups (flat).
2. **Global PR inbox** — one batched query across all repos, categorized into four buckets.
3. **Activity polling + in-app badges** — near-real-time, no macOS banners.
4. **Actions center** — per-repo + a cross-repo favorited-workflows dashboard; view workflows/runs/jobs/steps, stream status, fetch logs, and trigger / re-run / cancel.
5. **PR ↔ worktree linking** — PR rows show when a branch is checked out locally and open the diff in the existing preview pane.

### Deferred (0.3.6+)

- "Review this PR with Claude" (launch an agent pane scoped to a PR).
- Nested custom group hierarchy (v1 custom groups are flat).
- macOS banner notifications (explicit choice: in-app badges only for v0.3.5).
- Issues (PRs only for v0.3.5).

### Non-negotiable reality checks baked into the design

- **No push channel.** A desktop app cannot receive GitHub webhooks without a public server. "Real-time" = polling the GitHub **notifications API** with `If-None-Match` conditional requests.
- **No live log tail for in-progress runs.** `gh run view --log` returns logs only after a job completes. While running, we show live **status / step progress**; on completion we fetch full logs (`--log-failed` to jump to failures). No fake live-tail.

---

## 2. Architecture

All three views authenticate via `gh`; data is fetched by shelling out to `gh api` (REST) and `gh api graphql` (batched reads), resolved through `config::which_path("gh")` — the same `Command::new` pattern `git.rs` uses for `git`. `gh` is added to the binaries `augmented_path()` makes discoverable.

### Backend — new `src-tauri/src/github/` module

| File | Responsibility |
|---|---|
| `mod.rs` | Tauri command handlers; defines `GithubState` (response cache + poller handle), wired into `AppState`. |
| `client.rs` | Single choke point for all `gh` invocations: `gh api`, `gh api graphql`, `gh run …`. JSON parse, typed error mapping, in-memory response cache (`endpoint → { etag, body, fetched_at }`). |
| `repos.rs` | List viewer repos (owner/collaborator/org-member affiliations), org grouping source data. |
| `prs.rs` | Single GraphQL `search` query for the PR inbox + bucket categorization. |
| `actions.rs` | Workflows, runs, jobs, steps, logs; dispatch / re-run / cancel. |
| `notifications.rs` | Background poller thread; emits a Tauri `github-activity` event (same pattern as `pty-data-{id}`). |

### Frontend — new `src/github/` dir (mirrors `src/sidebar/`)

| File | Responsibility |
|---|---|
| `GithubPanel.tsx` | Root; header (`@user · gh authed`, refresh), three sub-tabs, owns sub-view routing. |
| `ReposView.tsx` | Grouped repo tree; pin, drag-to-group, context menu. |
| `PrInboxView.tsx` | Four buckets, filters, worktree-link indicators. |
| `ActionsView.tsx` | Favorited dashboard, per-repo drill-down, run expansion, dispatch form. |
| `githubState.ts` | Local persisted state (groups, pins, favorited workflows, seen markers) via `ui.toml`. |

### Sidebar rail

`SidebarTab` becomes `"files" | "worktrees" | "github"`. The rail gains a GitHub icon (with an unread-activity badge). Selecting it opens the GitHub panel, whose internal sub-nav switches Repos / PRs / Actions.

### Degraded / auth states

On panel open, check `gh auth status`:
- **gh not installed** → empty state with an install hint.
- **installed but unauthed** → CTA to run `gh auth login` (offer to open a pre-typed shell tab).
- **authed** → render normally.

Every `gh` call maps to a typed result. The panel renders inline, non-blocking states — not-installed / not-authed / offline / rate-limited (with reset time) / empty — plus a manual refresh everywhere. A failure never crashes a pane; it shows a retry affordance.

---

## 3. Data model & persistence

### Persisted locally — `~/.config/vector/ui.toml`, `[github]` table

Only the user's *organizational layer* is persisted. **No GitHub content is cached on disk; no secrets at rest.**

```toml
[github]
custom_groups = ["Work", "Side"]                                  # ordered, flat
repo_group = { "acme/api" = "Work", "acme/web" = "Work" }         # repo → custom group; absent ⇒ auto org group
pinned_repos = ["acme/api", "me/dotfiles"]
favorited_workflows = ["acme/api:ci.yml", "me/vector:release.yml"]
github_subview = "prs"                                             # last-open sub-tab
seen_activity = { "<thread-id>" = "<iso-ts>" }                    # unread/badge diffing, survives restart
```

### In-memory only — Rust `GithubState` (never serialized)

- `repo_cache`, `pr_cache`, `actions_cache`: `{ etag, json, fetched_at }` per endpoint; TTL-gated; conditional re-fetch via `If-None-Match` (304 ⇒ reuse cached body).
- `poller`: thread join handle + stop flag.

Restart ⇒ clean refetch, no stale-on-disk problems.

### Core TS shapes (minimal fields, derived from `gh` JSON)

```ts
type Repo = { nameWithOwner; owner; isPrivate; pushedAt; defaultBranch; openPrCount };
type PullRequest = {
  repo; number; title; author; state; reviewDecision; isDraft;
  mergeable; ciStatus; updatedAt;
  category: "attention" | "review" | "authored" | "merged";  // computed
  worktreePath?: string;                                      // cross-referenced from worktree index
};
type WorkflowRun = { repo; workflowName; runNumber; status; conclusion; branch; event; createdAt; headSha };
type Activity = { threadId; repo; prNumber; kind; unread; updatedAt };
```

---

## 4. Repos view

- **Source:** `gh api graphql` — `viewer.repositories` + `viewer.organizations.repositories` (affiliations: owner, collaborator, org-member). Paginated, cached.
- **Render order:** ★ Favorites → custom groups (user order) → auto org groups (collapsible). A repo present in `repo_group` renders under its custom group; otherwise under its org.
- **Repo row:** name (`owner/` muted), private/public glyph, open-PR count pill, last-push relative time, pin star on favorites.
- **Interactions:** drag a repo into a custom group; "+ New group"; right-click → Pin/Unpin, Move to group, Open on GitHub, Reveal worktree (if checked out). Collapse state + scroll position persist.

---

## 5. PR inbox

One `gh api graphql` batched `search` query keeps the inbox to a single round-trip across all repos. `mergeable` + `statusCheckRollup` fields supply conflict and CI state — no extra calls.

Four buckets, evaluated top-down so each PR lands in exactly one:

| Bucket | Rule |
|---|---|
| ⚠ **Needs attention** | Authored by me **and** (`reviewDecision = CHANGES_REQUESTED` **or** `ciStatus = failure` **or** `mergeable = CONFLICTING`) |
| 👀 **Needs my review** | `review-requested:@me`, not yet reviewed by me |
| ✎ **Authored** | `author:@me`, open, not already in *Needs attention* |
| ✔ **Recently merged/closed** | mine, closed in last ~7 days (collapsible, low priority) |

- **Row:** CI dot · `#num` · title · repo · review-decision / conflict / draft chips · author avatar/initials · `● checked out: <worktree>` when linked. Unread rows highlighted.
- **Filters:** All / Pinned-repos-only + text filter; sort by updated.
- **Click behavior:** worktree-linked PR ⇒ open its diff in the preview pane via the existing `DiffRenderer`. Unlinked PR ⇒ open on GitHub. (A future detail-card view may replace the GitHub jump; out of scope for v0.3.5.)

---

## 6. Activity polling & badges

A single background poller thread (in `GithubState`), started when authed:

- **Source:** `gh api notifications`, filtered to PR threads where the user is author or requested reviewer.
- **Cadence:** ~45s when the Vector window is focused; back off to ~5 min when unfocused (frontend reports focus state, as it already tracks the active tab). `If-None-Match` ⇒ most polls return 304 at ~zero cost. Worst case ≈ 80 calls/hr against a 5000/hr budget.
- **On change:** emit `github-activity` with the diffed threads. Frontend updates: rail icon **badge count** (unread since `seen_activity`), **row highlight** in the PR inbox, subtle pulse on the rail icon. **No macOS banners.**
- **Seen** clears when the user views the relevant PR/inbox; `seen_activity` timestamps persist so badges survive restart.
- **Edge handling:** poller pauses on auth loss or sleep/wake gaps (re-checks `gh auth status` on resume); requests never overlap.

---

## 7. Actions center

### Entry points

1. **Per-repo** — drill into a repo ⇒ its workflows (`gh api repos/{owner}/{repo}/actions/workflows`) + recent runs.
2. **Global favorites dashboard** — top of the Actions sub-view: runs for every workflow in `favorited_workflows`, across repos, newest first. Star a workflow anywhere to add it. This is the "see Actions across repos without visiting GitHub" piece.

### Hierarchy

Workflow → Runs → Jobs → Steps. Run row: status spinner / conclusion glyph, run #, branch, triggering event, actor, relative time, commit SHA. Expand a run ⇒ jobs with per-step status.

### Control set (all via `gh`)

- **Trigger** — `workflow_dispatch`: a modal reads the workflow's `inputs` schema and renders typed fields (string / boolean / choice / environment) + a ref/branch picker; submits `gh api -X POST .../dispatches`.
- **Re-run** — all jobs or failed-only (`gh run rerun <id>` / `--failed`).
- **Cancel** — `gh run cancel <id>` for in-progress runs.
- **Logs** — while running: poll status/steps (~5s) and show live step progress; on completion: fetch full logs (`gh run view <id> --log`, or `--log-failed`) and render in a **preview pane** via the existing code/log renderer. No fake live-tail.

### Refresh

In-progress runs visible on screen poll on a short interval; idle lists use the cached TTL. The activity poller also flags newly-failed favorited runs.

---

## 8. Rate-limit & performance posture

- Authenticated REST budget 5000/hr; GraphQL counts separately. Batched GraphQL for repos + PR inbox keeps interactive loads to ~1 call each.
- All read endpoints cached with ETag conditional re-fetch; polling dominated by cheap 304s.
- Per-call subprocess spawn cost is acceptable at this cadence; the `client.rs` cache avoids redundant spawns within a TTL window.

---

## 9. Module boundaries (for testability / clarity)

Each unit has one purpose and a well-defined interface:

- `client.rs` is the *only* place that spawns `gh`; everything else calls typed functions on it. Swapping the transport (e.g., a future Octokit path) touches one file.
- `repos.rs` / `prs.rs` / `actions.rs` / `notifications.rs` each own one GitHub concern and return plain typed structs to the command layer.
- Frontend views are independent and read from `githubState.ts` + Tauri events; no shared mutable state between views.

---

## 10. Verification plan (no test suite — exercise live)

Build, then walk each flow in the running app:

1. **Repos** — load; create a custom group; drag a repo in; pin; restart ⇒ groups/pins/collapse persist.
2. **PR inbox** — force a merge conflict and a failing CI on an authored PR ⇒ it lands in *Needs attention*; a `review-requested:@me` PR lands in *Needs my review*.
3. **Worktree link** — check out a PR branch ⇒ row shows the linked worktree; click ⇒ correct diff opens in preview.
4. **Actions** — trigger a `workflow_dispatch` with inputs; re-run failed; cancel an in-progress run; open `--log-failed` in the preview.
5. **Badges** — generate a real review/comment ⇒ rail badge increments; viewing clears it; restart preserves seen state.
6. **Degraded** — temporarily move `gh` off PATH ⇒ install hint; `gh auth logout` ⇒ login CTA.

Staff-engineer subagent reviews the diff (builds its own context) before push.

---

## 11. Release mechanics (v0.3.5)

- Bump version in **three** files: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
- Sync lockfiles (`npm install --package-lock-only`; a `cargo` command).
- Add `gh` to `config::augmented_path()` / `which_path` lookups.
- Update `README.md` (new GitHub tab section) and refresh `CLAUDE.md`'s architecture list (currently behind code: `git.rs`, `sidebar.rs`, `usage.rs`, `preview.rs`, `fs_watch.rs`, `worktree_session.rs` undocumented) to also include the new `github/` module.
- Commit, tag `v0.3.5`, push, create the GitHub release with custom "What's new", then `scripts/release.sh`.
