import { Operation, InvoiceRecord, ActivityType, ExportTrackingEntry, ExportTrackingRecord } from '../types';
import { clearLegacyTemplateCaches } from './templateService';

const STORAGE_KEY = 'sooq_operations_db_v2';
const EXPORT_TRACKING_KEY = 'fawater_export_tracking_v1';

const IMAGES_DB_NAME = 'fawater_images_db';
const IMAGES_DB_VERSION = 1;
const IMAGES_STORE_NAME = 'invoice_images';

interface StoredImageRecord {
  invoiceId: string;
  imageBase64: string;
  imageMimeType: string;
  updatedAt: string;
}

function openImagesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB غير متوفر في هذه البيئة'));
      return;
    }
    const req = indexedDB.open(IMAGES_DB_NAME, IMAGES_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMAGES_STORE_NAME)) {
        db.createObjectStore(IMAGES_STORE_NAME, { keyPath: 'invoiceId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('فشل فتح قاعدة بيانات صور الفواتير'));
  });
}

export async function saveInvoiceImage(
  invoiceId: string,
  imageBase64: string,
  imageMimeType: string = 'image/jpeg'
): Promise<void> {
  if (!imageBase64) return;
  const db = await openImagesDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IMAGES_STORE_NAME);
    const req = store.put({
      invoiceId,
      imageBase64,
      imageMimeType,
      updatedAt: new Date().toISOString(),
    } as StoredImageRecord);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('فشل حفظ صورة الفاتورة في IndexedDB'));
  });
}

export async function getInvoiceImage(
  invoiceId: string
): Promise<{ imageBase64: string; imageMimeType: string } | null> {
  try {
    const db = await openImagesDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE_NAME, 'readonly');
      const store = tx.objectStore(IMAGES_STORE_NAME);
      const req = store.get(invoiceId);
      req.onsuccess = () => {
        const res = req.result as StoredImageRecord | undefined;
        resolve(res ? { imageBase64: res.imageBase64, imageMimeType: res.imageMimeType } : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function deleteInvoiceImage(invoiceId: string): Promise<void> {
  try {
    const db = await openImagesDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IMAGES_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGES_STORE_NAME);
      const req = store.delete(invoiceId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore cleanup failures
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

function stripHeavyFieldsForStorage(ops: Operation[]): Operation[] {
  return ops.map((op) => {
    const { excelBase64: _ignoredExcel, ...restOp } = op as any;
    return {
      ...restOp,
      templateType: 'official' as const,
      invoices: (op.invoices || []).map((inv) => {
        const { imageBase64, ...restInv } = inv;
        return {
          ...restInv,
          hasImage: Boolean(inv.hasImage || imageBase64),
        };
      }),
    };
  });
}

async function migrateLegacyImagesToIndexedDb(ops: Operation[]): Promise<boolean> {
  let migratedAny = false;
  for (const op of ops) {
    for (const inv of op.invoices || []) {
      if (inv.imageBase64) {
        try {
          await saveInvoiceImage(inv.id, inv.imageBase64, inv.imageMimeType || 'image/jpeg');
          migratedAny = true;
        } catch (err) {
          console.error('Failed migrating legacy invoice image to IndexedDB:', inv.id, err);
        }
      }
    }
  }
  return migratedAny;
}

export function getOperations(): Operation[] {
  clearLegacyTemplateCaches();
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) {
      const defaultOp = createOperationObject('حسابات المؤسسة', 'تجارة عامة');
      saveOperations([defaultOp]);
      return [defaultOp];
    }
    const parsed: Operation[] = JSON.parse(data);

    // If legacy records still contain inline base64 images, migrate them cleanly to IndexedDB
    const hasInlineImages = parsed.some(
      (op) => (op as any).excelBase64 || (op.invoices || []).some((inv) => Boolean(inv.imageBase64))
    );
    if (hasInlineImages) {
      migrateLegacyImagesToIndexedDb(parsed).then(() => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(stripHeavyFieldsForStorage(parsed)));
        } catch (err) {
          console.error('Failed compacting localStorage after image migration:', err);
        }
      });
    }

    return parsed.map((op) => ({
      ...op,
      templateType: 'official' as const,
    }));
  } catch (e) {
    console.error('Error reading operations:', e);
    throw new Error('تعذر قراءة بيانات العمليات من التخزين المحلي.');
  }
}

export function saveOperations(ops: Operation[]) {
  clearLegacyTemplateCaches();

  // Persist any inline images in memory to IndexedDB asynchronously (without blocking metadata save)
  for (const op of ops) {
    for (const inv of op.invoices || []) {
      if (inv.imageBase64) {
        saveInvoiceImage(inv.id, inv.imageBase64, inv.imageMimeType || 'image/jpeg').catch((err) => {
          console.error('Error saving invoice image to IndexedDB:', err);
        });
      }
    }
  }

  const sanitized = stripHeavyFieldsForStorage(ops);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (e: any) {
    throw new Error(
      'تجاوزت البيانات الحد المتاح في التخزين المحلي (localStorage). يرجى مراجعة البيانات أو تصدير الملفات وحذف العمليات غير المطلوبة.'
    );
  }
}

export async function saveOperationWithImages(op: Operation): Promise<void> {
  for (const inv of op.invoices || []) {
    if (inv.imageBase64) {
      await saveInvoiceImage(inv.id, inv.imageBase64, inv.imageMimeType || 'image/jpeg');
    }
  }
  saveOperation(op);
}

export function getOperationById(id: string): Operation | undefined {
  const ops = getOperations();
  return ops.find((o) => o.id === id);
}

export function saveOperation(op: Operation) {
  const ops = getOperations();
  const index = ops.findIndex((o) => o.id === op.id);
  const updatedOp: Operation = {
    ...op,
    templateType: 'official',
    updatedAt: new Date().toISOString().split('T')[0],
  };
  if (index >= 0) {
    ops[index] = updatedOp;
  } else {
    ops.unshift(updatedOp);
  }
  saveOperations(ops);
}

export function deleteOperation(id: string) {
  const ops = getOperations();
  const target = ops.find((o) => o.id === id);
  if (target) {
    for (const inv of target.invoices || []) {
      deleteInvoiceImage(inv.id).catch(() => {});
    }
  }
  const filtered = ops.filter((o) => o.id !== id);
  saveOperations(filtered);
  clearExportTracking(id);
}

export function createOperationObject(name: string, activityType: ActivityType): Operation {
  const today = new Date().toISOString().split('T')[0];
  const safeFileBase = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_') || 'fawater';
  return {
    id: 'op_' + Date.now() + Math.random().toString(36).substring(2, 6),
    name: name.trim(),
    activityType,
    createdAt: today,
    updatedAt: today,
    templateType: 'official',
    customFields: [],
    invoices: [],
    excelFileName: `${safeFileBase}_fawater.xlsx`,
  };
}

// --- Independent Export Tracking ---

function readAllExportTracking(): Record<string, ExportTrackingRecord> {
  try {
    const raw = localStorage.getItem(EXPORT_TRACKING_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getExportTracking(operationId: string): ExportTrackingRecord | null {
  const all = readAllExportTracking();
  return all[operationId] || null;
}

export function recordExportBatch(
  operationId: string,
  templateSha256: string,
  entries: ExportTrackingEntry[]
): ExportTrackingRecord {
  const all = readAllExportTracking();
  const prev = all[operationId];
  const mergedIds = Array.from(
    new Set([...(prev?.exportedInvoiceIds || []), ...entries.map((e) => e.invoiceId)])
  );
  const entryMap = new Map<string, ExportTrackingEntry>();
  for (const e of prev?.entries || []) {
    entryMap.set(e.invoiceId, e);
  }
  for (const e of entries) {
    entryMap.set(e.invoiceId, e);
  }

  const record: ExportTrackingRecord = {
    operationId,
    lastExportedAt: new Date().toISOString(),
    templateSha256,
    exportedInvoiceIds: mergedIds,
    entries: Array.from(entryMap.values()),
  };
  all[operationId] = record;
  try {
    localStorage.setItem(EXPORT_TRACKING_KEY, JSON.stringify(all));
  } catch {
    // non-fatal tracking error
  }
  return record;
}

export function clearExportTracking(operationId: string): void {
  try {
    const all = readAllExportTracking();
    delete all[operationId];
    localStorage.setItem(EXPORT_TRACKING_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}
