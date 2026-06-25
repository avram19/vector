# GitHub Sidebar — Plan 0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third sidebar tab ("GitHub") that authenticates via the user's `gh` CLI and renders a panel with auth-aware states and a Repos/PRs/Actions sub-tab shell — the foundation every later GitHub plan builds on.

**Architecture:** A new `src-tauri/src/github/` module owns all `gh` interaction behind a single `client.rs` choke point; a `GithubState` (response cache, reserved for later phases) is added to `AppState`. The frontend gains a `github` `SidebarTab`, a rail icon, and a `src/github/GithubPanel.tsx` that shows install/login/empty states and a three-way sub-tab shell with placeholder bodies (filled by Plans 1–4).

**Tech Stack:** Rust (Tauri v2 commands, `parking_lot::Mutex`, `std::process::Command`), React 18 + TypeScript, `@tauri-apps/api` `invoke`. No new dependencies.

## Global Constraints

- **No test suite in this repo.** The "test cycle" for every task is: `cargo check --manifest-path src-tauri/Cargo.toml` (backend), `npx tsc --noEmit` (frontend), then a scripted manual check in the running app via `npm run tauri dev`. Never claim a task passes without running these.
- **Visual source of truth:** `docs/superpowers/specs/assets/2026-06-24-github-sidebar-mockup.html`. UI must match it (layout, density, color, iconography).
- **`gh` is already discoverable** via `config::which_path("gh")` (homebrew/usr-local dirs are in `augmented_path()`). Do **not** add new PATH entries.
- **Pinned deps:** all `package.json` deps are pinned exactly (no `^`/`~`). Add no npm/cargo dependencies in this plan.
- **DOM renderer only** for xterm; not touched here, but don't introduce alternate renderers.
- **Auth model:** `gh` CLI only. Never read or store a token in the webview or on disk.
- **Commit trailer:** end every commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Branch:** all work lands on `feat/github-sidebar` (already created).

---

### Task 1: `gh` client choke point + auth status

**Files:**
- Create: `src-tauri/src/github/mod.rs`
- Create: `src-tauri/src/github/client.rs`

**Interfaces:**
- Produces:
  - `github::client::run_gh(args: &[&str]) -> Result<String, String>` — runs `gh`, returns stdout, maps non-zero exit to `Err(stderr)`.
  - `github::client::AuthStatus { installed: bool, authed: bool, login: Option<String> }` (serializes camelCase: `installed`, `authed`, `login`).
  - `github::client::auth_status() -> AuthStatus` (blocking).
  - `github::GithubState` (Default) with `cache: parking_lot::Mutex<HashMap<String, CachedResponse>>`.
  - `github::CachedResponse { etag: Option<String>, body: String, fetched_at: std::time::Instant }`.
  - `github::gh_auth_status` Tauri command → `Result<client::AuthStatus, String>`.

- [ ] **Step 1: Create `src-tauri/src/github/client.rs`**

```rust
use std::process::Command;

use crate::config;

/// Resolve the `gh` binary against Vector's augmented PATH (GUI apps start with
/// a minimal PATH on macOS). `None` means gh is not installed / not on PATH.
pub fn gh_path() -> Option<std::path::PathBuf> {
    config::which_path("gh")
}

/// Run `gh` with `args`, returning stdout on success. A non-zero exit maps to
/// `Err(stderr)`. PATH is augmented so gh's own child processes (git) resolve.
pub fn run_gh(args: &[&str]) -> Result<String, String> {
    let gh = gh_path().ok_or_else(|| "gh CLI not found on PATH".to_string())?;
    let out = Command::new(&gh)
        .args(args)
        .env("PATH", config::augmented_path())
        .output()
        .map_err(|e| format!("failed to spawn gh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("gh exited with {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub installed: bool,
    pub authed: bool,
    pub login: Option<String>,
}

/// Determine gh install + auth state. Authed iff `gh api user` returns a login.
pub fn auth_status() -> AuthStatus {
    if gh_path().is_none() {
        return AuthStatus { installed: false, authed: false, login: None };
    }
    match run_gh(&["api", "user", "--jq", ".login"]) {
        Ok(out) => {
            let login = out.trim().to_string();
            if login.is_empty() {
                AuthStatus { installed: true, authed: false, login: None }
            } else {
                AuthStatus { installed: true, authed: true, login: Some(login) }
            }
        }
        Err(_) => AuthStatus { installed: true, authed: false, login: None },
    }
}
```

- [ ] **Step 2: Create `src-tauri/src/github/mod.rs`**

```rust
pub mod client;

use std::collections::HashMap;
use tauri::State;

use crate::AppState;

/// A cached `gh api` response. Reserved for Plans 1–4 (repos/PRs/actions); the
/// foundation only constructs the empty map.
pub struct CachedResponse {
    pub etag: Option<String>,
    pub body: String,
    pub fetched_at: std::time::Instant,
}

/// In-memory only — never serialized to disk. Holds the ETag response cache and
/// (in later plans) the activity poller handle.
#[derive(Default)]
pub struct GithubState {
    pub cache: parking_lot::Mutex<HashMap<String, CachedResponse>>,
}

#[tauri::command]
pub async fn gh_auth_status(_state: State<'_, AppState>) -> Result<client::AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(client::auth_status)
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Verify it compiles (will fail until wired into main.rs — expected)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | head -20`
Expected: error `file not found for module \`github\`` OR unused-module warnings — because `mod github;` is not yet declared. This confirms the files exist but aren't wired. Proceed to Task 2 (do not commit a non-compiling tree).

---

### Task 2: Wire the github module into `AppState` + command handler

**Files:**
- Modify: `src-tauri/src/main.rs` (module decls ~line 3–11; `struct AppState` line 18–27; the `AppState { … }` constructor; the `tauri::generate_handler!` block)

**Interfaces:**
- Consumes: `github::GithubState`, `github::gh_auth_status` from Task 1.
- Produces: `AppState.github: github::GithubState` accessible to all commands; `gh_auth_status` invokable from the frontend.

- [ ] **Step 1: Declare the module.** In `main.rs`, in the `mod …;` block (alphabetical, near line 5), add `mod github;` after `mod git;`:

```rust
mod git;
mod github;
mod preview;
```

- [ ] **Step 2: Add the field to `AppState`.** In `struct AppState { … }` (line 18), add after `ui_config`:

```rust
    ui_config: parking_lot::Mutex<config::UiConfig>,
    github: github::GithubState,
```

- [ ] **Step 3: Initialize the field.** Find where `AppState { … }` is constructed (search: `registry:` inside a `.manage(` or `AppState {` literal). Add the field to that literal:

```rust
        ui_config: parking_lot::Mutex::new(config::load_ui_config()),
        github: github::GithubState::default(),
```

(Match the surrounding field-init style; `GithubState::default()` gives an empty cache.)

- [ ] **Step 4: Register the command.** In the `tauri::generate_handler![ … ]` block, add `github::gh_auth_status,` next to the other module-qualified commands (e.g., after `read_agent_cwd,`):

```rust
            read_agent_cwd,
            github::gh_auth_status,
        ])
```

- [ ] **Step 5: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: `Finished` with no errors. Warnings about unused `CachedResponse`/`cache` fields are acceptable (they're used in later plans) — silence them by prefixing with nothing yet; if the build is configured `deny(warnings)` it is not (existing code carries warnings), so leave as-is.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/github/ src-tauri/src/main.rs
git commit -m "feat(github): add gh client + auth-status command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Persist the GitHub sub-view (backend config)

**Files:**
- Modify: `src-tauri/src/config.rs` (`enum SidebarTab` line 49–52; `struct UiConfig` line 71–83; `Default for UiConfig` line 85–95)
- Modify: `src-tauri/src/main.rs` (`struct SidebarConfigPatch` line 645–651; `update_sidebar_config` line 654–662)

**Interfaces:**
- Produces: `SidebarTab::Github` (serializes `"github"`); `UiConfig.github_subview: String` (default `"repos"`); `update_sidebar_config` accepts and persists `github_subview`.

- [ ] **Step 1: Add the enum variant.** In `config.rs`, extend `SidebarTab`:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SidebarTab {
    Files,
    Worktrees,
    Github,
}
```

- [ ] **Step 2: Add the config field + default helper.** Above `struct UiConfig`, add the default fn near `default_sidebar_width` (line 69):

```rust
fn default_sidebar_width() -> u32 { 240 }
fn default_github_subview() -> String { "repos".to_string() }
```

Then add the field to `struct UiConfig` (after `worktrees_view_mode`):

```rust
    #[serde(default)]
    pub worktrees_view_mode: WorktreesViewMode,
    #[serde(default = "default_github_subview")]
    pub github_subview: String,
```

And to the `Default` impl (after `worktrees_view_mode`):

```rust
            worktrees_view_mode: WorktreesViewMode::default(),
            github_subview: default_github_subview(),
        }
```

- [ ] **Step 3: Extend the patch struct.** In `main.rs`, add to `SidebarConfigPatch` (after `worktrees_view_mode`):

```rust
    worktrees_view_mode: Option<config::WorktreesViewMode>,
    github_subview: Option<String>,
}
```

- [ ] **Step 4: Apply the patch.** In `update_sidebar_config`, add before the `save_ui_config` line:

```rust
    if let Some(v) = patch.worktrees_view_mode { cfg.worktrees_view_mode = v; }
    if let Some(v) = patch.github_subview { cfg.github_subview = v; }
    config::save_ui_config(&cfg).map_err(|e| e.to_string())
```

- [ ] **Step 5: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs
git commit -m "feat(github): persist github sub-view + SidebarTab::Github

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend state — add the `github` tab + sub-view

**Files:**
- Modify: `src/sidebar/sidebarState.ts` (type line 5; `SidebarState` line 10–16; `DEFAULT` line 19–25)

**Interfaces:**
- Consumes: `update({ github_subview })` and `update({ sidebar_active_tab: "github" })` from `useSidebarState`.
- Produces: `SidebarTab` now includes `"github"`; `SidebarState.github_subview: string`.

- [ ] **Step 1: Extend the type union.** Line 5:

```ts
export type SidebarTab = "files" | "worktrees" | "github";
```

- [ ] **Step 2: Add the state field.** In `type SidebarState`, after `worktrees_view_mode`:

```ts
  worktrees_view_mode: WorktreesViewMode;
  github_subview: string;
};
```

- [ ] **Step 3: Add the default.** In `DEFAULT`, after `worktrees_view_mode`:

```ts
  worktrees_view_mode: "flat",
  github_subview: "repos",
};
```

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors related to `sidebarState.ts`. (Pre-existing errors elsewhere, if any, are out of scope — but there should be none.)

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/sidebarState.ts
git commit -m "feat(github): add github sidebar tab + sub-view to frontend state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: GitHub panel component (auth states + sub-tab shell)

**Files:**
- Create: `src/github/GithubPanel.tsx`
- Reference: `docs/superpowers/specs/assets/2026-06-24-github-sidebar-mockup.html` (match header + sub-tabs)

**Interfaces:**
- Consumes: `invoke<GhAuthStatus>("gh_auth_status")`; `subview: string` + `onSubview: (v: string) => void` props (driven by `update({ github_subview })` in Task 6).
- Produces: `GithubPanel` React component; `type GhAuthStatus = { installed: boolean; authed: boolean; login: string | null }`.

- [ ] **Step 1: Create `src/github/GithubPanel.tsx`**

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type GhAuthStatus = { installed: boolean; authed: boolean; login: string | null };

type SubView = "repos" | "prs" | "actions";

const SUBTABS: { id: SubView; label: string }[] = [
  { id: "repos", label: "Repos" },
  { id: "prs", label: "PRs" },
  { id: "actions", label: "Actions" },
];

export function GithubPanel({
  subview,
  onSubview,
}: {
  subview: string;
  onSubview: (v: string) => void;
}) {
  const [auth, setAuth] = useState<GhAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    invoke<GhAuthStatus>("gh_auth_status")
      .then(setAuth)
      .catch(() => setAuth({ installed: false, authed: false, login: null }))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  if (loading && !auth) {
    return <div className="gh-empty">Checking GitHub CLI…</div>;
  }
  if (!auth?.installed) {
    return (
      <div className="gh-empty">
        <p><b>GitHub CLI not found</b></p>
        <p className="gh-muted">Install <code>gh</code> to use the GitHub tab.</p>
        <a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>
        <button className="gh-retry" onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!auth.authed) {
    return (
      <div className="gh-empty">
        <p><b>Not signed in to GitHub</b></p>
        <p className="gh-muted">Run <code>gh auth login</code> in a shell, then retry.</p>
        <button className="gh-retry" onClick={refresh}>Retry</button>
      </div>
    );
  }

  const active = (SUBTABS.find((t) => t.id === subview)?.id ?? "repos") as SubView;

  return (
    <div className="gh-panel">
      <div className="gh-head">
        <span className="gh-who">
          <span className="gh-av" />
          <b>@{auth.login}</b>
          <span className="gh-muted">· gh authed</span>
        </span>
        <button className="gh-icobtn" title="Refresh" onClick={refresh}>⟳</button>
      </div>
      <div className="gh-subtabs">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            className={`gh-subtab${active === t.id ? " active" : ""}`}
            onClick={() => onSubview(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="gh-subbody">
        {active === "repos" && <div className="gh-placeholder">Repos — coming in Plan 1</div>}
        {active === "prs" && <div className="gh-placeholder">PR inbox — coming in Plan 2</div>}
        {active === "actions" && <div className="gh-placeholder">Actions — coming in Plan 3</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal styles.** Append to `src/index.css`:

```css
/* ── GitHub panel ─────────────────────────────────────────── */
.gh-empty { padding: 16px; color: var(--muted, rgba(200,200,210,0.75)); display: flex; flex-direction: column; gap: 8px; align-items: flex-start; font-size: 13px; }
.gh-empty a { color: #58a6ff; }
.gh-retry { background: rgba(128,128,128,0.16); border: 0; color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.gh-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.gh-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 6px; }
.gh-who { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.gh-who b { color: var(--fg, #e1e1eb); }
.gh-av { width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg,#3a5f8a,#a371f7); }
.gh-muted { color: rgba(170,172,190,0.6); }
.gh-icobtn { width: 24px; height: 24px; border: 0; background: transparent; color: rgba(170,172,190,0.6); border-radius: 6px; cursor: pointer; }
.gh-icobtn:hover { background: rgba(128,128,128,0.16); color: var(--fg, #e1e1eb); }
.gh-subtabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--border, rgba(128,128,128,0.18)); }
.gh-subtab { padding: 6px 11px; font-size: 12px; color: rgba(170,172,190,0.6); border: 0; background: transparent; cursor: pointer; border-bottom: 2px solid transparent; }
.gh-subtab:hover { color: var(--fg, #e1e1eb); }
.gh-subtab.active { color: var(--fg, #e1e1eb); border-bottom-color: #7aa7e0; }
.gh-subbody { flex: 1; overflow: auto; min-height: 0; }
.gh-placeholder { padding: 16px; color: rgba(170,172,190,0.5); font-size: 12px; }
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors. `GithubPanel` is unused until Task 6 — TS does not error on unused exports, so this is clean.

- [ ] **Step 4: Commit**

```bash
git add src/github/GithubPanel.tsx src/index.css
git commit -m "feat(github): GithubPanel with auth states + sub-tab shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Mount the GitHub tab in the sidebar rail + panel

**Files:**
- Modify: `src/sidebar/Sidebar.tsx` (imports line 1–4; add `GithubIcon`; rail buttons line 99–103; panel title line 117–120; panel content line 131–154)

**Interfaces:**
- Consumes: `GithubPanel` (Task 5); `state.github_subview` + `update` (Task 4).
- Produces: a clickable GitHub rail icon that opens the panel and renders `GithubPanel`.

- [ ] **Step 1: Import the panel.** Add after the `WorktreesView` import (line 4):

```tsx
import { WorktreesView } from "./WorktreesView";
import { GithubPanel } from "../github/GithubPanel";
```

- [ ] **Step 2: Add a `GithubIcon` component.** After `WorktreesIcon` (line 25), add (octocat mark, matches mockup):

```tsx
function GithubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.36 1.11 2.94.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.27 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
```

- [ ] **Step 3: Add the rail button.** After the Worktrees button (line 103, before `<div className="sidebar-rail-spacer" />`):

```tsx
        ><WorktreesIcon /></button>
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "github" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("github")}
          title="GitHub"
        ><GithubIcon /></button>
        <div className="sidebar-rail-spacer" />
```

- [ ] **Step 4: Update the panel title.** Replace the title expression (line 118–120) so `github` shows "GitHub" when no project root:

```tsx
            <span className="sidebar-panel-title" title={projectRoot ?? ""}>
              {sidebar_active_tab === "github"
                ? "GitHub"
                : (projectRoot ? basename(projectRoot) : (sidebar_active_tab === "files" ? "Files" : "Worktrees"))}
            </span>
```

(GitHub is account-global, not project-scoped, so it ignores `projectRoot`.)

- [ ] **Step 5: Render the panel content.** After the `worktrees` block (line 141–153, just before the closing `</div>` of `sidebar-panel-content` at line 154), add:

```tsx
            )}
            {sidebar_active_tab === "github" && (
              <GithubPanel
                subview={state.github_subview}
                onSubview={(v) => update({ github_subview: v })}
              />
            )}
          </div>
```

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/sidebar/Sidebar.tsx
git commit -m "feat(github): mount GitHub tab in sidebar rail + panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end manual verification in the running app

**Files:** none (verification only).

- [ ] **Step 1: Launch the app**

Run: `npm run tauri dev`
Wait for the window. Open the sidebar (click a rail icon if collapsed).

- [ ] **Step 2: Verify the authed happy path.** With `gh` installed and `gh auth login` already done:
  - A **GitHub icon** appears in the rail below Worktrees.
  - Click it → panel header shows `@<your-login> · gh authed`.
  - Three sub-tabs **Repos / PRs / Actions** render; clicking each shows its "coming in Plan N" placeholder and the active underline moves.
  - Quit and relaunch, click GitHub, click **PRs**, quit, relaunch → GitHub panel reopens on **PRs** (sub-view persisted via `ui.toml`).

- [ ] **Step 3: Verify the not-authed state.** In a terminal: `gh auth logout` (then in the app, click the panel's **Retry**). Expected: "Not signed in to GitHub" with the `gh auth login` hint. Re-login (`gh auth login`) and Retry → header returns. (If you prefer not to log out, skip — but note it as unverified.)

- [ ] **Step 4: Verify the not-installed state (optional).** Temporarily rename `gh` off PATH (e.g. `mv "$(which gh)" "$(which gh).bak"`), click Retry → "GitHub CLI not found". Restore (`mv …bak` back).

- [ ] **Step 5: Confirm `ui.toml` shape.** Run: `cat ~/.config/vector/ui.toml`
  Expected: contains `github_subview = "prs"` (or whatever you last selected) and `sidebar_active_tab = "github"`.

- [ ] **Step 6: Final commit (only if Steps 1–5 passed; no code change expected)**

If everything passed, the feature is verified — no extra commit needed. If a fix was required during verification, commit it:

```bash
git add -A
git commit -m "fix(github): <describe the fix found during verification>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Plan 0 slice):**
- GitHub as third sidebar tab (account-global) → Tasks 3–6. ✓
- `gh`-based auth, no token storage → Task 1 (`run_gh`/`auth_status`, no token read). ✓
- Degraded states (not-installed / not-authed) → Task 5. ✓
- Module layout `src-tauri/src/github/{mod,client}.rs` + `src/github/` → Tasks 1, 5. ✓
- `GithubState` (cache, reserved) in `AppState` → Tasks 1–2. ✓
- Sub-view persistence in `ui.toml` → Task 3. ✓
- Repos/PRs/Actions bodies → placeholders here; full views are Plans 1–4 (out of this plan's scope by design). ✓

**Placeholder scan:** UI "coming in Plan N" strings are intentional, scoped foundation stubs — not plan placeholders; every code step contains complete code. No "TBD/handle edge cases". ✓

**Type consistency:** `AuthStatus`/`GhAuthStatus` fields (`installed`/`authed`/`login`) match across Rust (camelCase serialize) and TS. `github_subview: String`/`string` matches. `SidebarTab::Github` ↔ `"github"` matches the existing `rename_all = "lowercase"` convention. ✓
