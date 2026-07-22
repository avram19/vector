---
title: Build from source
description: Requirements and commands for building Vector yourself.
---

Requirements: Rust (stable), Node 20+, on macOS, Linux, or Windows.

```bash
npm install
npm run tauri dev       # dev build with HMR
npm run tauri build     # produce .app + .dmg in src-tauri/target/release/bundle/
```

`npm run tauri dev` gives you hot-module-reload on the frontend plus a Rust dev build of the backend — the fastest loop for iterating on the app.

For a quick backend-only typecheck without a full build:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

There is no automated test suite. Verify any change by running the app and exercising the affected flow directly — especially anything that touches the PTY pipeline (`pty.rs`), since that's the easiest place to introduce a regression that only shows up visually.
