import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashKey } from "./hash";
import {
  cursorProjectsDir,
  cursorTrackingDbPath,
} from "./cursor-paths";
import { querySqliteStrings } from "./cursor-sqlite";
import {
  addSessionSpan,
  createAggregate,
  type UsageAggregate,
} from "./reports";

/*
 * Local Cursor usage without reading chat bodies.
 * 1) agent-transcripts: birthtime→mtime of each *.jsonl (session span).
 * 2) ai-code-tracking.db: conversationId + model + createdAt aggregates.
 * Synthetic token weights only so by_model validates; callers mark estimated.
 */

export type CursorBounds = { start: number; end: number };

function birthMs(st: { birthtimeMs: number; ctimeMs: number; mtimeMs: number }): number {
  const b = st.birthtimeMs;
  if (Number.isFinite(b) && b > 0) return b;
  return Math.min(st.ctimeMs, st.mtimeMs);
}

function overlaps(
  start: number,
  end: number,
  bounds: CursorBounds,
): boolean {
  return end >= bounds.start && start < bounds.end;
}

function clip(start: number, end: number, bounds: CursorBounds): {
  start: number;
  end: number;
} {
  return {
    start: Math.max(start, bounds.start),
    end: Math.min(end, bounds.end),
  };
}

async function walkJsonl(
  dir: string,
  out: string[],
  depth: number,
): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walkJsonl(path, out, depth + 1);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
}

async function fromTranscripts(
  projectsDir: string,
  bounds: CursorBounds,
  offsetMinutes: number,
  agg: UsageAggregate,
): Promise<number> {
  let projectEntries;
  try {
    projectEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let added = 0;
  for (const project of projectEntries) {
    if (!project.isDirectory()) continue;
    const transcriptsRoot = join(
      projectsDir,
      project.name,
      "agent-transcripts",
    );
    const files: string[] = [];
    await walkJsonl(transcriptsRoot, files, 0);
    for (const file of files) {
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (st.size <= 0) continue;
      // birthtime is often "now" after copy/checkout; prefer the span of
      // birth↔mtime, and fall back to a 1-minute window ending at mtime.
      const birth = birthMs(st);
      const mtime = st.mtimeMs;
      let start = Math.min(birth, mtime);
      let end = Math.max(birth, mtime);
      if (end - start < 60_000) {
        end = mtime;
        start = mtime - 60_000;
      }
      if (!overlaps(start, end, bounds)) continue;
      const clipped = clip(start, end, bounds);
      if (!(clipped.end > clipped.start)) continue;
      addSessionSpan(
        agg,
        {
          session: hashKey(file),
          start: clipped.start,
          end: clipped.end,
          model: "composer",
          weight: 1,
        },
        offsetMinutes,
      );
      added += 1;
    }
  }
  return added;
}

async function fromTrackingDb(
  dbPath: string,
  bounds: CursorBounds,
  offsetMinutes: number,
  agg: UsageAggregate,
): Promise<number> {
  const sql = `
SELECT
  COALESCE(conversationId, requestId, hash) AS sid,
  COALESCE(NULLIF(TRIM(model), ''), 'composer') AS model,
  MIN(createdAt) AS t0,
  MAX(createdAt) AS t1,
  COUNT(*) AS n
FROM ai_code_hashes
WHERE createdAt >= ${Math.floor(bounds.start)}
  AND createdAt < ${Math.floor(bounds.end)}
GROUP BY sid, model
`.trim();
  const rows = await querySqliteStrings(dbPath, sql);
  if (!rows) return 0;
  let added = 0;
  for (const row of rows) {
    const sid = row[0]?.trim();
    const model = row[1]?.trim() || "composer";
    const t0 = Number(row[2]);
    const t1 = Number(row[3]);
    const n = Number(row[4]);
    if (!sid || !Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    const start = Math.min(t0, t1);
    const end = Math.max(t0, t1, start + 60_000);
    if (!overlaps(start, end, bounds)) continue;
    const clipped = clip(start, end, bounds);
    if (!(clipped.end > clipped.start)) continue;
    addSessionSpan(
      agg,
      {
        session: hashKey(`tracking:${sid}:${model}`),
        start: clipped.start,
        end: clipped.end,
        model: model.slice(0, 80),
        weight: Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 1,
      },
      offsetMinutes,
    );
    added += 1;
  }
  return added;
}

export async function readCursorUsage(
  env: NodeJS.ProcessEnv,
  home: string,
  bounds: CursorBounds,
  offsetMinutes: number,
): Promise<UsageAggregate & { transcriptSessions: number; trackingSessions: number }> {
  const agg = createAggregate();
  const transcriptSessions = await fromTranscripts(
    cursorProjectsDir(env, home),
    bounds,
    offsetMinutes,
    agg,
  );
  const trackingSessions = await fromTrackingDb(
    cursorTrackingDbPath(env, home),
    bounds,
    offsetMinutes,
    agg,
  );
  return { ...agg, transcriptSessions, trackingSessions };
}
