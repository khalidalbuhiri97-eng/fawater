import * as XLSX from 'xlsx';
import { InvoiceRecord, CustomField } from '../types';
import { loadOfficialTemplateWorkbook } from './dbService';

export interface SheetPreview {
  sheetName: string;
  columns: string[];
  sampleRows: any[];
  totalRows: number;
}

export interface ExcelTemplateAnalysis {
  sheetNames: string[];
  sheetsPreview: Record<string, SheetPreview>;
  workbook: XLSX.WorkBook;
}

export async function parseUploadedExcel(file: File): Promise<ExcelTemplateAnalysis> {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array', cellDates: true, cellStyles: true });
  const sheetNames = workbook.SheetNames;
  const sheetsPreview: Record<string, SheetPreview> = {};

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

/**
 * Loads the official fawater_template.xlsx and synchronizes invoices into it.
 */
export async function generateExportWorkbook(
  invoices: InvoiceRecord[],
  operationName: string,
  activityType: string
): Promise<Uint8Array> {
  const workbook = await loadOfficialTemplateWorkbook();

  if (!workbook.Sheets['المبيعات']) {
    const wsSales = XLSX.utils.aoa_to_sheet([
      [`سجل المبيعات اليومية والأرصدة - ${operationName}`, '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['بيانات المبيعات اليومية', '', '', '', '', 'الأرصدة وتتبع النقدية', '', ''],
      ['التاريخ', 'اليوم', 'المبيعات النقدية (الكاش)', 'الشبكة', 'إجمالي المبيعات', 'رصيد الكاش', 'رصيد الصندوق', 'رصيد الشبكة (البنك)']
    ]);
    XLSX.utils.book_append_sheet(workbook, wsSales, 'المبيعات');
  }

  if (!workbook.Sheets['المشتريات والموردين']) {
    const wsPurchases = XLSX.utils.aoa_to_sheet([
      [`سجل المشتريات والموردين - ${operationName}`, '', '', '', '', ''],
      ['', '', '', '', '', ''],
      ['التاريخ', 'اسم المورد', 'المبلغ قبل الضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة', 'الرصيد']
    ]);
    XLSX.utils.book_append_sheet(workbook, wsPurchases, 'المشتريات والموردين');
  }

  if (!workbook.Sheets['ملخص الأداء']) {
    const wsSummary = XLSX.utils.aoa_to_sheet([
      ['', `نظام إدارة الحسابات - ${operationName}`],
      ['', 'ملخص المبيعات اليومية، المشتريات، والأرصدة المالية'],
      ['', ''],
      ['', 'إجمالي المبيعات', '', 'إجمالي المشتريات (شامل الضريبة)', '', 'صافي التدفق (المبيعات - المشتريات)']
    ]);
    XLSX.utils.book_append_sheet(workbook, wsSummary, 'ملخص الأداء');
  }

  const wsSales = workbook.Sheets['المبيعات'];
  const wsPurchases = workbook.Sheets['المشتريات والموردين'];

  const getExistingIds = (ws: XLSX.WorkSheet, headerRowIndex: number): Set<string> => {
    const ids = new Set<string>();
    const json = XLSX.utils.sheet_to_json<any>(ws, { header: 1 });
    for (let r = headerRowIndex; r < json.length; r++) {
      const row = json[r] as any[];
      if (row && row[0]) ids.add(String(row[0]));
      if (row && row[1]) ids.add(String(row[1]));
    }
    return ids;
  };

  const salesExisting = getExistingIds(wsSales, 4);
  const purchasesExisting = getExistingIds(wsPurchases, 3);

  let totalSales = 0;
  let totalPurchases = 0;
  let totalTax = 0;

  const getNextRowIndex = (ws: XLSX.WorkSheet): number => {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:H1');
    return range.e.r + 1;
  };

  let salesNextRow = Math.max(getNextRowIndex(wsSales) + 1, 5);
  let purchasesNextRow = Math.max(getNextRowIndex(wsPurchases) + 1, 4);

  const newSalesRows: any[][] = [];
  const newPurchaseRows: any[][] = [];

  for (const inv of invoices) {
    if (inv.status !== 'مكتملة') continue;

    const docType = inv.documentType || 'مبيعات';
    const invId = inv.id;
    const invNum = inv.invoiceNumber || '';

    if (docType === 'مبيعات' || docType === 'فاتورة ضريبية') {
      if (!salesExisting.has(invId) && !salesExisting.has(invNum)) {
        const rowNum = salesNextRow++;
        const totalSalesFormula = `=C${rowNum}+D${rowNum}`;

        newSalesRows.push([
          inv.invoiceDate || null,
          inv.day || null,
          inv.cashSales !== undefined ? inv.cashSales : null,
          inv.networkSales !== undefined ? inv.networkSales : null,
          { t: 'n', f: totalSalesFormula },
          inv.cashBalance !== undefined ? inv.cashBalance : null,
          inv.cashBoxBalance !== undefined ? inv.cashBoxBalance : null,
          inv.networkBalance !== undefined ? inv.networkBalance : null
        ]);
        salesExisting.add(invId);
      }
      totalSales += Number(inv.grandTotal || (inv.cashSales || 0) + (inv.networkSales || 0));
    } else {
      if (!purchasesExisting.has(invId) && !purchasesExisting.has(invNum)) {
        const rowNum = purchasesNextRow++;
        const grandTotalFormula = `=C${rowNum}+D${rowNum}`;

        newPurchaseRows.push([
          inv.invoiceDate || null,
          inv.issuerName || null,
          inv.subtotal !== undefined ? inv.subtotal : null,
          inv.taxAmount !== undefined ? inv.taxAmount : null,
          { t: 'n', f: grandTotalFormula },
          inv.balance !== undefined ? inv.balance : null
        ]);
        purchasesExisting.add(invId);
      }
      totalPurchases += Number(inv.grandTotal || (inv.subtotal || 0) + (inv.taxAmount || 0));
    }

    totalTax += Number(inv.taxAmount || 0);
  }

  if (newSalesRows.length > 0) {
    XLSX.utils.sheet_add_aoa(wsSales, newSalesRows, { origin: -1 });
  }
  if (newPurchaseRows.length > 0) {
    XLSX.utils.sheet_add_aoa(wsPurchases, newPurchaseRows, { origin: -1 });
  }

  const wsSummary = workbook.Sheets['ملخص الأداء'];
  if (wsSummary) {
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

export async function downloadExportWorkbook(invoices: InvoiceRecord[], operationName: string, activityType: string, filename: string) {
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

export async function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`, { cellStyles: true });
}
