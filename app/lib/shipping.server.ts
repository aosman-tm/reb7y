/**
 * Reads the merchant's real shipping zones straight from Shopify (Settings →
 * Shipping and delivery) so the delivery-zone presets in the app always match
 * what the merchant actually configured, instead of a hardcoded region list.
 * Requires the `read_shipping` access scope; callers should fall back to
 * manual zone entry when it isn't granted (or the shop has no zones yet).
 */

type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ShopifyZonePreset = {
  name: string;
  keywords: string; // province/country names Shopify assigned to this zone, comma-separated
  isDefault: boolean; // true when the zone covers "rest of world" — a good catch-all default
};

const SHIPPING_ZONES_QUERY = `#graphql
  query Reb7yShippingZones($first: Int!) {
    deliveryProfiles(first: $first, merchantOwnedOnly: true) {
      edges {
        node {
          profileLocationGroups {
            locationGroupZones(first: 50) {
              edges {
                node {
                  zone {
                    name
                    countries {
                      code { restOfWorld }
                      provinces { name }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

/**
 * Fetch the merchant's live shipping zone names (deduped) plus the
 * provinces/countries assigned to each, used as address-matching keywords.
 */
export async function fetchShopifyDeliveryZones(
  admin: GraphqlClient,
): Promise<{ zones: ShopifyZonePreset[]; error: string | null }> {
  try {
    const response = await admin.graphql(SHIPPING_ZONES_QUERY, { variables: { first: 20 } });
    const body: any = await response.json();
    if (body?.errors) {
      const message = Array.isArray(body.errors)
        ? body.errors.map((e: any) => e.message).join("; ")
        : String(body.errors);
      return { zones: [], error: message };
    }

    const seen = new Map<string, ShopifyZonePreset>();
    const profileEdges = body?.data?.deliveryProfiles?.edges ?? [];
    for (const profileEdge of profileEdges) {
      const groups = profileEdge?.node?.profileLocationGroups ?? [];
      for (const group of groups) {
        const zoneEdges = group?.locationGroupZones?.edges ?? [];
        for (const zoneEdge of zoneEdges) {
          const zone = zoneEdge?.node?.zone;
          const name = String(zone?.name ?? "").trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (seen.has(key)) continue;

          const countries = zone?.countries ?? [];
          const keywords: string[] = [];
          let isDefault = false;
          for (const country of countries) {
            if (country?.code?.restOfWorld) isDefault = true;
            for (const province of country?.provinces ?? []) {
              if (province?.name) keywords.push(province.name);
            }
          }
          seen.set(key, { name, keywords: keywords.join(","), isDefault });
        }
      }
    }
    return { zones: Array.from(seen.values()), error: null };
  } catch (err) {
    return {
      zones: [],
      error: err instanceof Error ? err.message : "Failed to load Shopify shipping zones.",
    };
  }
}
