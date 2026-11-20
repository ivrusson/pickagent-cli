# pickagent skill (PA-033)

Agent skill for comparing AI plans from local usage measured by the [pickagent](https://pickagent.dev) scanner.

## What it does

When you ask things like "which AI plan should I pay for", "is Max worth it", or "I'm out of quota", the agent:

1. Explains what the scanner reads (aggregates only, never conversations).
2. After you confirm, runs `npx @pickagent/cli scan` with the flags that apply.
3. Summarizes the profile and opens the verdict in the browser, or uses the public MCP if you would rather not open it.

## npm package

The command is `npx @pickagent/cli scan`. You do not need to clone anything to run it. From a clone of this repository, `npm ci && npm run build` and `node dist/cli.js scan`.

## Install — Claude Code

Copy or link this folder into your user skills:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/pickagent" ~/.claude/skills/pickagent
```

Or clone it from GitHub:

```bash
git clone https://github.com/ivrusson/pickagent-cli.git /tmp/pickagent-cli
ln -s /tmp/pickagent-cli/skills/pickagent ~/.claude/skills/pickagent
```

You can also package it as a Claude Code plugin pointing at `skills/pickagent/`.

## Install — Codex

```bash
mkdir -p ~/.codex/skills/pickagent
cp -R skills/pickagent/* ~/.codex/skills/pickagent/
```

Codex loads `~/.codex/skills/<name>/SKILL.md`.

## Optional MCP

To simulate without a browser, or to explore plans after the scan:

- Claude Code: `claude mcp add --transport http pickagent https://pickagent.dev/api/mcp`
- Codex: `codex mcp add pickagent --url https://pickagent.dev/api/mcp`

Details in [references/mcp.md](references/mcp.md).

## Contents

| File                              | Use                                      |
| --------------------------------- | ---------------------------------------- |
| `SKILL.md`                        | Agent instructions (body in English).    |
| `references/mcp.md`               | MCP connection and public tools.         |
| `references/privacy-and-flags.md` | Privacy contract and CLI flags.          |

This skill has no scripts or binaries; documentation only.
