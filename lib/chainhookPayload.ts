// Pure parsing of the Hiro Chainhook Stacks payload: no I/O, no Supabase, no
// secrets, so it is unit-testable in isolation. Everything is runtime-guarded;
// the types are for readability only and are never trusted.

import { decodeEventTuple, type DecodedEvent } from "@/lib/chainhookDecode";

// The contract whose print events we ingest, e.g. "SP....address.contract-name".
// Set this to your own contract; it is the primary server-side filter alongside
// the predicate's own contract_identifier match.
export const CONTRACT_ID = process.env.CONTRACT_ID ?? "";

// Optional secondary guard on the decoded application topic. The predicate's
// "contains" already filters server-side, so leave this unset to index every
// print event from the contract, or set it to keep only one event topic.
export const EVENT_TOPIC = process.env.EVENT_TOPIC ?? "";

// A Clarity print event carries the same three fields whichever payload shape
// delivers it: a receipt event's data, or a contract_log operation's metadata.
type PrintEventData = {
  contract_identifier?: string;
  topic?: string;
  value?: unknown;
};

type ChainhookEvent = {
  type?: string;
  data?: PrintEventData;
};

// Rosetta-style operation. The hosted Hiro Platform represents a print event as
// an operation of type "contract_log" whose metadata carries the print fields.
type ChainhookOperation = {
  type?: string;
  metadata?: PrintEventData;
};

type ChainhookTransaction = {
  transaction_identifier?: { hash?: string };
  operations?: ChainhookOperation[];
  metadata?: {
    success?: boolean;
    // Some payload shapes name the caller "sender", others "sender_address".
    sender?: string;
    sender_address?: string;
    receipt?: { events?: ChainhookEvent[] };
  };
};

export type ChainhookBlock = {
  block_identifier?: { index?: number; hash?: string };
  transactions?: ChainhookTransaction[];
};

export type BlockEnvelope = {
  apply?: ChainhookBlock[];
  rollback?: ChainhookBlock[];
};

// The blocks arrive either at the top level (Chainhook CLI / self-hosted node)
// or nested under an "event" envelope (some hosted Hiro Platform deliveries).
export type ChainhookPayload = BlockEnvelope & {
  event?: BlockEnvelope;
};

// One row of the generic public.events table. Add typed columns of your own by
// mapping them from decoded.fields (see the README worked example).
export type EventRow = {
  tx_id: string;
  block_height: number;
  sender: string | null;
  topic: string | null;
  fields: Record<string, unknown>;
  raw: unknown;
  reverted: boolean;
};

function toRow(
  txId: string,
  blockHeight: number,
  tx: ChainhookTransaction,
  decoded: DecodedEvent,
): EventRow {
  return {
    tx_id: txId,
    block_height: blockHeight,
    sender: tx.metadata?.sender ?? tx.metadata?.sender_address ?? null,
    topic: decoded.topic,
    fields: decoded.fields,
    raw: decoded.raw,
    reverted: false,
  };
}

// Collect the print-event data a transaction carries, from both payload shapes:
// receipt events of type "SmartContractEvent", and operations of type
// "contract_log". Either may be present depending on the Chainhook delivery.
//
// The receipt-event path is authoritative: with decode_clarity_values: true the
// data.value is the decoded Clarity tuple, which decodeEventTuple reads directly.
// The contract_log operation path is best-effort: in some hosted shapes its value
// is a serialized form (hex / repr) rather than a decoded tuple, in which case
// decodeEventTuple returns null and the entry is skipped - the receipt-event entry
// for the same transaction still indexes it, so no event is lost. We intentionally
// do not deserialize raw Clarity here to avoid pulling in a Clarity decoder.
function printEventData(tx: ChainhookTransaction): PrintEventData[] {
  const out: PrintEventData[] = [];
  for (const event of tx.metadata?.receipt?.events ?? []) {
    if (event.type === "SmartContractEvent" && event.data) out.push(event.data);
  }
  for (const op of tx.operations ?? []) {
    if (op?.type === "contract_log" && op.metadata) out.push(op.metadata);
  }
  return out;
}

// Pull matching event rows from a block. Skips failed transactions and any event
// that is not our contract's print of the expected (optional) topic. When both
// payload shapes carry the same logical event, it is de-duplicated per transaction
// so it is not counted twice.
export function eventRowsFromBlock(block: ChainhookBlock): EventRow[] {
  const blockHeight = block.block_identifier?.index ?? 0;
  const rows: EventRow[] = [];
  for (const tx of block.transactions ?? []) {
    if (tx.metadata?.success === false) continue;
    const txId = tx.transaction_identifier?.hash;
    if (!txId) continue;
    const seen = new Set<string>();
    for (const data of printEventData(tx)) {
      // "print" is Chainhook's wire topic for Clarity print events.
      if (data.topic !== "print") continue;
      if (CONTRACT_ID && data.contract_identifier !== CONTRACT_ID) continue;
      const decoded = decodeEventTuple(data.value);
      if (!decoded) continue;
      // EVENT_TOPIC is a secondary guard on the decoded application topic.
      if (EVENT_TOPIC && decoded.topic !== EVENT_TOPIC) continue;
      // De-duplicate the same event when both shapes carry it in one transaction.
      const key = `${data.contract_identifier ?? ""}|${decoded.topic ?? ""}|${JSON.stringify(decoded.raw)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(toRow(txId, blockHeight, tx, decoded));
    }
  }
  return rows;
}

// Return the apply/rollback blocks whether they sit at the top level or nested
// under an "event" envelope.
export function blockEnvelope(payload: ChainhookPayload): BlockEnvelope {
  if (payload.event && typeof payload.event === "object") {
    return payload.event;
  }
  return payload;
}
