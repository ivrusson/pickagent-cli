import assert from "node:assert/strict";
import test from "node:test";
import { choosePlansAndPrices, planPickerOptions } from "./interview";
import { CANCEL, type Cancel, type ScanPrompts } from "./prompts";
import type { CatalogPlan } from "./catalog";

function script(answers: {
  select?: string[];
  text?: string[];
  multiselect?: string[][];
}): ScanPrompts & { messages: string[] } {
  const messages: string[] = [];
  let selectAt = 0;
  let textAt = 0;
  let multiAt = 0;
  const take = <T>(list: T[] | undefined, index: number, fallback: T): T =>
    list && index < list.length ? list[index]! : fallback;
  return {
    messages,
    intro() {},
    outro() {},
    cancel() {},
    note(message) {
      messages.push(message);
    },
    spin(_message, task) {
      return task();
    },
    multiselect(input) {
      messages.push(input.message);
      const values = take(answers.multiselect, multiAt, [...(input.initialValues ?? [])]);
      multiAt += 1;
      return values;
    },
    select(input) {
      messages.push(input.message);
      const value = take(answers.select, selectAt, input.initialValue ?? input.options[0]!.value);
      selectAt += 1;
      return value;
    },
    autocomplete() {
      return CANCEL;
    },
    text(input) {
      messages.push(input.message);
      const value = take(answers.text, textAt, input.initialValue ?? "");
      textAt += 1;
      return value;
    },
    confirm() {
      return false;
    },
  };
}

const cursor: CatalogPlan = {
  id: "cursor-super",
  name: "Cursor Super",
  provider: "cursor",
  providerLabel: "Cursor",
  billing: "subscription",
  legacy: false,
  prices: {
    usd: { amount: 100, period: "month", taxIncluded: false },
    eur: { amount: 107.8, period: "month", taxIncluded: true, derived: true },
  },
  sourceUrl: "https://cursor.com/pricing",
};

test("picker options are grouped by provider", () => {
  const options = planPickerOptions(
    [
      cursor,
      {
        ...cursor,
        id: "claude-pro",
        name: "Claude Pro",
        provider: "anthropic",
        providerLabel: "Anthropic",
      },
    ],
    new Set(),
  );
  assert.equal(options[0]?.label, "Anthropic");
  assert.equal(options[0]?.disabled, true);
  assert.equal(options[1]?.value, "claude-pro");
  assert.equal(options[2]?.label, "Cursor");
  assert.equal(options[3]?.value, "cursor-super");
});

test("without a catalog, confirming a plan asks for the amount", async () => {
  const prompts = script({
    multiselect: [["cursor-super"]],
    text: ["18"],
    select: ["EUR", "yearly"],
  });
  const choice = await choosePlansAndPrices({
    prompts,
    detected: ["cursor-super"],
    specs: [],
    config: {},
    catalog: null,
  });
  assert.equal(isCancel(choice), false);
  if (isCancel(choice)) return;
  assert.deepEqual(choice.plans, ["cursor-super"]);
  assert.equal(choice.prices["cursor-super"]?.amount, 18);
  assert.equal(choice.prices["cursor-super"]?.currency, "EUR");
  assert.equal(choice.prices["cursor-super"]?.billing, "yearly");
  assert.ok(prompts.messages.some((line) => line.includes("unavailable")));
});

test("yes reuses saved plans and still keeps --plan", async () => {
  const prompts = script({ select: ["yes"] });
  const choice = await choosePlansAndPrices({
    prompts,
    detected: ["claude-pro", "cursor-super"],
    forced: ["cursor-super"],
    specs: [],
    config: {
      plans: ["claude-pro"],
      plan_prices: {
        "claude-pro": {
          amount: 20,
          currency: "EUR",
          billing: "monthly",
          provenance: "declared",
        },
      },
    },
    catalog: null,
  });
  assert.equal(isCancel(choice), false);
  if (isCancel(choice)) return;
  assert.deepEqual(choice.plans, ["claude-pro", "cursor-super"]);
  assert.equal(choice.prices["claude-pro"]?.amount, 20);
  assert.equal(choice.prices["cursor-super"], undefined);
});

test("a catalog price can be accepted as shown", async () => {
  const prompts = script({ select: ["yes"] });
  const choice = await choosePlansAndPrices({
    prompts,
    detected: ["cursor-super"],
    specs: [],
    config: {},
    catalog: {
      version: "0123456789abcdef",
      plans: [cursor],
      byId: new Map([["cursor-super", cursor]]),
    },
  });
  assert.equal(isCancel(choice), false);
  if (isCancel(choice)) return;
  assert.equal(choice.prices["cursor-super"]?.amount, 107.8);
  assert.ok(prompts.messages.includes("Cursor Super — €107.80/mo (VAT incl.)"));
});

function isCancel(value: unknown): value is Cancel {
  return value === CANCEL;
}
