import { timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  blockEnvelope,
  eventRowsFromBlock,
  type ChainhookPayload,
  type EventRow,
} from "@/lib/chainhookPayload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Permissive CORS, matching the reference. Not required for server-to-server
// delivery, but harmless and convenient for manual probes.
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

// Length-safe, timing-safe secret comparison. timingSafeEqual throws on
// unequal-length buffers, so guard the length first.
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  // Verify the shared secret before any other work. An unset secret is a loud,
  // retryable misconfiguration rather than a silent accept.
  const expected = process.env.CHAINHOOK_AUTH_TOKEN;
  if (!expected) {
    return json({ ok: false, error: "Server not configured." }, 500);
  }

  // Prefer the Authorization: Bearer header (Chainhook CLI / self-hosted node).
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Fall back to a ?token= query param: the hosted Hiro Platform HTTP-POST
  // builder has no custom-header field, so the secret can only ride on the URL.
  const queryToken = new URL(req.url).searchParams.get("token") ?? "";
  const provided = bearer || queryToken;
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  let payload: ChainhookPayload;
  try {
    payload = (await req.json()) as ChainhookPayload;
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  try {
    // Blocks arrive at the top level or under an "event" envelope; support both.
    const { apply, rollback } = blockEnvelope(payload);

    // Rollback before apply: if a reorg both rolls back and re-applies a tx, the
    // apply pass below restores reverted=false, leaving the correct final state.
    const rolledBack = (rollback ?? [])
      .flatMap(eventRowsFromBlock)
      .map((row) => row.tx_id);

    // The table is keyed on tx_id, so a transaction that emits more than one
    // matching print event would otherwise produce duplicate conflict targets in
    // a single upsert (which Postgres rejects). De-duplicate by tx_id, keeping the
    // last matching event in the transaction. Multi-event contracts that need
    // every event should add an event index to the key (see the README).
    const byTxId = new Map<string, EventRow>();
    for (const row of (apply ?? []).flatMap(eventRowsFromBlock)) {
      byTxId.set(row.tx_id, row);
    }
    const rows = Array.from(byTxId.values());

    // No-op fast path: most deliveries contain nothing for us. Acknowledge
    // without touching Supabase, so a no-op never depends on the database.
    if (rolledBack.length === 0 && rows.length === 0) {
      return json({ ok: true });
    }

    const supabase = getSupabaseAdmin();

    if (rolledBack.length > 0) {
      const { error } = await supabase
        .from("events")
        .update({ reverted: true })
        .in("tx_id", rolledBack);
      if (error) throw error;
    }

    // Apply: idempotent upsert keyed on tx_id, so redelivery is a safe no-op and
    // a re-applied tx is un-reverted.
    if (rows.length > 0) {
      const { error } = await supabase
        .from("events")
        .upsert(rows, { onConflict: "tx_id" });
      if (error) throw error;
    }

    return json({ ok: true });
  } catch (err) {
    console.error("Chainhook processing failed:", err);
    // 500 so Hiro retries; the upserts make a full replay safe.
    return json({ ok: false, error: "Processing failed." }, 500);
  }
}

// Unauthenticated liveness check. Returns 200 without touching the database or
// revealing any configuration, so a probe can confirm the endpoint is deployed.
export function GET() {
  return json({ ok: true });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
