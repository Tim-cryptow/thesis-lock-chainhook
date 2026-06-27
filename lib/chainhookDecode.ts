// Pure helpers for reading the decoded Clarity values Hiro delivers when a
// chainhook predicate sets decode_clarity_values: true. The decoded shapes vary
// across Hiro and Stacks versions: a tuple may be a flat object or wrapped in
// { value }, a uint may arrive as a number, a numeric string, or a "u123"
// string, and a buff arrives as a hex string. Parse defensively and keep the
// raw value for forward-compatibility. No I/O here, so this module is unit-testable.

// The single field that carries the application-level event discriminator inside
// a contract's print tuple. The reference contract names it "event"; change this
// one constant if your contract uses a different field name. This is the only
// contract-specific assumption in the decoder.
export const EVENT_DISCRIMINATOR_FIELD = "event";

export type DecodedEvent = {
  // The application event discriminator (e.g. "anchor-created"), or null if the
  // tuple has no discriminator field.
  topic: string | null;
  // The tuple's fields, left as decoded so callers can map their own columns.
  fields: Record<string, unknown>;
  // The full decoded value, lossless, for a jsonb column.
  raw: unknown;
};

// Strip one { value } wrapper if present; otherwise return the input as-is.
export function unwrap(input: unknown): unknown {
  if (input && typeof input === "object" && "value" in input) {
    return (input as { value: unknown }).value;
  }
  return input;
}

// string | number | bigint -> string, else null.
export function toStr(input: unknown): string | null {
  const value = unwrap(input);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

// A buff arrives as a hex string; normalize to a lowercase 0x-prefixed form.
export function toHex(input: unknown): string | null {
  const value = toStr(input);
  if (value == null) return null;
  const lower = value.toLowerCase();
  return lower.startsWith("0x") ? lower : `0x${lower}`;
}

// Accept number, bigint, numeric string, or Clarity "u123" string. Block heights
// are far below 2^53 and bigint is not JSON-serializable, so return a number.
export function toUint(input: unknown): number | null {
  const value = unwrap(input);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const digits = value.trim().replace(/^u/, "");
    if (/^\d+$/.test(digits)) {
      const parsed = Number(digits);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

// Return the tuple's fields whether the tuple is flat or wrapped in { value }.
// Only unwrap a genuine { value } envelope: the inner value must itself be a
// tuple object and this level must not already carry the discriminator field.
// Otherwise a flat tuple with a real Clarity field named "value" (for example
// { event: "sale", value: "u100" }) would be collapsed to that scalar and the
// event silently dropped.
function tupleFields(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  const inner = obj["value"];
  const isEnvelope =
    "value" in obj &&
    !(EVENT_DISCRIMINATOR_FIELD in obj) &&
    !!inner &&
    typeof inner === "object" &&
    !Array.isArray(inner);
  if (isEnvelope) {
    return inner as Record<string, unknown>;
  }
  return obj;
}

// Decode a contract's print tuple into a generic { topic, fields, raw }. Returns
// null when the envelope is not a recognizable tuple. This is contract-agnostic:
// it reads the discriminator from EVENT_DISCRIMINATOR_FIELD and leaves all other
// field mapping to the caller.
export function decodeEventTuple(value: unknown): DecodedEvent | null {
  const fields = tupleFields(value);
  if (fields == null) return null;
  return {
    topic: toStr(fields[EVENT_DISCRIMINATOR_FIELD]),
    fields,
    raw: value,
  };
}
