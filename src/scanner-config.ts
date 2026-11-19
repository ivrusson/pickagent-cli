import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DECLARED_PROVENANCE,
  DeclaredPlanPriceSchema,
  type DeclaredPlanPrice,
} from "./profile";

/** Local answers the scanner remembers between runs (under `~/.pickagent/`). */
export type ScannerConfig = {
  plans?: string[];
  plan_prices?: Record<string, DeclaredPlanPrice>;
};

const PlanIdRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ScannerConfigSchema = z.strictObject({
  plans: z.array(z.string().regex(PlanIdRe).max(48)).max(10).optional(),
  plan_prices: z.record(z.string(), DeclaredPlanPriceSchema).optional(),
});

export function scannerConfigPath(home: string): string {
  return join(home, ".pickagent", "scanner.json");
}

export async function loadScannerConfig(path: string): Promise<ScannerConfig> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = ScannerConfigSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return {};
    const config = parsed.data;
    if (config.plan_prices) {
      const prices: Record<string, DeclaredPlanPrice> = {};
      for (const [planId, price] of Object.entries(config.plan_prices)) {
        if (!PlanIdRe.test(planId) || planId.length > 48) continue;
        const row = DeclaredPlanPriceSchema.safeParse(price);
        if (row.success) prices[planId] = row.data;
      }
      config.plan_prices = Object.keys(prices).length ? prices : undefined;
    }
    if (config.plans) {
      config.plans = config.plans.filter(
        (id) => PlanIdRe.test(id) && id.length <= 48,
      );
      if (!config.plans.length) config.plans = undefined;
    }
    return config;
  } catch {
    return {};
  }
}

export async function saveScannerConfig(
  path: string,
  config: ScannerConfig,
): Promise<void> {
  const payload: ScannerConfig = {};
  if (config.plans?.length) payload.plans = config.plans.slice(0, 10);
  if (config.plan_prices && Object.keys(config.plan_prices).length) {
    payload.plan_prices = config.plan_prices;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Build a declared price row with engine provenance fixed to `declared`. */
export function declaredPrice(
  input: Omit<DeclaredPlanPrice, "provenance">,
): DeclaredPlanPrice {
  return { ...input, provenance: DECLARED_PROVENANCE };
}