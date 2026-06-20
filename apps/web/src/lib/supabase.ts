import { createClient } from '@supabase/supabase-js';

// Browser client uses the ANON key. RLS enforces org isolation on every query
// this client could ever make.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
