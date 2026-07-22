# Contributing to Vector

Thanks for your interest in Vector — an agent-first terminal where every tab
runs a coding agent instead of a shell. Contributions are welcome. This guide
covers how to get set up, what to expect, and how to send a good change.

## A note on how Vector is built

Vector is **vibe-coded**: a human supplies requirements in plain English and an
AI coding agent produces the implementation. You're welcome to contribute
directly (hand-written PRs are great) — just keep changes focused and matching
the surrounding style. See the "How it was built" section of the
[README](../README.md) for context.

## License of contributions

Vector is source-available under the
[PolyForm Noncommercial License 1.0.0](../LICENSE). By submitting a
contribution, you agree that it is licensed under the same terms. Non-commercial
use is free; **commercial use requires a separate license** — open an issue to
discuss.

## Getting set up

Vector is a [Tauri v2](https://v2.tauri.app/) app (Rust backend + React/TypeScript
frontend, rendered with xterm.js).

Requirements: Rust (stable), Node 20+, on macOS, Linux, or Windows.

```bash
npm install
npm run tauri dev                                 # HMR frontend + Rust dev build
npm run tauri build                               # produce installers in src-tauri/target/release/bundle/
cargo check --manifest-path src-tauri/Cargo.toml  # quick backend typecheck
```

OS-divergent logic lives behind `src-tauri/src/platform/` (one file per OS,
compiler-enforced) — porting or fixing per-OS behavior means editing that
module, not scattering `cfg(target_os)` through the codebase.

## Verifying changes (there is no test suite)

Vector has no automated test suite. **A change isn't done until you've built the
app and exercised the affected flow** in a running instance — especially
anything touching `src-tauri/src/pty.rs` (the PTY read/filter/coalesce pipeline
is the most load-bearing and easiest to regress). For cross-platform changes,
the `linux-check` / `windows-check` CI jobs compile-verify the other OSes.

## Sending a pull request

1. **Open an issue first** for anything non-trivial, so we can agree on the
   approach before you invest time.
2. Branch off `main`; keep the change focused (one concern per PR).
3. Match the existing code style — comment density, naming, and idioms of the
   file you're editing.
4. Describe **what** changed and **how you verified it** (which flow you ran).
   Fill out the PR template.
5. If it's user-facing, add a short bullet under `## [Unreleased]` in
   [`CHANGELOG.md`](../CHANGELOG.md) (`- **Thing** — what the user gets.`).
6. Don't bump the version or edit release plumbing — releases are cut by the
   maintainer.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/avram19/vector/issues/new/choose).
For security problems, **do not** open a public issue — see
[SECURITY.md](SECURITY.md).

## Docs

User-facing docs live in `website/` (Astro + Starlight, published to
[avram19.github.io/vector](https://avram19.github.io/vector/)). Update the
relevant guide page when you change behavior it describes.
