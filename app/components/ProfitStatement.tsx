import { BlockStack, InlineStack, Text, Divider, Box } from "@shopify/polaris";
import type { ReportTotals } from "../lib/profit.server";
import { formatMoney, formatPercent } from "../lib/money";

function Row({
  label,
  amount,
  currency,
  strong,
  tone,
}: {
  label: string;
  amount: number;
  currency: string;
  strong?: boolean;
  tone?: "success" | "critical" | "subdued";
}) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      <Text as="span" variant={strong ? "headingMd" : "bodyMd"} tone={strong ? undefined : tone}>
        {label}
      </Text>
      <Text as="span" variant={strong ? "headingMd" : "bodyMd"} tone={tone}>
        {formatMoney(amount, currency)}
      </Text>
    </InlineStack>
  );
}

/** The core profit-and-loss waterfall: revenue down to net profit. */
export function ProfitStatement({
  totals,
  currency,
}: {
  totals: ReportTotals;
  currency: string;
}) {
  return (
    <BlockStack gap="300">
      <Row label="Revenue" amount={totals.revenue} currency={currency} />
      <Row label="− Materials" amount={-totals.materialsCost} currency={currency} tone="subdued" />
      <Row
        label="− Real delivery cost"
        amount={-totals.realDelivery}
        currency={currency}
        tone="subdued"
      />
      <Row label="− Payment fees" amount={-totals.paymentFee} currency={currency} tone="subdued" />
      <Divider />
      <Row label="Gross profit (orders)" amount={totals.grossProfit} currency={currency} strong />
      <Row label="− Ad spend" amount={-totals.adSpend} currency={currency} tone="subdued" />
      <Row
        label="− Overheads (subscription, bills…)"
        amount={-totals.overheads}
        currency={currency}
        tone="subdued"
      />
      <Row
        label="− Salaries & bonuses"
        amount={-totals.payroll}
        currency={currency}
        tone="subdued"
      />
      <Divider />
      <Box
        padding="300"
        background={totals.netProfit >= 0 ? "bg-surface-success" : "bg-surface-critical"}
        borderRadius="200"
      >
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="headingLg">
            Net profit
          </Text>
          <Text
            as="span"
            variant="headingLg"
            tone={totals.netProfit >= 0 ? "success" : "critical"}
          >
            {formatMoney(totals.netProfit, currency)}
          </Text>
        </InlineStack>
        <InlineStack align="space-between">
          <Text as="span" variant="bodySm" tone="subdued">
            Profit margin
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {formatPercent(totals.margin)}
          </Text>
        </InlineStack>
      </Box>
    </BlockStack>
  );
}
