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
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });
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
 * Updates or appends invoices into an existing or new workbook and returns binary Uint8Array.
 */
export function syncInvoicesToWorkbook(
  workbook: XLSX.WorkBook,
  invoices: InvoiceRecord[],
  customFields: CustomField[],
  operationName: string,
  activityType: string
): Uint8Array {
  // We can clone or rebuild the sheets while preserving user custom sheets
  // For structured worksheets, we rebuild the data rows from the `invoices` array.

  // 1. Sales Sheet
  const salesRows: any[][] = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المستند', 'اسم المؤسسة (البائع)', 'اسم العميل', 'الرقم الضريبي للبائع', 'الرقم الضريبي للعميل', 'العملة', 'الإجمالي قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات']
  ];
  const purchaseRows: any[][] = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المستند', 'اسم المؤسسة (المورد)', 'اسم العميل', 'الرقم الضريبي للمورد', 'الرقم الضريبي للعميل', 'العملة', 'الإجمالي قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات']
  ];
  const expenseRows: any[][] = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'التاريخ', 'نوع المصروف', 'جهة الصرف / المورد', 'الرقم الضريبي', 'العملة', 'المبلغ قبل الضريبة', 'الضريبة', 'نسبة الضريبة %', 'الخصم', 'الإجمالي النهائي', 'ملاحظات']
  ];
  const itemsRows: any[][] = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'اسم الصنف', 'كود الصنف', 'الكمية', 'الوحدة', 'سعر الوحدة', 'الخصم', 'الضريبة', 'إجمالي الصنف']
  ];
  const customRows: any[][] = [
    ['معرف الفاتورة', 'رقم الفاتورة', 'اسم الحقل المخصص', 'قيمة الحقل']
  ];

  let totalSales = 0;
  let totalPurchases = 0;
  let totalExpenses = 0;
  let totalTax = 0;

  for (const inv of invoices) {
    if (inv.status !== 'مكتملة') continue;

    const docType = inv.documentType || 'مبيعات';
    const row = [
      inv.id,
      inv.invoiceNumber || '',
      inv.invoiceDate || '',
      docType,
      inv.issuerName || '',
      inv.clientName || '',
      inv.issuerTaxId || '',
      inv.clientTaxId || '',
      inv.currency || 'SAR',
      inv.subtotal || 0,
      inv.taxAmount || 0,
      inv.taxRate || 0,
      inv.discount || 0,
      inv.grandTotal || 0,
      inv.notes || ''
    ];

    if (docType === 'مبيعات' || docType === 'فاتورة ضريبية') {
      salesRows.push(row);
      totalSales += Number(inv.grandTotal || 0);
    } else if (docType === 'مشتريات' || docType === 'مرتجعات') {
      purchaseRows.push(row);
      totalPurchases += Number(inv.grandTotal || 0);
    } else {
      expenseRows.push(row);
      totalExpenses += Number(inv.grandTotal || 0);
    }

    totalTax += Number(inv.taxAmount || 0);

    // Items
    if (inv.items && inv.items.length > 0) {
      for (const item of inv.items) {
        itemsRows.push([
          inv.id,
          inv.invoiceNumber || '',
          item.name || '',
          item.code || '',
          item.quantity || 1,
          item.unit || 'حبة',
          item.unitPrice || 0,
          item.discount || 0,
          item.tax || 0,
          item.total || 0
        ]);
      }
    }

    // Custom fields
    if (inv.customFieldsValues) {
      for (const [cfId, val] of Object.entries(inv.customFieldsValues)) {
        const cfDef = customFields.find(c => c.id === cfId);
        const cfName = cfDef ? cfDef.name : cfId;
        customRows.push([
          inv.id,
          inv.invoiceNumber || '',
          cfName,
          val !== undefined && val !== null ? String(val) : ''
        ]);
      }
    }
  }

  // Update or create sheets in workbook
  const updateSheet = (sheetName: string, data: any[][]) => {
    const ws = XLSX.utils.aoa_to_sheet(data);
    if (workbook.Sheets[sheetName]) {
      workbook.Sheets[sheetName] = ws;
    } else {
      XLSX.utils.book_append_sheet(workbook, ws, sheetName);
    }
  };

  updateSheet('المبيعات (Sales)', salesRows);
  updateSheet('المشتريات (Purchases)', purchaseRows);
  updateSheet('المصروفات (Expenses)', expenseRows);
  updateSheet('تفاصيل الأصناف (Items)', itemsRows);
  updateSheet('الحقول المخصصة (Custom Fields)', customRows);

  // Summary Sheet
  const netIncome = totalSales - (totalPurchases + totalExpenses);
  const summaryData = [
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
  ];
  updateSheet('الملخص (Summary)', summaryData);

  // Write to array buffer
  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(excelBuffer);
}

export function downloadWorkbook(workbook: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}
