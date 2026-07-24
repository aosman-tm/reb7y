import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { parseAmount, formatMoney, round2 } from "../lib/money";
import { todayString } from "../lib/dates";

const CATEGORIES = [
  { label: "Subscription (Shopify, apps)", value: "subscription" },
  { label: "Bill (electricity, water, rent)", value: "bill" },
  { label: "Urgent / one-off (repair)", value: "urgent" },
  { label: "Other", value: "other" },
];
const FREQUENCIES = [
  { label: "Every month", value: "monthly" },
  { label: "Every week", value: "weekly" },
  { label: "Every day", value: "daily" },
  { label: "One time", value: "once" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [expenses, settings] = await Promise.all([
    prisma.expense.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" } }),
    getSettings(session.shop),
  ]);
  return { expenses, currency: settings.currency, today: todayString() };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");

  if (intent === "delete") {
    await prisma.expense.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  if (intent === "toggle") {
    const id = String(form.get("id"));
    await prisma.expense.updateMany({
      where: { id, shop },
      data: { active: form.get("active") === "true" },
    });
    return { ok: true };
  }

  if (intent === "create" || intent === "update") {
    const label = String(form.get("label") ?? "").trim();
    if (!label) return { error: "Give it a name." };
    const frequency = String(form.get("frequency") ?? "monthly");
    const dayRaw = String(form.get("dayOfMonth") ?? "").trim();
    const data = {
      label,
      category: String(form.get("category") ?? "other"),
      amount: parseAmount(form.get("amount")),
      frequency,
      date: frequency === "once" ? String(form.get("date") ?? "") || null : null,
      dayOfMonth: frequency === "monthly" && dayRaw ? Math.round(Number(dayRaw)) : null,
      note: String(form.get("note") ?? "").trim() || null,
      active: form.get("active") !== "false",
    };
    if (intent === "create") {
      await prisma.expense.create({ data: { shop, ...data } });
    } else {
      await prisma.expense.updateMany({ where: { id: String(form.get("id")), shop }, data });
    }
    return { ok: true };
  }

  return { error: "Unknown action." };
};

function monthlyEstimate(amount: number, frequency: string): number {
  switch (frequency) {
    case "daily":
      return amount * 30;
    case "weekly":
      return amount * 4.345;
    case "monthly":
      return amount;
    default:
      return 0;
  }
}

type Expense = {
  id: string;
  label: string;
  category: string;
  amount: number;
  frequency: string;
  date: string | null;
  dayOfMonth: number | null;
  note: string | null;
  active: boolean;
};

const CATEGORY_TONE: Record<string, "info" | "warning" | "critical" | undefined> = {
  subscription: "info",
  bill: "warning",
  urgent: "critical",
  other: undefined,
};

export default function ExpensesPage() {
  const { expenses, currency, today } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("subscription");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [date, setDate] = useState(today);
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [note, setNote] = useState("");

  const openNew = () => {
    setEditing("new");
    setLabel("");
    setCategory("subscription");
    setAmount("");
    setFrequency("monthly");
    setDate(today);
    setDayOfMonth("");
    setNote("");
  };
  const openEdit = (e: Expense) => {
    setEditing(e);
    setLabel(e.label);
    setCategory(e.category);
    setAmount(String(e.amount));
    setFrequency(e.frequency);
    setDate(e.date ?? today);
    setDayOfMonth(e.dayOfMonth != null ? String(e.dayOfMonth) : "");
    setNote(e.note ?? "");
  };
  const submit = () => {
    fetcher.submit(
      {
        _action: editing === "new" ? "create" : "update",
        ...(editing !== "new" && editing ? { id: editing.id } : {}),
        label,
        category,
        amount: amount || "0",
        frequency,
        date,
        dayOfMonth,
        note,
        active: "true",
      },
      { method: "post" },
    );
    setEditing(null);
  };

  const recurringMonthly = round2(
    expenses
      .filter((e) => e.active && e.frequency !== "once")
      .reduce((s, e) => s + monthlyEstimate(e.amount, e.frequency), 0),
  );

  return (
    <Page
      primaryAction={{ content: "Add expense", onAction: openNew }}
    >
      <TitleBar title="Expenses" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            Add any cost that isn't part of an order: your Shopify plan, electricity, water, rent, a
            one-off repair — anything. Pick how often you pay it and the app spreads it across your
            reports so your profit is the real number.
          </p>
        </Banner>

        {expenses.length > 0 && (
          <Card>
            <InlineStack align="space-between">
              <Text as="span" variant="headingMd">
                Recurring costs (per month)
              </Text>
              <Text as="span" variant="headingMd">
                {formatMoney(recurringMonthly, currency)}
              </Text>
            </InlineStack>
          </Card>
        )}

        <Card padding="0">
          {expenses.length === 0 ? (
            <Box padding="500">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="p" tone="subdued">
                  No expenses yet.
                </Text>
                <Button variant="primary" onClick={openNew}>
                  Add your first expense
                </Button>
              </BlockStack>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={expenses.length}
              headings={[
                { title: "Expense" },
                { title: "Amount" },
                { title: "Schedule" },
                { title: "≈ / month" },
                { title: "" },
              ]}
            >
              {expenses.map((e, index) => (
                <IndexTable.Row id={e.id} key={e.id} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="150" blockAlign="center">
                      <Text as="span" fontWeight="semibold">
                        {e.label}
                      </Text>
                      <Badge tone={CATEGORY_TONE[e.category]} size="small">
                        {e.category}
                      </Badge>
                      {!e.active && <Badge size="small">paused</Badge>}
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatMoney(e.amount, currency)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {e.frequency === "once"
                      ? `One time · ${e.date ?? "—"}`
                      : e.frequency === "monthly"
                        ? `Every month${e.dayOfMonth ? ` (day ${e.dayOfMonth})` : ""}`
                        : e.frequency === "weekly"
                          ? "Every week"
                          : "Every day"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {e.frequency === "once" ? (
                      <Text as="span" tone="subdued">
                        one-time
                      </Text>
                    ) : (
                      formatMoney(monthlyEstimate(e.amount, e.frequency), currency)
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200" align="end">
                      <Button size="slim" onClick={() => openEdit(e)}>
                        Edit
                      </Button>
                      <Button
                        size="slim"
                        variant="plain"
                        onClick={() =>
                          fetcher.submit(
                            { _action: "toggle", id: e.id, active: String(!e.active) },
                            { method: "post" },
                          )
                        }
                      >
                        {e.active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="slim"
                        variant="plain"
                        tone="critical"
                        onClick={() => {
                          if (confirm(`Delete "${e.label}"?`)) {
                            fetcher.submit({ _action: "delete", id: e.id }, { method: "post" });
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing === "new" ? "Add expense" : `Edit ${editing.label}`}
          primaryAction={{
            content: "Save",
            onAction: submit,
            loading: fetcher.state !== "idle",
            disabled: !label.trim(),
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setEditing(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <TextField
                label="Name"
                value={label}
                onChange={setLabel}
                autoComplete="off"
                placeholder="e.g. Shopify plan, Electricity, Fridge repair"
              />
              <Select label="Category" options={CATEGORIES} value={category} onChange={setCategory} />
              <TextField
                label="Amount"
                type="number"
                value={amount}
                onChange={setAmount}
                autoComplete="off"
                prefix={currency}
                min={0}
                step={0.01}
              />
              <Select
                label="How often?"
                options={FREQUENCIES}
                value={frequency}
                onChange={setFrequency}
              />
              {frequency === "once" && (
                <TextField label="Date" type="date" value={date} onChange={setDate} autoComplete="off" />
              )}
              {frequency === "monthly" && (
                <TextField
                  label="Day of month you usually pay (optional)"
                  type="number"
                  value={dayOfMonth}
                  onChange={setDayOfMonth}
                  autoComplete="off"
                  min={1}
                  max={31}
                  helpText="Just a reminder — doesn't change the math."
                />
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
