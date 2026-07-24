import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  InlineStack,
  Text,
  Badge,
  Banner,
  Box,
  Button,
  Divider,
  Icon,
} from "@shopify/polaris";
import { CheckCircleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { buildReportSafe } from "../lib/profit.server";
import { resolveRange } from "../lib/dates";
import { formatMoney, formatPercent } from "../lib/money";
import { RangeSelector } from "../components/RangeSelector";
import { ProfitStatement } from "../components/ProfitStatement";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = resolveRange(url.searchParams.get("range") ?? "30d");

  const [{ report, error }, materialsCount, zonesCount, productCostCount] = await Promise.all([
    buildReportSafe(admin, session.shop, range.start, range.end),
    prisma.material.count({ where: { shop: session.shop, archived: false } }),
    prisma.deliveryZone.count({ where: { shop: session.shop } }),
    prisma.productCost.count({ where: { shop: session.shop } }),
  ]);

  return {
    report,
    error,
    rangePreset: range.preset,
    setup: { materialsCount, zonesCount, productCostCount },
  };
};

export default function Dashboard() {
  const { report, error, rangePreset, setup } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const setupComplete =
    setup.materialsCount > 0 && setup.productCostCount > 0 && setup.zonesCount > 0;

  return (
    <Page>
      <TitleBar title="reb7y — profit dashboard" />
      <BlockStack gap="400">
        {!setupComplete && <SetupChecklist setup={setup} navigate={navigate} />}

        {error && (
          <Banner tone="critical" title="Couldn't read your orders from Shopify">
            <p>{error}</p>
            <p>
              This usually means the app still needs <b>Protected customer data access</b> approved
              in your Partner dashboard (Apps → your app → API access), or the app needs to be
              reinstalled after adding the orders permission. See the README for the exact steps.
            </p>
          </Banner>
        )}

        <Banner tone="info">
          <p>
            Numbers below include all Shopify orders in the selected range, even if those orders
            were created before you installed reb7y.
          </p>
        </Banner>

        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingLg">
            Overview
          </Text>
          <Box minWidth="180px">
            <RangeSelector value={rangePreset} />
          </Box>
        </InlineStack>

        {report && (
          <>
            {report.missingCostCount > 0 && (
              <Banner tone="warning">
                <p>
                  {report.missingCostCount} order(s) contain a product without a recipe, so their
                  material cost counts as 0. Add recipes on <b>Product costs</b> for fully accurate
                  numbers.
                </p>
              </Banner>
            )}

            <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
              <HeroKpi
                label="Net profit"
                value={formatMoney(report.totals.netProfit, report.currency)}
                tone={report.totals.netProfit >= 0 ? "success" : "critical"}
                sub={`${formatPercent(report.totals.margin)} margin`}
              />
              <HeroKpi
                label="Revenue"
                value={formatMoney(report.totals.revenue, report.currency)}
                sub={`${report.totals.orderCount} orders`}
              />
              <HeroKpi
                label="Total costs"
                value={formatMoney(
                  report.totals.materialsCost +
                    report.totals.realDelivery +
                    report.totals.paymentFee +
                    report.totals.adSpend +
                    report.totals.overheads +
                    report.totals.payroll,
                  report.currency,
                )}
                sub="materials, delivery, fees, ads, overheads, salaries"
              />
              <HeroKpi
                label="Rejected / returned"
                value={String(report.totals.rejectedCount)}
                sub={
                  report.totals.deliveryLoss > 0
                    ? `${formatMoney(report.totals.deliveryLoss, report.currency)} lost on shipping`
                    : "no shipping loss"
                }
              />
            </InlineGrid>

            <InlineGrid columns={{ xs: 1, md: "3fr 2fr" }} gap="400">
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">
                    Profit &amp; loss
                  </Text>
                  <ProfitStatement totals={report.totals} currency={report.currency} />
                </BlockStack>
              </Card>

              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">
                      Where the money goes
                    </Text>
                    <CostMix totals={report.totals} currency={report.currency} />
                  </BlockStack>
                </Card>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      Jump to
                    </Text>
                    <Button onClick={() => navigate("/app/orders")}>Orders &amp; profit</Button>
                    <Button onClick={() => navigate("/app/reports")}>Full reports</Button>
                    <Button onClick={() => navigate("/app/ads")}>Log today's ad spend</Button>
                  </BlockStack>
                </Card>
              </BlockStack>
            </InlineGrid>
          </>
        )}
      </BlockStack>
    </Page>
  );
}

function HeroKpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "success" | "critical";
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="span" variant="heading2xl" tone={tone}>
          {value}
        </Text>
        {sub && (
          <Text as="span" variant="bodySm" tone="subdued">
            {sub}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

function CostMix({
  totals,
  currency,
}: {
  totals: {
    revenue: number;
    materialsCost: number;
    realDelivery: number;
    paymentFee: number;
    adSpend: number;
    overheads: number;
    payroll: number;
  };
  currency: string;
}) {
  const items = [
    { label: "Materials", amount: totals.materialsCost },
    { label: "Delivery", amount: totals.realDelivery },
    { label: "Payment fees", amount: totals.paymentFee },
    { label: "Ad spend", amount: totals.adSpend },
    { label: "Overheads", amount: totals.overheads },
    { label: "Salaries & bonuses", amount: totals.payroll },
  ];
  const base = totals.revenue > 0 ? totals.revenue : 0;
  return (
    <BlockStack gap="200">
      {items.map((it) => (
        <InlineStack key={it.label} align="space-between">
          <Text as="span" tone="subdued">
            {it.label}
          </Text>
          <Text as="span">
            {formatMoney(it.amount, currency)}
            {base > 0 && (
              <Text as="span" tone="subdued" variant="bodySm">
                {"  "}({formatPercent(it.amount / base)})
              </Text>
            )}
          </Text>
        </InlineStack>
      ))}
    </BlockStack>
  );
}

function SetupChecklist({
  setup,
  navigate,
}: {
  setup: { materialsCount: number; zonesCount: number; productCostCount: number };
  navigate: (to: string) => void;
}) {
  const steps = [
    {
      done: setup.materialsCount > 0,
      label: "Add your materials",
      hint: "Box, bubble wrap, cards, stickers…",
      to: "/app/materials",
    },
    {
      done: setup.productCostCount > 0,
      label: "Build product recipes",
      hint: "Combine materials into each product's cost",
      to: "/app/products",
    },
    {
      done: setup.zonesCount > 0,
      label: "Set delivery zones",
      hint: "Real courier cost per area",
      to: "/app/delivery",
    },
  ];
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Finish setting up reb7y
        </Text>
        <Divider />
        {steps.map((s) => (
          <InlineStack key={s.label} align="space-between" blockAlign="center">
            <InlineStack gap="200" blockAlign="center">
              <Box>
                {s.done ? (
                  <Icon source={CheckCircleIcon} tone="success" />
                ) : (
                  <Badge tone="attention">To do</Badge>
                )}
              </Box>
              <BlockStack gap="050">
                <Text as="span" fontWeight="medium">
                  {s.label}
                </Text>
                <Text as="span" tone="subdued" variant="bodySm">
                  {s.hint}
                </Text>
              </BlockStack>
            </InlineStack>
            {!s.done && <Button onClick={() => navigate(s.to)}>Start</Button>}
          </InlineStack>
        ))}
      </BlockStack>
    </Card>
  );
}
