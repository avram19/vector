# Vector Website — Landing Page + Docs (GitHub Pages)

**Status:** Design approved, pending spec review
**Date:** 2026-07-21

## Goal

A free, hosted **landing page + documentation site** for Vector on GitHub Pages,
plus a slimmed README that points at it. Covers install/getting-started,
features/usage, custom agents/config, and architecture/contributing. Built to
deploy now with **placeholder images**, with real screenshots swapped in later.

## Constraints & decisions (locked)

- **Shape:** full — a custom marketing **landing page** *and* structured **docs**.
- **Content areas (all four):** Getting started · Guide (features/usage) · Agents & config · Architecture/contributing.
- **Stack:** **Astro + Starlight** (`@astrojs/starlight`) — custom hero landing via Astro, docs via Starlight (sidebar nav, full-text search, dark/light, mobile, edit-links).
- **Hosting:** **GitHub Pages**, source = GitHub Actions. URL `https://avram19.github.io/vector/` (custom domain is a later add via `CNAME`). Project subpath → Astro `base: '/vector'`.
- **Images:** ship **placeholders** now (labeled, correctly-sized), real screenshots drop in later without structural change.
- **README:** slimmed to intro + badges + link-to-site + build-from-source + license, **keeping the "How it was built" vibe-coded disclosure verbatim** (non-negotiable).
- **Download tracking (#2):** a shields.io downloads badge in the README and the landing's download section — no separate tooling.
- **Pinned deps** in `website/package.json` (exact, no `^`/`~`), matching repo policy.

## Architecture

- **`website/`** — a self-contained Astro project (its own `package.json`, `node_modules`, `astro.config.mjs`), committed to the repo.
  - `src/pages/index.astro` — the custom landing page (owns `/`).
  - `src/content/docs/**` — Starlight markdown docs (own their slug routes under `/vector/...`).
  - `src/assets/` — images (placeholders now).
  - `astro.config.mjs` — `site: 'https://avram19.github.io'`, `base: '/vector'`, Starlight integration + sidebar config.
- **Routing:** the custom `src/pages/index.astro` takes `/`; Starlight serves the docs collection at their slugs. Verify during implementation that the custom landing wins at root (fallback: Starlight `splash`-template homepage if a routing conflict appears).
- **Deploy:** `.github/workflows/pages.yml` — on push to `main` under `website/**` (+ `workflow_dispatch`), build with `withastro/action` and publish with `actions/deploy-pages`. `permissions: { contents: read, pages: write, id-token: write }`. Pages must be enabled once in repo settings (source: GitHub Actions).

## Landing page (`src/pages/index.astro`)

Single scrolling page, dark-first, theme-aware:

1. **Top nav** — logo/wordmark, links: Docs, GitHub, Download.
2. **Hero** — headline ("An agent-first terminal"), one-line subtext (every tab is a coding agent, not a shell), primary CTA **Download**, secondary **Read the docs** / **GitHub**, and the **hero screenshot** (placeholder now).
3. **Feature grid** — 6 cards, each icon + title + one-liner (+ optional small shot):
   agent-native tabs · pane splits · file/diff/mermaid previewer · GitHub sidebar (PRs/Actions) · Claude profiles · cross-platform (macOS + Linux).
4. **Supported agents** — a compact strip/list (Claude Code, Codex, Cursor Agent, Copilot CLI, Aider, Gemini, Amazon Q, OpenCode, Crush, Goose, Amp, Plandex, Continue, Qodo, + raw shell).
5. **"How it was built"** — the vibe-coded disclosure, reused verbatim from the README (non-negotiable).
6. **Download** — macOS `.dmg`, Linux `.AppImage` / `.deb` (link to Releases), unsigned note, + the **downloads badge**.
7. **Footer** — links (GitHub, Docs, License PolyForm Noncommercial), a "built with Claude Code" line.

## Docs (Starlight, `src/content/docs/`)

Sidebar groups → pages (content **adapted** from the existing README / CLAUDE.md / `docs/superpowers/specs`, not written from scratch):

- **Getting started/** — `install.md` (macOS dmg + Linux AppImage/deb, per-OS), `first-run.md` (notifications, picking an agent), `updates.md` (in-app updater).
- **guide/** — `tabs-and-panes.md`, `previewer.md`, `sidebar.md` (files/worktrees), `github.md` (PR inbox/Actions), `profiles.md` (Claude profiles), `usage-meter.md`, `shortcuts.md` (per-platform table — macOS ⌘ vs Linux/Windows Ctrl+Shift), `themes.md`.
- **agents/** — `agent-list.md`, `custom-agent.md` (adding one, `config.toml`), `resume.md`.
- **architecture/** — `how-its-built.md` (Tauri v2 / PTY pipeline / `platform/` module), `build-from-source.md`, `vibe-coded.md` (the story + link to the design specs).

Starlight config carries: title "Vector", the logo, a GitHub social link, `editLink` to the repo, and the sidebar groups above.

## README (slimmed)

Keep it a lean repo front door:
- Title + one-paragraph intro + **badges** (downloads, license; optionally build status).
- **A prominent link to the docs site.**
- Quick install (macOS + Linux one-liners), Build from source, Add a custom agent (short — link to docs for detail), License.
- **"How it was built"** section verbatim (non-negotiable).
- The deep feature/shortcut/profile sections move to the docs site; the README links out rather than duplicating.

## Placeholder images

Committed, correctly-sized labeled placeholders (SVG or PNG) at the paths the real screenshots will occupy: `hero`, the six feature shots, and a Linux shot. Each is a neutral frame labeled with what it depicts (e.g. "Hero — agent tab") so the layout is real and swapping in a PNG later is a one-file change. A short `website/src/assets/README.md` lists the target filename, dimensions, and subject for each, matching the screenshot shopping list.

## Verification

- `npm run build` (in `website/`) succeeds; `npm run preview` serves locally.
- Landing renders at `/` with hero + all sections; docs render with working sidebar nav + search; dark/light toggle works; internal links resolve under the `/vector` base.
- The Pages workflow deploys and the live site loads at the Pages URL (first deploy after enabling Pages).

## Out of scope (YAGNI)

- Custom domain (default `github.io` URL; CNAME is a trivial later add).
- Blog/changelog page (the GitHub Releases + CHANGELOG cover this).
- Analytics beyond the downloads badge.
- i18n / versioned docs.
- Writing net-new deep content where the README/specs already have it — adapt, don't reinvent.

## Open risks

1. **Astro custom-index vs Starlight root routing** — verify the custom landing owns `/`; fall back to Starlight's splash template if needed.
2. **Base-path link correctness** — project-subpath (`/vector`) means every asset/link must respect `base`; Astro/Starlight handle this when configured, but verify in `preview`.
3. **Pages enablement** — a one-time manual repo setting (source: GitHub Actions) the workflow can't do itself.
