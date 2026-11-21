import { realpath, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { expandHome } from "./cursor-paths";
import {
  cursorProjectsDir,
  cursorStateDbPath,
  cursorTrackingDbPath,
} from "./cursor-paths";
import { codexHomeDir } from "./codex-rollout";
import type { Source } from "./profile";

export type DiscoveredAccount = {
  id: string;
  source: Source;
  label: string;
  hint?: string;
  /** Set for a Claude Code account. Scanning reads only the selected dirs. */
  claudeDir?: string;
};

export type ScanLimits = {
  sources: Set<Source>;
  /** Null: every Claude config dir. */
  claudeDirs: string[] | null;
};

const isDict = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function safeName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  if (/[\\/@\n]/.test(trimmed) || trimmed.includes("..")) return null;
  return trimmed;
}

type RegistryAccount = { dir: string; name: string | null };

/** `config_dir` plus a short display name. Tokens and env stay unread. */
async function registryAccounts(home: string): Promise<RegistryAccount[]> {
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
  const accounts: RegistryAccount[] = [];
  for (const [key, profile] of Object.entries(data.profiles)) {
    if (!isDict(profile) || typeof profile.config_dir !== "string") continue;
    const dir = expandHome(profile.config_dir, home);
    if (!dir) continue;
    const named =
      (typeof profile.name === "string" ? safeName(profile.name) : null) ??
      (typeof profile.label === "string" ? safeName(profile.label) : null) ??
      safeName(key);
    accounts.push({ dir, name: named });
  }
  return accounts;
}

function claudeLabel(dir: string, home: string, name: string | null): string {
  if (name) return `Claude Code (${name})`;
  const base = basename(dir);
  if (dir === join(home, ".claude") || base === ".claude") return "Claude Code";
  if (dir === join(home, ".config", "claude")) return "Claude Code (config)";
  const short = safeName(base.replace(/^\./, ""));
  return short ? `Claude Code (${short})` : "Claude Code";
}

async function discoverClaude(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<DiscoveredAccount[]> {
  const named = new Map<string, string | null>();
  for (const account of await registryAccounts(home)) {
    if (!(await exists(account.dir))) continue;
    named.set(await real(account.dir), account.name);
  }
  const candidates: string[] = [];
  const raw = env.CLAUDE_CONFIG_DIR?.trim();
  if (raw) {
    for (const entry of raw.split(",")) {
      const expanded = expandHome(entry.trim(), home);
      if (expanded) candidates.push(expanded);
    }
  }
  candidates.push(join(home, ".config", "claude"), join(home, ".claude"));
  const accounts: DiscoveredAccount[] = [];
  const seen = new Set<string>();
  for (const dir of candidates) {
    if (!(await exists(dir))) continue;
    const key = await real(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!named.has(key)) named.set(key, null);
  }
  let n = 0;
  for (const [dir, name] of named) {
    if (!(await exists(dir))) continue;
    n += 1;
    accounts.push({
      id: `claude-${n}`,
      source: "claude-code",
      label: claudeLabel(dir, home, name),
      hint: name ?? undefined,
      claudeDir: dir,
    });
  }
  return accounts;
}

async function addIf(
  accounts: DiscoveredAccount[],
  path: string,
  account: DiscoveredAccount,
) {
  if (await exists(path)) accounts.push(account);
}

/** Local accounts the scanner can read. No usage is parsed here. */
export async function discoverAccounts(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<DiscoveredAccount[]> {
  const accounts = await discoverClaude(env, home);
  if (
    (await exists(cursorStateDbPath(env, home))) ||
    (await exists(cursorProjectsDir(env, home))) ||
    (await exists(cursorTrackingDbPath(env, home)))
  ) {
    accounts.push({ id: "cursor", source: "cursor", label: "Cursor" });
  }
  await addIf(accounts, join(home, ".local", "share", "opencode"), {
    id: "opencode",
    source: "opencode",
    label: "OpenCode",
  });
  if (
    (await exists(join(home, ".kimi"))) ||
    (await exists(join(home, ".kimi-code")))
  ) {
    accounts.push({ id: "kimi", source: "kimi-cli", label: "Kimi" });
  }
  await addIf(accounts, codexHomeDir(env, home), {
    id: "codex",
    source: "codex",
    label: "Codex",
  });
  await addIf(accounts, join(home, ".gemini", "tmp"), {
    id: "gemini",
    source: "gemini-cli",
    label: "Gemini CLI",
  });
  await addIf(accounts, join(home, ".gemini", "antigravity"), {
    id: "antigravity",
    source: "antigravity",
    label: "Antigravity",
  });
  return accounts;
}

export function limitsFrom(accounts: readonly DiscoveredAccount[]): ScanLimits {
  const sources = new Set(accounts.map((account) => account.source));
  const claudeDirs = accounts
    .map((account) => account.claudeDir)
    .filter((dir): dir is string => Boolean(dir));
  return {
    sources,
    claudeDirs: claudeDirs.length ? claudeDirs : null,
  };
}
