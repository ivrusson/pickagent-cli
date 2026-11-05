import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProfile } from "../../../src/lib/engine";
import { ccusageArgv, envForCcusage, type CcusageLoad } from "./ccusage-run";
import { runScan, type ScanIo } from "./scan";

const now = new Date("2026-11-05T12:00:00.000Z");

const daily = {
  daily: [
    {
      date: "2026-10-05",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 100,
      cacheReadTokens: 500,
      modelsUsed: ["claude-sonnet-4-5-20250929"],
      modelBreakdowns: [
        {
          modelName: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 100,
          cacheReadTokens: 500,
        },
      ],
    },
  ],
};

const sessions = {
  sessions: [
    {
      models: ["claude-sonnet-4-5-20250929"],
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 100,
      cacheReadTokens: 500,
      firstActivity: "2026-10-05T08:00:00.000Z",
      lastActivity: "2026-10-05T10:00:00.000Z",
      modelBreakdowns: [
        {
          modelName: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 100,
          cacheReadTokens: 500,
        },
      ],
    },
  ],
};

function io(load: CcusageLoad, home: string): ScanIo & { out: string; err: string; opened: string[] } {
  const state = { out: "", err: "", opened: [] as string[] };
  return {
    ...state,
    env: {},
    home,
    now,
    timeZone: "UTC",
    isTTY: true,
    loadCcusage: () => Promise.resolve(load),
    stdout: (text) => {
      state.out += text;
    },
    stderr: (text) => {
      state.err += text;
    },
    prompt: () => Promise.resolve("n"),
    open: (url) => {
      state.opened.push(url);
      return Promise.resolve();
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
    get opened() {
      return state.opened;
    },
  };
}

test("ccusage JSON is printed as a valid profile and the browser stays shut", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-empty-"));
  const scan = io({ failed: false, reports: { daily, sessions } }, home);
  const code = await runScan(
    ["scan", "--period", "2026-10", "--plan", "claude-pro", "--json", "--no-open"],
    scan,
  );
  assert.equal(code, 0);
  assert.equal(scan.opened.length, 0);
  assert.equal(scan.out.includes("SECRET"), false);
  const parsed = parseProfile(JSON.parse(scan.out) as unknown);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.profile.schema, "pickagent.profile/v1");
    assert.equal(parsed.profile.agent_hours.provenance, "measured");
    assert.deepEqual(parsed.profile.plans, ["claude-pro"]);
  }
});

test("a machine without logs exits non-zero and does not throw", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-none-"));
  const scan = io({ failed: true, reports: {} }, home);
  const code = await runScan(["scan", "--period", "2026-10", "--json", "--no-open"], scan);
  assert.equal(code, 1);
  assert.equal(scan.out, "");
  assert.match(scan.err, /No hay un perfil válido/);
  assert.equal(scan.err.includes("ccusage no informa"), false);
  assert.equal(scan.opened.length, 0);
});

test("ccusage is focused on Claude and the child env has no API keys", () => {
  assert.deepEqual(ccusageArgv("daily", "2026-10-01", "2026-10-31", "Europe/Madrid"), [
    "--yes",
    "ccusage@latest",
    "claude",
    "daily",
    "--json",
    "--no-cost",
    "--offline",
    "--since",
    "2026-10-01",
    "--until",
    "2026-10-31",
    "--timezone",
    "Europe/Madrid",
    "--breakdown",
  ]);
  const blocks = ccusageArgv("blocks", "2026-10-01", "2026-10-31", null);
  assert.equal(blocks.includes("claude"), false);
  assert.equal(blocks.includes("--breakdown"), false);
  assert.ok(blocks.includes("blocks"));

  const env = envForCcusage({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    OPENAI_API_KEY: "sk-secret",
    CLAUDE_CONFIG_DIR: "/tmp/claude",
    CODEX_HOME: "/tmp/codex",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude");
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.LOG_LEVEL, "0");
  assert.equal(JSON.stringify(env).includes("sk-secret"), false);
});

test("--yes opens the verdict URL and a refusal does not", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-open-"));
  const opened = io({ failed: false, reports: { daily, sessions } }, home);
  const code = await runScan(["scan", "--period", "2026-10", "--yes"], opened);
  assert.equal(code, 0);
  assert.equal(opened.opened.length, 1);
  assert.match(opened.opened[0] ?? "", /^https:\/\/pickagent\.dev\/es\/veredicto#p=/);
  assert.match(opened.out, /medido/);
  assert.match(opened.out, /2026-10/);

  const refused = io({ failed: false, reports: { daily, sessions } }, home);
  const declined = await runScan(["scan", "--period", "2026-10"], refused);
  assert.equal(declined, 0);
  assert.equal(refused.opened.length, 0);
});
