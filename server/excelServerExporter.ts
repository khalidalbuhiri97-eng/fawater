import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { normalizeInvoiceDate } from './dateUtils.js';
import { findDuplicateInvoiceServer } from './invoiceDeduplication.js';

export const SERVER_OFFICIAL_TEMPLATE_PATH = path.resolve(
  process.cwd(),
  'public/assets/templates/fawater_template.xlsx'
);

export interface ServerTemplateColumnInfo {
  colNumber: number;
  colLetter: string;
  name: string;
  fieldKey: string;
}

export interface ServerTemplateSheetInfo {
  sheetName: string;
  headerRowNumber: number;
  dataStartRowNumber: number;
  totalsRowNumber: number | null;
  columns: ServerTemplateColumnInfo[];
}

export interface ServerExportEntry {
  invoiceId: string;
  operationId: string;
  sheetName: string;
  rowNumber: number;
  exportedAt: string;
  invoiceUpdatedAt?: string;
}

export interface ServerExportResult {
  buffer: Buffer;
  templateSha256: string;
  exportedCount: number;
  skippedDuplicates: number;
  skippedUnready: number;
  salesWritten: number;
  purchasesWritten: number;
  entries: ServerExportEntry[];
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

function normalizeHeader(value: string): string {
  return String(value || '').replace(/[\u064B-\u065F\u0670ـ]/g, '').replace(/[\s\u00A0]+/g, ' ').trim();
}

function classifyColumnKey(sheetName: string, colLetter: string, headerName: string): string {
  const header = normalizeHeader(headerName);
  if (sheetName === 'المبيعات') {
    if (header.includes('التاريخ') || header.includes('تاريخ') || header.includes('تأريخ')) return 'invoiceDate';
    if (header.includes('اليوم')) return 'day';
    if (
      (header.includes('المبيعات النقدية') || header.includes('النقدية') || header.includes('الكاش')) &&
      !header.includes('رصيد')
    ) {
      return 'cashSales';
    }
    if (header.includes('الشبكة') && !header.includes('رصيد')) return 'networkSales';
    if (header.includes('إجمالي المبيعات') || header.includes('الإجمالي')) return 'formula:salesTotal';
    if (header.includes('رصيد الكاش')) return 'cashBalance';
    if (header.includes('رصيد الصندوق')) return 'cashBoxBalance';
    if (header.includes('رصيد الشبكة')) return 'networkBalance';
  } else if (sheetName === 'المشتريات والموردين') {
    if (header.includes('التاريخ') || header.includes('تاريخ') || header.includes('تأريخ')) return 'invoiceDate';
    if (header.includes('اسم المورد') || header.includes('المورد')) return 'issuerName';
    if (header.includes('طريقة الدفع') || header.includes('الدفع')) return 'paymentMethod';
    if (header.includes('رقم الفاتورة')) return 'invoiceNumber';
    if (header.includes('قبل الضريبة')) return 'subtotal';
    if (
      (header.includes('ضريبة القيمة المضافة') || header.includes('الضريبة')) &&
      !header.includes('قبل الضريبة') &&
      !header.includes('شامل الضريبة')
    ) {
      return 'taxAmount';
    }
    if (header.includes('شامل الضريبة') || header.includes('الإجمالي')) {
      return 'formula:purchasesTotal';
    }
    if (header.includes('الرصيد')) return 'balance';
    if (header.includes('الرقم الضريبي')) return 'issuerTaxId';
    if (headerName === '#' || header.includes('رقم العملية')) return 'operationNumber';
  }
  return `extra:${colLetter}`;
}

async function inspectOfficialTemplate(buffer: Buffer | ArrayBuffer): Promise<{
  workbook: ExcelJS.Workbook;
  sheets: ServerTemplateSheetInfo[];
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  for (const required of ['ملخص الأداء', 'المبيعات', 'المشتريات والموردين']) {
    if (!sheetNames.includes(required)) {
      throw new Error(`ملف القالب غير متوافق: الورقة المطلوبة "${required}" غير موجودة.`);
    }
  }

  const sheets: ServerTemplateSheetInfo[] = [];

  for (const ws of workbook.worksheets) {
    let headerRowNumber = 1;
    let rawHeaders: { colNumber: number; colLetter: string; name: string }[] = [];

    const maxScan = Math.min(ws.rowCount || 15, 15);
    for (let r = 1; r <= maxScan; r++) {
      const row = ws.getRow(r);
      const rowCols: { colNumber: number; colLetter: string; name: string }[] = [];
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

      if (ws.name === 'المبيعات') {
        if (
          rowCols.some((c) => c.name.includes('التاريخ') || c.name.includes('تاريخ') || c.name.includes('تأريخ')) &&
          rowCols.some((c) => c.name.includes('المبيعات') || c.name.includes('الشبكة'))
        ) {
          headerRowNumber = r;
          rawHeaders = rowCols;
          break;
        }
      } else if (ws.name === 'المشتريات والموردين') {
        if (
          (rowCols.some((c) => c.name.includes('التاريخ') || c.name.includes('تاريخ') || c.name.includes('تأريخ')) &&
           rowCols.some((c) => c.name.includes('المورد'))) ||
          rowCols.some((c) => c.name.includes('الدفع') || c.name.includes('#'))
        ) {
          headerRowNumber = r;
          rawHeaders = rowCols;
          break;
        }
      } else if (rowCols.length >= 2 && rawHeaders.length === 0) {
        headerRowNumber = r;
        rawHeaders = rowCols;
      }
    }

    const dataStartRowNumber = headerRowNumber + 1;
    let totalsRowNumber: number | null = null;
    if (ws.name === 'المبيعات' || ws.name === 'المشتريات والموردين') {
      const maxRow = Math.max(ws.rowCount || 50, 50);
      for (let r = dataStartRowNumber; r <= maxRow; r++) {
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
      dataStartRowNumber,
      totalsRowNumber,
      columns: rawHeaders.map((h) => ({
        ...h,
        fieldKey: classifyColumnKey(ws.name, h.colLetter, h.name),
      })),
    });
  }

  return { workbook, sheets };
}

function isRowEmpty(row: ExcelJS.Row, colCount: number): boolean {
  for (let c = 1; c <= colCount; c++) {
    const v = row.getCell(c).value;
    if (v !== null && v !== undefined && v !== '') {
      if (typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
        continue;
      }
      return false;
    }
  }
  return true;
}

function findNextWritableRow(ws: ExcelJS.Worksheet, sheetInfo: ServerTemplateSheetInfo): number {
  const start = sheetInfo.dataStartRowNumber;
  const limit = sheetInfo.totalsRowNumber
    ? sheetInfo.totalsRowNumber - 1
    : Math.max(ws.rowCount, start);
  const colCount = Math.max(sheetInfo.columns.length, 6);

  let lastOccupied = start - 1;
  for (let r = start; r <= limit; r++) {
    if (!isRowEmpty(ws.getRow(r), colCount)) {
      lastOccupied = r;
    }
  }
  return lastOccupied + 1;
}

function parseExcelDateValue(dateValue: unknown): Date | null {
  const normalized = normalizeInvoiceDate(dateValue);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function copyRowStyle(sourceRow: ExcelJS.Row, targetRow: ExcelJS.Row, colCount: number) {
  if (sourceRow.height) {
    targetRow.height = sourceRow.height;
  }
  for (let c = 1; c <= colCount; c++) {
    targetRow.getCell(c).style = { ...sourceRow.getCell(c).style };
  }
}

function ensureWritableRowBeforeTotals(
  ws: ExcelJS.Worksheet,
  targetRowNumber: number,
  sheetInfo: ServerTemplateSheetInfo,
  workbook: ExcelJS.Workbook
): number {
  if (!sheetInfo.totalsRowNumber || targetRowNumber < sheetInfo.totalsRowNumber) {
    return sheetInfo.totalsRowNumber || targetRowNumber;
  }

  const oldTotalsRow = sheetInfo.totalsRowNumber;
  ws.spliceRows(oldTotalsRow, 0, []);
  const newTotalsRow = oldTotalsRow + 1;
  sheetInfo.totalsRowNumber = newTotalsRow;

  copyRowStyle(ws.getRow(oldTotalsRow - 1), ws.getRow(oldTotalsRow), sheetInfo.columns.length);

  const totalsRow = ws.getRow(newTotalsRow);
  const startRow = sheetInfo.dataStartRowNumber;
  const endRow = newTotalsRow - 1;

  if (ws.name === 'المبيعات') {
    for (const colLetter of ['C', 'D', 'E']) {
      totalsRow.getCell(colLetter).value = {
        formula: `SUM(${colLetter}${startRow}:${colLetter}${endRow})`,
      };
    }
    for (const colLetter of ['F', 'G', 'H']) {
      totalsRow.getCell(colLetter).value = {
        formula: `IFERROR(LOOKUP(2,1/(${colLetter}${startRow}:${colLetter}${endRow}<>""),${colLetter}${startRow}:${colLetter}${endRow}),0)`,
      };
    }
  } else if (ws.name === 'المشتريات والموردين') {
    for (const colLetter of ['F', 'G', 'H']) {
      totalsRow.getCell(colLetter).value = {
        formula: `SUM(${colLetter}${startRow}:${colLetter}${endRow})`,
      };
    }
    totalsRow.getCell('I').value = {
      formula: `IFERROR(LOOKUP(2,1/(I${startRow}:I${endRow}<>""),I${startRow}:I${endRow}),0)`,
    };
  }

  const summaryWs = workbook.getWorksheet('ملخص الأداء');
  if (summaryWs) {
    if (ws.name === 'المبيعات') {
      summaryWs.getCell('B6').value = { formula: `'المبيعات'!E${newTotalsRow}` };
      summaryWs.getCell('B9').value = {
        formula: `LOOKUP(2,1/('المبيعات'!F${startRow}:F${endRow}<>""),'المبيعات'!F${startRow}:F${endRow})`,
      };
      summaryWs.getCell('D9').value = {
        formula: `LOOKUP(2,1/('المبيعات'!G${startRow}:G${endRow}<>""),'المبيعات'!G${startRow}:G${endRow})`,
      };
      summaryWs.getCell('F9').value = {
        formula: `LOOKUP(2,1/('المبيعات'!H${startRow}:H${endRow}<>""),'المبيعات'!H${startRow}:H${endRow})`,
      };
    } else if (ws.name === 'المشتريات والموردين') {
      summaryWs.getCell('D6').value = { formula: `'المشتريات والموردين'!H${newTotalsRow}` };
    }
  }

  return newTotalsRow;
}

function findColumnByKeywords(
  columns: ServerTemplateColumnInfo[],
  keywords: string[],
  excludeKeywords: string[] = []
): ServerTemplateColumnInfo | undefined {
  for (const kw of keywords) {
    const normalizedKeyword = normalizeHeader(kw);
    const match = columns.find(
      (col) => normalizeHeader(col.name).includes(normalizedKeyword) && !excludeKeywords.some((ex) => normalizeHeader(col.name).includes(normalizeHeader(ex)))
    );
    if (match) return match;
  }
  return undefined;
}

export async function generateOfficialExcelOnServer(params: {
  organizationId: string;
  invoices: any[];
  alreadyExportedIds?: Set<string>;
}): Promise<ServerExportResult> {
  const templateBuf = await fs.readFile(SERVER_OFFICIAL_TEMPLATE_PATH);
  const templateSha256 = crypto.createHash('sha256').update(templateBuf).digest('hex');

  const { workbook, sheets } = await inspectOfficialTemplate(templateBuf);
  workbook.calcProperties.fullCalcOnLoad = true;

  const salesSheetInfo = sheets.find((s) => s.sheetName === 'المبيعات');
  const purchasesSheetInfo = sheets.find((s) => s.sheetName === 'المشتريات والموردين');
  if (!salesSheetInfo || !purchasesSheetInfo) {
    throw new Error('تعذر تحديد أوراق المبيعات والمشتريات في قالب Excel.');
  }

  const salesWs = workbook.getWorksheet(salesSheetInfo.sheetName)!;
  const purchasesWs = workbook.getWorksheet(purchasesSheetInfo.sheetName)!;

  let nextSalesRow = findNextWritableRow(salesWs, salesSheetInfo);
  let nextPurchasesRow = findNextWritableRow(purchasesWs, purchasesSheetInfo);

  const salesDateCol = findColumnByKeywords(salesSheetInfo.columns, ['تاريخ الفاتورة', 'تأريخ الفاتورة', 'التاريخ', 'تاريخ', 'تأريخ']);
  const salesDayCol = findColumnByKeywords(salesSheetInfo.columns, ['اليوم']);
  const salesCashCol = findColumnByKeywords(salesSheetInfo.columns, ['المبيعات النقدية', 'النقدية', 'الكاش'], ['رصيد']);
  const salesNetworkCol = findColumnByKeywords(salesSheetInfo.columns, ['الشبكة'], ['رصيد']);
  const salesTotalCol = findColumnByKeywords(salesSheetInfo.columns, ['إجمالي المبيعات', 'الإجمالي']);
  const salesCashBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الكاش']);
  const salesBoxBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الصندوق']);
  const salesNetBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الشبكة']);

  const purDateCol = findColumnByKeywords(purchasesSheetInfo.columns, ['تاريخ الفاتورة', 'تأريخ الفاتورة', 'التاريخ', 'تاريخ', 'تأريخ']);
  const purPaymentCol = findColumnByKeywords(purchasesSheetInfo.columns, ['طريقة الدفع', 'الدفع']);
  const purSupplierCol = findColumnByKeywords(purchasesSheetInfo.columns, ['اسم المورد', 'المورد']);
  const purInvoiceNumberCol = findColumnByKeywords(purchasesSheetInfo.columns, ['رقم الفاتورة']);
  const purTaxIdCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الرقم الضريبي']);
  const purSubtotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['المبلغ قبل الضريبة', 'قبل الضريبة']);
  const purTaxCol = findColumnByKeywords(
    purchasesSheetInfo.columns,
    ['ضريبة القيمة المضافة', 'الضريبة'],
    ['قبل الضريبة', 'شامل الضريبة']
  );
  const purTotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['شامل الضريبة', 'الإجمالي']);
  const purBalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الرصيد']);

  const seenIds = new Set<string>(params.alreadyExportedIds || []);
  const exportedOrBlockedInvoices: any[] = [];
  const entries: ServerExportEntry[] = [];
  let salesWritten = 0;
  let purchasesWritten = 0;
  let skippedDuplicates = 0;
  let skippedUnready = 0;

  for (const inv of params.invoices) {
    if (inv.status !== 'مكتملة') {
      skippedUnready++;
      continue;
    }
    if (inv.documentType !== 'مبيعات' && inv.documentType !== 'مشتريات') {
      skippedUnready++;
      continue;
    }
    if (!inv.invoiceDate || !String(inv.invoiceDate).trim()) {
      skippedUnready++;
      continue;
    }
    if (seenIds.has(inv.id)) {
      exportedOrBlockedInvoices.push(inv);
      skippedDuplicates++;
      continue;
    }
    if (findDuplicateInvoiceServer(inv, exportedOrBlockedInvoices).isDuplicate) {
      skippedDuplicates++;
      continue;
    }

    if (inv.documentType === 'مبيعات') {
      ensureWritableRowBeforeTotals(salesWs, nextSalesRow, salesSheetInfo, workbook);
      const row = salesWs.getRow(nextSalesRow);

      if (salesDateCol) row.getCell(salesDateCol.colNumber).value = parseExcelDateValue(inv.invoiceDate);
      if (salesDayCol && inv.day) row.getCell(salesDayCol.colNumber).value = inv.day;
      if (salesCashCol && inv.cashSales !== undefined && inv.cashSales !== null) {
        row.getCell(salesCashCol.colNumber).value = Number(inv.cashSales);
      }
      if (salesNetworkCol && inv.networkSales !== undefined && inv.networkSales !== null) {
        row.getCell(salesNetworkCol.colNumber).value = Number(inv.networkSales);
      }
      if (salesTotalCol) {
        if (
          (inv.cashSales !== undefined && inv.cashSales !== null) ||
          (inv.networkSales !== undefined && inv.networkSales !== null)
        ) {
          const cCol = salesCashCol?.colLetter || 'C';
          const dCol = salesNetworkCol?.colLetter || 'D';
          const calcResult = Number(inv.cashSales ?? 0) + Number(inv.networkSales ?? 0);
          row.getCell(salesTotalCol.colNumber).value = {
            formula: `${cCol}${nextSalesRow}+${dCol}${nextSalesRow}`,
            result: calcResult,
          };
        } else if (inv.grandTotal !== undefined && inv.grandTotal !== null) {
          row.getCell(salesTotalCol.colNumber).value = Number(inv.grandTotal);
        }
      }
      if (salesCashBalCol && inv.cashBalance !== undefined && inv.cashBalance !== null) {
        row.getCell(salesCashBalCol.colNumber).value = Number(inv.cashBalance);
      }
      if (salesBoxBalCol && inv.cashBoxBalance !== undefined && inv.cashBoxBalance !== null) {
        row.getCell(salesBoxBalCol.colNumber).value = Number(inv.cashBoxBalance);
      }
      if (salesNetBalCol && inv.networkBalance !== undefined && inv.networkBalance !== null) {
        row.getCell(salesNetBalCol.colNumber).value = Number(inv.networkBalance);
      }

      const extraSales = inv.extraColumnsData?.[salesSheetInfo.sheetName];
      if (extraSales) {
        for (const col of salesSheetInfo.columns) {
          if (col.fieldKey.startsWith('extra:')) {
            const val = extraSales[col.colLetter];
            if (val !== undefined && val !== '') row.getCell(col.colNumber).value = val;
          }
        }
      }

      seenIds.add(inv.id);
      exportedOrBlockedInvoices.push(inv);
      entries.push({
        invoiceId: inv.id,
        operationId: params.organizationId,
        sheetName: salesSheetInfo.sheetName,
        rowNumber: nextSalesRow,
        exportedAt: new Date().toISOString(),
        invoiceUpdatedAt: inv.updatedAt,
      });
      nextSalesRow++;
      salesWritten++;
    } else if (inv.documentType === 'مشتريات') {
      ensureWritableRowBeforeTotals(purchasesWs, nextPurchasesRow, purchasesSheetInfo, workbook);
      const row = purchasesWs.getRow(nextPurchasesRow);

      if (purDateCol) row.getCell(purDateCol.colNumber).value = parseExcelDateValue(inv.invoiceDate);
      if (purSupplierCol && inv.issuerName) row.getCell(purSupplierCol.colNumber).value = inv.issuerName;
      if (purPaymentCol) {
        const paymentMethod = inv.customFieldsValues?.__official_payment_method
          ?? inv.customFieldsValues?.paymentMethod
          ?? inv.customFieldsValues?.payment_method
          ?? inv.paymentMethod;
        if (paymentMethod !== undefined && paymentMethod !== null && String(paymentMethod).trim()) {
          row.getCell(purPaymentCol.colNumber).value = String(paymentMethod).trim();
        }
      }
      if (purInvoiceNumberCol && inv.invoiceNumber) row.getCell(purInvoiceNumberCol.colNumber).value = inv.invoiceNumber;
      if (purTaxIdCol && inv.issuerTaxId) row.getCell(purTaxIdCol.colNumber).value = inv.issuerTaxId;
      if (purSubtotalCol && inv.subtotal !== undefined && inv.subtotal !== null) {
        row.getCell(purSubtotalCol.colNumber).value = Number(inv.subtotal);
      }
      if (purTaxCol && inv.taxAmount !== undefined && inv.taxAmount !== null) {
        row.getCell(purTaxCol.colNumber).value = Number(inv.taxAmount);
      }
      if (purTotalCol) {
        if (
          (inv.subtotal !== undefined && inv.subtotal !== null) ||
          (inv.taxAmount !== undefined && inv.taxAmount !== null)
        ) {
          const cCol = purSubtotalCol?.colLetter || 'C';
          const dCol = purTaxCol?.colLetter || 'D';
          const calcResult = Number(inv.subtotal ?? 0) + Number(inv.taxAmount ?? 0);
          row.getCell(purTotalCol.colNumber).value = {
            formula: `${cCol}${nextPurchasesRow}+${dCol}${nextPurchasesRow}`,
            result: calcResult,
          };
        } else if (inv.grandTotal !== undefined && inv.grandTotal !== null) {
          row.getCell(purTotalCol.colNumber).value = Number(inv.grandTotal);
        }
      }
      if (purBalCol && inv.balance !== undefined && inv.balance !== null) {
        row.getCell(purBalCol.colNumber).value = Number(inv.balance);
      }

      const extraPurchases = inv.extraColumnsData?.[purchasesSheetInfo.sheetName];
      if (extraPurchases) {
        for (const col of purchasesSheetInfo.columns) {
          if (col.fieldKey.startsWith('extra:')) {
            const val = extraPurchases[col.colLetter];
            if (val !== undefined && val !== '') row.getCell(col.colNumber).value = val;
          }
        }
      }

      seenIds.add(inv.id);
      exportedOrBlockedInvoices.push(inv);
      entries.push({
        invoiceId: inv.id,
        operationId: params.organizationId,
        sheetName: purchasesSheetInfo.sheetName,
        rowNumber: nextPurchasesRow,
        exportedAt: new Date().toISOString(),
        invoiceUpdatedAt: inv.updatedAt,
      });
      nextPurchasesRow++;
      purchasesWritten++;
    }
  }

  const outArrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(outArrayBuffer as ArrayBuffer),
    templateSha256,
    exportedCount: entries.length,
    skippedDuplicates,
    skippedUnready,
    salesWritten,
    purchasesWritten,
    entries,
  };
}
