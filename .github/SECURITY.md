# Security Policy

## Supported versions

Vector ships as a rolling release with an in-app updater. Only the **latest
release** receives security fixes — please update before reporting (Help →
Check for Updates…, or grab the latest from
[Releases](https://github.com/avram19/vector/releases)).

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub:

1. Go to the [**Security** tab](https://github.com/avram19/vector/security).
2. Click **Report a vulnerability** to open a private security advisory.

Include what you can: affected version/platform, steps to reproduce, impact,
and any proof-of-concept. You'll get a response as soon as the maintainer is
able; fixes ship in the next release and are credited in the advisory unless
you prefer to stay anonymous.

## Scope notes

Vector runs third-party agent CLIs (Claude Code, Codex, etc.) and tools (`git`,
`gh`) that it spawns on your behalf — vulnerabilities in those belong to their
respective projects. Issues in **how Vector spawns, sandboxes, filters, or
renders** that software are in scope.
