import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;
let cachedConfigKey = '';

export const FAWATER_TABLES = [
  'organizations',
  'invoices',
  'invoice_items',
  'invoice_attachments',
  'custom_fields',
  'invoice_custom_values',
  'template_versions',
  'export_batches',
  'export_batch_items',
  'ai_extraction_logs',
  'ai_processing_batches',
  'ai_processing_jobs',
  'audit_logs',
  'app_settings',
] as const;

export const FAWATER_BUCKETS = ['invoice-images', 'invoice-exports'] as const;

export function inspectSupabaseKeyType(rawKey?: string): {
  kind: 'service_role' | 'anon' | 'publishable' | 'secret' | 'unknown' | 'missing';
  detail: string;
} {
  const key = (rawKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) return { kind: 'missing', detail: 'غير موجود' };
  if (key.startsWith('sb_secret_')) return { kind: 'secret', detail: 'sb_secret_*' };
  if (key.startsWith('sb_publishable_')) return { kind: 'publishable', detail: 'sb_publishable_* (مفتاح عام)' };

  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (payload?.role === 'service_role') {
        return { kind: 'service_role', detail: 'JWT role=service_role' };
      }
      if (payload?.role === 'anon' || payload?.role === 'authenticated') {
        return { kind: 'anon', detail: `JWT role=${payload.role}` };
      }
      return { kind: 'unknown', detail: `JWT role=${String(payload?.role || 'unknown')}` };
    } catch {
      return { kind: 'unknown', detail: 'JWT غير قابل للقراءة' };
    }
  }
  return { kind: 'unknown', detail: 'صيغة مفتاح غير قياسية' };
}

export function isSupabaseConfigured(): boolean {
  const url = (process.env.SUPABASE_URL || 'https://fryrlbgonkvounnarfwd.supabase.co').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return Boolean(url && key);
}

/**
 * Trusted server-side Supabase client (uses SUPABASE_SERVICE_ROLE_KEY only, NO Supabase Auth).
 * NEVER expose this client or key to frontend/browser code.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  const url = (process.env.SUPABASE_URL || 'https://fryrlbgonkvounnarfwd.supabase.co').trim();
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

export interface SupabaseConnectionStatus {
  configured: boolean;
  connected: boolean;
  bucketsReady: boolean;
  keyType: string;
  tablesChecked: Record<string, boolean>;
  missingOrDeniedTables: string[];
  missingBuckets: string[];
  error?: string;
}

/**
 * Checks real connectivity against the 12 actual Fawater tables and 2 storage buckets.
 * Never calls Supabase Auth or queries non-existent tables (like profiles/users/workspaces).
 */
export async function testSupabaseConnection(): Promise<SupabaseConnectionStatus> {
  const keyInfo = inspectSupabaseKeyType();

  if (!isSupabaseConfigured()) {
    return {
      configured: false,
      connected: false,
      bucketsReady: false,
      keyType: keyInfo.detail,
      tablesChecked: {},
      missingOrDeniedTables: [...FAWATER_TABLES],
      missingBuckets: [...FAWATER_BUCKETS],
      error: 'متغيرات SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY غير مهيأة على الخادم.',
    };
  }

  if (keyInfo.kind === 'anon' || keyInfo.kind === 'publishable') {
    return {
      configured: true,
      connected: false,
      bucketsReady: false,
      keyType: keyInfo.detail,
      tablesChecked: {},
      missingOrDeniedTables: [...FAWATER_TABLES],
      missingBuckets: [...FAWATER_BUCKETS],
      error:
        `المفتاح المضبوط في SUPABASE_SERVICE_ROLE_KEY هو مفتاح عام (${keyInfo.detail}) وليس Service Role Key! ` +
        'بسبب تفعيل RLS ومنع anon، يجب وضع مفتاح service_role السري (أو sb_secret_*) في أسرار الخادم فقط.',
    };
  }

  const client = getSupabaseAdmin();
  if (!client) {
    return {
      configured: false,
      connected: false,
      bucketsReady: false,
      keyType: keyInfo.detail,
      tablesChecked: {},
      missingOrDeniedTables: [...FAWATER_TABLES],
      missingBuckets: [...FAWATER_BUCKETS],
      error: 'تعذر تهيئة عميل Supabase الإداري.',
    };
  }

  try {
    const tablesChecked: Record<string, boolean> = {};
    const missingOrDeniedTables: string[] = [];
    let firstError = '';

    await Promise.all(
      FAWATER_TABLES.map(async (tableName) => {
        const { error } = await client.from(tableName).select('id').limit(1);
        if (error) {
          tablesChecked[tableName] = false;
          missingOrDeniedTables.push(tableName);
          if (!firstError) firstError = `${tableName}: ${error.message}`;
        } else {
          tablesChecked[tableName] = true;
        }
      })
    );

    const { data: buckets, error: bucketErr } = await client.storage.listBuckets();
    const bucketNames = new Set((buckets || []).map((b) => b.id || b.name));
    const missingBuckets = FAWATER_BUCKETS.filter((b) => !bucketNames.has(b));
    const bucketsReady = !bucketErr && missingBuckets.length === 0;

    const allTablesOk = missingOrDeniedTables.length === 0;

    if (!allTablesOk) {
      return {
        configured: true,
        connected: false,
        bucketsReady,
        keyType: keyInfo.detail,
        tablesChecked,
        missingOrDeniedTables,
        missingBuckets,
        error: `تعذر الوصول إلى ${missingOrDeniedTables.length} جدول (${firstError}). تأكد من أن SUPABASE_SERVICE_ROLE_KEY هو Service Role الصحيح وتنفيذ الصلاحيات على الجداول الـ 12.`,
      };
    }

    if (!bucketsReady) {
      return {
        configured: true,
        connected: true,
        bucketsReady: false,
        keyType: keyInfo.detail,
        tablesChecked,
        missingOrDeniedTables: [],
        missingBuckets,
        error: bucketErr
          ? `الجداول الـ 12 جاهزة لكن فشل فحص المخازن: ${bucketErr.message}`
          : `الجداول الـ 12 جاهزة لكن المخازن التالية غير موجودة: ${missingBuckets.join(', ')}`,
      };
    }

    return {
      configured: true,
      connected: true,
      bucketsReady: true,
      keyType: keyInfo.detail,
      tablesChecked,
      missingOrDeniedTables: [],
      missingBuckets: [],
    };
  } catch (err: any) {
    return {
      configured: true,
      connected: false,
      bucketsReady: false,
      keyType: keyInfo.detail,
      tablesChecked: {},
      missingOrDeniedTables: [...FAWATER_TABLES],
      missingBuckets: [...FAWATER_BUCKETS],
      error: err?.message || 'فشل الاتصال بخادم Supabase.',
    };
  }
}
