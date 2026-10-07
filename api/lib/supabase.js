import { createClient } from '@supabase/supabase-js';

let client = null;
let readOnlyClient = null;

export function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase server credentials are not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).');
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

// Mutations are blocked on this client. The service-role key bypasses RLS on every
// table, so "the tools are read-only" cannot be left as a convention in a comment -
// any new tool that reaches for .insert() would otherwise write to production.
const MUTATIONS = new Set(['insert', 'update', 'upsert', 'delete']);

function blocked(table, method) {
  return () => {
    throw new Error(`Blocked: tools are read-only and may not ${method}() on "${table}".`);
  };
}

// supabase-js builders keep `this` on their prototype chain, so every method has to
// be re-bound to the original builder before it is handed back out.
function readOnlyBuilder(builder, table) {
  return new Proxy(builder, {
    get(target, prop) {
      if (MUTATIONS.has(prop)) return blocked(table, prop);
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function getReadOnlySupabase() {
  if (readOnlyClient) return readOnlyClient;
  const supabase = getSupabase();
  readOnlyClient = new Proxy(supabase, {
    get(target, prop) {
      if (prop === 'from') {
        return (table) => readOnlyBuilder(target.from(table), table);
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return readOnlyClient;
}
