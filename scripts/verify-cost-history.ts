/* Proves that changing a cost today does not rewrite what past orders cost.
 *
 * Touches the database, so it works on a throwaway shop id and cleans up after
 * itself. Run: npx tsx scripts/verify-cost-history.ts */
import prisma from "../app/db.server";
import {
  loadCostTimeline,
  recordMaterialPrice,
  recordZonePrice,
  setMaterialTimeline,
  seedCostHistory,
  resolveAsOf,
  EARLIEST_DAY,
} from "../app/lib/costHistory.server";
import {
  applyPriceChange,
  toPeriods,
  describePeriod,
  fromEditorModel,
  toEditorModel,
} from "../app/lib/priceTimeline";
import { todayString } from "../app/lib/dates";

const SHOP = "verify-cost-history.myshopify.test";
const PRODUCT = "gid://shopify/Product/VERIFY1";
const TODAY = todayString();

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = typeof actual === "number" && typeof expected === "number"
    ? Math.abs(actual - expected) < 0.001
    : actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}: got ${actual}, expected ${expected}`);
}

async function cleanup() {
  await prisma.materialPrice.deleteMany({ where: { shop: SHOP } });
  await prisma.productCostVersion.deleteMany({ where: { shop: SHOP } });
  await prisma.deliveryZonePrice.deleteMany({ where: { shop: SHOP } });
  await prisma.bomLine.deleteMany({ where: { productCost: { shop: SHOP } } });
  await prisma.productCost.deleteMany({ where: { shop: SHOP } });
  await prisma.material.deleteMany({ where: { shop: SHOP } });
  await prisma.deliveryZone.deleteMany({ where: { shop: SHOP } });
}

async function main() {
  await cleanup();

  // --- Pure resolution rules -------------------------------------------------
  const rows = [
    { effectiveFrom: "2026-01-01", v: 10 },
    { effectiveFrom: "2026-06-01", v: 20 },
    { effectiveFrom: "2026-08-01", v: 30 },
  ];
  check("picks the entry in effect", resolveAsOf(rows, "2026-07-15")?.v, 20);
  check("picks the newest on an exact date", resolveAsOf(rows, "2026-08-01")?.v, 30);
  check("dates before all entries fall back to oldest", resolveAsOf(rows, "2025-01-01")?.v, 10);

  // --- What the preview shows is what gets stored ---------------------------
  const base = [{ effectiveFrom: EARLIEST_DAY, amount: 15 }];
  const periods = toPeriods(
    applyPriceChange(base, { mode: "range", amount: 25, from: "2026-03-01", to: "2026-03-31" }),
  );
  check("a period produces three stretches of time", periods.length, 3);
  check("the first stretch keeps the old price", periods[0].amount, 15);
  check("the middle stretch is the new price", periods[1].amount, 25);
  check("the last stretch returns to the old price", periods[2].amount, 15);
  check("the period reads plainly", describePeriod(periods[1], EARLIEST_DAY), "1 Mar 2026 – 31 Mar 2026");
  check("the open-ended tail reads plainly", describePeriod(periods[2], EARLIEST_DAY), "From 1 Apr 2026 onward");
  check(
    "a period inside another replaces it",
    toPeriods(
      applyPriceChange(
        [
          { effectiveFrom: EARLIEST_DAY, amount: 15 },
          { effectiveFrom: "2026-03-10", amount: 40 },
        ],
        { mode: "range", amount: 25, from: "2026-03-01", to: "2026-03-31" },
      ),
    ).length,
    3,
  );

  // --- The box scenario ------------------------------------------------------
  // A box costing 15 EGP, used one per product.
  const box = await prisma.material.create({
    data: { shop: SHOP, name: "Small box", unit: "piece", costPerUnit: 15 },
  });
  const product = await prisma.productCost.create({
    data: { shop: SHOP, productId: PRODUCT, title: "Verify product", factoryCost: 5, otherCost: 0 },
  });
  await prisma.bomLine.create({
    data: { productCostId: product.id, materialId: box.id, quantity: 1 },
  });

  // Baseline the current cost, exactly as the screens do before an edit.
  await seedCostHistory(SHOP);

  // The supplier raises the box to 17 EGP starting 1 August 2026.
  await prisma.material.update({ where: { id: box.id }, data: { costPerUnit: 17 } });
  await recordMaterialPrice({
    shop: SHOP,
    materialId: box.id,
    change: { mode: "date", amount: 17, from: "2026-08-01" },
  });

  const timeline = await loadCostTimeline(SHOP);
  const julyCost = timeline.costMapAt("2026-07-15").get(PRODUCT);
  const augustCost = timeline.costMapAt("2026-08-05").get(PRODUCT);

  check("a July order still costs the old 15 EGP box", julyCost?.materialCost, 15);
  check("a July order's total unit cost is unchanged", julyCost?.unitCost, 20); // 15 + 5 factory
  check("an August order uses the new 17 EGP box", augustCost?.materialCost, 17);
  check("an August order's total unit cost rises", augustCost?.unitCost, 22);

  // --- Correcting a genuine mistake SHOULD rewrite history --------------------
  await recordMaterialPrice({
    shop: SHOP,
    materialId: box.id,
    change: { mode: "correct", amount: 16, today: TODAY },
  });
  const afterFix = await loadCostTimeline(SHOP);
  check(
    "'fix a mistake' rewrites the price in effect",
    afterFix.costMapAt("2026-08-05").get(PRODUCT)?.materialCost,
    16,
  );
  check(
    "'fix a mistake' leaves the earlier period alone",
    afterFix.costMapAt("2026-07-15").get(PRODUCT)?.materialCost,
    15,
  );

  // --- A price that applied only for a period --------------------------------
  // Reset to a clean single price, then say the box cost 25 EGP only during
  // March 2026 (a temporary supplier) and went back afterwards.
  await recordMaterialPrice({
    shop: SHOP,
    materialId: box.id,
    change: { mode: "correct", amount: 15, today: TODAY },
  });
  await prisma.materialPrice.deleteMany({
    where: { shop: SHOP, materialId: box.id, effectiveFrom: { gt: EARLIEST_DAY } },
  });
  await recordMaterialPrice({
    shop: SHOP,
    materialId: box.id,
    change: { mode: "range", amount: 25, from: "2026-03-01", to: "2026-03-31" },
  });

  const ranged = await loadCostTimeline(SHOP);
  check("before the period: old price", ranged.costMapAt("2026-02-28").get(PRODUCT)?.materialCost, 15);
  check("first day of the period: new price", ranged.costMapAt("2026-03-01").get(PRODUCT)?.materialCost, 25);
  check("inside the period: new price", ranged.costMapAt("2026-03-15").get(PRODUCT)?.materialCost, 25);
  check("last day of the period: new price", ranged.costMapAt("2026-03-31").get(PRODUCT)?.materialCost, 25);
  check("day after the period: back to old", ranged.costMapAt("2026-04-01").get(PRODUCT)?.materialCost, 15);
  check("long after the period: still old", ranged.costMapAt("2026-08-05").get(PRODUCT)?.materialCost, 15);

  const liveAfterRange = await prisma.material.findUnique({ where: { id: box.id } });
  check("a past-only period leaves today's price alone", liveAfterRange?.costPerUnit, 15);

  // --- The editor model: current price + earlier periods ---------------------
  // What the merchant types in the add/edit form must survive a round trip.
  const typed = {
    current: 15,
    periods: [{ from: "2025-08-01", to: "2025-08-15", amount: 20 }],
  };
  const stored = fromEditorModel(typed, EARLIEST_DAY);
  const readBack = toEditorModel(stored, TODAY, EARLIEST_DAY);
  check("the current price survives a round trip", readBack.current, 15);
  check("the earlier period survives a round trip", readBack.periods.length, 1);
  check("its start date survives", readBack.periods[0].from, "2025-08-01");
  check("its end date survives", readBack.periods[0].to, "2025-08-15");
  check("its price survives", readBack.periods[0].amount, 20);

  // A material saved straight from the form must price orders accordingly.
  await setMaterialTimeline({ shop: SHOP, materialId: box.id, entries: stored });
  const formSaved = await loadCostTimeline(SHOP);
  check("before the typed period", formSaved.costMapAt("2025-07-31").get(PRODUCT)?.materialCost, 15);
  check("inside the typed period", formSaved.costMapAt("2025-08-10").get(PRODUCT)?.materialCost, 20);
  check("after the typed period", formSaved.costMapAt("2025-08-16").get(PRODUCT)?.materialCost, 15);

  const liveAfterForm = await prisma.material.findUnique({ where: { id: box.id } });
  check("the list page shows the current price", liveAfterForm?.costPerUnit, 15);

  check(
    "a material with no periods stores one price",
    fromEditorModel({ current: 12, periods: [] }, EARLIEST_DAY).length,
    1,
  );

  // --- Delivery zones behave the same way ------------------------------------
  const zone = await prisma.deliveryZone.create({
    data: { shop: SHOP, name: "Cairo", keywords: "cairo", realCost: 50, isDefault: true },
  });
  await seedCostHistory(SHOP);
  await prisma.deliveryZone.update({ where: { id: zone.id }, data: { realCost: 65 } });
  await recordZonePrice({
    shop: SHOP,
    zoneId: zone.id,
    change: { mode: "date", amount: 65, from: "2026-08-01" },
  });

  const zoneTimeline = await loadCostTimeline(SHOP);
  const julyZone = zoneTimeline.zonesAt("2026-07-15").find((z) => z.id === zone.id);
  const augZone = zoneTimeline.zonesAt("2026-08-05").find((z) => z.id === zone.id);
  check("a July order keeps the old 50 EGP courier cost", julyZone?.realCost, 50);
  check("an August order uses the new 65 EGP courier cost", augZone?.realCost, 65);

  // --- Seeding is idempotent -------------------------------------------------
  const before = await prisma.materialPrice.count({ where: { shop: SHOP } });
  await seedCostHistory(SHOP);
  const after = await prisma.materialPrice.count({ where: { shop: SHOP } });
  check("re-seeding adds no duplicate rows", after, before);

  const seeded = await prisma.materialPrice.findFirst({
    where: { shop: SHOP, materialId: box.id, effectiveFrom: EARLIEST_DAY },
  });
  check("the baseline entry kept the ORIGINAL price", seeded?.costPerUnit, 15);

  await cleanup();

  console.log(failures === 0 ? "\nAll cost-history checks passed." : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});
