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
  Checkbox,
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

// Starter zones for Egypt — keywords match Shopify's shipping city/province text.
const EGYPT_STARTER = [
  { name: "Cairo", keywords: "cairo,القاهرة", realCost: 0, isDefault: false },
  {
    name: "Giza",
    keywords: "giza,الجيزة,6th of october,6 october,sheikh zayed",
    realCost: 0,
    isDefault: false,
  },
  { name: "Alexandria", keywords: "alexandria,الاسكندرية,اسكندرية", realCost: 0, isDefault: false },
  {
    name: "Delta",
    keywords:
      "mansoura,tanta,zagazig,damietta,dakahlia,gharbia,menoufia,qalyubia,sharqia,kafr el sheikh,beheira,ismailia,port said,suez",
    realCost: 0,
    isDefault: false,
  },
  {
    name: "Upper Egypt",
    keywords: "aswan,luxor,asyut,sohag,qena,minya,beni suef,fayoum,red sea,hurghada",
    realCost: 0,
    isDefault: false,
  },
  { name: "Other (rest of Egypt)", keywords: "", realCost: 0, isDefault: true },
];

type Zone = {
  id: string;
  name: string;
  keywords: string;
  realCost: number;
  isDefault: boolean;
};

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

function buildZonePresets(zones: Zone[]): ZonePreset[] {
  const map = new Map<string, ZonePreset>();

  for (const starter of EGYPT_STARTER) {
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
  const { session } = await authenticate.admin(request);
  const [zones, settings] = await Promise.all([
    prisma.deliveryZone.findMany({
      where: { shop: session.shop },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    getSettings(session.shop),
  ]);
  return { zones, currency: settings.currency };
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
        data: EGYPT_STARTER.map((z) => ({ shop, ...z })),
      });
    }
    return { ok: true };
  }

  if (intent === "create" || intent === "update") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Zone name is required." };
    const isDefault = form.get("isDefault") === "true";
    const data = {
      name,
      keywords: String(form.get("keywords") ?? "").trim(),
      realCost: parseAmount(form.get("realCost")),
      isDefault,
    };
    if (intent === "create") {
      const created = await prisma.deliveryZone.create({ data: { shop, ...data } });
      if (isDefault) await clearOtherDefaults(shop, created.id);
    } else {
      const id = String(form.get("id"));
      await prisma.deliveryZone.updateMany({ where: { id, shop }, data });
      if (isDefault) await clearOtherDefaults(shop, id);
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
    if (existing) {
      await prisma.deliveryZone.update({ where: { id: existing.id }, data });
      if (isDefault) await clearOtherDefaults(shop, existing.id);
    } else {
      const created = await prisma.deliveryZone.create({ data: { shop, ...data } });
      if (isDefault) await clearOtherDefaults(shop, created.id);
    }
    return { ok: true };
  }

  if (intent === "delete") {
    await prisma.deliveryZone.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

function AddZone({ zones, currency }: { zones: Zone[]; currency: string }) {
  const fetcher = useFetcher<typeof action>();
  const presets = buildZonePresets(zones);
  const [selectedPresetKey, setSelectedPresetKey] = useState("");
  const [cost, setCost] = useState("");
  const busy = fetcher.state !== "idle";
  const selectedPreset = presets.find((p) => p.key === selectedPresetKey) ?? null;
  const zoneOptions = [
    { label: "Select zone…", value: "" },
    ...presets.map((p) => ({ label: p.name, value: p.key })),
  ];

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Add a delivery zone
        </Text>
        <InlineGrid columns={{ xs: 1, sm: "2fr 1fr auto" }} gap="300">
          <Select
            label="Zone"
            options={zoneOptions}
            value={selectedPresetKey}
            onChange={(value) => {
              setSelectedPresetKey(value);
              if (!value) return;
              const selected = presets.find((p) => p.key === value);
              if (!selected) return;
              setCost(String(selected.existingCost ?? 0));
            }}
            helpText="Choose a zone, then set its real courier cost."
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
              disabled={!selectedPreset}
              loading={busy}
              onClick={() => {
                if (!selectedPreset) return;
                fetcher.submit(
                  {
                    _action: "savePrice",
                    name: selectedPreset.name,
                    keywords: selectedPreset.keywords,
                    realCost: cost || "0",
                    isDefault: String(selectedPreset.isDefault),
                  },
                  { method: "post" },
                );
                setSelectedPresetKey("");
                setCost("");
              }}
            >
              Save price
            </Button>
          </Box>
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

function ZoneRow({ zone, index, currency }: { zone: Zone; index: number; currency: string }) {
  const fetcher = useFetcher<typeof action>();
  const [cost, setCost] = useState(String(zone.realCost));
  const [isDefault, setIsDefault] = useState(zone.isDefault);
  const busy = fetcher.state !== "idle";
  const dirty = cost !== String(zone.realCost) || isDefault !== zone.isDefault;

  return (
    <IndexTable.Row id={zone.id} position={index}>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          <Text as="span">{zone.name}</Text>
          {zone.isDefault && <Badge tone="info">Default</Badge>}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Box maxWidth="130px">
          <TextField
            label="Cost"
            labelHidden
            type="number"
            value={cost}
            onChange={setCost}
            autoComplete="off"
            prefix={currency}
            min={0}
            step={0.01}
          />
        </Box>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Checkbox label="Default" labelHidden checked={isDefault} onChange={setIsDefault} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200" align="end" blockAlign="center">
          <Button
            size="slim"
            disabled={!dirty}
            loading={busy}
            onClick={() =>
              fetcher.submit(
                {
                  _action: "update",
                  id: zone.id,
                  name: zone.name,
                  keywords: zone.keywords,
                  realCost: cost || "0",
                  isDefault: String(isDefault),
                },
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
            onClick={() => {
              if (confirm(`Delete zone "${zone.name}"?`)) {
                fetcher.submit({ _action: "delete", id: zone.id }, { method: "post" });
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

export default function DeliveryPage() {
  const { zones, currency } = useLoaderData<typeof loader>();

  return (
    <Page>
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

        <AddZone zones={zones} currency={currency} />

        <Card padding="0">
          {zones.length === 0 ? (
            <Box padding="500">
              <Text as="p" tone="subdued" alignment="center">
                No zones yet.
              </Text>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={zones.length}
              headings={[
                { title: "Zone" },
                { title: "Real cost" },
                { title: "Default" },
                { title: "" },
              ]}
            >
              {zones.map((z, i) => (
                <ZoneRow key={z.id} zone={z} index={i} currency={currency} />
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
