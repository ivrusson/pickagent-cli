const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PLAN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY_MS = 86_400_000;

export const DEFAULT_BASE_URL = "https://pickagent.dev";

export const HELP = `pickagent scan — perfil medido, en local

Lee el uso de todos los agentes que detecta ccusage (Claude Code, Codex,
OpenCode, Gemini CLI, Copilot, …), construye un perfil con totales y
desglose por harness (\`by_source\`) y abre el veredicto. El perfil viaja
en el fragmento de la URL; no se sube.

Sin --plan, intenta leer el plan local de Claude (~/.claude.json) y de
Codex (claim chatgpt_plan_type en ~/.codex/auth.json) y lo mete en
\`plans\` y en \`by_source.*.plan\`. No llama a la red ni sube tokens.

Uso
  pickagent scan [opciones]

Opciones
  --period YYYY-MM     Mes natural. Por defecto, el mes local en curso.
  --days N             Últimos N días, incluido hoy (1–366).
  --plan SLUG          Plan que pagas hoy. Se puede repetir. Ej. claude-pro.
                       Si lo pasas, sustituye a la detección automática.
  --base-url URL       Origen del veredicto. Por defecto ${DEFAULT_BASE_URL}.
  --json               Escribe solo el perfil JSON en stdout.
  --yes                Abre el navegador sin preguntar.
  --no-open            No abre el navegador.
  --codex              Solo Codex (rollouts locales; experimental).
  --help               Esta ayuda.

Por defecto se mezclan todos los harnesses detectados. --codex limita la
lectura a Codex.
`;

export type ScanArgs = {
  period: string;
  plans: string[];
  json: boolean;
  yes: boolean;
  noOpen: boolean;
  baseUrl: string;
  codex: boolean;
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
      error: `comando desconocido «${argv[0]}». Usa: pickagent scan`,
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
  let codex = false;

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
    else if (flag === "--period") {
      const value = take();
      if (!value || !MONTH_RE.test(value)) {
        return { ok: false, error: "--period espera YYYY-MM." };
      }
      period = value;
    } else if (flag === "--days") {
      const value = take();
      const parsed = value ? parseDays(value) : null;
      if (parsed == null) return { ok: false, error: "--days espera un entero de 1 a 366." };
      days = parsed;
    } else if (flag === "--plan") {
      const value = take();
      if (!value || !PLAN_RE.test(value) || value.length > 48) {
        return { ok: false, error: "--plan espera un slug en minúsculas, como claude-pro." };
      }
      plans.push(value);
    } else if (flag === "--base-url") {
      const value = take();
      const base = value ? normalizeBaseUrl(value) : null;
      if (!base) return { ok: false, error: "--base-url espera una URL http(s)." };
      baseUrl = base;
    } else {
      return { ok: false, error: `opción desconocida «${flag}».` };
    }
  }

  if (period && days != null) {
    return { ok: false, error: "Usa --period o --days, no los dos." };
  }
  if (plans.length > 10) return { ok: false, error: "Como máximo 10 planes." };

  const resolved =
    period ??
    (days != null ? periodFromDays(days, now, offsetMinutes) : currentMonth(now, offsetMinutes));
  return {
    ok: true,
    help: false,
    args: { period: resolved, plans, json, yes, noOpen, baseUrl, codex },
  };
}

export function verdictUrl(baseUrl: string, hash: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/es/veredicto${hash}`;
}
