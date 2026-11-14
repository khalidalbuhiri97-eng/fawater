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
 * Creates a brand new structured Excel workbook with standard sheets and headers.
 */
export function createNewStructuredWorkbook(operationName: string, activityType: string): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. Sales Sheet
  const salesData = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المستند', 'اسم المؤسسة (البائع)', 'اسم العميل', 'الرقم الضريبي للبائع', 'الرقم الضريبي للعميل', 'العملة', 'الإجمالي قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات'],
  ];
  const wsSales = XLSX.utils.aoa_to_sheet(salesData);
  XLSX.utils.book_append_sheet(wb, wsSales, 'المبيعات (Sales)');

  // 2. Purchases Sheet
  const purchasesData = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المستند', 'اسم المؤسسة (المورد)', 'اسم العميل', 'الرقم الضريبي للمورد', 'الرقم الضريبي للعميل', 'العملة', 'الإجمالي قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات'],
  ];
  const wsPurchases = XLSX.utils.aoa_to_sheet(purchasesData);
  XLSX.utils.book_append_sheet(wb, wsPurchases, 'المشتريات (Purchases)');

  // 3. Expenses Sheet
  const expensesData = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المصروف', 'جهة الصرف / المورد', 'الرقم الضريبي', 'العملة', 'المبلغ قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات'],
  ];
  const wsExpenses = XLSX.utils.aoa_to_sheet(expensesData);
  XLSX.utils.book_append_sheet(wb, wsExpenses, 'المصروفات (Expenses)');

  // 4. Invoice Items Sheet
  const itemsData = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'اسم الصنف', 'كود الصنف', 'الكمية', 'الوحدة', 'سعر الوحدة', 'الخصم', 'الضريبة', 'إجمالي الصنف'],
  ];
  const wsItems = XLSX.utils.aoa_to_sheet(itemsData);
  XLSX.utils.book_append_sheet(wb, wsItems, 'تفاصيل الأصناف (Items)');

  // 5. Custom Fields Sheet
  const customData = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'اسم الحقل المخصص', 'قيمة الحقل'],
  ];
  const wsCustom = XLSX.utils.aoa_to_sheet(customData);
  XLSX.utils.book_append_sheet(wb, wsCustom, 'الحقول المخصصة (Custom Fields)');

  // 6. Summary Sheet
  const summaryData = [
    ['مشروع / مؤسسة:', operationName],
    ['نوع النشاط:', activityType],
    ['تاريخ الإنشاء:', new Date().toISOString().split('T')[0]],
    [],
    ['الملخص المالي', 'القيمة'],
    ['إجمالي المبيعات', 0],
    ['إجمالي المشتريات', 0],
    ['إجمالي المصروفات', 0],
    ['إجمالي الضرائب المحصلة/المدفوعة', 0],
    ['صافي الإيرادات', 0],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'الملخص (Summary)');

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
      // First row as headers
      columns = (jsonRows[0] as any[]).map((c, idx) => String(c || `عمود ${idx + 1}`));
      sampleRows = jsonRows.slice(1, 6); // preview first 5 rows
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
 * Appends invoices into the existing workbook without overwriting pre-existing data,
 * preserving template formatting, styles, formulas, and preventing duplicates.
 */
export function syncInvoicesToWorkbook(
  workbook: XLSX.WorkBook,
  invoices: InvoiceRecord[],
  customFields: CustomField[],
  operationName: string,
  activityType: string
): Uint8Array {
  // Helper to ensure sheet exists or get it, without destroying formatting if it exists
  const getOrEnsureSheet = (sheetName: string, defaultHeaders: any[]) => {
    if (!workbook.Sheets[sheetName]) {
      const ws = XLSX.utils.aoa_to_sheet([defaultHeaders]);
      XLSX.utils.book_append_sheet(workbook, ws, sheetName);
    }
    return workbook.Sheets[sheetName];
  };

  const wsSales = getOrEnsureSheet('المبيعات (Sales)', [
    'معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المستند', 'اسم المؤسسة (البائع)', 'اسم العميل', 'الرقم الضريبي للبائع', 'الرقم الضريبي للعميل', 'العملة', 'الإجمالي قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات'
  ]);
  const wsPurchases = getOrEnsureSheet('المشتريات (Purchases)', [
    'معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المستند', 'اسم المؤسسة (المورد)', 'اسم العميل', 'الرقم الضريبي للمورد', 'الرقم الضريبي للعميل', 'العملة', 'الإجمالي قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات'
  ]);
  const wsExpenses = getOrEnsureSheet('المصروفات (Expenses)', [
    'معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المصروف', 'جهة الصرف / المورد', 'الرقم الضريبي', 'العملة', 'المبلغ قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات'
  ]);
  const wsItems = getOrEnsureSheet('تفاصيل الأصناف (Items)', [
    'معرف الفاتورة', 'رقم الفاتورة', 'اسم الصنف', 'كود الصنف', 'الكمية', 'الوحدة', 'سعر الوحدة', 'الخصم', 'الضريبة', 'إجمالي الصنف'
  ]);
  const wsCustom = getOrEnsureSheet('الحقول المخصصة (Custom Fields)', [
    'معرف الفاتورة', 'رقم الفاتورة', 'اسم الحقل المخصص', 'قيمة الحقل'
  ]);

  // Helper to append rows to an existing worksheet using sheet_add_aoa with origin: -1
  // This preserves existing rows, styles, formulas, and formatting above.
  const appendRowsToSheet = (ws: XLSX.WorkSheet, newRows: any[][]) => {
    if (newRows.length === 0) return;
    XLSX.utils.sheet_add_aoa(ws, newRows, { origin: -1 });
  };

  // Extract existing IDs from sheets to prevent duplication
  const getExistingIds = (ws: XLSX.WorkSheet): Set<string> => {
    const ids = new Set<string>();
    const json = XLSX.utils.sheet_to_json<any>(ws, { header: 1 });
    // Assuming ID is in column 0 or 1
    for (let r = 1; r < json.length; r++) {
      const row = json[r] as any[];
      if (row && row[0]) ids.add(String(row[0]));
      if (row && row[1]) ids.add(String(row[1]));
    }
    return ids;
  };

  const salesExistingIds = getExistingIds(wsSales);
  const purchaseExistingIds = getExistingIds(wsPurchases);
  const expenseExistingIds = getExistingIds(wsExpenses);

  const newSalesRows: any[][] = [];
  const newPurchaseRows: any[][] = [];
  const newExpenseRows: any[][] = [];
  const newItemsRows: any[][] = [];
  const newCustomRows: any[][] = [];

  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;
  let totalTax = 0;

  for (const inv of invoices) {
    if (inv.status !== 'مكتملة') continue;

    const docType = inv.documentType || 'مبيعات';
    const invId = inv.id;
    const invNum = inv.invoiceNumber || '';

    const row = [
      invId,
      invNum,
      inv.invoiceDate || null,
      docType,
      inv.issuerName || null,
      inv.clientName || null,
      inv.issuerTaxId || null,
      inv.clientTaxId || null,
      inv.currency || null,
      inv.subtotal !== undefined ? inv.subtotal : null,
      inv.taxAmount !== undefined ? inv.taxAmount : null,
      inv.taxRate !== undefined ? inv.taxRate : null,
      inv.discount !== undefined ? inv.discount : null,
      inv.grandTotal !== undefined ? inv.grandTotal : null,
      inv.notes || null
    ];

    if (docType === 'مبيعات' || docType === 'فاتورة ضريبية') {
      if (!salesExistingIds.has(invId) && !salesExistingIds.has(invNum)) {
        newSalesRows.push(row);
        salesExistingIds.add(invId);
      }
      totalSales += Number(inv.grandTotal || 0);
    } else if (docType === 'مشتريات' || docType === 'مرتجعات') {
      if (!purchaseExistingIds.has(invId) && !purchaseExistingIds.has(invNum)) {
        newPurchaseRows.push(row);
        purchaseExistingIds.add(invId);
      }
      totalPurchases += Number(inv.grandTotal || 0);
    } else {
      if (!expenseExistingIds.has(invId) && !expenseExistingIds.has(invNum)) {
        newExpenseRows.push(row);
        expenseExistingIds.add(invId);
      }
      totalExpenses += Number(inv.grandTotal || 0);
    }

    totalTax += Number(inv.taxAmount || 0);

    // Items
    if (inv.items && inv.items.length > 0) {
      for (const item of inv.items) {
        newItemsRows.push([
          invId,
          invNum,
          item.name || null,
          item.code || null,
          item.quantity !== undefined ? item.quantity : null,
          item.unit || null,
          item.unitPrice !== undefined ? item.unitPrice : null,
          item.discount !== undefined ? item.discount : null,
          item.tax !== undefined ? item.tax : null,
          item.total !== undefined ? item.total : null
        ]);
      }
    }

    // Custom fields
    if (inv.customFieldsValues) {
      for (const [cfId, val] of Object.entries(inv.customFieldsValues)) {
        const cfDef = customFields.find(c => c.id === cfId);
        const cfName = cfDef ? cfDef.name : cfId;
        newCustomRows.push([
          invId,
          invNum,
          cfName,
          val !== undefined && val !== null ? String(val) : null
        ]);
      }
    }
  }

  // Append safely without destroying template formatting
  appendRowsToSheet(wsSales, newSalesRows);
  appendRowsToSheet(wsPurchases, newPurchaseRows);
  appendRowsToSheet(wsExpenses, newExpenseRows);
  appendRowsToSheet(wsItems, newItemsRows);
  appendRowsToSheet(wsCustom, newCustomRows);

  // Summary Sheet update if exists
  const wsSummary = workbook.Sheets['الملخص (Summary)'];
  if (wsSummary) {
    const netIncome = totalSales - (totalPurchases + totalExpenses);
    // Update summary cells if structured or add/update
    XLSX.utils.sheet_add_aoa(wsSummary, [
      ['مشروع / مؤسسة:', operationName],
      ['نوع النشاط:', activityType],
      ['تاريخ التحديث:', new Date().toISOString().split('T')[0]],
      [],
      ['الملخص المالي', 'القيمة'],
      ['إجمالي المبيعات', totalSales],
      ['إجمالي المشتريات', totalPurchases],
      ['إجمالي المصروفات', totalExpenses],
      ['إجمالي الضرائب المحصلة/المدفوعة', totalTax],
      ['صافي الإيرادات', netIncome],
    ], { origin: 'A1' });
  }

  // Write to array buffer preserving cell styles if supported
  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: true });
  return new Uint8Array(excelBuffer);
}

export function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`, { cellStyles: true });
}
