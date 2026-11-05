import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readClaudeLogs } from "./claude-jsonl";
import { readCodexLogs } from "./codex-rollout";

const bounds = {
  start: Date.parse("2026-10-01T00:00:00.000Z"),
  end: Date.parse("2026-11-01T00:00:00.000Z"),
};

function limitRow(id: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    error: "rate_limit",
    isApiErrorMessage: true,
    message: {
      id,
      model: "<synthetic>",
      content: [
        {
          type: "text",
          text: "You've hit your session limit · resets 1:50pm (Europe/London)",
        },
      ],
    },
  });
}

test("claude: a replayed limit row counts once per message id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pickagent-claude-dedupe-"));
  const dir = join(root, "projects", "p");
  await mkdir(dir, { recursive: true });
  // Same message id replayed with a later timestamp (resumed session), in two
  // files; plus a second, distinct limit message.
  await writeFile(
    join(dir, "a.jsonl"),
    `${limitRow("msg_limit_1", "2026-10-05T09:00:00.000Z")}\n${limitRow("msg_limit_1", "2026-10-05T09:00:30.000Z")}\n`,
  );
  await writeFile(
    join(dir, "b.jsonl"),
    `${limitRow("msg_limit_1", "2026-10-05T09:01:00.000Z")}\n${limitRow("msg_limit_2", "2026-10-06T09:00:00.000Z")}\n`,
  );
  const logs = await readClaudeLogs([root], bounds, 0);
  assert.equal(logs.hits.length, 2);
});

function codexTokenCount(timestamp: string, resetsAtSec: number): object {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        rate_limit_reached_type: "primary",
        primary: { used_percent: 100, resets_at: resetsAtSec },
      },
    },
  };
}

test("codex: events in one window share resets_at and count once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pickagent-codex-dedupe-"));
  const dir = join(root, "sessions", "2026", "10", "05");
  await mkdir(dir, { recursive: true });
  const first = Date.parse("2026-10-05T09:00:00.000Z");
  const windowA = Math.round(first / 1000) + 3 * 3600;
  const windowB = windowA + 5 * 3600;
  const lines = [
    {
      timestamp: "2026-10-05T08:00:00.000Z",
      type: "session_meta",
      payload: { originator: "Codex Desktop" },
    },
    codexTokenCount("2026-10-05T09:00:00.000Z", windowA),
    codexTokenCount("2026-10-05T09:00:07.000Z", windowA),
    codexTokenCount("2026-10-05T09:20:00.000Z", windowA),
    codexTokenCount("2026-10-05T15:00:00.000Z", windowB),
    codexTokenCount("2026-10-05T15:00:09.000Z", windowB),
  ];
  await writeFile(
    join(dir, "rollout-a.jsonl"),
    `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const logs = await readCodexLogs(root, bounds, 0);
  assert.equal(logs.hits.length, 2);
  assert.deepEqual(
    logs.hits.map((hit) => hit.at),
    [first, Date.parse("2026-10-05T15:00:00.000Z")],
  );
});
