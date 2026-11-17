import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  const url = (import.meta.env.VITE_SUPABASE_URL || 'https://fryrlbgonkvounnarfwd.supabase.co') as string;
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_1hfYV443ep4J0mN2aO_e2g_BBPJmcXq') as string;
  if (!url || !key) {
    throw new Error('إعدادات الدخول غير مكتملة. أضف VITE_SUPABASE_URL وVITE_SUPABASE_ANON_KEY إلى متغيرات بيئة الواجهة.');
  }
  if (!client) {
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}


/** Attach the current Supabase session to same-origin server API requests. */
export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const { data, error } = await getSupabaseBrowserClient().auth.getSession();
  if (error) throw error;
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error('انتهت جلسة الدخول. سجّل الدخول مجدداً.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return fetch(input, { ...init, headers });
}
