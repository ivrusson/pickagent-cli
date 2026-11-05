import { spawn } from "node:child_process";
import type { CcusageReports } from "../../../src/lib/engine/ccusage";

/*
 * ccusage 20's plain `daily` and `session` commands aggregate every agent.
 * Claude Code is the focused form `ccusage claude daily|session`. `blocks`
 * is the Claude 5-hour window report and has no source prefix.
 * Flags checked against ccusage docs (guide/cli-options, guide/claude):
 *   --json --breakdown --no-cost --offline --since --until --timezone
 * --since/--until accept YYYY-MM-DD and are inclusive. --offline keeps
 * ccusage off the pricing network. npx itself may download the package.
 */

const TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
] as const;

const TIME_KEYS = [
  "date",
  "period",
  "firstActivity",
  "lastActivity",
  "startTime",
  "endTime",
  "blockStart",
  "blockEnd",
  "actualEndTime",
] as const;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function ccusageArgv(
  report: "daily" | "session" | "blocks",
  since: string,
  until: string,
  timeZone: string | null,
): string[] {
  const args = ["--yes", "ccusage@latest"];
  if (report === "blocks") args.push("blocks");
  else args.push("claude", report);
  args.push("--json", "--no-cost", "--offline", "--since", since, "--until", until);
  if (timeZone) args.push("--timezone", timeZone);
  if (report !== "blocks") args.push("--breakdown");
  return args;
}

export function systemTimeZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || !/^[A-Za-z0-9_+/.-]{1,64}$/.test(zone)) return null;
  return zone;
}

/** Drops project names, paths, session ids and message text from a report. */
export function modelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.startsWith("<") || name.length > 80) return null;
  if (
    name.startsWith("/") ||
    name.startsWith("~") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    return null;
  }
  return name;
}

function stamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && value.length <= 40) {
    return value;
  }
  return null;
}

function tokenFields(row: Dict): Dict {
  const out: Dict = {};
  for (const key of TOKEN_KEYS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeBreakdownItem(row: Dict): Dict | null {
  const name = modelName(row.modelName ?? row.model);
  if (!name) return null;
  return { modelName: name, ...tokenFields(row) };
}

function sanitizeRow(row: Dict): Dict {
  const out: Dict = {};
  for (const key of TIME_KEYS) {
    const value = stamp(row[key]);
    if (value) out[key] = value;
  }
  Object.assign(out, tokenFields(row));
  if (row.isGap === true || row.isGap === false) out.isGap = row.isGap;
  if (row.isActive === true || row.isActive === false) out.isActive = row.isActive;
  for (const key of ["modelsUsed", "models"] as const) {
    if (!Array.isArray(row[key])) continue;
    const names = row[key].map(modelName).filter((name) => name != null);
    if (names.length) out[key] = names;
  }
  if (Array.isArray(row.modelBreakdowns)) {
    const items = row.modelBreakdowns.filter(isDict).flatMap((item) => {
      const clean = sanitizeBreakdownItem(item);
      return clean ? [clean] : [];
    });
    if (items.length) out.modelBreakdowns = items;
  }
  if (isDict(row.breakdown)) {
    const map: Dict = {};
    for (const [key, value] of Object.entries(row.breakdown)) {
      const name = modelName(key);
      if (name && isDict(value)) map[name] = tokenFields(value);
    }
    if (Object.keys(map).length) out.breakdown = map;
  }
  if (isDict(row.tokenCounts)) out.tokenCounts = tokenFields(row.tokenCounts);
  return out;
}

function rowsFrom(report: unknown): Dict[] {
  if (Array.isArray(report)) return report.filter(isDict);
  if (!isDict(report)) return [];
  for (const key of ["daily", "sessions", "session", "blocks", "data"]) {
    if (Array.isArray(report[key])) return report[key].filter(isDict);
  }
  if (isDict(report.projects)) {
    return Object.values(report.projects).flatMap((value) =>
      Array.isArray(value) ? value.filter(isDict) : [],
    );
  }
  return [];
}

function sanitizeReport(report: unknown, key: string): unknown {
  const rows = rowsFrom(report).map(sanitizeRow);
  if (isDict(report) && Array.isArray(report.data)) {
    const type = report.type === "daily" || report.type === "session" || report.type === "blocks"
      ? report.type
      : key;
    return { type, data: rows };
  }
  return { [key]: rows };
}

export function sanitizeReports(reports: CcusageReports): CcusageReports {
  return {
    daily: reports.daily == null ? undefined : sanitizeReport(reports.daily, "daily"),
    sessions:
      reports.sessions == null ? undefined : sanitizeReport(reports.sessions, "sessions"),
    blocks: reports.blocks == null ? undefined : sanitizeReport(reports.blocks, "blocks"),
  };
}

const API_KEY_ENV = [
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^CLAUDE_API/i,
  /^GEMINI_/i,
  /^GOOGLE_API/i,
  /^AWS_SECRET/i,
  /^AWS_ACCESS_KEY/i,
  /^AZURE_OPENAI/i,
];

export function envForCcusage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, LOG_LEVEL: "0" };
  for (const key of Object.keys(next)) {
    if (API_KEY_ENV.some((pattern) => pattern.test(key))) delete next[key];
  }
  return next;
}

export type CommandOutput =
  | { ok: true; stdout: string }
  | { ok: false; reason: "spawn" | "timeout" | "exit" | "too_big" };

const MAX_STDOUT = 64 * 1024 * 1024;

export function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "spawn" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: CommandOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT) {
        child.kill();
        finish({ ok: false, reason: "too_big" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish({ ok: false, reason: "spawn" }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: "exit" });
        return;
      }
      finish({ ok: true, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function parseJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

export type CcusageLoad = { failed: boolean; reports: CcusageReports };

export async function loadCcusage(input: {
  since: string;
  until: string;
  timeZone: string | null;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: typeof runCommand;
}): Promise<CcusageLoad> {
  const run = input.run ?? runCommand;
  const env = envForCcusage(input.env);
  const timeoutMs = input.timeoutMs ?? 90_000;
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const reports: CcusageReports = {};
  let ok = 0;
  await Promise.all(
    (["daily", "session", "blocks"] as const).map(async (report) => {
      const result = await run(
        npx,
        ccusageArgv(report, input.since, input.until, input.timeZone),
        env,
        timeoutMs,
      );
      if (!result.ok) return;
      const json = parseJson(result.stdout);
      if (json == null) return;
      ok += 1;
      if (report === "session") reports.sessions = json;
      else reports[report] = json;
    }),
  );
  return { failed: ok === 0, reports: sanitizeReports(reports) };
}
