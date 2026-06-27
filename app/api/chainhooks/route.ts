export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unauthenticated liveness check. Returns 200 without touching the database or
// revealing any configuration, so a probe can confirm the endpoint is deployed.
export function GET() {
  return Response.json({ ok: true });
}
