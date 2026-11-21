import type { PriceSpec } from "./price-spec";
import { parsePriceSpec } from "./price-spec";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PLAN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_MS = 86_400_000;

export const DEFAULT_BASE_URL = "https://pickagent.dev";

export const HELP = `pickagent scan — measured profile, on your machine

Reads usage from every agent ccusage detects (Claude Code, Codex,
OpenCode, Gemini CLI, Copilot, …), builds a profile with totals and a
per-harness breakdown (\`by_source\`), and opens the verdict. The profile
travels in the URL fragment; it is not uploaded.

In a terminal it asks which accounts to scan, which plans you pay for,
and confirms each price from GET /api/catalog/prices. Answers are saved
in ~/.pickagent/scanner.json. --yes accepts the defaults: every account,
last time's plans and prices when they exist, catalog prices, and opening
the verdict. Without a terminal, with --json, or when an agent runs the
command, it does not prompt. It keeps detected plans, adds every --plan,
and applies every --price.

Usage
  pickagent scan [options]

Options
  --period YYYY-MM     Calendar month. Default: the current local month.
  --days N             Last N days, including today (1–366).
  --plan SLUG          Plan you pay for. Repeatable. Added to detected plans.
                       E.g. claude-pro.
  --price SPEC         Declared price. Repeatable.
                       SPEC is <planId>=<amount><EUR|USD>[/mo|/yr]
                       e.g. cursor-super=107.80EUR/mo
  --base-url URL       Verdict origin. Default ${DEFAULT_BASE_URL}.
  --lang es|en         Verdict language. Default: es when LC_ALL, LC_MESSAGES,
                       or LANG starts with es; otherwise en.
  --json               Write only the JSON profile to stdout. No prompts.
  --yes                Accept the defaults and open the browser.
  --no-open            Do not open the browser. The URL is printed.
  --verbose            Print the harness breakdown and notes.
  --codex              Codex only (local rollouts; experimental).
  --help               This help.

PICKAGENT_API_URL overrides the catalog origin (default ${DEFAULT_BASE_URL}).
If that request fails, a terminal asks for the amount. PICKAGENT_AGENT=1
skips prompts, as do CI, Cursor Agent, Claude Code, and Codex.

By default every detected harness is merged. --codex limits the read
to Codex.
`;

export type ScanArgs = {
  period: string;
  plans: string[];
  json: boolean;
  yes: boolean;
  noOpen: boolean;
  baseUrl: string;
  /** null: choose from LC_ALL / LC_MESSAGES / LANG at run time. */
  lang: "es" | "en" | null;
  codex: boolean;
  verbose: boolean;
  /** Declared prices from repeatable `--price`. Later flags win. */
  prices: PriceSpec[];
};

export type ParsedArgs =
  | { ok: true; help: true }
  | { ok: true; help: false; args: ScanArgs }
  | { ok: false; error: string };

export function localOffsetMinutes(now: Date): number {
  return -now.getTimezoneOffset();
}

export function currentMonth(now: Date, offsetMinutes: number): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 7);
}

export function periodFromDays(
  days: number,
  now: Date,
  offsetMinutes: number,
): string {
  const end = new Date(now.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return `${start}/${end}`;
}

function isoDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

export function periodRange(period: string): { since: string; until: string } | null {
  const month = MONTH_RE.exec(period);
  if (month) {
    const last = new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate();
    return {
      since: `${period}-01`,
      until: `${period}-${String(last).padStart(2, "0")}`,
    };
  }
  const range = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (!range || !isoDay(range[1]) || !isoDay(range[2]) || range[1] > range[2]) {
    return null;
  }
  return { since: range[1], until: range[2] };
}

/** Inclusive local start and exclusive local end, as UTC milliseconds. */
export function boundsOf(
  period: string,
  offsetMinutes: number,
): { start: number; end: number } | null {
  const range = periodRange(period);
  if (!range) return null;
  const start = Date.parse(`${range.since}T00:00:00Z`) - offsetMinutes * 60_000;
  const end =
    Date.parse(`${range.until}T00:00:00Z`) + DAY_MS - offsetMinutes * 60_000;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return { start, end };
}

export function normalizeBaseUrl(input: string): string | null {
  if (input.includes("\n") || input.includes("\r")) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function parseDays(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= 366 ? days : null;
}

export function parseArgs(
  argv: string[],
  now: Date,
  offsetMinutes: number,
): ParsedArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { ok: true, help: true };
  }
  if (argv[0] !== "scan") {
    return {
      ok: false,
      error: `unknown command "${argv[0]}". Use: pickagent scan`,
    };
  }
  const rest = argv.slice(1);
  let period: string | null = null;
  let days: number | null = null;
  const plans: string[] = [];
  let json = false;
  let yes = false;
  let noOpen = false;
  let baseUrl = DEFAULT_BASE_URL;
  let lang: "es" | "en" | null = null;
  let codex = false;
  let verbose = false;
  const prices: PriceSpec[] = [];

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] ?? "";
    const take = (): string | null => {
      const value = rest[i + 1];
      if (value == null || value.startsWith("--")) return null;
      i += 1;
      return value;
    };
    if (flag === "--help" || flag === "-h") return { ok: true, help: true };
    else if (flag === "--json") json = true;
    else if (flag === "--yes") yes = true;
    else if (flag === "--no-open") noOpen = true;
    else if (flag === "--codex") codex = true;
    else if (flag === "--verbose") verbose = true;
    else if (flag === "--lang") {
      const value = take()?.toLowerCase();
      if (value !== "es" && value !== "en") {
        return { ok: false, error: "--lang expects es or en." };
      }
      lang = value;
    }
    else if (flag === "--period") {
      const value = take();
      if (!value || !MONTH_RE.test(value)) {
        return { ok: false, error: "--period expects YYYY-MM." };
      }
      period = value;
    } else if (flag === "--days") {
      const value = take();
      const parsed = value ? parseDays(value) : null;
      if (parsed == null) return { ok: false, error: "--days expects an integer from 1 to 366." };
      days = parsed;
    } else if (flag === "--plan") {
      const value = take();
      if (!value || !PLAN_RE.test(value) || value.length > 48) {
        return { ok: false, error: "--plan expects a lowercase slug, such as claude-pro." };
      }
      plans.push(value);
    } else if (flag === "--price") {
      const value = take();
      const price = value ? parsePriceSpec(value) : null;
      if (!price) {
        return {
          ok: false,
          error:
            "--price expects <planId>=<amount><EUR|USD>[/mo|/yr], such as cursor-super=107.80EUR/mo.",
        };
      }
      prices.push(price);
    } else if (flag === "--base-url") {
      const value = take();
      const base = value ? normalizeBaseUrl(value) : null;
      if (!base) return { ok: false, error: "--base-url expects an http(s) URL." };
      baseUrl = base;
    } else {
      return { ok: false, error: `unknown option "${flag}".` };
    }
  }

  if (period && days != null) {
    return { ok: false, error: "Use --period or --days, not both." };
  }
  if (plans.length > 10) return { ok: false, error: "At most 10 plans." };

  const resolved =
    period ??
    (days != null ? periodFromDays(days, now, offsetMinutes) : currentMonth(now, offsetMinutes));
  return {
    ok: true,
    help: false,
    args: {
      period: resolved,
      plans,
      json,
      yes,
      noOpen,
      baseUrl,
      lang,
      codex,
      verbose,
      prices,
    },
  };
}

export type VerdictLang = "es" | "en";

/** Spanish locales open /es/veredicto. Anything else opens /en/verdict. */
/**
 * True when a coding agent or CI is driving the process.
 * Those runs get flags, not prompts.
 */
export function isAgentEnv(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PICKAGENT_AGENT?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (env.CI === "true" || env.CI === "1") return true;
  if (env.CURSOR_AGENT?.trim()) return true;
  if (env.CLAUDECODE === "1") return true;
  if (env.CODEX_SANDBOX === "1") return true;
  if (env.CODEX_THREAD_ID?.trim()) return true;
  return false;
}

export function verdictLangFromEnv(env: NodeJS.ProcessEnv): VerdictLang {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return raw.trim().toLowerCase().startsWith("es") ? "es" : "en";
}

export function verdictPath(lang: VerdictLang): string {
  return lang === "es" ? "/es/veredicto" : "/en/verdict";
}

export function verdictUrl(baseUrl: string, hash: string, lang: VerdictLang = "en"): string {
  return `${baseUrl.replace(/\/+$/, "")}${verdictPath(lang)}${hash}`;
}
