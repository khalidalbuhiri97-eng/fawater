import { ExportTrackingRecord, Operation, SyncStatus } from '../types';
import { TemplateSheetInfo } from './templateService';

export let LOCAL_DB_NAME = 'fawater_local_store_v1_signed_out';

/** Isolate offline records and queued sync work between authenticated accounts. */
export function setLocalStoreUserScope(userId: string | null): void {
  const scope = userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : 'signed_out';
  if (LOCAL_DB_NAME !== `fawater_local_store_v1_${scope}`) {
    LOCAL_DB_NAME = `fawater_local_store_v1_${scope}`;
    dbPromise = null;
  }
}
export const LOCAL_DB_VERSION = 1;

export const STORE_NAMES = {
  ORGANIZATIONS: 'organizations',
  INVOICE_IMAGES: 'invoice_images',
  EXPORT_TRACKING: 'export_tracking',
  EXPORT_FILES: 'export_files',
  TEMPLATE_VERSIONS: 'template_versions',
  SYNC_QUEUE: 'sync_queue',
  META: 'meta',
} as const;

export interface StoredImageRecord {
  invoiceId: string;
  organizationId?: string;
  imageBase64: string;
  imageMimeType: string;
  fileName?: string;
  fileSize?: number;
  updatedAt: string;
}

export interface StoredExportFileRecord {
  batchId: string;
  organizationId: string;
  fileName: string;
  buffer: ArrayBuffer;
  createdAt: string;
}

export interface TemplateVersionHistoryItem {
  sha256: string;
  version: string;
  source: 'local' | 'github';
  filePath: string;
  isActive: boolean;
  updatedAt: string;
  sheets: TemplateSheetInfo[];
}

export type SyncEntityType =
  | 'organization'
  | 'delete_organization'
  | 'custom_field'
  | 'delete_custom_field'
  | 'invoice'
  | 'delete_invoice'
  | 'attachment'
  | 'export_batch'
  | 'template';

export interface SyncQueueItem {
  key: string; // e.g., `${entityType}:${entityId}`
  entityType: SyncEntityType;
  entityId: string;
  organizationId?: string;
  payload: any;
  status: SyncStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id?: string | null): boolean {
  return Boolean(id && UUID_REGEX.test(id));
}

export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Deterministically converts any legacy string ID (e.g., op_1234, inv_5678)
 * into a stable RFC 4122 UUID so repeated migrations are 100% idempotent.
 */
export function toStableUuid(rawId: string): string {
  if (isValidUuid(rawId)) return rawId.toLowerCase();
  // FNV-1a style 128-bit deterministic hash across 4 independent 32-bit seeds
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35];
  const out = new Uint8Array(16);
  for (let s = 0; s < 4; s++) {
    let h = seeds[s];
    for (let i = 0; i < rawId.length; i++) {
      h ^= rawId.charCodeAt(i) + ((s + 1) * 31);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out[s * 4] = (h >>> 24) & 0xff;
    out[s * 4 + 1] = (h >>> 16) & 0xff;
    out[s * 4 + 2] = (h >>> 8) & 0xff;
    out[s * 4 + 3] = h & 0xff;
  }
  out[6] = (out[6] & 0x0f) | 0x40;
  out[8] = (out[8] & 0x3f) | 0x80;
  const hex = Array.from(out).map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

// --- IndexedDB + Node In-Memory Fallback ---
const memoryStores: Record<string, Map<string, any>> = {
  [STORE_NAMES.ORGANIZATIONS]: new Map(),
  [STORE_NAMES.INVOICE_IMAGES]: new Map(),
  [STORE_NAMES.EXPORT_TRACKING]: new Map(),
  [STORE_NAMES.EXPORT_FILES]: new Map(),
  [STORE_NAMES.TEMPLATE_VERSIONS]: new Map(),
  [STORE_NAMES.SYNC_QUEUE]: new Map(),
  [STORE_NAMES.META]: new Map(),
};

const KEY_PATHS: Record<string, string> = {
  [STORE_NAMES.ORGANIZATIONS]: 'id',
  [STORE_NAMES.INVOICE_IMAGES]: 'invoiceId',
  [STORE_NAMES.EXPORT_TRACKING]: 'operationId',
  [STORE_NAMES.EXPORT_FILES]: 'batchId',
  [STORE_NAMES.TEMPLATE_VERSIONS]: 'sha256',
  [STORE_NAMES.SYNC_QUEUE]: 'key',
  [STORE_NAMES.META]: 'key',
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openLocalDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [storeName, keyPath] of Object.entries(KEY_PATHS)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('فشل فتح قاعدة البيانات المحلية IndexedDB'));
    };
  });
  return dbPromise;
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  if (!hasIndexedDb()) {
    return (memoryStores[storeName]?.get(key) as T) || null;
  }
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(storeName: string): Promise<T[]> {
  if (!hasIndexedDb()) {
    return Array.from(memoryStores[storeName]?.values() || []) as T[];
  }
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut<T extends Record<string, any>>(storeName: string, value: T): Promise<void> {
  if (!hasIndexedDb()) {
    const keyField = KEY_PATHS[storeName];
    memoryStores[storeName]?.set(String(value[keyField]), structuredCloneSafe(value));
    return;
  }
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  if (!hasIndexedDb()) {
    memoryStores[storeName]?.delete(key);
    return;
  }
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbClearAllForTest(): Promise<void> {
  if (!hasIndexedDb()) {
    for (const m of Object.values(memoryStores)) m.clear();
    return;
  }
  const db = await openLocalDb();
  for (const storeName of Object.values(STORE_NAMES)) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

function structuredCloneSafe<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof ArrayBuffer) return obj.slice(0) as unknown as T;
  if (Array.isArray(obj)) return obj.map(structuredCloneSafe) as unknown as T;
  const copy: any = {};
  for (const [k, v] of Object.entries(obj)) {
    copy[k] = v instanceof ArrayBuffer ? v.slice(0) : structuredCloneSafe(v);
  }
  return copy;
}

// Convenience helpers for Export Tracking & Files & Template Versions
export async function readExportTrackingFromStore(
  operationId: string
): Promise<ExportTrackingRecord | null> {
  return idbGet<ExportTrackingRecord>(STORE_NAMES.EXPORT_TRACKING, operationId);
}

export async function writeExportTrackingToStore(record: ExportTrackingRecord): Promise<void> {
  await idbPut(STORE_NAMES.EXPORT_TRACKING, record);
}

export async function saveExportFileToStore(record: StoredExportFileRecord): Promise<void> {
  await idbPut(STORE_NAMES.EXPORT_FILES, record);
}

export async function getExportFileFromStore(
  batchId: string
): Promise<StoredExportFileRecord | null> {
  return idbGet<StoredExportFileRecord>(STORE_NAMES.EXPORT_FILES, batchId);
}

export async function getAllExportTrackingFromStore(): Promise<ExportTrackingRecord[]> {
  return idbGetAll<ExportTrackingRecord>(STORE_NAMES.EXPORT_TRACKING);
}

export async function saveTemplateVersionHistory(item: TemplateVersionHistoryItem): Promise<void> {
  const existing = await idbGetAll<TemplateVersionHistoryItem>(STORE_NAMES.TEMPLATE_VERSIONS);
  for (const row of existing) {
    if (row.sha256 !== item.sha256 && row.isActive) {
      await idbPut(STORE_NAMES.TEMPLATE_VERSIONS, { ...row, isActive: false });
    }
  }
  await idbPut(STORE_NAMES.TEMPLATE_VERSIONS, item);
}

export async function getTemplateVersionHistory(): Promise<TemplateVersionHistoryItem[]> {
  const list = await idbGetAll<TemplateVersionHistoryItem>(STORE_NAMES.TEMPLATE_VERSIONS);
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getMetaValue<T>(key: string): Promise<T | null> {
  const row = await idbGet<{ key: string; value: T }>(STORE_NAMES.META, key);
  return row ? row.value : null;
}

export async function setMetaValue<T>(key: string, value: T): Promise<void> {
  await idbPut(STORE_NAMES.META, { key, value });
}

export async function readAllOrganizationsFromStore(): Promise<Operation[]> {
  const ops = await idbGetAll<Operation>(STORE_NAMES.ORGANIZATIONS);
  return ops.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
