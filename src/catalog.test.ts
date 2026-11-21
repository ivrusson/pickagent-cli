import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogPricesUrl,
  declaredFromCatalog,
  fetchCatalogPrices,
  formatOffer,
  indexCatalog,
} from "./catalog";

const cursorSuper = {
  catalogVersion: "0123456789abcdef",
  generatedAt: "2026-11-20T12:00:00.000Z",
  plans: [
    {
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
    },
  ],
};

test("catalog prices use PICKAGENT_API_URL and fall back when the request fails", async () => {
  assert.equal(
    catalogPricesUrl({ PICKAGENT_API_URL: "https://example.test/root/" }),
    "https://example.test/root/api/catalog/prices",
  );
  assert.equal(catalogPricesUrl({}), "https://pickagent.dev/api/catalog/prices");
  assert.equal(catalogPricesUrl({ PICKAGENT_API_URL: "not a url" }), null);

  let url = "";
  const offline = await fetchCatalogPrices({ PICKAGENT_API_URL: "https://example.test" }, async (input) => {
    url = String(input);
    throw new Error("offline");
  });
  assert.equal(offline, null);
  assert.equal(url, "https://example.test/api/catalog/prices");

  const missing = await fetchCatalogPrices({}, async () => new Response("nope", { status: 503 }));
  assert.equal(missing, null);

  const bad = await fetchCatalogPrices({}, async () =>
    Response.json({ plans: [{ id: "nope", limits: [] }] }),
  );
  assert.equal(bad, null);
});

test("a catalog quote prefers EUR and becomes a declared price", () => {
  const index = indexCatalog(cursorSuper);
  assert.ok(index);
  const plan = index.byId.get("cursor-super");
  assert.ok(plan);
  assert.equal(formatOffer(plan), "Cursor Super — €107.80/mo (VAT incl.)");
  const declared = declaredFromCatalog(plan);
  assert.equal(declared?.amount, 107.8);
  assert.equal(declared?.currency, "EUR");
  assert.equal(declared?.billing, "monthly");
  assert.equal(declared?.provenance, "declared");
});
