import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { hashKey } from "./hash";
import type { LimitHit } from "./limit-text";
import {
  addUsage,
  createAggregate,
  type TokenSum,
  type UsageAggregate,
} from "./reports";

/*
 * EXPERIMENTAL. Codex CLI rollout files are documented by third-party
 * readers as ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (CODEX_HOME
 * overrides ~/.codex). This machine had no sessions directory, so the
 * shape is not confirmed here. Enabled only with --codex.
 *
 * A file is read only when its first line is session_meta and
 * payload.originator contains "codex". response_item lines (prompts,
 * tool calls, paths) are not parsed. Token rows use last_token_usage,
 * never the cumulative total. input_tokens includes the cached portion,
 * so non-cached input is input_tokens - cached_input_tokens. There is no
 * cache-write field; callers mark tokens as estimated.
 */

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function codexHomeDir(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.CODEX_HOME?.trim();
  if (!raw) return join(home, ".codex");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return raw;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

function modelOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.startsWith("<") || name.length > 80) return null;
  if (name.startsWith("/") || name.startsWith("~") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  return name;
}

function isCodexFile(line: string): boolean {
  if (!line.includes('"session_meta"')) return false;
  let row: unknown;
  try {
    row = JSON.parse(line) as unknown;
  } catch {
    return false;
  }
  if (!isDict(row) || row.type !== "session_meta" || !isDict(row.payload)) {
    return false;
  }
  const originator = row.payload.originator;
  return typeof originator === "string" && originator.toLowerCase().includes("codex");
}

function waitFromReset(at: number, resetsSec: number): number | null {
  const hours = Math.round((resetsSec * 1000 - at) / 3_600_000);
  if (hours > 168) return null;
  if (hours < 0) return hours >= -1 ? 0 : null;
  return hours;
}

function hitFromLimits(limits: Dict, at: number): LimitHit | null {
  const reached = limits.rate_limit_reached_type;
  if (typeof reached !== "string" || reached.length === 0) return null;
  let resets: number | null = null;
  for (const key of ["primary", "secondary"]) {
    const window = limits[key];
    if (
      isDict(window) &&
      typeof window.resets_at === "number" &&
      Number.isFinite(window.resets_at)
    ) {
      resets = window.resets_at;
      break;
    }
  }
  return { at, waitHours: resets == null ? null : waitFromReset(at, resets) };
}

function takeLine(
  line: string,
  state: { model: string },
  agg: UsageAggregate,
  session: string,
  bounds: { start: number; end: number },
  offsetMinutes: number,
) {
  // Prompts and tool arguments live on response_item lines. Do not parse them.
  if (line.includes('"response_item"')) return;
  if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return;
  let row: unknown;
  try {
    row = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!isDict(row) || !isDict(row.payload)) return;
  const at = Date.parse(typeof row.timestamp === "string" ? row.timestamp : "");
  if (row.type === "turn_context") {
    const model = modelOf(row.payload.model);
    if (model) state.model = model;
    return;
  }
  if (row.type !== "event_msg" || row.payload.type !== "token_count") return;
  if (Number.isNaN(at) || at < bounds.start || at >= bounds.end) return;
  const info = isDict(row.payload.info) ? row.payload.info : null;
  const last = info && isDict(info.last_token_usage) ? info.last_token_usage : null;
  const model = state.model;
  if (last && model) {
    const cached = count(last.cached_input_tokens);
    const tokens: TokenSum = {
      input: Math.max(0, count(last.input_tokens) - cached),
      output: count(last.output_tokens) + count(last.reasoning_output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
    };
    addUsage(agg, { session, at, model, tokens }, offsetMinutes);
  }
  if (isDict(row.payload.rate_limits)) {
    const hit = hitFromLimits(row.payload.rate_limits, at);
    if (hit && !agg.hits.some((prev) => prev.at === hit.at)) agg.hits.push(hit);
  }
}

async function readRollout(
  file: string,
  agg: UsageAggregate,
  bounds: { start: number; end: number },
  offsetMinutes: number,
) {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const state = { model: "" };
  const session = hashKey(file);
  let confirmed: boolean | null = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (confirmed == null) {
        confirmed = isCodexFile(line);
        if (!confirmed) return;
        let row: unknown;
        try {
          row = JSON.parse(line) as unknown;
        } catch {
          return;
        }
        if (isDict(row) && isDict(row.payload)) {
          const model = modelOf(row.payload.model);
          if (model) state.model = model;
        }
        continue;
      }
      takeLine(line, state, agg, session, bounds, offsetMinutes);
    }
  } catch {
    // Skip an unreadable rollout. The path is not reported.
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function walkRollouts(
  dir: string,
  depth: number,
  visit: (file: string) => Promise<void>,
) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkRollouts(path, depth + 1, visit);
    else if (
      entry.isFile() &&
      entry.name.startsWith("rollout-") &&
      entry.name.endsWith(".jsonl")
    ) {
      await visit(path);
    }
  }
}

export async function readCodexLogs(
  home: string,
  bounds: { start: number; end: number },
  offsetMinutes: number,
): Promise<UsageAggregate> {
  const agg = createAggregate();
  for (const sub of ["sessions", "archived_sessions"]) {
    await walkRollouts(join(home, sub), 0, (file) =>
      readRollout(file, agg, bounds, offsetMinutes),
    );
  }
  return agg;
}
