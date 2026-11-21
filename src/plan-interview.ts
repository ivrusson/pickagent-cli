import { parseProfile, type DeclaredPlanPrice, type Profile } from "./profile";
import type { ScanArgs } from "./args";
import type { PriceSpec } from "./price-spec";
import {
  declaredPrice,
  loadScannerConfig,
  scannerConfigPath,
  type ScannerConfig,
} from "./scanner-config";
import type { ScanIo } from "./scan";

const PLAN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function priceForPlan(
  profile: Profile,
  config: ScannerConfig,
  planId: string,
): DeclaredPlanPrice | undefined {
  return profile.plan_prices?.[planId] ?? config.plan_prices?.[planId];
}

export function applyDeclaredChoices(
  profile: Profile,
  plans: readonly string[],
  prices: Record<string, DeclaredPlanPrice>,
): Profile {
  const nextPlans: string[] = [];
  for (const planId of plans) {
    if (!PLAN_RE.test(planId) || planId.length > 48 || nextPlans.includes(planId)) {
      continue;
    }
    nextPlans.push(planId);
    if (nextPlans.length === 10) break;
  }
  const plan_prices: Record<string, DeclaredPlanPrice> = {};
  for (const planId of nextPlans) {
    const row = prices[planId];
    if (row) plan_prices[planId] = row;
  }
  if (!Object.keys(plan_prices).length) {
    const { plan_prices: _drop, ...rest } = profile;
    return { ...rest, plans: nextPlans };
  }
  return { ...profile, plans: nextPlans, plan_prices };
}

/** `--price` overrides a saved amount and includes that plan. */
export function applyPriceSpecs(profile: Profile, specs: readonly PriceSpec[]): Profile {
  if (!specs.length) return profile;
  const plans = [...profile.plans];
  const prices: Record<string, DeclaredPlanPrice> = { ...(profile.plan_prices ?? {}) };
  for (const spec of specs) {
    if (!plans.includes(spec.planId)) plans.push(spec.planId);
    prices[spec.planId] = declaredPrice({
      amount: spec.amount,
      currency: spec.currency,
      billing: spec.billing,
    });
  }
  return applyDeclaredChoices(profile, plans, prices);
}

function applyConfigSilently(profile: Profile, config: ScannerConfig): Profile {
  let next = profile;
  if (!next.plans.length && config.plans?.length) {
    next = { ...next, plans: config.plans.slice(0, 10) };
  }
  if (config.plan_prices) {
    const fromConfig: Record<string, DeclaredPlanPrice> = {};
    for (const planId of next.plans) {
      const saved = config.plan_prices[planId];
      if (saved && !priceForPlan(next, {}, planId)) fromConfig[planId] = saved;
    }
    if (Object.keys(fromConfig).length) {
      next = applyDeclaredChoices(next, next.plans, {
        ...(next.plan_prices ?? {}),
        ...fromConfig,
      });
    }
  }
  return next;
}

export type DeclaredPlansResult = {
  profile: Profile;
  warnings: string[];
};

/**
 * Fills `plans` / `plan_prices` from local config. Prompts live in the
 * interactive scan, not here.
 */
export async function withDeclaredPlans(
  profile: Profile,
  _args: ScanArgs,
  io: ScanIo,
): Promise<DeclaredPlansResult> {
  const config = await loadScannerConfig(scannerConfigPath(io.home));
  const next = applyConfigSilently(profile, config);
  const parsed = parseProfile(next);
  if (parsed.ok) return { profile: parsed.profile, warnings: [] };
  return { profile, warnings: ["plan_price_invalid"] };
}

/** Saved plans and prices, when a previous run stored any. */
export async function savedPlans(io: ScanIo): Promise<ScannerConfig> {
  return loadScannerConfig(scannerConfigPath(io.home));
}

export function rememberPlans(
  plans: readonly string[],
  prices: Record<string, DeclaredPlanPrice>,
): ScannerConfig {
  const config: ScannerConfig = {};
  if (plans.length) config.plans = [...plans].slice(0, 10);
  if (Object.keys(prices).length) config.plan_prices = prices;
  return config;
}
