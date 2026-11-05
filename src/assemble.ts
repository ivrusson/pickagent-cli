import {
  estimated,
  measured,
  parseProfile,
  profileFromCcusage,
  type CcusageReports,
  type Issue,
  type Profile,
  type Source,
} from "../../../src/lib/engine";
import type { LimitHit } from "./limit-text";

export type AssembleInput = {
  reports: CcusageReports;
  hits: LimitHit[];
  period: string;
  plans: string[];
  source: Extract<Source, "claude-code" | "codex">;
  utcOffsetMinutes: number;
  /** Codex cache writes are absent, so token metrics stay estimated. */
  estimateTokens?: boolean;
  extraWarnings?: string[];
  /**
   * The local parser looked for quota hits. Drop the engine's
   * `no_limit_hits` note, which only describes ccusage.
   */
  limitHitsKnown?: boolean;
};

export type Assembled = {
  profile: Profile | null;
  issues: Issue[];
  warnings: string[];
};

function worstOf(hits: LimitHit[], offsetMinutes: number) {
  const ranked = hits.filter((hit) => hit.waitHours != null);
  if (!ranked.length) return undefined;
  const worst = ranked.reduce((best, hit) =>
    (hit.waitHours ?? -1) > (best.waitHours ?? -1) ? hit : best,
  );
  const wait = worst.waitHours;
  if (wait == null) return undefined;
  const local = new Date(worst.at + offsetMinutes * 60_000);
  return {
    weekday: (local.getUTCDay() + 6) % 7,
    hour: local.getUTCHours(),
    wait_hours: Math.max(0, Math.min(168, Math.round(wait))),
  };
}

function withHits(
  profile: Profile,
  hits: LimitHit[],
  source: AssembleInput["source"],
  offsetMinutes: number,
): Profile {
  if (!hits.length) return profile;
  const worst = worstOf(hits, offsetMinutes);
  return {
    ...profile,
    blocks: measured(
      worst ? { count: hits.length, worst } : { count: hits.length },
      source,
    ),
  };
}

function withEstimatedTokens(profile: Profile, source: AssembleInput["source"]): Profile {
  const next: Profile = {
    ...profile,
    by_model: estimated(profile.by_model.value, source),
  };
  if (profile.tokens) next.tokens = estimated(profile.tokens.value, source);
  return next;
}

export function assembleProfile(input: AssembleInput): Assembled {
  const result = profileFromCcusage(input.reports, {
    period: input.period,
    source: input.source,
    utcOffsetMinutes: input.utcOffsetMinutes,
    plans: input.plans,
  });
  const warnings = [...(input.extraWarnings ?? []), ...result.warnings];
  let draft: Profile | null = result.profile;
  if (draft && input.hits.length) {
    draft = withHits(draft, input.hits, input.source, input.utcOffsetMinutes);
  }
  if (input.hits.length || input.limitHitsKnown) {
    const index = warnings.indexOf("no_limit_hits");
    if (index >= 0) warnings.splice(index, 1);
  }
  if (draft && input.estimateTokens) draft = withEstimatedTokens(draft, input.source);
  const parsed = parseProfile(draft ?? result.draft);
  if (!parsed.ok) return { profile: null, issues: parsed.issues, warnings };
  return { profile: parsed.profile, issues: [], warnings };
}
