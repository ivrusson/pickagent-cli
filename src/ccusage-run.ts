import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CcusageReports } from "./profile/ccusage";

/*
 * Unified ccusage reports (`daily` / `session`) include every detected agent.
 * `--by-agent` adds per-agent slices used for `by_source` on the profile.
 * `blocks` remains the Claude 5-hour window report (no agent prefix).
 * Flags: --json --by-agent --breakdown --no-cost --offline --since --until
 * --timezone. Dates are inclusive. --offline skips the pricing network.
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
  const args = ["--yes", "ccusage@latest", report];
  args.push("--json", "--no-cost", "--offline", "--since", since, "--until", until);
  if (timeZone) args.push("--timezone", timeZone);
  if (report !== "blocks") {
    args.push("--breakdown", "--by-agent");
  }
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

function agentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name || name.length > 40) return null;
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return null;
  return name;
}

function sanitizeAgentSlice(row: Dict): Dict | null {
  const name = agentId(row.agent);
  if (!name) return null;
  const out: Dict = { agent: name, ...tokenFields(row) };
  for (const key of ["modelsUsed", "models"] as const) {
    if (!Array.isArray(row[key])) continue;
    const names = row[key].map(modelName).filter((n) => n != null);
    if (names.length) out[key] = names;
  }
  if (Array.isArray(row.modelBreakdowns)) {
    const items = row.modelBreakdowns.filter(isDict).flatMap((item) => {
      const clean = sanitizeBreakdownItem(item);
      return clean ? [clean] : [];
    });
    if (items.length) out.modelBreakdowns = items;
  }
  if (isDict(row.tokenCounts)) out.tokenCounts = tokenFields(row.tokenCounts);
  return out;
}

function sanitizeRow(row: Dict): Dict {
  const out: Dict = {};
  for (const key of TIME_KEYS) {
    const value = stamp(row[key]);
    if (value) out[key] = value;
  }
  Object.assign(out, tokenFields(row));
  const agent = agentId(row.agent);
  if (agent) out.agent = agent;
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
  if (Array.isArray(row.agents)) {
    const agents = row.agents.filter(isDict).flatMap((item) => {
      const clean = sanitizeAgentSlice(item);
      return clean ? [clean] : [];
    });
    if (agents.length) out.agents = agents;
  }
  if (isDict(row.metadata) && Array.isArray(row.metadata.agents)) {
    const names = row.metadata.agents
      .map(agentId)
      .filter((name): name is string => name != null);
    if (names.length) out.metadata = { agents: names };
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

/**
 * Names copied into the ccusage child, compared case-insensitively.
 * `LANG` is exact. `LC_*` is allowed separately. Anything ending in
 * `_TOKEN`, `_KEY` or `_SECRET`, and any `npm_config_*auth*`, is dropped
 * even if the name would otherwise match.
 */
const CCUSAGE_ENV_ALLOW = new Set(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TZ",
    "LANG",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "npm_config_registry",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "ALL_PROXY",
    "npm_config_proxy",
    "npm_config_https_proxy",
    "npm_config_cafile",
    "npm_config_userconfig",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ].map((key) => key.toLowerCase()),
);

function deniedCcusageEnv(key: string): boolean {
  if (/_(token|key|secret)$/i.test(key)) return true;
  return /^npm_config_.*auth/i.test(key);
}

function allowedCcusageEnv(key: string): boolean {
  if (deniedCcusageEnv(key)) return false;
  const lower = key.toLowerCase();
  if (CCUSAGE_ENV_ALLOW.has(lower)) return true;
  return lower.startsWith("lc_");
}

export function envForCcusage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { LOG_LEVEL: "0" };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (!allowedCcusageEnv(key)) continue;
    next[key] = value;
  }
  return next;
}

export type NpxSpawn = {
  command: string;
  args: string[];
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

/**
 * Quote one argument for a `cmd.exe /c` line. `%` is left alone: `%%` only
 * collapses inside batch files, and the ccusage arguments (dates, flags, an
 * IANA zone) never contain `%`.
 */
export function quoteCmdArg(arg: string): string {
  const clean = arg.replace(/[\r\n]/g, "");
  return `"${clean.replace(/"/g, '""')}"`;
}

/**
 * Node >= 20.12 refuses to spawn `npx.cmd` without a shell (CVE-2024-27980).
 * On Windows, run `node.exe` against `npx-cli.js` so the arguments never
 * reach `cmd.exe`. If that file is missing, fall back to `cmd.exe /c` with
 * each argument quoted.
 */
export function npxCliCandidates(execPath: string): string[] {
  const binDir = path.win32.dirname(execPath);
  return [
    path.win32.join(binDir, "node_modules", "npm", "bin", "npx-cli.js"),
    path.win32.join(binDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    path.win32.join(binDir, "..", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
}

export function resolveNpxCli(
  execPath: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  for (const candidate of npxCliCandidates(execPath)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function buildNpxSpawn(
  npxArgs: string[],
  input: {
    platform: NodeJS.Platform;
    execPath: string;
    npxCliPath: string | null;
  },
): NpxSpawn {
  if (input.platform !== "win32") {
    return { command: "npx", args: npxArgs, shell: false };
  }
  if (input.npxCliPath) {
    return {
      command: input.execPath,
      args: [input.npxCliPath, ...npxArgs],
      shell: false,
    };
  }
  // `cmd /s /c` strips one leading and one trailing quote. The extra pair
  // keeps the quotes around each argument, including ones that contain `&`.
  const commandLine = ["npx.cmd", ...npxArgs].map(quoteCmdArg).join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
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
  options?: { shell?: boolean; windowsVerbatimArguments?: boolean },
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: options?.shell ?? false,
        windowsVerbatimArguments: options?.windowsVerbatimArguments,
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
  const npxCli = process.platform === "win32" ? resolveNpxCli(process.execPath) : null;
  const reports: CcusageReports = {};
  let ok = 0;
  await Promise.all(
    (["daily", "session", "blocks"] as const).map(async (report) => {
      const plan = buildNpxSpawn(
        ccusageArgv(report, input.since, input.until, input.timeZone),
        {
          platform: process.platform,
          execPath: process.execPath,
          npxCliPath: npxCli,
        },
      );
      const result = await run(plan.command, plan.args, env, timeoutMs, {
        shell: plan.shell,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
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
