# pickagent scan

Local CLI. It reads your agents' usage, builds a `pickagent.profile/v1` profile, and opens the verdict in the browser. The profile travels in the `#p=` URL fragment. It is not uploaded.

Scanner page: https://pickagent.dev/en/escaner

## Install and use

Requires Node 20.12 or newer. Windows: untested.

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
--plan SLUG          Plan you pay for. Repeatable. Added to detected plans.
--price SPEC         Declared price. Repeatable.
                     SPEC is <planId>=<amount><EUR|USD>[/mo|/yr]
                     e.g. cursor-super=107.80EUR/mo
--base-url URL       Verdict origin. Default https://pickagent.dev.
--lang es|en         Verdict language. Default: es when LC_ALL, LC_MESSAGES,
                     or LANG starts with es; otherwise en.
--json               Write only the JSON profile to stdout. No prompts.
--yes                Accept the defaults and open the browser.
--no-open            Do not open the browser. The URL is printed.
--verbose            Print the harness breakdown and notes.
--codex              Codex only (local rollouts; experimental).
--help               This help.
```

By default every harness is merged. `--codex` limits the read to Codex.
`--plan` adds a plan. It does not drop plans detected on the machine.

In a terminal, `pickagent scan` asks which accounts to include (all checked), which plans you pay for, and confirms each catalog price. `--yes` accepts those defaults, including last time's plans and prices when `~/.pickagent/scanner.json` has them. Without a terminal, with `--json`, or when an agent runs the command (`PICKAGENT_AGENT=1`, `CI`, Cursor Agent, Claude Code, or Codex), there are no prompts: pass `--plan` and `--price`.

`PICKAGENT_API_URL` is the catalog origin for `GET /api/catalog/prices` (default `https://pickagent.dev`). If that request fails, a terminal asks for the amount, currency, and billing cycle.

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
3. If ccusage fails to start or fails validation, the local parser reads every Claude config directory: comma-separated `CLAUDE_CONFIG_DIR`, each `config_dir` in `~/.claude-subs/registry.json` (that field only), and the defaults `~/.claude` and `~/.config/claude`. Usage is summed as one `claude-code` source.
4. If local Codex rollouts exist and ccusage did not contribute Codex, they are merged into the profile.
5. If Cursor agent-transcripts or `ai-tracking` exist and ccusage did not contribute Cursor, they are merged (estimated hours; chat text is not read).
6. Plans: it reads the Claude tier in every config directory (`default_claude_ai` is Claude Pro; Max 5× / 20× map to `claude-max-5x` / `claude-ultra`), the `chatgpt_plan_type` JWT claim in `~/.codex/auth.json`, and Cursor `stripeMembershipType` in `state.vscdb`. Old Stripe ids `pro` and `pro_plus` map to `cursor-pro-legacy` and `cursor-pro-plus-legacy`, not Premium or Super. `ultra` stays unmapped until you add a plan. Several Claude profiles can contribute several plans. `--plan` adds to that list. Tokens and email are not uploaded. Prices come from `GET /api/catalog/prices` (names and amounts only). A terminal can confirm or replace them. The request does not send the profile.
7. OpenCode, Kimi (`~/.kimi` and `~/.kimi-code`), and Codex hours that ccusage leaves at 0 are estimated from session timestamps. Gemini CLI (`~/.gemini/tmp`) and Antigravity (`~/.gemini/antigravity`) are included the same way: tokens by family when the file has a usage object, otherwise hours and days only.

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

Three network exits:

- `npx` may download `ccusage@latest` the first time. ccusage is launched with `--offline` so it does not request prices.
- `GET {origin}/api/catalog/prices` for plan names and amounts. The origin is `PICKAGENT_API_URL` or `https://pickagent.dev`. The request body is empty. If it fails, prices are typed in (or passed with `--price`).
- Opening the browser at the verdict URL, after confirmation.

No other HTTP. No database. The profile is not uploaded.

To see those calls on Linux: `strace -f -e trace=network -o /tmp/pickagent.strace npx @pickagent/cli scan --no-open`. `strace` is Linux-only; macOS does not have it. The expected connections are `npx` downloading `ccusage`, and `GET /api/catalog/prices`. With `--no-open` the browser does not open.

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

Without `--json`, a short English summary: period, sources, agent-hours, and the plans with the amounts you confirmed. `--verbose` adds the harness breakdown and notes. It asks before opening the browser (`Open verdict`). The URL is printed only when the browser is not opened. `--yes` accepts the defaults and opens. `--no-open` does not open, and prints the URL. `--json` writes only the profile to stdout (the URL goes to stderr when the browser stays closed). The browser opens only when you also pass `--yes` and not `--no-open`.

The URL is `{base}/es/veredicto` when `LC_ALL`, `LC_MESSAGES`, or `LANG` starts with `es`, and `{base}/en/verdict` otherwise, plus `profileToHash()`. `--lang es` or `--lang en` overrides that. Default base: `https://pickagent.dev`. `/en/veredicto` redirects on the site.

The profile goes through `parseProfile` before use. If it does not match the schema, the issues are printed and the process exits with code 1. With no measurable usage (no hours with a distinct start and end) it also exits with code 1: an empty profile does not fit the schema, because `agent_hours`, `activity`, and `by_model` are required.

## How to audit it

The code is in `src/`. The profile contract (`pickagent.profile/v1`, its parse, its encode, and the step from usage reports to that profile) is in `src/profile/`. esbuild bundles it into `dist/cli.js` together with Zod. There are no runtime dependencies: the published package is that file, this README, and the license.

Search for `fetch(`, `http.request`, `net.connect`, and keys: they should not appear, except the allowlist of variables passed to ccusage. The only external execution is `npx ccusage@latest` and the system `open` / `xdg-open`. On Windows the child does not start `npx.cmd` directly (Node 20.12 or newer rejects that) and the browser URL is quoted. Windows: untested.

On a clean clone: `npm ci && npm run build && node dist/cli.js scan --help && npm test`.

## Why the code is public

The profile is not uploaded. It travels in the `#p=` URL fragment, and the browser does not send the fragment to the server. The repository is public so anyone can check: the scanner does not `fetch` the profile. The only network it opens is `npx` resolving `ccusage`, a `GET /api/catalog/prices` request that sends no profile data (including when `--no-open` is set), and opening the browser. The `src/profile/` schema has no place for conversation text. The verdict page reads that fragment in the browser. The verdict calculation is not in this repository.

## How it is published

No npm token is required. Pushing a tag `vX.Y.Z` whose `X.Y.Z` matches `version` in `package.json` makes GitHub Actions (`.github/workflows/release.yml`) install dependencies, build, run the tests, and publish `@pickagent/cli` with `npm publish --provenance --access public`. Provenance uses GitHub OIDC (`id-token: write`), so the npm package is tied to this repository and that commit.

Before the first tag, the repository must be registered as a trusted publisher of the package on npmjs.com (workflow `release.yml`). A person creates the tag; this repository does not publish itself.
