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
  Select,
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
import { parseAmount, formatMoney, round2 } from "../lib/money";

const BUILT_IN_UNITS = ["piece", "cm", "meter", "gram", "kg", "ml", "liter", "roll", "sheet"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [materials, settings, customUnits] = await Promise.all([
    prisma.material.findMany({ where: { shop, archived: false }, orderBy: { name: "asc" } }),
    getSettings(shop),
    prisma.customUnit.findMany({ where: { shop }, orderBy: { name: "asc" } }),
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
    };
  });

  const units = [...BUILT_IN_UNITS, ...customUnits.map((u) => u.name)];
  return {
    materials: list,
    customUnits,
    units,
    currency: settings.currency,
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
    const data = {
      name,
      unit: String(form.get("unit") ?? "piece"),
      costPerUnit: parseAmount(form.get("costPerUnit")),
    };
    if (intent === "create") {
      await prisma.material.create({
        data: { shop, ...data, stock: parseAmount(form.get("stock")) },
      });
    } else {
      await prisma.material.updateMany({ where: { id: String(form.get("id")), shop }, data });
    }
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

function AddMaterial({ units }: { units: string[] }) {
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("piece");
  const [cost, setCost] = useState("");
  const [stock, setStock] = useState("");
  const busy = fetcher.state !== "idle";

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Add a material
        </Text>
        <InlineGrid columns={{ xs: 1, sm: "2fr 1fr 1fr 1fr auto" }} gap="300">
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            autoComplete="off"
            placeholder="e.g. Small box"
          />
          <Select
            label="Unit"
            options={units.map((u) => ({ label: u, value: u }))}
            value={unit}
            onChange={setUnit}
          />
          <TextField
            label="Cost per unit"
            type="number"
            value={cost}
            onChange={setCost}
            autoComplete="off"
            prefix="EGP"
            min={0}
            step={0.01}
          />
          <TextField
            label="Starting stock"
            type="number"
            value={stock}
            onChange={setStock}
            autoComplete="off"
            min={0}
            step={1}
            placeholder="0"
          />
          <Box paddingBlockStart="600">
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={busy}
              onClick={() => {
                fetcher.submit(
                  { _action: "create", name, unit, costPerUnit: cost || "0", stock: stock || "0" },
                  { method: "post" },
                );
                setName("");
                setCost("");
                setStock("");
                setUnit("piece");
              }}
            >
              Add
            </Button>
          </Box>
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

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
};

function MaterialRow({
  material,
  index,
  units,
  currency,
  onRestock,
}: {
  material: MaterialItem;
  index: number;
  units: string[];
  currency: string;
  onRestock: (m: MaterialItem) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState(material.name);
  const [unit, setUnit] = useState(material.unit);
  const [cost, setCost] = useState(String(material.costPerUnit));
  const busy = fetcher.state !== "idle";
  const dirty =
    name !== material.name || unit !== material.unit || cost !== String(material.costPerUnit);
  const unitOptions = units.map((u) => ({ label: u, value: u }));
  if (!units.includes(unit)) unitOptions.unshift({ label: unit, value: unit });

  return (
    <IndexTable.Row id={material.id} position={index}>
      <IndexTable.Cell>
        <TextField label="Name" labelHidden value={name} onChange={setName} autoComplete="off" />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Select label="Unit" labelHidden options={unitOptions} value={unit} onChange={setUnit} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Box maxWidth="120px">
          <TextField
            label="Cost"
            labelHidden
            type="number"
            value={cost}
            onChange={setCost}
            autoComplete="off"
            prefix="EGP"
            min={0}
            step={0.01}
          />
        </Box>
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
          <Button
            size="slim"
            disabled={!dirty}
            loading={busy}
            onClick={() =>
              fetcher.submit(
                { _action: "update", id: material.id, name, unit, costPerUnit: cost || "0" },
                { method: "post" },
              )
            }
          >
            Save
          </Button>
          <Button size="slim" onClick={() => onRestock(material)}>
            Restock
          </Button>
          <Button
            size="slim"
            variant="plain"
            tone="critical"
            onClick={() => {
              if (confirm(`Delete "${material.name}"?`)) {
                fetcher.submit({ _action: "delete", id: material.id }, { method: "post" });
              }
            }}
          >
            Delete
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function MaterialsPage() {
  const { materials, customUnits, units, currency } = useLoaderData<typeof loader>();
  const restockFetcher = useFetcher<typeof action>();

  const [restock, setRestock] = useState<MaterialItem | null>(null);
  const [addQty, setAddQty] = useState("");
  const [threshold, setThreshold] = useState("");

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
    <Page>
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

        <AddMaterial units={units} />
        <UnitManager units={units} customUnits={customUnits} />

        <Card padding="0">
          {materials.length === 0 ? (
            <Box padding="500">
              <Text as="p" tone="subdued" alignment="center">
                No materials yet. Add your first one above.
              </Text>
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
                  units={units}
                  currency={currency}
                  onRestock={openRestock}
                />
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

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
