import type { Profile, Source } from "../../../src/lib/engine";

const SOURCE_ES: Record<Source, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
  "chat-interview": "entrevista",
  manual: "a mano",
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
  "other-cli": "otro CLI",
};

const MODEL_ES: Record<string, string> = {
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
  other: "otro",
  "claude-fable": "Fable",
  minimax: "MiniMax",
};

const WEEKDAYS = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
] as const;

const WARNING_ES: Record<string, string> = {
  ccusage_failed: "ccusage no respondió. Esta lectura usa el parser local.",
  ccusage_incomplete:
    "ccusage no llegó a un perfil válido. Esta lectura usa el parser local.",
  no_limit_hits:
    "Esta lectura no trae bloqueos: ccusage no informa de cuándo se alcanza el tope.",
  tokens_split_evenly:
    "Varios modelos venían sin desglose: los tokens se reparten a partes iguales y quedan estimados.",
  agent_hours_from_blocks:
    "Las horas salen del reloj de las ventanas, no de las sesiones, y quedan estimadas.",
  sessions_without_times: "Hay sesiones sin hora de inicio y fin.",
  no_tokens: "No hay tokens en el periodo.",
  no_times: "No hay sesiones con inicio y fin distintos. No invento las horas.",
  codex_experimental:
    "Lectura de Codex experimental: el formato del rollout no está confirmado aquí.",
  codex_cache_write_unreported:
    "Codex no anota la caché creada. Ese campo queda a 0 y los tokens quedan estimados.",
  plan_detect_invalid_profile:
    "Se detectó un plan local, pero el perfil no validó al aplicarlo; se deja sin ese plan.",
};

const number = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("es-ES", {
  style: "percent",
  maximumFractionDigits: 0,
});

function how(provenance: string): string {
  return provenance === "measured" ? "medido" : "estimado";
}

function labelSource(source: string): string {
  return SOURCE_ES[source as Source] ?? source;
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
        `Plan local de ${labelSource(source ?? "")} no mapeado al catálogo (${raw ?? "?"}). Usa --plan.`,
      );
      continue;
    }
    const bare = warning.includes(":")
      ? warning.slice(warning.indexOf(":") + 1)
      : warning;
    const prefix = warning.includes(":")
      ? `${labelSource(warning.slice(0, warning.indexOf(":")))}: `
      : "";
    lines.push(`${prefix}${WARNING_ES[bare] ?? WARNING_ES[warning] ?? warning}`);
  }
  return lines;
}

export function renderPreview(
  profile: Profile,
  meta: { url: string; warnings: string[]; scannedAt: string; reader: string },
): string {
  const sources = sourcesLine(profile);
  const lines = [
    "pickagent",
    `Periodo ${profile.period}. Fuentes ${sources}. Lectura ${meta.scannedAt}.`,
    `Cómo se leyó: ${meta.reader}.`,
    "",
    `Horas-agente: ${number.format(profile.agent_hours.value)} (${how(profile.agent_hours.provenance)}, total, ${profile.period})`,
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
          slice.sessions != null ? `, ${number.format(slice.sessions)} ses.` : "";
        const plan = slice.plan ? `, plan ${slice.plan}` : "";
        return `${labelSource(source)} ${number.format(slice.agent_hours)} h (${how(slice.provenance)}${sessions}${plan})`;
      });
    lines.push(`Por harness: ${parts.join(" · ")}`);
  }
  if (profile.active_days) {
    lines.push(
      `Días activos: ${number.format(profile.active_days.value)} (${how(profile.active_days.provenance)}, ${profile.period})`,
    );
  }
  if (profile.sessions) {
    lines.push(
      `Sesiones: ${number.format(profile.sessions.value.count)}, mediana ${number.format(profile.sessions.value.median_minutes)} min (${how(profile.sessions.provenance)}, ${profile.period})`,
    );
  }
  const models = Object.entries(profile.by_model.value)
    .map(([model, share]) => `${MODEL_ES[model] ?? model} ${percent.format(share)}`)
    .join(", ");
  lines.push(
    `Modelos: ${models} (${how(profile.by_model.provenance)}, ${profile.period})`,
  );
  if (profile.blocks) {
    const worst = profile.blocks.value.worst;
    const when = worst
      ? ` El peor: ${WEEKDAYS[worst.weekday] ?? "día"} a las ${worst.hour} h, espera ${worst.wait_hours} h.`
      : "";
    lines.push(
      `Bloqueos: ${number.format(profile.blocks.value.count)}.${when} (${how(profile.blocks.provenance)}, ${profile.period})`,
    );
  }
  const plans = profile.plans.length ? profile.plans.join(", ") : "ninguno indicado";
  lines.push(`Planes que pagas hoy: ${plans}.`);
  const notes = noteLines(meta.warnings);
  if (notes.length) {
    lines.push("", "Notas:");
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push(
    "",
    "El perfil se queda en tu máquina. Viaja en el fragmento de la URL; el servidor no lo recibe.",
    "No incluye mensajes, rutas ni nombres de proyecto.",
    meta.url,
  );
  return lines.join("\n");
}
