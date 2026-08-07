import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  Text,
  TextField,
  Select,
  Button,
  Checkbox,
  Banner,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import {
  recordSettingsVersion,
  seedSettingsBaseline,
  settingsVersionHistory,
} from "../lib/costHistory.server";
import { todayString } from "../lib/dates";
import { formatDay } from "../lib/priceTimeline";
import { parseAmount } from "../lib/money";

const CURRENCIES = ["EGP", "USD", "GBP", "EUR", "SAR", "AED"].map((c) => ({
  label: c,
  value: c,
}));

const RETURN_DELIVERY_OPTIONS = [
  { label: "Charge full real delivery", value: "full" },
  { label: "Charge percentage of real delivery", value: "percent" },
  { label: "Charge fixed amount", value: "fixed" },
];

const DEPOSIT_OPTIONS = [
  { label: "No deposit", value: "none" },
  { label: "Fixed deposit amount", value: "fixed" },
  { label: "Percentage of real courier cost", value: "percent_real" },
  { label: "Percentage of Shopify shipping", value: "percent_shopify" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [settings, history] = await Promise.all([
    getSettings(session.shop),
    settingsVersionHistory(session.shop),
  ]);
  return { settings, history, today: todayString() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const depositMode = String(form.get("depositMode") ?? "none");
  const data = {
    currency: String(form.get("currency") ?? "EGP"),
    paymentFeePercent: parseAmount(form.get("paymentFeePercent")),
    paymentFeeFlat: parseAmount(form.get("paymentFeeFlat")),
    codFeePercent: parseAmount(form.get("codFeePercent")),
    codRoundTripDefault: form.get("codRoundTripDefault") === "true",
    returnDeliveryMode: String(form.get("returnDeliveryMode") ?? "full"),
    returnDeliveryPercent: parseAmount(form.get("returnDeliveryPercent"), 100),
    returnDeliveryFixed: parseAmount(form.get("returnDeliveryFixed"), 0),
    depositMode,
    depositValue: depositMode === "none" ? 0 : parseAmount(form.get("depositValue"), 0),
  };
  const previous = await getSettings(shop);

  // Baseline the OLD rules before the new ones land. Without this the first
  // change becomes the oldest recorded version and applies backwards over
  // every order ever placed.
  await seedSettingsBaseline(shop, previous);

  await prisma.settings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });

  const raw = String(form.get("effectiveFrom") ?? "");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayString();
  await recordSettingsVersion({ shop, day, rules: data });

  return { ok: true };
};

export default function SettingsPage() {
  const { settings, history, today } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [currency, setCurrency] = useState(settings.currency);
  const [feePct, setFeePct] = useState(String(settings.paymentFeePercent));
  const [feeFlat, setFeeFlat] = useState(String(settings.paymentFeeFlat));
  const [codPct, setCodPct] = useState(String(settings.codFeePercent));
  const [codRoundTrip, setCodRoundTrip] = useState(settings.codRoundTripDefault);
  const [returnDeliveryMode, setReturnDeliveryMode] = useState(settings.returnDeliveryMode);
  const [returnDeliveryPercent, setReturnDeliveryPercent] = useState(
    String(settings.returnDeliveryPercent),
  );
  const [returnDeliveryFixed, setReturnDeliveryFixed] = useState(
    String(settings.returnDeliveryFixed),
  );
  const [depositMode, setDepositMode] = useState(settings.depositMode);
  const [depositValue, setDepositValue] = useState(String(settings.depositValue));
  const busy = fetcher.state !== "idle";
  const saved = fetcher.data && "ok" in fetcher.data && fetcher.state === "idle";

  return (
    <Page>
      <TitleBar title="Settings" />
      <BlockStack gap="400">
        {saved && <Banner tone="success">Settings saved.</Banner>}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Currency
            </Text>
            <Select
              label="Store currency"
              options={CURRENCIES}
              value={currency}
              onChange={setCurrency}
              helpText="Used to display all amounts across the app."
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Payment fees
            </Text>
            <Text as="p" tone="subdued">
              Charged against the money you collect on each order. Leave at 0 if you don't pay a
              gateway fee.
            </Text>
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
              <TextField
                label="Card / gateway fee (%)"
                type="number"
                value={feePct}
                onChange={setFeePct}
                autoComplete="off"
                suffix="%"
                min={0}
                step={0.1}
              />
              <TextField
                label="Flat fee per order"
                type="number"
                value={feeFlat}
                onChange={setFeeFlat}
                autoComplete="off"
                prefix={currency}
                min={0}
                step={0.01}
              />
            </InlineGrid>
            <TextField
              label="Cash-on-Delivery (COD) fee (%)"
              type="number"
              value={codPct}
              onChange={setCodPct}
              autoComplete="off"
              suffix="%"
              min={0}
              step={0.1}
              helpText="Extra fee some couriers charge to collect cash. Applied to COD orders instead of the card fee. Leave 0 to use the card fee."
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Rejected / returned orders
            </Text>
            <Select
              label="Default return delivery cost"
              options={RETURN_DELIVERY_OPTIONS}
              value={returnDeliveryMode}
              onChange={setReturnDeliveryMode}
            />
            {returnDeliveryMode === "percent" && (
              <TextField
                label="Default return delivery percentage"
                type="number"
                value={returnDeliveryPercent}
                onChange={setReturnDeliveryPercent}
                autoComplete="off"
                suffix="%"
                min={0}
                max={100}
                step={1}
              />
            )}
            {returnDeliveryMode === "fixed" && (
              <TextField
                label="Default fixed return delivery amount"
                type="number"
                value={returnDeliveryFixed}
                onChange={setReturnDeliveryFixed}
                autoComplete="off"
                prefix={currency}
                min={0}
                step={0.01}
              />
            )}
            <Checkbox
              label="Count delivery cost twice on rejected/returned orders (paid the courier both ways)"
              checked={codRoundTrip}
              onChange={setCodRoundTrip}
            />
            <Text as="p" tone="subdued" variant="bodySm">
              These are defaults. You can still adjust each order manually, and each product can
              override how much delivery is charged when returned.
            </Text>

            <Text as="h3" variant="headingSm">
              Deposit collection (order confirmation)
            </Text>
            <Select
              label="Default deposit rule"
              options={DEPOSIT_OPTIONS}
              value={depositMode}
              onChange={setDepositMode}
              helpText="Applied on rejected/returned orders as recovered money from the customer deposit."
            />
            {depositMode !== "none" && (
              <TextField
                label={depositMode === "fixed" ? "Default deposit amount" : "Default deposit percentage"}
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
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              When do these rules start?
            </Text>
            <Text as="p" tone="subdued">
              Orders before this date keep the rules that applied then, so your finished reports do
              not change. Set an earlier date if a fee actually changed a while ago and you are
              entering it late.
            </Text>
            <Box maxWidth="240px">
              <TextField
                label="These rules apply from"
                type="date"
                value={effectiveFrom}
                max={today}
                onChange={setEffectiveFrom}
                autoComplete="off"
              />
            </Box>

            {history.length > 0 && (
              <BlockStack gap="150">
                <Text as="h3" variant="headingSm">
                  Earlier rules
                </Text>
                {history.map((h) => (
                  <InlineStack key={h.effectiveFrom} gap="300" align="space-between">
                    <Text as="span" tone="subdued">
                      {h.effectiveFrom <= "2000-01-01"
                        ? "From the beginning"
                        : `From ${formatDay(h.effectiveFrom)}`}
                    </Text>
                    <Text as="span" tone="subdued">
                      card {h.paymentFeePercent}% · COD {h.codFeePercent}% · deposit{" "}
                      {h.depositMode}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <InlineStack align="end">
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              fetcher.submit(
                {
                  currency,
                  paymentFeePercent: feePct || "0",
                  paymentFeeFlat: feeFlat || "0",
                  codFeePercent: codPct || "0",
                  codRoundTripDefault: String(codRoundTrip),
                  returnDeliveryMode,
                  returnDeliveryPercent: returnDeliveryPercent || "100",
                  returnDeliveryFixed: returnDeliveryFixed || "0",
                  depositMode,
                  depositValue: depositValue || "0",
                  effectiveFrom,
                },
                { method: "post" },
              )
            }
          >
            Save settings
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
