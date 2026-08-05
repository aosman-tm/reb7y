import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  TextField,
  Select,
  Checkbox,
  Button,
  IndexTable,
  Thumbnail,
  Box,
  Banner,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { parseAmount, formatMoney, round2 } from "../lib/money";
import {
  recordProductCostChange,
  seedCostHistory,
  setProductExtrasTimeline,
  productExtrasHistory,
} from "../lib/costHistory.server";
import {
  fromEditorModel,
  toEditorModel,
  parseEditorModel,
  EARLIEST_DAY,
  type PriceChange,
  type PriceEntry,
} from "../lib/priceTimeline";
import { todayString } from "../lib/dates";
import { PriceRowsEditor } from "../components/PriceRowsEditor";

const PRODUCT_QUERY = `#graphql
  query Reb7yProduct($id: ID!) {
    product(id: $id) {
      id
      title
      featuredImage { url altText }
      variants(first: 1) { edges { node { price } } }
    }
  }`;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const gid = `gid://shopify/Product/${params.id}`;

  const [productResp, productCost, materials, settings, extrasHistory] = await Promise.all([
    admin.graphql(PRODUCT_QUERY, { variables: { id: gid } }),
    prisma.productCost.findUnique({
      where: { shop_productId: { shop: session.shop, productId: gid } },
      include: { bomLines: { include: { material: true } } },
    }),
    prisma.material.findMany({
      where: { shop: session.shop, archived: false },
      orderBy: { name: "asc" },
    }),
    getSettings(session.shop),
    productExtrasHistory(session.shop, gid),
  ]);

  const body: any = await productResp.json();
  const node = body?.data?.product;
  const price = parseFloat(node?.variants?.edges?.[0]?.node?.price ?? "0") || 0;

  const lines = (productCost?.bomLines ?? []).map((l) => ({
    id: l.id,
    materialId: l.materialId,
    name: l.material.name,
    unit: l.material.unit,
    costPerUnit: l.material.costPerUnit,
    quantity: l.quantity,
    countOnReturn: l.countOnReturn,
    lineCost: round2(l.quantity * l.material.costPerUnit),
  }));
  const materialTotal = round2(lines.reduce((s, l) => s + l.lineCost, 0));
  const factoryCost = round2(productCost?.factoryCost ?? 0);
  const otherCost = round2(productCost?.otherCost ?? 0);
  const unitCost = round2(materialTotal + factoryCost + otherCost);

  return {
    product: {
      title: node?.title ?? "Product",
      image: node?.featuredImage?.url ?? null,
      price,
    },
    factoryCost,
    lines,
    materials: materials.map((m) => ({
      id: m.id,
      name: m.name,
      unit: m.unit,
      costPerUnit: m.costPerUnit,
    })),
    otherCost,
    materialTotal,
    unitCost,
    margin: round2(price - unitCost),
    currency: settings.currency,
    today: todayString(),
    // Past factory / other costs, so the edit screen shows the full history.
    factoryHistory: extrasHistory.factory.length
      ? extrasHistory.factory
      : ([{ effectiveFrom: EARLIEST_DAY, amount: factoryCost }] as PriceEntry[]),
    otherHistory: extrasHistory.other.length
      ? extrasHistory.other
      : ([{ effectiveFrom: EARLIEST_DAY, amount: otherCost }] as PriceEntry[]),
    returnDeliveryMode: productCost?.returnDeliveryMode ?? "settings",
    returnDeliveryPercent: round2(productCost?.returnDeliveryPercent ?? 100),
    settingsReturnDeliveryMode: settings.returnDeliveryMode,
    settingsReturnDeliveryPercent: settings.returnDeliveryPercent,
    settingsReturnDeliveryFixed: settings.returnDeliveryFixed,
    hasRecipe: Boolean(productCost),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const gid = `gid://shopify/Product/${params.id}`;
  const form = await request.formData();
  const intent = form.get("_action");

  const ensureProductCost = async (title: string) =>
    prisma.productCost.upsert({
      where: { shop_productId: { shop, productId: gid } },
      create: { shop, productId: gid, title },
      update: { title },
    });

  /**
   * Apply a cost change while keeping the dated history correct.
   *
   * Seeding runs first, on purpose: it records the product's CURRENT cost as
   * its historical baseline, so it has to happen before the new value lands.
   * Without that, past orders would silently adopt the new cost.
   */
  const withHistory = async (
    mutate: () => Promise<void>,
    opts: { change: PriceChange; reason: string },
  ) => {
    await seedCostHistory(shop);
    await mutate();
    await recordProductCostChange({
      shop,
      productId: gid,
      change: opts.change,
      reason: opts.reason,
    });
  };

  /** Recipe edits always count from today; only money amounts ask when. */
  const fromToday = (): PriceChange => ({ mode: "today", amount: 0, today: todayString() });

  if (intent === "addLine") {
    const materialId = String(form.get("materialId") ?? "");
    if (!materialId) return { error: "Pick a material." };
    await withHistory(
      async () => {
        const pc = await ensureProductCost(String(form.get("title") ?? ""));
        await prisma.bomLine.create({
          data: {
            productCostId: pc.id,
            materialId,
            quantity: parseAmount(form.get("quantity"), 1),
          },
        });
      },
      { change: fromToday(), reason: "recipe" },
    );
    return { ok: true };
  }

  if (intent === "saveExtras") {
    const returnDeliveryMode = String(form.get("returnDeliveryMode") ?? "settings");
    const returnDeliveryPercent = parseAmount(form.get("returnDeliveryPercent"), 100);

    // Both costs arrive as full timelines: what they are now, plus any earlier
    // periods where they were different.
    const factoryModel = parseEditorModel(form.get("factory"));
    const otherModel = parseEditorModel(form.get("other"));

    await prisma.productCost.upsert({
      where: { shop_productId: { shop, productId: gid } },
      create: {
        shop,
        productId: gid,
        title: String(form.get("title") ?? ""),
        factoryCost: factoryModel.current,
        otherCost: otherModel.current,
        returnDeliveryMode,
        returnDeliveryPercent,
      },
      update: {
        factoryCost: factoryModel.current,
        otherCost: otherModel.current,
        returnDeliveryMode,
        returnDeliveryPercent,
      },
    });

    await setProductExtrasTimeline({
      shop,
      productId: gid,
      factory: fromEditorModel(factoryModel, EARLIEST_DAY),
      other: fromEditorModel(otherModel, EARLIEST_DAY),
      returnDeliveryMode,
      returnDeliveryPercent,
    });
    return { ok: true };
  }

  // Line update / delete — verify the line belongs to this shop first.
  if (intent === "updateLine" || intent === "deleteLine") {
    const lineId = String(form.get("lineId") ?? "");
    const line = await prisma.bomLine.findUnique({
      where: { id: lineId },
      include: { productCost: true },
    });
    if (!line || line.productCost.shop !== shop) return { error: "Not found." };
    await withHistory(
      async () => {
        if (intent === "updateLine") {
          await prisma.bomLine.update({
            where: { id: lineId },
            data: { quantity: parseAmount(form.get("quantity"), 1) },
          });
        } else {
          await prisma.bomLine.delete({ where: { id: lineId } });
        }
      },
      { change: fromToday(), reason: "recipe" },
    );
    return { ok: true };
  }

  if (intent === "toggleReturnLine") {
    const lineId = String(form.get("lineId") ?? "");
    const line = await prisma.bomLine.findUnique({
      where: { id: lineId },
      include: { productCost: true },
    });
    if (!line || line.productCost.shop !== shop) return { error: "Not found." };
    await withHistory(
      async () => {
        await prisma.bomLine.update({
          where: { id: lineId },
          data: { countOnReturn: form.get("countOnReturn") === "true" },
        });
      },
      { change: fromToday(), reason: "recipe" },
    );
    return { ok: true };
  }

  return { error: "Unknown action." };
};

type Line = {
  id: string;
  name: string;
  unit: string;
  costPerUnit: number;
  quantity: number;
  countOnReturn: boolean;
  lineCost: number;
};

function LineRow({
  line,
  index,
  currency,
}: {
  line: Line;
  index: number;
  currency: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const [qty, setQty] = useState(String(line.quantity));
  const busy = fetcher.state !== "idle";
  const liveCost = round2((parseFloat(qty) || 0) * line.costPerUnit);
  const dirty = qty !== String(line.quantity);

  return (
    <IndexTable.Row id={line.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="medium">
          {line.name}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued">
          {formatMoney(line.costPerUnit, currency)} / {line.unit}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Box maxWidth="120px">
          <InlineStack gap="150" blockAlign="center" wrap={false}>
            <TextField
              label="Qty"
              labelHidden
              type="number"
              value={qty}
              onChange={setQty}
              autoComplete="off"
              min={0}
              step={0.1}
            />
            <Text as="span" tone="subdued">
              {line.unit}
            </Text>
          </InlineStack>
        </Box>
      </IndexTable.Cell>
      <IndexTable.Cell>{formatMoney(liveCost, currency)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Checkbox
          label="Count on return"
          labelHidden
          checked={line.countOnReturn}
          onChange={(checked) =>
            fetcher.submit(
              { _action: "toggleReturnLine", lineId: line.id, countOnReturn: String(checked) },
              { method: "post" },
            )
          }
        />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" align="end" blockAlign="center">
          <Button
            size="slim"
            disabled={!dirty}
            loading={busy}
            onClick={() =>
              fetcher.submit(
                { _action: "updateLine", lineId: line.id, quantity: qty || "0" },
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
              fetcher.submit({ _action: "deleteLine", lineId: line.id }, { method: "post" })
            }
          >
            Remove
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function ProductCostEditor() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const addFetcher = useFetcher<typeof action>();
  const otherFetcher = useFetcher<typeof action>();

  const [materialId, setMaterialId] = useState("");
  const [qty, setQty] = useState("1");
  const [factory, setFactory] = useState(() =>
    toEditorModel(data.factoryHistory, data.today, EARLIEST_DAY),
  );
  const [other, setOther] = useState(() =>
    toEditorModel(data.otherHistory, data.today, EARLIEST_DAY),
  );
  const [returnDeliveryMode, setReturnDeliveryMode] = useState(data.returnDeliveryMode);
  const [returnDeliveryPercent, setReturnDeliveryPercent] = useState(
    String(data.returnDeliveryPercent),
  );

  const saveExtras = () => {
    otherFetcher.submit(
      {
        _action: "saveExtras",
        factory: JSON.stringify(factory),
        other: JSON.stringify(other),
        returnDeliveryMode,
        returnDeliveryPercent: returnDeliveryPercent || "100",
        title: data.product.title,
      },
      { method: "post" },
    );
  };

  const { product, lines, materials, currency } = data;
  const materialOptions = [
    { label: "Select a material…", value: "" },
    ...materials.map((m) => ({
      label: `${m.name} — ${formatMoney(m.costPerUnit, currency)} / ${m.unit}`,
      value: m.id,
    })),
  ];
  const settingsDeliveryLabel =
    data.settingsReturnDeliveryMode === "fixed"
      ? `${formatMoney(data.settingsReturnDeliveryFixed, currency)} fixed`
      : data.settingsReturnDeliveryMode === "percent"
        ? `${data.settingsReturnDeliveryPercent}% of real delivery`
        : "full real delivery";
  const returnDeliveryOptions = [
    { label: `Use settings default (${settingsDeliveryLabel})`, value: "settings" },
    { label: "Charge full real delivery", value: "full" },
    { label: "Charge percentage of real delivery", value: "percent" },
  ];

  return (
    <Page
      backAction={{ content: "Product costs", onAction: () => navigate("/app/products") }}
      title={product.title}
    >
      <TitleBar title="Product recipe" />
      <BlockStack gap="400">
        <Card>
          <InlineStack gap="400" blockAlign="center" align="space-between">
            <InlineStack gap="300" blockAlign="center">
              <Thumbnail source={product.image ?? ""} alt={product.title} size="medium" />
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd">
                  {product.title}
                </Text>
                <Text as="span" tone="subdued">
                  Sells for {formatMoney(product.price, currency)}
                </Text>
              </BlockStack>
            </InlineStack>
            <Box>
              <BlockStack gap="050" inlineAlign="end">
                <Text as="span" tone="subdued" variant="bodySm">
                  Profit per item
                </Text>
                <Text
                  as="span"
                  variant="headingLg"
                  tone={data.margin >= 0 ? "success" : "critical"}
                >
                  {formatMoney(data.margin, currency)}
                </Text>
              </BlockStack>
            </Box>
          </InlineStack>
        </Card>

        {materials.length === 0 && (
          <Banner tone="warning" title="Add materials first">
            <p>
              You have no materials yet. Go to the <b>Materials</b> page to add your parts (box,
              bubble wrap, card…), then come back to build this product's recipe.
            </p>
            <Box paddingBlockStart="200">
              <Button onClick={() => navigate("/app/materials")}>Go to Materials</Button>
            </Box>
          </Banner>
        )}

        <Card padding="0">
          <Box padding="400">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Recipe
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Recipe changes count from today onward. Orders you already made keep the recipe and
                prices they were made with, so your past reports stay the same.
              </Text>
            </BlockStack>
          </Box>
          {lines.length === 0 ? (
            <Box paddingInline="400" paddingBlockEnd="400">
              <Text as="p" tone="subdued">
                No materials in this recipe yet. Add one below.
              </Text>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={lines.length}
              headings={[
                { title: "Material" },
                { title: "Unit cost" },
                { title: "Quantity" },
                { title: "Line cost" },
                { title: "Count on return" },
                { title: "" },
              ]}
            >
              {lines.map((l, i) => (
                <LineRow key={l.id} line={l} index={i} currency={currency} />
              ))}
            </IndexTable>
          )}

          {materials.length > 0 && (
            <Box padding="400" background="bg-surface-secondary">
              <InlineGrid columns={{ xs: 1, sm: "2fr 1fr auto" }} gap="300">
                <Select
                  label="Material"
                  labelHidden
                  options={materialOptions}
                  value={materialId}
                  onChange={setMaterialId}
                />
                <TextField
                  label="Quantity"
                  labelHidden
                  type="number"
                  value={qty}
                  onChange={setQty}
                  autoComplete="off"
                  min={0}
                  step={0.1}
                  placeholder="Qty"
                />
                <Button
                  variant="primary"
                  disabled={!materialId}
                  loading={addFetcher.state !== "idle"}
                  onClick={() => {
                    addFetcher.submit(
                      {
                        _action: "addLine",
                        materialId,
                        quantity: qty || "1",
                        title: product.title,
                      },
                      { method: "post" },
                    );
                    setMaterialId("");
                    setQty("1");
                  }}
                >
                  Add to recipe
                </Button>
              </InlineGrid>
            </Box>
          )}
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h3" variant="headingMd">
              Factory, return &amp; other costs
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              For returned orders, only materials marked "Count on return" above are charged.
            </Text>
            <Select
              label="Returned order delivery (this product)"
              options={returnDeliveryOptions}
              value={returnDeliveryMode}
              onChange={setReturnDeliveryMode}
              helpText="Use settings default, or override this product to charge full delivery or only a percentage."
            />
            {returnDeliveryMode === "percent" && (
              <TextField
                label="Returned delivery percentage for this product"
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
            <PriceRowsEditor
              label="Factory cost per item"
              helpText="Your direct manufacturing/factory cost for this item today."
              model={factory}
              onChange={setFactory}
              currency={currency}
              today={data.today}
            />

            <Divider />

            <PriceRowsEditor
              label="Other cost per item (labour, tape, handling…)"
              helpText="Anything not tracked as a material."
              model={other}
              onChange={setOther}
              currency={currency}
              today={data.today}
            />

            <Box>
              <Button
                variant="primary"
                loading={otherFetcher.state !== "idle"}
                onClick={saveExtras}
              >
                Save costs
              </Button>
            </Box>

            <Divider />

            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text as="span">Materials</Text>
                <Text as="span">{formatMoney(data.materialTotal, currency)}</Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="span">Factory</Text>
                <Text as="span">{formatMoney(data.factoryCost, currency)}</Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="span">Other</Text>
                <Text as="span">{formatMoney(data.otherCost, currency)}</Text>
              </InlineStack>
              <Divider />
              <InlineStack align="space-between">
                <Text as="span" variant="headingMd">
                  Total cost per item
                </Text>
                <Text as="span" variant="headingMd">
                  {formatMoney(data.unitCost, currency)}
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="span" variant="headingMd">
                  Profit per item (vs {formatMoney(product.price, currency)})
                </Text>
                <Text
                  as="span"
                  variant="headingMd"
                  tone={data.margin >= 0 ? "success" : "critical"}
                >
                  {formatMoney(data.margin, currency)}
                </Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
