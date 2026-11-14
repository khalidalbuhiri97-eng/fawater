import * as XLSX from 'xlsx';
import { InvoiceRecord, CustomField } from '../types';

export interface SheetStructure {
  sheetName: string;
  headerRowIndex: number;
  columns: string[];
  dataStartRowIndex: number;
}

export interface TemplateAnalysisResult {
  filename: string;
  sha256Fingerprint: string;
  sheets: SheetStructure[];
  workbook: XLSX.WorkBook;
}

/**
 * Computes SHA-256 hash fingerprint of ArrayBuffer
 */
export async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } catch (e) {
    return 'sha256-unavailable';
  }
}

const TEMPLATE_STORAGE_KEY = 'fawater_template_cache_v2';

/**
 * Loads the official fawater_template.xlsx from assets, inspects its structure dynamically,
 * computes SHA-256 fingerprint, and logs details to the console.
 */
export async function loadAndAnalyzeOfficialTemplate(): Promise<TemplateAnalysisResult> {
  let arrayBuf: ArrayBuffer;

  try {
    const res = await fetch('/assets/templates/fawater_template.xlsx');
    if (!res.ok) {
      throw new Error('فشل تحميل القالب الرسمي من assets/templates/fawater_template.xlsx');
    }
    arrayBuf = await res.arrayBuffer();
  } catch (err) {
    console.warn('Fallback: fetching from root /assets/templates/fawater_template.xlsx');
    const res = await fetch('/assets/templates/fawater_template.xlsx');
    arrayBuf = await res.arrayBuffer();
  }

  const sha256Fingerprint = await computeSha256(arrayBuf);
  const workbook = XLSX.read(arrayBuf, { type: 'array', cellDates: true, cellStyles: true });

  const sheets: SheetStructure[] = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<any>(ws, { header: 1 });
    
    let headerRowIndex = 0;
    let columns: string[] = [];

    // Find the first row that has multiple column headers or looks like a header row
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const row = rows[r] as any[];
      if (row && row.filter(Boolean).length >= 2) {
        headerRowIndex = r;
        columns = row.map((c, idx) => String(c || `عمود ${idx + 1}`));
        break;
      }
    }

    const dataStartRowIndex = headerRowIndex + 1;

    sheets.push({
      sheetName,
      headerRowIndex,
      columns,
      dataStartRowIndex
    });
  }

  console.log('=== FAWATER OFFICIAL TEMPLATE ANALYSIS ===');
  console.log('Template Path: assets/templates/fawater_template.xlsx');
  console.log('SHA-256 Fingerprint:', sha256Fingerprint);
  console.log('Detected Sheets & Structure:', sheets);
  console.log('==========================================');

  return {
    filename: 'fawater_template.xlsx',
    sha256Fingerprint,
    sheets,
    workbook
  };
}

/**
 * Centralized export function that loads the official template, inspects its structure dynamically,
 * and appends approved invoices into the correct sheets while preserving formatting and formulas.
 */
export async function generateExportWorkbook(
  invoices: InvoiceRecord[],
  operationName: string,
  activityType: string
): Promise<Uint8Array> {
  const analysis = await loadAndAnalyzeOfficialTemplate();
  const { workbook, sheets } = analysis;

  // Clear old cached template variants if any
  localStorage.removeItem('fawater_custom_template_base64');

  let totalSales = 0;
  let totalPurchases = 0;
  let totalTax = 0;

  for (const sheetStruct of sheets) {
    const ws = workbook.Sheets[sheetStruct.sheetName];
    if (!ws) continue;

    const isSalesSheet = sheetStruct.sheetName.includes('مبيعات') || sheetStruct.sheetName.includes('Sales');
    const isPurchasesSheet = sheetStruct.sheetName.includes('مشتريات') || sheetStruct.sheetName.includes('Purchases') || sheetStruct.sheetName.includes('موردين');

    if (!isSalesSheet && !isPurchasesSheet) continue;

    // Get existing IDs to prevent duplicates
    const existingIds = new Set<string>();
    const jsonRows = XLSX.utils.sheet_to_json<any>(ws, { header: 1 });
    for (let r = sheetStruct.dataStartRowIndex; r < jsonRows.length; r++) {
      const row = jsonRows[r] as any[];
      if (row && row[0]) existingIds.add(String(row[0]));
      if (row && row[1]) existingIds.add(String(row[1]));
    }

    const nextRow = Math.max(jsonRows.length, sheetStruct.dataStartRowIndex + 1);
    let currentRowNum = nextRow;
    const newRows: any[][] = [];

    for (const inv of invoices) {
      if (inv.status !== 'مكتملة') continue;

      const docType = inv.documentType || 'مبيعات';
      const isThisSales = docType === 'مبيعات' || docType === 'فاتورة ضريبية';

      if (isSalesSheet && isThisSales) {
        if (!existingIds.has(inv.id) && !existingIds.has(inv.invoiceNumber || '')) {
          const formulaColIndex = sheetStruct.columns.findIndex(c => c.includes('إجمالي') || c.includes('Total'));
          const formulaRef = formulaColIndex !== -1 ? XLSX.utils.encode_cell({ r: currentRowNum - 1, c: formulaColIndex }) : null;
          
          // Map to columns dynamically
          const rowData = sheetStruct.columns.map((colName, colIdx) => {
            if (colName.includes('التاريخ') || colName.includes('Date')) return inv.invoiceDate || null;
            if (colName.includes('اليوم') || colName.includes('Day')) return inv.day || null;
            if (colName.includes('كاش') || colName.includes('Cash')) return inv.cashSales !== undefined ? inv.cashSales : null;
            if (colName.includes('شبكة') || colName.includes('POS') || colName.includes('بنك')) return inv.networkSales !== undefined ? inv.networkSales : null;
            if (colName.includes('إجمالي') || colName.includes('Total')) {
              // Formula C+D or similar
              return { t: 'n', f: `=C${currentRowNum}+D${currentRowNum}` };
            }
            if (colName.includes('رصيد الكاش')) return inv.cashBalance !== undefined ? inv.cashBalance : null;
            if (colName.includes('رصيد الصندوق')) return inv.cashBoxBalance !== undefined ? inv.cashBoxBalance : null;
            if (colName.includes('رصيد الشبكة')) return inv.networkBalance !== undefined ? inv.networkBalance : null;
            return null;
          });

          newRows.push(rowData);
          existingIds.add(inv.id);
          currentRowNum++;
        }
        totalSales += Number(inv.grandTotal || (inv.cashSales || 0) + (inv.networkSales || 0));
      } else if (isPurchasesSheet && !isThisSales) {
        if (!existingIds.has(inv.id) && !existingIds.has(inv.invoiceNumber || '')) {
          const rowData = sheetStruct.columns.map((colName) => {
            if (colName.includes('التاريخ') || colName.includes('Date')) return inv.invoiceDate || null;
            if (colName.includes('المورد') || colName.includes('Supplier') || colName.includes('اسم')) return inv.issuerName || null;
            if (colName.includes('قبل الضريبة') || colName.includes('Subtotal')) return inv.subtotal !== undefined ? inv.subtotal : null;
            if (colName.includes('ضريبة') || colName.includes('VAT')) return inv.taxAmount !== undefined ? inv.taxAmount : null;
            if (colName.includes('الإجمالي') || colName.includes('Grand') || colName.includes('شامل')) {
              return { t: 'n', f: `=C${currentRowNum}+D${currentRowNum}` };
            }
            if (colName.includes('رصيد') || colName.includes('Balance')) return inv.balance !== undefined ? inv.balance : null;
            return null;
          });

          newRows.push(rowData);
          existingIds.add(inv.id);
          currentRowNum++;
        }
        totalPurchases += Number(inv.grandTotal || (inv.subtotal || 0) + (inv.taxAmount || 0));
      }

      totalTax += Number(inv.taxAmount || 0);
    }

    if (newRows.length > 0) {
      XLSX.utils.sheet_add_aoa(ws, newRows, { origin: -1 });
    }
  }

  // Update Summary Sheet if exists
  const summarySheetName = workbook.SheetNames.find(s => s.includes('ملخص') || s.includes('Summary'));
  if (summarySheetName) {
    const wsSummary = workbook.Sheets[summarySheetName];
    const netIncome = totalSales - totalPurchases;
    XLSX.utils.sheet_add_aoa(wsSummary, [
      ['', `نظام إدارة الحسابات - ${operationName}`],
      ['', 'ملخص المبيعات اليومية، المشتريات، والأرصدة المالية'],
      ['', ''],
      ['', 'إجمالي المبيعات', '', 'إجمالي المشتريات (شامل الضريبة)', '', 'صافي التدفق (المبيعات - المشتريات)'],
      ['', totalSales, '', totalPurchases, '', netIncome],
      ['', ''],
      ['', 'آخر رصيد كاش', '', 'آخر رصيد صندوق', '', 'آخر رصيد شبكة (بنك)'],
      ['', '#N/A', '', '#N/A', '', '#N/A']
    ], { origin: 'A1' });
  }

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: true });
  return new Uint8Array(excelBuffer);
}

export async function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`, { cellStyles: true });
}

export async function downloadExportWorkbook(
  invoices: InvoiceRecord[],
  operationName: string,
  activityType: string,
  filename: string
) {
  const buf = await generateExportWorkbook(invoices, operationName, activityType);
  const blob = new Blob([buf.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function parseUploadedExcel(file: File) {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array', cellDates: true, cellStyles: true });
  const sheetNames = workbook.SheetNames;
  const sheetsPreview: Record<string, any> = {};

  for (const name of sheetNames) {
    const worksheet = workbook.Sheets[name];
    const jsonRows = XLSX.utils.sheet_to_json<any>(worksheet, { header: 1 });
    const totalRows = jsonRows.length;
    let columns: string[] = [];
    let sampleRows: any[] = [];

    if (totalRows > 0) {
      columns = (jsonRows[0] as any[]).map((c, idx) => String(c || `عمود ${idx + 1}`));
      sampleRows = jsonRows.slice(1, 6);
    }

    sheetsPreview[name] = {
      sheetName: name,
      columns,
      sampleRows,
      totalRows,
    };
  }

  return {
    sheetNames,
    sheetsPreview,
    workbook,
  };
}
