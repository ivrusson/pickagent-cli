import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCursorUsage } from "./cursor-usage";
import { toReports } from "./reports";
import { assembleProfile } from "./assemble";

test("readCursorUsage builds sessions from transcript mtimes", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-cursor-"));
  const project = join(home, ".cursor", "projects", "demo");
  const transcriptDir = join(project, "agent-transcripts", "agent-abc");
  await mkdir(transcriptDir, { recursive: true });
  const file = join(transcriptDir, "agent-abc.jsonl");
  await writeFile(file, '{"role":"user","message":"x"}\n');
  // 2026-10-05 08:00–10:00 UTC
  const start = new Date("2026-10-05T08:00:00.000Z");
  const end = new Date("2026-10-05T10:00:00.000Z");
  await utimes(file, end, end);
  // birthtime is not always settable; force via atime/mtime and accept ≥1h
  // by also touching a second write after start window if needed.
  try {
    const { utimes: utimesSync } = await import("node:fs");
    utimesSync(file, start, end);
  } catch {
    // platform may ignore birthtime; span still uses mtime as end
  }

  const bounds = {
    start: Date.parse("2026-10-01T00:00:00.000Z"),
    end: Date.parse("2026-11-01T00:00:00.000Z"),
  };
  const logs = await readCursorUsage(
    { CURSOR_PROJECTS_DIR: join(home, ".cursor", "projects") },
    home,
    bounds,
    0,
  );
  assert.ok(logs.transcriptSessions >= 1);
  assert.ok(logs.sessions.size >= 1);

  const assembled = assembleProfile({
    reports: toReports(logs),
    hits: [],
    period: "2026-10",
    plans: [],
    source: "cursor",
    utcOffsetMinutes: 0,
    estimateTokens: true,
    limitHitsKnown: true,
  });
  assert.ok(assembled.profile);
  assert.equal(assembled.profile.agent_hours.source, "cursor");
  assert.ok(assembled.profile.agent_hours.value > 0);
  assert.equal(assembled.profile.by_model.provenance, "estimated");
});
