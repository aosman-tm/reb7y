import { Outlet } from "@remix-run/react";

// Layout route for /app/products and /app/products/:id.
// The list lives in app.products._index.tsx; the recipe editor in
// app.products.$id.tsx. This just renders whichever child matches.
export default function ProductsLayout() {
  return <Outlet />;
}
