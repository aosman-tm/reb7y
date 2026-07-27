/* Sanity check for the money engine — pure functions, no DB / Shopify needed.
 * Run: npx tsx scripts/verify-profit.ts */
import {
  computeOrderPnl,
  matchZone,
  prorateExpense,
  type NormalizedOrder,
  type Zone,
  type CostMap,
} from "../app/lib/profit.server";
import type { ShopSettings } from "../app/lib/settings.server";

let failures = 0;
function check(name: string, actual: number, expected: number) {
  const ok = Math.abs(actual - expected) < 0.001;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}: got ${actual}, expected ${expected}`);
}

// Product 1 = box(5) + 20cm bubble wrap(0.5/cm=10) + card(2) + sticker(1) = 18 EGP
const costMap: CostMap = new Map([
  ["gid://shopify/Product/P1", {
    productId: "gid://shopify/Product/P1",
    title: "Product 1",
    materialCost: 18,
    returnMaterialUnitCost: 0,
    factoryCost: 0,
    otherCost: 0,
    unitCost: 18,
    returnDeliveryMode: "settings",
    returnDeliveryPercent: 100,
  }],
]);

const zones: Zone[] = [
  { id: "z1", name: "Cairo", keywords: "cairo,nasr city", realCost: 50, isDefault: false },
  { id: "z2", name: "Other", keywords: "", realCost: 70, isDefault: true },
];

const settings: ShopSettings = {
  id: "s1",
  shop: "demo.myshopify.com",
  currency: "EGP",
  paymentFeePercent: 2,
  paymentFeeFlat: 0,
  codFeePercent: 0,
  codRoundTripDefault: true,
  returnDeliveryMode: "full",
  returnDeliveryPercent: 100,
  returnDeliveryFixed: 0,
  depositMode: "none",
  depositValue: 0,
};

function order(overrides: Partial<NormalizedOrder>): NormalizedOrder {
  return {
    id: "gid://shopify/Order/A",
    name: "#A",
    createdAt: "2026-07-01T10:00:00Z",
    cancelledAt: null,
    financialStatus: "PENDING",
    fulfillmentStatus: "FULFILLED",
    gateways: ["Cash on Delivery (COD)"],
    isCOD: true,
    total: 300,
    tax: 0,
    shippingCharged: 40,
    discounts: 0,
    refunds: 0,
    city: "Nasr City",
    province: "Cairo",
    country: "Egypt",
    lineItems: [
      { productId: "gid://shopify/Product/P1", variantId: null, title: "Product 1", quantity: 1, revenue: 300 },
    ],
    ...overrides,
  };
}

console.log("\n--- Zone matching ---");
check("Nasr City matches Cairo zone (cost)", matchZone(order({}), zones)!.realCost, 50);
check(
  "Unknown city falls back to default zone (cost)",
  matchZone(order({ city: "Aswan", province: "Aswan" }), zones)!.realCost,
  70,
);

console.log("\n--- Delivered COD order ---");
// revenue 300, materials 18, delivery 50 (Cairo zone), fee 2% of 300 = 6 => profit 226
const a = computeOrderPnl(order({}), { costMap, zones, settings });
check("materials", a.materialsCost, 18);
check("real delivery (from zone)", a.realDelivery, 50);
check("payment fee 2%", a.paymentFee, 6);
check("delivery gap (40 charged - 50 real)", a.deliveryGap, -10);
check("profit", a.profit, 226);
console.log(`   source = ${a.realDeliverySource} (expected zone)`);
if (a.realDeliverySource !== "zone") failures++;

console.log("\n--- Fallback to Shopify shipping when real cost is missing ---");
const fallback = computeOrderPnl(order({ city: null, province: null }), {
  costMap,
  zones: [],
  settings,
});
check("fallback real delivery uses Shopify shipping", fallback.realDelivery, 40);
check("fallback delivery gap is break-even", fallback.deliveryGap, 0);
console.log(`   fallback source = ${fallback.realDeliverySource} (expected shopify)`);
if (fallback.realDeliverySource !== "shopify") failures++;

console.log("\n--- Rejected COD order, override 60 real, round-trip x2 ---");
// not delivered => revenue 0, materials 0, delivery 60*2=120, fee 0 => profit -120
const b = computeOrderPnl(order({}), {
  costMap,
  zones,
  settings,
  override: {
    realDeliveryCost: 60,
    deliveryOutcome: "rejected",
    roundTrip: true,
    depositMode: "settings",
    depositValue: 0,
    note: null,
  },
});
check("revenue is 0 (no sale)", b.revenue, 0);
check("materials is 0 (goods returned)", b.materialsCost, 0);
check("delivery counted twice", b.realDelivery, 120);
check("profit is the delivery loss", b.profit, -120);

console.log("\n--- Returned order with deposit recovery ---");
const withDeposit: ShopSettings = {
  ...settings,
  depositMode: "percent_real",
  depositValue: 50,
};
const e = computeOrderPnl(order({ fulfillmentStatus: "RETURNED" }), {
  costMap,
  zones,
  settings: withDeposit,
});
check("deposit collected (50% of 50)", e.depositCollected, 25);
check("courier net loss after deposit", e.courierNetLoss, 75);
check("profit includes recovered deposit", e.profit, -75);

console.log("\n--- Missing recipe (product not costed) ---");
const c = computeOrderPnl(
  order({ lineItems: [{ productId: "gid://shopify/Product/UNKNOWN", variantId: null, title: "X", quantity: 2, revenue: 300 }] }),
  { costMap, zones, settings },
);
check("materials 0 when no recipe", c.materialsCost, 0);
console.log(`   missingCost flag = ${c.missingCost} (expected true)`);
if (c.missingCost !== true) failures++;

console.log("\n--- Tax is excluded from revenue ---");
// total 330 incl 30 tax => revenue 300
const d = computeOrderPnl(order({ total: 330, tax: 30 }), { costMap, zones, settings });
check("revenue excludes tax", d.revenue, 300);

console.log("\n--- Expense proration ---");
// monthly 500 over a 30-day range => 500; over 15 days => 250
check("monthly over 30 days", prorateExpense(500, "monthly", null, "2026-07-01", "2026-07-30", 30), 500);
check("monthly over 15 days", prorateExpense(500, "monthly", null, "2026-07-01", "2026-07-15", 15), 250);
check("weekly over 7 days", prorateExpense(100, "weekly", null, "2026-07-01", "2026-07-07", 7), 100);
check("daily over 10 days", prorateExpense(20, "daily", null, "2026-07-01", "2026-07-10", 10), 200);
check(
  "one-time inside range counts",
  prorateExpense(300, "once", "2026-07-05", "2026-07-01", "2026-07-31", 31),
  300,
);
check(
  "one-time outside range is 0",
  prorateExpense(300, "once", "2026-06-05", "2026-07-01", "2026-07-31", 31),
  0,
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
