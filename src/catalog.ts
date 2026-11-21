import { z } from "zod";
import { normalizeBaseUrl } from "./args";
import { declaredPrice } from "./scanner-config";
import type { DeclaredPlanPrice } from "./profile";

/**
 * Public price list from `GET /api/catalog/prices`.
 * Names and prices only. The same shape as the web catalog payload.
 */

const MoneySchema = z.object({
  amount: z.number().finite().nonnegative(),
  period: z.enum(["month", "year"]),
  taxIncluded: z.boolean(),
});

const EurSchema = MoneySchema.extend({ derived: z.boolean() });

export const CatalogPricePlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
  name: z.string().min(1).max(80),
  provider: z.string().min(1).max(80),
  providerLabel: z.string().min(1).max(80),
  billing: z.enum(["subscription", "api"]),
  legacy: z.boolean(),
  prices: z
    .object({
      usd: MoneySchema.nullable(),
      eur: EurSchema.nullable(),
    })
    .nullable(),
  sourceUrl: z.string().nullable(),
});

export const CatalogPricesResponseSchema = z.object({
  catalogVersion: z.string(),
  generatedAt: z.string(),
  plans: z.array(CatalogPricePlanSchema),
});

export type CatalogPlan = z.infer<typeof CatalogPricePlanSchema>;

export type CatalogIndex = {
  version: string;
  plans: CatalogPlan[];
  byId: Map<string, CatalogPlan>;
};

const DEFAULT_ORIGIN = "https://pickagent.dev";

/** Origin from `PICKAGENT_API_URL`, otherwise https://pickagent.dev. */
export function catalogPricesUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PICKAGENT_API_URL?.trim();
  const base = raw ? normalizeBaseUrl(raw) : DEFAULT_ORIGIN;
  if (!base) return null;
  return `${base}/api/catalog/prices`;
}

export function indexCatalog(payload: unknown): CatalogIndex | null {
  const parsed = CatalogPricesResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    version: parsed.data.catalogVersion,
    plans: parsed.data.plans,
    byId: new Map(parsed.data.plans.map((plan) => [plan.id, plan])),
  };
}

/**
 * Fetches the public price list. Returns null when the URL is unset,
 * the network fails, or the body does not match the catalog schema.
 */
export async function fetchCatalogPrices(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CatalogIndex | null> {
  const url = catalogPricesUrl(env);
  if (!url) return null;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    return indexCatalog(await response.json());
  } catch {
    return null;
  }
}

export function formatMoney(
  amount: number,
  currency: "EUR" | "USD",
  period: "month" | "year",
  taxIncluded: boolean,
): string {
  const figure = amount.toFixed(2);
  const body = currency === "EUR" ? `€${figure}` : `$${figure}`;
  const per = period === "year" ? "/yr" : "/mo";
  const tax = taxIncluded ? " (VAT incl.)" : " (excl. VAT)";
  return `${body}${per}${tax}`;
}

/** `Cursor Super — €107.80/mo (VAT incl.)`. Prefers the EUR quote. */
export function formatOffer(plan: CatalogPlan): string | null {
  const eur = plan.prices?.eur ?? null;
  const usd = plan.prices?.usd ?? null;
  const money = eur ?? usd;
  if (!money) return null;
  const currency = eur ? "EUR" : "USD";
  return `${plan.name} — ${formatMoney(money.amount, currency, money.period, money.taxIncluded)}`;
}

/** Catalog quote as a declared price. EUR when the plan has one. */
export function declaredFromCatalog(plan: CatalogPlan): DeclaredPlanPrice | null {
  const eur = plan.prices?.eur ?? null;
  const usd = plan.prices?.usd ?? null;
  const money = eur ?? usd;
  if (!money) return null;
  return declaredPrice({
    amount: money.amount,
    currency: eur ? "EUR" : "USD",
    billing: money.period === "year" ? "yearly" : "monthly",
  });
}

export function catalogNames(index: CatalogIndex | null): Record<string, string> {
  if (!index) return {};
  const names: Record<string, string> = {};
  for (const plan of index.plans) names[plan.id] = plan.name;
  return names;
}
