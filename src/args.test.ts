import assert from "node:assert/strict";
import test from "node:test";
import {
  boundsOf,
  currentMonth,
  normalizeBaseUrl,
  parseArgs,
  periodFromDays,
  verdictLangFromEnv,
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
    verdictUrl("https://pickagent.dev", "#p=1.abc", "en"),
    "https://pickagent.dev/en/verdict#p=1.abc",
  );
  assert.equal(
    verdictUrl("https://pickagent.dev", "#p=1.abc", "es"),
    "https://pickagent.dev/es/veredicto#p=1.abc",
  );
});

test("--lang overrides the locale and rejects other tags", () => {
  const spanish = parseArgs(["scan", "--lang", "es"], now, 0);
  assert.equal(spanish.ok && !spanish.help && spanish.args.lang, "es");
  const english = parseArgs(["scan", "--lang", "en"], now, 0);
  assert.equal(english.ok && !english.help && english.args.lang, "en");
  const omitted = parseArgs(["scan"], now, 0);
  assert.equal(omitted.ok && !omitted.help && omitted.args.lang, null);
  assert.equal(parseArgs(["scan", "--lang", "fr"], now, 0).ok, false);
});

test("locale es opens the Spanish verdict", () => {
  assert.equal(verdictLangFromEnv({ LC_ALL: "es_ES.UTF-8", LANG: "en_US" }), "es");
  assert.equal(verdictLangFromEnv({ LC_MESSAGES: "es", LANG: "C" }), "es");
  assert.equal(verdictLangFromEnv({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(verdictLangFromEnv({}), "en");
});

test("--price is repeatable and the last value wins", () => {
  const parsed = parseArgs(
    [
      "scan",
      "--price",
      "cursor-super=107.80EUR/mo",
      "--price",
      "claude-pro=240USD/yr",
      "--price",
      "cursor-super=90EUR",
      "--verbose",
    ],
    now,
    0,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.help) return;
  assert.equal(parsed.args.verbose, true);
  assert.deepEqual(parsed.args.prices, [
    { planId: "cursor-super", amount: 107.8, currency: "EUR", billing: "monthly" },
    { planId: "claude-pro", amount: 240, currency: "USD", billing: "yearly" },
    { planId: "cursor-super", amount: 90, currency: "EUR", billing: "monthly" },
  ]);
  assert.equal(parseArgs(["scan", "--price", "claude-pro=20GBP"], now, 0).ok, false);
  assert.equal(parseArgs(["scan", "--price", "Claude=20EUR"], now, 0).ok, false);
});

test("explicit plans and prices share the ten-plan limit", () => {
  const ten = Array.from({ length: 10 }, (_, index) => `plan-${index}`);
  const accepted = parseArgs(
    ["scan", ...ten.flatMap((id) => ["--price", `${id}=1EUR`])],
    now,
    0,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok || accepted.help) return;
  assert.equal(accepted.args.prices.length, 10);

  const extraPrice = parseArgs(
    ["scan", ...ten.flatMap((id) => ["--price", `${id}=1EUR`]), "--price", "extra-plan=2EUR"],
    now,
    0,
  );
  assert.equal(extraPrice.ok, false);
  if (extraPrice.ok) return;
  assert.match(extraPrice.error, /At most 10 plans/);

  const override = parseArgs(
    ["scan", ...ten.flatMap((id) => ["--plan", id]), "--price", "plan-0=4EUR"],
    now,
    0,
  );
  assert.equal(override.ok, true);
  const crowded = parseArgs(
    ["scan", ...ten.flatMap((id) => ["--plan", id]), "--price", "extra-plan=4EUR"],
    now,
    0,
  );
  assert.equal(crowded.ok, false);
});

test("month bounds are local and exclusive at the end", () => {
  const bounds = boundsOf("2026-10", 60);
  assert.ok(bounds);
  assert.equal(new Date(bounds.start).toISOString(), "2026-09-30T23:00:00.000Z");
  assert.equal(new Date(bounds.end).toISOString(), "2026-10-31T23:00:00.000Z");
});
