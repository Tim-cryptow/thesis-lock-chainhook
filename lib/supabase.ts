import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client built from the service-role key. The service-role
// key bypasses row level security, so it must never reach the browser: it is read
// from a non-NEXT_PUBLIC env var (so Next never inlines it into a client bundle)
// and this module imports "server-only" (so a client-component import is a build
// error rather than a silent leak).

let client: SupabaseClient | null = null;

// Read a required env var or throw a clear error. The chainhook route turns this
// throw into a 500, which is the correct loud-and-retryable signal for a misconfig.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

// Lazily construct a single service-role client and cache it. Lazy (not at module
// load) so a missing env var surfaces only when the client is actually used, never
// breaking the build or unrelated imports.
export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;
  client = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}
