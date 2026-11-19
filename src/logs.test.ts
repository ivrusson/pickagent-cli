import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeProfile, profileToHash } from "./profile";
import { assembleProfile } from "./assemble";
import { readClaudeLogs } from "./claude-jsonl";
import { readCodexLogs } from "./codex-rollout";
import { sanitizeReports } from "./ccusage-run";
import { toReports } from "./reports";

const SECRET_PROMPT = "SECRET_PROMPT do not leak";
const SECRET_PATH = "/Users/secret/client/file.ts";
const SECRET_DIR = "Users-secret-client";
const SECRET_SESSION = "sess-SECRET-id";

const sonnet = "claude-sonnet-4-5-20250929";

function claudeLine(row: unknown): string {
  return JSON.stringify(row);
}

async function claudeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pickagent-claude-"));
  const dir = join(root, "projects", SECRET_DIR);
  await mkdir(dir, { recursive: true });
  const lines = [
    claudeLine({
      type: "user",
      cwd: SECRET_PATH,
      sessionId: SECRET_SESSION,
      message: { content: SECRET_PROMPT },
    }),
    claudeLine({
      type: "assistant",
      timestamp: "2026-10-05T08:00:00.000Z",
      sessionId: SECRET_SESSION,
      cwd: SECRET_PATH,
      message: {
        id: "msg_1",
        model: sonnet,
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 5000,
        },
        content: [{ type: "text", text: `SECRET_REPLY ${SECRET_PATH}` }],
      },
    }),
    claudeLine({
      type: "assistant",
      timestamp: "2026-10-05T08:00:01.000Z",
      sessionId: SECRET_SESSION,
      message: {
        id: "msg_1",
        model: sonnet,
        usage: { input_tokens: 99999, output_tokens: 99999 },
        content: [{ type: "text", text: SECRET_PROMPT }],
      },
    }),
    claudeLine({
      type: "assistant",
      timestamp: "2026-10-05T10:00:00.000Z",
      sessionId: SECRET_SESSION,
      message: {
        id: "msg_2",
        model: sonnet,
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 2000,
        },
      },
    }),
    claudeLine({
      type: "assistant",
      timestamp: "2026-10-05T09:00:00.000Z",
      sessionId: SECRET_SESSION,
      error: "rate_limit",
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        model: "<synthetic>",
        content: [
          {
            type: "text",
            text: "You've hit your session limit · resets 1:50pm (Europe/London)",
          },
        ],
      },
    }),
    claudeLine({
      type: "assistant",
      timestamp: "2026-10-05T09:05:00.000Z",
      error: "rate_limit",
      isApiErrorMessage: true,
      message: {
        content: [
          {
            type: "text",
            text: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
          },
        ],
      },
    }),
  ];
  await writeFile(join(dir, "sess.jsonl"), `${lines.join("\n")}\n`);
  await writeFile(join(dir, "notes.txt"), SECRET_PROMPT);
  return root;
}

test("fallback jsonl becomes a measured profile with one usage block", async () => {
  const root = await claudeFixture();
  const bounds = {
    start: Date.parse("2026-10-01T00:00:00.000Z"),
    end: Date.parse("2026-11-01T00:00:00.000Z"),
  };
  const logs = await readClaudeLogs([root], bounds, 0);
  const assembled = assembleProfile({
    reports: toReports(logs),
    hits: logs.hits,
    period: "2026-10",
    plans: ["claude-pro"],
    source: "claude-code",
    utcOffsetMinutes: 0,
  });
  assert.ok(assembled.profile, JSON.stringify(assembled.issues));
  const profile = assembled.profile;
  assert.equal(profile.provenance["claude-code"], "measured");
  assert.equal(profile.agent_hours.provenance, "measured");
  assert.equal(profile.tokens?.value[0]?.input, 1500);
  assert.equal(profile.blocks?.value.count, 1);
  assert.equal(profile.blocks?.provenance, "measured");
  assert.equal(profile.blocks?.value.worst?.hour, 9);
  assert.equal(profile.blocks?.value.worst?.wait_hours, 4);
  assert.equal(profile.plans[0], "claude-pro");

  const encoded = `${JSON.stringify(profile)}\n${encodeProfile(profile)}\n${profileToHash(profile)}`;
  for (const secret of [SECRET_PROMPT, SECRET_PATH, SECRET_DIR, SECRET_SESSION, "SECRET_REPLY", "msg_1"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test("codex rollout is experimental and drops prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pickagent-codex-"));
  const dir = join(root, "sessions", "2026", "10", "05");
  await mkdir(dir, { recursive: true });
  const first = Date.parse("2026-10-05T08:05:00.000Z");
  const second = Date.parse("2026-10-05T09:00:00.000Z");
  const lines = [
    {
      timestamp: "2026-10-05T08:00:00.000Z",
      type: "session_meta",
      payload: {
        id: SECRET_SESSION,
        cwd: SECRET_PATH,
        originator: "Codex Desktop",
      },
    },
    {
      timestamp: "2026-10-05T08:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.4", cwd: SECRET_PATH },
    },
    {
      timestamp: "2026-10-05T08:00:02.000Z",
      type: "response_item",
      payload: { type: "message", content: `${SECRET_PROMPT} ${SECRET_PATH}` },
    },
    {
      timestamp: "2026-10-05T08:05:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            output_tokens: 100,
            reasoning_output_tokens: 20,
            total_tokens: 1120,
          },
          total_token_usage: { input_tokens: 99999, output_tokens: 99999 },
        },
        rate_limits: { rate_limit_reached_type: null },
      },
    },
    {
      timestamp: "2026-10-05T09:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 100,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 550,
          },
        },
        rate_limits: {
          rate_limit_reached_type: "primary",
          primary: { used_percent: 100, resets_at: Math.round(second / 1000) + 3 * 3600 },
        },
      },
    },
  ];
  await writeFile(
    join(dir, "rollout-secret.jsonl"),
    `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeFile(join(dir, "notes.jsonl"), JSON.stringify({ content: SECRET_PROMPT }));
  await writeFile(
    join(root, "sessions", "other.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { originator: "not-codex", cwd: SECRET_PATH } }),
  );

  const logs = await readCodexLogs(
    root,
    { start: first - 86_400_000, end: second + 86_400_000 },
    0,
  );
  const assembled = assembleProfile({
    reports: toReports(logs),
    hits: logs.hits,
    period: "2026-10",
    plans: [],
    source: "codex",
    utcOffsetMinutes: 0,
    estimateTokens: true,
    extraWarnings: ["codex_experimental"],
  });
  assert.ok(assembled.profile, JSON.stringify(assembled.issues));
  const profile = assembled.profile;
  assert.equal(profile.provenance.codex, "measured");
  assert.equal(profile.tokens?.provenance, "estimated");
  assert.equal(profile.by_model.provenance, "estimated");
  assert.equal(profile.tokens?.value[0]?.model, "gpt");
  assert.equal(profile.tokens?.value[0]?.input, 1000);
  assert.equal(profile.tokens?.value[0]?.output, 170);
  assert.equal(profile.tokens?.value[0]?.cache_read, 500);
  assert.equal(profile.tokens?.value[0]?.cache_write, 0);
  assert.equal(profile.blocks?.value.count, 1);
  assert.equal(profile.blocks?.value.worst?.wait_hours, 3);
  assert.ok(assembled.warnings.includes("codex_experimental"));

  const encoded = `${JSON.stringify(profile)}\n${profileToHash(profile)}`;
  for (const secret of [SECRET_PROMPT, SECRET_PATH, SECRET_SESSION, "primary", "99999"]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test("ccusage JSON drops paths before it becomes a profile", () => {
  const clean = sanitizeReports({
    daily: {
      daily: [
        {
          date: "2026-10-05",
          projectPath: SECRET_PATH,
          session: SECRET_SESSION,
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 100,
          cacheReadTokens: 500,
          modelsUsed: [sonnet],
          modelBreakdowns: [
            {
              modelName: sonnet,
              inputTokens: 1000,
              outputTokens: 200,
              cacheCreationTokens: 100,
              cacheReadTokens: 500,
              cwd: SECRET_PATH,
            },
          ],
        },
      ],
      projects: {
        [SECRET_DIR]: [{ date: "2026-10-06", inputTokens: 1, modelsUsed: [sonnet] }],
      },
    },
    sessions: {
      sessions: [
        {
          session: SECRET_SESSION,
          projectPath: SECRET_PATH,
          models: [sonnet],
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 100,
          cacheReadTokens: 500,
          firstActivity: "2026-10-05T08:00:00.000Z",
          lastActivity: "2026-10-05T10:00:00.000Z",
          modelBreakdowns: [
            {
              modelName: sonnet,
              inputTokens: 1000,
              outputTokens: 200,
              cacheCreationTokens: 100,
              cacheReadTokens: 500,
            },
          ],
        },
      ],
    },
  });
  const serialized = JSON.stringify(clean);
  assert.equal(serialized.includes(SECRET_PATH), false);
  assert.equal(serialized.includes(SECRET_DIR), false);
  assert.equal(serialized.includes(SECRET_SESSION), false);

  const assembled = assembleProfile({
    reports: clean,
    hits: [],
    period: "2026-10",
    plans: ["claude-pro"],
    source: "claude-code",
    utcOffsetMinutes: 0,
  });
  assert.ok(assembled.profile, JSON.stringify(assembled.issues));
  assert.equal(assembled.profile.agent_hours.provenance, "measured");
  assert.equal(assembled.profile.agent_hours.value, 2);
  const encoded = `${JSON.stringify(assembled.profile)}\n${profileToHash(assembled.profile)}`;
  for (const secret of [SECRET_PROMPT, SECRET_PATH, SECRET_DIR, SECRET_SESSION]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

test("fallback jsonl folds claude-fable-* into claude-fable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pickagent-fable-"));
  const dir = join(root, "projects", SECRET_DIR);
  await mkdir(dir, { recursive: true });
  const turn = (id: string, at: string, model: string, input: number) =>
    claudeLine({
      type: "assistant",
      timestamp: at,
      sessionId: SECRET_SESSION,
      message: { id, model, usage: { input_tokens: input, output_tokens: input / 10 } },
    });
  await writeFile(
    join(dir, "sess.jsonl"),
    `${[
      turn("msg_1", "2026-11-02T08:00:00.000Z", "claude-opus-5-5", 3000),
      turn("msg_2", "2026-11-02T09:00:00.000Z", "claude-fable-5-1", 1000),
    ].join("\n")}\n`,
  );
  const logs = await readClaudeLogs(
    [root],
    { start: Date.parse("2026-11-01T00:00:00.000Z"), end: Date.parse("2026-12-01T00:00:00.000Z") },
    0,
  );
  const assembled = assembleProfile({
    reports: toReports(logs),
    hits: logs.hits,
    period: "2026-11",
    plans: ["claude-max-5x"],
    source: "claude-code",
    utcOffsetMinutes: 0,
  });
  assert.ok(assembled.profile, JSON.stringify(assembled.issues));
  assert.deepEqual(assembled.profile.by_model.value, { "claude-opus": 0.75, "claude-fable": 0.25 });
  assert.deepEqual(
    assembled.profile.tokens?.value.map((r) => r.model),
    ["claude-opus", "claude-fable"],
  );
});
