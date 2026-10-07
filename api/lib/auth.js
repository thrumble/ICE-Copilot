import { createClient } from '@supabase/supabase-js';

function getAuthClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase server credentials are not configured.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function isAuthorizedRequest(req) {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const allowedEmail = (process.env.ALLOWED_USER_EMAIL || process.env.VITE_ALLOWED_USER_EMAIL)?.trim().toLowerCase();
  if (!token || !allowedEmail) return false;
  try {
    const { data, error } = await getAuthClient().auth.getUser(token);
    return !error && data.user?.email?.toLowerCase() === allowedEmail;
  } catch {
    return false;
  }
}
