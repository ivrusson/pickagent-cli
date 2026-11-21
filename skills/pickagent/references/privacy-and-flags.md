# Privacy contract and CLI flags

Source of truth: the README at the root of https://github.com/ivrusson/pickagent-cli.

## What the scanner reads

- Claude Code (default): via `ccusage` offline reports or, if those fail, local `.jsonl` under Claude config dirs — only numeric usage fields.
- Codex (`--codex`, experimental): rollout logs under `CODEX_HOME` / `~/.codex`, only token and timing aggregates.

Aggregates only: tokens, hours, models, 5-hour windows. Hours stored at hour granularity.

## What it never reads

- Message, prompt, or tool **content**.
- Paths, `cwd`, project names, titles.
- Clear session ids (hashed for grouping only; hash not in profile).
- API keys (stripped from child env before ccusage).

## Network

- `npx` may download `ccusage` once; ccusage runs `--offline`.
- `GET /api/catalog/prices` for plan names and amounts. No profile is sent. `PICKAGENT_API_URL` overrides the origin.
- Optional: open the verdict URL in the browser after user confirmation.
- No other HTTP; no database.

## Flags (quick reference)

```
npx @pickagent/cli scan [--period YYYY-MM | --days N] [--plan SLUG]...
  [--price planId=amountEUR|USD[/mo|/yr]]...
  [--lang es|en] [--json] [--yes] [--no-open] [--verbose] [--codex] [--base-url URL]
```

`--lang` forces `/es/veredicto` or `/en/verdict`. Without it, a locale starting with `es` (`LC_ALL`, then `LC_MESSAGES`, then `LANG`) opens the Spanish page.

Agents, `--json`, and a non-TTY run do not prompt. Pass `--plan` and `--price`.

- `--json` + `--no-open`: profile on stdout for MCP `simulate_profile`. The URL is on stderr.
- `--yes`: accept defaults (all accounts, saved plans and prices, catalog prices) and open unless `--no-open`.
- `--verbose`: harness breakdown and notes. The default summary is short.
- `--codex`: Codex-only profile; do not mix with Claude in one run.
