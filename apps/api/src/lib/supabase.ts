import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Service-role client for backend/pipeline use. This key BYPASSES RLS, so every
// query in application code MUST still scope by org_id explicitly. RLS is the
// backstop for client (anon-key) connections, not a substitute for org scoping
// in trusted backend code.
let client: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
