import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexHomeDir, readCodexLogs } from "./codex-rollout";
import { querySqliteStrings } from "./cursor-sqlite";
import {
  modelFamily,
  type ModelFamily,
  type Source,
} from "./profile/ids";
import {
  METRIC_KEYS,
  parseProfile,
  periodDays,
  type Profile,
  type TokenRow,
} from "./profile/profile";
import { dominantSource } from "./profile/merge-sources";
import { localDay, type UsageAggregate } from "./reports";

/*
 * Hours for harnesses whose daily report has active days but no session
 * length. Timestamps only: no message text, paths, or project names.
 * Every hour from this module is estimated.
 */

const MIN_MS = 60_000;
const CAP_MS = 8 * 3_600_000;

export type HourFill = {
  source: Source;
  hours: number;
  activeDays: number;
  sessions: number;
  tokens?: TokenRow[];
};

type Bounds = { start: number; end: number };
type Span = { start: number; end: number };

const round1 = (n: number) => Math.round(n * 10) / 10;

function roundHours(ms: number): number {
  const hours = ms / 3_600_000;
  return hours > 0 ? Math.max(0.1, round1(hours)) : 0;
}

export function summarizeSpans(
  spans: Span[],
  bounds: Bounds,
  offsetMinutes: number,
): { hours: number; activeDays: number; sessions: number } {
  const days = new Set<string>();
  let ms = 0;
  let sessions = 0;
  for (const span of spans) {
    const start = Math.max(bounds.start, Math.min(span.start, span.end));
    const end = Math.min(bounds.end, Math.max(span.start, span.end));
    if (!(end >= bounds.start && start < bounds.end)) continue;
    if (end < start) continue;
    const overlap = Math.max(0, end - start);
    let duration = overlap;
    if (duration < MIN_MS) duration = MIN_MS;
    if (duration > CAP_MS) duration = CAP_MS;
    ms += duration;
    sessions += 1;
    const last = Math.min(bounds.end - 1, start + duration - 1);
    for (let t = start; t <= last; t += 3_600_000) {
      days.add(localDay(t, offsetMinutes));
      if (days.size > 400) break;
    }
    days.add(localDay(last, offsetMinutes));
  }
  return { hours: roundHours(ms), activeDays: days.size, sessions };
}

function safeModel(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 80 || name.startsWith("<")) return null;
  if (name.startsWith("/") || name.startsWith("~") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  return name;
}

function addFamily(
  into: Map<ModelFamily, TokenRow>,
  model: string,
  part: { input: number; output: number; cache_read: number; cache_write: number },
) {
  const family = modelFamily(model);
  const prev = into.get(family) ?? {
    model: family,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };
  prev.input += part.input;
  prev.output += part.output;
  prev.cache_read += part.cache_read;
  prev.cache_write += part.cache_write;
  into.set(family, prev);
}

function rowsOf(map: Map<ModelFamily, TokenRow>): TokenRow[] | undefined {
  const rows = [...map.values()]
    .map((row) => ({
      ...row,
      input: Math.round(row.input),
      output: Math.round(row.output),
      cache_read: Math.round(row.cache_read),
      cache_write: Math.round(row.cache_write),
    }))
    .filter((row) => row.input + row.output + row.cache_read + row.cache_write > 0);
  return rows.length ? rows : undefined;
}

export function kimiHomes(home: string): string[] {
  return [join(home, ".kimi-code"), join(home, ".kimi")];
}

function epochField(text: string, key: string): number | null {
  const match = new RegExp(`"${key}"\\s*:\\s*(\\d{10,16})`).exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

async function walkFiles(
  dir: string,
  depth: number,
  visit: (file: string) => Promise<void>,
  accept: (name: string) => boolean,
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
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "skills") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(path, depth + 1, visit, accept);
    else if (entry.isFile() && accept(entry.name)) await visit(path);
  }
}

export async function readKimiFill(
  home: string,
  bounds: Bounds,
  offsetMinutes: number,
): Promise<HourFill | null> {
  const spans: Span[] = [];
  for (const root of kimiHomes(home)) {
    await walkFiles(join(root, "sessions"), 0, async (file) => {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return;
      }
      const created = epochField(text, "createdAt");
      const updated = epochField(text, "updatedAt");
      if (created == null || updated == null) return;
      spans.push({ start: Math.min(created, updated), end: Math.max(created, updated) });
    }, (name) => name === "state.json");
  }
  const stats = summarizeSpans(spans, bounds, offsetMinutes);
  if (stats.hours <= 0 && stats.activeDays <= 0) return null;
  return { source: "kimi-cli", ...stats };
}

export async function readOpenCodeFill(
  home: string,
  bounds: Bounds,
  offsetMinutes: number,
): Promise<HourFill | null> {
  const db = join(home, ".local", "share", "opencode", "opencode.db");
  const sql = `
SELECT time_created, time_updated,
  COALESCE(tokens_input, 0), COALESCE(tokens_output, 0),
  COALESCE(tokens_reasoning, 0), COALESCE(tokens_cache_read, 0),
  COALESCE(tokens_cache_write, 0), COALESCE(model, '')
FROM session_v2
WHERE time_created < ${Math.floor(bounds.end)}
  AND time_updated >= ${Math.floor(bounds.start)}
`.trim();
  let rows = await querySqliteStrings(db, sql);
  let withModel = true;
  if (!rows) {
    withModel = false;
    rows = await querySqliteStrings(
      db,
      `SELECT time_created, time_updated FROM session
       WHERE time_created < ${Math.floor(bounds.end)}
         AND time_updated >= ${Math.floor(bounds.start)}`,
    );
  }
  if (!rows?.length) return null;
  const spans: Span[] = [];
  const tokens = new Map<ModelFamily, TokenRow>();
  for (const row of rows) {
    const created = Number(row[0]);
    const updated = Number(row[1]);
    if (!Number.isFinite(created) || !Number.isFinite(updated)) continue;
    spans.push({ start: Math.min(created, updated), end: Math.max(created, updated) });
    if (!withModel) continue;
    const model = safeModel(row[7] ?? "");
    if (!model) continue;
    const reasoning = Number(row[4]) || 0;
    addFamily(tokens, model, {
      input: Number(row[2]) || 0,
      output: (Number(row[3]) || 0) + reasoning,
      cache_read: Number(row[5]) || 0,
      cache_write: Number(row[6]) || 0,
    });
  }
  const stats = summarizeSpans(spans, bounds, offsetMinutes);
  if (stats.hours <= 0) return null;
  return { source: "opencode", ...stats, tokens: rowsOf(tokens) };
}

export async function readCodexHourFill(
  env: NodeJS.ProcessEnv,
  home: string,
  bounds: Bounds,
  offsetMinutes: number,
): Promise<HourFill | null> {
  const logs = await readCodexLogs(codexHomeDir(env, home), bounds, offsetMinutes);
  const fromUsage = summarizeSpans(spansOf(logs), bounds, offsetMinutes);
  const stats =
    fromUsage.hours > 0
      ? fromUsage
      : summarizeSpans(await codexFileSpans(codexHomeDir(env, home)), bounds, offsetMinutes);
  if (stats.hours <= 0) return null;
  return { source: "codex", ...stats };
}

function spansOf(logs: UsageAggregate): Span[] {
  return [...logs.sessions.values()].map((session) => ({
    start: session.start,
    end: session.end,
  }));
}

async function codexFileSpans(home: string): Promise<Span[]> {
  const spans: Span[] = [];
  const files: string[] = [];
  for (const sub of ["sessions", "archived_sessions"]) {
    await walkFiles(join(home, sub), 0, async (file) => {
      files.push(file);
    }, (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
  }
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const line of text.split("\n")) {
      if (!line.includes('"timestamp"') || line.includes('"response_item"')) continue;
      const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      if (!match) continue;
      const at = Date.parse(match[1]!);
      if (Number.isNaN(at)) continue;
      if (at < min) min = at;
      if (at > max) max = at;
    }
    if (max > min) spans.push({ start: min, end: max });
  }
  return spans;
}

export async function readGeminiFill(
  home: string,
  bounds: Bounds,
  offsetMinutes: number,
): Promise<HourFill | null> {
  const root = join(home, ".gemini", "tmp");
  const spans: Span[] = [];
  const tokens = new Map<ModelFamily, TokenRow>();
  await walkFiles(root, 0, async (file) => {
    const lower = file.toLowerCase();
    if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
      await geminiFile(file, spans, tokens);
      return;
    }
    const clock = await fileSpan(file);
    if (clock) spans.push(clock);
  }, (name) => {
    if (name === "projects.json" || name.startsWith("settings")) return false;
    return name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".log");
  });
  const stats = summarizeSpans(spans, bounds, offsetMinutes);
  if (stats.hours <= 0 && stats.activeDays <= 0) return null;
  return { source: "gemini-cli", ...stats, tokens: rowsOf(tokens) };
}

async function geminiFile(
  file: string,
  spans: Span[],
  tokens: Map<ModelFamily, TokenRow>,
) {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  const times: number[] = [];
  const takeTime = (raw: string) => {
    const at = /^\d{10,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isNaN(at) && at > 1_000_000_000_000) times.push(at);
    else if (!Number.isNaN(at) && at > 1_000_000_000) times.push(at * 1000);
  };
  for (const match of text.matchAll(/"(?:timestamp|createdAt|updatedAt|startTime|endTime|firstActivity|lastActivity)"\s*:\s*"?([^",}\s]+)"?/g)) {
    takeTime(match[1] ?? "");
  }
  const usage = /"(?:usage|tokens)"\s*:\s*\{([^}]{0,400})\}/.exec(text);
  if (usage) {
    const body = usage[1] ?? "";
    const num = (key: string) => {
      const found = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(body);
      return found ? Number(found[1]) : 0;
    };
    const modelMatch = /"(?:model|modelName|modelId)"\s*:\s*"([^"]+)"/.exec(text);
    const model = modelMatch ? safeModel(modelMatch[1] ?? "") : null;
    if (model) {
      addFamily(tokens, model, {
        input: num("input") || num("inputTokens") || num("input_tokens"),
        output: num("output") || num("outputTokens") || num("output_tokens"),
        cache_read: num("cacheRead") || num("cache_read") || num("cacheReadTokens"),
        cache_write: num("cacheWrite") || num("cache_write") || num("cacheCreationTokens"),
      });
    }
  }
  if (times.length >= 1) {
    const start = Math.min(...times);
    const end = Math.max(...times);
    spans.push({ start, end: end > start ? end : start + MIN_MS });
    return;
  }
  const clock = await fileSpan(file);
  if (clock) spans.push(clock);
}

async function fileSpan(file: string): Promise<Span | null> {
  try {
    const st = await stat(file);
    if (st.size <= 0) return null;
    const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    const start = Math.min(birth, st.mtimeMs);
    const end = Math.max(birth, st.mtimeMs);
    return { start, end: end > start ? end : start + MIN_MS };
  } catch {
    return null;
  }
}

export async function readAntigravityFill(
  home: string,
  bounds: Bounds,
  offsetMinutes: number,
): Promise<HourFill | null> {
  const root = join(home, ".gemini", "antigravity");
  const spans: Span[] = [];
  for (const sub of ["conversations", "implicit"]) {
    await walkFiles(join(root, sub), 0, async (file) => {
      const clock = await fileSpan(file);
      if (clock) spans.push(clock);
    }, (name) => name.endsWith(".pb") || name.endsWith(".json"));
  }
  const stats = summarizeSpans(spans, bounds, offsetMinutes);
  if (stats.hours <= 0 && stats.activeDays <= 0) return null;
  return { source: "antigravity", ...stats };
}

function sharesOf(rows: TokenRow[]): Profile["by_model"]["value"] {
  const work = (row: TokenRow) => row.input + row.output + row.cache_write;
  const total = rows.reduce((sum, row) => sum + work(row), 0);
  const value: Profile["by_model"]["value"] = {};
  if (total <= 0) return value;
  for (const row of rows) {
    value[row.model] = Math.round((work(row) / total) * 1000) / 1000;
  }
  const entries = Object.entries(value) as [ModelFamily, number][];
  if (!entries.length) return value;
  const largest = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const drift = 1 - entries.reduce((sum, [, v]) => sum + v, 0);
  value[largest[0]] = Math.round(((value[largest[0]] ?? 0) + drift) * 1000) / 1000;
  return value;
}

function mergeTokens(profile: Profile, extra: TokenRow[], source: Source): Profile {
  const map = new Map<ModelFamily, TokenRow>();
  for (const row of profile.tokens?.value ?? []) map.set(row.model, { ...row });
  for (const row of extra) {
    const prev = map.get(row.model) ?? {
      model: row.model,
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    };
    prev.input += row.input;
    prev.output += row.output;
    prev.cache_read += row.cache_read;
    prev.cache_write += row.cache_write;
    map.set(row.model, prev);
  }
  const rows = [...map.values()];
  if (!rows.length) return profile;
  const next: Profile = {
    ...profile,
    tokens: { value: rows, provenance: "estimated", source },
    by_model: { value: sharesOf(rows), provenance: "estimated", source },
  };
  if (!next.models_count || rows.length > next.models_count.value) {
    next.models_count = { value: rows.length, provenance: "estimated", source };
  }
  return next;
}

/**
 * Fills estimated hours where a harness has none. Tokens are added only
 * when that harness was missing, so a ccusage slice is not counted twice.
 */
export function applyHourFills(profile: Profile, fills: HourFill[]): Profile {
  const useful = fills.filter((fill) => fill.hours > 0);
  if (!useful.length) return profile;
  let next: Profile = profile;
  for (const fill of useful) {
    const prev = next.by_source?.[fill.source];
    if (prev && prev.agent_hours > 0) continue;
    const by_source = { ...(next.by_source ?? {}) };
    const dayCap = periodDays(next.period) ?? 366;
    by_source[fill.source] = {
      agent_hours: fill.hours,
      provenance: "estimated",
      active_days:
        Math.min(dayCap, Math.max(prev?.active_days ?? 0, fill.activeDays)) ||
        undefined,
      sessions: fill.sessions > 0 ? fill.sessions : prev?.sessions,
      plan: prev?.plan,
    };
    const provenance = { ...next.provenance };
    // These hours are clocks, not a measured log. A 0-hour ccusage
    // placeholder must not stay "measured" and become the primary source.
    provenance[fill.source] = "estimated";
    const agent_hours = {
      ...next.agent_hours,
      value: round1(next.agent_hours.value + fill.hours),
      provenance: "estimated" as const,
    };
    const draft: Profile = { ...next, by_source, provenance, agent_hours };
    const days = Math.min(fill.activeDays, dayCap);
    if (days > (next.active_days?.value ?? 0)) {
      draft.active_days = {
        value: days,
        provenance: "estimated",
        source: next.active_days?.source ?? fill.source,
      };
    }
    next = draft;
    if (!prev && fill.tokens?.length) next = mergeTokens(next, fill.tokens, fill.source);
  }
  const dominant = dominantSource(next.by_source ?? {}, next.provenance);
  const labeled: Profile = { ...next };
  if (labeled.agent_hours.source !== dominant) {
    labeled.agent_hours = { ...labeled.agent_hours, source: dominant };
  }
  if (labeled.activity) labeled.activity = { ...labeled.activity, source: dominant };
  if (labeled.by_model) labeled.by_model = { ...labeled.by_model, source: dominant };
  if (labeled.active_days) labeled.active_days = { ...labeled.active_days, source: dominant };
  if (labeled.sessions && labeled.sessions.provenance === "measured") {
    labeled.sessions = { ...labeled.sessions, source: dominant };
  }
  if (labeled.tokens && next.tokens?.provenance === "estimated" && !profile.tokens) {
    labeled.tokens = { ...labeled.tokens, source: dominant };
  }
  if (labeled.models_count) labeled.models_count = { ...labeled.models_count, source: dominant };
  for (const key of METRIC_KEYS) {
    const metric = labeled[key];
    if (!metric) continue;
    if (labeled.provenance[metric.source] !== "estimated") continue;
    if (metric.provenance !== "measured") continue;
    const dominantMethod = labeled.provenance[dominant];
    labeled[key] =
      dominantMethod === "measured"
        ? { ...metric, source: dominant }
        : { ...metric, source: dominant, provenance: "estimated" };
  }
  const parsed = parseProfile(labeled);
  return parsed.ok ? parsed.profile : profile;
}
