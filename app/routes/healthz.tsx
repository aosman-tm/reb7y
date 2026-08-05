// Unauthenticated liveness probe used by the deploy script and uptime checks.
export const loader = () =>
  new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
