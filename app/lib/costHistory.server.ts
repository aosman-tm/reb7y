/**
 * Dated cost history.
 *
 * A report has to show what an order actually cost on the day it happened. If
 * costs are read live, raising a box from 15 to 17 EGP silently rewrites the
 * profit of every order ever placed, and last month's numbers change after the
 * month is over.
 *
 * So every cost that feeds an order's profit is stored with the day it started:
 *
 *   MaterialPrice       what one unit of a material cost from a day onward
 *   ProductCostVersion  a complete snapshot of one product's unit cost
 *   DeliveryZonePrice   a zone's real courier cost from a day onward
 *
 * The Material / ProductCost / DeliveryZone rows stay the values the merchant
 * edits on screen; these tables are the history behind them.
 *
 * ProductCostVersion is a full snapshot rather than a pointer at the recipe,
 * because a recipe is itself editable: if it were resolved live, adding a
 * material to a product tomorrow would change what that product cost last year.
 */
import prisma from "../db.server";
import { round2 } from "./money";
import { todayString } from "./dates";

/** What the merchant chose when saving a new cost. */
export type ApplyMode = "today" | "date" | "correct";

/** Far enough back to cover any order a Shopify store could have. */
export const EARLIEST_DAY = "2000-01-01";

/** Per-unit cost of a product, as it stood on some day. */
export type ProductUnitCost = {
  productId: string;
  title: string;
  materialCost: number;
  returnMaterialUnitCost: number;
  factoryCost: number;
  otherCost: number;
  unitCost: number;
  returnDeliveryMode: string;
  returnDeliveryPercent: number;
};

export type CostMap = Map<string, ProductUnitCost>;

export type Zone = {
  id: string;
  name: string;
  keywords: string;
  realCost: number;
  isDefault: boolean;
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The entry in effect on `day`: the newest one starting on or before it.
 *
 * If the day predates every entry we fall back to the OLDEST entry instead of
 * returning nothing. A merchant who enters their costs today should not see
 * last month's orders priced at zero — the earliest price they ever recorded is
 * a far better estimate of what things cost before that.
 */
export function resolveAsOf<T extends { effectiveFrom: string }>(
  rows: T[],
  day: string,
): T | undefined {
  let inEffect: T | undefined;
  let oldest: T | undefined;
  for (const row of rows) {
    if (!oldest || row.effectiveFrom < oldest.effectiveFrom) oldest = row;
    if (row.effectiveFrom <= day && (!inEffect || row.effectiveFrom > inEffect.effectiveFrom)) {
      inEffect = row;
    }
  }
  return inEffect ?? oldest;
}

/** Turn the merchant's choice into the day the new cost starts from. */
export function effectiveDayFor(mode: ApplyMode, chosenDay?: string | null): string {
  if (mode === "date" && chosenDay && /^\d{4}-\d{2}-\d{2}$/.test(chosenDay)) return chosenDay;
  return todayString();
}

// ---------------------------------------------------------------------------
// Reading: the whole timeline for a shop
// ---------------------------------------------------------------------------

export type CostTimeline = {
  /** Product costs as they stood on `day`. */
  costMapAt: (day: string) => CostMap;
  /** Delivery zones with the real cost that applied on `day`. */
  zonesAt: (day: string) => Zone[];
};

/**
 * Load every cost and its history once, and hand back resolvers keyed by day.
 *
 * Results are memoised per day: a report covering 30 days resolves 30 times,
 * not once per order.
 */
export async function loadCostTimeline(shop: string): Promise<CostTimeline> {
  const [productRows, versionRows, materialPriceRows, zoneRows, zonePriceRows] = await Promise.all([
    prisma.productCost.findMany({
      where: { shop },
      include: { bomLines: { include: { material: true } } },
    }),
    prisma.productCostVersion.findMany({ where: { shop } }),
    prisma.materialPrice.findMany({ where: { shop } }),
    prisma.deliveryZone.findMany({ where: { shop } }),
    prisma.deliveryZonePrice.findMany({ where: { shop } }),
  ]);

  const versionsByProduct = groupBy(versionRows, (v) => v.productId);
  const pricesByMaterial = groupBy(materialPriceRows, (p) => p.materialId);
  const pricesByZone = groupBy(zonePriceRows, (p) => p.zoneId);

  const costCache = new Map<string, CostMap>();
  const zoneCache = new Map<string, Zone[]>();

  const materialCostAt = (materialId: string, liveCost: number, day: string): number => {
    const history = pricesByMaterial.get(materialId);
    if (!history?.length) return liveCost;
    return resolveAsOf(history, day)?.costPerUnit ?? liveCost;
  };

  const costMapAt = (day: string): CostMap => {
    const cached = costCache.get(day);
    if (cached) return cached;

    const map: CostMap = new Map();
    for (const row of productRows) {
      const version = resolveAsOf(versionsByProduct.get(row.productId) ?? [], day);

      if (version) {
        // A recorded snapshot wins outright — it is what this product cost.
        map.set(row.productId, {
          productId: row.productId,
          title: row.title,
          materialCost: round2(version.materialCost),
          returnMaterialUnitCost: round2(version.returnMaterialCost),
          factoryCost: round2(version.factoryCost),
          otherCost: round2(version.otherCost),
          unitCost: round2(version.materialCost + version.factoryCost + version.otherCost),
          returnDeliveryMode: version.returnDeliveryMode,
          returnDeliveryPercent: version.returnDeliveryPercent,
        });
        continue;
      }

      // No snapshot yet (product costed before this feature, or never edited
      // since): fall back to the live recipe priced at that day's material costs.
      let materialCost = 0;
      let returnMaterialCost = 0;
      for (const line of row.bomLines) {
        const unit = materialCostAt(line.materialId, line.material.costPerUnit, day);
        materialCost += line.quantity * unit;
        if (line.countOnReturn) returnMaterialCost += line.quantity * unit;
      }
      map.set(row.productId, {
        productId: row.productId,
        title: row.title,
        materialCost: round2(materialCost),
        returnMaterialUnitCost: round2(returnMaterialCost),
        factoryCost: round2(row.factoryCost),
        otherCost: round2(row.otherCost),
        unitCost: round2(materialCost + row.factoryCost + row.otherCost),
        returnDeliveryMode: row.returnDeliveryMode,
        returnDeliveryPercent: row.returnDeliveryPercent,
      });
    }

    costCache.set(day, map);
    return map;
  };

  const zonesAt = (day: string): Zone[] => {
    const cached = zoneCache.get(day);
    if (cached) return cached;

    const list = zoneRows.map((z) => {
      const history = pricesByZone.get(z.id);
      const realCost = history?.length
        ? (resolveAsOf(history, day)?.realCost ?? z.realCost)
        : z.realCost;
      return {
        id: z.id,
        name: z.name,
        keywords: z.keywords,
        realCost,
        isDefault: z.isDefault,
      };
    });

    zoneCache.set(day, list);
    return list;
  };

  return { costMapAt, zonesAt };
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Writing: recording a cost change
// ---------------------------------------------------------------------------

/**
 * Compute and store what a product costs from `day` onward.
 *
 * Materials are priced as of `day`, so backdating a change uses the material
 * prices that applied then rather than today's.
 */
export async function recordProductVersion(args: {
  shop: string;
  productId: string;
  day: string;
  reason?: string;
}): Promise<void> {
  const { shop, productId, day, reason = "edit" } = args;

  const product = await prisma.productCost.findFirst({
    where: { shop, productId },
    include: { bomLines: { include: { material: true } } },
  });
  if (!product) return;

  const materialIds = product.bomLines.map((l) => l.materialId);
  const priceRows = materialIds.length
    ? await prisma.materialPrice.findMany({ where: { shop, materialId: { in: materialIds } } })
    : [];
  const pricesByMaterial = groupBy(priceRows, (p) => p.materialId);

  let materialCost = 0;
  let returnMaterialCost = 0;
  for (const line of product.bomLines) {
    const history = pricesByMaterial.get(line.materialId);
    const unit = history?.length
      ? (resolveAsOf(history, day)?.costPerUnit ?? line.material.costPerUnit)
      : line.material.costPerUnit;
    materialCost += line.quantity * unit;
    if (line.countOnReturn) returnMaterialCost += line.quantity * unit;
  }

  const data = {
    materialCost: round2(materialCost),
    returnMaterialCost: round2(returnMaterialCost),
    factoryCost: round2(product.factoryCost),
    otherCost: round2(product.otherCost),
    returnDeliveryMode: product.returnDeliveryMode,
    returnDeliveryPercent: product.returnDeliveryPercent,
    reason,
  };

  await prisma.productCostVersion.upsert({
    where: { shop_productId_effectiveFrom: { shop, productId, effectiveFrom: day } },
    create: { shop, productId, effectiveFrom: day, ...data },
    update: data,
  });
}

/**
 * Record a product cost change the merchant just made.
 *
 * "correct" overwrites the version currently in effect instead of adding a new
 * one, because the merchant is fixing a number that was always wrong.
 */
export async function recordProductCostChange(args: {
  shop: string;
  productId: string;
  mode: ApplyMode;
  chosenDay?: string | null;
  reason?: string;
}): Promise<void> {
  const { shop, productId, mode, chosenDay, reason = "edit" } = args;

  let day = effectiveDayFor(mode, chosenDay);
  if (mode === "correct") {
    const existing = await prisma.productCostVersion.findMany({ where: { shop, productId } });
    const inEffect = resolveAsOf(existing, todayString());
    day = inEffect?.effectiveFrom ?? EARLIEST_DAY;
  }

  await recordProductVersion({ shop, productId, day, reason });
}

/** Every product whose recipe uses this material. */
async function productsUsingMaterial(shop: string, materialId: string): Promise<string[]> {
  const lines = await prisma.bomLine.findMany({
    where: { materialId, productCost: { shop } },
    include: { productCost: { select: { productId: true } } },
  });
  return Array.from(new Set(lines.map((l) => l.productCost.productId)));
}

/**
 * Save a new material price and push the consequences into every product that
 * uses it, so their snapshots stay in step.
 *
 * "correct" rewrites the price currently in effect instead of adding a new one
 * — the merchant is fixing a number that was always wrong, so old reports are
 * meant to change.
 */
export async function recordMaterialPrice(args: {
  shop: string;
  materialId: string;
  costPerUnit: number;
  mode: ApplyMode;
  chosenDay?: string | null;
}): Promise<void> {
  const { shop, materialId, costPerUnit, mode, chosenDay } = args;

  if (mode === "correct") {
    const existing = await prisma.materialPrice.findMany({ where: { shop, materialId } });
    const inEffect = resolveAsOf(existing, todayString());
    if (inEffect) {
      await prisma.materialPrice.update({
        where: { id: inEffect.id },
        data: { costPerUnit },
      });
      await refreshProductsForMaterial(shop, materialId, inEffect.effectiveFrom);
      return;
    }
    // Nothing recorded yet: fall through and start the history at the beginning
    // of time so the correction covers every existing order.
  }

  const day = mode === "correct" ? EARLIEST_DAY : effectiveDayFor(mode, chosenDay);

  await prisma.materialPrice.upsert({
    where: { shop_materialId_effectiveFrom: { shop, materialId, effectiveFrom: day } },
    create: { shop, materialId, costPerUnit, effectiveFrom: day },
    update: { costPerUnit },
  });

  await refreshProductsForMaterial(shop, materialId, day);
}

/** Re-snapshot every product using this material, from `day` onward. */
async function refreshProductsForMaterial(shop: string, materialId: string, day: string) {
  const productIds = await productsUsingMaterial(shop, materialId);
  for (const productId of productIds) {
    await recordProductVersion({ shop, productId, day, reason: "material" });
  }
}

/** Save a new real courier cost for a zone. */
export async function recordZonePrice(args: {
  shop: string;
  zoneId: string;
  realCost: number;
  mode: ApplyMode;
  chosenDay?: string | null;
}): Promise<void> {
  const { shop, zoneId, realCost, mode, chosenDay } = args;

  if (mode === "correct") {
    const existing = await prisma.deliveryZonePrice.findMany({ where: { shop, zoneId } });
    const inEffect = resolveAsOf(existing, todayString());
    if (inEffect) {
      await prisma.deliveryZonePrice.update({ where: { id: inEffect.id }, data: { realCost } });
      return;
    }
  }

  const day = mode === "correct" ? EARLIEST_DAY : effectiveDayFor(mode, chosenDay);
  await prisma.deliveryZonePrice.upsert({
    where: { shop_zoneId_effectiveFrom: { shop, zoneId, effectiveFrom: day } },
    create: { shop, zoneId, realCost, effectiveFrom: day },
    update: { realCost },
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Give anything without history a starting entry, dated far enough back to
 * cover existing orders. Safe to call repeatedly: it only fills gaps.
 */
export async function seedCostHistory(shop: string): Promise<void> {
  const [materials, products, zones, materialPrices, versions, zonePrices] = await Promise.all([
    prisma.material.findMany({ where: { shop } }),
    prisma.productCost.findMany({ where: { shop }, select: { productId: true } }),
    prisma.deliveryZone.findMany({ where: { shop } }),
    prisma.materialPrice.findMany({ where: { shop }, select: { materialId: true } }),
    prisma.productCostVersion.findMany({ where: { shop }, select: { productId: true } }),
    prisma.deliveryZonePrice.findMany({ where: { shop }, select: { zoneId: true } }),
  ]);

  const haveMaterial = new Set(materialPrices.map((p) => p.materialId));
  const haveProduct = new Set(versions.map((v) => v.productId));
  const haveZone = new Set(zonePrices.map((p) => p.zoneId));

  for (const m of materials) {
    if (haveMaterial.has(m.id)) continue;
    await prisma.materialPrice.create({
      data: {
        shop,
        materialId: m.id,
        costPerUnit: m.costPerUnit,
        effectiveFrom: EARLIEST_DAY,
        note: "starting price",
      },
    });
  }

  for (const z of zones) {
    if (haveZone.has(z.id)) continue;
    await prisma.deliveryZonePrice.create({
      data: {
        shop,
        zoneId: z.id,
        realCost: z.realCost,
        effectiveFrom: EARLIEST_DAY,
        note: "starting cost",
      },
    });
  }

  for (const p of products) {
    if (haveProduct.has(p.productId)) continue;
    await recordProductVersion({
      shop,
      productId: p.productId,
      day: EARLIEST_DAY,
      reason: "seed",
    });
  }
}

// ---------------------------------------------------------------------------
// History for display
// ---------------------------------------------------------------------------

export type PriceHistoryEntry = { effectiveFrom: string; amount: number };

export async function materialPriceHistory(
  shop: string,
  materialId: string,
): Promise<PriceHistoryEntry[]> {
  const rows = await prisma.materialPrice.findMany({
    where: { shop, materialId },
    orderBy: { effectiveFrom: "desc" },
  });
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, amount: r.costPerUnit }));
}

export async function zonePriceHistory(
  shop: string,
  zoneId: string,
): Promise<PriceHistoryEntry[]> {
  const rows = await prisma.deliveryZonePrice.findMany({
    where: { shop, zoneId },
    orderBy: { effectiveFrom: "desc" },
  });
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, amount: r.realCost }));
}
