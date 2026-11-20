import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProfile, type Profile } from "./profile";
import { orchestrator } from "./profile/fixtures/orchestrator";
import { withDeclaredPlans } from "./plan-interview";
import {
  declaredPrice,
  saveScannerConfig,
  scannerConfigPath,
} from "./scanner-config";
import type { ScanIo } from "./scan";

function baseProfile(plans: string[]): Profile {
  const profile = structuredClone(orchestrator);
  profile.period = "2026-10";
  profile.plans = plans;
  delete profile.plan_prices;
  return profile;
}

function mockIo(
  home: string,
  answers: string[],
  isTTY: boolean,
): ScanIo & { prompts: string[] } {
  let i = 0;
  const prompts: string[] = [];
  return {
    env: {},
    home,
    now: new Date("2026-11-05T12:00:00.000Z"),
    timeZone: "UTC",
    isTTY,
    loadCcusage: async () => ({ failed: true, reports: {} }),
    stdout: () => {},
    stderr: () => {},
    prompt: async (question) => {
      prompts.push(question);
      return answers[i++] ?? "";
    },
    open: async () => {},
    prompts,
  };
}

test("non-interactive scan applies saved prices without prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-plan-silent-"));
  await saveScannerConfig(scannerConfigPath(home), {
    plans: ["claude-pro"],
    plan_prices: {
      "claude-pro": declaredPrice({
        amount: 22,
        currency: "USD",
        billing: "monthly",
      }),
    },
  });
  const io = mockIo(home, [], false);
  const result = await withDeclaredPlans(
    baseProfile(["claude-pro"]),
    {
      period: "2026-10",
      plans: ["claude-pro"],
      json: true,
      yes: false,
      noOpen: true,
      baseUrl: "https://pickagent.dev",
      lang: null,
      codex: false,
    },
    io,
  );
  assert.equal(io.prompts.length, 0);
  assert.equal(result.profile.plan_prices?.["claude-pro"]?.amount, 22);
  assert.equal(parseProfile(result.profile).ok, true);
});

test("interactive scan asks once and writes config", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-plan-ask-"));
  const io = mockIo(
    home,
    ["claude-pro", "20", "EUR", "monthly"],
    true,
  );
  const result = await withDeclaredPlans(
    baseProfile([]),
    {
      period: "2026-10",
      plans: [],
      json: false,
      yes: false,
      noOpen: true,
      baseUrl: "https://pickagent.dev",
      lang: null,
      codex: false,
    },
    io,
  );
  assert.ok(io.prompts.length >= 2);
  assert.deepEqual(result.profile.plans, ["claude-pro"]);
  assert.equal(result.profile.plan_prices?.["claude-pro"]?.amount, 20);
  const saved = await import("./scanner-config.js").then((m) =>
    m.loadScannerConfig(m.scannerConfigPath(home)),
  );
  assert.equal(saved.plan_prices?.["claude-pro"]?.currency, "EUR");
});

test("an unmapped local tier asks for a plan instead of leaving it out", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-plan-unmapped-"));
  const io = mockIo(
    home,
    ["cursor-ultra-legacy", "18", "EUR", "monthly", "200", "USD", "yearly"],
    true,
  );
  const result = await withDeclaredPlans(
    baseProfile(["chatgpt-plus"]),
    {
      period: "2026-10",
      plans: [],
      json: false,
      yes: false,
      noOpen: true,
      baseUrl: "https://pickagent.dev",
      lang: null,
      codex: false,
    },
    io,
    { unmapped: true },
  );
  assert.ok(io.prompts[0]?.includes("Plan you pay for"));
  assert.ok(result.profile.plans.includes("chatgpt-plus"));
  assert.ok(result.profile.plans.includes("cursor-ultra-legacy"));
});