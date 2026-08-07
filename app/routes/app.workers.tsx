import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  TextField,
  Select,
  Button,
  Badge,
  Banner,
  Box,
  Modal,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { setSalaryTimeline, allSalaryHistories } from "../lib/costHistory.server";
import {
  fromEditorModel,
  toEditorModel,
  parseEditorModel,
  EARLIEST_DAY,
  type PriceEditorModel,
  type PriceEntry,
} from "../lib/priceTimeline";
import { PriceRowsEditor } from "../components/PriceRowsEditor";
import { parseAmount, formatMoney, round2 } from "../lib/money";
import { todayString } from "../lib/dates";

const PAYMENT_TYPES = [
  { label: "Bonus", value: "bonus" },
  { label: "Gift", value: "gift" },
  { label: "Other", value: "other" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [workers, settings, salaryHistories] = await Promise.all([
    prisma.worker.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "asc" },
      include: { payments: { orderBy: { createdAt: "desc" }, take: 30 } },
    }),
    getSettings(session.shop),
    allSalaryHistories(session.shop),
  ]);
  return {
    workers: workers.map((w) => ({
      ...w,
      // Past salaries, so the edit form shows the whole history.
      salaryHistory:
        salaryHistories[w.id] ?? [{ effectiveFrom: EARLIEST_DAY, amount: w.monthlySalary }],
    })),
    currency: settings.currency,
    today: todayString(),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");

  if (intent === "createWorker" || intent === "updateWorker") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Name is required." };
    const ageRaw = String(form.get("age") ?? "").trim();
    // The salary arrives as a whole timeline: what it is now, plus any earlier
    // periods where it was different. A raise must not restate past payroll.
    const model = parseEditorModel(form.get("salary"));
    const entries = fromEditorModel(model, EARLIEST_DAY);
    const data = {
      name,
      age: ageRaw ? Math.round(Number(ageRaw)) : null,
      monthlySalary: model.current,
      note: String(form.get("note") ?? "").trim() || null,
    };
    if (intent === "createWorker") {
      const created = await prisma.worker.create({ data: { shop, ...data } });
      await setSalaryTimeline({ shop, workerId: created.id, entries });
    } else {
      const id = String(form.get("id"));
      await prisma.worker.updateMany({ where: { id, shop }, data });
      await setSalaryTimeline({ shop, workerId: id, entries });
    }
    return { ok: true };
  }

  if (intent === "toggleWorker") {
    await prisma.worker.updateMany({
      where: { id: String(form.get("id")), shop },
      data: { active: form.get("active") === "true" },
    });
    return { ok: true };
  }

  if (intent === "deleteWorker") {
    await prisma.worker.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  if (intent === "addPayment") {
    const workerId = String(form.get("workerId") ?? "");
    // Confirm the worker belongs to this shop before logging a payment.
    const worker = await prisma.worker.findFirst({ where: { id: workerId, shop } });
    if (!worker) return { error: "Worker not found." };
    await prisma.workerPayment.create({
      data: {
        shop,
        workerId,
        amount: parseAmount(form.get("amount")),
        type: String(form.get("type") ?? "bonus"),
        date: String(form.get("date") ?? "") || todayString(),
        note: String(form.get("note") ?? "").trim() || null,
      },
    });
    return { ok: true };
  }

  if (intent === "deletePayment") {
    await prisma.workerPayment.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

type Payment = {
  id: string;
  amount: number;
  type: string;
  date: string;
  note: string | null;
  createdAt: string;
};
type Worker = {
  id: string;
  name: string;
  age: number | null;
  monthlySalary: number;
  active: boolean;
  note: string | null;
  payments: Payment[];
  salaryHistory: PriceEntry[];
};

function loggedAt(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function WorkersPage() {
  const { workers, currency, today } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // Worker add/edit modal
  const [workerModal, setWorkerModal] = useState<Worker | "new" | null>(null);
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [salary, setSalary] = useState<PriceEditorModel>({ current: 0, periods: [] });
  const [wnote, setWnote] = useState("");

  // Payment modal
  const [payFor, setPayFor] = useState<Worker | null>(null);
  const [pAmount, setPAmount] = useState("");
  const [pType, setPType] = useState("bonus");
  const [pDate, setPDate] = useState(today);
  const [pNote, setPNote] = useState("");

  const openNewWorker = () => {
    setWorkerModal("new");
    setName("");
    setAge("");
    setSalary({ current: 0, periods: [] });
    setWnote("");
  };
  const openEditWorker = (w: Worker) => {
    setWorkerModal(w);
    setName(w.name);
    setAge(w.age != null ? String(w.age) : "");
    // Show every salary ever recorded, not just the current one.
    setSalary(toEditorModel(w.salaryHistory, today, EARLIEST_DAY));
    setWnote(w.note ?? "");
  };
  const submitWorker = () => {
    fetcher.submit(
      {
        _action: workerModal === "new" ? "createWorker" : "updateWorker",
        ...(workerModal !== "new" && workerModal ? { id: workerModal.id } : {}),
        name,
        age,
        salary: JSON.stringify(salary),
        note: wnote,
      },
      { method: "post" },
    );
    setWorkerModal(null);
  };

  const openPayment = (w: Worker) => {
    setPayFor(w);
    setPAmount("");
    setPType("bonus");
    setPDate(today);
    setPNote("");
  };
  const submitPayment = () => {
    if (!payFor) return;
    fetcher.submit(
      {
        _action: "addPayment",
        workerId: payFor.id,
        amount: pAmount || "0",
        type: pType,
        date: pDate,
        note: pNote,
      },
      { method: "post" },
    );
    setPayFor(null);
  };

  const totalSalaries = round2(
    workers.filter((w) => w.active).reduce((s, w) => s + w.monthlySalary, 0),
  );

  return (
    <Page primaryAction={{ content: "Add worker", onAction: openNewWorker }}>
      <TitleBar title="Workers" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            Add your team with their monthly salary, and log any bonus or gift (with the date and
            time). Salaries and bonuses are subtracted from your profit in the Dashboard and Reports.
          </p>
        </Banner>

        {workers.length > 0 && (
          <Card>
            <InlineStack align="space-between">
              <Text as="span" variant="headingMd">
                Monthly salaries (active workers)
              </Text>
              <Text as="span" variant="headingMd">
                {formatMoney(totalSalaries, currency)}
              </Text>
            </InlineStack>
          </Card>
        )}

        {workers.length === 0 ? (
          <Card>
            <Box padding="400">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="p" tone="subdued">
                  No workers yet.
                </Text>
                <Button variant="primary" onClick={openNewWorker}>
                  Add your first worker
                </Button>
              </BlockStack>
            </Box>
          </Card>
        ) : (
          workers.map((w) => (
            <Card key={w.id}>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {w.name}
                    </Text>
                    {w.age != null && (
                      <Text as="span" tone="subdued">
                        {w.age} yrs
                      </Text>
                    )}
                    {!w.active && <Badge>paused</Badge>}
                  </InlineStack>
                  <InlineStack gap="200">
                    <Text as="span" variant="headingMd">
                      {formatMoney(w.monthlySalary, currency)}/mo
                    </Text>
                  </InlineStack>
                </InlineStack>

                <InlineStack gap="200">
                  <Button size="slim" onClick={() => openEditWorker(w)}>
                    Edit
                  </Button>
                  <Button size="slim" onClick={() => openPayment(w)}>
                    Add bonus / gift
                  </Button>
                  <Button
                    size="slim"
                    variant="plain"
                    onClick={() =>
                      fetcher.submit(
                        { _action: "toggleWorker", id: w.id, active: String(!w.active) },
                        { method: "post" },
                      )
                    }
                  >
                    {w.active ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="slim"
                    variant="plain"
                    tone="critical"
                    onClick={() => {
                      if (confirm(`Delete ${w.name}? This removes their bonus log too.`)) {
                        fetcher.submit(
                          { _action: "deleteWorker", id: w.id },
                          { method: "post" },
                        );
                      }
                    }}
                  >
                    Delete
                  </Button>
                </InlineStack>

                {w.payments.length > 0 && (
                  <>
                    <Divider />
                    <Text as="h4" variant="headingSm">
                      Bonuses &amp; gifts
                    </Text>
                    <BlockStack gap="150">
                      {w.payments.map((p) => (
                        <InlineStack key={p.id} align="space-between" blockAlign="center">
                          <InlineStack gap="200" blockAlign="center">
                            <Badge size="small">{p.type}</Badge>
                            <Text as="span" fontWeight="medium">
                              {formatMoney(p.amount, currency)}
                            </Text>
                            <Text as="span" tone="subdued" variant="bodySm">
                              {p.date}
                              {p.note ? ` · ${p.note}` : ""}
                            </Text>
                          </InlineStack>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" tone="subdued" variant="bodySm">
                              logged {loggedAt(p.createdAt)}
                            </Text>
                            <Button
                              size="micro"
                              variant="plain"
                              tone="critical"
                              onClick={() =>
                                fetcher.submit(
                                  { _action: "deletePayment", id: p.id },
                                  { method: "post" },
                                )
                              }
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  </>
                )}
              </BlockStack>
            </Card>
          ))
        )}
      </BlockStack>

      {/* Worker add/edit modal */}
      {workerModal && (
        <Modal
          open
          onClose={() => setWorkerModal(null)}
          title={workerModal === "new" ? "Add worker" : `Edit ${workerModal.name}`}
          primaryAction={{
            content: "Save",
            onAction: submitWorker,
            loading: fetcher.state !== "idle",
            disabled: !name.trim(),
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setWorkerModal(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField
                  label="Age (optional)"
                  type="number"
                  value={age}
                  onChange={setAge}
                  autoComplete="off"
                  min={0}
                  max={120}
                />
              </InlineGrid>
              <PriceRowsEditor
                label="Monthly salary"
                helpText="What you pay this person per month right now."
                model={salary}
                onChange={setSalary}
                currency={currency}
                today={today}
              />
              <TextField
                label="Note (optional)"
                value={wnote}
                onChange={setWnote}
                autoComplete="off"
                multiline={2}
              />
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      {/* Payment modal */}
      {payFor && (
        <Modal
          open
          onClose={() => setPayFor(null)}
          title={`Bonus / gift for ${payFor.name}`}
          primaryAction={{
            content: "Add",
            onAction: submitPayment,
            loading: fetcher.state !== "idle",
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setPayFor(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TextField
                  label="Amount"
                  type="number"
                  value={pAmount}
                  onChange={setPAmount}
                  autoComplete="off"
                  prefix={currency}
                  min={0}
                  step={0.01}
                />
                <Select label="Type" options={PAYMENT_TYPES} value={pType} onChange={setPType} />
              </InlineGrid>
              <TextField label="Date" type="date" value={pDate} onChange={setPDate} autoComplete="off" />
              <TextField
                label="Note (optional)"
                value={pNote}
                onChange={setPNote}
                autoComplete="off"
                placeholder="e.g. Ahmed did great this month"
                multiline={2}
              />
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
