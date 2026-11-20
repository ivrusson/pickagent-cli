---
name: pickagent
description: >-
  Compare AI subscription plans from real local usage. Use when the user asks
  which plan to pay for, if an upgrade is worth it, cost vs limits, or hitting
  quotas — in Spanish or English. Examples: "which AI plan should I pay for",
  "is Max worth it", "I'm out of quota", "Claude Pro vs API",
  "Codex usage limits".
---

# pickagent scanner

Help the user get a **verdict** (which AI plan fits their measured usage). Speak to the user in **their language**; follow these steps in English.

## Before you run anything

1. Briefly say you will run the local open-source scanner (`npx @pickagent/cli scan`). It only reads **aggregated** usage on their machine.
2. State the privacy contract in one or two lines (do not paraphrase loosely):
   - **Reads:** local Claude Code or Codex logs; aggregated tokens, hours, models, and windows; hour-level timestamps (no clock minutes in stored hours).
   - **Never reads:** conversation content, API keys, project names, paths, or clear session identifiers. Nothing is uploaded; the profile travels in the browser URL fragment only.
3. Ask which plan they pay today and map it to a catalog slug (e.g. `claude-pro`; use `list_plans` if the MCP is connected, never guess a slug) and the period if they care (`--period YYYY-MM` or `--days N`).
4. Ask permission to run the scan. **Do not** read `~/.claude`, `~/.codex`, or any `.jsonl` logs yourself — only the CLI may read them.

## Run the scan

Execute in the user’s project directory (or home if they prefer):

```bash
npx @pickagent/cli scan
```

Add flags from what they told you:

| Flag               | When                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `--plan <slug>`    | Repeat for each plan they pay (e.g. `--plan claude-pro`).                              |
| `--period YYYY-MM` | Calendar month (default: current local month).                                         |
| `--days N`         | Last N days (1–366); do not combine with `--period`.                                   |
| `--codex`          | User runs **Codex** (not Claude Code); experimental.                                   |
| `--yes`            | Auto-open browser without a second prompt (only if they asked).                        |
| `--no-open`        | Do not open a browser.                                                                 |
| `--lang es` or `en` | Force the verdict page. Default follows `LC_ALL`, then `LC_MESSAGES`, then `LANG` (`es` → `/es/veredicto`, otherwise `/en/verdict`). |
| `--json`           | Print `pickagent.profile/v1` on stdout (pair with `--no-open` for in-agent follow-up). |

After a successful run, summarize the profile in plain language: agent hours, busy windows, model mix, and `current_plan_ids` / provenance (`measured` vs `estimated`). Offer the verdict URL the CLI printed (`https://pickagent.dev/en/verdict#p=…`, or `/es/veredicto` when the locale is Spanish).

## Browser-free path

If they do not want a browser:

1. Run: `npx @pickagent/cli scan --json --no-open` (plus their flags).
2. If the **pickagent MCP** is connected, call `simulate_profile` with the JSON profile and explain the ranked verdict using **only** tool output (never invent prices or limits).
3. If MCP is not connected, give them the verdict URL to open when they choose.

## Follow-ups (MCP)

When pickagent MCP is available, use public tools for scenarios after the profile exists:

- `simulate_profile` — verdict for a `pickagent.profile/v1` object.
- `list_plans` — catalog browse.
- `get_plan` — one plan by id.
- `search_tools` — directory search.

Signed-in tools (saved subscriptions and verdicts) need signing in with OAuth and are coming soon; do not name or call them.

Setup: see [references/mcp.md](references/mcp.md).

## Rules

- Never upload logs, paste transcript text, or send profile data to any URL except what the user opens locally via the CLI.
- Never fabricate usage numbers; if the scan fails or has no measurable hours, say so and suggest `--days` or a different period.
- For deeper privacy and CLI flags, see [references/privacy-and-flags.md](references/privacy-and-flags.md).
