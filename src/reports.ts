import type { CcusageReports } from "../../../src/lib/engine/ccusage";
import type { LimitHit } from "./limit-text";

export type TokenSum = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageAggregate = {
  daily: Map<string, Map<string, TokenSum>>;
  sessions: Map<
    string,
    { models: Map<string, TokenSum>; start: number; end: number }
  >;
  hits: LimitHit[];
};

export function createAggregate(): UsageAggregate {
  return { daily: new Map(), sessions: new Map(), hits: [] };
}

export function emptyTokens(): TokenSum {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(into: TokenSum, extra: TokenSum) {
  into.input += extra.input;
  into.output += extra.output;
  into.cacheRead += extra.cacheRead;
  into.cacheWrite += extra.cacheWrite;
}

function bucket(map: Map<string, TokenSum>, model: string): TokenSum {
  const row = map.get(model) ?? emptyTokens();
  map.set(model, row);
  return row;
}

/** Local calendar day for a fixed offset (the same one passed to the engine). */
export function localDay(at: number, offsetMinutes: number): string {
  return new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function addUsage(
  agg: UsageAggregate,
  turn: { session: string; at: number; model: string; tokens: TokenSum },
  offsetMinutes: number,
) {
  const total =
    turn.tokens.input +
    turn.tokens.output +
    turn.tokens.cacheRead +
    turn.tokens.cacheWrite;
  if (total <= 0) return;
  addTokens(bucket(dayModels(agg, turn.at, offsetMinutes), turn.model), turn.tokens);
  const session = agg.sessions.get(turn.session) ?? {
    models: new Map<string, TokenSum>(),
    start: turn.at,
    end: turn.at,
  };
  addTokens(bucket(session.models, turn.model), turn.tokens);
  session.start = Math.min(session.start, turn.at);
  session.end = Math.max(session.end, turn.at);
  agg.sessions.set(turn.session, session);
}

/**
 * Session span with a synthetic token weight (Cursor transcripts have no
 * usage field). Callers mark the resulting profile tokens as estimated.
 */
export function addSessionSpan(
  agg: UsageAggregate,
  turn: {
    session: string;
    start: number;
    end: number;
    model: string;
    weight?: number;
  },
  offsetMinutes: number,
) {
  const start = Math.min(turn.start, turn.end);
  const end = Math.max(turn.start, turn.end);
  if (!(end > start)) return;
  const weight = Math.max(1, Math.round(turn.weight ?? 1));
  const tokens: TokenSum = {
    input: 0,
    output: weight,
    cacheRead: 0,
    cacheWrite: 0,
  };
  addTokens(bucket(dayModels(agg, start, offsetMinutes), turn.model), tokens);
  const session = agg.sessions.get(turn.session) ?? {
    models: new Map<string, TokenSum>(),
    start,
    end,
  };
  addTokens(bucket(session.models, turn.model), tokens);
  session.start = Math.min(session.start, start);
  session.end = Math.max(session.end, end);
  agg.sessions.set(turn.session, session);
}

function dayModels(agg: UsageAggregate, at: number, offsetMinutes: number) {
  const date = localDay(at, offsetMinutes);
  const models = agg.daily.get(date) ?? new Map<string, TokenSum>();
  agg.daily.set(date, models);
  return models;
}

function breakdown(models: Map<string, TokenSum>) {
  return [...models.entries()].map(([modelName, tokens]) => ({
    modelName,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationTokens: tokens.cacheWrite,
    cacheReadTokens: tokens.cacheRead,
  }));
}

function totals(models: Map<string, TokenSum>) {
  const sum = emptyTokens();
  for (const tokens of models.values()) addTokens(sum, tokens);
  return {
    inputTokens: sum.input,
    outputTokens: sum.output,
    cacheCreationTokens: sum.cacheWrite,
    cacheReadTokens: sum.cacheRead,
  };
}

/**
 * ccusage-shaped reports. Session map keys are hashes and are not copied.
 * Rows carry model ids, token counts and timestamps only.
 */
export function toReports(agg: UsageAggregate): CcusageReports {
  const daily = [...agg.daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, models]) => ({
      date,
      modelsUsed: [...models.keys()],
      modelBreakdowns: breakdown(models),
      ...totals(models),
    }));
  const sessions = [...agg.sessions.values()].map((session) => ({
    models: [...session.models.keys()],
    modelBreakdowns: breakdown(session.models),
    ...totals(session.models),
    firstActivity: new Date(session.start).toISOString(),
    lastActivity: new Date(session.end).toISOString(),
  }));
  return {
    daily: { daily },
    sessions: { sessions },
  };
}
