import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  InlineStack,
  Text,
  TextField,
  Button,
  IndexTable,
  Banner,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { parseAmount, formatMoney, round2 } from "../lib/money";
import { todayString } from "../lib/dates";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [entries, settings] = await Promise.all([
    prisma.adSpend.findMany({
      where: { shop: session.shop },
      orderBy: { date: "desc" },
      take: 90,
    }),
    getSettings(session.shop),
  ]);
  const total = round2(entries.reduce((s, e) => s + e.amount, 0));
  return { entries, currency: settings.currency, today: todayString(), total };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");

  if (intent === "save") {
    const date = String(form.get("date") ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Pick a valid date." };
    const amount = parseAmount(form.get("amount"));
    const note = String(form.get("note") ?? "").trim() || null;
    await prisma.adSpend.upsert({
      where: { shop_date: { shop, date } },
      create: { shop, date, amount, note },
      update: { amount, note },
    });
    return { ok: true };
  }

  if (intent === "delete") {
    await prisma.adSpend.deleteMany({ where: { shop, date: String(form.get("date")) } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

function AddSpend({ today }: { today: string }) {
  const fetcher = useFetcher<typeof action>();
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const busy = fetcher.state !== "idle";

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Log ad spend for a day
        </Text>
        <InlineGrid columns={{ xs: 1, sm: "1fr 1fr 2fr auto" }} gap="300">
          <TextField label="Date" type="date" value={date} onChange={setDate} autoComplete="off" />
          <TextField
            label="Amount spent"
            type="number"
            value={amount}
            onChange={setAmount}
            autoComplete="off"
            prefix="EGP"
            min={0}
            step={0.01}
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChange={setNote}
            autoComplete="off"
            placeholder="e.g. Facebook + TikTok"
          />
          <Box paddingBlockStart="600">
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                fetcher.submit(
                  { _action: "save", date, amount: amount || "0", note },
                  { method: "post" },
                );
                setAmount("");
                setNote("");
              }}
            >
              Save
            </Button>
          </Box>
        </InlineGrid>
        <Text as="p" tone="subdued" variant="bodySm">
          Saving a date that already exists will update it.
        </Text>
      </BlockStack>
    </Card>
  );
}

type Entry = { id: string; date: string; amount: number; note: string | null };

function SpendRow({ entry, index }: { entry: Entry; index: number }) {
  const fetcher = useFetcher<typeof action>();
  const [amount, setAmount] = useState(String(entry.amount));
  const [note, setNote] = useState(entry.note ?? "");
  const busy = fetcher.state !== "idle";
  const dirty = amount !== String(entry.amount) || note !== (entry.note ?? "");

  return (
    <IndexTable.Row id={entry.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="medium">
          {entry.date}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Box maxWidth="140px">
          <TextField
            label="Amount"
            labelHidden
            type="number"
            value={amount}
            onChange={setAmount}
            autoComplete="off"
            prefix="EGP"
            min={0}
            step={0.01}
          />
        </Box>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <TextField label="Note" labelHidden value={note} onChange={setNote} autoComplete="off" />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" align="end" blockAlign="center">
          <Button
            size="slim"
            disabled={!dirty}
            loading={busy}
            onClick={() =>
              fetcher.submit(
                { _action: "save", date: entry.date, amount: amount || "0", note },
                { method: "post" },
              )
            }
          >
            Save
          </Button>
          <Button
            size="slim"
            variant="plain"
            tone="critical"
            onClick={() =>
              fetcher.submit({ _action: "delete", date: entry.date }, { method: "post" })
            }
          >
            Delete
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function AdsPage() {
  const { entries, currency, today, total } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Ad spend" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            Enter how much you spent on ads each day. This is subtracted from your profit for the
            matching date range in the Dashboard and Reports.
          </p>
        </Banner>

        <AddSpend today={today} />

        <Card padding="0">
          {entries.length === 0 ? (
            <Box padding="500">
              <Text as="p" tone="subdued" alignment="center">
                No ad spend logged yet.
              </Text>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={entries.length}
              headings={[
                { title: "Date" },
                { title: "Amount" },
                { title: "Note" },
                { title: "" },
              ]}
            >
              {entries.map((e, i) => (
                <SpendRow key={e.id} entry={e} index={i} />
              ))}
            </IndexTable>
          )}
        </Card>

        {entries.length > 0 && (
          <Card>
            <InlineStack align="space-between">
              <Text as="span" variant="headingMd">
                Total (last {entries.length} entries)
              </Text>
              <Text as="span" variant="headingMd">
                {formatMoney(total, currency)}
              </Text>
            </InlineStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
