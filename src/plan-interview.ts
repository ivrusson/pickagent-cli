import {
  DECLARED_BILLING,
  DECLARED_CURRENCIES,
  parseProfile,
  type DeclaredPlanPrice,
  type Profile,
} from "./profile";
import type { ScanArgs } from "./args";
import {
  declaredPrice,
  loadScannerConfig,
  saveScannerConfig,
  scannerConfigPath,
  type ScannerConfig,
} from "./scanner-config";
import type { ScanIo } from "./scan";

const PLAN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function scanInteractive(args: ScanArgs, io: ScanIo): boolean {
  return io.isTTY && !args.json;
}

function bracketDefault(label: string, value: string | undefined): string {
  return value && value.length ? `${label} [${value}]: ` : `${label}: `;
}

function normalizePlanSlug(raw: string, fallback: string | undefined): string | null {
  const trimmed = raw.trim() || fallback?.trim() || "";
  if (!trimmed || !PLAN_RE.test(trimmed) || trimmed.length > 48) return null;
  return trimmed;
}

function parseAmount(raw: string, fallback: number | undefined): number | null {
  const trimmed = raw.trim();
  const source = trimmed.length ? trimmed : fallback != null ? String(fallback) : "";
  if (!source) return null;
  const value = Number(source.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseCurrency(
  raw: string,
  fallback: DeclaredPlanPrice["currency"] | undefined,
): DeclaredPlanPrice["currency"] | null {
  const trimmed = raw.trim().toUpperCase() || fallback;
  if (!trimmed) return null;
  return (DECLARED_CURRENCIES as readonly string[]).includes(trimmed)
    ? (trimmed as DeclaredPlanPrice["currency"])
    : null;
}

function parseBilling(
  raw: string,
  fallback: DeclaredPlanPrice["billing"] | undefined,
): DeclaredPlanPrice["billing"] | null {
  const trimmed = raw.trim().toLowerCase() || fallback;
  if (!trimmed) return null;
  return (DECLARED_BILLING as readonly string[]).includes(trimmed)
    ? (trimmed as DeclaredPlanPrice["billing"])
    : null;
}

function priceForPlan(
  profile: Profile,
  config: ScannerConfig,
  planId: string,
): DeclaredPlanPrice | undefined {
  return profile.plan_prices?.[planId] ?? config.plan_prices?.[planId];
}

function mergePlanPrices(
  profile: Profile,
  prices: Record<string, DeclaredPlanPrice>,
): Profile {
  const merged = { ...(profile.plan_prices ?? {}), ...prices };
  const plan_prices: Record<string, DeclaredPlanPrice> = {};
  for (const planId of profile.plans) {
    const row = merged[planId];
    if (row) plan_prices[planId] = row;
  }
  if (!Object.keys(plan_prices).length) {
    const { plan_prices: _drop, ...rest } = profile;
    return rest as Profile;
  }
  return { ...profile, plan_prices };
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
    if (Object.keys(fromConfig).length) next = mergePlanPrices(next, fromConfig);
  }
  return next;
}

function plansMissingPrice(profile: Profile, config: ScannerConfig): string[] {
  return profile.plans.filter((planId) => !priceForPlan(profile, config, planId));
}

async function askPlan(io: ScanIo, config: ScannerConfig): Promise<string | null> {
  const fallback = config.plans?.[0];
  const answer = await io.prompt(
    bracketDefault("Plan you pay for (catalog slug)", fallback),
  );
  return normalizePlanSlug(answer, fallback);
}

async function askPrice(
  io: ScanIo,
  planId: string,
  config: ScannerConfig,
): Promise<DeclaredPlanPrice | null> {
  const fallback = config.plan_prices?.[planId];
  const amountRaw = await io.prompt(
    bracketDefault(`Amount for ${planId}`, fallback?.amount?.toString()),
  );
  const amount = parseAmount(amountRaw, fallback?.amount);
  if (amount == null) return null;

  const currencyRaw = await io.prompt(
    bracketDefault(`Currency for ${planId} (EUR/USD)`, fallback?.currency),
  );
  const currency = parseCurrency(currencyRaw, fallback?.currency);
  if (!currency) return null;

  const billingRaw = await io.prompt(
    bracketDefault(`Billing cycle for ${planId} (monthly/yearly)`, fallback?.billing),
  );
  const billing = parseBilling(billingRaw, fallback?.billing);
  if (!billing) return null;

  return declaredPrice({ amount, currency, billing });
}

async function runInterview(
  profile: Profile,
  config: ScannerConfig,
  io: ScanIo,
  args: ScanArgs,
  opts?: { askUnmapped?: boolean },
): Promise<{ profile: Profile; config: ScannerConfig; warnings: string[] }> {
  const warnings: string[] = [];
  let next = { ...profile };
  const saved: ScannerConfig = {
    plans: [...(config.plans ?? [])],
    plan_prices: { ...(config.plan_prices ?? {}) },
  };

  if (opts?.askUnmapped && next.plans.length && !args.plans.length) {
    const extra = await askPlan(io, config);
    if (extra && !next.plans.includes(extra)) {
      next = { ...next, plans: [...next.plans, extra].slice(0, 10) };
      saved.plans = [...next.plans];
    }
  }

  if (!args.plans.length && !next.plans.length) {
    const planId = await askPlan(io, config);
    if (planId) {
      next = { ...next, plans: [planId] };
      saved.plans = [planId];
    } else {
      warnings.push("plan_price_missing");
      return { profile: next, config: saved, warnings };
    }
  } else if (saved.plans?.length) {
    saved.plans = [...next.plans];
  } else {
    saved.plans = [...next.plans];
  }

  for (const planId of [...next.plans]) {
    if (priceForPlan(next, saved, planId)) continue;
    const price = await askPrice(io, planId, saved);
    if (!price) {
      warnings.push("plan_price_missing");
      continue;
    }
    saved.plan_prices = { ...(saved.plan_prices ?? {}), [planId]: price };
    next = mergePlanPrices(next, { [planId]: price });
  }

  return { profile: next, config: saved, warnings };
}

export type DeclaredPlansResult = {
  profile: Profile;
  warnings: string[];
};

/**
 * Fills `plans` / `plan_prices` from local config and optional terminal prompts.
 */
export async function withDeclaredPlans(
  profile: Profile,
  args: ScanArgs,
  io: ScanIo,
  extra?: { unmapped?: boolean },
): Promise<DeclaredPlansResult> {
  const configPath = scannerConfigPath(io.home);
  const config = await loadScannerConfig(configPath);
  const warnings: string[] = [];

  if (!scanInteractive(args, io)) {
    const next = applyConfigSilently(profile, config);
    const parsed = parseProfile(next);
    if (parsed.ok) return { profile: parsed.profile, warnings };
    return { profile, warnings: [...warnings, "plan_price_invalid"] };
  }

  const prefilled = applyConfigSilently(profile, config);
  const noPlans =
    !args.plans.length && !prefilled.plans.length;
  const missingPrices = plansMissingPrice(prefilled, {});
  const askUnmapped =
    Boolean(extra?.unmapped) && !args.plans.length && prefilled.plans.length > 0;

  let next = profile;
  if (noPlans || missingPrices.length > 0 || askUnmapped) {
    const interviewed = await runInterview(next, config, io, args, { askUnmapped });
    next = interviewed.profile;
    warnings.push(...interviewed.warnings);
    if (
      interviewed.config.plans?.length ||
      (interviewed.config.plan_prices &&
        Object.keys(interviewed.config.plan_prices).length > 0)
    ) {
      await saveScannerConfig(configPath, interviewed.config);
    }
  } else {
    next = prefilled;
  }

  const parsed = parseProfile(next);
  if (!parsed.ok) {
    return { profile, warnings: [...warnings, "plan_price_invalid"] };
  }
  return { profile: parsed.profile, warnings };
}