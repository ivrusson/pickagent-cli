import assert from "node:assert/strict";
import test from "node:test";
import { classifyUsageLimit } from "./limit-text";

const at = Date.parse("2026-10-05T10:15:00.000Z");

test("session limit keeps the next clock in the stated timezone", () => {
  const hit = classifyUsageLimit(
    "You've hit your session limit · resets 1:50pm (Europe/London)",
    at,
  );
  assert.ok(hit);
  assert.equal(hit.waitHours, 3);
});

test("weekly limit is the same best-effort clock, not a date", () => {
  const hit = classifyUsageLimit(
    "You've hit your weekly limit · resets 8am (Europe/London)",
    at,
  );
  assert.ok(hit);
  assert.equal(hit.waitHours, 21);
});

test("monthly spend counts, without inventing a wait", () => {
  const hit = classifyUsageLimit(
    "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit",
    at,
  );
  assert.ok(hit);
  assert.equal(hit.waitHours, null);
});

test("transient 429 throttle is not a usage block", () => {
  const hit = classifyUsageLimit(
    "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
    at,
  );
  assert.equal(hit, null);
});

test("a reset without a real timezone omits the wait", () => {
  const hit = classifyUsageLimit("You've hit your session limit · resets 1:50pm", at);
  assert.ok(hit);
  assert.equal(hit.waitHours, null);
});
