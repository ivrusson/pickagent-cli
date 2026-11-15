import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDetectedPlans,
  detectPlans,
  jsonStringValue,
  mapClaudeTier,
  mapCodexPlanType,
} from "./detect-plans";

test("mapClaudeTier prefers max/pro consumer tiers", () => {
  assert.equal(mapClaudeTier("default_claude_max_5x"), "claude-max-5x");
  assert.equal(mapClaudeTier("default_claude_max_20x"), "claude-ultra");
  assert.equal(mapClaudeTier("claude_pro"), "claude-pro");
  assert.equal(mapClaudeTier("pro"), "claude-pro");
  assert.equal(mapClaudeTier("default_raven_enterprise"), null);
  assert.equal(mapClaudeTier("enterprise_usage_based"), null);
});

test("mapCodexPlanType covers ChatGPT plan_type values", () => {
  assert.equal(mapCodexPlanType("go"), "chatgpt-go");
  assert.equal(mapCodexPlanType("plus"), "chatgpt-plus");
  assert.equal(mapCodexPlanType("prolite"), "chatgpt-pro-100");
  assert.equal(mapCodexPlanType("pro"), "chatgpt-pro-200");
  assert.equal(mapCodexPlanType("promax"), "chatgpt-pro-500");
  assert.equal(mapCodexPlanType("free"), null);
});

test("jsonStringValue reads the first plain string", () => {
  const text = '{"a":null,"organizationRateLimitTier":"default_claude_max_5x","b":1}';
  assert.equal(jsonStringValue(text, "organizationRateLimitTier"), "default_claude_max_5x");
  assert.equal(jsonStringValue(text, "missing"), null);
});

function jwtWithPlan(plan: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_plan_type: plan },
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("detectPlans reads Claude account file and Codex JWT", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-plans-"));
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        organizationRateLimitTier: "default_claude_max_5x",
      },
    }),
  );
  await mkdir(join(home, ".codex"));
  await writeFile(
    join(home, ".codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: jwtWithPlan("plus") },
    }),
  );

  const detected = await detectPlans({ home, env: {} });
  assert.deepEqual(detected.plans, ["claude-max-5x", "chatgpt-plus"]);
  assert.equal(detected.detections[0]?.source, "claude-code");
  assert.equal(detected.detections[1]?.source, "codex");
});

test("applyDetectedPlans fills plans and by_source.plan; CLI wins", () => {
  const base: {
    plans: string[];
    provenance: Partial<Record<"claude-code" | "codex", "measured" | "estimated">>;
    by_source: Partial<
      Record<
        "claude-code" | "codex",
        {
          agent_hours: number;
          provenance: "measured" | "estimated";
          plan?: string;
        }
      >
    >;
  } = {
    plans: [],
    provenance: { "claude-code": "measured" },
    by_source: {
      "claude-code": { agent_hours: 10, provenance: "measured" },
    },
  };
  const detected = {
    detections: [
      {
        source: "claude-code" as const,
        plan: "claude-pro",
        raw: "pro",
        confidence: "measured" as const,
      },
      {
        source: "codex" as const,
        plan: "chatgpt-go",
        raw: "go",
        confidence: "measured" as const,
      },
    ],
    plans: ["claude-pro", "chatgpt-go"],
    warnings: [],
  };
  const auto = applyDetectedPlans(base, detected, { cliPlans: [] });
  assert.deepEqual(auto.plans, ["claude-pro", "chatgpt-go"]);
  assert.equal(auto.by_source?.["claude-code"]?.plan, "claude-pro");
  assert.equal(auto.by_source?.codex?.plan, "chatgpt-go");
  assert.equal(auto.provenance.codex, "measured");

  const forced = applyDetectedPlans(base, detected, {
    cliPlans: ["claude-ultra"],
  });
  assert.deepEqual(forced.plans, ["claude-ultra"]);
  assert.equal(forced.by_source?.["claude-code"]?.plan, "claude-pro");
});
