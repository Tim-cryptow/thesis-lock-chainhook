# Chainhook -> Supabase starter template

A clone-and-configure template that indexes any Stacks contract's `print` events
into Supabase, reorg-safely, without running a Chainhook node or polling the Hiro
API. Set a few env vars, point a predicate at your contract and event, deploy the
endpoint to Vercel, register the predicate on the Hiro Platform, and your
contract's print events stream into a Supabase table you own.

It generalizes a production pipeline (already shipped and running) into a generic
events table and a contract-agnostic decoder.

## What it does

- Exposes `POST /api/chainhooks`, a Hiro Chainhook HTTP-POST receiver.
- Filters each delivery to print events from your contract, decodes the Clarity
  tuple defensively, and writes one row per transaction.
- Reads both Chainhook payload shapes: blocks at the top level (`apply`/`rollback`)
  or nested under an `event` envelope, and print events delivered as
  `SmartContractEvent` receipt events or as `contract_log` operations. When both
  representations carry the same event in one transaction, it is de-duplicated.
- Handles chain reorganizations: a `rollback` marks affected rows `reverted=true`;
  a re-`apply` un-reverts them. Upserts are keyed on `tx_id`, so redelivery and
  full replay are safe no-ops.

### Trust model

The chain is the source of truth. Supabase is an idempotent, rollback-aware
index/cache that can be rebuilt at any time by replaying from the predicate's
`start_block`. Nothing here is authoritative state; if the table is lost or
corrupted, re-register the predicate from your deploy block and the index refills.

## Quickstart

1. Clone this repo and install dependencies:
   ```bash
   git clone <this-repo> my-indexer && cd my-indexer
   npm install
   ```
2. Copy the env template and fill it in:
   ```bash
   cp .env.example .env.local
   ```
   Generate the auth token with `openssl rand -hex 32`. Set `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `CONTRACT_ID`, and optionally `EVENT_TOPIC`.
3. Run the database migration. Either push with the Supabase CLI:
   ```bash
   supabase db push
   ```
   or paste the SQL block below into the Supabase SQL editor.
4. Deploy to Vercel. Import the repo, set the same env vars in the Vercel project
   settings (`CHAINHOOK_AUTH_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `CONTRACT_ID`, `EVENT_TOPIC`), then redeploy so they take effect.
5. Fill in `chainhook.predicate.example.json` (save your copy as something matching
   `*.local.json` so the real token stays out of git): set `uuid`, `name`,
   `start_block`, `contract_identifier`, `contains`, and the `url` to
   `<YOUR_DEPLOYMENT_URL>/api/chainhooks`.
6. Register the predicate on the Hiro Platform and set the matching secret (see
   Authentication below), then enable it. Print events from your contract now
   stream into the `events` table.

## Authentication

The route accepts the shared secret over two transports and prefers the header:

- **`Authorization: Bearer <token>`** - used by the Chainhook CLI and self-hosted
  nodes, which can send custom headers. This is the `authorization_header` field
  in `chainhook.predicate.example.json`.
- **`?token=<token>` query param** - used by the hosted Hiro Platform. Its
  HTTP-POST builder has no custom-header field, so the secret can only ride on the
  URL. In the Hiro Platform UI, set the POST url to
  `<YOUR_DEPLOYMENT_URL>/api/chainhooks?token=<CHAINHOOK_AUTH_TOKEN>` and leave the
  header unset. Enter the real token only in the UI, never in the committed file.

The token is compared with `node:crypto` `timingSafeEqual` behind an equal-length
guard. A missing or mismatched token returns 401; an unset `CHAINHOOK_AUTH_TOKEN`
on the server returns 500 (a loud, retryable misconfiguration).

## How to adapt it

- **Different contract or event:** change `CONTRACT_ID` and `EVENT_TOPIC` and point
  the predicate's `contract_identifier` / `contains` at them. The decoder needs no
  code change.
- **Different discriminator field:** the decoder reads the application event name
  from a single field, `EVENT_DISCRIMINATOR_FIELD` in `lib/chainhookDecode.ts`
  (default `"event"`). If your contract names it something else, change that one
  constant.
- **Typed columns:** the generic table stores `topic`, the decoded `fields`
  (jsonb), and the lossless `raw` value. For richer queries, add typed columns to
  the table and map them from `decoded.fields` in the route's `toRow`.

### Worked example: thesislock

The reference contract emits a print tuple with an `event` discriminator and the
fields `hash`, `anchored-by`, `stacks-block`, `burn-block`, and `label`. To index
those as typed columns you would add them to the migration and map them in
`toRow`, using the decoder helpers:

```ts
import { toHex, toStr, toUint } from "@/lib/chainhookDecode";

// inside toRow(...), alongside the generic columns:
hash:         toHex(decoded.fields["hash"]),
anchored_by:  toStr(decoded.fields["anchored-by"]),
stacks_block: toUint(decoded.fields["stacks-block"]),
burn_block:   toUint(decoded.fields["burn-block"]),
label:        toStr(decoded.fields["label"]),
```

`CONTRACT_ID` would be `SP3QS6X01XKTYC84BHA0J567CZTAH67BJHN88FNVM.thesislock` and
`EVENT_TOPIC` would be `anchor-created`.

## Smoke test

This needs no database (the no-op fast path acknowledges an empty delivery without
touching Supabase):

```bash
curl -i -X POST "$URL/api/chainhooks?token=$CHAINHOOK_AUTH_TOKEN" \
  -H "Content-Type: application/json" -d '{"apply":[],"rollback":[]}'
# -> 200 {"ok":true}
```

| Status | Meaning |
| ------ | ------- |
| 200    | Accepted (matching rows written, or a no-op acknowledged). |
| 400    | Invalid JSON body. |
| 401    | Token missing or mismatched. |
| 404    | Route not deployed at this URL. |
| 500    | Server misconfig (no `CHAINHOOK_AUTH_TOKEN`) or DB error. Hiro retries; upserts keep replays safe. |

A `GET /api/chainhooks` is an unauthenticated liveness check that returns
`200 {"ok":true}` without touching the database or revealing any config.

## Database schema

```sql
create table if not exists public.events (
  tx_id text primary key,
  block_height bigint not null,
  sender text,
  topic text,
  fields jsonb,
  raw jsonb not null,
  reverted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists events_recent_idx
  on public.events (block_height desc) where reverted = false;

create index if not exists events_topic_idx on public.events (topic);

alter table public.events enable row level security;

create policy "events_public_read"
  on public.events
  for select
  using (true);
```

RLS is enabled with a public `SELECT` policy and no write policy, so anon/auth
clients stay read-only; only the service-role key (which bypasses RLS) used by the
ingest route can write. Add typed columns and indexes per your own event for
richer queries.

## Known limits

- One row per transaction. The table is keyed on `tx_id`, so if a single
  transaction emits more than one matching print event, the last event in that
  transaction wins. To capture every event, add an event index to the table and
  make the primary key composite (for example `(tx_id, event_index)`), then set
  the route's upsert `onConflict` to match.
- Large backfills may need a lower Hiro batch size.
- It indexes Stacks `print` events only; it does not track other event types or
  general chain state.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run (decoder unit tests)
npm run build       # next build
```

## License

MIT. See [LICENSE](./LICENSE).
