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
 * edits on screen; these tables are the history behind them. After any change
 * the editable row is re-synced to whatever is in effect today, so "the price"
 * on screen always means "the price right now".
 *
 * ProductCostVersion is a full snapshot rather than a pointer at the recipe,
 * because a recipe is itself editable: if it were resolved live, adding a
 * material to a product tomorrow would change what that product cost last year.
 *
 * What gets stored is decided by applyPriceChange in ./priceTimeline, which the
 * edit screens also use to preview the result. One implementation, so the
 * preview cannot disagree with what actually happens.
 */
import prisma from "../db.server";
import { round2 } from "./money";
import { todayString } from "./dates";
import {
  EARLIEST_DAY,
  applyPriceChange,
  amountOn,
  nextDay,
  type PriceChange,
  type PriceEntry,
} from "./priceTimeline";

export type { PriceChange, PriceEntry };
export { EARLIEST_DAY };

/** What the merchant chose when saving a new cost. */
export type ApplyMode = "today" | "date" | "range" | "correct";

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

/** The non-material part of a product's cost, versioned alongside it. */
type ProductExtras = {
  factoryCost: number;
  otherCost: number;
  returnDeliveryMode: string;
  returnDeliveryPercent: number;
};

// ---------------------------------------------------------------------------
// Reading a change off a form
// ---------------------------------------------------------------------------

/** Build the change the merchant asked for from submitted form fields. */
export function priceChangeFromForm(form: FormData, amount: number): PriceChange {
  const today = todayString();
  const raw = String(form.get("applyMode") ?? "today");
  const from = String(form.get("applyFrom") ?? "");
  const to = String(form.get("applyTo") ?? "");
  const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

  if (raw === "date" && isDay(from)) return { mode: "date", amount, from };
  if (raw === "range" && isDay(from) && isDay(to)) {
    // Tolerate the two dates being entered the wrong way round.
    const [a, b] = from <= to ? [from, to] : [to, from];
    return { mode: "range", amount, from: a, to: b };
  }
  if (raw === "correct") return { mode: "correct", amount, today };
  return { mode: "today", amount, today };
}

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
      return { id: z.id, name: z.name, keywords: z.keywords, realCost, isDefault: z.isDefault };
    });

    zoneCache.set(day, list);
    return list;
  };

  return { costMapAt, zonesAt };
}

// ---------------------------------------------------------------------------
// Writing: product cost versions
// ---------------------------------------------------------------------------

/** The recipe cost of a product on a given day, priced with that day's materials. */
async function materialCostOn(
  shop: string,
  productId: string,
  day: string,
): Promise<{ materialCost: number; returnMaterialCost: number } | null> {
  const product = await prisma.productCost.findFirst({
    where: { shop, productId },
    include: { bomLines: { include: { material: true } } },
  });
  if (!product) return null;

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
  return { materialCost, returnMaterialCost };
}

/** The product's live (currently editable) non-material costs. */
async function liveExtras(shop: string, productId: string): Promise<ProductExtras | null> {
  const row = await prisma.productCost.findFirst({ where: { shop, productId } });
  if (!row) return null;
  return {
    factoryCost: row.factoryCost,
    otherCost: row.otherCost,
    returnDeliveryMode: row.returnDeliveryMode,
    returnDeliveryPercent: row.returnDeliveryPercent,
  };
}

/** The non-material costs that applied on `day`, falling back to the live row. */
async function extrasOn(shop: string, productId: string, day: string): Promise<ProductExtras | null> {
  const versions = await prisma.productCostVersion.findMany({ where: { shop, productId } });
  const version = resolveAsOf(versions, day);
  if (version) {
    return {
      factoryCost: version.factoryCost,
      otherCost: version.otherCost,
      returnDeliveryMode: version.returnDeliveryMode,
      returnDeliveryPercent: version.returnDeliveryPercent,
    };
  }
  return liveExtras(shop, productId);
}

/** Store what a product cost from `day` onward, with explicit non-material costs. */
async function writeProductVersion(args: {
  shop: string;
  productId: string;
  day: string;
  extras: ProductExtras;
  reason: string;
}): Promise<void> {
  const { shop, productId, day, extras, reason } = args;
  const materials = await materialCostOn(shop, productId, day);
  if (!materials) return;

  const data = {
    materialCost: round2(materials.materialCost),
    returnMaterialCost: round2(materials.returnMaterialCost),
    factoryCost: round2(extras.factoryCost),
    otherCost: round2(extras.otherCost),
    returnDeliveryMode: extras.returnDeliveryMode,
    returnDeliveryPercent: extras.returnDeliveryPercent,
    reason,
  };

  await prisma.productCostVersion.upsert({
    where: { shop_productId_effectiveFrom: { shop, productId, effectiveFrom: day } },
    create: { shop, productId, effectiveFrom: day, ...data },
    update: data,
  });
}

/**
 * Re-snapshot a product from `day` onward, keeping the non-material costs that
 * already applied then.
 *
 * Used when a MATERIAL price moved: the recipe cost changes, but the factory
 * cost that applied back then must not be overwritten with today's.
 */
export async function recordProductVersion(args: {
  shop: string;
  productId: string;
  day: string;
  reason?: string;
}): Promise<void> {
  const { shop, productId, day, reason = "edit" } = args;
  const extras = await extrasOn(shop, productId, day);
  if (!extras) return;
  await writeProductVersion({ shop, productId, day, extras, reason });
}

/**
 * Record a product cost change the merchant just made, honouring when they said
 * it applies. The live ProductCost row is then re-synced to whatever is in
 * effect today.
 */
export async function recordProductCostChange(args: {
  shop: string;
  productId: string;
  change: PriceChange;
  reason?: string;
}): Promise<void> {
  const { shop, productId, change, reason = "edit" } = args;
  const now = await liveExtras(shop, productId);
  if (!now) return;

  if (change.mode === "range") {
    // Read what applies after the period BEFORE touching anything.
    const dayAfter = nextDay(change.to);
    const after = await extrasOn(shop, productId, dayAfter);

    // The whole period becomes this one cost.
    await prisma.productCostVersion.deleteMany({
      where: {
        shop,
        productId,
        effectiveFrom: { gt: change.from, lte: change.to },
      },
    });
    await writeProductVersion({ shop, productId, day: change.from, extras: now, reason });

    const following = await prisma.productCostVersion.findFirst({
      where: { shop, productId, effectiveFrom: dayAfter },
    });
    if (!following && after) {
      await writeProductVersion({ shop, productId, day: dayAfter, extras: after, reason: "revert" });
    }
  } else if (change.mode === "correct") {
    const versions = await prisma.productCostVersion.findMany({ where: { shop, productId } });
    const target = resolveAsOf(versions, todayString());
    await writeProductVersion({
      shop,
      productId,
      day: target?.effectiveFrom ?? EARLIEST_DAY,
      extras: now,
      reason,
    });
  } else {
    const day = change.mode === "date" ? change.from : change.today;
    await writeProductVersion({ shop, productId, day, extras: now, reason });
  }

  await syncLiveProductCost(shop, productId);
}

/**
 * Replace a product's factory/other cost timeline with what the merchant
 * entered.
 *
 * Versions are rewritten at every day any input changes — the two cost
 * timelines plus the days its materials changed price — so each stored snapshot
 * is complete and no day silently inherits the wrong recipe cost.
 */
export async function setProductExtrasTimeline(args: {
  shop: string;
  productId: string;
  factory: PriceEntry[];
  other: PriceEntry[];
  returnDeliveryMode: string;
  returnDeliveryPercent: number;
}): Promise<void> {
  const { shop, productId, factory, other, returnDeliveryMode, returnDeliveryPercent } = args;

  const product = await prisma.productCost.findFirst({
    where: { shop, productId },
    include: { bomLines: true },
  });
  if (!product) return;

  const materialIds = product.bomLines.map((l) => l.materialId);
  const materialDays = materialIds.length
    ? (
        await prisma.materialPrice.findMany({
          where: { shop, materialId: { in: materialIds } },
          select: { effectiveFrom: true },
        })
      ).map((r) => r.effectiveFrom)
    : [];

  const days = Array.from(
    new Set([
      EARLIEST_DAY,
      ...factory.map((e) => e.effectiveFrom),
      ...other.map((e) => e.effectiveFrom),
      ...materialDays,
    ]),
  ).sort();

  await prisma.productCostVersion.deleteMany({ where: { shop, productId } });
  for (const day of days) {
    await writeProductVersion({
      shop,
      productId,
      day,
      extras: {
        factoryCost: amountOn(factory, day) ?? 0,
        otherCost: amountOn(other, day) ?? 0,
        returnDeliveryMode,
        returnDeliveryPercent,
      },
      reason: "edit",
    });
  }

  await syncLiveProductCost(shop, productId);
}

/** Put the editable row back in step with the version in effect today. */
async function syncLiveProductCost(shop: string, productId: string): Promise<void> {
  const versions = await prisma.productCostVersion.findMany({ where: { shop, productId } });
  const current = resolveAsOf(versions, todayString());
  if (!current) return;
  await prisma.productCost.updateMany({
    where: { shop, productId },
    data: {
      factoryCost: current.factoryCost,
      otherCost: current.otherCost,
      returnDeliveryMode: current.returnDeliveryMode,
      returnDeliveryPercent: current.returnDeliveryPercent,
    },
  });
}

// ---------------------------------------------------------------------------
// Writing: material prices
// ---------------------------------------------------------------------------

/** Every product whose recipe uses this material. */
async function productsUsingMaterial(shop: string, materialId: string): Promise<string[]> {
  const lines = await prisma.bomLine.findMany({
    where: { materialId, productCost: { shop } },
    include: { productCost: { select: { productId: true } } },
  });
  return Array.from(new Set(lines.map((l) => l.productCost.productId)));
}

/**
 * Replace a material's whole price timeline with what the merchant entered,
 * and push the consequences into every product that uses it.
 */
export async function setMaterialTimeline(args: {
  shop: string;
  materialId: string;
  entries: PriceEntry[];
}): Promise<void> {
  const { shop, materialId, entries } = args;
  const existing = await prisma.materialPrice.findMany({ where: { shop, materialId } });
  const before: PriceEntry[] = existing.map((e) => ({
    effectiveFrom: e.effectiveFrom,
    amount: e.costPerUnit,
  }));
  await writeMaterialEntries(shop, materialId, before, entries);
}

/**
 * Save a material price change and push the consequences into every product
 * that uses it, so their snapshots stay in step.
 */
export async function recordMaterialPrice(args: {
  shop: string;
  materialId: string;
  change: PriceChange;
}): Promise<void> {
  const { shop, materialId, change } = args;

  const existing = await prisma.materialPrice.findMany({ where: { shop, materialId } });
  const before: PriceEntry[] = existing.map((e) => ({
    effectiveFrom: e.effectiveFrom,
    amount: e.costPerUnit,
  }));
  await writeMaterialEntries(shop, materialId, before, applyPriceChange(before, change));
}

async function writeMaterialEntries(
  shop: string,
  materialId: string,
  before: PriceEntry[],
  after: PriceEntry[],
): Promise<void> {
  if (after.length === 0) return;

  await prisma.$transaction([
    prisma.materialPrice.deleteMany({ where: { shop, materialId } }),
    ...after.map((e) =>
      prisma.materialPrice.create({
        data: { shop, materialId, costPerUnit: e.amount, effectiveFrom: e.effectiveFrom },
      }),
    ),
  ]);

  // The editable value always means "the price right now".
  const nowAmount = amountOn(after, todayString());
  if (nowAmount != null) {
    await prisma.material.updateMany({
      where: { id: materialId, shop },
      data: { costPerUnit: nowAmount },
    });
  }

  // Re-snapshot affected products on every day the timeline touches, so a
  // period with a different price shows up in those orders too.
  const days = Array.from(
    new Set([...before, ...after].map((e) => e.effectiveFrom)),
  ).sort();
  const productIds = await productsUsingMaterial(shop, materialId);
  for (const day of days) {
    for (const productId of productIds) {
      await recordProductVersion({ shop, productId, day, reason: "material" });
    }
  }
  for (const productId of productIds) {
    await syncLiveProductCost(shop, productId);
  }
}

// ---------------------------------------------------------------------------
// Writing: delivery zone costs
// ---------------------------------------------------------------------------

/** Replace a zone's whole cost timeline with what the merchant entered. */
export async function setZoneTimeline(args: {
  shop: string;
  zoneId: string;
  entries: PriceEntry[];
}): Promise<void> {
  await writeZoneEntries(args.shop, args.zoneId, args.entries);
}

export async function recordZonePrice(args: {
  shop: string;
  zoneId: string;
  change: PriceChange;
}): Promise<void> {
  const { shop, zoneId, change } = args;

  const existing = await prisma.deliveryZonePrice.findMany({ where: { shop, zoneId } });
  const before: PriceEntry[] = existing.map((e) => ({
    effectiveFrom: e.effectiveFrom,
    amount: e.realCost,
  }));
  await writeZoneEntries(shop, zoneId, applyPriceChange(before, change));
}

async function writeZoneEntries(
  shop: string,
  zoneId: string,
  after: PriceEntry[],
): Promise<void> {
  if (after.length === 0) return;

  await prisma.$transaction([
    prisma.deliveryZonePrice.deleteMany({ where: { shop, zoneId } }),
    ...after.map((e) =>
      prisma.deliveryZonePrice.create({
        data: { shop, zoneId, realCost: e.amount, effectiveFrom: e.effectiveFrom },
      }),
    ),
  ]);

  const nowAmount = amountOn(after, todayString());
  if (nowAmount != null) {
    await prisma.deliveryZone.updateMany({
      where: { id: zoneId, shop },
      data: { realCost: nowAmount },
    });
  }
}

// ---------------------------------------------------------------------------
// Money rules (Settings) over time
// ---------------------------------------------------------------------------

/** The fee / deposit / return rules that decide an order's profit. */
export type MoneyRules = {
  paymentFeePercent: number;
  paymentFeeFlat: number;
  codFeePercent: number;
  codRoundTripDefault: boolean;
  returnDeliveryMode: string;
  returnDeliveryPercent: number;
  returnDeliveryFixed: number;
  depositMode: string;
  depositValue: number;
};

function rulesOf(row: MoneyRules): MoneyRules {
  return {
    paymentFeePercent: row.paymentFeePercent,
    paymentFeeFlat: row.paymentFeeFlat,
    codFeePercent: row.codFeePercent,
    codRoundTripDefault: row.codRoundTripDefault,
    returnDeliveryMode: row.returnDeliveryMode,
    returnDeliveryPercent: row.returnDeliveryPercent,
    returnDeliveryFixed: row.returnDeliveryFixed,
    depositMode: row.depositMode,
    depositValue: row.depositValue,
  };
}

/**
 * Resolve the money rules that applied on any given day.
 *
 * Loaded once and memoised per day, the same way costs are, so a report over a
 * range does not re-query for every order.
 */
export async function loadRulesTimeline(
  shop: string,
  live: MoneyRules,
): Promise<(day: string) => MoneyRules> {
  const versions = await prisma.settingsVersion.findMany({ where: { shop } });
  if (versions.length === 0) return () => live;

  const cache = new Map<string, MoneyRules>();
  return (day: string) => {
    const hit = cache.get(day);
    if (hit) return hit;
    const version = resolveAsOf(versions, day);
    const rules = version ? rulesOf(version) : live;
    cache.set(day, rules);
    return rules;
  };
}

/**
 * Give the shop's existing rules a starting version, dated far enough back to
 * cover every order. Must run BEFORE new rules are saved: it records the
 * current rules as the historical baseline, so it has to see the old ones.
 * Only fills a gap, so it is safe to call on every save.
 */
export async function seedSettingsBaseline(shop: string, current: MoneyRules): Promise<void> {
  const count = await prisma.settingsVersion.count({ where: { shop } });
  if (count > 0) return;
  await prisma.settingsVersion.create({
    data: { shop, effectiveFrom: EARLIEST_DAY, ...rulesOf(current) },
  });
}

/** Every recorded set of rules, newest first, for showing on the settings page. */
export async function settingsVersionHistory(
  shop: string,
): Promise<{ effectiveFrom: string; paymentFeePercent: number; codFeePercent: number; depositMode: string }[]> {
  const rows = await prisma.settingsVersion.findMany({
    where: { shop },
    orderBy: { effectiveFrom: "desc" },
  });
  return rows.map((r) => ({
    effectiveFrom: r.effectiveFrom,
    paymentFeePercent: r.paymentFeePercent,
    codFeePercent: r.codFeePercent,
    depositMode: r.depositMode,
  }));
}

/** Record the money rules in effect from `day` onward. */
export async function recordSettingsVersion(args: {
  shop: string;
  day: string;
  rules: MoneyRules;
}): Promise<void> {
  const { shop, day, rules } = args;
  await prisma.settingsVersion.upsert({
    where: { shop_effectiveFrom: { shop, effectiveFrom: day } },
    create: { shop, effectiveFrom: day, ...rules },
    update: { ...rules },
  });
}

// ---------------------------------------------------------------------------
// Salaries and expense amounts over time
// ---------------------------------------------------------------------------

/** Replace a worker's salary timeline. */
export async function setSalaryTimeline(args: {
  shop: string;
  workerId: string;
  entries: PriceEntry[];
}): Promise<void> {
  const { shop, workerId, entries } = args;
  if (entries.length === 0) return;

  await prisma.$transaction([
    prisma.workerSalary.deleteMany({ where: { shop, workerId } }),
    ...entries.map((e) =>
      prisma.workerSalary.create({
        data: { shop, workerId, monthlySalary: e.amount, effectiveFrom: e.effectiveFrom },
      }),
    ),
  ]);

  const now = amountOn(entries, todayString());
  if (now != null) {
    await prisma.worker.updateMany({ where: { id: workerId, shop }, data: { monthlySalary: now } });
  }
}

/** Replace an expense's amount timeline. */
export async function setExpenseTimeline(args: {
  shop: string;
  expenseId: string;
  entries: PriceEntry[];
}): Promise<void> {
  const { shop, expenseId, entries } = args;
  if (entries.length === 0) return;

  await prisma.$transaction([
    prisma.expenseAmount.deleteMany({ where: { shop, expenseId } }),
    ...entries.map((e) =>
      prisma.expenseAmount.create({
        data: { shop, expenseId, amount: e.amount, effectiveFrom: e.effectiveFrom },
      }),
    ),
  ]);

  const now = amountOn(entries, todayString());
  if (now != null) {
    await prisma.expense.updateMany({ where: { id: expenseId, shop }, data: { amount: now } });
  }
}

export async function salaryHistory(shop: string, workerId: string): Promise<PriceEntry[]> {
  const rows = await prisma.workerSalary.findMany({
    where: { shop, workerId },
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, amount: r.monthlySalary }));
}

export async function expenseHistory(shop: string, expenseId: string): Promise<PriceEntry[]> {
  const rows = await prisma.expenseAmount.findMany({
    where: { shop, expenseId },
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, amount: r.amount }));
}

export async function allSalaryHistories(shop: string): Promise<Record<string, PriceEntry[]>> {
  const rows = await prisma.workerSalary.findMany({
    where: { shop },
    orderBy: { effectiveFrom: "asc" },
  });
  return indexHistory(
    rows,
    (r) => r.workerId,
    (r) => ({ effectiveFrom: r.effectiveFrom, amount: r.monthlySalary }),
  );
}

export async function allExpenseHistories(shop: string): Promise<Record<string, PriceEntry[]>> {
  const rows = await prisma.expenseAmount.findMany({
    where: { shop },
    orderBy: { effectiveFrom: "asc" },
  });
  return indexHistory(
    rows,
    (r) => r.expenseId,
    (r) => ({ effectiveFrom: r.effectiveFrom, amount: r.amount }),
  );
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Give anything without history a starting entry, dated far enough back to
 * cover existing orders. Safe to call repeatedly: it only fills gaps.
 *
 * Must run BEFORE a value is changed — it records the current cost as the
 * historical baseline, so it has to see the old number.
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
    await recordProductVersion({ shop, productId: p.productId, day: EARLIEST_DAY, reason: "seed" });
  }
}

// ---------------------------------------------------------------------------
// History for display
// ---------------------------------------------------------------------------

export async function materialPriceHistory(shop: string, materialId: string): Promise<PriceEntry[]> {
  const rows = await prisma.materialPrice.findMany({
    where: { shop, materialId },
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, amount: r.costPerUnit }));
}

export async function zonePriceHistory(shop: string, zoneId: string): Promise<PriceEntry[]> {
  const rows = await prisma.deliveryZonePrice.findMany({
    where: { shop, zoneId },
    orderBy: { effectiveFrom: "asc" },
  });
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, amount: r.realCost }));
}

function indexHistory<T>(
  rows: T[],
  keyOf: (row: T) => string,
  entryOf: (row: T) => PriceEntry,
): Record<string, PriceEntry[]> {
  const out: Record<string, PriceEntry[]> = {};
  for (const row of rows) {
    const key = keyOf(row);
    (out[key] ??= []).push(entryOf(row));
  }
  return out;
}

/** A product's factory and other cost over time, each as its own timeline. */
export async function productExtrasHistory(
  shop: string,
  productId: string,
): Promise<{ factory: PriceEntry[]; other: PriceEntry[] }> {
  const rows = await prisma.productCostVersion.findMany({
    where: { shop, productId },
    orderBy: { effectiveFrom: "asc" },
  });

  // Versions exist per day for several reasons (a material moved, a cost was
  // edited), so collapse runs where the value did not actually change.
  const collapse = (pick: (r: (typeof rows)[number]) => number): PriceEntry[] => {
    const out: PriceEntry[] = [];
    for (const row of rows) {
      const amount = round2(pick(row));
      if (out.length === 0 || out[out.length - 1].amount !== amount) {
        out.push({ effectiveFrom: row.effectiveFrom, amount });
      }
    }
    return out;
  };

  return { factory: collapse((r) => r.factoryCost), other: collapse((r) => r.otherCost) };
}

/** All material price histories for a shop, keyed by material id.
 *  A plain object rather than a Map so it survives the loader's JSON trip. */
export async function allMaterialHistories(shop: string): Promise<Record<string, PriceEntry[]>> {
  const rows = await prisma.materialPrice.findMany({
    where: { shop },
    orderBy: { effectiveFrom: "asc" },
  });
  return indexHistory(
    rows,
    (r) => r.materialId,
    (r) => ({ effectiveFrom: r.effectiveFrom, amount: r.costPerUnit }),
  );
}

/** All zone cost histories for a shop, keyed by zone id. */
export async function allZoneHistories(shop: string): Promise<Record<string, PriceEntry[]>> {
  const rows = await prisma.deliveryZonePrice.findMany({
    where: { shop },
    orderBy: { effectiveFrom: "asc" },
  });
  return indexHistory(
    rows,
    (r) => r.zoneId,
    (r) => ({ effectiveFrom: r.effectiveFrom, amount: r.realCost }),
  );
}
