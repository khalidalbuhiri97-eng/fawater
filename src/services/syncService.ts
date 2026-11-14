import {
  CustomField,
  ExportBatchRecord,
  InvoiceRecord,
  Operation,
  SyncOverview,
  SyncStatus,
} from '../types';
import {
  getExportFileFromStore,
  getMetaValue,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  readAllOrganizationsFromStore,
  setMetaValue,
  STORE_NAMES,
  SyncEntityType,
  SyncQueueItem,
  writeExportTrackingToStore,
  readExportTrackingFromStore,
} from './localStore';

const SYNC_ORDER: Record<SyncEntityType, number> = {
  template: 1,
  organization: 2,
  custom_field: 3,
  invoice: 4,
  attachment: 5,
  export_batch: 6,
  delete_custom_field: 7,
  delete_invoice: 8,
  delete_organization: 9,
};

let currentOverview: SyncOverview = {
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  supabaseConfigured: false,
  supabaseConnected: false,
  pendingCount: 0,
  failedCount: 0,
  syncingCount: 0,
  status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'local_only',
};

const listeners = new Set<(overview: SyncOverview) => void>();
let syncInProgress = false;

function notifyListeners() {
  for (const cb of listeners) {
    try {
      cb({ ...currentOverview });
    } catch {
      // ignore listener errors
    }
  }
}

export function subscribeSyncStatus(cb: (overview: SyncOverview) => void): () => void {
  listeners.add(cb);
  cb({ ...currentOverview });
  return () => {
    listeners.delete(cb);
  };
}

export function getSyncOverview(): SyncOverview {
  return { ...currentOverview };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function refreshSyncOverview(): Promise<SyncOverview> {
  const queue = await idbGetAll<SyncQueueItem>(STORE_NAMES.SYNC_QUEUE);
  const pendingCount = queue.filter((q) => q.status === 'pending').length;
  const failedCount = queue.filter((q) => q.status === 'failed').length;
  const syncingCount = queue.filter((q) => q.status === 'syncing').length;
  const lastSyncAt = (await getMetaValue<string>('last_sync_at')) || currentOverview.lastSyncAt;
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  let status: SyncOverview['status'] = 'local_only';
  if (!isOnline) {
    status = 'offline';
  } else if (syncingCount > 0 || syncInProgress) {
    status = 'syncing';
  } else if (failedCount > 0) {
    status = 'failed';
  } else if (pendingCount > 0) {
    status = 'pending';
  } else if (currentOverview.supabaseConnected) {
    status = 'synced';
  } else {
    status = 'local_only';
  }

  const lastFailed = queue.find((q) => q.status === 'failed' && q.lastError);

  currentOverview = {
    ...currentOverview,
    isOnline,
    pendingCount,
    failedCount,
    syncingCount,
    status,
    lastSyncAt,
    lastError: lastFailed?.lastError || currentOverview.lastError,
  };
  notifyListeners();
  return { ...currentOverview };
}

export async function enqueueSyncTask(
  entityType: SyncEntityType,
  entityId: string,
  payload: any,
  organizationId?: string
): Promise<void> {
  const key = `${entityType}:${entityId}`;
  const now = new Date().toISOString();
  const existing = await idbGet<SyncQueueItem>(STORE_NAMES.SYNC_QUEUE, key);

  // If deleting an entity, drop any pending upsert for that same entity
  if (entityType === 'delete_invoice') {
    await idbDelete(STORE_NAMES.SYNC_QUEUE, `invoice:${entityId}`);
    await idbDelete(STORE_NAMES.SYNC_QUEUE, `attachment:${entityId}`);
  } else if (entityType === 'delete_custom_field') {
    await idbDelete(STORE_NAMES.SYNC_QUEUE, `custom_field:${entityId}`);
  } else if (entityType === 'delete_organization') {
    const all = await idbGetAll<SyncQueueItem>(STORE_NAMES.SYNC_QUEUE);
    for (const item of all) {
      if (item.organizationId === entityId || item.entityId === entityId) {
        await idbDelete(STORE_NAMES.SYNC_QUEUE, item.key);
      }
    }
  }

  const record: SyncQueueItem = {
    key,
    entityType,
    entityId,
    organizationId,
    payload,
    status: 'pending',
    attempts: existing?.attempts || 0,
    lastError: undefined,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await idbPut(STORE_NAMES.SYNC_QUEUE, record);
  await refreshSyncOverview();
}

export async function checkSupabaseServerStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  error?: string;
}> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    currentOverview = { ...currentOverview, isOnline: false };
    await refreshSyncOverview();
    return { configured: currentOverview.supabaseConfigured, connected: false, error: 'أنت غير متصل بالإنترنت' };
  }

  try {
    const res = await fetch('/api/supabase/status', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    const configured = Boolean(data?.configured);
    const connected = Boolean(res.ok && data?.connected);
    currentOverview = {
      ...currentOverview,
      isOnline: true,
      supabaseConfigured: configured,
      supabaseConnected: connected,
      lastError: connected ? undefined : data?.error,
    };
    await refreshSyncOverview();
    return { configured, connected, error: data?.error };
  } catch (err: any) {
    currentOverview = {
      ...currentOverview,
      supabaseConnected: false,
      lastError: err?.message || 'تعذر التحقق من اتصال Supabase',
    };
    await refreshSyncOverview();
    return { configured: false, connected: false, error: err?.message };
  }
}

async function updateEntitySyncStatusLocally(
  entityType: SyncEntityType,
  entityId: string,
  organizationId: string | undefined,
  status: SyncStatus,
  syncError?: string
): Promise<void> {
  if (entityType === 'organization') {
    const org = await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, entityId);
    if (org) {
      await idbPut(STORE_NAMES.ORGANIZATIONS, { ...org, syncStatus: status, syncError });
    }
  } else if (entityType === 'invoice' && organizationId) {
    const org = await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, organizationId);
    if (org) {
      const updatedInvoices = (org.invoices || []).map((inv) =>
        inv.id === entityId ? { ...inv, syncStatus: status, syncError } : inv
      );
      await idbPut(STORE_NAMES.ORGANIZATIONS, { ...org, invoices: updatedInvoices });
    }
  } else if (entityType === 'export_batch' && organizationId) {
    const tracking = await readExportTrackingFromStore(organizationId);
    if (tracking) {
      const batches = (tracking.batches || []).map((b) =>
        b.id === entityId ? { ...b, syncStatus: status } : b
      );
      await writeExportTrackingToStore({ ...tracking, batches });
    }
  }
}

async function executeQueueItem(item: SyncQueueItem): Promise<void> {
  switch (item.entityType) {
    case 'template': {
      const res = await fetch('/api/supabase/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'organization': {
      const org = (await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, item.entityId)) || item.payload;
      const res = await fetch('/api/supabase/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: org.id,
          name: org.name,
          activityType: org.activityType,
          excelFileName: org.excelFileName,
          createdAt: org.createdAt,
          updatedAt: org.updatedAt,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'custom_field': {
      const res = await fetch('/api/supabase/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: item.organizationId,
          field: item.payload as CustomField,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'delete_custom_field': {
      const res = await fetch(`/api/supabase/custom-fields/${encodeURIComponent(item.entityId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'invoice': {
      const org = await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, item.organizationId || '');
      const latestInvoice =
        org?.invoices?.find((inv) => inv.id === item.entityId) || (item.payload.invoice as InvoiceRecord);
      const orgMeta = org || item.payload.organization;
      const res = await fetch('/api/supabase/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization: {
            id: orgMeta.id,
            name: orgMeta.name,
            activityType: orgMeta.activityType,
            excelFileName: orgMeta.excelFileName,
            customFields: orgMeta.customFields || [],
          },
          invoice: { ...latestInvoice, imageBase64: undefined },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'attachment': {
      const img = await idbGet<any>(STORE_NAMES.INVOICE_IMAGES, item.entityId);
      const imageBase64 = img?.imageBase64 || item.payload?.imageBase64;
      if (!imageBase64) return;
      const res = await fetch('/api/supabase/attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: item.organizationId || img?.organizationId,
          invoiceId: item.entityId,
          imageBase64,
          mimeType: img?.imageMimeType || item.payload?.mimeType || 'image/jpeg',
          fileName: img?.fileName || item.payload?.fileName || 'invoice.jpg',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.storagePath && item.organizationId) {
        const org = await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, item.organizationId);
        if (org) {
          const updated = org.invoices.map((inv) =>
            inv.id === item.entityId ? { ...inv, storagePath: data.storagePath } : inv
          );
          await idbPut(STORE_NAMES.ORGANIZATIONS, { ...org, invoices: updated });
        }
      }
      break;
    }
    case 'export_batch': {
      const batch = item.payload as ExportBatchRecord;
      const fileRec = await getExportFileFromStore(batch.id);
      const xlsxBase64 = fileRec?.buffer ? arrayBufferToBase64(fileRec.buffer) : undefined;
      const res = await fetch('/api/supabase/exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId: batch.id,
          organizationId: batch.organizationId,
          fileName: batch.fileName,
          templateSha256: batch.templateSha256,
          salesCount: batch.salesCount,
          purchasesCount: batch.purchasesCount,
          exportedAt: batch.exportedAt,
          entries: batch.entries,
          xlsxBase64,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'delete_invoice': {
      const res = await fetch(`/api/supabase/invoices/${encodeURIComponent(item.entityId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
    case 'delete_organization': {
      const res = await fetch(
        `/api/supabase/organizations/${encodeURIComponent(item.entityId)}?confirm=true`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      break;
    }
  }
}

export async function syncAllPending(): Promise<{ synced: number; failed: number; skipped: boolean }> {
  if (syncInProgress) {
    return { synced: 0, failed: 0, skipped: true };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await refreshSyncOverview();
    return { synced: 0, failed: 0, skipped: true };
  }

  syncInProgress = true;
  await refreshSyncOverview();

  let synced = 0;
  let failed = 0;

  try {
    const status = await checkSupabaseServerStatus();
    if (!status.configured || !status.connected) {
      return { synced: 0, failed: 0, skipped: true };
    }

    const queue = await idbGetAll<SyncQueueItem>(STORE_NAMES.SYNC_QUEUE);
    const ordered = queue.sort((a, b) => {
      const diff = (SYNC_ORDER[a.entityType] || 99) - (SYNC_ORDER[b.entityType] || 99);
      return diff !== 0 ? diff : a.createdAt.localeCompare(b.createdAt);
    });

    for (const item of ordered) {
      const syncingItem: SyncQueueItem = {
        ...item,
        status: 'syncing',
        updatedAt: new Date().toISOString(),
      };
      await idbPut(STORE_NAMES.SYNC_QUEUE, syncingItem);
      await updateEntitySyncStatusLocally(item.entityType, item.entityId, item.organizationId, 'syncing');
      await refreshSyncOverview();

      try {
        await executeQueueItem(syncingItem);
        await idbDelete(STORE_NAMES.SYNC_QUEUE, item.key);
        await updateEntitySyncStatusLocally(item.entityType, item.entityId, item.organizationId, 'synced');
        synced++;
      } catch (err: any) {
        const errMsg = err?.message || 'فشل المزامنة مع Supabase';
        const failedItem: SyncQueueItem = {
          ...item,
          status: 'failed',
          attempts: (item.attempts || 0) + 1,
          lastError: errMsg,
          updatedAt: new Date().toISOString(),
        };
        await idbPut(STORE_NAMES.SYNC_QUEUE, failedItem);
        await updateEntitySyncStatusLocally(
          item.entityType,
          item.entityId,
          item.organizationId,
          'failed',
          errMsg
        );
        failed++;
      }
    }

    if (synced > 0 || ordered.length === 0) {
      const now = new Date().toISOString();
      await setMetaValue('last_sync_at', now);
      currentOverview = { ...currentOverview, lastSyncAt: now };
    }
  } finally {
    syncInProgress = false;
    await refreshSyncOverview();
  }

  return { synced, failed, skipped: false };
}

/**
 * Safely merges remote Supabase records into IndexedDB on startup without overwriting
 * un-synced local pending/failed records.
 */
export async function pullFromSupabaseAndMerge(): Promise<boolean> {
  const status = await checkSupabaseServerStatus();
  if (!status.configured || !status.connected) return false;

  try {
    const res = await fetch('/api/supabase/bootstrap', { cache: 'no-store' });
    if (!res.ok) return false;
    const json = await res.json();
    if (!json.success || !json.data) return false;

    const {
      organizations = [],
      invoices = [],
      invoice_items = [],
      invoice_attachments = [],
      custom_fields = [],
      invoice_custom_values = [],
      export_batches = [],
      export_batch_items = [],
    } = json.data;

    const queue = await idbGetAll<SyncQueueItem>(STORE_NAMES.SYNC_QUEUE);
    const pendingOrgDeletes = new Set(
      queue.filter((q) => q.entityType === 'delete_organization').map((q) => q.entityId)
    );
    const pendingInvDeletes = new Set(
      queue.filter((q) => q.entityType === 'delete_invoice').map((q) => q.entityId)
    );
    const pendingInvUpserts = new Set(
      queue.filter((q) => q.entityType === 'invoice').map((q) => q.entityId)
    );

    const localOrgs = await readAllOrganizationsFromStore();
    const localOrgMap = new Map(localOrgs.map((o) => [o.id, o]));

    for (const remoteOrg of organizations) {
      if (pendingOrgDeletes.has(remoteOrg.id)) continue;

      const orgFields: CustomField[] = custom_fields
        .filter((cf: any) => cf.organization_id === remoteOrg.id)
        .map((cf: any) => ({
          id: cf.id,
          name: cf.name,
          type: cf.field_type,
          required: Boolean(cf.is_required),
          aiExtract: Boolean(cf.ai_extract),
          manual: Boolean(cf.manual_entry),
          excelSheet: cf.excel_sheet,
          excelColumn: cf.excel_column,
          options: cf.options || undefined,
        }));

      const orgRemoteInvoices: InvoiceRecord[] = invoices
        .filter((inv: any) => inv.organization_id === remoteOrg.id && !pendingInvDeletes.has(inv.id))
        .map((inv: any) => {
          const items = invoice_items
            .filter((it: any) => it.invoice_id === inv.id)
            .map((it: any) => ({
              id: it.id,
              name: it.name,
              code: it.code || undefined,
              quantity: it.quantity ?? undefined,
              unit: it.unit || undefined,
              unitPrice: it.unit_price ?? undefined,
              discount: it.discount ?? undefined,
              tax: it.tax ?? undefined,
              total: it.total ?? undefined,
            }));

          const att = invoice_attachments.find((a: any) => a.invoice_id === inv.id);
          const customVals: Record<string, any> = { ...(inv.custom_fields_values || {}) };
          for (const icv of invoice_custom_values) {
            if (icv.invoice_id === inv.id) {
              customVals[icv.custom_field_id] = icv.value;
            }
          }

          return {
            id: inv.id,
            organizationId: inv.organization_id,
            documentType: inv.document_type,
            entryMethod: inv.entry_method || undefined,
            invoiceNumber: inv.invoice_number || '',
            invoiceDate: inv.invoice_date || '',
            day: inv.day || '',
            issuerName: inv.issuer_name || '',
            clientName: inv.client_name || '',
            issuerTaxId: inv.issuer_tax_id || '',
            clientTaxId: inv.client_tax_id || '',
            currency: inv.currency || '',
            subtotal: inv.subtotal ?? undefined,
            taxAmount: inv.tax_amount ?? undefined,
            taxRate: inv.tax_rate ?? undefined,
            discount: inv.discount ?? undefined,
            grandTotal: inv.grand_total ?? undefined,
            cashSales: inv.cash_sales ?? undefined,
            networkSales: inv.network_sales ?? undefined,
            cashBalance: inv.cash_balance ?? undefined,
            cashBoxBalance: inv.cash_box_balance ?? undefined,
            networkBalance: inv.network_balance ?? undefined,
            balance: inv.balance ?? undefined,
            notes: inv.notes || '',
            classificationReason: inv.classification_reason || '',
            status: inv.status,
            errorMessage: inv.error_message || undefined,
            items,
            customFieldsValues: customVals,
            extraColumnsData: inv.extra_columns_data || {},
            hasImage: Boolean(att),
            storagePath: att?.storage_path,
            imageFileName: att?.file_name,
            imageMimeType: att?.mime_type,
            imageFileSize: att?.file_size,
            syncStatus: 'synced' as SyncStatus,
            createdAt: String(inv.created_at || '').split('T')[0],
            updatedAt: String(inv.updated_at || '').split('T')[0],
          };
        });

      const localOrg = localOrgMap.get(remoteOrg.id);
      let mergedInvoices = orgRemoteInvoices;

      if (localOrg) {
        const localInvMap = new Map((localOrg.invoices || []).map((i) => [i.id, i]));
        const mergedMap = new Map<string, InvoiceRecord>();
        for (const rInv of orgRemoteInvoices) {
          const lInv = localInvMap.get(rInv.id);
          // Preserve local pending/failed edit over remote snapshot
          if (lInv && (pendingInvUpserts.has(lInv.id) || lInv.syncStatus === 'pending' || lInv.syncStatus === 'failed')) {
            mergedMap.set(lInv.id, lInv);
          } else {
            mergedMap.set(rInv.id, rInv);
          }
        }
        // Keep local-only invoices not yet pushed
        for (const lInv of localOrg.invoices || []) {
          if (!mergedMap.has(lInv.id) && !pendingInvDeletes.has(lInv.id)) {
            mergedMap.set(lInv.id, lInv);
          }
        }
        mergedInvoices = Array.from(mergedMap.values());
      }

      const mergedOrg: Operation = {
        id: remoteOrg.id,
        name: remoteOrg.name,
        activityType: remoteOrg.activity_type,
        excelFileName: remoteOrg.excel_file_name,
        createdAt: String(remoteOrg.created_at || '').split('T')[0],
        updatedAt: String(remoteOrg.updated_at || '').split('T')[0],
        templateType: 'official',
        customFields: orgFields.length > 0 ? orgFields : localOrg?.customFields || [],
        invoices: mergedInvoices,
        syncStatus: 'synced',
      };
      await idbPut(STORE_NAMES.ORGANIZATIONS, mergedOrg);

      // Merge export batches for this organization
      const remoteBatches: ExportBatchRecord[] = export_batches
        .filter((b: any) => b.organization_id === remoteOrg.id)
        .map((b: any) => {
          const items = export_batch_items
            .filter((bi: any) => bi.export_batch_id === b.id)
            .map((bi: any) => ({
              invoiceId: bi.invoice_id,
              operationId: remoteOrg.id,
              sheetName: bi.sheet_name,
              rowNumber: bi.row_number,
              exportedAt: b.exported_at,
            }));
          return {
            id: b.id,
            organizationId: b.organization_id,
            fileName: b.file_name,
            templateSha256: b.template_sha256,
            storagePath: b.storage_path || undefined,
            exportedCount: b.exported_count,
            salesCount: b.sales_count,
            purchasesCount: b.purchases_count,
            exportedAt: b.exported_at,
            entries: items,
            syncStatus: 'synced' as SyncStatus,
          };
        });

      if (remoteBatches.length > 0) {
        const localTracking = await readExportTrackingFromStore(remoteOrg.id);
        const batchMap = new Map<string, ExportBatchRecord>();
        for (const lb of localTracking?.batches || []) batchMap.set(lb.id, lb);
        for (const rb of remoteBatches) batchMap.set(rb.id, rb);

        const allBatches = Array.from(batchMap.values()).sort((a, b) =>
          b.exportedAt.localeCompare(a.exportedAt)
        );
        const allEntries = allBatches.flatMap((b) => b.entries);
        const allIds = Array.from(new Set(allEntries.map((e) => e.invoiceId)));
        await writeExportTrackingToStore({
          operationId: remoteOrg.id,
          lastExportedAt: allBatches[0]?.exportedAt || new Date().toISOString(),
          templateSha256: allBatches[0]?.templateSha256 || '',
          exportedInvoiceIds: allIds,
          entries: allEntries,
          batches: allBatches,
        });
      }
    }

    await refreshSyncOverview();
    return true;
  } catch (err) {
    console.warn('Supabase bootstrap merge warning:', err);
    return false;
  }
}

let listenersAttached = false;

export function initOnlineSyncListeners(): void {
  if (typeof window === 'undefined' || listenersAttached) return;
  listenersAttached = true;

  window.addEventListener('online', () => {
    currentOverview = { ...currentOverview, isOnline: true };
    syncAllPending().catch(() => {});
  });

  window.addEventListener('offline', () => {
    currentOverview = { ...currentOverview, isOnline: false, status: 'offline' };
    notifyListeners();
  });
}
