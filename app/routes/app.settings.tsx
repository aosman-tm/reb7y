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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { parseAmount } from "../lib/money";

const CURRENCIES = ["EGP", "USD", "GBP", "EUR", "SAR", "AED"].map((c) => ({
  label: c,
  value: c,
}));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  return { settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const data = {
    currency: String(form.get("currency") ?? "EGP"),
    paymentFeePercent: parseAmount(form.get("paymentFeePercent")),
    paymentFeeFlat: parseAmount(form.get("paymentFeeFlat")),
    codFeePercent: parseAmount(form.get("codFeePercent")),
    codRoundTripDefault: form.get("codRoundTripDefault") === "true",
  };
  await prisma.settings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
  return { ok: true };
};

export default function SettingsPage() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [currency, setCurrency] = useState(settings.currency);
  const [feePct, setFeePct] = useState(String(settings.paymentFeePercent));
  const [feeFlat, setFeeFlat] = useState(String(settings.paymentFeeFlat));
  const [codPct, setCodPct] = useState(String(settings.codFeePercent));
  const [codRoundTrip, setCodRoundTrip] = useState(settings.codRoundTripDefault);
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
            <Checkbox
              label="Count delivery cost twice on rejected/returned orders (paid the courier both ways)"
              checked={codRoundTrip}
              onChange={setCodRoundTrip}
            />
            <Text as="p" tone="subdued" variant="bodySm">
              This is the default. You can still change round-trip on any individual order.
            </Text>
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
