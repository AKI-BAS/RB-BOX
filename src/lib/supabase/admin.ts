import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Server-only Supabase client that uses the service role key.
 *
 * NEVER import this into a client component. It bypasses RLS.
 * Only use inside API routes / server actions / Edge Functions.
 */
export function createAdminClient() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  }
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
