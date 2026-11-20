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
  // birthtime is not settable; the span uses mtime as its end.
  await utimes(file, start, end);

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
    estimateTime: true,
    limitHitsKnown: true,
  });
  assert.ok(assembled.profile);
  assert.equal(assembled.profile.agent_hours.source, "cursor");
  assert.equal(assembled.profile.agent_hours.provenance, "estimated");
  assert.equal(assembled.profile.provenance.cursor, "estimated");
  assert.equal(assembled.profile.sessions?.provenance, "estimated");
  assert.ok(assembled.profile.agent_hours.value > 0);
  assert.equal(assembled.profile.by_model.provenance, "estimated");
});

test("cursor sessions group files in one conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-cursor-group-"));
  const root = join(home, ".cursor", "projects", "demo", "agent-transcripts");
  const one = join(root, "conv-a");
  const two = join(root, "conv-b");
  await mkdir(one, { recursive: true });
  await mkdir(two, { recursive: true });
  const when = new Date("2026-10-05T08:00:00.000Z");
  const later = new Date("2026-10-05T09:00:00.000Z");
  for (const file of [join(one, "a.jsonl"), join(one, "sub.jsonl")]) {
    await writeFile(file, "{}\n");
    await utimes(file, when, later);
  }
  await writeFile(join(two, "b.jsonl"), "{}\n");
  await utimes(join(two, "b.jsonl"), when, later);
  const logs = await readCursorUsage(
    { CURSOR_PROJECTS_DIR: join(home, ".cursor", "projects") },
    home,
    {
      start: Date.parse("2026-10-01T00:00:00.000Z"),
      end: Date.parse("2026-11-01T00:00:00.000Z"),
    },
    0,
  );
  assert.equal(logs.sessions.size, 2);
  assert.equal(logs.transcriptSessions, 2);
});
