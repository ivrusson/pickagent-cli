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
- Optional: open the verdict URL in the browser after user confirmation.
- No other HTTP; no database.

## Flags (quick reference)

```
npx @pickagent/cli scan [--period YYYY-MM | --days N] [--plan SLUG]...
  [--json] [--yes] [--no-open] [--codex] [--base-url URL]
```

- `--json` + `--no-open`: profile on stdout for MCP `simulate_profile`.
- `--yes`: skip the browser confirmation prompt (still opens unless `--no-open`).
- `--codex`: Codex-only profile; do not mix with Claude in one run.
