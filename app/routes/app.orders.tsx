import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Checkbox,
  IndexTable,
  Badge,
  Banner,
  Box,
  Modal,
  ButtonGroup,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildReport, type OrderPnl } from "../lib/profit.server";
import { resolveRange } from "../lib/dates";
import { parseAmount, formatMoney } from "../lib/money";
import { RangeSelector } from "../components/RangeSelector";
import { getSettings } from "../lib/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = resolveRange(url.searchParams.get("range") ?? "all");
  const [report, settings] = await Promise.all([
    buildReport(admin, session.shop, range.start, range.end),
    getSettings(session.shop),
  ]);
  return {
    report,
    rangePreset: range.preset,
    settingsDepositMode: settings.depositMode,
    settingsDepositValue: settings.depositValue,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");
  const orderId = String(form.get("orderId") ?? "");

  if (intent === "reset") {
    await prisma.orderCost.deleteMany({ where: { shop, orderId } });
    return { ok: true };
  }

  if (intent === "save") {
    const raw = String(form.get("realDeliveryCost") ?? "").trim();
    const depositMode = String(form.get("depositMode") ?? "settings");
    const data = {
      name: String(form.get("name") ?? ""),
      realDeliveryCost: raw === "" ? null : parseAmount(raw),
      deliveryOutcome: String(form.get("outcome") ?? "delivered"),
      roundTrip: form.get("roundTrip") === "true",
      depositMode,
      depositValue: depositMode === "none" || depositMode === "settings"
        ? 0
        : parseAmount(form.get("depositValue"), 0),
      note: String(form.get("note") ?? "").trim() || null,
    };
    await prisma.orderCost.upsert({
      where: { shop_orderId: { shop, orderId } },
      create: { shop, orderId, ...data },
      update: data,
    });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

const OUTCOMES = [
  { label: "Delivered", value: "delivered" },
  { label: "Rejected (customer refused)", value: "rejected" },
  { label: "Returned", value: "returned" },
];

const DEPOSIT_OPTIONS = [
  { label: "Use settings default", value: "settings" },
  { label: "No deposit", value: "none" },
  { label: "Fixed deposit amount", value: "fixed" },
  { label: "% of real courier cost", value: "percent_real" },
  { label: "% of Shopify shipping", value: "percent_shopify" },
];

function formatDepositMode(mode: string, value: number, currency: string): string {
  if (mode === "fixed") return `${formatMoney(value, currency)} fixed`;
  if (mode === "percent_real") return `${value}% of real courier`;
  if (mode === "percent_shopify") return `${value}% of Shopify shipping`;
  return "no deposit";
}

function shortDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function longDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** One line of the profit calculation, so the modal reads like a receipt. */
function MathRow({
  label,
  hint,
  value,
  currency,
  sign,
  strong,
}: {
  label: string;
  hint?: string;
  value: number;
  currency: string;
  sign: "+" | "-" | "=";
  strong?: boolean;
}) {
  return (
    <InlineStack align="space-between" blockAlign="start" gap="400" wrap={false}>
      <BlockStack gap="050">
        <Text as="span" fontWeight={strong ? "semibold" : "regular"}>
          {label}
        </Text>
        {hint && (
          <Text as="span" tone="subdued" variant="bodySm">
            {hint}
          </Text>
        )}
      </BlockStack>
      <Text
        as="span"
        fontWeight={strong ? "semibold" : "regular"}
        tone={sign === "-" ? "critical" : sign === "=" ? undefined : "success"}
      >
        {sign === "=" ? "" : sign}
        {formatMoney(value, currency)}
      </Text>
    </InlineStack>
  );
}

export default function OrdersPage() {
  const { report, rangePreset, settingsDepositMode, settingsDepositValue } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const currency = report.currency;

  const filter = searchParams.get("outcome") ?? "all";
  const orders = report.orders.filter((o) =>
    filter === "all" ? true : filter === "issues" ? !o.delivered : o.delivered,
  );

  // --- Read-only detail modal ---
  const [viewing, setViewing] = useState<OrderPnl | null>(null);

  // --- Editor modal state ---
  const [editing, setEditing] = useState<OrderPnl | null>(null);
  const [outcome, setOutcome] = useState("delivered");
  const [delivery, setDelivery] = useState("");
  const [roundTrip, setRoundTrip] = useState(false);
  const [depositMode, setDepositMode] = useState("settings");
  const [depositValue, setDepositValue] = useState("");
  const [note, setNote] = useState("");

  const settingsDepositLabel = formatDepositMode(
    settingsDepositMode,
    settingsDepositValue,
    currency,
  );

  const openEdit = (o: OrderPnl) => {
    setEditing(o);
    setOutcome(o.outcome);
    setDelivery(o.overrideDelivery != null ? String(o.overrideDelivery) : "");
    setRoundTrip(o.roundTrip);
    setDepositMode(o.overrideDepositMode ?? "settings");
    setDepositValue(o.overrideDepositValue != null ? String(o.overrideDepositValue) : "");
    setNote(o.note ?? "");
  };

  const saveEdit = () => {
    if (!editing) return;
    fetcher.submit(
      {
        _action: "save",
        orderId: editing.orderId,
        name: editing.name,
        realDeliveryCost: delivery,
        outcome,
        roundTrip: String(roundTrip),
        depositMode,
        depositValue,
        note,
      },
      { method: "post" },
    );
    setEditing(null);
  };

  const resetEdit = () => {
    if (!editing) return;
    fetcher.submit({ _action: "reset", orderId: editing.orderId }, { method: "post" });
    setEditing(null);
  };

  return (
    <Page>
      <TitleBar title="Orders" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            Order profit calculations include all Shopify orders inside the selected date range,
            including orders placed before this app was installed.
          </p>
          <p>
            If you still only see recent orders, Shopify's <b>read_orders</b> scope only returns
            the last 60 days. Request <b>read_all_orders</b> for full historical access.
          </p>
        </Banner>

        {report.missingCostCount > 0 && (
          <Banner tone="warning">
            <p>
              {report.missingCostCount} order(s) include a product with no recipe yet, so their
              material cost is counted as 0. Add recipes on the <b>Product costs</b> page for
              accurate profit.
            </p>
          </Banner>
        )}

        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Box minWidth="160px">
                <RangeSelector value={rangePreset} />
              </Box>
              <ButtonGroup variant="segmented">
                <FilterButton current={filter} value="all" label="All" />
                <FilterButton current={filter} value="delivered" label="Delivered" />
                <FilterButton current={filter} value="issues" label="Rejected/Returned" />
              </ButtonGroup>
            </InlineStack>
            <InlineStack gap="400">
              <Kpi label="Orders" value={String(report.totals.orderCount)} />
              <Kpi label="Revenue" value={formatMoney(report.totals.revenue, currency)} />
              <Kpi
                label="Deposits recovered"
                value={formatMoney(report.totals.depositsRecovered, currency)}
                tone={report.totals.depositsRecovered > 0 ? "success" : undefined}
              />
              <Kpi
                label="Net profit"
                value={formatMoney(report.totals.netProfit, currency)}
                tone={report.totals.netProfit >= 0 ? "success" : "critical"}
              />
            </InlineStack>
          </InlineStack>
        </Card>

        <Card padding="0">
          {orders.length === 0 ? (
            <Box padding="500">
              <Text as="p" tone="subdued" alignment="center">
                No orders in this range.
              </Text>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={orders.length}
              headings={[
                { title: "Order" },
                { title: "Revenue" },
                { title: "Materials" },
                { title: "Courier progress" },
                { title: "Fee" },
                { title: "Profit" },
                { title: "" },
              ]}
            >
              {orders.map((o, index) => (
                <IndexTable.Row id={o.orderId} key={o.orderId} position={index}>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <InlineStack gap="150" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {o.name}
                        </Text>
                        {o.isCOD && <Badge size="small">COD</Badge>}
                        {!o.delivered && (
                          <Badge size="small" tone="critical">
                            {o.outcome === "rejected" ? "Rejected" : "Returned"}
                          </Badge>
                        )}
                        {o.missingCost && (
                          <Badge size="small" tone="attention">
                            No recipe
                          </Badge>
                        )}
                      </InlineStack>
                      {o.customerName && (
                        <Text as="span" variant="bodySm">
                          {o.customerName}
                        </Text>
                      )}
                      <Text as="span" tone="subdued" variant="bodySm">
                        {shortDate(o.createdAt)}
                        {o.city ? ` · ${o.city}` : ""}
                      </Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatMoney(o.revenue, currency)}</IndexTable.Cell>
                  <IndexTable.Cell>{formatMoney(o.materialsCost, currency)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span">
                        real paid {formatMoney(o.realDelivery, currency)} · {o.realDeliverySourceLabel}
                      </Text>
                      {o.delivered ? (
                        <Text
                          as="span"
                          variant="bodySm"
                          tone={
                            o.deliveryGap < 0
                              ? "critical"
                              : o.deliveryGap > 0
                                ? "success"
                                : "subdued"
                          }
                        >
                          charged {formatMoney(o.shippingCharged, currency)}
                          {" · "}
                          {o.deliveryGap < 0
                            ? `lose ${formatMoney(-o.deliveryGap, currency)}`
                            : o.deliveryGap > 0
                              ? `profit ${formatMoney(o.deliveryGap, currency)}`
                              : "break-even"}
                          {o.realDeliverySource === "shopify" ? " · from Shopify value" : ""}
                        </Text>
                      ) : (
                        <>
                          <Text as="span" variant="bodySm" tone="success">
                            deposit +{formatMoney(o.depositCollected, currency)}
                            {o.depositRule ? ` · ${o.depositRule}` : ""}
                          </Text>
                          <Text
                            as="span"
                            variant="bodySm"
                            tone={o.courierNetLoss > 0 ? "critical" : "success"}
                          >
                            {o.courierNetLoss > 0
                              ? `net courier loss ${formatMoney(o.courierNetLoss, currency)}`
                              : o.courierNetLoss < 0
                                ? `net courier gain ${formatMoney(-o.courierNetLoss, currency)}`
                                : "courier break-even"}
                            {o.returnDeliveryRule ? ` · delivery ${o.returnDeliveryRule}` : ""}
                          </Text>
                        </>
                      )}
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatMoney(o.paymentFee, currency)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text
                      as="span"
                      fontWeight="semibold"
                      tone={o.profit >= 0 ? "success" : "critical"}
                    >
                      {formatMoney(o.profit, currency)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <ButtonGroup variant="segmented">
                      <Button size="slim" onClick={() => setViewing(o)}>
                        View
                      </Button>
                      <Button size="slim" onClick={() => openEdit(o)}>
                        Adjust
                      </Button>
                    </ButtonGroup>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>

        {report.truncated && (
          <Text as="p" tone="subdued" alignment="center">
            Showing the most recent 10,000 orders in this range.
          </Text>
        )}

        {report.totals.rejectedCount > 0 && (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="bodyMd">
                Rejected/returned courier net
              </Text>
              <Text
                as="span"
                fontWeight="semibold"
                tone={report.totals.courierIssueNetLoss > 0 ? "critical" : "success"}
              >
                {report.totals.courierIssueNetLoss > 0
                  ? `loss ${formatMoney(report.totals.courierIssueNetLoss, currency)}`
                  : report.totals.courierIssueNetLoss < 0
                    ? `gain ${formatMoney(-report.totals.courierIssueNetLoss, currency)}`
                    : "break-even"}
              </Text>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Based on real courier cost minus recovered deposits from failed deliveries.
            </Text>
          </Card>
        )}
      </BlockStack>

      {viewing && (
        <Modal
          open
          onClose={() => setViewing(null)}
          title={`${viewing.name} · ${longDate(viewing.createdAt)}`}
          primaryAction={{ content: "Close", onAction: () => setViewing(null) }}
          secondaryActions={[
            {
              content: "Adjust this order",
              onAction: () => {
                const order = viewing;
                setViewing(null);
                openEdit(order);
              },
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              {viewing.customerName && (
                <Text as="p" variant="headingSm">
                  {viewing.customerName}
                </Text>
              )}
              <InlineStack gap="150" blockAlign="center">
                {viewing.isCOD && <Badge size="small">COD</Badge>}
                <Badge size="small" tone={viewing.delivered ? "success" : "critical"}>
                  {viewing.delivered
                    ? "Delivered"
                    : viewing.outcome === "rejected"
                      ? "Rejected"
                      : "Returned"}
                </Badge>
                {viewing.city && <Badge size="small">{viewing.city}</Badge>}
                {viewing.hasOverride && (
                  <Badge size="small" tone="info">
                    Manually adjusted
                  </Badge>
                )}
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Costs below are the ones that applied on {longDate(viewing.createdAt)} — not
                today's. Changing a price now will not move this order.
              </Text>
            </BlockStack>
          </Modal.Section>

          <Modal.Section>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                What was in this order
              </Text>

              {viewing.lines.length === 0 ? (
                <Text as="p" tone="subdued">
                  Shopify returned no products for this order.
                </Text>
              ) : (
                viewing.lines.map((line, i) => (
                  <Box
                    key={`${line.productId ?? line.title}-${i}`}
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                  >
                    <BlockStack gap="150">
                      <InlineStack align="space-between" gap="400" wrap={false}>
                        <Text as="span" fontWeight="semibold">
                          {line.title}
                          {line.quantity !== 1 ? ` × ${line.quantity}` : ""}
                        </Text>
                        <Text as="span" fontWeight="semibold">
                          {formatMoney(line.revenue, currency)}
                        </Text>
                      </InlineStack>

                      {line.hasCost ? (
                        <BlockStack gap="050">
                          <InlineStack align="space-between" gap="400" wrap={false}>
                            <Text as="span" tone="subdued" variant="bodySm">
                              Costed as “{line.costTitle}” ·{" "}
                              {formatMoney(line.unitCost, currency)} each
                            </Text>
                            <Text as="span" tone="critical" variant="bodySm">
                              −{formatMoney(line.lineCost, currency)}
                            </Text>
                          </InlineStack>
                          {line.costTitle !== line.title && (
                            <Text as="span" tone="caution" variant="bodySm">
                              Shopify sent this line as “{line.title}”, so it was costed using your
                              “{line.costTitle}” product. If this order was really a different
                              product or a bundle, add a cost for what Shopify actually sends.
                            </Text>
                          )}
                          {!viewing.delivered && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              Not delivered, so only the materials you cannot reuse are counted.
                            </Text>
                          )}
                        </BlockStack>
                      ) : (
                        <Text as="span" tone="caution" variant="bodySm">
                          No cost recipe for this product — counted as {formatMoney(0, currency)},
                          so the profit below is too high.
                        </Text>
                      )}

                      <Text as="span" tone="subdued" variant="bodySm">
                        Shopify product {line.productId?.split("/").pop() ?? "— none sent"}
                      </Text>
                    </BlockStack>
                  </Box>
                ))
              )}
            </BlockStack>
          </Modal.Section>

          <Modal.Section>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                How the profit was calculated
              </Text>

              <MathRow
                label="Money from the customer"
                hint={
                  viewing.delivered
                    ? `Order total${viewing.tax > 0 ? `, minus ${formatMoney(viewing.tax, currency)} tax` : ""}${
                        viewing.shippingCharged > 0
                          ? `, includes ${formatMoney(viewing.shippingCharged, currency)} shipping`
                          : ""
                      }`
                    : "Not delivered — you kept none of the sale"
                }
                value={viewing.revenue}
                currency={currency}
                sign="+"
              />

              {!viewing.delivered && viewing.depositCollected > 0 && (
                <MathRow
                  label="Deposit you kept"
                  hint={viewing.depositRule ?? undefined}
                  value={viewing.depositCollected}
                  currency={currency}
                  sign="+"
                />
              )}

              <MathRow
                label="Product cost"
                hint={
                  viewing.lines.length > 0
                    ? viewing.lines
                        .map((l) => `${l.costTitle ?? l.title}${l.quantity !== 1 ? ` ×${l.quantity}` : ""}`)
                        .join(" + ")
                    : undefined
                }
                value={viewing.materialsCost}
                currency={currency}
                sign="-"
              />

              <MathRow
                label="Courier"
                hint={`${viewing.realDeliverySourceLabel}${
                  viewing.roundTrip ? " · counted both ways" : ""
                }${viewing.returnDeliveryRule ? ` · ${viewing.returnDeliveryRule}` : ""}`}
                value={viewing.realDelivery}
                currency={currency}
                sign="-"
              />

              <MathRow
                label="Payment fee"
                hint={
                  viewing.paymentFeePercent === 0 && viewing.paymentFeeFlat === 0
                    ? "No fee set in Settings"
                    : `${viewing.paymentFeePercent}%${
                        viewing.paymentFeeFlat > 0
                          ? ` + ${formatMoney(viewing.paymentFeeFlat, currency)}`
                          : ""
                      }${viewing.isCOD ? " (COD rate)" : ""}`
                }
                value={viewing.paymentFee}
                currency={currency}
                sign="-"
              />

              <Box borderColor="border" borderBlockStartWidth="025" paddingBlockStart="300">
                <MathRow
                  label="Profit on this order"
                  hint="Before ads, salaries and monthly expenses"
                  value={viewing.profit}
                  currency={currency}
                  sign="="
                  strong
                />
              </Box>

              {viewing.delivered && viewing.shippingCharged !== viewing.realDelivery && (
                <Text
                  as="p"
                  variant="bodySm"
                  tone={viewing.deliveryGap < 0 ? "critical" : "success"}
                >
                  Shipping: charged {formatMoney(viewing.shippingCharged, currency)}, paid{" "}
                  {formatMoney(viewing.realDelivery, currency)} —{" "}
                  {viewing.deliveryGap < 0
                    ? `you lost ${formatMoney(-viewing.deliveryGap, currency)}`
                    : `you gained ${formatMoney(viewing.deliveryGap, currency)}`}
                  .
                </Text>
              )}

              {viewing.refunds > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Refunded to the customer: {formatMoney(viewing.refunds, currency)}.
                </Text>
              )}
              {viewing.discounts > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Discounts given: {formatMoney(viewing.discounts, currency)}.
                </Text>
              )}
              {viewing.note && (
                <Banner tone="info">
                  <p>{viewing.note}</p>
                </Banner>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={`Adjust ${editing.name}`}
          primaryAction={{ content: "Save", onAction: saveEdit, loading: fetcher.state !== "idle" }}
          secondaryActions={[
            ...(editing.hasOverride
              ? [{ content: "Reset to default", onAction: resetEdit, destructive: true }]
              : []),
            { content: "Cancel", onAction: () => setEditing(null) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Select
                label="Delivery outcome"
                options={OUTCOMES}
                value={outcome}
                onChange={setOutcome}
                helpText="Rejected/Returned = the customer didn't keep it, so there's no sale — but you still paid the courier."
              />
              <TextField
                label="Real delivery cost for this order"
                type="number"
                value={delivery}
                onChange={setDelivery}
                autoComplete="off"
                prefix={currency}
                min={0}
                step={0.01}
                placeholder={String(editing.zoneCost)}
                helpText={
                  editing.zoneName
                    ? `Leave empty to use the "${editing.zoneName}" zone default of ${formatMoney(
                        editing.zoneCost,
                        currency,
                      )}.`
                    : "Leave empty to use the default zone cost."
                }
              />
              {outcome !== "delivered" && (
                <BlockStack gap="300">
                  <Checkbox
                    label="Paid the courier both ways (count delivery ×2)"
                    checked={roundTrip}
                    onChange={setRoundTrip}
                  />
                  <Select
                    label="Deposit collection rule"
                    options={DEPOSIT_OPTIONS}
                    value={depositMode}
                    onChange={setDepositMode}
                    helpText={`Settings default: ${settingsDepositLabel}. Deposit is added as recovered money on rejected/returned orders.`}
                  />
                  {depositMode !== "none" && depositMode !== "settings" && (
                    <TextField
                      label={depositMode === "fixed" ? "Deposit amount" : "Deposit percentage"}
                      type="number"
                      value={depositValue}
                      onChange={setDepositValue}
                      autoComplete="off"
                      prefix={depositMode === "fixed" ? currency : undefined}
                      suffix={depositMode === "fixed" ? undefined : "%"}
                      min={0}
                      max={depositMode === "fixed" ? undefined : 100}
                      step={depositMode === "fixed" ? 0.01 : 1}
                    />
                  )}
                </BlockStack>
              )}
              <TextField
                label="Note (optional)"
                value={note}
                onChange={setNote}
                autoComplete="off"
                multiline={2}
              />
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}

function FilterButton({
  current,
  value,
  label,
}: {
  current: string;
  value: string;
  label: string;
}) {
  const [params, setParams] = useSearchParams();
  return (
    <Button
      pressed={current === value}
      onClick={() => {
        const next = new URLSearchParams(params);
        if (value === "all") next.delete("outcome");
        else next.set("outcome", value);
        setParams(next, { replace: true });
      }}
    >
      {label}
    </Button>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "critical";
}) {
  return (
    <BlockStack gap="050" inlineAlign="start">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="headingMd" tone={tone}>
        {value}
      </Text>
    </BlockStack>
  );
}
