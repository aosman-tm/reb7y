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
  Badge,
  Banner,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../lib/settings.server";
import { parseAmount } from "../lib/money";
import { fetchShopifyDeliveryZones, type ShopifyZonePreset } from "../lib/shipping.server";
import {
  setZoneTimeline,
  recordZonePrice,
  allZoneHistories,
} from "../lib/costHistory.server";
import { todayString } from "../lib/dates";
import {
  fromEditorModel,
  toEditorModel,
  parseEditorModel,
  EARLIEST_DAY,
  type PriceEntry,
} from "../lib/priceTimeline";
import { ZoneFormModal, type ZoneDraft } from "../components/ZoneFormModal";

// Fallback zones for Egypt, used only when Shopify's own shipping zones can't be
// read (missing `read_shipping` scope, or none configured yet). Keywords match
// Shopify's shipping city/province text.
const EGYPT_STARTER: ShopifyZonePreset[] = [
  { name: "Cairo", keywords: "cairo,القاهرة", isDefault: false },
  {
    name: "Giza",
    keywords: "giza,الجيزة,6th of october,6 october,sheikh zayed",
    isDefault: false,
  },
  { name: "Alexandria", keywords: "alexandria,الاسكندرية,اسكندرية", isDefault: false },
  {
    name: "Delta",
    keywords:
      "mansoura,tanta,zagazig,damietta,dakahlia,gharbia,menoufia,qalyubia,sharqia,kafr el sheikh,beheira,ismailia,port said,suez",
    isDefault: false,
  },
  {
    name: "Upper Egypt",
    keywords: "aswan,luxor,asyut,sohag,qena,minya,beni suef,fayoum,red sea,hurghada",
    isDefault: false,
  },
  { name: "Other (rest of Egypt)", keywords: "", isDefault: true },
];

const CUSTOM_ZONE_KEY = "__custom__";

type Zone = {
  id: string;
  name: string;
  keywords: string;
  realCost: number;
  isDefault: boolean;
};

type ZoneWithHistory = Zone & { history: PriceEntry[] };

type ZonePreset = {
  key: string;
  name: string;
  keywords: string;
  isDefault: boolean;
  existingId: string | null;
  existingCost: number | null;
};

function normalizeZoneKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Merge zones read live from Shopify (or the fallback list) with prices already saved in the app. */
function buildZonePresets(zones: Zone[], shopifyZones: ShopifyZonePreset[]): ZonePreset[] {
  const map = new Map<string, ZonePreset>();
  const source = shopifyZones.length > 0 ? shopifyZones : EGYPT_STARTER;

  for (const starter of source) {
    const key = normalizeZoneKey(starter.name);
    map.set(key, {
      key,
      name: starter.name,
      keywords: starter.keywords,
      isDefault: starter.isDefault,
      existingId: null,
      existingCost: null,
    });
  }

  for (const zone of zones) {
    const key = normalizeZoneKey(zone.name);
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        name: zone.name,
        keywords: zone.keywords || existing.keywords,
        isDefault: zone.isDefault || existing.isDefault,
        existingId: zone.id,
        existingCost: zone.realCost,
      });
      continue;
    }

    map.set(key, {
      key,
      name: zone.name,
      keywords: zone.keywords,
      isDefault: zone.isDefault,
      existingId: zone.id,
      existingCost: zone.realCost,
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.isDefault === b.isDefault) return a.name.localeCompare(b.name);
    return a.isDefault ? -1 : 1;
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [zones, settings, shopifyZonesResult, histories] = await Promise.all([
    prisma.deliveryZone.findMany({
      where: { shop: session.shop },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    getSettings(session.shop),
    fetchShopifyDeliveryZones(admin),
    allZoneHistories(session.shop),
  ]);
  return {
    zones: zones.map((z) => ({
      ...z,
      // Past costs, so the edit screen can preview the result of a change.
      history: histories[z.id] ?? [{ effectiveFrom: EARLIEST_DAY, amount: z.realCost }],
    })),
    currency: settings.currency,
    today: todayString(),
    shopifyZones: shopifyZonesResult.zones,
    shopifyZonesError: shopifyZonesResult.error,
  };
};

async function clearOtherDefaults(shop: string, keepId?: string) {
  await prisma.deliveryZone.updateMany({
    where: { shop, isDefault: true, ...(keepId ? { id: { not: keepId } } : {}) },
    data: { isDefault: false },
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("_action");

  if (intent === "seed") {
    const count = await prisma.deliveryZone.count({ where: { shop } });
    if (count === 0) {
      await prisma.deliveryZone.createMany({
        data: EGYPT_STARTER.map((z) => ({ shop, name: z.name, keywords: z.keywords, isDefault: z.isDefault, realCost: 0 })),
      });
    }
    return { ok: true };
  }

  if (intent === "create" || intent === "update") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Zone name is required." };
    const isDefault = form.get("isDefault") === "true";
    // The form carries the whole cost timeline: what the courier charges now,
    // plus any earlier periods where it was different.
    const model = parseEditorModel(form.get("price"));
    const entries = fromEditorModel(model, EARLIEST_DAY);
    const data = {
      name,
      keywords: String(form.get("keywords") ?? "").trim(),
      realCost: model.current,
      isDefault,
    };
    if (intent === "create") {
      const created = await prisma.deliveryZone.create({ data: { shop, ...data } });
      if (isDefault) await clearOtherDefaults(shop, created.id);
      await setZoneTimeline({ shop, zoneId: created.id, entries });
    } else {
      const id = String(form.get("id"));
      await prisma.deliveryZone.updateMany({ where: { id, shop }, data });
      if (isDefault) await clearOtherDefaults(shop, id);
      await setZoneTimeline({ shop, zoneId: id, entries });
    }
    return { ok: true };
  }

  if (intent === "savePrice") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Zone is required." };
    const isDefault = form.get("isDefault") === "true";
    const data = {
      name,
      keywords: String(form.get("keywords") ?? "").trim(),
      realCost: parseAmount(form.get("realCost")),
      isDefault,
    };

    const existing = await prisma.deliveryZone.findFirst({ where: { shop, name } });
    const entries = fromEditorModel(
      { current: data.realCost, periods: [] },
      EARLIEST_DAY,
    );
    if (existing) {
      await prisma.deliveryZone.update({ where: { id: existing.id }, data });
      if (isDefault) await clearOtherDefaults(shop, existing.id);
      // Quick price entry only sets today's cost; earlier periods are edited
      // on the zone itself, so merge rather than replace.
      await recordZonePrice({
        shop,
        zoneId: existing.id,
        change: { mode: "today", amount: data.realCost, today: todayString() },
      });
    } else {
      const created = await prisma.deliveryZone.create({ data: { shop, ...data } });
      if (isDefault) await clearOtherDefaults(shop, created.id);
      await setZoneTimeline({ shop, zoneId: created.id, entries });
    }
    return { ok: true };
  }

  if (intent === "delete") {
    await prisma.deliveryZone.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

function AddZone({
  zones,
  currency,
  shopifyZones,
  usingLiveZones,
}: {
  zones: Zone[];
  currency: string;
  shopifyZones: ShopifyZonePreset[];
  usingLiveZones: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const presets = buildZonePresets(zones, shopifyZones);
  const [selectedPresetKey, setSelectedPresetKey] = useState("");
  const [customName, setCustomName] = useState("");
  const [cost, setCost] = useState("");
  const busy = fetcher.state !== "idle";
  const isCustom = selectedPresetKey === CUSTOM_ZONE_KEY;
  const selectedPreset = presets.find((p) => p.key === selectedPresetKey) ?? null;
  const zoneOptions = [
    { label: "Select zone…", value: "" },
    ...presets.map((p) => ({ label: p.name, value: p.key })),
    { label: "Custom zone (type name)…", value: CUSTOM_ZONE_KEY },
  ];
  const readyName = isCustom ? customName.trim() : (selectedPreset?.name ?? "");
  const canSave = isCustom ? readyName.length > 0 : Boolean(selectedPreset);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Add a delivery zone please
        </Text>
        <InlineGrid columns={{ xs: 1, sm: "2fr 1fr auto" }} gap="300">
          <Select
            label="Zone"
            options={zoneOptions}
            value={selectedPresetKey}
            onChange={(value) => {
              setSelectedPresetKey(value);
              setCustomName("");
              if (!value || value === CUSTOM_ZONE_KEY) {
                setCost("0");
                return;
              }
              const selected = presets.find((p) => p.key === value);
              if (!selected) return;
              setCost(String(selected.existingCost ?? 0));
            }}
            helpText={
              usingLiveZones
                ? "Pulled live from your Shopify shipping zones. Pick Custom to type an exact name instead."
                : "We couldn't read your Shopify shipping zones yet, so this list is a starting point — pick Custom to type the exact zone name from Shopify."
            }
          />
          <TextField
            label="Real cost"
            type="number"
            value={cost}
            onChange={setCost}
            autoComplete="off"
            prefix={currency}
            min={0}
            step={0.01}
          />
          <Box paddingBlockStart="600">
            <Button
              variant="primary"
              disabled={!canSave}
              loading={busy}
              onClick={() => {
                if (!canSave) return;
                fetcher.submit(
                  {
                    _action: "savePrice",
                    name: readyName,
                    keywords: isCustom ? "" : (selectedPreset?.keywords ?? ""),
                    realCost: cost || "0",
                    isDefault: isCustom ? "false" : String(selectedPreset?.isDefault ?? false),
                  },
                  { method: "post" },
                );
                setSelectedPresetKey("");
                setCustomName("");
                setCost("");
              }}
            >
              Save price
            </Button>
          </Box>
        </InlineGrid>
        {isCustom && (
          <TextField
            label="Zone name"
            value={customName}
            onChange={setCustomName}
            autoComplete="off"
            placeholder="Type the exact zone name from your Shopify shipping settings"
          />
        )}
      </BlockStack>
    </Card>
  );
}


/** One zone in the list: current cost only. Its history lives in the edit modal. */
function ZoneRow({
  zone,
  index,
  currency,
  onEdit,
  onDelete,
}: {
  zone: ZoneWithHistory;
  index: number;
  currency: string;
  onEdit: (z: ZoneWithHistory) => void;
  onDelete: (z: ZoneWithHistory) => void;
}) {
  const periodCount = Math.max(0, zone.history.length - 1);

  return (
    <IndexTable.Row id={zone.id} position={index}>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" fontWeight="semibold">
            {zone.name}
          </Text>
          {zone.isDefault && <Badge tone="info">Default</Badge>}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" fontWeight="semibold">
            {zone.realCost} {currency}
          </Text>
          {periodCount > 0 && (
            <Badge tone="info" size="small">
              {periodCount === 1 ? "1 earlier cost" : `${periodCount} earlier costs`}
            </Badge>
          )}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued" variant="bodySm">
          {zone.keywords || "—"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" align="end" blockAlign="center">
          <Button size="slim" onClick={() => onEdit(zone)}>
            Edit
          </Button>
          <Button size="slim" variant="plain" tone="critical" onClick={() => onDelete(zone)}>
            Delete
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function DeliveryPage() {
  const { zones, currency, shopifyZones, shopifyZonesError, today } = useLoaderData<typeof loader>();
  const usingLiveZones = shopifyZones.length > 0;
  const saveFetcher = useFetcher<typeof action>();
  const [draft, setDraft] = useState<ZoneDraft | null>(null);

  const openAdd = () =>
    setDraft({
      id: null,
      name: "",
      keywords: "",
      isDefault: false,
      price: { current: 0, periods: [] },
    });

  const openEdit = (z: ZoneWithHistory) =>
    setDraft({
      id: z.id,
      name: z.name,
      keywords: z.keywords,
      isDefault: z.isDefault,
      // Show every cost ever recorded, not just today's.
      price: toEditorModel(z.history, today, EARLIEST_DAY),
    });

  const saveDraft = () => {
    if (!draft) return;
    saveFetcher.submit(
      {
        _action: draft.id ? "update" : "create",
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        keywords: draft.keywords,
        isDefault: String(draft.isDefault),
        price: JSON.stringify(draft.price),
      },
      { method: "post" },
    );
    setDraft(null);
  };

  const deleteZone = (z: ZoneWithHistory) => {
    if (confirm(`Delete zone "${z.name}"?`)) {
      saveFetcher.submit({ _action: "delete", id: z.id }, { method: "post" });
    }
  };

  return (
    <Page primaryAction={{ content: "Add zone", onAction: openAdd }}>
      <TitleBar title="Delivery zones" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            Set the <b>real courier cost</b> (what the express company charges you) per area. The
            app matches each order to a zone by its shipping city/governorate and uses that as the
            real delivery cost — you can still override any single order on the Orders page. Mark one
            zone as <b>Default</b> to catch anything that doesn't match.
          </p>
        </Banner>

        {!usingLiveZones && (
          <Banner tone="warning">
            <p>
              We couldn't read the shipping zones from your Shopify admin
              {shopifyZonesError ? ` (${shopifyZonesError})` : ""}. This usually means the app needs
              to be reinstalled to grant the new shipping permission. In the meantime, pick{" "}
              <b>Custom zone</b> below and type the exact zone name from Shopify's{" "}
              <b>Settings → Shipping and delivery</b> page.
            </p>
          </Banner>
        )}

        <AddZone
          zones={zones}
          currency={currency}
          shopifyZones={shopifyZones}
          usingLiveZones={usingLiveZones}
        />

        <Card padding="0">
          {zones.length === 0 ? (
            <Box padding="500">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="p" tone="subdued" alignment="center">
                  No zones yet.
                </Text>
                <Button variant="primary" onClick={openAdd}>
                  Add zone
                </Button>
              </BlockStack>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={zones.length}
              headings={[
                { title: "Zone" },
                { title: "Real cost now" },
                { title: "Matches" },
                { title: "" },
              ]}
            >
              {zones.map((z, i) => (
                <ZoneRow
                  key={z.id}
                  zone={z}
                  index={i}
                  currency={currency}
                  onEdit={openEdit}
                  onDelete={deleteZone}
                />
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      {draft && (
        <ZoneFormModal
          draft={draft}
          currency={currency}
          today={today}
          busy={saveFetcher.state !== "idle"}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={saveDraft}
        />
      )}
    </Page>
  );
}
