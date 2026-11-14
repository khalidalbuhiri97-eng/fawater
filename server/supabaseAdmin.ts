import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;
let cachedConfigKey = '';

export function isSupabaseConfigured(): boolean {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return Boolean(url && key);
}

/**
 * Trusted server-side Supabase admin client (uses SUPABASE_SERVICE_ROLE_KEY).
 * NEVER expose this client or key to frontend/browser code.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  const url = (process.env.SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !serviceKey) {
    return null;
  }

  const keySig = `${url}::${serviceKey.slice(0, 8)}`;
  if (!cachedClient || cachedConfigKey !== keySig) {
    cachedClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    cachedConfigKey = keySig;
  }
  return cachedClient;
}

export async function testSupabaseConnection(): Promise<{
  configured: boolean;
  connected: boolean;
  bucketsReady: boolean;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    return {
      configured: false,
      connected: false,
      bucketsReady: false,
      error: 'متغيرات SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY غير مهيأة على الخادم.',
    };
  }

  const client = getSupabaseAdmin();
  if (!client) {
    return {
      configured: false,
      connected: false,
      bucketsReady: false,
      error: 'تعذر تهيئة عميل Supabase الإداري.',
    };
  }

  try {
    const { error: orgErr } = await client.from('organizations').select('id').limit(1);
    if (orgErr) {
      return {
        configured: true,
        connected: false,
        bucketsReady: false,
        error: `اتصال Supabase متاح لكن الجدول غير جاهز أو فشل الاستعلام: ${orgErr.message}`,
      };
    }

    const { data: buckets, error: bucketErr } = await client.storage.listBuckets();
    if (bucketErr) {
      return {
        configured: true,
        connected: true,
        bucketsReady: false,
        error: `تم الاتصال بقاعدة البيانات لكن فشل فحص المخازن: ${bucketErr.message}`,
      };
    }

    const names = new Set((buckets || []).map((b) => b.id || b.name));
    const bucketsReady = names.has('invoice-images') && names.has('invoice-exports');
    return {
      configured: true,
      connected: true,
      bucketsReady,
      error: bucketsReady ? undefined : 'مخازن invoice-images أو invoice-exports غير منشأة بعد.',
    };
  } catch (err: any) {
    return {
      configured: true,
      connected: false,
      bucketsReady: false,
      error: err?.message || 'فشل الاتصال بخادم Supabase.',
    };
  }
}
