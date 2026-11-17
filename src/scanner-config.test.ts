import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  declaredPrice,
  loadScannerConfig,
  saveScannerConfig,
  scannerConfigPath,
} from "./scanner-config";

test("scanner config round-trips under the home directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-config-"));
  const path = scannerConfigPath(home);
  const payload = {
    plans: ["claude-pro"],
    plan_prices: {
      "claude-pro": declaredPrice({
        amount: 18,
        currency: "EUR",
        billing: "monthly",
      }),
    },
  };
  await saveScannerConfig(path, payload);
  const saved = await loadScannerConfig(path);
  assert.deepEqual(saved, payload);
  const text = await readFile(path, "utf8");
  assert.equal(text.includes("sk-"), false);
});

test("invalid config on disk is ignored", async () => {
  const home = await mkdtemp(join(tmpdir(), "pickagent-config-bad-"));
  const path = scannerConfigPath(home);
  await saveScannerConfig(path, { plans: ["NOT VALID"] });
  assert.deepEqual(await loadScannerConfig(path), {});
});