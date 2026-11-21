import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProfile, type Profile } from "./profile";
import { orchestrator } from "./profile/fixtures/orchestrator";
import { applyPriceSpecs, withDeclaredPlans } from "./plan-interview";
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
      verbose: false,
      prices: [],
    },
    io,
  );
  assert.equal(io.prompts.length, 0);
  assert.equal(result.profile.plan_prices?.["claude-pro"]?.amount, 22);
  assert.equal(parseProfile(result.profile).ok, true);
});

test("a --price plan stays when the profile already lists ten plans", () => {
  const saved = Array.from({ length: 10 }, (_, index) => `saved-${index}`);
  const profile = baseProfile(saved);
  const next = applyPriceSpecs(profile, [
    { planId: "extra-plan", amount: 20, currency: "EUR", billing: "monthly" },
  ]);
  assert.equal(next.plans[0], "extra-plan");
  assert.equal(next.plans.length, 10);
  assert.equal(next.plan_prices?.["extra-plan"]?.amount, 20);
  assert.equal(next.plans.includes("saved-9"), false);
  assert.equal(parseProfile(next).ok, true);

  const overridden = applyPriceSpecs(profile, [
    { planId: "saved-3", amount: 12, currency: "USD", billing: "yearly" },
  ]);
  assert.equal(overridden.plans.length, 10);
  assert.equal(overridden.plan_prices?.["saved-3"]?.amount, 12);
  assert.deepEqual([...overridden.plans].sort(), [...saved].sort());
});

test("a TTY does not prompt inside the silent plan fill", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-plan-tty-"));
  const io = mockIo(home, ["claude-pro", "20", "EUR", "monthly"], true);
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
      verbose: false,
      prices: [],
    },
    io,
  );
  assert.equal(io.prompts.length, 0);
  assert.deepEqual(result.profile.plans, []);
});