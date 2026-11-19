import {
  MODEL_FAMILIES,
  modelFamily,
  type ModelFamily,
  type Source,
} from "./ids";
import {
  PROFILE_SCHEMA_ID,
  ProfileSchema,
  estimated,
  measured,
  type MetricKey,
  type Profile,
  type TokenRow,
} from "./profile";

/*
 * Maps ccusage JSON reports (`ccusage daily|session|blocks --json`) into a
 * partial profile marked `measured`. Shapes follow ccusage's docs
 * (docs/guide/json-output.md), which document two layouts per report:
 *   { daily: [...] } / { sessions: [...] } / { blocks: [...] }   (current)
 *   { type: "daily", data: [...] } …                              (older)
 * and aliases between them (date|period, models|modelsUsed,
 * startTime|blockStart, modelBreakdowns|breakdown…). Readers are tolerant and
 * ignore anything they do not know. Project names, paths and session ids are
 * never copied: only numbers, model families and local hours survive.
 * ccusage does not report limit hits, so `blocks` (bloqueos) stays empty.
 */

export type CcusageReports = {
  daily?: unknown;
  sessions?: unknown;
  blocks?: unknown;
};

export type CcusageOptions = {
  /** Period the reports cover (`2026-10` or `2026-10-06/2026-11-04`). */
  period: string;
  source?: Source;
  /** Minutes to add to UTC for local time: `-new Date().getTimezoneOffset()`. */
  utcOffsetMinutes?: number;
  plans?: string[];
};

export type ProfileDraft = Omit<Profile, MetricKey> &
  Partial<Pick<Profile, MetricKey>>;

export type CcusageResult = {
  draft: ProfileDraft;
  /** The draft when it already passes the schema; null otherwise. */
  profile: Profile | null;
  warnings: string[];
};

/** A session spanning more than this is a resumed conversation: capped. */
export const SESSION_CAP_HOURS = 8;

type Dict = Record<string, unknown>;
type Interval = { start: number; end: number };
type Tokens = Omit<TokenRow, "model">;

const HOUR_MS = 3_600_000;

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Rows of a report in any documented layout (project groups flattened). */
function rowsOf(report: unknown, keys: string[]): Dict[] {
  if (Array.isArray(report)) return report.filter(isDict);
  if (!isDict(report)) return [];
  for (const key of keys) {
    if (Array.isArray(report[key]))
      return (report[key] as unknown[]).filter(isDict);
  }
  if (Array.isArray(report.data)) return report.data.filter(isDict);
  if (isDict(report.projects)) {
    return Object.values(report.projects).flatMap((rows) =>
      Array.isArray(rows) ? rows.filter(isDict) : [],
    );
  }
  return [];
}

function tokensOf(row: Dict): Tokens {
  const counts = isDict(row.tokenCounts) ? row.tokenCounts : row;
  return {
    input: num(counts.inputTokens),
    output: num(counts.outputTokens),
    cache_write: num(
      counts.cacheCreationTokens ?? counts.cacheCreationInputTokens,
    ),
    cache_read: num(counts.cacheReadTokens ?? counts.cacheReadInputTokens),
  };
}

function modelNames(row: Dict): string[] {
  const list = row.modelsUsed ?? row.models;
  return Array.isArray(list)
    ? list.filter(
        (m): m is string => typeof m === "string" && !m.startsWith("<"),
      )
    : [];
}

/** Per-model tokens of a row: breakdowns when present, else its only model. */
function breakdownOf(row: Dict): { name: string; tokens: Tokens }[] | null {
  if (Array.isArray(row.modelBreakdowns)) {
    return row.modelBreakdowns.filter(isDict).flatMap((b) => {
      const name = str(b.modelName);
      return name && !name.startsWith("<")
        ? [{ name, tokens: tokensOf(b) }]
        : [];
    });
  }
  if (isDict(row.breakdown)) {
    return Object.entries(row.breakdown).flatMap(([name, b]) =>
      isDict(b) && !name.startsWith("<") ? [{ name, tokens: tokensOf(b) }] : [],
    );
  }
  const names = modelNames(row);
  return names.length === 1
    ? [{ name: names[0], tokens: tokensOf(row) }]
    : null;
}

const work = (t: Tokens) => t.input + t.output + t.cache_write;

function addTokens(
  into: Map<ModelFamily, Tokens>,
  model: ModelFamily,
  t: Tokens,
) {
  const row = into.get(model) ?? {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
  };
  row.input += t.input;
  row.output += t.output;
  row.cache_read += t.cache_read;
  row.cache_write += t.cache_write;
  into.set(model, row);
}

function intervalOf(
  row: Dict,
  startKeys: string[],
  endKeys: string[],
): Interval | null {
  const meta = isDict(row.metadata) ? row.metadata : {};
  const pick = (keys: string[]) =>
    keys.map((k) => str(row[k]) ?? str(meta[k])).find((v) => v != null) ?? null;
  const startText = pick(startKeys);
  const endText = pick(endKeys);
  // Date-only stamps (YYYY-MM-DD) carry no time of day: unusable.
  if (
    !startText ||
    !endText ||
    startText.length <= 10 ||
    endText.length <= 10
  ) {
    return null;
  }
  const start = Date.parse(startText);
  const end = Date.parse(endText);
  // Zero-length spans (a single turn) carry no time to spread.
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return { start, end };
}

/** Spreads intervals over local hour and weekday buckets, in minutes. */
function histograms(intervals: Interval[], offsetMs: number) {
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  for (const { start, end } of intervals) {
    let t = start;
    while (t < end) {
      const next = Math.min(
        end,
        (Math.floor((t + offsetMs) / HOUR_MS) + 1) * HOUR_MS - offsetMs,
      );
      const local = new Date(t + offsetMs);
      const minutes = (next - t) / 60_000;
      hours[local.getUTCHours()] += minutes;
      weekdays[(local.getUTCDay() + 6) % 7] += minutes;
      t = next;
    }
  }
  return { hours: hours.map(Math.round), weekdays: weekdays.map(Math.round) };
}

/** Time-weighted median of how many intervals overlap, over active time. */
function medianConcurrency(intervals: Interval[]): number | null {
  const events = intervals
    .flatMap(({ start, end }) => [
      { t: start, d: 1 },
      { t: end, d: -1 },
    ])
    .sort((a, b) => a.t - b.t || a.d - b.d);
  const time = new Map<number, number>();
  let level = 0;
  for (let i = 0; i < events.length; i++) {
    level += events[i].d;
    const span = (events[i + 1]?.t ?? events[i].t) - events[i].t;
    if (level > 0 && span > 0) time.set(level, (time.get(level) ?? 0) + span);
  }
  const total = [...time.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const level of [...time.keys()].sort((a, b) => a - b)) {
    acc += time.get(level) ?? 0;
    if (acc >= total / 2) return level;
  }
  return null;
}

/** Most agent-hours inside any 5-hour window starting at an interval start. */
function peakWindow(intervals: Interval[]): number {
  let peak = 0;
  for (const { start } of intervals) {
    const end = start + 5 * HOUR_MS;
    let load = 0;
    for (const i of intervals) {
      load += Math.max(0, Math.min(end, i.end) - Math.max(start, i.start));
    }
    peak = Math.max(peak, load / HOUR_MS);
  }
  return peak;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Hours to one decimal, but never 0 for real time: tokens need hours. */
const roundHours = (hours: number) =>
  hours > 0 ? Math.max(0.1, round(hours, 1)) : 0;

const hasActivity = (h: { hours: number[]; weekdays: number[] }) =>
  h.hours.some((v) => v > 0) && h.weekdays.some((v) => v > 0);

/** Shares rounded to 3 decimals that still add up to 1. */
function shares(
  byModel: Map<ModelFamily, number>,
): Profile["by_model"]["value"] {
  const total = [...byModel.values()].reduce((a, b) => a + b, 0);
  const entries = MODEL_FAMILIES.filter((m) => (byModel.get(m) ?? 0) > 0).map(
    (m): [ModelFamily, number] => [m, round((byModel.get(m) ?? 0) / total, 3)],
  );
  if (entries.length) {
    const largest = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    largest[1] = round(
      largest[1] + 1 - entries.reduce((s, [, v]) => s + v, 0),
      3,
    );
  }
  return Object.fromEntries(entries);
}

export function profileFromCcusage(
  reports: CcusageReports,
  options: CcusageOptions,
): CcusageResult {
  const source = options.source ?? "claude-code";
  const offsetMs = (options.utcOffsetMinutes ?? 0) * 60_000;
  const warnings: string[] = [];
  const draft: ProfileDraft = {
    schema: PROFILE_SCHEMA_ID,
    period: options.period,
    plans: options.plans ?? [],
    provenance: { [source]: "measured" },
  };

  const daily = rowsOf(reports.daily, ["daily"]);
  const sessions = rowsOf(reports.sessions, ["sessions", "session"]);
  const blocks = rowsOf(reports.blocks, ["blocks"]).filter(
    (b) => b.isGap !== true,
  );

  // Tokens by model: daily first, then sessions, then blocks.
  const byModel = new Map<ModelFamily, Tokens>();
  const rawModels = new Set<string>();
  let unsplit = false;
  const tokenSource =
    [daily, sessions, blocks].find((rows) => rows.length) ?? [];
  for (const row of tokenSource) {
    modelNames(row).forEach((m) => rawModels.add(m));
    const parts = breakdownOf(row);
    if (parts) {
      for (const part of parts) {
        rawModels.add(part.name);
        addTokens(byModel, modelFamily(part.name), part.tokens);
      }
    } else {
      // Several models, no breakdown: split evenly and flag as estimated.
      const names = modelNames(row);
      if (!names.length) continue;
      unsplit = true;
      const t = tokensOf(row);
      const f = 1 / names.length;
      for (const name of names) {
        addTokens(byModel, modelFamily(name), {
          input: t.input * f,
          output: t.output * f,
          cache_read: t.cache_read * f,
          cache_write: t.cache_write * f,
        });
      }
    }
  }
  if (byModel.size) {
    const rows: TokenRow[] = MODEL_FAMILIES.filter((m) => byModel.has(m)).map(
      (model) => {
        const t = byModel.get(model)!;
        return {
          model,
          input: Math.round(t.input),
          output: Math.round(t.output),
          cache_read: Math.round(t.cache_read),
          cache_write: Math.round(t.cache_write),
        };
      },
    );
    const mark = unsplit ? estimated : measured;
    if (unsplit) warnings.push("tokens_split_evenly");
    draft.tokens = mark(rows, source);
    draft.by_model = mark(
      shares(new Map(rows.map((r) => [r.model, work(r)] as const))),
      source,
    );
    draft.models_count = measured(Math.max(1, rawModels.size), source);
  } else {
    warnings.push("no_tokens");
  }

  // Daily activity.
  const dailyWork = daily
    .map((row) => work(tokensOf(row)))
    .filter((w) => w > 0);
  if (dailyWork.length) {
    draft.active_days = measured(dailyWork.length, source);
    const mean = dailyWork.reduce((a, b) => a + b, 0) / dailyWork.length;
    const variance =
      dailyWork.reduce((s, w) => s + (w - mean) ** 2, 0) / dailyWork.length;
    draft.daily_variation = measured(
      round(Math.sqrt(variance) / mean, 2),
      source,
    );
  }

  // Time: sessions with timestamps give agent time; blocks give wall time.
  const sessionIntervals = sessions
    .map((row) =>
      intervalOf(
        row,
        ["firstActivity", "startTime"],
        ["lastActivity", "endTime"],
      ),
    )
    .filter((i): i is Interval => i != null)
    .map(({ start, end }) => ({
      start,
      end: Math.min(end, start + SESSION_CAP_HOURS * HOUR_MS),
    }));
  const blockIntervals = blocks
    .map((row) =>
      intervalOf(
        row,
        ["startTime", "blockStart"],
        ["actualEndTime", "endTime", "blockEnd"],
      ),
    )
    .filter((i): i is Interval => i != null);

  const sessionActivity = histograms(sessionIntervals, offsetMs);
  const blockActivity = histograms(blockIntervals, offsetMs);
  // Sessions too short to fill a minute bucket give way to the blocks.
  if (
    sessions.length &&
    sessionIntervals.length &&
    (hasActivity(sessionActivity) || !hasActivity(blockActivity))
  ) {
    const minutes = sessionIntervals.map((i) => (i.end - i.start) / 60_000);
    const hours = minutes.reduce((a, b) => a + b, 0) / 60;
    draft.agent_hours = measured(roundHours(hours), source);
    draft.sessions = measured(
      { count: sessions.length, median_minutes: round(median(minutes), 0) },
      source,
    );
    draft.activity = measured(sessionActivity, source);
    const parallel = medianConcurrency(sessionIntervals);
    if (parallel != null)
      draft.parallel_agents_p50 = measured(parallel, source);
    draft.peak_window_load = measured(
      round(peakWindow(sessionIntervals), 1),
      source,
    );
  } else if (blockIntervals.length) {
    // Blocks are wall-clock time: parallel agents are invisible here.
    const hours =
      blockIntervals.reduce((s, i) => s + (i.end - i.start), 0) / HOUR_MS;
    draft.agent_hours = estimated(roundHours(hours), source);
    draft.activity = measured(blockActivity, source);
    draft.peak_window_load = estimated(
      round(peakWindow(blockIntervals), 1),
      source,
    );
    // Without times a session length would be a guess: leave it out.
    if (sessions.length) warnings.push("sessions_without_times");
    warnings.push("agent_hours_from_blocks");
  } else {
    warnings.push("no_times");
  }
  warnings.push("no_limit_hits");

  if (draft.activity && !hasActivity(draft.activity.value)) {
    delete draft.activity;
    warnings.push("no_times");
  }

  const parsed = ProfileSchema.safeParse(draft);
  return { draft, profile: parsed.success ? parsed.data : null, warnings };
}
