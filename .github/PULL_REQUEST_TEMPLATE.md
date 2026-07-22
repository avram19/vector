<!-- Thanks for contributing to Vector! Please fill this out. -->

## Summary

<!-- What does this change do, and why? -->

## Related issue

<!-- e.g. Closes #123. Open an issue first for non-trivial changes. -->

## How was this verified?

<!-- Vector has no automated test suite — describe how you exercised the change
     in a running build. Note the OS(es) you tested on. Anything touching
     pty.rs must be verified in a running app. -->

- [ ] Built and ran the app (`npm run tauri dev` / `build`)
- [ ] Exercised the affected flow
- OS tested: <!-- macOS / Linux / Windows -->

## Checklist

- [ ] Change is focused (one concern)
- [ ] Matches the surrounding code style
- [ ] `cargo check` passes (if backend touched)
- [ ] Added a `## [Unreleased]` bullet in `CHANGELOG.md` (if user-facing)
- [ ] Updated the relevant `website/` docs page (if behavior changed)
- [ ] Did not bump the version or edit release plumbing
