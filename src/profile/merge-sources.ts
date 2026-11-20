import { type ModelFamily, type Source } from "./ids";
import {
  measured,
  parseProfile,
  type Profile,
  type SourceBreakdown,
  type TokenRow,
} from "./profile";
import type { CcusageReports } from "./ccusage";
import { profileFromCcusage } from "./ccusage";

/*
 * Multi-harness scan: map ccusage agent ids → Source, split unified
 * `--by-agent` reports, and attach a `by_source` breakdown to a total profile.
 */

/** ccusage CLI agent name → pickagent Source. Unknowns become `other-cli`. */
export const CCUSAGE_AGENT_TO_SOURCE: Record<string, Source> = {
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  copilot: "copilot",
  gemini: "gemini-cli",
  opencode: "opencode",
  amp: "amp",
  droid: "droid",
  codebuff: "codebuff",
  hermes: "hermes",
  pi: "pi",
  goose: "goose",
  kilo: "kilo",
  antigravity: "antigravity",
  kimi: "kimi-cli",
  qwen: "qwen-cli",
  openclaw: "openclaw",
  grok: "grok-cli",
  zcode: "zcode",
  cline: "cline",
};

export function mapCcusageAgent(agent: string): Source {
  const key = agent.trim().toLowerCase();
  return CCUSAGE_AGENT_TO_SOURCE[key] ?? "other-cli";
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function rowsOf(report: unknown, keys: string[]): Dict[] {
  if (Array.isArray(report)) return report.filter(isDict);
  if (!isDict(report)) return [];
  for (const key of keys) {
    if (Array.isArray(report[key]))
      return (report[key] as unknown[]).filter(isDict);
  }
  if (Array.isArray(report.data)) return report.data.filter(isDict);
  return [];
}

function stamp(row: Dict): Dict {
  const out: Dict = {};
  for (const key of [
    "date",
    "period",
    "firstActivity",
    "lastActivity",
    "startTime",
    "endTime",
    "blockStart",
    "blockEnd",
    "actualEndTime",
  ] as const) {
    if (typeof row[key] === "string") out[key] = row[key];
  }
  return out;
}

function tokenFields(row: Dict): Dict {
  const out: Dict = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
  ] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

function agentEntryToDailyRow(parent: Dict, agent: Dict): Dict {
  const row: Dict = { ...stamp(parent), ...tokenFields(agent) };
  if (Array.isArray(agent.modelsUsed)) row.modelsUsed = agent.modelsUsed;
  if (Array.isArray(agent.models)) row.models = agent.models;
  if (Array.isArray(agent.modelBreakdowns)) {
    row.modelBreakdowns = agent.modelBreakdowns;
  }
  if (isDict(agent.breakdown)) row.breakdown = agent.breakdown;
  if (isDict(agent.tokenCounts)) row.tokenCounts = agent.tokenCounts;
  return row;
}

/** Totals rows: unified `agent: "all"` or legacy rows with no agent field. */
export function totalDailyRows(report: unknown): Dict[] {
  return rowsOf(report, ["daily"]).filter(
    (row) => row.agent == null || row.agent === "all",
  );
}

/**
 * Splits a unified ccusage report set into one report pack per Source.
 * Daily rows with `agents[]` fan out; session rows use `agent`; blocks go to
 * Claude Code (ccusage `blocks` is the Claude 5 h window report).
 */
export function splitReportsByAgent(
  reports: CcusageReports,
): Map<Source, CcusageReports> {
  const buckets = new Map<Source, { daily: Dict[]; sessions: Dict[]; blocks: Dict[] }>();

  const ensure = (source: Source) => {
    let bucket = buckets.get(source);
    if (!bucket) {
      bucket = { daily: [], sessions: [], blocks: [] };
      buckets.set(source, bucket);
    }
    return bucket;
  };

  for (const row of rowsOf(reports.daily, ["daily"])) {
    if (Array.isArray(row.agents)) {
      for (const entry of row.agents) {
        if (!isDict(entry)) continue;
        const name = typeof entry.agent === "string" ? entry.agent : null;
        if (!name || name === "all") continue;
        ensure(mapCcusageAgent(name)).daily.push(agentEntryToDailyRow(row, entry));
      }
      continue;
    }
    if (typeof row.agent === "string" && row.agent !== "all") {
      ensure(mapCcusageAgent(row.agent)).daily.push(row);
    }
  }

  for (const row of rowsOf(reports.sessions, ["sessions", "session"])) {
    if (typeof row.agent !== "string" || row.agent === "all") continue;
    ensure(mapCcusageAgent(row.agent)).sessions.push(row);
  }

  for (const row of rowsOf(reports.blocks, ["blocks"])) {
    ensure("claude-code").blocks.push(row);
  }

  const out = new Map<Source, CcusageReports>();
  for (const [source, bucket] of buckets) {
    if (!bucket.daily.length && !bucket.sessions.length && !bucket.blocks.length) {
      continue;
    }
    out.set(source, {
      daily: bucket.daily.length ? { daily: bucket.daily } : undefined,
      sessions: bucket.sessions.length ? { sessions: bucket.sessions } : undefined,
      blocks: bucket.blocks.length ? { blocks: bucket.blocks } : undefined,
    });
  }
  return out;
}

/** Reports used to build the totals profile. */
export function totalsReports(reports: CcusageReports): CcusageReports {
  const daily = totalDailyRows(reports.daily);
  return {
    daily: daily.length ? { daily } : reports.daily,
    sessions: reports.sessions,
    blocks: reports.blocks,
  };
}

function breakdownOf(profile: Profile): SourceBreakdown {
  return {
    agent_hours: profile.agent_hours.value,
    provenance: profile.agent_hours.provenance,
    active_days: profile.active_days?.value,
    sessions: profile.sessions?.value.count,
  };
}

/**
 * Primary source: the measured harness with the most agent-hours.
 * The provenance map wins over the slice: ccusage marks a source measured
 * even when the hour figure itself is estimated. A source is measured only
 * when every contributor says so. Estimated slices (Cursor file clocks,
 * timestamp fills) never outrank a measured one that has hours.
 * Pending resync with the web engine — see README.md.
 */
export function dominantSource(
  bySource: Partial<Record<Source, SourceBreakdown>>,
  provenance: Partial<Record<Source, "measured" | "estimated">> = {},
): Source {
  let bestMeasured: Source | null = null;
  let measuredHours = -1;
  let bestAny: Source | null = null;
  let anyHours = -1;
  for (const [source, slice] of Object.entries(bySource) as [
    Source,
    SourceBreakdown,
  ][]) {
    if (slice.agent_hours > anyHours) {
      anyHours = slice.agent_hours;
      bestAny = source;
    }
    const method = provenance[source] ?? slice.provenance;
    if (
      method === "measured" &&
      slice.agent_hours > 0 &&
      slice.agent_hours > measuredHours
    ) {
      measuredHours = slice.agent_hours;
      bestMeasured = source;
    }
  }
  return bestMeasured ?? bestAny ?? "claude-code";
}

function retarget<T>(
  metric: { value: T; provenance: "measured" | "estimated"; source: Source },
  source: Source,
): { value: T; provenance: "measured" | "estimated"; source: Source } {
  return { ...metric, source };
}

/**
 * Builds one profile with totals + `by_source` from a unified ccusage load.
 * Returns null when the totals profile does not validate.
 */
export function profileFromMultiAgent(
  reports: CcusageReports,
  options: {
    period: string;
    plans: string[];
    utcOffsetMinutes: number;
  },
): {
  profile: Profile | null;
  parts: Map<Source, Profile>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const parts = new Map<Source, Profile>();
  const split = splitReportsByAgent(reports);

  const partialBreakdown = new Map<Source, SourceBreakdown>();

  for (const [source, partReports] of split) {
    const result = profileFromCcusage(partReports, {
      period: options.period,
      plans: options.plans,
      source,
      utcOffsetMinutes: options.utcOffsetMinutes,
    });
    warnings.push(...result.warnings.map((w) => `${source}:${w}`));
    if (result.profile) {
      parts.set(source, result.profile);
      continue;
    }
    // Token-only agents (no session timestamps) still belong in by_source.
    const draft = result.draft;
    if (draft.tokens || draft.sessions || draft.agent_hours) {
      partialBreakdown.set(source, {
        agent_hours: draft.agent_hours?.value ?? 0,
        provenance: draft.agent_hours?.provenance ?? "estimated",
        active_days: draft.active_days?.value,
        sessions: draft.sessions?.value.count,
      });
    }
  }

  const totalResult = profileFromCcusage(totalsReports(reports), {
    period: options.period,
    plans: options.plans,
    source: "claude-code",
    utcOffsetMinutes: options.utcOffsetMinutes,
  });
  warnings.push(...totalResult.warnings);

  if (!totalResult.profile && parts.size === 0) {
    return { profile: null, parts, warnings };
  }

  // Prefer a validated total; if only parts exist, merge them.
  let base = totalResult.profile;
  if (!base && parts.size) {
    base = mergeProfileParts([...parts.values()], options.plans);
  }
  if (!base) return { profile: null, parts, warnings };

  const by_source: Partial<Record<Source, SourceBreakdown>> = {};
  const provenance: Profile["provenance"] = { ...base.provenance };
  for (const [source, part] of parts) {
    by_source[source] = breakdownOf(part);
    provenance[source] = part.provenance[source] ?? part.agent_hours.provenance;
  }
  for (const [source, slice] of partialBreakdown) {
    if (by_source[source]) continue;
    by_source[source] = slice;
    provenance[source] = slice.provenance;
  }

  if (Object.keys(by_source).length === 0) {
    const source = base.agent_hours.source;
    by_source[source] = breakdownOf(base);
    provenance[source] = base.provenance[source] ?? base.agent_hours.provenance;
  }

  const dominant = dominantSource(by_source, provenance);
  const next: Profile = {
    ...base,
    provenance,
    by_source,
    agent_hours: retarget(base.agent_hours, dominant),
    activity: retarget(base.activity, dominant),
    by_model: retarget(base.by_model, dominant),
  };
  if (base.active_days) next.active_days = retarget(base.active_days, dominant);
  if (base.parallel_agents_p50) {
    next.parallel_agents_p50 = retarget(base.parallel_agents_p50, dominant);
  }
  if (base.peak_window_load) {
    next.peak_window_load = retarget(base.peak_window_load, dominant);
  }
  if (base.sessions) next.sessions = retarget(base.sessions, dominant);
  if (base.daily_variation) {
    next.daily_variation = retarget(base.daily_variation, dominant);
  }
  if (base.tokens) next.tokens = retarget(base.tokens, dominant);
  if (base.intensity) next.intensity = retarget(base.intensity, dominant);
  if (base.models_count) next.models_count = retarget(base.models_count, dominant);
  if (base.blocks) next.blocks = retarget(base.blocks, dominant);

  const parsed = parseProfile(next);
  if (!parsed.ok) return { profile: null, parts, warnings };
  return { profile: parsed.profile, parts, warnings };
}

/** Sum two activity histograms. */
function sumActivity(
  a: Profile["activity"]["value"],
  b: Profile["activity"]["value"],
): Profile["activity"]["value"] {
  return {
    hours: a.hours.map((v, i) => v + (b.hours[i] ?? 0)),
    weekdays: a.weekdays.map((v, i) => v + (b.weekdays[i] ?? 0)),
  };
}

/**
 * Merges already-built single-source profiles (e.g. local Codex into a
 * multi-agent scan). Hours and activity are summed; tokens are concatenated
 * by model family; `by_source` is rebuilt.
 */
export function mergeProfileParts(
  profiles: Profile[],
  plans: string[],
): Profile | null {
  if (!profiles.length) return null;
  if (profiles.length === 1) {
    const only = profiles[0]!;
    const source = only.agent_hours.source;
    const withBreak: Profile = {
      ...only,
      plans,
      by_source: {
        ...(only.by_source ?? {}),
        [source]: only.by_source?.[source] ?? breakdownOf(only),
      },
    };
    const parsed = parseProfile(withBreak);
    return parsed.ok ? parsed.profile : null;
  }

  const period = profiles[0]!.period;
  const provenance: Profile["provenance"] = {};
  const by_source: Partial<Record<Source, SourceBreakdown>> = {};
  let agentHours = 0;
  let hoursMeasured = true;
  let activity = {
    hours: Array.from({ length: 24 }, () => 0),
    weekdays: Array.from({ length: 7 }, () => 0),
  };
  const tokenMap = new Map<
    string,
    { input: number; output: number; cache_read: number; cache_write: number }
  >();
  let sessionCount = 0;
  let sessionMedianWeight = 0;
  let sessionMedianAcc = 0;
  let activeDays = 0;
  let peak = 0;
  let blocksCount = 0;
  let worst: NonNullable<Profile["blocks"]>["value"]["worst"];
  let modelsCount = 0;

  for (const profile of profiles) {
    for (const [source, method] of Object.entries(profile.provenance) as [
      Source,
      "measured" | "estimated",
    ][]) {
      const prev = provenance[source];
      if (prev == null) provenance[source] = method;
      else if (prev === "estimated" || method === "estimated") {
        provenance[source] = "estimated";
      }
    }
    if (profile.by_source) {
      for (const [source, slice] of Object.entries(profile.by_source) as [
        Source,
        SourceBreakdown,
      ][]) {
        const prev = by_source[source];
        by_source[source] = prev
          ? {
              agent_hours: prev.agent_hours + slice.agent_hours,
              provenance:
                prev.provenance === "measured" && slice.provenance === "measured"
                  ? "measured"
                  : "estimated",
              active_days:
                Math.max(prev.active_days ?? 0, slice.active_days ?? 0) ||
                undefined,
              sessions: (prev.sessions ?? 0) + (slice.sessions ?? 0) || undefined,
            }
          : { ...slice };
      }
    } else {
      const source = profile.agent_hours.source;
      const slice = breakdownOf(profile);
      const prev = by_source[source];
      by_source[source] = prev
        ? {
            agent_hours: prev.agent_hours + slice.agent_hours,
            provenance:
              prev.provenance === "measured" && slice.provenance === "measured"
                ? "measured"
                : "estimated",
            active_days:
              Math.max(prev.active_days ?? 0, slice.active_days ?? 0) ||
              undefined,
            sessions: (prev.sessions ?? 0) + (slice.sessions ?? 0) || undefined,
          }
        : slice;
      const method = profile.agent_hours.provenance;
      const prevMethod = provenance[source];
      provenance[source] =
        prevMethod == null
          ? method
          : prevMethod === "measured" && method === "measured"
            ? "measured"
            : "estimated";
    }

    agentHours += profile.agent_hours.value;
    if (profile.agent_hours.provenance !== "measured") hoursMeasured = false;
    activity = sumActivity(activity, profile.activity.value);
    if (profile.tokens) {
      for (const row of profile.tokens.value) {
        const prev = tokenMap.get(row.model) ?? {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
        };
        tokenMap.set(row.model, {
          input: prev.input + row.input,
          output: prev.output + row.output,
          cache_read: prev.cache_read + row.cache_read,
          cache_write: prev.cache_write + row.cache_write,
        });
      }
    }
    // Estimated session counts (one file per Cursor turn) stay on by_source.
    if (profile.sessions && profile.sessions.provenance === "measured") {
      sessionCount += profile.sessions.value.count;
      sessionMedianWeight += profile.sessions.value.count;
      sessionMedianAcc +=
        profile.sessions.value.median_minutes * profile.sessions.value.count;
    }
    if (profile.active_days) {
      activeDays = Math.max(activeDays, profile.active_days.value);
    }
    if (profile.peak_window_load) {
      peak = Math.max(peak, profile.peak_window_load.value);
    }
    if (profile.blocks) {
      blocksCount += profile.blocks.value.count;
      const candidate = profile.blocks.value.worst;
      if (
        candidate &&
        (!worst || candidate.wait_hours > (worst.wait_hours ?? -1))
      ) {
        worst = candidate;
      }
    }
    if (profile.models_count) {
      modelsCount = Math.max(modelsCount, profile.models_count.value);
    }
  }

  const dominant = dominantSource(by_source, provenance);
  const hoursProv = hoursMeasured ? "measured" : "estimated";
  const dominantProv = provenance[dominant] === "estimated" ? "estimated" : "measured";
  const hourMetric = {
    value: Math.round(agentHours * 10) / 10,
    provenance: hoursProv,
    source: dominant,
  } as const;

  const tokenRows: TokenRow[] = [...tokenMap.entries()].map(([model, t]) => ({
    model: model as ModelFamily,
    ...t,
  }));

  const work = (t: { input: number; output: number; cache_write: number }) =>
    t.input + t.output + t.cache_write;
  const totalWork = tokenRows.reduce((s, r) => s + work(r), 0);
  const byModelValue: Profile["by_model"]["value"] = {};
  if (totalWork > 0) {
    for (const row of tokenRows) {
      byModelValue[row.model] =
        Math.round((work(row) / totalWork) * 1000) / 1000;
    }
    const entries = Object.entries(byModelValue) as [
      ModelFamily,
      number,
    ][];
    if (entries.length) {
      const largest = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
      const drift = 1 - entries.reduce((s, [, v]) => s + v, 0);
      byModelValue[largest[0]] =
        Math.round(((byModelValue[largest[0]] ?? 0) + drift) * 1000) / 1000;
    }
  } else {
    Object.assign(byModelValue, profiles[0]!.by_model.value);
  }

  const draft: Profile = {
    schema: "pickagent.profile/v1",
    period,
    plans,
    provenance,
    by_source,
    agent_hours: hourMetric,
    activity: { value: activity, provenance: dominantProv, source: dominant },
    by_model: {
      value: byModelValue,
      provenance: tokenRows.length
        ? hoursProv
        : profiles[0]!.by_model.provenance,
      source: dominant,
    },
  };
  if (activeDays > 0) {
    draft.active_days = measured(activeDays, dominant);
  }
  if (sessionCount > 0) {
    draft.sessions = {
      value: {
        count: sessionCount,
        median_minutes:
          sessionMedianWeight > 0
            ? Math.round(sessionMedianAcc / sessionMedianWeight)
            : 0,
      },
      provenance: "measured",
      source: dominant,
    };
  }
  if (peak > 0) {
    draft.peak_window_load = {
      value: Math.round(peak * 10) / 10,
      provenance: hoursProv,
      source: dominant,
    };
  }
  if (tokenRows.length) {
    draft.tokens = {
      value: tokenRows,
      provenance: hoursProv,
      source: dominant,
    };
  }
  if (modelsCount > 0) {
    draft.models_count = measured(modelsCount, dominant);
  }
  if (blocksCount > 0) {
    draft.blocks = measured(
      worst ? { count: blocksCount, worst } : { count: blocksCount },
      dominant,
    );
  }

  const parsed = parseProfile(draft);
  return parsed.ok ? parsed.profile : null;
}
