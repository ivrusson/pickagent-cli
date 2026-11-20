import { z } from "zod";

/*
 * Closed id lists for the profile. They are enums on
 * purpose: a profile must never carry free text (project names, paths,
 * prompts), so every string in it is either one of these ids or a date.
 * Adding an id is a schema change.
 */

/**
 * Model families. Exact model versions are folded into their family.
 * The `#p=` fragment codes families by position (fragment.ts), so new
 * families go at the end, after `other`; never reorder.
 */
export const MODEL_FAMILIES = [
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gpt",
  "gpt-mini",
  "gpt-codex",
  "gemini-pro",
  "gemini-flash",
  "grok",
  "deepseek",
  "qwen",
  "kimi",
  "glm",
  "mistral",
  "composer",
  "other",
  "claude-fable",
  "minimax",
] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const ModelFamilySchema = z.enum(MODEL_FAMILIES);

/** Companies that sell plans or train models. */
export const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "github",
  "cursor",
  "xai",
  "deepseek",
  "alibaba",
  "moonshot",
  "zhipu",
  "mistral",
  "other",
  "minimax",
] as const;

export type Provider = (typeof PROVIDERS)[number];
export const ProviderSchema = z.enum(PROVIDERS);

export const MODEL_PROVIDER: Record<ModelFamily, Provider> = {
  "claude-opus": "anthropic",
  "claude-sonnet": "anthropic",
  "claude-haiku": "anthropic",
  gpt: "openai",
  "gpt-mini": "openai",
  "gpt-codex": "openai",
  "gemini-pro": "google",
  "gemini-flash": "google",
  grok: "xai",
  deepseek: "deepseek",
  qwen: "alibaba",
  kimi: "moonshot",
  glm: "zhipu",
  mistral: "mistral",
  composer: "cursor",
  other: "other",
  "claude-fable": "anthropic",
  minimax: "minimax",
};

/**
 * Where a metric came from: an agent's local logs, or an interview.
 * Split so the `#p=` fragment dictionary can keep CORE codes stable and
 * append EXTRA (and new keys like `by_source`) after MODEL_FAMILIES.
 */
export const SOURCES_CORE = [
  "claude-code",
  "codex",
  "cursor",
  "copilot",
  "gemini-cli",
  "opencode",
  "chat-interview",
  "manual",
] as const;

/** ccusage agents added after the original eight. Append only. */
export const SOURCES_EXTRA = [
  "amp",
  "droid",
  "codebuff",
  "hermes",
  "pi",
  "goose",
  "kilo",
  "antigravity",
  "kimi-cli",
  "qwen-cli",
  "openclaw",
  "grok-cli",
  "zcode",
  "cline",
  "other-cli",
] as const;

export const SOURCES = [...SOURCES_CORE, ...SOURCES_EXTRA] as const;

export type Source = (typeof SOURCES)[number];
export const SourceSchema = z.enum(SOURCES);

export const PROVENANCE = ["measured", "estimated"] as const;
export type Provenance = (typeof PROVENANCE)[number];
export const ProvenanceSchema = z.enum(PROVENANCE);

/**
 * Cursor prices from before the Plus / Premium / Super rename.
 * Local Stripe ids `pro` and `pro_plus` are these products, not
 * `cursor-premium` / `cursor-super`. Append-only; the web catalog
 * adds the same slugs.
 */
export const CURSOR_LEGACY_PLAN_IDS = [
  "cursor-pro-legacy",
  "cursor-pro-plus-legacy",
  "cursor-ultra-legacy",
] as const;

/** Catalog plan ids: lowercase slugs such as `claude-max-5x`. */
export const PlanIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(48);

export type PlanId = z.infer<typeof PlanIdSchema>;

const FAMILY_PATTERNS: [RegExp, ModelFamily][] = [
  [/opus/, "claude-opus"],
  [/sonnet/, "claude-sonnet"],
  [/haiku/, "claude-haiku"],
  [/fable/, "claude-fable"],
  [/codex/, "gpt-codex"],
  [/gpt.*(mini|nano)|o\d+-mini/, "gpt-mini"],
  [/(^|\/)(gpt|o\d)/, "gpt"],
  [/gemini.*(flash|lite)/, "gemini-flash"],
  [/gemini/, "gemini-pro"],
  [/grok/, "grok"],
  [/deepseek/, "deepseek"],
  [/qwen/, "qwen"],
  [/kimi|moonshot/, "kimi"],
  [/glm/, "glm"],
  [/mistral|devstral|codestral|magistral/, "mistral"],
  [/composer/, "composer"],
  [/minimax/, "minimax"],
];

/**
 * Folds a raw model name from a log (`claude-sonnet-4-5-20250929`,
 * `openai/gpt-5-codex`) into its family. Unknown names become `other`, so the
 * raw string never reaches the profile.
 */
export function modelFamily(rawName: string): ModelFamily {
  const name = rawName.trim().toLowerCase();
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(name)) return family;
  }
  return "other";
}
