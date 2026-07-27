import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  InlineStack,
  Text,
  IndexTable,
  Banner,
  Box,
  Button,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { buildReportSafe, type Report } from "../lib/profit.server";
import { resolveRange } from "../lib/dates";
import { formatMoney, formatPercent } from "../lib/money";
import { RangeSelector } from "../components/RangeSelector";
import { ProfitStatement } from "../components/ProfitStatement";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = resolveRange(url.searchParams.get("range") ?? "30d");
  const { report, error } = await buildReportSafe(admin, session.shop, range.start, range.end);
  return { report, error, rangePreset: range.preset };
};

function downloadOrdersCsv(report: Report) {
  const header = [
    "Order",
    "Date",
    "COD",
    "Outcome",
    "Revenue",
    "Materials",
    "ShippingCharged",
    "RealDelivery",
    "DepositCollected",
    "CourierNetLoss",
    "PaymentFee",
    "Profit",
    "City",
  ];
  const rows = report.orders.map((o) => [
    o.name,
    o.createdAt.slice(0, 10),
    o.isCOD ? "yes" : "no",
    o.outcome,
    o.revenue,
    o.materialsCost,
    o.shippingCharged,
    o.realDelivery,
    o.depositCollected,
    o.courierNetLoss,
    o.paymentFee,
    o.profit,
    (o.city ?? "").replace(/[",\n]/g, " "),
  ]);
  const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `reb7y-orders-${report.range.start}_to_${report.range.end}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export default function ReportsPage() {
  const { report, error, rangePreset } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Reports" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingLg">
            Profit &amp; loss
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Box minWidth="180px">
              <RangeSelector value={rangePreset} />
            </Box>
            {report && report.orders.length > 0 && (
              <Button onClick={() => downloadOrdersCsv(report)}>Export orders CSV</Button>
            )}
          </InlineStack>
        </InlineStack>

        {error && (
          <Banner tone="critical" title="Couldn't read your orders from Shopify">
            <p>{error}</p>
          </Banner>
        )}

        <Banner tone="info">
          <p>
            Calculations include all Shopify orders inside the selected date range, even if those
            orders were created before this app was installed.
          </p>
        </Banner>

        {report && (
          <>
            <InlineGrid columns={{ xs: 1, md: "3fr 2fr" }} gap="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">
                    {report.range.start} → {report.range.end}
                  </Text>
                  <ProfitStatement totals={report.totals} currency={report.currency} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Extra detail
                  </Text>
                  <DetailRow
                    label="Orders"
                    value={String(report.totals.orderCount)}
                  />
                  <DetailRow
                    label="Rejected / returned"
                    value={String(report.totals.rejectedCount)}
                  />
                  <Divider />
                  <DetailRow
                    label="Shipping charged to customers"
                    value={formatMoney(report.totals.shippingCharged, report.currency)}
                  />
                  <DetailRow
                    label="Real delivery cost paid"
                    value={formatMoney(report.totals.realDelivery, report.currency)}
                  />
                  <DetailRow
                    label="Deposits recovered"
                    value={formatMoney(report.totals.depositsRecovered, report.currency)}
                    tone={report.totals.depositsRecovered > 0 ? "success" : undefined}
                  />
                  <DetailRow
                    label="Rejected/returned courier net"
                    value={formatMoney(report.totals.courierIssueNetLoss, report.currency)}
                    tone={report.totals.courierIssueNetLoss > 0 ? "critical" : "success"}
                  />
                  <DetailRow
                    label="Lost on shipping (real > charged)"
                    value={formatMoney(report.totals.deliveryLoss, report.currency)}
                    tone="critical"
                  />
                  <Divider />
                  <DetailRow
                    label="Discounts given"
                    value={formatMoney(report.totals.discounts, report.currency)}
                  />
                  <DetailRow
                    label="Refunds"
                    value={formatMoney(report.totals.refunds, report.currency)}
                  />
                  <DetailRow
                    label="Ad spend"
                    value={formatMoney(report.totals.adSpend, report.currency)}
                  />
                  <DetailRow
                    label="Overheads (subscription, bills…)"
                    value={formatMoney(report.totals.overheads, report.currency)}
                  />
                  <DetailRow
                    label="Salaries & bonuses"
                    value={formatMoney(report.totals.payroll, report.currency)}
                  />
                </BlockStack>
              </Card>
            </InlineGrid>

            <Card padding="0">
              <Box padding="400">
                <Text as="h3" variant="headingMd">
                  Product profitability
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Delivered orders only. Shipping and payment fees are split across products by each
                  line's share of order revenue.
                </Text>
              </Box>
              {report.products.length === 0 ? (
                <Box paddingInline="400" paddingBlockEnd="400">
                  <Text as="p" tone="subdued">
                    No product sales in this range.
                  </Text>
                </Box>
              ) : (
                <IndexTable
                  selectable={false}
                  itemCount={report.products.length}
                  headings={[
                    { title: "Product" },
                    { title: "Units" },
                    { title: "Revenue" },
                    { title: "Materials" },
                    { title: "Shipping charged (share)" },
                    { title: "Real delivery (share)" },
                    { title: "Payment fee (share)" },
                    { title: "Profit" },
                    { title: "Margin" },
                  ]}
                >
                  {report.products.map((p, index) => (
                    <IndexTable.Row id={p.productId ?? p.title} key={p.productId ?? p.title} position={index}>
                      <IndexTable.Cell>
                        <InlineStack gap="150" blockAlign="center">
                          <Text as="span" fontWeight="medium">
                            {p.title}
                          </Text>
                          {p.missingCost && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              (no recipe)
                            </Text>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{p.units}</IndexTable.Cell>
                      <IndexTable.Cell>{formatMoney(p.revenue, report.currency)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatMoney(p.materialCost, report.currency)}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatMoney(p.shippingChargedAllocated, report.currency)}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatMoney(p.deliveryCostAllocated, report.currency)}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatMoney(p.paymentFeeAllocated, report.currency)}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone={p.profit >= 0 ? "success" : "critical"}>
                          {formatMoney(p.profit, report.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone={p.marginRatio >= 0 ? "success" : "critical"}>
                          {formatPercent(p.marginRatio)}
                        </Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </Card>
          </>
        )}
      </BlockStack>
    </Page>
  );
}

function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "critical" | "success";
}) {
  return (
    <InlineStack align="space-between">
      <Text as="span" tone="subdued">
        {label}
      </Text>
      <Text as="span" tone={tone}>
        {value}
      </Text>
    </InlineStack>
  );
}
