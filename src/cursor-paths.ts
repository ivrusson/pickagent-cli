import { homedir } from "node:os";
import { join } from "node:path";

/** Non-secret membership tier key in Cursor `state.vscdb` ItemTable. */
export const CURSOR_MEMBERSHIP_KEY = "cursorAuth/stripeMembershipType";

/** Expand `~/…` against home; leave absolute paths alone. */
export function expandHome(raw: string, home: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return home;
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  return trimmed;
}

/**
 * Cursor `state.vscdb` (VS Code globalStorage). Holds
 * `cursorAuth/stripeMembershipType` — never the access token for our reads.
 */
export function cursorStateDbPath(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.CURSOR_STATE_DB?.trim();
  if (override) return expandHome(override, home);
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(
    home,
    ".config",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

/** `~/.cursor/projects` — agent-transcripts live under each project id. */
export function cursorProjectsDir(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env.CURSOR_PROJECTS_DIR?.trim();
  if (override) return expandHome(override, home);
  return join(home, ".cursor", "projects");
}

/** Optional AI code-tracking SQLite (model + timestamps, no file bodies). */
export function cursorTrackingDbPath(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env.CURSOR_AI_TRACKING_DB?.trim();
  if (override) return expandHome(override, home);
  return join(home, ".cursor", "ai-tracking", "ai-code-tracking.db");
}
