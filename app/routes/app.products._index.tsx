import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  Text,
  Badge,
  Thumbnail,
  TextField,
  Box,
  BlockStack,
  Banner,
  Button,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { loadCostMap } from "../lib/profit.server";
import { getSettings } from "../lib/settings.server";
import { formatMoney, round2 } from "../lib/money";

const PRODUCTS_QUERY = `#graphql
  query Reb7yProducts($first: Int!, $query: String) {
    products(first: $first, query: $query, sortKey: TITLE) {
      edges {
        node {
          id
          title
          status
          totalInventory
          featuredImage { url altText }
          variants(first: 1) { edges { node { price } } }
        }
      }
      pageInfo { hasNextPage }
    }
  }`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: { first: 100, query: q ? `title:*${q}*` : null },
  });
  const body: any = await response.json();
  const costMap = await loadCostMap(session.shop);
  const settings = await getSettings(session.shop);

  const products = ((body?.data?.products?.edges ?? []) as any[]).map((edge: any) => {
    const node = edge.node;
    const price = parseFloat(node.variants?.edges?.[0]?.node?.price ?? "0") || 0;
    const cost = costMap.get(node.id);
    const unitCost = cost?.unitCost ?? null;
    return {
      id: node.id,
      numericId: String(node.id).split("/").pop(),
      title: node.title,
      status: node.status,
      image: node.featuredImage?.url ?? null,
      price,
      unitCost,
      hasRecipe: Boolean(cost),
      margin: unitCost != null ? round2(price - unitCost) : null,
    };
  });

  return {
    products,
    hasMore: Boolean(body?.data?.products?.pageInfo?.hasNextPage),
    q,
    currency: settings.currency,
  };
};

export default function ProductsPage() {
  const { products, hasMore, q, currency } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(q);

  const runSearch = (value: string) => {
    setSearch(value);
    setSearchParams(value ? { q: value } : {}, { replace: true });
  };

  return (
    <Page>
      <TitleBar title="Product costs" />
      <BlockStack gap="400">
        <Banner tone="info">
          <p>
            These are your live Shopify products. Open one to build its recipe from your materials —
            the app adds up materials + factory cost + other costs into one cost per item, then
            shows your margin against the sale price.
          </p>
        </Banner>

        <Card>
          <TextField
            label="Search products"
            labelHidden
            value={search}
            onChange={runSearch}
            autoComplete="off"
            placeholder="Search products by title…"
            clearButton
            onClearButtonClick={() => runSearch("")}
          />
        </Card>

        <Card padding="0">
          {products.length === 0 ? (
            <Box padding="500">
              <Text as="p" tone="subdued" alignment="center">
                No products found{q ? ` for "${q}"` : ""}.
              </Text>
            </Box>
          ) : (
            <IndexTable
              selectable={false}
              itemCount={products.length}
              headings={[
                { title: "Product" },
                { title: "Price" },
                { title: "Cost / item" },
                { title: "Margin" },
                { title: "" },
              ]}
            >
              {products.map((p, index) => (
                <IndexTable.Row
                  id={p.id}
                  key={p.id}
                  position={index}
                  onClick={() => navigate(`/app/products/${p.numericId}`)}
                >
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Thumbnail source={p.image ?? ""} alt={p.title} size="small" />
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {p.title}
                        </Text>
                        {!p.hasRecipe && (
                          <Badge tone="attention" size="small">
                            No recipe
                          </Badge>
                        )}
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatMoney(p.price, currency)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {p.unitCost != null ? (
                      formatMoney(p.unitCost, currency)
                    ) : (
                      <Text as="span" tone="subdued">
                        —
                      </Text>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {p.margin != null ? (
                      <Text as="span" tone={p.margin >= 0 ? "success" : "critical"}>
                        {formatMoney(p.margin, currency)}
                      </Text>
                    ) : (
                      <Text as="span" tone="subdued">
                        —
                      </Text>
                    )}
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Button
                      variant="plain"
                      onClick={() => navigate(`/app/products/${p.numericId}`)}
                    >
                      {p.hasRecipe ? "Edit recipe" : "Add recipe"}
                    </Button>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>

        {hasMore && (
          <Text as="p" tone="subdued" alignment="center">
            Showing the first 100 products. Use search to find others.
          </Text>
        )}
      </BlockStack>
    </Page>
  );
}
