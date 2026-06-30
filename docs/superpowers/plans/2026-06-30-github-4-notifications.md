# GitHub Activity Notifications Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust background thread polls the user's GitHub PR notifications (author / review-requested) and emits them; the GitHub rail icon shows a badge of activity since the panel was last opened, and PR inbox rows show a dot for unread activity.

**Architecture:** `github/notifications.rs` fetches+filters `gh api notifications`; a poller thread (spawned in `main.rs` setup) emits a `github-activity` event every 45s (focused) / 300s (unfocused), with focus tracked via a window event into `GithubState.focused`. The Sidebar listens, renders the rail badge (count newer than a persisted `seenAt`), sets `seenAt` on opening the panel, and threads the unread set to `PrInboxView` for row dots.

**Tech Stack:** Rust (`gh api`, `serde_json`, `std::thread`, `AtomicBool`, Tauri `Emitter`/`Manager`/`WindowEvent`), React 18 + TS (`@tauri-apps/api/event` `listen`). No new deps.

## Global Constraints

- **No test suite.** Test cycle: `cargo check --manifest-path src-tauri/Cargo.toml` (backend), `npx tsc --noEmit` + `npm run build` (frontend), then manual verification in `npm run tauri dev`.
- **Spec:** `docs/superpowers/specs/2026-06-30-github-notifications-design.md`.
- **Builds on Plans 0–3.** Available: `github::client::run_gh`, `github::{CachedResponse, GithubState}`, `AppState.github`, the `github_*` `UiConfig`/`SidebarConfigPatch`/`SidebarState` pattern, `Sidebar` (rail buttons + `GithubPanel` mount + `update`), `GithubPanel` (renders `PrInboxView`), `PrInboxView` (`PullRequest` has `repo`+`number`; `PrRow` is a component).
- **Data layer:** `gh api` only via `client::run_gh`. No new cargo/npm deps.
- **Scope:** badge counts unread notifications with `reason ∈ {author, review_requested}` and `subject.type == "PullRequest"`. **No macOS banners.** Do NOT mutate GitHub read state — `seenAt` is local.
- **Badge vs dot:** badge = count with `updatedAt > seenAt` (clears on opening the panel); dot = PR is in the current unread set (independent of `seenAt`).
- **camelCase Rust↔TS.** Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `feat/github-sidebar`.

---

### Task 1: Backend — notifications fetch + poller + focus

**Files:**
- Create: `src-tauri/src/github/notifications.rs`
- Modify: `src-tauri/src/github/mod.rs` (`pub mod notifications;`, `GithubState.focused` + manual `Default`, `list_github_notifications` command)
- Modify: `src-tauri/src/main.rs` (`setup()`: spawn poller + window focus handler; register command)

**Interfaces:**
- Produces: `notifications::Notification { thread_id: String, repo: String, number: u64, title: String, reason: String, updated_at: String }` (camelCase: `threadId`, `repo`, `number`, `title`, `reason`, `updatedAt`). `notifications::list_notifications() -> Result<Vec<Notification>, String>`; `notifications::spawn_poller(app: tauri::AppHandle)`; command `list_github_notifications`; `GithubState.focused: std::sync::atomic::AtomicBool` (default `true`).

- [ ] **Step 1: Create `src-tauri/src/github/notifications.rs`**

```rust
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub thread_id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub reason: String,
    pub updated_at: String,
}

/// Unread PR notifications where I'm the author or a requested reviewer.
pub fn list_notifications() -> Result<Vec<Notification>, String> {
    let raw = client::run_gh(&["api", "notifications?per_page=50"])?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
    let mut out = Vec::new();
    if let Some(items) = v.as_array() {
        for t in items {
            let reason = t["reason"].as_str().unwrap_or_default();
            if t["subject"]["type"].as_str().unwrap_or_default() != "PullRequest" {
                continue;
            }
            if reason != "author" && reason != "review_requested" {
                continue;
            }
            let url = t["subject"]["url"].as_str().unwrap_or_default();
            let number = url.rsplit('/').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            out.push(Notification {
                thread_id: t["id"].as_str().unwrap_or_default().to_string(),
                repo: t["repository"]["full_name"].as_str().unwrap_or_default().to_string(),
                number,
                title: t["subject"]["title"].as_str().unwrap_or_default().to_string(),
                reason: reason.to_string(),
                updated_at: t["updated_at"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    Ok(out)
}

/// Background poller: emit `github-activity` (the filtered notifications) on an
/// interval — 45s focused, 300s unfocused. Best-effort: emits empty on error
/// (e.g. not authed) and keeps looping. Lives for the process lifetime.
pub fn spawn_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use std::sync::atomic::Ordering;
        loop {
            let notifs = list_notifications().unwrap_or_default();
            let _ = app.emit("github-activity", &notifs);
            let focused = app
                .state::<crate::AppState>()
                .github
                .focused
                .load(Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_secs(if focused { 45 } else { 300 }));
        }
    });
}
```

- [ ] **Step 2: In `src-tauri/src/github/mod.rs`** — declare the module, add `focused` to `GithubState` with a manual `Default`, and add the command.

Add `pub mod notifications;` under `pub mod actions;`.

Replace the `#[derive(Default)] pub struct GithubState { … }` block with:

```rust
pub struct GithubState {
    pub cache: parking_lot::Mutex<HashMap<String, CachedResponse>>,
    /// Window focus — drives the poller cadence (45s focused / 300s unfocused).
    pub focused: std::sync::atomic::AtomicBool,
}

impl Default for GithubState {
    fn default() -> Self {
        Self {
            cache: parking_lot::Mutex::new(HashMap::new()),
            focused: std::sync::atomic::AtomicBool::new(true),
        }
    }
}
```

Append the command (after `github_cancel`):

```rust
#[tauri::command]
pub async fn list_github_notifications(_state: State<'_, AppState>) -> Result<Vec<notifications::Notification>, String> {
    tauri::async_runtime::spawn_blocking(notifications::list_notifications).await.map_err(|e| e.to_string())?
}
```

- [ ] **Step 3: In `src-tauri/src/main.rs` `setup()`** — replace the line `let _ = app.get_webview_window("main");` with the poller spawn + focus handler:

```rust
            github::notifications::spawn_poller(app.handle().clone());
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        handle
                            .state::<AppState>()
                            .github
                            .focused
                            .store(*focused, std::sync::atomic::Ordering::Relaxed);
                    }
                });
            }
```

(`Manager` — for `get_webview_window`/`state` — is already imported in `main.rs`.)

- [ ] **Step 4: Register the command** in `main.rs` `generate_handler!` (after `github::github_cancel,`):

```rust
            github::github_cancel,
            github::list_github_notifications,
```

- [ ] **Step 5: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors (pre-existing warnings OK).

- [ ] **Step 6: Smoke-test the filter**

Run: `gh api "notifications?per_page=50" --jq '[.[] | select(.subject.type=="PullRequest" and (.reason=="author" or .reason=="review_requested")) | {repo:.repository.full_name, n:(.subject.url|split("/")|last), reason}] | length'`
Expected: a number (your matching unread PR notification count). 0 is fine if you have none unread.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/github/notifications.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): notifications poller — emits github-activity (author/review-requested PRs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — persist seenAt

**Files:**
- Modify: `src-tauri/src/config.rs` (`UiConfig` + `Default`)
- Modify: `src-tauri/src/main.rs` (`SidebarConfigPatch` + `update_sidebar_config`)

**Interfaces:**
- Produces `UiConfig.github_notifications_seen_at: String` (`#[serde(default)]`), settable via `update_sidebar_config`.

- [ ] **Step 1: Add the field to `UiConfig`** (after `github_favorited_workflows`):

```rust
    #[serde(default)]
    pub github_favorited_workflows: Vec<String>,
    #[serde(default)]
    pub github_notifications_seen_at: String,
```

- [ ] **Step 2: Add to the `Default` impl** (after `github_favorited_workflows: Vec::new(),`):

```rust
            github_favorited_workflows: Vec::new(),
            github_notifications_seen_at: String::new(),
```

- [ ] **Step 3: Extend `SidebarConfigPatch` in `main.rs`** (after `github_favorited_workflows: Option<Vec<String>>,`):

```rust
    github_favorited_workflows: Option<Vec<String>>,
    github_notifications_seen_at: Option<String>,
```

- [ ] **Step 4: Apply in `update_sidebar_config`** (before `config::save_ui_config`):

```rust
    if let Some(v) = patch.github_favorited_workflows { cfg.github_favorited_workflows = v; }
    if let Some(v) = patch.github_notifications_seen_at { cfg.github_notifications_seen_at = v; }
    config::save_ui_config(&cfg).map_err(|e| e.to_string())
```

- [ ] **Step 5: Verify + commit**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -2` (Expected: `Finished`.)

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs
git commit -m "feat(github): persist notifications seen-at timestamp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — Sidebar event + rail badge + seenAt + threading

**Files:**
- Modify: `src/sidebar/sidebarState.ts` (add `github_notifications_seen_at`)
- Modify: `src/sidebar/Sidebar.tsx` (listen, badge, seenAt, thread to GithubPanel)
- Modify: `src/github/GithubPanel.tsx` (accept + forward `notifications` to PrInboxView)
- Modify: `src/index.css` (rail badge style)

**Interfaces:**
- Produces on `SidebarState`: `github_notifications_seen_at: string`. `GithubPanel` gains a `notifications: GhNotification[]` prop forwarded to `PrInboxView`.
- Type `GhNotification = { threadId: string; repo: string; number: number; title: string; reason: string; updatedAt: string }`.

- [ ] **Step 1: `sidebarState.ts`** — add the field to `SidebarState` (after `github_favorited_workflows`) and `DEFAULT`:

```ts
  github_favorited_workflows: string[];
  github_notifications_seen_at: string;
```
```ts
  github_favorited_workflows: [],
  github_notifications_seen_at: "",
```

- [ ] **Step 2: `Sidebar.tsx`** — add the event listener, state, rail badge, and seenAt-on-open.

Add imports near the top:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
```
(`invoke` may already be imported — if so, don't duplicate it.)

Add the notification type (near the top of the file, after imports):

```tsx
export type GhNotification = { threadId: string; repo: string; number: number; title: string; reason: string; updatedAt: string };
```

Inside the `Sidebar` component, after `const { state, update, hydrated } = useSidebarState();`, add:

```tsx
  const [notifications, setNotifications] = React.useState<GhNotification[]>([]);

  React.useEffect(() => {
    invoke<GhNotification[]>("list_github_notifications").then(setNotifications).catch(() => {});
    const un = listen<GhNotification[]>("github-activity", (e) => setNotifications(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  const seenAt = state.github_notifications_seen_at;
  const unreadCount = notifications.filter((n) => n.updatedAt > seenAt).length;
```

In `onIconClick`, mark seen when the GitHub tab is opened. Replace the body of `onIconClick` with:

```tsx
  const onIconClick = (tab: SidebarTab) => {
    if (tab === "github") {
      update({ github_notifications_seen_at: new Date().toISOString() });
    }
    if (tab === sidebar_active_tab && !sidebar_collapsed) {
      update({ sidebar_collapsed: true });
    } else {
      update({ sidebar_active_tab: tab, sidebar_collapsed: false });
    }
  };
```

On the GitHub rail button, add the badge. Change the GitHub `<button …><GithubIcon /></button>` to include a badge span:

```tsx
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "github" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("github")}
          title="GitHub"
        >
          <GithubIcon />
          {unreadCount > 0 && <span className="sidebar-rail-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
```

Pass `notifications` to `GithubPanel` (add to the existing `<GithubPanel … />` render):

```tsx
                onOpenPreview={onOpenPreview}
                notifications={notifications}
              />
```

- [ ] **Step 3: `GithubPanel.tsx`** — accept `notifications` and forward to `PrInboxView`. Add to the props destructure + type:

```tsx
  onOpenPreview,
  notifications,
}: {
  …
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
  notifications: { repo: string; number: number; updatedAt: string }[];
}) {
```

Update the PRs mount to pass it:

```tsx
        {active === "prs" && <PrInboxView repoFilter={repoFilter} onRepoFilter={setRepoFilter} login={auth.login ?? ""} onTrigger={(t) => setTriggerTarget(t)} notifications={notifications} />}
```

- [ ] **Step 4: Rail badge CSS** — append to `src/index.css`:

```css
.sidebar-rail-icon { position: relative; }
.sidebar-rail-badge { position: absolute; top: 2px; right: 2px; min-width: 15px; height: 15px; padding: 0 3px; box-sizing: border-box; border-radius: 8px; background: #d9483b; color: #fff; font-size: 9px; font-weight: 700; line-height: 15px; text-align: center; }
```

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10`
Expected: errors ONLY about `PrInboxView` needing the new `notifications` prop (fixed in Task 4). `Sidebar.tsx`/`GithubPanel.tsx` otherwise clean.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar/sidebarState.ts src/sidebar/Sidebar.tsx src/github/GithubPanel.tsx src/index.css
git commit -m "feat(github): rail activity badge from github-activity events + seen-on-open

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — PR row unread dot

**Files:**
- Modify: `src/github/PrInboxView.tsx` (consume `notifications`, dot on matching rows)
- Modify: `src/index.css` (dot style)

**Interfaces:**
- Consumes: `notifications: { repo: string; number: number; updatedAt: string }[]`.

- [ ] **Step 1: Add the prop + unread set.** Extend the `PrInboxView` destructure + type:

```tsx
export function PrInboxView({ repoFilter, onRepoFilter, login, onTrigger, notifications }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
  login: string;
  onTrigger: (target: { repo: string; presetRef?: string }) => void;
  notifications: { repo: string; number: number; updatedAt: string }[];
}) {
```

Add, near the other `useMemo`s (e.g. after `repoOptions`):

```tsx
  const unreadSet = useMemo(() => new Set(notifications.map((n) => `${n.repo}#${n.number}`)), [notifications]);
```

- [ ] **Step 2: Pass the set into `PrRow`.** Change `PrRow`'s signature to accept `unreadSet`:

```tsx
function PrRow({ pr, onTrigger, unreadSet }: { pr: PullRequest; onTrigger: (t: { repo: string; presetRef?: string }) => void; unreadSet: Set<string> }) {
  const unread = unreadSet.has(`${pr.repo}#${pr.number}`);
```

In the `gh-pr-top` row, add the dot before the CI dot:

```tsx
      <div className="gh-pr-top">
        {unread && <span className="gh-pr-unread" title="Unread activity" />}
        <span className={`gh-ci-dot ${ciClass(pr.ciStatus)}`} />
        <span className="gh-pr-num">#{pr.number}</span>
        <span className="gh-pr-title">{pr.title}</span>
      </div>
```

- [ ] **Step 3: Update every `<PrRow … />` usage** to pass `unreadSet={unreadSet}` (there are several — each subsection map and the Team list). For example:

```tsx
{groups.action.map((p) => <PrRow key={p.url} pr={p} onTrigger={onTrigger} unreadSet={unreadSet} />)}
```

Apply the same `unreadSet={unreadSet}` addition to the `ready`, `waiting`, `done`, and `teamPrs` maps.

- [ ] **Step 4: Dot CSS** — append to `src/index.css`:

```css
.gh-pr-unread { width: 7px; height: 7px; border-radius: 50%; background: var(--gh-accent); flex: 0 0 auto; }
```

- [ ] **Step 5: Verify types + build**

Run: `npx tsc --noEmit 2>&1 | grep -v 'npm warn' | head -10` (Expected: no errors.)
Run: `npm run build 2>&1 | tail -2` (Expected: `✓ built`.)

- [ ] **Step 6: Commit**

```bash
git add src/github/PrInboxView.tsx src/index.css
git commit -m "feat(github): unread-activity dot on PR rows from notifications

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end manual verification

**Files:** none.

- [ ] **Step 1:** `npm run tauri dev`. With at least one unread PR notification where you're the author or requested reviewer (you have one in SpringRole/sv-backend), the **GitHub rail icon shows a red badge** with the count within ~45s (or immediately on launch via the initial fetch).
- [ ] **Step 2: Seen clears.** Click the GitHub rail icon to open the panel → badge clears. Quit + relaunch → badge stays clear (no new activity); `cat ~/.config/vector/ui.toml` shows `github_notifications_seen_at`.
- [ ] **Step 3: PR row dot.** GitHub → Pull Requests → a PR with unread activity shows a **dot** to the left of its CI dot. (The dot reflects unread state, so it persists even after the badge clears.)
- [ ] **Step 4: Read clears the dot.** Open that PR/notification on github.com (mark read) → within a poll cycle (~45s) the dot disappears.
- [ ] **Step 5: Focus cadence.** Unfocus the Vector window → polling slows to ~5 min (no easy visual cue; trust the code). Refocus → back to ~45s.
- [ ] **Step 6: Light theme** — badge + dot readable.

If a fix was needed, commit it with a `fix(github):` message + the trailer.

---

## Self-Review

**Spec coverage:**
- Poller thread, 45s/300s, focus via window event, emits `github-activity`, best-effort on auth loss → Task 1. ✓
- Filter to PR + reason author/review_requested → Task 1 `list_notifications`. ✓
- Rail badge = count newer than seenAt; clears on open; persisted → Tasks 2, 3. ✓
- PR row dot = current unread set (seenAt-independent) → Task 4. ✓
- No macOS banners; no GitHub read-state mutation → by construction (only emit + local seenAt). ✓
- `list_github_notifications` command for initial state → Task 1, used in Task 3. ✓

**Placeholder scan:** concrete states; no TBDs. ✓

**Type consistency:** `Notification`/`GhNotification` camelCase (`threadId`, `repo`, `number`, `title`, `reason`, `updatedAt`) identical Rust↔TS. The frontend prop types use the structural subset `{ repo, number, updatedAt }` (assignable from the full `GhNotification`). `github_notifications_seen_at` field name identical across `UiConfig`/`SidebarConfigPatch`/`SidebarState`. `list_github_notifications` (no args) matches the invoke site. Badge uses `updatedAt > seenAt`; dot uses `unreadSet` membership — consistent with the spec's two-signal model. `GithubState.focused` default `true`. ✓
