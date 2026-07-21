// Generate polished, user-facing "What's new" release notes from the commits
// since the last tag, using Claude. Prints GitHub-flavored markdown to stdout.
//
// Usage:  node scripts/gen-release-notes.mjs <prevTag|""> <version>
// Requires: ANTHROPIC_API_KEY in the environment (or an `ant auth login` profile).
//
// Run by the release workflow's gate job; the output becomes the GitHub release
// body (which the Tauri updater shows as "What's new"). The release body stays
// editable afterward if a bullet needs a human touch.
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";

const [, , prevTag, version] = process.argv;
const range = prevTag ? `${prevTag}..HEAD` : "HEAD";

// Commit subjects since the last release, minus pure housekeeping noise.
const commits = execSync(`git log --no-merges --pretty=format:%s ${range}`, { encoding: "utf8" })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((s) => !/^(release|chore\(deps\)|ci|docs\(sdd\)):/i.test(s));

const fallback = `Release v${version}.`;

if (commits.length === 0) {
  console.log(fallback);
  process.exit(0);
}

const system = `You write concise, user-facing release notes for Vector — an agent-first terminal: a macOS/Linux desktop app where each tab runs a coding agent (Claude Code, Codex, etc.) instead of a shell. You are given the raw git commit subjects for one release and must produce the "What's new" list a *user* (not a developer) would read.

Rules:
- Output GitHub-flavored markdown: a short list of bullets, each of the form "- **Feature name** — one concise, user-facing sentence describing the benefit."
- Group related commits into a single bullet. Aim for 3–7 bullets total.
- Focus on what users notice: new features, visible fixes, platform support. OMIT internal refactors, CI, dependency bumps, version prep, and test-only changes unless they directly change the user experience.
- Never invent features that the commits don't imply.
- Output ONLY the bullet list — no heading, preamble, or sign-off.`;

const user = `Version: v${version}\n\nCommit subjects since the last release:\n${commits.map((c) => `- ${c}`).join("\n")}`;

try {
  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY / auth profile from env
  const resp = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  console.log(text || fallback);
} catch (err) {
  // Never fail the release over notes — fall back to a minimal body.
  process.stderr.write(`release-notes generation failed: ${err?.message ?? err}\n`);
  console.log(fallback);
}
