# pickagent scan

Local CLI. It reads your agents' usage, builds a `pickagent.profile/v1` profile, and opens the verdict in the browser. The profile travels in the `#p=` URL fragment. It is not uploaded.

Scanner page: https://pickagent.dev/en/escaner

## Install and use

Requires Node 20 or newer. Windows: untested.

On a machine that does not have this repository:

```bash
npx @pickagent/cli scan
npx @pickagent/cli scan --period 2026-10 --plan claude-pro
npx @pickagent/cli scan --help
```

`npx` downloads the package and runs it there. It is not installed into a project.

## Options

```text
--period YYYY-MM     Calendar month. Default: the current local month.
--days N             Last N days, including today (1–366).
--plan SLUG          Plan you pay for today. Repeatable. E.g. claude-pro.
--base-url URL       Verdict origin. Default https://pickagent.dev.
--json               Write only the JSON profile to stdout.
--yes                Open the browser without asking.
--no-open            Do not open the browser.
--codex              Codex only (local rollouts; experimental).
--help               This help.
```

By default every harness is merged. `--codex` limits the read to Codex.
`--plan` replaces automatic plan detection.

From a clone of this repository:

```bash
npm ci
npm run build
node dist/cli.js scan --period 2026-10 --plan claude-pro
npm test
```

Without packaging: `npx tsx src/cli.ts scan --help`.

## What it reads

Every agent ccusage detects, by default.

1. `npx --yes ccusage@latest` with three unified reports, in parallel:
   - `daily --json --by-agent --breakdown --no-cost --offline --since YYYY-MM-DD --until YYYY-MM-DD --timezone <IANA>`
   - `session` with the same flags
   - `blocks` with `--json --no-cost --offline` and the same range (Claude 5-hour windows)
2. The `--by-agent` JSON is split by harness. Totals go into the profile metrics and the breakdown into `by_source` (hours, sessions, provenance per source).
3. If ccusage fails to start or fails validation, the local parser reads `~/.claude/projects/**/*.jsonl` (and `~/.config/claude`). `CLAUDE_CONFIG_DIR` replaces those paths.
4. If local Codex rollouts exist and ccusage did not contribute Codex, they are merged into the profile.
5. If Cursor agent-transcripts or `ai-tracking` exist and ccusage did not contribute Cursor, they are merged (estimated hours; chat text is not read).
6. Plans (no network): it reads the Claude tier in `~/.claude.json` / credentials, the `chatgpt_plan_type` JWT claim in `~/.codex/auth.json`, and Cursor `stripeMembershipType` in `state.vscdb`, maps them to catalog slugs (`claude-pro`, `chatgpt-plus`, `cursor-super`, …), and writes them to `plans` and `by_source.*.plan`. `--plan` replaces detection. Tokens and email are not uploaded.

ccusage is not part of pickagent. It is third-party code, and each run resolves it with `npx` as `ccusage@latest`, with no pinned version.

`--codex` limits the read to local Codex rollouts (experimental).

## What it never reads

- Message text, prompts, and tool contents.
- Paths, `cwd`, project names, and titles.
- The session id in the clear. It is used only to group rows, and it is hashed with SHA-256 first. The hash does not enter the profile.
- API keys. They are not requested. The ccusage process does not inherit the environment: it only receives `LOG_LEVEL=0` (set by the scanner) and, when present, these variables: `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TZ`, `LANG`, `LC_*`, `TMPDIR`, `TEMP`, `TMP`, `SystemRoot`, `ComSpec`, `PATHEXT`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `npm_config_registry`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`, `https_proxy`, `no_proxy`, `ALL_PROXY`, `npm_config_proxy`, `npm_config_https_proxy`, `npm_config_cafile`, `npm_config_userconfig`, `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE`. Names are compared case-insensitively. No variable whose name ends in `_TOKEN`, `_KEY`, or `_SECRET` is passed, nor `npm_config_*auth*`. If your proxy or registry URL contains a username and password, ccusage receives it. ccusage runs with your user permissions, so it can read your files, such as `~/.npmrc`.

From each Claude line, only these fields are copied, as numbers or hours: timestamp, model id, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and the session id (already hashed). Lines that do not look like an `assistant` record with `usage` or `rate_limit` are not parsed.

Profile hours are stored in one-hour blocks (truncated to the local hour). Clock minutes are not stored. The session median is in minutes, because the schema requires it, rounded to one minute.

ccusage output is filtered before use: dates, models, tokens, and the `isGap` / `isActive` flags are kept. Costs, session ids, paths, and the project grouping are dropped (`projects` keys are not copied).

## Network

Only two network exits:

- `npx` may download `ccusage@latest` the first time. ccusage is launched with `--offline` so it does not request prices.
- Opening the browser at the verdict URL, after confirmation.

No other HTTP. No database.

To see those calls on Linux: `strace -f -e trace=network -o /tmp/pickagent.strace npx @pickagent/cli scan --no-open`. `strace` is Linux-only; macOS does not have it. The only expected connection is `npx` downloading `ccusage`. With `--no-open` the browser does not open.

## Claude blocks (local parser)

ccusage does not say when you run out of quota (`no_limit_hits`). The local parser does, and only when ccusage did not produce a valid profile. It is best-effort, over the text Claude Code writes in the transcript when `error` is `"rate_limit"`.

The first line counts when it matches one of these:

```text
/^You've hit your (?:session|weekly) limit\b/
/^You've hit your org's monthly spend limit\b/
```

A transient API limit does not count, even when the error is `rate_limit`:

```text
/not your usage limit/i
/temporarily limiting requests/i
```

The wait comes from:

```text
/\bresets (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i
```

The sentence has no date. The wait is the next time the clock reaches that hour in the zone inside the parentheses, rounded to hours. For a weekly or monthly cap that undershoots. If the zone is missing or is not IANA, the block still counts and `wait_hours` is omitted. The sentence text is not stored.

Repeated `assistant` records with the same `message.id` count once: Claude Code writes the same response under several `uuid` values.

## Codex (`--codex`, experimental)

The machine where this reader was written had no `~/.codex/sessions` directory, so the format is not confirmed here. The expected shape is what third-party readers document: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/**/rollout-*.jsonl` (`CODEX_HOME` or `~/.codex`).

A file is included only when the first line is `session_meta` and `payload.originator` contains `codex`. `response_item` lines (prompts, tools, paths) are not parsed.

It uses `turn_context.payload.model` and `event_msg` with `payload.type === "token_count"` and `info.last_token_usage`. The cumulative `total_token_usage` is ignored. `input_tokens` includes the cached part, so uncached input is `input_tokens - cached_input_tokens`, cache read is `cached_input_tokens`, and output adds `output_tokens` and `reasoning_output_tokens`. There is no cache write: that field stays 0 and tokens and `by_model` are marked `estimated`. Hours taken from timestamps stay `measured`.

A block counts when `rate_limits.rate_limit_reached_type` is a non-empty string. The string is not stored. The wait comes from `primary.resets_at` or, if missing, `secondary.resets_at` (unix, seconds).

## Output

Without `--json`, an English summary and the URL. It asks before opening the browser. `--yes` opens without asking. `--no-open` does not open. `--json` writes only the profile to stdout; the browser opens only when you also pass `--yes` and not `--no-open`.

The URL is `{base}/en/veredicto` plus `profileToHash()`. Default base: `https://pickagent.dev`.

The profile goes through `parseProfile` before use. If it does not match the schema, the issues are printed and the process exits with code 1. With no measurable usage (no hours with a distinct start and end) it also exits with code 1: an empty profile does not fit the schema, because `agent_hours`, `activity`, and `by_model` are required.

## How to audit it

The code is in `src/`. The profile contract (`pickagent.profile/v1`, its parse, its encode, and the step from usage reports to that profile) is in `src/profile/`. esbuild bundles it into `dist/cli.js` together with Zod. There are no runtime dependencies: the published package is that file, this README, and the license.

Search for `fetch(`, `http.request`, `net.connect`, and keys: they should not appear, except the allowlist of variables passed to ccusage. The only external execution is `npx ccusage@latest` and the system `open` / `xdg-open`. On Windows the child does not start `npx.cmd` directly (Node 20.12 or newer rejects that) and the browser URL is quoted. Windows: untested.

On a clean clone: `npm ci && npm run build && node dist/cli.js scan --help && npm test`.

## Why the code is public

The profile is not uploaded. It travels in the `#p=` URL fragment, and the browser does not send the fragment to the server. The repository is public so anyone can check: the scanner does not `fetch` the profile, it opens no network beyond `npx` resolving `ccusage` and opening the browser, and the `src/profile/` schema has no place for conversation text. The verdict page reads that fragment in the browser. The verdict calculation is not in this repository.

## How it is published

No npm token is required. Pushing a tag `vX.Y.Z` whose `X.Y.Z` matches `version` in `package.json` makes GitHub Actions (`.github/workflows/release.yml`) install dependencies, build, run the tests, and publish `@pickagent/cli` with `npm publish --provenance --access public`. Provenance uses GitHub OIDC (`id-token: write`), so the npm package is tied to this repository and that commit.

Before the first tag, the repository must be registered as a trusted publisher of the package on npmjs.com (workflow `release.yml`). A person creates the tag; this repository does not publish itself.
