import * as XLSX from 'xlsx';
import { InvoiceRecord, CustomField } from '../types';

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

/**
 * Creates the official structured Excel workbook with 3 official sheets:
 * 1. ملخص الأداء
 * 2. المبيعات (Headers at row 4, data starts at row 5)
 * 3. المشتريات والموردين (Headers at row 3, data starts at row 4)
 */
export function createNewStructuredWorkbook(operationName: string, activityType: string): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. ملخص الأداء (Performance Summary)
  const summaryData = [
    ['تقرير أداء المؤسسة / المشروع', operationName],
    ['نوع النشاط:', activityType],
    ['تاريخ الإنشاء:', new Date().toISOString().split('T')[0]],
    [],
    ['مؤشر الأداء', 'القيمة الإجمالية'],
    ['إجمالي المبيعات', 0],
    ['إجمالي المشتريات', 0],
    ['إجمالي الضرائب', 0],
    ['صافي الإيرادات', 0],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخص الأداء');

  // 2. المبيعات (Sales - Header at row 4 (index 3), data starts at row 5)
  const salesHeaders = [
    'التاريخ', 'اليوم', 'المبيعات النقدية (الكاش)', 'الشبكة', 'إجمالي المبيعات', 'رصيد الكاش', 'رصيد الصندوق', 'رصيد الشبكة (البنك)'
  ];
  const salesRows = [
    [operationName, '', '', '', '', '', '', ''],
    ['سجل مبيعات المؤسسة', '', '', '', '', '', '', ''],
    [],
    salesHeaders,
  ];
  const wsSales = XLSX.utils.aoa_to_sheet(salesRows);
  XLSX.utils.book_append_sheet(wb, wsSales, 'المبيعات');

  // 3. المشتريات والموردين (Purchases - Header at row 3 (index 2), data starts at row 4)
  const purchasesHeaders = [
    'التاريخ', 'اسم المورد', 'المبلغ قبل الضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة', 'الرصيد'
  ];
  const purchasesRows = [
    [operationName, '', '', '', '', ''],
    ['سجل المشتريات والموردين', '', '', '', '', ''],
    purchasesHeaders,
  ];
  const wsPurchases = XLSX.utils.aoa_to_sheet(purchasesRows);
  XLSX.utils.book_append_sheet(wb, wsPurchases, 'المشتريات والموردين');

  return wb;
}

/**
 * Parses an uploaded Excel file and returns worksheet previews and structure.
 */
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
 * Appends invoices into the official template workbook according to the exact schema:
 * - Sales sheet: starts at row 5, formula in col E (`=C{row}+D{row}`)
 * - Purchases sheet: starts at row 4, formula in col E (`=C{row}+D{row}`)
 */
export function syncInvoicesToWorkbook(
  workbook: XLSX.WorkBook,
  invoices: InvoiceRecord[],
  customFields: CustomField[],
  operationName: string,
  activityType: string
): Uint8Array {
  // Ensure required sheets exist
  if (!workbook.Sheets['المبيعات']) {
    const wsSales = XLSX.utils.aoa_to_sheet([
      [operationName, '', '', '', '', '', '', ''],
      ['سجل مبيعات المؤسسة', '', '', '', '', '', '', ''],
      [],
      ['التاريخ', 'اليوم', 'المبيعات النقدية (الكاش)', 'الشبكة', 'إجمالي المبيعات', 'رصيد الكاش', 'رصيد الصندوق', 'رصيد الشبكة (البنك)']
    ]);
    XLSX.utils.book_append_sheet(workbook, wsSales, 'المبيعات');
  }

  if (!workbook.Sheets['المشتريات والموردين']) {
    const wsPurchases = XLSX.utils.aoa_to_sheet([
      [operationName, '', '', '', '', ''],
      ['سجل المشتريات والموردين', '', '', '', '', ''],
      ['التاريخ', 'اسم المورد', 'المبلغ قبل الضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة', 'الرصيد']
    ]);
    XLSX.utils.book_append_sheet(workbook, wsPurchases, 'المشتريات والموردين');
  }

  if (!workbook.Sheets['ملخص الأداء']) {
    const wsSummary = XLSX.utils.aoa_to_sheet([
      ['تقرير أداء المؤسسة', operationName],
      ['نوع النشاط:', activityType],
      [],
      ['مؤشر الأداء', 'القيمة الإجمالية']
    ]);
    XLSX.utils.book_append_sheet(workbook, wsSummary, 'ملخص الأداء');
  }

  const wsSales = workbook.Sheets['المبيعات'];
  const wsPurchases = workbook.Sheets['المشتريات والموردين'];

  // Helper to extract existing invoice IDs to prevent duplication
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

  const salesExisting = getExistingIds(wsSales, 4); // sales header at row 4 (index 3)
  const purchasesExisting = getExistingIds(wsPurchases, 3); // purchases header at row 3 (index 2)

  let totalSales = 0;
  let totalPurchases = 0;
  let totalTax = 0;

  // Read current sheet ranges to determine next row
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
        // Formula for Total Sales (Col E = C + D)
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
      totalSales += Number(inv.grandTotal || (inv.subtotal || 0) + (inv.taxAmount || 0));
    } else {
      // Purchases / Expenses
      if (!purchasesExisting.has(invId) && !purchasesExisting.has(invNum)) {
        const rowNum = purchasesNextRow++;
        // Formula for Grand Total (Col E = C + D)
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

  // Append safely
  if (newSalesRows.length > 0) {
    XLSX.utils.sheet_add_aoa(wsSales, newSalesRows, { origin: -1 });
  }
  if (newPurchaseRows.length > 0) {
    XLSX.utils.sheet_add_aoa(wsPurchases, newPurchaseRows, { origin: -1 });
  }

  // Update Summary Sheet
  const wsSummary = workbook.Sheets['ملخص الأداء'];
  if (wsSummary) {
    const netIncome = totalSales - totalPurchases;
    XLSX.utils.sheet_add_aoa(wsSummary, [
      ['تقرير أداء المؤسسة', operationName],
      ['نوع النشاط:', activityType],
      ['تاريخ التحديث:', new Date().toISOString().split('T')[0]],
      [],
      ['مؤشر الأداء', 'القيمة الإجمالية'],
      ['إجمالي المبيعات', totalSales],
      ['إجمالي المشتريات', totalPurchases],
      ['إجمالي الضرائب', totalTax],
      ['صافي الإيرادات', netIncome],
    ], { origin: 'A1' });
  }

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: true });
  return new Uint8Array(excelBuffer);
}

export function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`, { cellStyles: true });
}
