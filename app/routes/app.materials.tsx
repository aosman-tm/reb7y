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
  Button,
  IndexTable,
  Banner,
  Badge,
  Box,
  Modal,
  Tag,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { computeMaterialUsage } from "../lib/profit.server";
import { setMaterialTimeline, allMaterialHistories } from "../lib/costHistory.server";
import { todayString } from "../lib/dates";
import { parseAmount, formatMoney, round2 } from "../lib/money";
import {
  fromEditorModel,
  toEditorModel,
  parseEditorModel,
  EARLIEST_DAY,
} from "../lib/priceTimeline";
import { MaterialFormModal, type MaterialDraft } from "../components/MaterialFormModal";

const BUILT_IN_UNITS = ["piece", "cm", "meter", "gram", "kg", "ml", "liter", "roll", "sheet"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [materials, settings, customUnits, histories] = await Promise.all([
    prisma.material.findMany({ where: { shop, archived: false }, orderBy: { name: "asc" } }),
    getSettings(shop),
    prisma.customUnit.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    allMaterialHistories(shop),
  ]);

  // Consumption from delivered orders (last 12 months). Fails quietly if the
  // app can't read orders yet — the rest of the page still works.
  let usage = new Map<string, number>();
  try {
    usage = await computeMaterialUsage(admin, shop);
  } catch {
    usage = new Map();
  }

  const list = materials.map((m) => {
    const used = round2(usage.get(m.id) ?? 0);
    const remaining = round2(m.stock - used);
    return {
      id: m.id,
      name: m.name,
      unit: m.unit,
      costPerUnit: m.costPerUnit,
      stock: m.stock,
      lowStockThreshold: m.lowStockThreshold,
      used,
      remaining,
      low: m.lowStockThreshold > 0 && remaining <= m.lowStockThreshold,
      // Past prices, so the edit screen can preview the result of a change.
      history: histories[m.id] ?? [{ effectiveFrom: EARLIEST_DAY, amount: m.costPerUnit }],
    };
  });

  const units = [...BUILT_IN_UNITS, ...customUnits.map((u) => u.name)];
  return {
    materials: list,
    customUnits,
    units,
    currency: settings.currency,
    today: todayString(),
    ordersReadable: usage.size >= 0,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");

  if (intent === "create" || intent === "update") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Name is required." };

    // The form carries the whole price timeline the merchant sees: what it
    // costs now, plus any earlier periods where it was different.
    const model = parseEditorModel(form.get("price"));
    const entries = fromEditorModel(model, EARLIEST_DAY);
    const data = { name, unit: String(form.get("unit") ?? "piece"), costPerUnit: model.current };

    if (intent === "create") {
      const created = await prisma.material.create({
        data: { shop, ...data, stock: parseAmount(form.get("stock")) },
      });
      await setMaterialTimeline({ shop, materialId: created.id, entries });
      return { ok: true };
    }

    const id = String(form.get("id"));
    const existing = await prisma.material.findFirst({ where: { id, shop } });
    if (!existing) return { error: "Material not found." };

    await prisma.material.updateMany({ where: { id, shop }, data });
    await setMaterialTimeline({ shop, materialId: id, entries });
    return { ok: true };
  }

  if (intent === "restock") {
    const id = String(form.get("id"));
    const add = parseAmount(form.get("amount"));
    await prisma.material.updateMany({
      where: { id, shop },
      data: {
        stock: { increment: add },
        lowStockThreshold: parseAmount(form.get("threshold")),
      },
    });
    return { ok: true };
  }

  if (intent === "delete") {
    const id = String(form.get("id"));
    try {
      await prisma.material.deleteMany({ where: { id, shop } });
    } catch {
      await prisma.material.updateMany({ where: { id, shop }, data: { archived: true } });
    }
    return { ok: true };
  }

  if (intent === "addUnit") {
    const name = String(form.get("name") ?? "").trim().toLowerCase();
    if (name) {
      await prisma.customUnit.upsert({
        where: { shop_name: { shop, name } },
        create: { shop, name },
        update: {},
      });
    }
    return { ok: true };
  }

  if (intent === "deleteUnit") {
    await prisma.customUnit.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

function UnitManager({
  units,
  customUnits,
}: {
  units: string[];
  customUnits: { id: string; name: string }[];
}) {
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState("");

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          Units
        </Text>
        <InlineStack gap="150" wrap>
          {BUILT_IN_UNITS.map((u) => (
            <Tag key={u}>{u}</Tag>
          ))}
          {customUnits.map((u) => (
            <Tag
              key={u.id}
              onRemove={() =>
                fetcher.submit({ _action: "deleteUnit", id: u.id }, { method: "post" })
              }
            >
              {u.name}
            </Tag>
          ))}
        </InlineStack>
        <InlineStack gap="200" blockAlign="end">
          <Box minWidth="200px">
            <TextField
              label="Add a custom unit"
              value={name}
              onChange={setName}
              autoComplete="off"
              placeholder="e.g. dozen, bag, roll"
            />
          </Box>
          <Button
            onClick={() => {
              if (name.trim()) {
                fetcher.submit({ _action: "addUnit", name }, { method: "post" });
                setName("");
              }
            }}
          >
            Add unit
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

type MaterialItem = {
  id: string;
  name: string;
  unit: string;
  costPerUnit: number;
  stock: number;
  lowStockThreshold: number;
  used: number;
  remaining: number;
  low: boolean;
  history: { effectiveFrom: string; amount: number }[];
};

/** One material in the list: current cost only. Its history lives in the edit modal. */
function MaterialRow({
  material,
  index,
  currency,
  onEdit,
  onRestock,
  onDelete,
}: {
  material: MaterialItem;
  index: number;
  currency: string;
  onEdit: (m: MaterialItem) => void;
  onRestock: (m: MaterialItem) => void;
  onDelete: (m: MaterialItem) => void;
}) {
  // More than one recorded price means this material has a past worth showing.
  const periodCount = Math.max(0, material.history.length - 1);

  return (
    <IndexTable.Row id={material.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" fontWeight="semibold">
          {material.name}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">
          {material.unit}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" fontWeight="semibold">
            {formatMoney(material.costPerUnit, currency)}
          </Text>
          {periodCount > 0 && (
            <Badge tone="info" size="small">
              {periodCount === 1 ? "1 earlier price" : `${periodCount} earlier prices`}
            </Badge>
          )}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <InlineStack gap="150" blockAlign="center">
            <Text as="span" fontWeight="semibold">
              {round2(material.remaining)} {material.unit}
            </Text>
            {material.low && (
              <Badge tone="critical" size="small">
                Low
              </Badge>
            )}
          </InlineStack>
          <Text as="span" tone="subdued" variant="bodySm">
            bought {round2(material.stock)} · used {round2(material.used)}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" align="end" blockAlign="center">
          <Button size="slim" onClick={() => onEdit(material)}>
            Edit
          </Button>
          <Button size="slim" onClick={() => onRestock(material)}>
            Restock
          </Button>
          <Button size="slim" variant="plain" tone="critical" onClick={() => onDelete(material)}>
            Delete
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function MaterialsPage() {
  const { materials, customUnits, units, currency, today } = useLoaderData<typeof loader>();
  const restockFetcher = useFetcher<typeof action>();

  const saveFetcher = useFetcher<typeof action>();
  const [draft, setDraft] = useState<MaterialDraft | null>(null);
  const [restock, setRestock] = useState<MaterialItem | null>(null);
  const [addQty, setAddQty] = useState("");
  const [threshold, setThreshold] = useState("");

  const openAdd = () =>
    setDraft({
      id: null,
      name: "",
      unit: "piece",
      stock: "",
      price: { current: 0, periods: [] },
    });

  const openEdit = (m: MaterialItem) =>
    setDraft({
      id: m.id,
      name: m.name,
      unit: m.unit,
      stock: String(m.stock),
      // Show every price ever recorded, not just today's.
      price: toEditorModel(m.history, today, EARLIEST_DAY),
    });

  const saveDraft = () => {
    if (!draft) return;
    saveFetcher.submit(
      {
        _action: draft.id ? "update" : "create",
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        unit: draft.unit,
        stock: draft.stock || "0",
        price: JSON.stringify(draft.price),
      },
      { method: "post" },
    );
    setDraft(null);
  };

  const deleteMaterial = (m: MaterialItem) => {
    if (confirm(`Delete "${m.name}"?`)) {
      saveFetcher.submit({ _action: "delete", id: m.id }, { method: "post" });
    }
  };

  const openRestock = (m: MaterialItem) => {
    setRestock(m);
    setAddQty("");
    setThreshold(String(m.lowStockThreshold || ""));
  };

  const submitRestock = () => {
    if (!restock) return;
    restockFetcher.submit(
      { _action: "restock", id: restock.id, amount: addQty || "0", threshold: threshold || "0" },
      { method: "post" },
    );
    setRestock(null);
  };

  return (
    <Page
      primaryAction={{ content: "Add material", onAction: openAdd }}
    >
      <TitleBar title="Materials" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            List every part you buy and what one unit costs. Set a <b>stock</b> level and the app
            subtracts what your delivered orders use (last 12 months), so you can see what's left and
            get a <b>Low</b> warning. Combine materials into products on the <b>Product costs</b>{" "}
            page.
          </p>
        </Banner>

        <UnitManager units={units} customUnits={customUnits} />

        <Card padding="0">
          {materials.length === 0 ? (
            <Box padding="500">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="p" tone="subdued" alignment="center">
                  No materials yet.
                </Text>
                <Button variant="primary" onClick={openAdd}>
                  Add material
                </Button>
              </BlockStack>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={materials.length}
              headings={[
                { title: "Material" },
                { title: "Unit" },
                { title: `Cost / unit (${currency})` },
                { title: "In stock" },
                { title: "" },
              ]}
            >
              {materials.map((m, i) => (
                <MaterialRow
                  key={m.id}
                  material={m}
                  index={i}
                  currency={currency}
                  onEdit={openEdit}
                  onRestock={openRestock}
                  onDelete={deleteMaterial}
                />
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      {draft && (
        <MaterialFormModal
          draft={draft}
          units={units}
          currency={currency}
          today={today}
          busy={saveFetcher.state !== "idle"}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={saveDraft}
        />
      )}

      {restock && (
        <Modal
          open
          onClose={() => setRestock(null)}
          title={`Restock ${restock.name}`}
          primaryAction={{
            content: "Add stock",
            onAction: submitRestock,
            loading: restockFetcher.state !== "idle",
          }}
          secondaryActions={[{ content: "Cancel", onAction: () => setRestock(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p" tone="subdued">
                Currently {round2(restock.remaining)} {restock.unit} left (bought{" "}
                {round2(restock.stock)}, used {round2(restock.used)}).
              </Text>
              <TextField
                label={`How many ${restock.unit} did you buy?`}
                type="number"
                value={addQty}
                onChange={setAddQty}
                autoComplete="off"
                min={0}
                step={1}
              />
              <TextField
                label="Warn me when remaining drops to"
                type="number"
                value={threshold}
                onChange={setThreshold}
                autoComplete="off"
                suffix={restock.unit}
                min={0}
                step={1}
                helpText="0 = no warning."
              />
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
