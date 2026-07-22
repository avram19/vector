#!/usr/bin/env node
// Compute installer-only download analytics from the GitHub Releases API and
// emit the data the badge + website consume. Excludes the updater's traffic:
//   - latest.json         → update *checks* (every client, every check) — the big inflater
//   - *.app.tar.gz/*.zip  → macOS/Windows update payloads
//   - *.sig               → fetched only by the updater (a clean proxy for updates)
// Windows (-setup.exe) and Linux (.AppImage) are re-fetched by the updater, so we
// subtract their matching *.sig count. macOS .dmg and Linux .deb are install-only.
//
// Usage: node download-stats.mjs <releases.json> <history.json> <out-dir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , releasesPath, historyPath, outDir] = process.argv;
if (!releasesPath || !historyPath || !outDir) {
  console.error("usage: download-stats.mjs <releases.json> <history.json> <out-dir>");
  process.exit(1);
}

const releases = JSON.parse(readFileSync(releasesPath, "utf8"));
const assets = releases.flatMap((r) => r.assets || []);
const sum = (re) => assets.filter((a) => re.test(a.name)).reduce((s, a) => s + (a.download_count || 0), 0);

const dmg = sum(/\.dmg$/);
const deb = sum(/\.deb$/);
const appImage = sum(/\.AppImage$/);
const appImageSig = sum(/\.AppImage\.sig$/);
const exe = sum(/-setup\.exe$/);
const exeSig = sum(/-setup\.exe\.sig$/);

const macos = dmg;
const linux = deb + Math.max(0, appImage - appImageSig);
const windows = Math.max(0, exe - exeSig);
const total = macos + linux + windows;

const compact = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n));

// shields.io endpoint badge
writeFileSync(
  join(outDir, "downloads-badge.json"),
  JSON.stringify({ schemaVersion: 1, label: "downloads", message: compact(total), color: "blue" }) + "\n"
);

// latest published release tag (API returns newest first)
const latest = releases.find((r) => !r.draft && !r.prerelease) || releases[0];
const version = latest ? latest.tag_name : null;

const updatedAt = new Date().toISOString();
// rich payload for the website (also feeds the nav version pill)
writeFileSync(
  join(outDir, "downloads.json"),
  JSON.stringify({ total, macos, linux, windows, version, updatedAt }, null, 2) + "\n"
);

// daily time series (dedupe by date; today's rerun overwrites today's row)
let history = [];
try {
  const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
  if (Array.isArray(parsed)) history = parsed;
} catch {}
const date = updatedAt.slice(0, 10);
history = history.filter((h) => h.date !== date);
history.push({ date, total, macos, linux, windows });
history.sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(join(outDir, "history.json"), JSON.stringify(history, null, 2) + "\n");

console.log(`installs total=${total} (macos=${macos} linux=${linux} windows=${windows}); history rows=${history.length}`);
