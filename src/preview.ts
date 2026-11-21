import type { Profile, Source } from "./profile";

const SOURCE_LABELS: Record<Source, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
  "chat-interview": "interview",
  manual: "manual",
  amp: "Amp",
  droid: "Droid",
  codebuff: "Codebuff",
  hermes: "Hermes",
  pi: "pi",
  goose: "Goose",
  kilo: "Kilo",
  antigravity: "Antigravity",
  "kimi-cli": "Kimi CLI",
  "qwen-cli": "Qwen CLI",
  openclaw: "OpenClaw",
  "grok-cli": "Grok CLI",
  zcode: "ZCode",
  cline: "Cline",
  "other-cli": "other CLI",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-opus": "Opus",
  "claude-sonnet": "Sonnet",
  "claude-haiku": "Haiku",
  gpt: "GPT",
  "gpt-mini": "GPT mini",
  "gpt-codex": "GPT Codex",
  "gemini-pro": "Gemini Pro",
  "gemini-flash": "Gemini Flash",
  grok: "Grok",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  kimi: "Kimi",
  glm: "GLM",
  mistral: "Mistral",
  composer: "Composer",
  other: "other",
  "claude-fable": "Fable",
  minimax: "MiniMax",
};

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const WARNING_TEXT: Record<string, string> = {
  ccusage_failed: "ccusage did not respond. This read uses the local parser.",
  ccusage_incomplete:
    "ccusage did not produce a valid profile. This read uses the local parser.",
  no_limit_hits:
    "This read has no blocks: ccusage does not report when the cap is hit.",
  tokens_split_evenly:
    "Several models had no breakdown: tokens are split evenly and marked estimated.",
  agent_hours_from_blocks:
    "Hours come from window clocks, not from sessions, and stay estimated.",
  sessions_without_times: "Some sessions have no start and end time.",
  no_tokens: "No tokens in this period.",
  no_times: "No sessions with a distinct start and end. Hours are not invented.",
  codex_experimental:
    "Experimental Codex read: the rollout format is not confirmed here.",
  codex_cache_write_unreported:
    "Codex does not record cache creation. That field stays 0 and tokens stay estimated.",
  cursor_experimental:
    "Experimental Cursor read: hours from agent-transcripts / ai-tracking metadata, without reading chat.",
  cursor_tokens_synthetic:
    "Cursor does not expose local tokens; model weight is synthetic and stays estimated.",
  cursor_from_transcripts:
    "Cursor hours estimated from agent-transcripts (birthtime→mtime).",
  cursor_from_tracking:
    "Cursor hours estimated from ~/.cursor/ai-tracking (hashes, no bodies).",
  plan_detect_invalid_profile:
    "A local plan was detected, but the profile failed validation when it was applied; that plan is left off.",
  plan_price_missing:
    "A plan is missing its declared amount; the comparator will use the catalog price.",
  plan_price_invalid:
    "Declared amounts failed validation; they are omitted from the profile.",
  model_share_unmeasured:
    "Local logs have clocks but no token breakdown. The model share is unmeasured and stays estimated.",
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});

function how(provenance: string): string {
  return provenance === "measured" ? "measured" : "estimated";
}

function labelSource(source: string): string {
  return SOURCE_LABELS[source as Source] ?? source;
}

function sourcesLine(profile: Profile): string {
  const keys = profile.by_source
    ? (Object.keys(profile.by_source) as Source[])
    : (Object.keys(profile.provenance) as Source[]);
  if (keys.length <= 1) {
    return labelSource(profile.agent_hours.source);
  }
  return keys.map(labelSource).join(", ");
}

export function noteLines(warnings: string[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const warning of warnings) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    if (warning.startsWith("plan_unmapped:")) {
      const [, source, raw] = warning.split(":");
      lines.push(
        `Local ${labelSource(source ?? "")} plan is not in the catalog (${raw ?? "?"}). Use --plan.`,
      );
      continue;
    }
    const bare = warning.includes(":")
      ? warning.slice(warning.indexOf(":") + 1)
      : warning;
    const prefix = warning.includes(":")
      ? `${labelSource(warning.slice(0, warning.indexOf(":")))}: `
      : "";
    lines.push(`${prefix}${WARNING_TEXT[bare] ?? WARNING_TEXT[warning] ?? warning}`);
  }
  return lines;
}

function planSummary(profile: Profile, names?: Record<string, string>): string {
  if (!profile.plans.length) return "none given";
  return profile.plans
    .map((planId) => {
      const price = profile.plan_prices?.[planId];
      const name = names?.[planId];
      const title = name && name !== planId ? name : planId;
      if (!price) return title;
      const symbol = price.currency === "EUR" ? "€" : "$";
      const per = price.billing === "yearly" ? "/yr" : "/mo";
      return `${title} — ${symbol}${price.amount.toFixed(2)}${per}`;
    })
    .join(", ");
}

export function renderPreview(
  profile: Profile,
  meta: {
    url: string;
    warnings: string[];
    scannedAt: string;
    reader: string;
    /** Harness breakdown and notes. Default is the short summary. */
    verbose?: boolean;
    /** Printed only when the browser was not opened. */
    includeUrl?: boolean;
    names?: Record<string, string>;
  },
): string {
  const sources = sourcesLine(profile);
  const plans = `Plans you pay for today: ${planSummary(profile, meta.names)}.`;
  if (!meta.verbose) {
    const lines = [
      "pickagent",
      `Period ${profile.period}. Sources ${sources}. Read ${meta.scannedAt}.`,
      "",
      `Agent-hours: ${number.format(profile.agent_hours.value)} (${how(profile.agent_hours.provenance)}, total, ${profile.period})`,
      plans,
      "",
      "The profile stays on your machine. It travels in the URL fragment; the server does not receive it.",
    ];
    if (meta.includeUrl) lines.push(meta.url);
    return lines.join("\n");
  }
  const lines = [
    "pickagent",
    `Period ${profile.period}. Sources ${sources}. Read ${meta.scannedAt}.`,
    `How it was read: ${meta.reader}.`,
    "",
    `Agent-hours: ${number.format(profile.agent_hours.value)} (${how(profile.agent_hours.provenance)}, total, ${profile.period})`,
  ];
  if (profile.by_source && Object.keys(profile.by_source).length > 0) {
    const parts = (Object.entries(profile.by_source) as [
      Source,
      {
        agent_hours: number;
        provenance: string;
        sessions?: number;
        plan?: string;
      },
    ][])
      .sort((a, b) => b[1].agent_hours - a[1].agent_hours)
      .map(([source, slice]) => {
        const sessions =
          slice.sessions != null ? `, ${number.format(slice.sessions)} sess.` : "";
        const plan = slice.plan ? `, plan ${slice.plan}` : "";
        return `${labelSource(source)} ${number.format(slice.agent_hours)} h (${how(slice.provenance)}${sessions}${plan})`;
      });
    lines.push(`By harness: ${parts.join(" · ")}`);
  }
  if (profile.active_days) {
    lines.push(
      `Active days: ${number.format(profile.active_days.value)} (${how(profile.active_days.provenance)}, ${profile.period})`,
    );
  }
  if (profile.sessions) {
    lines.push(
      `Sessions: ${number.format(profile.sessions.value.count)}, median ${number.format(profile.sessions.value.median_minutes)} min (${how(profile.sessions.provenance)}, ${profile.period})`,
    );
  }
  const models = Object.entries(profile.by_model.value)
    .map(([model, share]) => `${MODEL_LABELS[model] ?? model} ${percent.format(share)}`)
    .join(", ");
  lines.push(
    `Models: ${models} (${how(profile.by_model.provenance)}, ${profile.period})`,
  );
  if (profile.blocks) {
    const worst = profile.blocks.value.worst;
    const when = worst
      ? ` Worst: ${WEEKDAYS[worst.weekday] ?? "day"} at ${worst.hour}:00, wait ${worst.wait_hours} h.`
      : "";
    lines.push(
      `Blocks: ${number.format(profile.blocks.value.count)}.${when} (${how(profile.blocks.provenance)}, ${profile.period})`,
    );
  }
  lines.push(plans);
  const notes = noteLines(meta.warnings);
  if (notes.length) {
    lines.push("", "Notes:");
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push(
    "",
    "The profile stays on your machine. It travels in the URL fragment; the server does not receive it.",
    "It does not include messages, paths, or project names.",
  );
  if (meta.includeUrl) lines.push(meta.url);
  return lines.join("\n");
}
