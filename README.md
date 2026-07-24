# reb7y — profit & loss tracker for your Shopify store

reb7y (ربحي) tells you exactly how much you **earn or lose on every order**, by
tracking the real costs Shopify doesn't:

- **Materials** — build each product from its parts (box, bubble wrap, card, sticker…). Each part has a known unit cost, so the app knows the true cost of every item.
- **Real delivery cost** — the actual courier price per area, even when it's different from what you charge the customer at checkout.
- **Daily ad spend** — you enter it, the app subtracts it from profit.
- **Fees, refunds, discounts, and rejected COD orders** — all counted.

It reads your live **products** and **orders** from Shopify and combines them with
your cost data to produce accurate per-order and period reports.

---

## What's inside

| Page | What it's for |
|------|---------------|
| **Dashboard** | Net profit, revenue, cost mix, and a P&L for any date range. Onboarding checklist. |
| **Orders** | Every order with its real profit. Adjust the real delivery cost or mark an order rejected/returned. |
| **Product costs** | Your live products. Open one to build its recipe from materials → cost per item + margin. |
| **Materials** | Your parts library (box, bubble wrap, card…), each with a unit cost. |
| **Ad spend** | One total per day. |
| **Delivery zones** | Real courier cost per area (with an Egypt starter set). Matched to each order by shipping city. |
| **Reports** | Full P&L, extra detail (shipping loss, refunds, discounts), per-product profitability, CSV export. |
| **Settings** | Currency (EGP by default), payment/COD fees, round-trip delivery default. |

### How profit is calculated (per order)

```
Revenue      = order total − tax        (0 if the order was rejected/returned)
− Materials  = Σ (each product's recipe cost × quantity)
− Delivery   = your per-order override, else the matching zone's real cost
               (counted ×2 on rejected/returned orders you paid both ways)
− Fees       = revenue × payment-fee %  (+ flat fee; COD fee for COD orders)
= Order profit
```

Then, for a date range:

```
Period profit = Σ order profit  −  total ad spend in that range
```

The math is covered by a check script: `npx tsx scripts/verify-profit.ts`.

---

## Tech

Shopify's official **Remix** app template — Remix + **Polaris** UI + **App Bridge**,
**Prisma** (SQLite in dev) for your cost data, and the Admin **GraphQL** API for
products and orders. The app only requests **read** access (`read_products`,
`read_orders`); it never writes to your store.

---

## Run it (one-time setup)

Everything below runs in **your** terminal — the connect step opens a browser to log
in to your Shopify Partner account, which only you can do.

**Prerequisites** (already installed on this machine): Node 20.19+/22.12+, and the
Shopify CLI. You also need a free [Shopify Partner account](https://partners.shopify.com)
and a **development store** to test on.

```bash
cd c:/shopify/app/reb7y

# 1. Link this code to an app in your Partner account (creates the app if needed).
npm run config:link        # or: shopify app config link

# 2. Start the dev server and install the app on your dev store.
npm run dev                # or: shopify app dev
```

`shopify app dev` prints a URL — open it, pick your development store, and install.
The app appears in your Shopify admin under **Apps → reb7y**.

### ⚠️ One required permission: Protected customer data

Reading an order's **shipping city** (to match delivery zones) counts as *protected
customer data*. If the Dashboard shows a red "Couldn't read your orders" banner:

1. Go to your app in the **Partner dashboard** → **API access**.
2. Under **Protected customer data access**, request/enable access (for your own
   store this is granted immediately).
3. Reinstall/refresh the app.

Everything else works without it — only the shipping-address zone matching needs it.

> Note: `read_orders` returns orders from the **last 60 days**. To report on older
> orders, add the `read_all_orders` scope in `shopify.app.toml` (it also needs
> approval), then redeploy.

---

## First steps in the app

1. **Materials** → add your parts (e.g. *Small box* 5.00 / piece, *Bubble wrap* 0.50 / cm).
2. **Product costs** → open a product → add materials to its recipe (e.g. 1 box + 20 cm bubble wrap + 1 card + 1 sticker).
3. **Delivery zones** → *Add Egypt starter zones*, then fill in the real courier cost per area.
4. **Settings** → confirm currency and any payment/COD fee.
5. **Ad spend** → log what you spend each day.
6. **Dashboard / Reports** → watch your real profit.

---

## Notes & assumptions

- Reports use your **current** material/zone costs applied to past orders (so if a
  cost changes, historical reports reflect the new cost).
- Ad spend is a **period** cost (per day), so it's subtracted from the total, not
  from individual orders.
- Rejected/returned orders: revenue becomes 0 and materials aren't counted (goods
  came back), but the delivery cost still counts — optionally ×2 for round trips.
- Dev data lives in `prisma/dev.sqlite`. For production, switch Prisma to Postgres/MySQL
  and run `npm run setup`.

Built on the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix).
