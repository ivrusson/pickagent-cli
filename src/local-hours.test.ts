import assert from "node:assert/strict";
import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { claudeConfigDirs, readClaudeLogs } from "./claude-jsonl";
import {
  applyHourFills,
  readAntigravityFill,
  readCodexHourFill,
  readGeminiFill,
  readKimiFill,
  readOpenCodeFill,
  summarizeSpans,
} from "./local-hours";
import { mergeProfileParts } from "./profile/merge-sources";
import { estimated, type Profile } from "./profile/profile";
import { orchestrator } from "./profile/fixtures/orchestrator";

const SECRET = "SECRET_PROMPT do not leak";
const bounds = {
  start: Date.parse("2026-10-01T00:00:00.000Z"),
  end: Date.parse("2026-11-01T00:00:00.000Z"),
};

test("registry config_dir is read and secrets are not", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-reg-"));
  const profile = join(home, "profiles", "extra");
  const def = join(home, ".claude");
  await mkdir(profile, { recursive: true });
  await mkdir(def, { recursive: true });
  await mkdir(join(home, ".claude-subs"), { recursive: true });
  await writeFile(
    join(home, ".claude-subs", "registry.json"),
    JSON.stringify({
      profiles: {
        extra: {
          config_dir: profile,
          env: { TOKEN: SECRET },
          sensitive_env: [SECRET],
        },
        again: { config_dir: profile },
      },
    }),
  );
  const dirs = await claudeConfigDirs(
    { CLAUDE_CONFIG_DIR: `${profile},~/also-missing` },
    home,
  );
  const resolved = await realpath(profile);
  assert.equal(dirs.filter((dir) => dir === resolved).length, 1);
  assert.ok(dirs.some((dir) => dir.endsWith(".claude")));
  assert.equal(JSON.stringify(dirs).includes(SECRET), false);
});

test("claude usage is summed across config directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-sum-"));
  const line = (id: string, input: number) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-05T08:00:00.000Z",
      sessionId: id,
      message: {
        id,
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: SECRET }],
        usage: { input_tokens: input, output_tokens: 1 },
      },
    });
  for (const [name, input] of [["a", 100], ["b", 50]] as const) {
    const dir = join(home, name, "projects", "hidden");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.jsonl"), `${line(name, input)}\n`);
  }
  const logs = await readClaudeLogs([join(home, "a"), join(home, "b")], bounds, 0);
  let input = 0;
  for (const models of logs.daily.values()) {
    for (const tokens of models.values()) input += tokens.input;
  }
  assert.equal(input, 150);
  assert.equal(logs.sessions.size, 2);
  assert.equal(JSON.stringify(toPublic(logs)).includes(SECRET), false);
});

function toPublic(logs: { hits: unknown; sessions: Map<string, unknown>; daily: Map<string, unknown> }) {
  return { hits: logs.hits.length, sessions: logs.sessions.size, days: logs.daily.size };
}

test("kimi hours come from both homes and stay estimated", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-kimi-"));
  const writeState = async (root: string, name: string, start: number, end: number) => {
    const dir = join(root, "sessions", "wd", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        createdAt: start,
        updatedAt: end,
        lastPrompt: SECRET,
        cwd: "/secret/project",
        title: SECRET,
      }),
    );
  };
  const start = Date.parse("2026-10-05T08:00:00.000Z");
  await writeState(join(home, ".kimi-code"), "one", start, start + 3_600_000);
  await writeState(join(home, ".kimi"), "two", start + 86_400_000, start + 86_400_000 + 3_600_000);
  const fill = await readKimiFill(home, bounds, 0);
  assert.ok(fill);
  assert.equal(fill.source, "kimi-cli");
  assert.ok(fill.hours >= 2);
  assert.equal(fill.activeDays, 2);
  assert.equal(JSON.stringify(fill).includes(SECRET), false);
  assert.equal(JSON.stringify(fill).includes("/secret"), false);
});

test("opencode hours come from session timestamps", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-oc-"));
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2 (
    time_created INTEGER, time_updated INTEGER,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
    tokens_cache_read INTEGER, tokens_cache_write INTEGER, model TEXT,
    title TEXT, directory TEXT
  )`);
  const start = Date.parse("2026-10-06T10:00:00.000Z");
  db.prepare(
    `INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(start, start + 2 * 3_600_000, 100, 40, 10, 5, 1, "claude-sonnet-4", SECRET, "/secret/path");
  db.close();
  const fill = await readOpenCodeFill(home, bounds, 0);
  assert.ok(fill);
  assert.ok(fill.hours >= 2);
  assert.equal(fill.activeDays, 1);
  assert.equal(fill.tokens?.[0]?.model, "claude-sonnet");
  assert.equal(JSON.stringify(fill).includes(SECRET), false);
  assert.equal(JSON.stringify(fill).includes("/secret"), false);
});

test("codex hours come from rollout timestamps", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-codex-hours-"));
  const dir = join(home, ".codex", "sessions", "2026", "10", "05");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "rollout-1.jsonl"),
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-10-05T08:00:00.000Z",
        payload: { originator: "codex_cli", cwd: "/secret/path" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-10-05T08:01:00.000Z",
        payload: { content: SECRET },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-05T10:00:00.000Z",
        payload: { type: "token_count" },
      }),
    ].join("\n"),
  );
  const fill = await readCodexHourFill({}, home, bounds, 0);
  assert.ok(fill);
  assert.equal(fill.source, "codex");
  assert.ok(fill.hours >= 1.5);
  assert.equal(JSON.stringify(fill).includes(SECRET), false);
  assert.equal(JSON.stringify(fill).includes("/secret"), false);
});

test("gemini and antigravity contribute estimated hours without message text", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-gem-"));
  const chat = join(home, ".gemini", "tmp", "proj", "chats");
  await mkdir(chat, { recursive: true });
  await writeFile(
    join(chat, "session.json"),
    JSON.stringify({
      messages: [{ content: SECRET, timestamp: "2026-10-07T09:00:00.000Z" }],
      usage: { input_tokens: 10, output_tokens: 4 },
      model: "gemini-2.5-pro",
      endTime: "2026-10-07T10:00:00.000Z",
    }),
  );
  const gemini = await readGeminiFill(home, bounds, 0);
  assert.ok(gemini);
  assert.equal(gemini.source, "gemini-cli");
  assert.ok(gemini.hours > 0);
  assert.equal(gemini.tokens?.[0]?.model, "gemini-pro");
  assert.equal(JSON.stringify(gemini).includes(SECRET), false);

  const conv = join(home, ".gemini", "antigravity", "conversations");
  await mkdir(conv, { recursive: true });
  const file = join(conv, "thread.pb");
  await writeFile(file, Buffer.from("not a message"));
  const when = new Date("2026-10-08T12:00:00.000Z");
  const later = new Date("2026-10-08T13:00:00.000Z");
  await utimes(file, when, later);
  const anti = await readAntigravityFill(home, bounds, 0);
  assert.ok(anti);
  assert.equal(anti.source, "antigravity");
  assert.ok(anti.hours > 0);
  assert.equal(JSON.stringify(anti).includes("thread"), false);
});

test("a point-in-time session counts one minute", () => {
  const at = Date.parse("2026-10-06T12:00:00.000Z");
  const stats = summarizeSpans([{ start: at, end: at }], bounds, 0);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.hours, 0.1);
  assert.equal(stats.activeDays, 1);
});

test("summarizeSpans caps a long session and counts days", () => {
  const start = Date.parse("2026-10-05T00:00:00.000Z");
  const stats = summarizeSpans(
    [{ start, end: start + 48 * 3_600_000 }],
    bounds,
    0,
  );
  assert.equal(stats.hours, 8);
  assert.equal(stats.sessions, 1);
  assert.ok(stats.activeDays >= 1);
});

test("measured hours stay primary when Cursor is larger and estimated", () => {
  const cursor: Profile = {
    ...structuredClone(orchestrator),
    plans: [],
    provenance: { cursor: "estimated" },
    agent_hours: estimated(400, "cursor"),
    activity: estimated(orchestrator.activity.value, "cursor"),
    by_model: estimated(orchestrator.by_model.value, "cursor"),
    tokens: estimated(orchestrator.tokens!.value, "cursor"),
    active_days: estimated(20, "cursor"),
    sessions: estimated({ count: 527, median_minutes: 1 }, "cursor"),
    by_source: {
      cursor: { agent_hours: 400, provenance: "estimated", sessions: 527, active_days: 20 },
    },
  };
  const claude: Profile = {
    ...structuredClone(orchestrator),
    by_source: {
      "claude-code": { agent_hours: 142, provenance: "measured", sessions: 160, active_days: 21 },
    },
  };
  const merged = mergeProfileParts([claude, cursor], ["claude-pro"]);
  assert.ok(merged);
  assert.equal(merged.agent_hours.source, "claude-code");
  assert.equal(merged.by_source?.cursor?.provenance, "estimated");
  assert.equal(merged.sessions?.value.count, 160);
  assert.equal(merged.by_source?.cursor?.sessions, 527);
});

test("a measured Cursor placeholder does not outrank Claude", () => {
  const base: Profile = {
    ...structuredClone(orchestrator),
    agent_hours: estimated(50, "claude-code"),
    provenance: { "claude-code": "measured", cursor: "measured" },
    by_source: {
      "claude-code": { agent_hours: 50, provenance: "estimated", active_days: 9 },
      cursor: { agent_hours: 0, provenance: "measured" },
    },
  };
  const cursor: Profile = {
    ...structuredClone(orchestrator),
    plans: [],
    provenance: { cursor: "estimated" },
    agent_hours: estimated(400, "cursor"),
    activity: estimated(orchestrator.activity.value, "cursor"),
    by_model: estimated(orchestrator.by_model.value, "cursor"),
    active_days: estimated(12, "cursor"),
    sessions: estimated({ count: 40, median_minutes: 1 }, "cursor"),
    by_source: {
      cursor: { agent_hours: 400, provenance: "estimated", sessions: 40, active_days: 12 },
    },
  };
  const merged = mergeProfileParts([base, cursor], ["claude-pro"]);
  assert.ok(merged);
  assert.equal(merged.agent_hours.source, "claude-code");
  assert.equal(merged.provenance.cursor, "estimated");
  assert.equal(merged.by_source?.cursor?.provenance, "estimated");
  assert.equal(merged.by_source?.cursor?.agent_hours, 400);
  assert.equal(merged.sessions?.value.count, orchestrator.sessions?.value.count);
});

test("a zero-hour slice picks up estimated timestamp hours", () => {
  const base: Profile = {
    ...structuredClone(orchestrator),
    by_source: {
      "claude-code": { agent_hours: 142, provenance: "measured", active_days: 21 },
      opencode: { agent_hours: 0, provenance: "measured", active_days: 4 },
    },
    provenance: { "claude-code": "measured", opencode: "measured" },
  };
  const next = applyHourFills(base, [
    { source: "opencode", hours: 3.5, activeDays: 4, sessions: 2 },
  ]);
  assert.equal(next.by_source?.opencode?.agent_hours, 3.5);
  assert.equal(next.by_source?.opencode?.provenance, "estimated");
  assert.equal(next.agent_hours.source, "claude-code");
  assert.ok(next.agent_hours.value > orchestrator.agent_hours.value);
});
