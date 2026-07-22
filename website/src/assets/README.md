# Screenshots

Real screenshots live directly in this folder as PNGs and are imported by the
landing (`Hero.astro`, `FeatureGrid.astro`) and docs. Feature-card shots are
cropped to 800×520 (object-fit cover); the hero keeps its natural aspect.

| File | Subject | Status |
| --- | --- | --- |
| hero.png | Claude Code tab + GitHub sidebar (landing hero) | ✅ real |
| feat-tabs.png | Session picker / new session | ✅ real |
| feat-panes.png | Claude Code · OpenCode split | ✅ real |
| feat-preview.png | File tree + README preview | ✅ real |
| feat-github.png | GitHub sidebar — PR inbox | ✅ real |
| feat-profiles.png | Claude Profiles (emails/org masked → generic) | ✅ real |
| themes-light.png | Light (Solarized) theme, in the Themes doc | ✅ real |
| placeholders/feat-crossplatform.svg | macOS + Linux + Windows | ⬜ placeholder |
| placeholders/linux.svg | Vector on Linux (Ubuntu) | ⬜ placeholder |
| (windows) | Vector on Windows | ⬜ not captured |

To replace a placeholder: drop a 2×/Retina PNG here with the target name, then
import it where it's used (or, for docs, use a relative `![](...)` link). Keep
dark theme unless the slot says otherwise.
