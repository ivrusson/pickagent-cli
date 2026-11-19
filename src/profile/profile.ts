import { z } from "zod";
import {
  ModelFamilySchema,
  PlanIdSchema,
  ProvenanceSchema,
  SourceSchema,
  type Provenance,
  type Source,
} from "./ids";

/*
 * pickagent.profile/v1: the usage summary the scanner (or the guided prompt)
 * produces. The verdict page reads it from the URL fragment. Contract rules:
 *  - strict objects everywhere: unknown keys are rejected, never kept;
 *  - no free text: strings are ids from ./ids, plan slugs or dates;
 *  - every metric is `{ value, provenance, source }`;
 *  - times are local hours, never minute-precise.
 * Field rules live in the schemas below.
 */

export const PROFILE_SCHEMA_ID = "pickagent.profile/v1";

/** Currencies a person can declare. Catalog prices may also be GBP. */
export const DECLARED_CURRENCIES = ["EUR", "USD"] as const;
export type DeclaredCurrency = (typeof DECLARED_CURRENCIES)[number];

export const DECLARED_BILLING = ["monthly", "yearly"] as const;
export type DeclaredBilling = (typeof DECLARED_BILLING)[number];

/** The only provenance a declared price can carry: the person said so. */
export const DECLARED_PROVENANCE = "declared" as const;

/** What the person says they pay for one plan. Yearly amounts are divided by 12 later. */
export const DeclaredPlanPriceSchema = z.strictObject({
  amount: z.number().min(0).finite(),
  currency: z.enum(DECLARED_CURRENCIES),
  billing: z.enum(DECLARED_BILLING),
  provenance: z.literal(DECLARED_PROVENANCE),
});

export type DeclaredPlanPrice = z.infer<typeof DeclaredPlanPriceSchema>;

export const INTENSITIES = ["light", "medium", "heavy"] as const;
export type Intensity = (typeof INTENSITIES)[number];

/** Wraps a metric value with where it came from and how it was obtained. */
export function measureSchema<T extends z.ZodType>(value: T) {
  return z.strictObject({
    value,
    provenance: ProvenanceSchema,
    source: SourceSchema,
  });
}

export type Measure<T> = { value: T; provenance: Provenance; source: Source };

export function measured<T>(value: T, source: Source): Measure<T> {
  return { value, provenance: "measured", source };
}

export function estimated<T>(value: T, source: Source): Measure<T> {
  return { value, provenance: "estimated", source };
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;
const DAY_MS = 86_400_000;

function isoDayToUtc(day: string): number | null {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : null;
}

/**
 * Number of days covered by a period: a calendar month (`2026-10`) or an
 * inclusive range (`2026-10-06/2026-11-04`). Returns null when invalid.
 */
export function periodDays(period: string): number | null {
  const month = MONTH_RE.exec(period);
  if (month) {
    const year = Number(month[1]);
    const index = Number(month[2]);
    return new Date(Date.UTC(year, index, 0)).getUTCDate();
  }
  const range = RANGE_RE.exec(period);
  if (!range) return null;
  const start = isoDayToUtc(range[1]);
  const end = isoDayToUtc(range[2]);
  if (start == null || end == null || end < start) return null;
  return Math.round((end - start) / DAY_MS) + 1;
}

export function isCalendarMonth(period: string): boolean {
  return MONTH_RE.test(period);
}

export const MAX_PERIOD_DAYS = 366;

export const PeriodSchema = z.string().refine(
  (period) => {
    const days = periodDays(period);
    return days != null && days <= MAX_PERIOD_DAYS;
  },
  { message: "period must be YYYY-MM or YYYY-MM-DD/YYYY-MM-DD (≤ 366 days)" },
);

const Share = z.number().min(0).max(1);
/** Histogram weight: any integer scale. The scale itself is not a unit. */
const Weight = z.int().min(0).max(1_000_000);
const TokenCount = z.int().min(0);

function hasMass(weights: number[]): boolean {
  return weights.some((w) => w > 0);
}

/**
 * When the agent works, in the user's local time. `hours[0]` is 00:00–00:59,
 * `weekdays[0]` is Monday. Weights are agent time (any unit).
 */
export const ActivitySchema = z.strictObject({
  hours: z.array(Weight).length(24).refine(hasMass, "hours is all zeros"),
  weekdays: z.array(Weight).length(7).refine(hasMass, "weekdays is all zeros"),
});

export const SessionsSchema = z.strictObject({
  count: z.int().min(0),
  median_minutes: z.number().min(0).max(1440),
});

export const TokenRowSchema = z.strictObject({
  model: ModelFamilySchema,
  input: TokenCount,
  output: TokenCount,
  cache_read: TokenCount,
  cache_write: TokenCount,
});

export const TokensSchema = z
  .array(TokenRowSchema)
  .min(1)
  .refine(
    (rows) => new Set(rows.map((r) => r.model)).size === rows.length,
    "one row per model",
  );

/** Share of tokens by model family; shares add up to 1 (±0.02). */
export const ByModelSchema = z
  .partialRecord(ModelFamilySchema, Share)
  .refine((shares) => {
    const values = Object.values(shares) as number[];
    const total = values.reduce((a, b) => a + b, 0);
    return values.length > 0 && Math.abs(total - 1) <= 0.02;
  }, "by_model shares must add up to 1");

export const WorstBlockSchema = z.strictObject({
  weekday: z.int().min(0).max(6),
  hour: z.int().min(0).max(23),
  /** Hours until the quota came back, rounded. */
  wait_hours: z.int().min(0).max(168),
});

/** Limit hits seen in the logs during the period. */
export const BlocksSchema = z
  .strictObject({
    count: z.int().min(0),
    worst: WorstBlockSchema.optional(),
  })
  .refine((b) => b.worst == null || b.count > 0, "worst needs count > 0");

/**
 * Per-harness slice of a multi-source scan. Totals live on the top-level
 * metrics; this map is the breakdown shown in the verdict.
 */
export const SourceBreakdownSchema = z.strictObject({
  agent_hours: z
    .number()
    .min(0)
    .max(24 * 366 * 64),
  provenance: ProvenanceSchema,
  active_days: z.int().min(0).max(MAX_PERIOD_DAYS).optional(),
  sessions: z.int().min(0).optional(),
  /** Catalog plan slug detected for this harness, when known. */
  plan: PlanIdSchema.optional(),
});

export type SourceBreakdown = z.infer<typeof SourceBreakdownSchema>;

const MAX_PARALLEL = 64;

const metricShape = {
  /** Agent time: 3 agents for 1 hour = 3 agent-hours. */
  agent_hours: measureSchema(
    z
      .number()
      .min(0)
      .max(24 * 366 * MAX_PARALLEL),
  ),
  activity: measureSchema(ActivitySchema),
  by_model: measureSchema(ByModelSchema),
  active_days: measureSchema(z.int().min(0).max(MAX_PERIOD_DAYS)).optional(),
  parallel_agents_p50: measureSchema(
    z.number().min(1).max(MAX_PARALLEL),
  ).optional(),
  /** Agent-hours inside the busiest 5-hour window of the period. */
  peak_window_load: measureSchema(
    z
      .number()
      .min(0)
      .max(5 * MAX_PARALLEL),
  ).optional(),
  sessions: measureSchema(SessionsSchema).optional(),
  /** Coefficient of variation of daily usage across active days. */
  daily_variation: measureSchema(z.number().min(0).max(20)).optional(),
  tokens: measureSchema(TokensSchema).optional(),
  intensity: measureSchema(z.enum(INTENSITIES)).optional(),
  /** Distinct model versions used (before folding into families). */
  models_count: measureSchema(z.int().min(1).max(200)).optional(),
  blocks: measureSchema(BlocksSchema).optional(),
};

export const METRIC_KEYS = Object.keys(
  metricShape,
) as (keyof typeof metricShape)[];

export const ProfileSchema = z
  .strictObject({
    schema: z.literal(PROFILE_SCHEMA_ID),
    period: PeriodSchema,
    /** Plans the user pays today (catalog slugs). */
    plans: z.array(PlanIdSchema).max(10),
    /**
     * Optional price the person declares for a plan in `plans`.
     * Absent on v1 profiles and on `#p=` links shared before this field.
     * Every key must be listed in `plans`.
     */
    plan_prices: z
      .partialRecord(PlanIdSchema, DeclaredPlanPriceSchema)
      .optional(),
    /** How each source was read: logs (`measured`) or interview. */
    provenance: z
      .partialRecord(SourceSchema, ProvenanceSchema)
      .refine((p) => Object.keys(p).length > 0, "provenance is empty"),
    /**
     * Optional per-harness breakdown when several agents contributed.
     * Keys must appear in `provenance`.
     */
    by_source: z.partialRecord(SourceSchema, SourceBreakdownSchema).optional(),
    ...metricShape,
  })
  .superRefine((profile, ctx) => {
    for (const key of METRIC_KEYS) {
      const metric = profile[key];
      if (!metric) continue;
      const method = profile.provenance[metric.source];
      if (method == null) {
        ctx.addIssue({
          code: "custom",
          path: [key, "source"],
          message: `source ${metric.source} is not listed in provenance`,
        });
      } else if (method === "estimated" && metric.provenance === "measured") {
        ctx.addIssue({
          code: "custom",
          path: [key, "provenance"],
          message: `an estimated source cannot produce measured data`,
        });
      }
    }
    if (profile.by_source) {
      for (const source of Object.keys(profile.by_source) as Source[]) {
        if (profile.provenance[source] == null) {
          ctx.addIssue({
            code: "custom",
            path: ["by_source", source],
            message: `source ${source} is not listed in provenance`,
          });
        }
      }
    }
    if (profile.plan_prices) {
      for (const planId of Object.keys(profile.plan_prices)) {
        if (!profile.plans.includes(planId)) {
          ctx.addIssue({
            code: "custom",
            path: ["plan_prices", planId],
            message: `plan ${planId} is not listed in plans`,
          });
        }
      }
    }
    const days = periodDays(profile.period);
    if (
      days != null &&
      profile.active_days &&
      profile.active_days.value > days
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["active_days", "value"],
        message: "active_days exceeds the period",
      });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type TokenRow = z.infer<typeof TokenRowSchema>;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type Issue = { path: string; message: string };

export type ProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; issues: Issue[] };

export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function parseProfile(input: unknown): ProfileResult {
  const result = ProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  return { ok: false, issues: toIssues(result.error) };
}

/** Average month length used to normalise ranges to «per month». */
export const DAYS_PER_MONTH = 30.44;

/** Agent-hours per month (raw value for calendar months, scaled for ranges). */
export function monthlyAgentHours(profile: Profile): number {
  if (isCalendarMonth(profile.period)) return profile.agent_hours.value;
  const days = periodDays(profile.period) ?? DAYS_PER_MONTH;
  return (profile.agent_hours.value * DAYS_PER_MONTH) / days;
}
