import {
  BackgroundQueueStatus,
  ExportBatchRecord,
  ExportTrackingEntry,
  InvoiceRecord,
  Operation,
} from '../types';
import {
  idbPut,
  readAllOrganizationsFromStore,
  readExportTrackingFromStore,
  STORE_NAMES,
  writeExportTrackingToStore,
} from './localStore';
import { authenticatedFetch } from '../auth/supabaseClient';

export async function enqueueAiBackgroundBatch(params: {
  organization: Operation;
  files: Array<{
    invoiceId: string;
    imageBase64: string;
    mimeType: string;
    fileName: string;
    fileSize: number;
    manualDocumentType: 'auto' | 'مبيعات' | 'مشتريات';
  }>;
}): Promise<{
  batchId: string;
  supabaseSynced: boolean;
  supabaseWarning?: string;
  initialInvoices: InvoiceRecord[];
}> {
  // Ensure this local organization exists in Supabase and the first signed-in user
  // is recorded as its owner before the server authorizes background processing.
  const bootstrapRes = await authenticatedFetch('/api/supabase/bootstrap', { cache: 'no-store' });
  if (bootstrapRes.ok) {
    const bootstrap = await bootstrapRes.json().catch(() => ({}));
    const found = (bootstrap?.data?.organizations || []).some((org: any) => org.id === params.organization.id);
    if (!found) {
      const createRes = await authenticatedFetch('/api/supabase/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: params.organization.id,
          name: params.organization.name,
          activityType: params.organization.activityType,
          excelFileName: params.organization.excelFileName,
        }),
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createData.success) {
        throw new Error(createData.error || `تعذر تهيئة المؤسسة قبل المعالجة (رمز ${createRes.status})`);
      }
    }
  } else if (bootstrapRes.status === 403) {
    // First organization for a new account: the server creates it and adds
    // the current authenticated user as owner in the same route.
    const createRes = await authenticatedFetch('/api/supabase/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: params.organization.id,
        name: params.organization.name,
        activityType: params.organization.activityType,
        excelFileName: params.organization.excelFileName,
      }),
    });
    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createData.success) {
      throw new Error(createData.error || `تعذر تهيئة المؤسسة قبل المعالجة (رمز ${createRes.status})`);
    }
  } else {
    const bootstrapData = await bootstrapRes.json().catch(() => ({}));
    throw new Error(bootstrapData.error || `تعذر التحقق من عضوية المؤسسة (رمز ${bootstrapRes.status})`);
  }

  const res = await authenticatedFetch('/api/background/ai-batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organization: {
        id: params.organization.id,
        name: params.organization.name,
        activityType: params.organization.activityType,
        excelFileName: params.organization.excelFileName,
        customFields: params.organization.customFields || [],
      },
      files: params.files,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || `تعذر إرسال الدفعة للمعالجة في الخلفية (رمز ${res.status})`);
  }
  return {
    batchId: data.batchId,
    supabaseSynced: Boolean(data.supabaseSynced),
    supabaseWarning: data.supabaseWarning,
    initialInvoices: Array.isArray(data.initialInvoices) ? data.initialInvoices : [],
  };
}

export async function retryBackgroundAiBatch(batchId: string): Promise<void> {
  const res = await authenticatedFetch(`/api/background/ai-batches/${encodeURIComponent(batchId)}/retry`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'تعذر إعادة محاولة الفواتير الفاشلة.');
  }
}

export async function enqueueBackgroundExcelExport(params: {
  organization: Operation;
  alreadyExportedIds: string[];
}): Promise<{ jobId: string; batchId: string; fileName: string; status: string }> {
  const res = await authenticatedFetch('/api/background/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organization: {
        id: params.organization.id,
        name: params.organization.name,
        excelFileName: params.organization.excelFileName,
      },
      invoices: (params.organization.invoices || []).map((inv) => {
        const { imageBase64: _drop, ...clean } = inv;
        return clean;
      }),
      alreadyExportedIds: params.alreadyExportedIds,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || `تعذر جدولة تصدير Excel في الخلفية (رمز ${res.status})`);
  }
  return {
    jobId: data.jobId,
    batchId: data.batchId,
    fileName: data.fileName,
    status: data.status,
  };
}

export async function downloadBackgroundExportFile(jobId: string, fileName: string): Promise<void> {
  const res = await authenticatedFetch(`/api/background/exports/${encodeURIComponent(jobId)}/download`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'تعذر تنزيل ملف Excel الجاهز.');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'fawater_export.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function fetchBackgroundQueueStatus(
  organizationId?: string
): Promise<BackgroundQueueStatus | null> {
  try {
    const url = organizationId
      ? `/api/background/status?organizationId=${encodeURIComponent(organizationId)}`
      : '/api/background/status';
    const res = await authenticatedFetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return {
      aiBatches: data.aiBatches || [],
      exportJobs: data.exportJobs || [],
      activeAiCount: Number(data.activeAiCount || 0),
      activeExportCount: Number(data.activeExportCount || 0),
      hasActiveJobs: Boolean(data.hasActiveJobs),
    };
  } catch {
    return null;
  }
}

export async function dismissBackgroundJob(id: string): Promise<void> {
  await authenticatedFetch(`/api/background/jobs/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
  }).catch(() => {});
}

/**
 * Merges server-processed background AI invoices and completed Excel export jobs
 * into the local IndexedDB mirror so UI views update live even after closing modals/tabs.
 * Returns true if any local records were updated.
 */
export async function mergeBackgroundResultsIntoLocalStore(
  status: BackgroundQueueStatus
): Promise<boolean> {
  let changed = false;

  const orgs = await readAllOrganizationsFromStore();
  const orgMap = new Map(orgs.map((o) => [o.id, o]));

  for (const batch of status.aiBatches) {
    let org = orgMap.get(batch.organizationId);
    if (!org) continue;

    const invMap = new Map((org.invoices || []).map((i) => [i.id, i]));
    let orgModified = false;

    for (const item of batch.items) {
      if (!item.invoiceRecord) continue;
      const existing = invMap.get(item.invoiceId);
      const serverInv = item.invoiceRecord;

      // Never overwrite user's manual approval ('مكتملة') with server's 'تحتاج مراجعة'
      if (existing && existing.status === 'مكتملة' && serverInv.status === 'تحتاج مراجعة') {
        continue;
      }

      if (
        !existing ||
        existing.status !== serverInv.status ||
        existing.processingStatus !== serverInv.processingStatus ||
        (serverInv.updatedAt && (!existing.updatedAt || serverInv.updatedAt > existing.updatedAt))
      ) {
        const merged: InvoiceRecord = {
          ...(existing || {}),
          ...serverInv,
          imageBase64: existing?.imageBase64,
        };
        invMap.set(item.invoiceId, merged);
        orgModified = true;
      }
    }

    if (orgModified) {
      const updatedOrg: Operation = {
        ...org,
        invoices: Array.from(invMap.values()),
        updatedAt: new Date().toISOString().split('T')[0],
      };
      await idbPut(STORE_NAMES.ORGANIZATIONS, updatedOrg);
      orgMap.set(org.id, updatedOrg);
      changed = true;
    }
  }

  for (const job of status.exportJobs) {
    if (job.status !== 'completed' || !job.entries || job.entries.length === 0) continue;
    const prev = await readExportTrackingFromStore(job.organizationId);
    const alreadyHasBatch = prev?.batches?.some((b) => b.id === job.batchId);
    if (alreadyHasBatch) continue;

    const newBatch: ExportBatchRecord = {
      id: job.batchId,
      organizationId: job.organizationId,
      fileName: job.fileName,
      templateSha256: job.templateSha256 || '',
      exportedCount: job.exportedCount,
      salesCount: job.salesCount,
      purchasesCount: job.purchasesCount,
      exportedAt: job.updatedAt,
      entries: job.entries,
      syncStatus: job.supabaseSynced ? 'synced' : 'pending',
    };

    const entryMap = new Map<string, ExportTrackingEntry>();
    for (const e of prev?.entries || []) entryMap.set(e.invoiceId, e);
    for (const e of job.entries) entryMap.set(e.invoiceId, e);

    const mergedIds = Array.from(
      new Set([...(prev?.exportedInvoiceIds || []), ...job.entries.map((e) => e.invoiceId)])
    );

    await writeExportTrackingToStore({
      operationId: job.organizationId,
      lastExportedAt: job.updatedAt,
      templateSha256: job.templateSha256 || prev?.templateSha256 || '',
      exportedInvoiceIds: mergedIds,
      entries: Array.from(entryMap.values()),
      batches: [newBatch, ...(prev?.batches || [])],
    });
    changed = true;
  }

  return changed;
}
