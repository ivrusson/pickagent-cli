/** `--price <planId>=<amount><EUR|USD>[/mo|/yr]` */

const PRICE_RE =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)=(\d+(?:[.,]\d+)?)(EUR|USD)(?:\/(mo|yr))?$/;

export type PriceSpec = {
  planId: string;
  amount: number;
  currency: "EUR" | "USD";
  billing: "monthly" | "yearly";
};

export function parsePriceSpec(raw: string): PriceSpec | null {
  const match = PRICE_RE.exec(raw.trim());
  if (!match) return null;
  const planId = match[1] ?? "";
  if (!planId || planId.length > 48) return null;
  const amount = Number((match[2] ?? "").replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const currency = match[3] === "USD" ? "USD" : "EUR";
  const billing = match[4] === "yr" ? "yearly" : "monthly";
  return { planId, amount, currency, billing };
}
