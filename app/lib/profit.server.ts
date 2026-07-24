/**
 * The money engine.
 *
 * Pulls live orders from Shopify and combines them with the shop's stored cost
 * data (materials / bill-of-materials, delivery zones, per-order overrides,
 * payment-fee settings) to produce an accurate per-order and aggregate P&L.
 *
 * Ad spend is a period-level cost (entered per day, not per order), so it is
 * subtracted once at the aggregate level — never per order.
 */
import prisma from "../db.server";
import { getSettings, type ShopSettings } from "./settings.server";
import { round2 } from "./money";
import { daysInclusive, todayString, daysAgoString } from "./dates";

/** Minimal shape of the Admin GraphQL client we rely on (version-agnostic). */
type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type NormalizedLineItem = {
  productId: string | null;
  variantId: string | null;
  title: string;
  quantity: number;
  revenue: number; // line total after line-level discounts
};

export type NormalizedOrder = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  gateways: string[];
  isCOD: boolean;
  total: number; // current total the customer pays (after discounts/returns), incl. tax
  tax: number;
  shippingCharged: number; // what the customer was charged for shipping
  discounts: number;
  refunds: number;
  city: string | null;
  province: string | null;
  country: string | null;
  lineItems: NormalizedLineItem[];
};

/** Per-unit cost of a product, derived from its bill of materials + other cost. */
export type ProductUnitCost = {
  productId: string;
  title: string;
  materialCost: number;
  factoryCost: number;
  otherCost: number;
  unitCost: number;
};

export type OrderOverride = {
  realDeliveryCost: number | null;
  deliveryOutcome: string; // delivered | rejected | returned
  roundTrip: boolean;
  note: string | null;
};

export type OrderPnl = {
  orderId: string;
  name: string;
  createdAt: string;
  outcome: string;
  isCOD: boolean;
  delivered: boolean;
  revenue: number; // money you keep from the customer, ex-tax (0 if not delivered)
  tax: number;
  shippingCharged: number;
  materialsCost: number;
  realDelivery: number;
  deliveryGap: number; // shippingCharged - realDelivery (negative = you lose on shipping)
  paymentFee: number;
  discounts: number;
  refunds: number;
  profit: number; // revenue - materials - realDelivery - paymentFee (BEFORE ad spend)
  zoneName: string | null;
  zoneCost: number; // the matched zone's real cost (before any override)
  overrideDelivery: number | null; // per-order override value, if the merchant set one
  roundTrip: boolean; // effective round-trip flag used in this calc
  note: string | null;
  hasOverride: boolean;
  missingCost: boolean; // at least one product in the order has no cost defined
  city: string | null;
  province: string | null;
};

export type ReportTotals = {
  orderCount: number;
  rejectedCount: number;
  revenue: number;
  materialsCost: number;
  realDelivery: number;
  paymentFee: number;
  discounts: number;
  refunds: number;
  adSpend: number;
  overheads: number; // prorated expenses (subscription, bills, urgent…)
  payroll: number; // prorated salaries + bonuses/gifts in range
  grossProfit: number; // orders only, before ads/overheads/payroll
  netProfit: number; // after ads, overheads and payroll
  margin: number; // netProfit / revenue
  shippingCharged: number;
  deliveryLoss: number; // sum of negative delivery gaps (money lost on shipping)
};

/** Per-product contribution over the period with shared shipping/fee allocation.
 * Shipping and payment fees are split across the order's products by line revenue
 * (fallback: by quantity when revenue is zero). */
export type ProductBreakdown = {
  productId: string | null;
  title: string;
  units: number;
  revenue: number;
  materialCost: number;
  shippingChargedAllocated: number;
  deliveryCostAllocated: number;
  paymentFeeAllocated: number;
  profit: number; // revenue - materialCost - deliveryCostAllocated - paymentFeeAllocated
  marginRatio: number; // profit / revenue
  missingCost: boolean;
};

export type Report = {
  range: { start: string; end: string };
  currency: string;
  orders: OrderPnl[];
  totals: ReportTotals;
  products: ProductBreakdown[];
  missingCostCount: number;
  truncated: boolean; // true if we hit the order fetch cap
};

// ---------------------------------------------------------------------------
// Product cost map
// ---------------------------------------------------------------------------

export type CostMap = Map<string, ProductUnitCost>;

/** Load every costed product for a shop and index it by Shopify product GID. */
export async function loadCostMap(shop: string): Promise<CostMap> {
  const rows = await prisma.productCost.findMany({
    where: { shop },
    include: { bomLines: { include: { material: true } } },
  });
  const map: CostMap = new Map();
  for (const row of rows) {
    const materialCost = row.bomLines.reduce(
      (sum, line) => sum + line.quantity * line.material.costPerUnit,
      0,
    );
    map.set(row.productId, {
      productId: row.productId,
      title: row.title,
      materialCost: round2(materialCost),
      factoryCost: round2(row.factoryCost),
      otherCost: round2(row.otherCost),
      unitCost: round2(materialCost + row.factoryCost + row.otherCost),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Delivery zone matching
// ---------------------------------------------------------------------------

export type Zone = {
  id: string;
  name: string;
  keywords: string;
  realCost: number;
  isDefault: boolean;
};

/** Find the delivery zone that matches an order's shipping address. */
export function matchZone(order: NormalizedOrder, zones: Zone[]): Zone | null {
  const haystack = `${order.city ?? ""} ${order.province ?? ""} ${order.country ?? ""}`.toLowerCase();
  for (const zone of zones) {
    const keywords = zone.keywords
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.some((k) => haystack.includes(k))) return zone;
  }
  return zones.find((z) => z.isDefault) ?? null;
}

// ---------------------------------------------------------------------------
// Per-order P&L
// ---------------------------------------------------------------------------

function detectCOD(gateways: string[]): boolean {
  return gateways.some((g) => {
    const s = g.toLowerCase();
    return s.includes("cash on delivery") || s.includes("cash on") || s === "cod" || s.includes("(cod)");
  });
}

export function computeOrderPnl(
  order: NormalizedOrder,
  ctx: {
    costMap: CostMap;
    zones: Zone[];
    settings: ShopSettings;
    override?: OrderOverride | null;
  },
): OrderPnl {
  const { costMap, zones, settings, override } = ctx;
  const outcome = override?.deliveryOutcome ?? "delivered";
  const delivered = outcome === "delivered";

  // --- Materials: only a real cost when the goods actually left (delivered). ---
  let materialsCost = 0;
  let missingCost = false;
  if (delivered) {
    for (const line of order.lineItems) {
      const cost = line.productId ? costMap.get(line.productId) : undefined;
      if (!cost) {
        missingCost = true;
        continue;
      }
      materialsCost += cost.unitCost * line.quantity;
    }
  }

  // --- Real delivery cost: per-order override first, else the matching zone. ---
  const zone = matchZone(order, zones);
  let realDelivery = override?.realDeliveryCost ?? zone?.realCost ?? 0;
  // Rejected / returned orders often mean you paid the courier both ways.
  const roundTrip = override?.roundTrip ?? (!delivered && settings.codRoundTripDefault);
  if (!delivered && roundTrip) realDelivery *= 2;

  // --- Revenue you keep: total minus tax (a pass-through). Zero if not delivered. ---
  const revenue = delivered ? Math.max(0, order.total - order.tax) : 0;

  // --- Payment / gateway fee on money actually collected. ---
  const feePercent =
    order.isCOD && settings.codFeePercent > 0
      ? settings.codFeePercent
      : settings.paymentFeePercent;
  const paymentFee = revenue > 0 ? (revenue * feePercent) / 100 + settings.paymentFeeFlat : 0;

  const profit = revenue - materialsCost - realDelivery - paymentFee;

  return {
    orderId: order.id,
    name: order.name,
    createdAt: order.createdAt,
    outcome,
    isCOD: order.isCOD,
    delivered,
    revenue: round2(revenue),
    tax: round2(order.tax),
    shippingCharged: round2(order.shippingCharged),
    materialsCost: round2(materialsCost),
    realDelivery: round2(realDelivery),
    deliveryGap: round2(order.shippingCharged - realDelivery),
    paymentFee: round2(paymentFee),
    discounts: round2(order.discounts),
    refunds: round2(order.refunds),
    profit: round2(profit),
    zoneName: zone?.name ?? null,
    zoneCost: round2(zone?.realCost ?? 0),
    overrideDelivery: override?.realDeliveryCost ?? null,
    roundTrip,
    note: override?.note ?? null,
    hasOverride: Boolean(override),
    missingCost,
    city: order.city,
    province: order.province,
  };
}

// ---------------------------------------------------------------------------
// Shopify order fetching
// ---------------------------------------------------------------------------

const ORDERS_QUERY = `#graphql
  query Reb7yOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          paymentGatewayNames
          currentTotalPriceSet { shopMoney { amount } }
          currentTotalTaxSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          totalRefundedSet { shopMoney { amount } }
          shippingAddress { city province country }
          lineItems(first: 100) {
            edges {
              node {
                title
                quantity
                discountedTotalSet { shopMoney { amount } }
                product { id }
                variant { id }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

function money(bag: any): number {
  const amount = bag?.shopMoney?.amount;
  const n = amount != null ? parseFloat(amount) : 0;
  return Number.isFinite(n) ? n : 0;
}

const MAX_PAGES = 20; // safety cap: up to 20 * 100 = 2000 orders per report

/** Fetch and normalize all orders created within [startDay, endDay] (inclusive). */
export async function fetchOrders(
  admin: GraphqlClient,
  startDay: string,
  endDay: string,
): Promise<{ orders: NormalizedOrder[]; truncated: boolean }> {
  const query = `created_at:>='${startDay}T00:00:00Z' created_at:<='${endDay}T23:59:59Z'`;
  const orders: NormalizedOrder[] = [];
  let after: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: { first: 100, after, query },
    });
    const body: any = await response.json();
    if (body?.errors) {
      const msg = Array.isArray(body.errors)
        ? body.errors.map((e: any) => e.message).join("; ")
        : JSON.stringify(body.errors);
      throw new Error(msg);
    }
    const connection = body?.data?.orders;
    if (!connection) break;

    for (const edge of connection.edges ?? []) {
      const node = edge.node;
      const gateways: string[] = node.paymentGatewayNames ?? [];
      orders.push({
        id: node.id,
        name: node.name ?? "",
        createdAt: node.createdAt,
        cancelledAt: node.cancelledAt ?? null,
        financialStatus: node.displayFinancialStatus ?? null,
        fulfillmentStatus: node.displayFulfillmentStatus ?? null,
        gateways,
        isCOD: detectCOD(gateways),
        total: money(node.currentTotalPriceSet),
        tax: money(node.currentTotalTaxSet),
        shippingCharged: money(node.totalShippingPriceSet),
        discounts: money(node.totalDiscountsSet),
        refunds: money(node.totalRefundedSet),
        city: node.shippingAddress?.city ?? null,
        province: node.shippingAddress?.province ?? null,
        country: node.shippingAddress?.country ?? null,
        lineItems: (node.lineItems?.edges ?? []).map((e: any) => ({
          productId: e.node.product?.id ?? null,
          variantId: e.node.variant?.id ?? null,
          title: e.node.title ?? "",
          quantity: e.node.quantity ?? 0,
          revenue: money(e.node.discountedTotalSet),
        })),
      });
    }

    if (connection.pageInfo?.hasNextPage) {
      after = connection.pageInfo.endCursor;
      if (page === MAX_PAGES - 1) truncated = true;
    } else {
      break;
    }
  }

  return { orders, truncated };
}

// ---------------------------------------------------------------------------
// Full report assembly
// ---------------------------------------------------------------------------

/** Build the complete P&L report for a shop over a day range. */
export async function buildReport(
  admin: GraphqlClient,
  shop: string,
  startDay: string,
  endDay: string,
): Promise<Report> {
  const [costMap, zoneRows, settings, overrideRows, adRows, expenseRows, workerRows, paymentRows, fetched] =
    await Promise.all([
      loadCostMap(shop),
      prisma.deliveryZone.findMany({ where: { shop } }),
      getSettings(shop),
      prisma.orderCost.findMany({ where: { shop } }),
      prisma.adSpend.findMany({
        where: { shop, date: { gte: startDay, lte: endDay } },
      }),
      prisma.expense.findMany({ where: { shop, active: true } }),
      prisma.worker.findMany({ where: { shop, active: true } }),
      prisma.workerPayment.findMany({
        where: { shop, date: { gte: startDay, lte: endDay } },
      }),
      fetchOrders(admin, startDay, endDay),
    ]);

  const zones: Zone[] = zoneRows.map((z) => ({
    id: z.id,
    name: z.name,
    keywords: z.keywords,
    realCost: z.realCost,
    isDefault: z.isDefault,
  }));
  const overrideMap = new Map(
    overrideRows.map((o) => [
      o.orderId,
      {
        realDeliveryCost: o.realDeliveryCost,
        deliveryOutcome: o.deliveryOutcome,
        roundTrip: o.roundTrip,
        note: o.note,
      } as OrderOverride,
    ]),
  );

  const orders = fetched.orders.map((o) =>
    computeOrderPnl(o, { costMap, zones, settings, override: overrideMap.get(o.id) }),
  );
  const orderPnlMap = new Map(orders.map((o) => [o.orderId, o]));

  // --- Per-product breakdown (delivered orders only). ---
  const productAcc = new Map<string, ProductBreakdown>();
  for (const order of fetched.orders) {
    const orderPnl = orderPnlMap.get(order.id);
    if (!orderPnl) continue;
    const delivered = (overrideMap.get(order.id)?.deliveryOutcome ?? "delivered") === "delivered";
    if (!delivered) continue;

    const totalLineRevenue = order.lineItems.reduce((sum, line) => sum + line.revenue, 0);
    const totalQty = order.lineItems.reduce((sum, line) => sum + line.quantity, 0);

    for (const line of order.lineItems) {
      const key = line.productId ?? `title:${line.title}`;
      const cost = line.productId ? costMap.get(line.productId) : undefined;
      const shareByRevenue = totalLineRevenue > 0 ? line.revenue / totalLineRevenue : 0;
      const shareByQty = totalQty > 0 ? line.quantity / totalQty : 0;
      const allocationShare = shareByRevenue > 0 ? shareByRevenue : shareByQty;
      const existing =
        productAcc.get(key) ??
        {
          productId: line.productId,
          title: cost?.title || line.title,
          units: 0,
          revenue: 0,
          materialCost: 0,
          shippingChargedAllocated: 0,
          deliveryCostAllocated: 0,
          paymentFeeAllocated: 0,
          profit: 0,
          marginRatio: 0,
          missingCost: false,
        };
      existing.units += line.quantity;
      existing.revenue += line.revenue;
      existing.materialCost += (cost?.unitCost ?? 0) * line.quantity;
      existing.shippingChargedAllocated += orderPnl.shippingCharged * allocationShare;
      existing.deliveryCostAllocated += orderPnl.realDelivery * allocationShare;
      existing.paymentFeeAllocated += orderPnl.paymentFee * allocationShare;
      if (!cost) existing.missingCost = true;
      productAcc.set(key, existing);
    }
  }
  const products = Array.from(productAcc.values())
    .map((p) => ({
      ...p,
      revenue: round2(p.revenue),
      materialCost: round2(p.materialCost),
      shippingChargedAllocated: round2(p.shippingChargedAllocated),
      deliveryCostAllocated: round2(p.deliveryCostAllocated),
      paymentFeeAllocated: round2(p.paymentFeeAllocated),
      profit: round2(p.revenue - p.materialCost - p.deliveryCostAllocated - p.paymentFeeAllocated),
      marginRatio:
        p.revenue > 0
          ? round2(
              (p.revenue - p.materialCost - p.deliveryCostAllocated - p.paymentFeeAllocated) /
                p.revenue,
            )
          : 0,
    }))
    .sort((a, b) => b.profit - a.profit);

  const adSpend = round2(adRows.reduce((s, r) => s + r.amount, 0));

  // --- Overheads (prorated expenses) and payroll (prorated salaries + bonuses). ---
  const rangeDays = daysInclusive(startDay, endDay);
  const overheads = round2(
    expenseRows.reduce(
      (s, e) => s + prorateExpense(e.amount, e.frequency, e.date, startDay, endDay, rangeDays),
      0,
    ),
  );
  const salaryCost = workerRows.reduce((s, w) => s + (w.monthlySalary * rangeDays) / 30, 0);
  const bonusCost = paymentRows.reduce((s, p) => s + p.amount, 0);
  const payroll = round2(salaryCost + bonusCost);

  const totals: ReportTotals = {
    orderCount: orders.length,
    rejectedCount: orders.filter((o) => !o.delivered).length,
    revenue: round2(orders.reduce((s, o) => s + o.revenue, 0)),
    materialsCost: round2(orders.reduce((s, o) => s + o.materialsCost, 0)),
    realDelivery: round2(orders.reduce((s, o) => s + o.realDelivery, 0)),
    paymentFee: round2(orders.reduce((s, o) => s + o.paymentFee, 0)),
    discounts: round2(orders.reduce((s, o) => s + o.discounts, 0)),
    refunds: round2(orders.reduce((s, o) => s + o.refunds, 0)),
    shippingCharged: round2(orders.reduce((s, o) => s + o.shippingCharged, 0)),
    deliveryLoss: round2(
      orders.reduce((s, o) => s + (o.deliveryGap < 0 ? -o.deliveryGap : 0), 0),
    ),
    adSpend,
    overheads,
    payroll,
    grossProfit: 0,
    netProfit: 0,
    margin: 0,
  };
  totals.grossProfit = round2(orders.reduce((s, o) => s + o.profit, 0));
  totals.netProfit = round2(totals.grossProfit - adSpend - overheads - payroll);
  totals.margin = totals.revenue > 0 ? totals.netProfit / totals.revenue : 0;

  return {
    range: { start: startDay, end: endDay },
    currency: settings.currency,
    orders,
    totals,
    products,
    missingCostCount: orders.filter((o) => o.missingCost).length,
    truncated: fetched.truncated,
  };
}

/** buildReport wrapped so a Shopify/permission error becomes a friendly string
 * instead of crashing the page (e.g. protected customer data not yet approved). */
export async function buildReportSafe(
  admin: GraphqlClient,
  shop: string,
  startDay: string,
  endDay: string,
): Promise<{ report: Report | null; error: string | null }> {
  try {
    const report = await buildReport(admin, shop, startDay, endDay);
    return { report, error: null };
  } catch (e: any) {
    return { report: null, error: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// Expenses & payroll proration
// ---------------------------------------------------------------------------

/** How much a single expense costs over a date range, based on its schedule.
 * Recurring costs are normalised to a daily rate; one-off costs count only if
 * their date falls inside the range. */
export function prorateExpense(
  amount: number,
  frequency: string,
  date: string | null,
  rangeStart: string,
  rangeEnd: string,
  rangeDays: number,
): number {
  switch (frequency) {
    case "once":
      return date && date >= rangeStart && date <= rangeEnd ? amount : 0;
    case "daily":
      return amount * rangeDays;
    case "weekly":
      return (amount * rangeDays) / 7;
    case "monthly":
    default:
      return (amount * rangeDays) / 30;
  }
}

// ---------------------------------------------------------------------------
// Material stock usage
// ---------------------------------------------------------------------------

/** Map of Shopify product GID -> its recipe lines (materialId + quantity). */
export async function loadRecipeMap(
  shop: string,
): Promise<Map<string, { materialId: string; qty: number }[]>> {
  const rows = await prisma.productCost.findMany({
    where: { shop },
    include: { bomLines: true },
  });
  const map = new Map<string, { materialId: string; qty: number }[]>();
  for (const row of rows) {
    map.set(
      row.productId,
      row.bomLines.map((l) => ({ materialId: l.materialId, qty: l.quantity })),
    );
  }
  return map;
}

/** Units of each material consumed by DELIVERED orders since `sinceDay`.
 * Returns a Map of materialId -> units used. */
export async function computeMaterialUsage(
  admin: GraphqlClient,
  shop: string,
  sinceDay: string = daysAgoString(365),
): Promise<Map<string, number>> {
  const [recipeMap, overrideRows, fetched] = await Promise.all([
    loadRecipeMap(shop),
    prisma.orderCost.findMany({ where: { shop } }),
    fetchOrders(admin, sinceDay, todayString()),
  ]);
  const outcome = new Map(overrideRows.map((o) => [o.orderId, o.deliveryOutcome]));
  const usage = new Map<string, number>();
  for (const order of fetched.orders) {
    if ((outcome.get(order.id) ?? "delivered") !== "delivered") continue;
    for (const line of order.lineItems) {
      const recipe = line.productId ? recipeMap.get(line.productId) : undefined;
      if (!recipe) continue;
      for (const r of recipe) {
        usage.set(r.materialId, (usage.get(r.materialId) ?? 0) + r.qty * line.quantity);
      }
    }
  }
  return usage;
}
