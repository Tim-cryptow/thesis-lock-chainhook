-- Generic events table for the Chainhook -> Supabase template. One row per
-- transaction, keyed on tx_id so redelivery is idempotent. A transaction that
-- emits more than one matching print event keeps the last event; see the README
-- for how to make the key composite if you need every event.
--
-- Supabase is an idempotent, rollback-aware index of the chain, not the source
-- of truth: it can be rebuilt at any time by replaying from the predicate's
-- start_block. To index a richer schema, add typed columns + indexes per your
-- own event and map them from the decoded fields in the ingest route.

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

-- Recent-first lookups of live (non-reverted) events.
create index if not exists events_recent_idx
  on public.events (block_height desc) where reverted = false;

-- Filter by application event topic.
create index if not exists events_topic_idx on public.events (topic);

-- Row level security: anon/auth get read-only access; there is no write policy,
-- so only the service-role key (which bypasses RLS) used by the ingest route can
-- write. Never expose the service-role key to the client.
alter table public.events enable row level security;

create policy "events_public_read"
  on public.events
  for select
  using (true);
