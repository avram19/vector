# Linux Port (Milestone 1) — Behavioral Verification Checklist

Run this in the **UTM Ubuntu Desktop arm64** VM against `feat/linux-port`
(`npm run tauri dev`, or a packaged AppImage). Tick each box; note anything odd
and paste it back. Items map to the tasks that produced them.

The Linux **compile** gate already passed on CI (x86_64 + aarch64). This list is
about *behavior* — the part CI can't see.

## 0. Launch
- [ ] `git checkout feat/linux-port && npm install && npm run tauri dev` builds and the window opens.
- [ ] No errors in the terminal about missing `.so` libs (if any, paste them).

## 1. Render gate — CRITICAL (Task 1, WebKitGTK)
This is the one risk CI could not verify.
- [ ] Open a shell tab — xterm text is crisp, **no scattered letters / em-dash corruption**.
- [ ] Wrapping is correct at the window edge (the `cols-3` margin holds — no wrap/scroll misalignment).
- [ ] Cursor tracks correctly while typing.
- [ ] Run `htop`, then `q`; run a fast-scrolling command (`ls -R /usr` or `yes | head -10000`) — redraw stays clean under load.
- [ ] Resize the window — terminal reflows without corruption.
- [ ] Launch a real Claude/agent tab (if configured) — streaming output is clean (frame coalescing intact).

## 2. Live cwd tracking (Task 2 `/proc`, Task 6 trampoline)
- [ ] In a **bash** shell tab, `cd /tmp` then `cd ~` — the sidebar file tree / cwd follows each `cd`.
- [ ] Repeat with **zsh** as `$SHELL` (`chsh -s $(which zsh)` or launch zsh) — cwd still tracks.
- [ ] In an agent tab, `cd` into a subdir — `read_agent_cwd` follows (sidebar updates).

## 3. Clipboard file paste (Task 3, Wayland + X11)
- [ ] In the Files app, **copy a file**, then in a Vector tab **paste** — the file's absolute path is inserted.
- [ ] Copy a file whose name **contains a space** — the pasted path is correct (percent-decoded, not `%20`).
- [ ] (If on X11) same test — confirm `xclip` path works. (Check session type: `echo $XDG_SESSION_TYPE`.)

## 4. File manager + default app (Task 1 Linux)
- [ ] "Reveal in file manager" on a file — the file manager opens **with that file selected** (DBus ShowItems).
- [ ] "Open with default app" on a file — it opens in the OS default handler.

## 5. Editor discovery + open (Task 5)
- [ ] With `code` installed (`sudo snap install code --classic` or apt), the sidebar editor menu lists **VS Code**.
- [ ] Also test `cursor`/`zed`/`nvim` if installed — each installed one appears.
- [ ] "Open in editor" launches the editor **at that path**.

## 6. Usage meter (Task 4)
- [ ] With a signed-in Claude (`~/.claude/.credentials.json` present), the usage meter shows numbers (reads the plaintext credential, no Keychain).

## 7. GitHub sidebar (cross-platform via `gh`)
- [ ] `gh auth login` in a terminal, then the GitHub tab lists repos / PRs / Actions (confirms `augmented_path` finds `gh` + `git` on Linux).

## 8. Keybindings (Task 7 — Ctrl+Shift on Linux)
- [ ] **Ctrl+Shift+T** opens a new tab.
- [ ] **Ctrl+Shift+W** closes a tab.
- [ ] Pane split shortcut works (row split; **column split = Ctrl+Shift+Alt+D** — 4-key chord, see Decisions below).
- [ ] Reload-agent shortcut works.
- [ ] **Plain Ctrl+C** in a running process **reaches the shell** (interrupts it) — NOT captured by an app action.
- [ ] Ctrl+D / Ctrl+U behave as normal shell controls.
- [ ] Copy = **Ctrl+Shift+C** (so Ctrl+C stays with the terminal).
- [ ] Sanity that `platform()` resolved: the fact that Ctrl+Shift shortcuts work at all confirms `isMac`/`isMod` initialized (the plugin-os init-timing assumption holds).

## 9. Updater / packaged build (release-time — optional now)
- [ ] Build a package: `npm run tauri build` → confirm `.AppImage` + `.deb` are produced under `src-tauri/target/.../bundle/`.
- [ ] Run the AppImage directly (not just `tauri dev`) — all of §1–8 still work from the packaged binary.
- [ ] (Deferred) Full updater self-update test needs a signed release with the Linux `latest.json` keys — do once secrets are wired.

## 10. macOS regression (run on the Mac, NOT the VM)
- [ ] Every ⌘ shortcut still works exactly as before; ⌘←/→ still do line-start/end.
- [ ] Reveal in Finder, open-with-default, editor discovery (`mdfind`), usage meter (Keychain), clipboard file paste all unchanged.

## Decisions pending (tell me your call)
- [ ] **Column-split chord** is currently **Ctrl+Shift+Alt+D** (4 keys). Keep, or remap to something lighter?
- [ ] **Wire signing secrets** (`TAURI_SIGNING_PRIVATE_KEY` + password) as repo secrets so `build.yml` can produce installable AppImages and the updater manifest?
- [ ] Before cutting any Linux release: verify `release.sh`'s AppImage-tarball glob matches Tauri's real output filenames (flagged in Task 8 review).
