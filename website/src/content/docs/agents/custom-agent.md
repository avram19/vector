---
title: Add a custom agent
description: Register any CLI as a Vector agent via ~/.config/vector/config.toml.
---

Not every agent you use ships as a Vector built-in. You can add any CLI — including internal or self-hosted tools — by dropping a TOML file at `~/.config/vector/config.toml`:

```toml
default = "claude"

[agents.myagent]
label = "My Custom Agent"
command = ["my-cli", "--flag"]

[agents.myagent.env]
MY_API_KEY = "..."
```

- `agents.<id>` — a unique key for the agent; this becomes its internal id.
- `label` — the display name shown in the agent picker and topbar dropdown.
- `command` — the argv to spawn, as an array (first element is the binary, resolved against your `PATH`; the rest are fixed arguments).
- `env` — optional key/value environment variables injected into the spawned process, on top of Vector's own (`PATH`, `TERM`, `COLORTERM`, etc.).
- `default` — which agent id new tabs should default to.

Vector merges this file with the built-in agent list on launch: your custom entries are added, and if you reuse a built-in id (like `claude`), your definition overrides it. The config is read once at startup, so **restart Vector** after editing the file for your changes to take effect.
