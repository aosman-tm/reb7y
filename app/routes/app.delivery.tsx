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
import { parseAmount, formatMoney } from "../lib/money";

type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const ADDRESS_ZONES_QUERY = `#graphql
  query Reb7yDeliveryAddressZones($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          shippingAddress {
            city
            province
          }
        }
      }
    }
  }`;

function normalizeZoneLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

async function loadShopifyAddressZones(admin: GraphqlClient): Promise<string[]> {
  try {
    const response = await admin.graphql(ADDRESS_ZONES_QUERY, { variables: { first: 250 } });
    const body: any = await response.json();
    const edges: any[] = body?.data?.orders?.edges ?? [];
    const labels = new Set<string>();

    for (const edge of edges) {
      const city = normalizeZoneLabel(String(edge?.node?.shippingAddress?.city ?? ""));
      const province = normalizeZoneLabel(String(edge?.node?.shippingAddress?.province ?? ""));
      if (province) labels.add(province);
      if (city) labels.add(city);
    }

    return Array.from(labels).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [zones, settings, suggestedZones] = await Promise.all([
    prisma.deliveryZone.findMany({
      where: { shop: session.shop },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    getSettings(session.shop),
    loadShopifyAddressZones(admin),
  ]);
  return { zones, currency: settings.currency, suggestedZones };
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

  if (intent === "delete") {
    await prisma.deliveryZone.deleteMany({ where: { id: String(form.get("id")), shop } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

function AddZone({ suggestedZones, currency }: { suggestedZones: string[]; currency: string }) {
  const fetcher = useFetcher<typeof action>();
  const [suggestedName, setSuggestedName] = useState("");
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [cost, setCost] = useState("");
  const busy = fetcher.state !== "idle";
  const zoneOptions = [
    { label: "Choose from Shopify addresses…", value: "" },
    ...suggestedZones.map((z) => ({ label: z, value: z })),
  ];

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Add a delivery zone
        </Text>
        <InlineGrid columns={{ xs: 1, sm: "1.5fr 1.5fr 2fr 1fr auto" }} gap="300">
          <Select
            label="Shopify zone"
            options={zoneOptions}
            value={suggestedName}
            onChange={(value) => {
              setSuggestedName(value);
              if (!value) return;
              setName(value);
              if (!keywords.trim()) setKeywords(value.toLowerCase());
            }}
            helpText="Pick a city/governorate already used in Shopify orders."
          />
          <TextField
            label="Zone name"
            value={name}
            onChange={setName}
            autoComplete="off"
            placeholder="e.g. Cairo"
          />
          <TextField
            label="Match keywords (comma separated)"
            value={keywords}
            onChange={setKeywords}
            autoComplete="off"
            placeholder="cairo, nasr city, maadi"
            helpText="Matched against the order's city/governorate."
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
              disabled={!name.trim()}
              loading={busy}
              onClick={() => {
                fetcher.submit(
                  { _action: "create", name, keywords, realCost: cost || "0", isDefault: "false" },
                  { method: "post" },
                );
                setSuggestedName("");
                setName("");
                setKeywords("");
                setCost("");
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

type Zone = {
  id: string;
  name: string;
  keywords: string;
  realCost: number;
  isDefault: boolean;
};

function ZoneRow({ zone, index, currency }: { zone: Zone; index: number; currency: string }) {
  const fetcher = useFetcher<typeof action>();
  const [name, setName] = useState(zone.name);
  const [keywords, setKeywords] = useState(zone.keywords);
  const [cost, setCost] = useState(String(zone.realCost));
  const [isDefault, setIsDefault] = useState(zone.isDefault);
  const busy = fetcher.state !== "idle";
  const dirty =
    name !== zone.name ||
    keywords !== zone.keywords ||
    cost !== String(zone.realCost) ||
    isDefault !== zone.isDefault;

  return (
    <IndexTable.Row id={zone.id} position={index}>
      <IndexTable.Cell>
        <InlineStack gap="200" blockAlign="center">
          <TextField label="Name" labelHidden value={name} onChange={setName} autoComplete="off" />
          {zone.isDefault && <Badge tone="info">Default</Badge>}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <TextField
          label="Keywords"
          labelHidden
          value={keywords}
          onChange={setKeywords}
          autoComplete="off"
          placeholder="(fallback for unmatched)"
        />
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
                  name,
                  keywords,
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
  const { zones, currency, suggestedZones } = useLoaderData<typeof loader>();
  const seedFetcher = useFetcher<typeof action>();

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

        {zones.length === 0 && (
          <Card>
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span">New to this? Add a starter set of Egypt zones to fill in.</Text>
              <Button
                loading={seedFetcher.state !== "idle"}
                onClick={() => seedFetcher.submit({ _action: "seed" }, { method: "post" })}
              >
                Add Egypt starter zones
              </Button>
            </InlineStack>
          </Card>
        )}

        <AddZone suggestedZones={suggestedZones} currency={currency} />

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
                { title: "Keywords" },
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
