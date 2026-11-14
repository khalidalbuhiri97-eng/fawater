import {
  ActivityType,
  CustomField,
  ExportBatchRecord,
  ExportTrackingEntry,
  ExportTrackingRecord,
  InvoiceRecord,
  Operation,
} from '../types';
import { clearLegacyTemplateCaches } from './templateService';
import {
  generateUuid,
  getAllExportTrackingFromStore,
  getExportFileFromStore,
  getMetaValue,
  hasIndexedDb,
  idbDelete,
  idbGet,
  idbPut,
  isValidUuid,
  readAllOrganizationsFromStore,
  readExportTrackingFromStore,
  saveExportFileToStore,
  setMetaValue,
  STORE_NAMES,
  StoredImageRecord,
  toStableUuid,
  writeExportTrackingToStore,
} from './localStore';
import {
  enqueueSyncTask,
  initOnlineSyncListeners,
  pullFromSupabaseAndMerge,
  refreshSyncOverview,
  syncAllPending,
} from './syncService';

export const LEGACY_STORAGE_KEY = 'sooq_operations_db_v2';
export const LEGACY_EXPORT_TRACKING_KEY = 'fawater_export_tracking_v1';
const LEGACY_IMAGES_DB_NAME = 'fawater_images_db';
const LEGACY_IMAGES_STORE_NAME = 'invoice_images';

function openLegacyImagesDbIfExists(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!hasIndexedDb()) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(LEGACY_IMAGES_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LEGACY_IMAGES_STORE_NAME)) {
        db.createObjectStore(LEGACY_IMAGES_STORE_NAME, { keyPath: 'invoiceId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function readLegacyImage(invoiceId: string): Promise<{ imageBase64: string; imageMimeType: string } | null> {
  try {
    const db = await openLegacyImagesDbIfExists();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(LEGACY_IMAGES_STORE_NAME, 'readonly');
      const store = tx.objectStore(LEGACY_IMAGES_STORE_NAME);
      const req = store.get(invoiceId);
      req.onsuccess = () => {
        const res = req.result as any;
        resolve(res?.imageBase64 ? { imageBase64: res.imageBase64, imageMimeType: res.imageMimeType || 'image/jpeg' } : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveInvoiceImage(
  invoiceId: string,
  imageBase64: string,
  imageMimeType: string = 'image/jpeg',
  options?: { organizationId?: string; fileName?: string; fileSize?: number; enqueueSync?: boolean }
): Promise<void> {
  if (!imageBase64) return;
  const stableInvId = isValidUuid(invoiceId) ? invoiceId : toStableUuid(invoiceId);
  const record: StoredImageRecord = {
    invoiceId: stableInvId,
    organizationId: options?.organizationId,
    imageBase64,
    imageMimeType,
    fileName: options?.fileName,
    fileSize: options?.fileSize,
    updatedAt: new Date().toISOString(),
  };
  await idbPut(STORE_NAMES.INVOICE_IMAGES, record);

  if (options?.enqueueSync && options.organizationId) {
    await enqueueSyncTask(
      'attachment',
      stableInvId,
      { mimeType: imageMimeType, fileName: options.fileName },
      options.organizationId
    );
  }
}

export async function getInvoiceImage(
  invoiceId: string
): Promise<{ imageBase64: string; imageMimeType: string } | null> {
  try {
    const direct = await idbGet<StoredImageRecord>(STORE_NAMES.INVOICE_IMAGES, invoiceId);
    if (direct?.imageBase64) {
      return { imageBase64: direct.imageBase64, imageMimeType: direct.imageMimeType };
    }
    // Check legacy store fallback if not yet migrated
    const legacy = await readLegacyImage(invoiceId);
    if (legacy) {
      await saveInvoiceImage(invoiceId, legacy.imageBase64, legacy.imageMimeType);
      return legacy;
    }
  } catch {
    // ignore
  }

  // Fallback to Supabase Storage if image exists remotely
  if (isValidUuid(invoiceId) && (typeof navigator === 'undefined' || navigator.onLine)) {
    try {
      const res = await fetch(`/api/supabase/attachments/${encodeURIComponent(invoiceId)}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.imageBase64) {
          await saveInvoiceImage(invoiceId, json.imageBase64, json.mimeType || 'image/jpeg', {
            fileName: json.fileName,
          });
          return { imageBase64: json.imageBase64, imageMimeType: json.mimeType || 'image/jpeg' };
        }
      }
    } catch {
      // offline/unavailable
    }
  }
  return null;
}

export async function deleteInvoiceImage(invoiceId: string): Promise<void> {
  try {
    await idbDelete(STORE_NAMES.INVOICE_IMAGES, invoiceId);
  } catch {
    // ignore
  }
}

export async function hydrateOperationImages(operation: Operation): Promise<Operation> {
  const invoices = operation.invoices || [];
  const hydratedInvoices = await Promise.all(
    invoices.map(async (inv) => {
      if (inv.imageBase64) {
        return { ...inv, hasImage: true };
      }
      const stored = await getInvoiceImage(inv.id);
      if (stored) {
        return {
          ...inv,
          hasImage: true,
          imageBase64: stored.imageBase64,
          imageMimeType: inv.imageMimeType || stored.imageMimeType,
        };
      }
      return inv;
    })
  );
  return { ...operation, invoices: hydratedInvoices };
}

function stripHeavyFieldsForOperationStore(op: Operation): Operation {
  const { excelBase64: _ignoredExcel, ...restOp } = op as any;
  return {
    ...restOp,
    id: isValidUuid(op.id) ? op.id : toStableUuid(op.id),
    templateType: 'official',
    customFields: (op.customFields || []).map((cf) => ({
      ...cf,
      id: isValidUuid(cf.id) ? cf.id : toStableUuid(cf.id),
    })),
    invoices: (op.invoices || []).map((inv) => {
      const { imageBase64, ...restInv } = inv;
      const stableInvId = isValidUuid(inv.id) ? inv.id : toStableUuid(inv.id);
      return {
        ...restInv,
        id: stableInvId,
        organizationId: isValidUuid(op.id) ? op.id : toStableUuid(op.id),
        hasImage: Boolean(inv.hasImage || imageBase64),
        items: (inv.items || []).map((it) => ({
          ...it,
          id: isValidUuid(it.id) ? it.id : toStableUuid(it.id),
        })),
      };
    }),
  };
}

/**
 * Migrates legacy localStorage operations & export tracking + legacy fawater_images_db
 * into IndexedDB `fawater_local_store_v1` idempotently.
 * Preserves legacy keys until IndexedDB persistence completes cleanly without errors.
 */
export async function migrateLegacyData(): Promise<{
  migratedOrgs: number;
  migratedInvoices: number;
  migratedTracking: number;
}> {
  clearLegacyTemplateCaches();
  let migratedOrgs = 0;
  let migratedInvoices = 0;
  let migratedTracking = 0;

  if (typeof localStorage === 'undefined') {
    return { migratedOrgs, migratedInvoices, migratedTracking };
  }

  const alreadyMigrated = await getMetaValue<boolean>('legacy_migrated_v1');
  const rawOps = localStorage.getItem(LEGACY_STORAGE_KEY);
  const rawTracking = localStorage.getItem(LEGACY_EXPORT_TRACKING_KEY);

  if (!rawOps && !rawTracking) {
    if (!alreadyMigrated) await setMetaValue('legacy_migrated_v1', true);
    return { migratedOrgs, migratedInvoices, migratedTracking };
  }

  const orgIdMap = new Map<string, string>();
  const invIdMap = new Map<string, string>();

  if (rawOps) {
    try {
      const legacyOps: Operation[] = JSON.parse(rawOps);
      const existingOps = await readAllOrganizationsFromStore();
      const existingOrgIds = new Set(existingOps.map((o) => o.id));

      for (const oldOp of legacyOps) {
        // Skip empty auto-seeded placeholder org if user never added invoices/fields and name was auto-placeholder
        const newOrgId = toStableUuid(oldOp.id);
        orgIdMap.set(oldOp.id, newOrgId);

        const mappedCustomFields: CustomField[] = (oldOp.customFields || []).map((cf) => ({
          ...cf,
          id: toStableUuid(cf.id),
        }));

        const mappedInvoices: InvoiceRecord[] = [];
        for (const oldInv of oldOp.invoices || []) {
          const newInvId = toStableUuid(oldInv.id);
          invIdMap.set(oldInv.id, newInvId);

          // Migrate inline base64 OR legacy fawater_images_db image to fawater_local_store_v1
          let imgData = oldInv.imageBase64
            ? { imageBase64: oldInv.imageBase64, imageMimeType: oldInv.imageMimeType || 'image/jpeg' }
            : await readLegacyImage(oldInv.id);

          if (imgData?.imageBase64) {
            await saveInvoiceImage(newInvId, imgData.imageBase64, imgData.imageMimeType, {
              organizationId: newOrgId,
              fileName: oldInv.imageFileName,
              enqueueSync: true,
            });
          }

          const { imageBase64: _drop, ...cleanInv } = oldInv;
          const mappedInv: InvoiceRecord = {
            ...cleanInv,
            id: newInvId,
            organizationId: newOrgId,
            hasImage: Boolean(oldInv.hasImage || imgData?.imageBase64),
            syncStatus: 'pending',
            items: (oldInv.items || []).map((it) => ({
              ...it,
              id: toStableUuid(it.id),
            })),
          };
          mappedInvoices.push(mappedInv);
          migratedInvoices++;
        }

        if (!existingOrgIds.has(newOrgId)) {
          const cleanOp: Operation = {
            ...stripHeavyFieldsForOperationStore({
              ...oldOp,
              id: newOrgId,
              customFields: mappedCustomFields,
              invoices: mappedInvoices,
            }),
            syncStatus: 'pending',
          };
          await idbPut(STORE_NAMES.ORGANIZATIONS, cleanOp);
          await enqueueSyncTask('organization', newOrgId, cleanOp, newOrgId);
          for (const cf of mappedCustomFields) {
            await enqueueSyncTask('custom_field', cf.id, cf, newOrgId);
          }
          for (const inv of mappedInvoices) {
            await enqueueSyncTask('invoice', inv.id, { organization: cleanOp, invoice: inv }, newOrgId);
          }
          migratedOrgs++;
        }
      }
    } catch (err) {
      console.error('Legacy operations migration error (preserving source):', err);
      throw err;
    }
  }

  if (rawTracking) {
    try {
      const legacyTrackingAll: Record<string, any> = JSON.parse(rawTracking);
      for (const [oldOpId, oldRec] of Object.entries(legacyTrackingAll)) {
        const newOpId = orgIdMap.get(oldOpId) || toStableUuid(oldOpId);
        const existingTrack = await readExportTrackingFromStore(newOpId);
        if (existingTrack) continue;

        const mappedEntries: ExportTrackingEntry[] = (oldRec.entries || []).map((e: any) => ({
          ...e,
          operationId: newOpId,
          invoiceId: invIdMap.get(e.invoiceId) || toStableUuid(e.invoiceId),
        }));
        const mappedIds = Array.from(new Set(mappedEntries.map((e) => e.invoiceId)));
        const batchId = toStableUuid(`legacy_batch_${newOpId}_${oldRec.lastExportedAt || ''}`);
        const legacyBatch: ExportBatchRecord | null =
          mappedEntries.length > 0
            ? {
                id: batchId,
                organizationId: newOpId,
                fileName: 'fawater_migrated_export.xlsx',
                templateSha256: oldRec.templateSha256 || '',
                exportedCount: mappedEntries.length,
                salesCount: mappedEntries.filter((e) => e.sheetName === 'المبيعات').length,
                purchasesCount: mappedEntries.filter((e) => e.sheetName === 'المشتريات والموردين').length,
                exportedAt: oldRec.lastExportedAt || new Date().toISOString(),
                entries: mappedEntries,
                syncStatus: 'pending',
              }
            : null;

        await writeExportTrackingToStore({
          operationId: newOpId,
          lastExportedAt: oldRec.lastExportedAt || new Date().toISOString(),
          templateSha256: oldRec.templateSha256 || '',
          exportedInvoiceIds: mappedIds,
          entries: mappedEntries,
          batches: legacyBatch ? [legacyBatch] : [],
        });
        migratedTracking++;
      }
    } catch (err) {
      console.error('Legacy tracking migration error (preserving source):', err);
      throw err;
    }
  }

  // Only mark migrated & remove legacy localStorage keys AFTER IndexedDB writes succeed cleanly
  await setMetaValue('legacy_migrated_v1', true);
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_EXPORT_TRACKING_KEY);
  } catch {
    // ignore storage removal errors
  }

  return { migratedOrgs, migratedInvoices, migratedTracking };
}

/**
 * App startup initialization:
 * 1. Attaches online/offline sync listeners
 * 2. Migrates any legacy localStorage / old IndexedDB records safely
 * 3. Attempts non-destructive sync & bootstrap with Supabase if configured and online
 * 4. Returns all organizations (empty array when clean, never injects a fake demo org)
 */
export async function initializeDatabase(): Promise<Operation[]> {
  initOnlineSyncListeners();
  await migrateLegacyData();
  await syncAllPending().catch(() => {});
  await pullFromSupabaseAndMerge().catch(() => {});
  await refreshSyncOverview();
  return readAllOrganizationsFromStore();
}

export async function getOperations(): Promise<Operation[]> {
  return readAllOrganizationsFromStore();
}

export async function getOperationById(id: string): Promise<Operation | undefined> {
  const op = await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, id);
  return op || undefined;
}

export async function saveOperation(op: Operation): Promise<Operation> {
  const prev = await idbGet<Operation>(STORE_NAMES.ORGANIZATIONS, op.id);
  const nowDate = new Date().toISOString().split('T')[0];

  // Store any inline images to IndexedDB and mark attachments for sync
  for (const inv of op.invoices || []) {
    if (inv.imageBase64) {
      const prevImg = await idbGet<StoredImageRecord>(STORE_NAMES.INVOICE_IMAGES, inv.id);
      if (!prevImg || prevImg.imageBase64 !== inv.imageBase64) {
        await saveInvoiceImage(inv.id, inv.imageBase64, inv.imageMimeType || 'image/jpeg', {
          organizationId: op.id,
          fileName: inv.imageFileName,
          fileSize: inv.imageFileSize,
          enqueueSync: true,
        });
      }
    }
  }

  const sanitized = stripHeavyFieldsForOperationStore({
    ...op,
    updatedAt: nowDate,
  });

  // Diff organization metadata, custom fields, and invoices to enqueue minimal precise sync tasks
  const orgMetaChanged =
    !prev ||
    prev.name !== sanitized.name ||
    prev.activityType !== sanitized.activityType ||
    prev.excelFileName !== sanitized.excelFileName;

  if (orgMetaChanged) {
    sanitized.syncStatus = 'pending';
  }

  await idbPut(STORE_NAMES.ORGANIZATIONS, sanitized);

  if (orgMetaChanged) {
    await enqueueSyncTask('organization', sanitized.id, sanitized, sanitized.id);
  }

  // Diff custom fields
  const prevFieldMap = new Map((prev?.customFields || []).map((f) => [f.id, f]));
  const nextFieldMap = new Map((sanitized.customFields || []).map((f) => [f.id, f]));
  for (const [fId, f] of nextFieldMap) {
    const oldF = prevFieldMap.get(fId);
    if (!oldF || JSON.stringify(oldF) !== JSON.stringify(f)) {
      await enqueueSyncTask('custom_field', fId, f, sanitized.id);
    }
  }
  for (const oldFId of prevFieldMap.keys()) {
    if (!nextFieldMap.has(oldFId)) {
      await enqueueSyncTask('delete_custom_field', oldFId, { id: oldFId }, sanitized.id);
    }
  }

  // Diff invoices
  const prevInvMap = new Map((prev?.invoices || []).map((i) => [i.id, i]));
  const nextInvMap = new Map((sanitized.invoices || []).map((i) => [i.id, i]));

  for (const [invId, inv] of nextInvMap) {
    const oldInv = prevInvMap.get(invId);
    if (!oldInv || JSON.stringify(oldInv) !== JSON.stringify(inv)) {
      const invWithPending = { ...inv, syncStatus: 'pending' as const };
      // Persist pending syncStatus on invoice
      const idx = sanitized.invoices.findIndex((x) => x.id === invId);
      if (idx >= 0) sanitized.invoices[idx] = invWithPending;
      await enqueueSyncTask('invoice', invId, { organization: sanitized, invoice: invWithPending }, sanitized.id);
    }
  }
  for (const oldInvId of prevInvMap.keys()) {
    if (!nextInvMap.has(oldInvId)) {
      await deleteInvoiceImage(oldInvId);
      await enqueueSyncTask('delete_invoice', oldInvId, { id: oldInvId }, sanitized.id);
    }
  }

  await idbPut(STORE_NAMES.ORGANIZATIONS, sanitized);
  // Trigger background non-blocking sync
  syncAllPending().catch(() => {});

  return sanitized;
}

export async function deleteOperationConfirmed(id: string, confirmed: boolean): Promise<void> {
  if (!confirmed) {
    throw new Error('يلزم تأكيد حذف المؤسسة صراحة قبل المتابعة.');
  }
  const target = await getOperationById(id);
  if (target) {
    for (const inv of target.invoices || []) {
      await deleteInvoiceImage(inv.id);
    }
  }
  const tracking = await readExportTrackingFromStore(id);
  for (const b of tracking?.batches || []) {
    await idbDelete(STORE_NAMES.EXPORT_FILES, b.id);
  }
  await clearExportTracking(id);
  await idbDelete(STORE_NAMES.ORGANIZATIONS, id);
  await enqueueSyncTask('delete_organization', id, { id }, id);
  syncAllPending().catch(() => {});
}

export function createOperationObject(name: string, activityType: ActivityType): Operation {
  const today = new Date().toISOString().split('T')[0];
  const safeFileBase = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'fawater';
  return {
    id: generateUuid(),
    name: name.trim(),
    activityType,
    createdAt: today,
    updatedAt: today,
    templateType: 'official',
    customFields: [],
    invoices: [],
    excelFileName: `${safeFileBase}_fawater.xlsx`,
    syncStatus: 'pending',
  };
}

// --- Export Batch Tracking & Deduplication ---

export async function getExportTracking(operationId: string): Promise<ExportTrackingRecord | null> {
  return readExportTrackingFromStore(operationId);
}

export async function getAllExportTracking(): Promise<ExportTrackingRecord[]> {
  return getAllExportTrackingFromStore();
}

export async function recordExportBatch(params: {
  batchId: string;
  operationId: string;
  fileName: string;
  templateSha256: string;
  entries: ExportTrackingEntry[];
  salesCount: number;
  purchasesCount: number;
  xlsxBuffer: ArrayBuffer;
}): Promise<ExportTrackingRecord> {
  const prev = await readExportTrackingFromStore(params.operationId);
  const nowIso = new Date().toISOString();

  const newBatch: ExportBatchRecord = {
    id: params.batchId,
    organizationId: params.operationId,
    fileName: params.fileName,
    templateSha256: params.templateSha256,
    exportedCount: params.entries.length,
    salesCount: params.salesCount,
    purchasesCount: params.purchasesCount,
    exportedAt: nowIso,
    entries: params.entries,
    syncStatus: 'pending',
  };

  // Save .xlsx bytes locally for instant re-download from history without re-generating duplicates
  await saveExportFileToStore({
    batchId: params.batchId,
    organizationId: params.operationId,
    fileName: params.fileName,
    buffer: params.xlsxBuffer,
    createdAt: nowIso,
  });

  // Preserve chronological entry history while maintaining unique exportedInvoiceIds
  const entryMap = new Map<string, ExportTrackingEntry>();
  for (const e of prev?.entries || []) entryMap.set(e.invoiceId, e);
  for (const e of params.entries) entryMap.set(e.invoiceId, e);

  const mergedIds = Array.from(
    new Set([...(prev?.exportedInvoiceIds || []), ...params.entries.map((e) => e.invoiceId)])
  );

  const record: ExportTrackingRecord = {
    operationId: params.operationId,
    lastExportedAt: nowIso,
    templateSha256: params.templateSha256,
    exportedInvoiceIds: mergedIds,
    entries: Array.from(entryMap.values()),
    batches: [newBatch, ...(prev?.batches || [])],
  };

  await writeExportTrackingToStore(record);
  await enqueueSyncTask('export_batch', params.batchId, newBatch, params.operationId);
  syncAllPending().catch(() => {});
  return record;
}

export async function getSavedExportFile(batchId: string) {
  return getExportFileFromStore(batchId);
}

export async function clearExportTracking(operationId: string): Promise<void> {
  await idbDelete(STORE_NAMES.EXPORT_TRACKING, operationId);
}
