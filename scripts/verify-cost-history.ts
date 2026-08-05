/* Proves that changing a cost today does not rewrite what past orders cost.
 *
 * Touches the database, so it works on a throwaway shop id and cleans up after
 * itself. Run: npx tsx scripts/verify-cost-history.ts */
import prisma from "../app/db.server";
import {
  loadCostTimeline,
  recordMaterialPrice,
  recordZonePrice,
  seedCostHistory,
  resolveAsOf,
  EARLIEST_DAY,
} from "../app/lib/costHistory.server";

const SHOP = "verify-cost-history.myshopify.test";
const PRODUCT = "gid://shopify/Product/VERIFY1";

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
    costPerUnit: 17,
    mode: "date",
    chosenDay: "2026-08-01",
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
    costPerUnit: 16,
    mode: "correct",
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

  // --- Delivery zones behave the same way ------------------------------------
  const zone = await prisma.deliveryZone.create({
    data: { shop: SHOP, name: "Cairo", keywords: "cairo", realCost: 50, isDefault: true },
  });
  await seedCostHistory(SHOP);
  await prisma.deliveryZone.update({ where: { id: zone.id }, data: { realCost: 65 } });
  await recordZonePrice({
    shop: SHOP,
    zoneId: zone.id,
    realCost: 65,
    mode: "date",
    chosenDay: "2026-08-01",
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
