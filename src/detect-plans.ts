import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDirs } from "./claude-jsonl";
import type { Source } from "./profile";
import { CURSOR_LEGACY_PLAN_IDS } from "./profile/ids";
import { CURSOR_MEMBERSHIP_KEY, cursorStateDbPath } from "./cursor-paths";
import { readSqliteItemValue } from "./cursor-sqlite";

/*
 * Best-effort local plan detection. No network, no chat bodies.
 * Claude: tier strings in ~/.claude.json (and optional credentials).
 * Codex: chatgpt_plan_type claim inside ~/.codex/auth.json JWTs.
 * Cursor: cursorAuth/stripeMembershipType in state.vscdb (no tokens).
 * Never returns tokens or email — only catalog plan slugs.
 */

export type DetectedPlan = {
  source: Source;
  plan: string;
  raw: string;
  confidence: "measured" | "estimated";
};

export type DetectPlansResult = {
  detections: DetectedPlan[];
  /** Unique catalog slugs, stable order (Claude then Codex then others). */
  plans: string[];
  warnings: string[];
};

const SOURCE_ORDER: Source[] = ["claude-code", "codex", "cursor"];

/** First non-empty JSON string value for `key` (avoids parsing huge files). */
export function jsonStringValue(text: string, key: string): string | null {
  const needle = `"${key}"`;
  let from = 0;
  while (from < text.length) {
    const i = text.indexOf(needle, from);
    if (i < 0) return null;
    from = i + needle.length;
    const rest = text.slice(from).trimStart();
    if (!rest.startsWith(":")) continue;
    const after = rest.slice(1).trimStart();
    if (!after.startsWith('"')) continue;
    const body = after.slice(1);
    const end = body.indexOf('"');
    if (end < 0) continue;
    const val = body.slice(0, end);
    if (!val || val.includes("\\")) continue;
    return val;
  }
  return null;
}

/**
 * Map Anthropic rate-limit / subscription tier strings to catalog ids.
 * Prefer rateLimitTier over coarse subscriptionType.
 */
export function mapClaudeTier(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (
    s.includes("enterprise") ||
    s.includes("team") ||
    s.includes("raven") ||
    s.includes("zero")
  ) {
    return null;
  }
  if (/max[_-]?20x|ultra/.test(s)) return "claude-ultra";
  if (/max[_-]?5x/.test(s)) return "claude-max-5x";
  // `default_claude_ai` is the Claude.ai Pro tier (not Max).
  if (
    s === "default_claude_ai" ||
    s === "claude_ai" ||
    s === "claude_pro" ||
    /(^|_)pro($|_)/.test(s) ||
    s === "pro" ||
    s.endsWith("_pro")
  ) {
    return "claude-pro";
  }
  // Bare `max` does not say 5× or 20×. Leave it for the plan interview.
  if (s === "max" || s === "claude_max" || s.endsWith("_max")) return null;
  return null;
}

/** Map OpenAI `chatgpt_plan_type` / Codex `plan_type` to catalog ids. */
export function mapCodexPlanType(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  switch (s) {
    case "go":
      return "chatgpt-go";
    case "plus":
      return "chatgpt-plus";
    case "prolite":
      return "chatgpt-pro-100";
    case "pro":
      return "chatgpt-pro-200";
    case "promax":
      return "chatgpt-pro-500";
    case "business":
    case "team":
      return "chatgpt-business";
    case "free":
      return null;
    default:
      return null;
  }
}

/**
 * Map Cursor `stripeMembershipType` to catalog ids.
 * Old Stripe product ids (`pro`, `pro_plus`) are the pre-rename prices
 * (~$20 / ~$60), not Premium / Super. `ultra` is shared by the old and
 * the current Ultra, so it is left unmapped and the interview asks.
 */
export function mapCursorMembership(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return null;
  switch (s) {
    case "plus":
    case "cursor_plus":
      return "cursor-plus";
    case "premium":
    case "cursor_premium":
      return "cursor-premium";
    case "super":
    case "cursor_super":
      return "cursor-super";
    case "pro":
      return CURSOR_LEGACY_PLAN_IDS[0];
    case "pro_plus":
    case "proplus":
      return CURSOR_LEGACY_PLAN_IDS[1];
    case "free":
    case "hobby":
    case "free_trial":
    case "trial":
    case "ultra":
    case "cursor_ultra":
    case "enterprise":
    case "team":
    case "teams":
      return null;
    default:
      return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const data = JSON.parse(json) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planTypeFromClaims(data: Record<string, unknown>): string | null {
  const auth = data["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const plan = (auth as Record<string, unknown>).chatgpt_plan_type;
    if (typeof plan === "string" && plan.trim()) return plan.trim();
  }
  if (typeof data.chatgpt_plan_type === "string" && data.chatgpt_plan_type.trim()) {
    return data.chatgpt_plan_type.trim();
  }
  if (typeof data.plan_type === "string" && data.plan_type.trim()) {
    return data.plan_type.trim();
  }
  return null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const CLAUDE_TIER_KEYS = [
  "rateLimitTier",
  "organizationRateLimitTier",
  "userRateLimitTier",
  "subscriptionType",
  "organizationType",
  "seatTier",
];

function tierCandidates(text: string | null): { key: string; raw: string }[] {
  if (!text) return [];
  const found: { key: string; raw: string }[] = [];
  for (const key of CLAUDE_TIER_KEYS) {
    const raw = jsonStringValue(text, key);
    if (raw) found.push({ key, raw });
  }
  return found;
}

function rankTiers(candidates: { key: string; raw: string }[]): { key: string; raw: string }[] {
  return [...candidates].sort((a, b) => {
    const score = (c: { key: string; raw: string }) => {
      if (/max|ultra|pro|claude_ai/.test(c.raw.toLowerCase())) return 0;
      if (c.key.toLowerCase().includes("ratelimit")) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
}

/**
 * One catalog plan per Claude config directory. Several profiles can
 * carry several plans; each distinct slug is returned.
 */
export async function detectClaudePlans(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ detections: DetectedPlan[]; warnings: string[] }> {
  const roots = await claudeConfigDirs(env, home);
  const detections: DetectedPlan[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const homeAccount = await readText(join(home, ".claude.json"));
  const defaultDir = join(home, ".claude");
  let defaultReal = defaultDir;
  try {
    defaultReal = await realpath(defaultDir);
  } catch {
    defaultReal = defaultDir;
  }

  const buckets: { key: string; raw: string }[][] = [];
  let attachedHome = false;
  for (const root of roots) {
    const own = [
      ...tierCandidates(await readText(join(root, ".credentials.json"))),
      ...tierCandidates(await readText(join(root, ".claude.json"))),
    ];
    // ~/.claude.json is the default account file, not a per-profile copy.
    if (root === defaultReal || root === defaultDir) {
      own.push(...tierCandidates(homeAccount));
      attachedHome = true;
    }
    if (own.length) buckets.push(own);
  }
  if (!attachedHome && homeAccount) buckets.push(tierCandidates(homeAccount));

  for (const candidates of buckets) {
    const ranked = rankTiers(candidates);
    let mapped = false;
    for (const { raw } of ranked) {
      const plan = mapClaudeTier(raw);
      if (!plan) continue;
      mapped = true;
      if (seen.has(plan)) break;
      seen.add(plan);
      detections.push({
        source: "claude-code",
        plan,
        raw,
        confidence: "measured",
      });
      break;
    }
    if (!mapped && ranked.length) {
      warnings.push(`plan_unmapped:claude-code:${ranked[0]!.raw}`);
    }
  }
  return { detections, warnings };
}

export async function detectCodexPlan(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<DetectedPlan | { warning: string } | null> {
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  const authText = await readText(join(codexHome, "auth.json"));
  if (!authText) return null;
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(authText) as Record<string, unknown>;
  } catch {
    return { warning: "plan_unmapped:codex:auth_parse_error" };
  }

  const tokens = auth.tokens;
  const tokenList: string[] = [];
  if (typeof tokens === "string") tokenList.push(tokens);
  else if (tokens && typeof tokens === "object") {
    for (const value of Object.values(tokens as Record<string, unknown>)) {
      if (typeof value === "string") tokenList.push(value);
    }
  }

  for (const token of tokenList) {
    const payload = decodeJwtPayload(token);
    if (!payload) continue;
    const raw = planTypeFromClaims(payload);
    if (!raw) continue;
    const plan = mapCodexPlanType(raw);
    if (plan) {
      return {
        source: "codex",
        plan,
        raw,
        confidence: "measured",
      };
    }
    return { warning: `plan_unmapped:codex:${raw}` };
  }
  return null;
}

export async function detectCursorPlan(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<DetectedPlan | { warning: string } | null> {
  const override = env.CURSOR_MEMBERSHIP_TYPE?.trim();
  const raw =
    override && override.length
      ? override
      : await readSqliteItemValue(
          cursorStateDbPath(env, home),
          CURSOR_MEMBERSHIP_KEY,
        );
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  // Not a consumer catalog plan. Do not ask about it.
  if (
    normalized === "free" ||
    normalized === "hobby" ||
    normalized === "free_trial" ||
    normalized === "trial" ||
    normalized === "enterprise" ||
    normalized === "team" ||
    normalized === "teams"
  ) {
    return null;
  }
  const plan = mapCursorMembership(raw);
  if (plan) {
    return {
      source: "cursor",
      plan,
      raw,
      confidence: "measured",
    };
  }
  // `ultra` and any other paid string we cannot place.
  return { warning: `plan_unmapped:cursor:${raw}` };
}

export async function detectPlans(input: {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Only attach plans for these harnesses (e.g. those present in by_source). */
  sources?: Source[];
}): Promise<DetectPlansResult> {
  const warnings: string[] = [];
  const detections: DetectedPlan[] = [];
  const allow = input.sources ? new Set(input.sources) : null;

  const claude = await detectClaudePlans(input.home, input.env);
  warnings.push(...claude.warnings);
  for (const found of claude.detections) {
    if (!allow || allow.has("claude-code")) detections.push(found);
  }

  const codex = await detectCodexPlan(input.home, input.env);
  if (codex && "warning" in codex) warnings.push(codex.warning);
  else if (codex && (!allow || allow.has("codex"))) detections.push(codex);

  const cursor = await detectCursorPlan(input.home, input.env);
  if (cursor && "warning" in cursor) warnings.push(cursor.warning);
  else if (cursor && (!allow || allow.has("cursor"))) detections.push(cursor);

  detections.sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
  );
  const plans: string[] = [];
  for (const d of detections) {
    if (!plans.includes(d.plan)) plans.push(d.plan);
  }
  return { detections, plans, warnings };
}

/** Merge detected plans into a profile's `plans` and `by_source.*.plan`. */
export function applyDetectedPlans<
  T extends {
    plans: string[];
    by_source?: Partial<
      Record<
        Source,
        {
          agent_hours: number;
          provenance: "measured" | "estimated";
          active_days?: number;
          sessions?: number;
          plan?: string;
        }
      >
    >;
    provenance: Partial<Record<Source, "measured" | "estimated">>;
  },
>(
  profile: T,
  detected: DetectPlansResult,
  opts: { cliPlans: string[] },
): T {
  const by_source = { ...(profile.by_source ?? {}) } as NonNullable<
    T["by_source"]
  >;
  const provenance = { ...profile.provenance };

  const plansBySource = new Map<Source, string[]>();
  for (const d of detected.detections) {
    const list = plansBySource.get(d.source) ?? [];
    if (!list.includes(d.plan)) list.push(d.plan);
    plansBySource.set(d.source, list);
    if (provenance[d.source] == null) provenance[d.source] = d.confidence;
  }
  for (const [source, planList] of plansBySource) {
    const prev = by_source[source];
    // One harness field cannot name two plans. All of them stay in `plans`.
    const plan = planList.length === 1 ? planList[0] : undefined;
    if (prev) {
      by_source[source] = plan ? { ...prev, plan } : { ...prev };
    } else if (plan) {
      const sample = detected.detections.find((d) => d.source === source);
      by_source[source] = {
        agent_hours: 0,
        provenance: sample?.confidence ?? "measured",
        plan,
      };
    }
  }

  const plans = opts.cliPlans.length
    ? [...opts.cliPlans]
    : detected.plans.length
      ? [...detected.plans]
      : [...profile.plans];

  return {
    ...profile,
    plans: plans.slice(0, 10),
    provenance,
    by_source: Object.keys(by_source).length ? by_source : profile.by_source,
  };
}
