import type { CatalogIndex, CatalogPlan } from "./catalog";
import { declaredFromCatalog, formatOffer } from "./catalog";
import type { DiscoveredAccount } from "./discover";
import type { DeclaredPlanPrice } from "./profile";
import { CANCEL, isPromptCancel, type Cancel, type ScanPrompts } from "./prompts";
import type { PriceSpec } from "./price-spec";
import { declaredPrice, type ScannerConfig } from "./scanner-config";

export const ADD_PLAN = "__add_plan__";

const PLAN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unique(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!id || id === ADD_PLAN || out.includes(id)) continue;
    out.push(id);
  }
  return out.slice(0, 10);
}

function hasMemory(config: ScannerConfig): boolean {
  return Boolean(
    config.plans?.length ||
      (config.plan_prices && Object.keys(config.plan_prices).length > 0),
  );
}

function priceFromSpec(spec: PriceSpec): DeclaredPlanPrice {
  return declaredPrice({
    amount: spec.amount,
    currency: spec.currency,
    billing: spec.billing,
  });
}

/** Searchable list, ordered and headed by provider. */
export function planPickerOptions(
  plans: readonly CatalogPlan[],
  exclude: ReadonlySet<string>,
): { value: string; label: string; hint?: string; disabled?: boolean }[] {
  const groups = new Map<string, CatalogPlan[]>();
  for (const plan of plans) {
    if (exclude.has(plan.id)) continue;
    const key = plan.providerLabel || plan.provider;
    const list = groups.get(key) ?? [];
    list.push(plan);
    groups.set(key, list);
  }
  const options: { value: string; label: string; hint?: string; disabled?: boolean }[] = [];
  for (const [provider, list] of [...groups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    options.push({
      value: `group:${provider}`,
      label: provider,
      disabled: true,
    });
    for (const plan of list.sort((a, b) => a.name.localeCompare(b.name))) {
      options.push({ value: plan.id, label: plan.name, hint: provider });
    }
  }
  return options;
}

async function askSlug(prompts: ScanPrompts): Promise<string | null | Cancel> {
  const raw = await prompts.text({
    message: "Plan id",
    placeholder: "claude-pro",
    validate(value) {
      const slug = value.trim();
      if (PLAN_RE.test(slug) && slug.length <= 48) return undefined;
      return "Use a catalog slug such as claude-pro.";
    },
  });
  if (isPromptCancel(raw)) return CANCEL;
  const slug = raw.trim();
  return PLAN_RE.test(slug) && slug.length <= 48 ? slug : null;
}

async function pickAnother(
  prompts: ScanPrompts,
  catalog: CatalogIndex | null,
  exclude: ReadonlySet<string>,
): Promise<string | null | Cancel> {
  const options = catalog ? planPickerOptions(catalog.plans, exclude) : [];
  const selectable = options.filter((option) => !option.disabled);
  if (!selectable.length) return askSlug(prompts);
  const picked = await prompts.autocomplete({
    message: "Add a plan",
    options,
    placeholder: "Search by provider or plan",
  });
  if (isPromptCancel(picked)) return CANCEL;
  if (!picked || picked.startsWith("group:") || exclude.has(picked)) return null;
  return picked;
}

type ManualDefaults = {
  amount?: string;
  currency: "EUR" | "USD";
  billing: "monthly" | "yearly";
};

async function askManual(
  prompts: ScanPrompts,
  planId: string,
  defaults: ManualDefaults,
): Promise<DeclaredPlanPrice | null | Cancel> {
  const amountRaw = await prompts.text({
    message: `Amount for ${planId}`,
    initialValue: defaults.amount,
    placeholder: defaults.amount ?? "0",
    validate(value) {
      const amount = Number(value.trim().replace(",", "."));
      if (Number.isFinite(amount) && amount >= 0) return undefined;
      return "Enter a number, 0 or more.";
    },
  });
  if (isPromptCancel(amountRaw)) return CANCEL;
  const amount = Number(amountRaw.trim().replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return null;

  const currency = await prompts.select({
    message: `Currency for ${planId}`,
    options: [
      { value: "EUR", label: "EUR" },
      { value: "USD", label: "USD" },
    ],
    initialValue: defaults.currency,
  });
  if (isPromptCancel(currency)) return CANCEL;
  if (currency !== "EUR" && currency !== "USD") return null;

  const billing = await prompts.select({
    message: `Billing cycle for ${planId}`,
    options: [
      { value: "monthly", label: "Monthly" },
      { value: "yearly", label: "Yearly" },
    ],
    initialValue: defaults.billing,
  });
  if (isPromptCancel(billing)) return CANCEL;
  if (billing !== "monthly" && billing !== "yearly") return null;
  return declaredPrice({ amount, currency, billing });
}

function defaultsFor(
  planId: string,
  config: ScannerConfig,
  catalog: CatalogIndex | null,
): ManualDefaults {
  const saved = config.plan_prices?.[planId];
  const quote = catalog?.byId.get(planId);
  const money = quote?.prices?.eur ?? quote?.prices?.usd ?? null;
  return {
    amount: saved?.amount?.toString() ?? (money ? String(money.amount) : undefined),
    currency: saved?.currency ?? (quote?.prices?.eur ? "EUR" : quote?.prices?.usd ? "USD" : "EUR"),
    billing:
      saved?.billing ?? (money?.period === "year" ? "yearly" : "monthly"),
  };
}

export async function chooseAccounts(
  prompts: ScanPrompts,
  accounts: readonly DiscoveredAccount[],
): Promise<DiscoveredAccount[] | Cancel> {
  if (!accounts.length) return [];
  const selected = await prompts.multiselect({
    message: "Accounts to scan",
    options: accounts.map((account) => ({
      value: account.id,
      label: account.label,
      hint: account.hint,
    })),
    initialValues: accounts.map((account) => account.id),
    required: true,
  });
  if (isPromptCancel(selected)) return CANCEL;
  const keep = new Set(selected);
  return accounts.filter((account) => keep.has(account.id));
}

export type PlanChoice = {
  plans: string[];
  prices: Record<string, DeclaredPlanPrice>;
};

/**
 * Last-time memory, plan multiselect, and a price confirm per plan.
 * A missing catalog falls through to amount, currency, and billing prompts.
 */
export async function choosePlansAndPrices(input: {
  prompts: ScanPrompts;
  detected: readonly string[];
  /** `--plan` ids for this run. Kept even when last time's list is reused. */
  forced?: readonly string[];
  specs: readonly PriceSpec[];
  config: ScannerConfig;
  catalog: CatalogIndex | null;
}): Promise<PlanChoice | Cancel> {
  const flagged = new Map(input.specs.map((spec) => [spec.planId, spec]));
  const forced = input.forced ?? [];
  if (hasMemory(input.config)) {
    const answer = await input.prompts.select({
      message: "Use last time's plans and prices?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "review", label: "Review" },
      ],
      initialValue: "yes",
    });
    if (isPromptCancel(answer)) return CANCEL;
    if (answer === "yes") {
      const plans = unique([
        ...flagged.keys(),
        ...forced,
        ...(input.config.plans?.length ? input.config.plans : input.detected),
      ]);
      const prices: Record<string, DeclaredPlanPrice> = {};
      for (const planId of plans) {
        const spec = flagged.get(planId);
        if (spec) prices[planId] = priceFromSpec(spec);
        else if (input.config.plan_prices?.[planId]) {
          prices[planId] = input.config.plan_prices[planId];
        }
      }
      return { plans, prices };
    }
  }

  const known = unique([
    ...input.detected,
    ...(input.config.plans ?? []),
    ...flagged.keys(),
  ]);
  const selectedRaw = await input.prompts.multiselect({
    message: "Plans you pay for",
    options: [
      ...known.map((planId) => {
        const plan = input.catalog?.byId.get(planId);
        return {
          value: planId,
          label: plan?.name ?? planId,
          hint: plan?.providerLabel,
        };
      }),
      { value: ADD_PLAN, label: "Add another plan…" },
    ],
    initialValues: unique([...input.detected, ...flagged.keys()]),
    required: false,
  });
  if (isPromptCancel(selectedRaw)) return CANCEL;
  let selected = unique(selectedRaw);
  if (selectedRaw.includes(ADD_PLAN)) {
    const extra = await pickAnother(input.prompts, input.catalog, new Set(selected));
    if (isPromptCancel(extra)) return CANCEL;
    if (extra) selected = unique([...selected, extra]);
  }

  const prices: Record<string, DeclaredPlanPrice> = {};
  const needsManual = selected.some((planId) => {
    if (flagged.has(planId)) return false;
    const plan = input.catalog?.byId.get(planId);
    return !plan || !formatOffer(plan);
  });
  if (needsManual && !input.catalog) {
    input.prompts.note(
      "Catalog prices are unavailable. Enter the amount you pay.",
      "Prices",
    );
  }

  for (const planId of selected) {
    const spec = flagged.get(planId);
    if (spec) {
      prices[planId] = priceFromSpec(spec);
      continue;
    }
    const plan = input.catalog?.byId.get(planId) ?? null;
    const offer = plan ? formatOffer(plan) : null;
    if (offer && plan) {
      const choice = await input.prompts.select({
        message: offer,
        options: [
          { value: "yes", label: "Yes" },
          { value: "other", label: "Other amount" },
          { value: "skip", label: "Skip" },
        ],
        initialValue: "yes",
      });
      if (isPromptCancel(choice)) return CANCEL;
      if (choice === "skip") continue;
      if (choice === "yes") {
        const declared = declaredFromCatalog(plan);
        if (declared) {
          prices[planId] = declared;
          continue;
        }
      }
    }
    const manual = await askManual(
      input.prompts,
      plan?.name ?? planId,
      defaultsFor(planId, input.config, input.catalog),
    );
    if (isPromptCancel(manual)) return CANCEL;
    if (manual) prices[planId] = manual;
  }
  return { plans: selected, prices };
}
