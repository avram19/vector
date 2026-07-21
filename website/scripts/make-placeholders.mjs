import { mkdirSync, writeFileSync } from "node:fs";
const dir = new URL("../src/assets/placeholders/", import.meta.url);
mkdirSync(dir, { recursive: true });
const shots = [
  ["hero", 1600, 1000, "Hero — agent tab (Claude Code) + sidebar"],
  ["feat-tabs", 800, 520, "Agent picker / tab bar"],
  ["feat-panes", 800, 520, "Pane splits"],
  ["feat-preview", 800, 520, "File / diff / mermaid preview"],
  ["feat-github", 800, 520, "GitHub sidebar (PRs / Actions)"],
  ["feat-profiles", 800, 520, "Claude profiles"],
  ["feat-crossplatform", 800, 520, "macOS + Linux"],
  ["linux", 1200, 760, "Vector on Linux"],
];
for (const [name, w, h, label] of shots) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#1d1d27"/><rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="#3a3a4a" stroke-width="2"/><text x="${w / 2}" y="${h / 2}" font-family="system-ui" font-size="26" fill="#8a8a9a" text-anchor="middle" dominant-baseline="middle">${label}  ·  ${w}×${h}</text></svg>`;
  writeFileSync(new URL(`${name}.svg`, dir), svg);
}
console.log("placeholders written");
