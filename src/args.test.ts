import assert from "node:assert/strict";
import test from "node:test";
import {
  boundsOf,
  currentMonth,
  normalizeBaseUrl,
  parseArgs,
  periodFromDays,
  verdictUrl,
} from "./args";

const now = new Date("2026-11-05T15:00:00.000Z");

test("default period is the current local month", () => {
  const parsed = parseArgs(["scan"], now, 0);
  assert.equal(parsed.ok && !parsed.help && parsed.args.period, "2026-11");
  assert.equal(currentMonth(now, 60), "2026-11");
});

test("--days builds an inclusive local range", () => {
  assert.equal(periodFromDays(7, now, 0), "2026-10-30/2026-11-05");
  const parsed = parseArgs(["scan", "--days", "7", "--plan", "claude-pro"], now, 0);
  assert.equal(parsed.ok && !parsed.help && parsed.args.period, "2026-10-30/2026-11-05");
  assert.deepEqual(parsed.ok && !parsed.help && parsed.args.plans, ["claude-pro"]);
});

test("period and days together are rejected", () => {
  const parsed = parseArgs(["scan", "--period", "2026-10", "--days", "3"], now, 0);
  assert.equal(parsed.ok, false);
});

test("plan slugs and base url are checked", () => {
  assert.equal(parseArgs(["scan", "--plan", "Claude_Pro"], now, 0).ok, false);
  assert.equal(parseArgs(["scan", "--base-url", "file:///tmp"], now, 0).ok, false);
  assert.equal(normalizeBaseUrl("https://pickagent.dev/"), "https://pickagent.dev");
  const parsed = parseArgs(
    ["scan", "--base-url", "https://example.com/app/", "--no-open", "--json"],
    now,
    0,
  );
  assert.equal(parsed.ok && !parsed.help && parsed.args.baseUrl, "https://example.com/app");
  assert.equal(
    verdictUrl("https://pickagent.dev", "#p=1.abc"),
    "https://pickagent.dev/en/veredicto#p=1.abc",
  );
});

test("month bounds are local and exclusive at the end", () => {
  const bounds = boundsOf("2026-10", 60);
  assert.ok(bounds);
  assert.equal(new Date(bounds.start).toISOString(), "2026-09-30T23:00:00.000Z");
  assert.equal(new Date(bounds.end).toISOString(), "2026-10-31T23:00:00.000Z");
});
