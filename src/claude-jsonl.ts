import { createReadStream } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { hashKey } from "./hash";
import { classifyUsageLimit } from "./limit-text";
import {
  addUsage,
  createAggregate,
  type TokenSum,
  type UsageAggregate,
} from "./reports";

/*
 * Fallback reader for Claude Code transcripts:
 *   $CLAUDE_CONFIG_DIR/projects/**\/*.jsonl
 *   or ~/.config/claude and ~/.claude (ccusage checks both).
 * A line is parsed only when it looks like an assistant record with usage
 * or a rate-limit error. User prompts, attachments and cwd stay on the
 * line buffer and are not copied. Session ids are hashed before grouping.
 */

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every Claude Code config directory for this machine.
 * Comma-separated `CLAUDE_CONFIG_DIR`, each `config_dir` in
 * `~/.claude-subs/registry.json` (that field only), and the defaults.
 * Paths are deduped. Registry env and tokens are never read.
 */
export async function claudeConfigDirs(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string[]> {
  const found: string[] = [];
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (raw) {
    for (const entry of raw.split(",")) {
      const expanded = expandHome(entry.trim(), home);
      if (expanded) found.push(expanded);
    }
  }
  found.push(...(await registryConfigDirs(home)));
  found.push(join(home, ".config", "claude"), join(home, ".claude"));
  return dedupePaths(found);
}

/** `config_dir` strings from the claude-subs registry. Nothing else. */
export async function registryConfigDirs(home: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(home, ".claude-subs", "registry.json"), "utf8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!isDict(data) || !isDict(data.profiles)) return [];
  const dirs: string[] = [];
  for (const profile of Object.values(data.profiles)) {
    if (!isDict(profile) || typeof profile.config_dir !== "string") continue;
    const expanded = expandHome(profile.config_dir.trim(), home);
    if (expanded) dirs.push(expanded);
  }
  return dirs;
}

async function dedupePaths(paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    let key = path;
    try {
      key = await realpath(path);
    } catch {
      key = path;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
}

function modelOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.startsWith("<") || name.length > 80) return null;
  if (
    name.startsWith("/") ||
    name.startsWith("~") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    return null;
  }
  return name;
}

function tokensOf(usage: Dict): TokenSum {
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens ?? usage.cache_read_tokens),
    cacheWrite: count(
      usage.cache_creation_input_tokens ?? usage.cache_creation_tokens,
    ),
  };
}

/** First text block, used only to classify a limit line. */
function firstText(message: Dict): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (isDict(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function takeLine(
  line: string,
  agg: UsageAggregate,
  seen: Set<string>,
  fileKey: string,
  bounds: { start: number; end: number },
  offsetMinutes: number,
) {
  if (!line.includes('"usage"') && !line.includes('"rate_limit"')) return;
  let row: unknown;
  try {
    row = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!isDict(row) || row.type !== "assistant" || !isDict(row.message)) return;
  const at = Date.parse(typeof row.timestamp === "string" ? row.timestamp : "");
  if (Number.isNaN(at) || at < bounds.start || at >= bounds.end) return;

  if (row.error === "rate_limit") {
    // A resumed session replays the same row: count each message id once.
    const hitId = typeof row.message.id === "string" ? row.message.id : "";
    const hitKey = hitId ? hashKey(`limit:${hitId}`) : "";
    if (hitKey && seen.has(hitKey)) return;
    const hit = classifyUsageLimit(firstText(row.message), at);
    if (hit && !agg.hits.some((prev) => prev.at === hit.at)) {
      if (hitKey) seen.add(hitKey);
      agg.hits.push(hit);
    }
    return;
  }

  const model = modelOf(row.message.model);
  const usage = isDict(row.message.usage) ? row.message.usage : null;
  if (!model || !usage) return;
  const tokens = tokensOf(usage);
  const messageId = typeof row.message.id === "string" ? row.message.id : "";
  const fingerprint = hashKey(
    messageId ||
      [at, model, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].join(
        ":",
      ),
  );
  if (seen.has(fingerprint)) return;
  seen.add(fingerprint);
  const rawSession =
    typeof row.sessionId === "string"
      ? row.sessionId
      : typeof row.session_id === "string"
        ? row.session_id
        : "";
  addUsage(
    agg,
    { session: hashKey(rawSession || fileKey), at, model, tokens },
    offsetMinutes,
  );
}

async function readFileLines(
  file: string,
  onLine: (line: string) => void,
): Promise<void> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) onLine(line);
  } catch {
    // Unreadable or truncated file: skip it. The path is not reported.
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function walkJsonl(
  dir: string,
  depth: number,
  visit: (file: string) => Promise<void>,
) {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === "memory" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, depth + 1, visit);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) await visit(path);
  }
}

export async function readClaudeLogs(
  dirs: string[],
  bounds: { start: number; end: number },
  offsetMinutes: number,
): Promise<UsageAggregate> {
  const agg = createAggregate();
  const seen = new Set<string>();
  for (const dir of dirs) {
    await walkJsonl(join(dir, "projects"), 0, async (file) => {
      const fileKey = hashKey(file);
      await readFileLines(file, (line) => {
        takeLine(line, agg, seen, fileKey, bounds, offsetMinutes);
      });
    });
  }
  return agg;
}
