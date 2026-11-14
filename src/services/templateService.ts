import ExcelJS from 'exceljs';

export const LOCAL_OFFICIAL_TEMPLATE_PATH = 'public/assets/templates/fawater_template.xlsx';
export const LOCAL_OFFICIAL_TEMPLATE_URL = '/assets/templates/fawater_template.xlsx';
export const GITHUB_OFFICIAL_TEMPLATE_URL =
  'https://raw.githubusercontent.com/khalidalbuhiri97-eng/fawater/main/public/assets/templates/fawater_template.xlsx';

const TEMPLATE_DB_NAME = 'fawater_template_db';
const TEMPLATE_DB_VERSION = 1;
const TEMPLATE_STORE_NAME = 'templates';
const OFFICIAL_TEMPLATE_KEY = 'official_template';

const LEGACY_STORAGE_KEYS = [
  'fawater_custom_template_base64',
  'fawater_template_cache_v2',
];

export interface TemplateColumnInfo {
  colNumber: number; // 1-indexed
  colLetter: string;
  name: string;
}

export interface TemplateSheetInfo {
  sheetName: string;
  headerRowNumber: number; // 1-indexed
  dataStartRowNumber: number; // 1-indexed
  totalsRowNumber: number | null; // 1-indexed
  columns: TemplateColumnInfo[];
}

export interface StoredOfficialTemplate {
  key: string;
  buffer: ArrayBuffer;
  sha256: string;
  source: 'local' | 'github';
  localAssetSha256?: string;
  updatedAt: string;
  sheets: TemplateSheetInfo[];
}

export interface TemplateCheckResult {
  success: boolean;
  updated: boolean;
  unchanged: boolean;
  message: string;
  sha256?: string;
  source?: 'local' | 'github';
  sheets?: TemplateSheetInfo[];
}

function columnNumberToLetter(col: number): string {
  let temp = col;
  let letter = '';
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

function getCellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((r) => r.text).join('').trim();
    }
    if ('text' in v) return String((v as any).text || '').trim();
    if ('result' in v) return String((v as any).result ?? '').trim();
    return '';
  }
  return String(v).trim();
}

export async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clearLegacyTemplateCaches(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    for (const key of LEGACY_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

function openTemplateDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB غير مدعوم في هذه البيئة'));
      return;
    }
    const request = indexedDB.open(TEMPLATE_DB_NAME, TEMPLATE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TEMPLATE_STORE_NAME)) {
        db.createObjectStore(TEMPLATE_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('فشل فتح قاعدة بيانات القالب'));
  });
}

async function readStoredTemplate(): Promise<StoredOfficialTemplate | null> {
  try {
    const db = await openTemplateDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TEMPLATE_STORE_NAME, 'readonly');
      const store = tx.objectStore(TEMPLATE_STORE_NAME);
      const req = store.get(OFFICIAL_TEMPLATE_KEY);
      req.onsuccess = () => resolve((req.result as StoredOfficialTemplate) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeStoredTemplate(record: StoredOfficialTemplate): Promise<void> {
  const db = await openTemplateDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEMPLATE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(TEMPLATE_STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('فشل حفظ القالب في IndexedDB'));
  });
}

/**
 * Validates an XLSX buffer against the official Fawater 3-sheet structure
 * and dynamically extracts sheet headers, data start rows, and totals rows.
 */
export async function validateAndInspectTemplateBuffer(buffer: ArrayBuffer): Promise<{
  workbook: ExcelJS.Workbook;
  sheets: TemplateSheetInfo[];
}> {
  if (!buffer || buffer.byteLength < 100) {
    throw new Error('ملف القالب فارغ أو تالف.');
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('تعذر قراءة ملف القالب كملف XLSX صالح.');
  }

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  const requiredSheets = ['ملخص الأداء', 'المبيعات', 'المشتريات والموردين'];
  for (const required of requiredSheets) {
    if (!sheetNames.includes(required)) {
      throw new Error(`ملف القالب غير متوافق: الورقة المطلوبة "${required}" غير موجودة.`);
    }
  }

  const sheets: TemplateSheetInfo[] = [];

  for (const ws of workbook.worksheets) {
    let headerRowNumber = 1;
    let columns: TemplateColumnInfo[] = [];

    const maxScan = Math.min(ws.rowCount || 15, 15);
    for (let r = 1; r <= maxScan; r++) {
      const row = ws.getRow(r);
      const rowCols: TemplateColumnInfo[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const text = getCellText(cell);
        if (text) {
          rowCols.push({
            colNumber,
            colLetter: columnNumberToLetter(colNumber),
            name: text,
          });
        }
      });

      // Header row in المبيعات (row 4, 8 cols) and المشتريات والموردين (row 3, 6 cols)
      if (ws.name === 'المبيعات') {
        const hasSalesHeaders =
          rowCols.some((c) => c.name.includes('التاريخ')) &&
          rowCols.some((c) => c.name.includes('المبيعات') || c.name.includes('الشبكة'));
        if (hasSalesHeaders) {
          headerRowNumber = r;
          columns = rowCols;
          break;
        }
      } else if (ws.name === 'المشتريات والموردين') {
        const hasPurchasesHeaders =
          rowCols.some((c) => c.name.includes('التاريخ')) &&
          rowCols.some((c) => c.name.includes('المورد'));
        if (hasPurchasesHeaders) {
          headerRowNumber = r;
          columns = rowCols;
          break;
        }
      } else if (rowCols.length >= 2 && columns.length === 0) {
        headerRowNumber = r;
        columns = rowCols;
      }
    }

    let totalsRowNumber: number | null = null;
    if (ws.name === 'المبيعات' || ws.name === 'المشتريات والموردين') {
      if (columns.length < 4) {
        throw new Error(`ملف القالب غير متوافق: تعذر العثور على صف العناوين الصحيح في ورقة "${ws.name}".`);
      }
      const maxRow = Math.max(ws.rowCount || 50, 50);
      for (let r = headerRowNumber + 1; r <= maxRow; r++) {
        const firstCell = getCellText(ws.getRow(r).getCell(1));
        if (firstCell.includes('الإجمالي') || firstCell.toLowerCase().includes('total')) {
          totalsRowNumber = r;
          break;
        }
      }
    }

    sheets.push({
      sheetName: ws.name,
      headerRowNumber,
      dataStartRowNumber: headerRowNumber + 1,
      totalsRowNumber,
      columns,
    });
  }

  return { workbook, sheets };
}

async function fetchLocalAssetTemplate(): Promise<{
  buffer: ArrayBuffer;
  sha256: string;
  sheets: TemplateSheetInfo[];
}> {
  const res = await fetch(LOCAL_OFFICIAL_TEMPLATE_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`فشل تحميل القالب الرسمي من ${LOCAL_OFFICIAL_TEMPLATE_PATH}`);
  }
  const buffer = await res.arrayBuffer();
  const sha256 = await computeSha256(buffer);
  const { sheets } = await validateAndInspectTemplateBuffer(buffer);
  return { buffer, sha256, sheets };
}

let loggedActiveTemplate = false;

/**
 * Returns the active validated official template buffer + metadata.
 * Loads from IndexedDB when valid, otherwise initializes from public/assets/templates/fawater_template.xlsx.
 */
export async function getOfficialTemplate(): Promise<StoredOfficialTemplate> {
  clearLegacyTemplateCaches();

  const stored = await readStoredTemplate();
  if (stored && stored.buffer) {
    try {
      const { sheets } = await validateAndInspectTemplateBuffer(stored.buffer);
      // If template came from local asset, check if bundled asset on server changed
      if (stored.source === 'local' && typeof window !== 'undefined') {
        try {
          const local = await fetchLocalAssetTemplate();
          if (local.sha256 !== stored.sha256) {
            const refreshed: StoredOfficialTemplate = {
              key: OFFICIAL_TEMPLATE_KEY,
              buffer: local.buffer,
              sha256: local.sha256,
              source: 'local',
              localAssetSha256: local.sha256,
              updatedAt: new Date().toISOString(),
              sheets: local.sheets,
            };
            await writeStoredTemplate(refreshed);
            logTemplateInfo(refreshed);
            return refreshed;
          }
        } catch {
          // If local fetch fails while offline, keep valid stored version
        }
      }

      const normalized: StoredOfficialTemplate = { ...stored, sheets };
      if (!loggedActiveTemplate) {
        logTemplateInfo(normalized);
        loggedActiveTemplate = true;
      }
      return normalized;
    } catch {
      // Stored template corrupted; reload from bundled official asset below
    }
  }

  const local = await fetchLocalAssetTemplate();
  const record: StoredOfficialTemplate = {
    key: OFFICIAL_TEMPLATE_KEY,
    buffer: local.buffer,
    sha256: local.sha256,
    source: 'local',
    localAssetSha256: local.sha256,
    updatedAt: new Date().toISOString(),
    sheets: local.sheets,
  };
  await writeStoredTemplate(record).catch(() => {});
  logTemplateInfo(record);
  loggedActiveTemplate = true;
  return record;
}

function logTemplateInfo(tpl: StoredOfficialTemplate) {
  console.info('=== FAWATER OFFICIAL TEMPLATE ACTIVE ===');
  console.info('Official Template Path:', LOCAL_OFFICIAL_TEMPLATE_PATH);
  console.info('Source:', tpl.source);
  console.info('SHA-256:', tpl.sha256);
  console.info('Sheets:', tpl.sheets);
  console.info('========================================');
}

/**
 * Checks GitHub for an updated official fawater_template.xlsx.
 * - Compares SHA-256 against active template.
 * - Skips saving if unchanged.
 * - Validates XLSX structure before replacing IndexedDB cache.
 * - Keeps last valid version intact on network failure or corrupt file.
 */
export async function checkForTemplateUpdate(
  remoteUrl: string = GITHUB_OFFICIAL_TEMPLATE_URL
): Promise<TemplateCheckResult> {
  clearLegacyTemplateCaches();

  let currentTemplate: StoredOfficialTemplate | null = null;
  try {
    currentTemplate = await getOfficialTemplate();
  } catch {
    currentTemplate = await readStoredTemplate();
  }

  try {
    const res = await fetch(remoteUrl, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`تعذر الاتصال بمستودع GitHub (رمز الحالة: ${res.status})`);
    }

    const remoteBuffer = await res.arrayBuffer();
    const remoteSha256 = await computeSha256(remoteBuffer);

    if (currentTemplate && currentTemplate.sha256 === remoteSha256) {
      return {
        success: true,
        updated: false,
        unchanged: true,
        sha256: remoteSha256,
        source: currentTemplate.source,
        sheets: currentTemplate.sheets,
        message: 'القالب الحالي مطابق تماماً لأحدث نسخة رسمية على GitHub (لا توجد تحديثات جديدة).',
      };
    }

    const { sheets } = await validateAndInspectTemplateBuffer(remoteBuffer);

    const updatedRecord: StoredOfficialTemplate = {
      key: OFFICIAL_TEMPLATE_KEY,
      buffer: remoteBuffer,
      sha256: remoteSha256,
      source: 'github',
      localAssetSha256: currentTemplate?.localAssetSha256,
      updatedAt: new Date().toISOString(),
      sheets,
    };

    await writeStoredTemplate(updatedRecord);
    logTemplateInfo(updatedRecord);

    return {
      success: true,
      updated: true,
      unchanged: false,
      sha256: remoteSha256,
      source: 'github',
      sheets,
      message: 'تم تنزيل التحديث الجديد لقالب Excel الرسمي والتحقق من سلامته وحفظه بنجاح.',
    };
  } catch (err: any) {
    return {
      success: false,
      updated: false,
      unchanged: false,
      sha256: currentTemplate?.sha256,
      source: currentTemplate?.source,
      sheets: currentTemplate?.sheets,
      message: `${err?.message || 'فشل التحقق من تحديث القالب'} — تم الإبقاء على آخر نسخة صالحة من القالب.`,
    };
  }
}
