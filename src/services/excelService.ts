import ExcelJS from 'exceljs';
import { ExportTrackingEntry, ExportTrackingRecord, InvoiceRecord, Operation } from '../types';
import {
  getOfficialTemplate,
  TemplateColumnInfo,
  TemplateSheetInfo,
  validateAndInspectTemplateBuffer,
} from './templateService';
import { getExportTracking, getSavedExportFile, recordExportBatch } from './dbService';
import { generateUuid } from './localStore';

export interface ExportExecutionResult {
  buffer: Uint8Array;
  fileName: string;
  templateSha256: string;
  exportedCount: number;
  skippedDuplicates: number;
  skippedUnready: number;
  salesWritten: number;
  purchasesWritten: number;
  entries: ExportTrackingEntry[];
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
    if ('formula' in v) return '';
    return '';
  }
  return String(v).trim();
}

function isRowEmpty(row: ExcelJS.Row, colCount: number): boolean {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    const v = cell.value;
    if (v !== null && v !== undefined && v !== '') {
      if (typeof v === 'object' && 'formula' in v) {
        // Formula cell alone without key inputs doesn't mean occupied, unless another col has value
        continue;
      }
      return false;
    }
  }
  return true;
}

function findNextWritableRow(
  ws: ExcelJS.Worksheet,
  sheetInfo: TemplateSheetInfo
): number {
  const start = sheetInfo.dataStartRowNumber;
  const limit = sheetInfo.totalsRowNumber
    ? sheetInfo.totalsRowNumber - 1
    : Math.max(ws.rowCount, start);
  const colCount = Math.max(sheetInfo.columns.length, 6);

  let lastOccupied = start - 1;
  for (let r = start; r <= limit; r++) {
    const row = ws.getRow(r);
    if (!isRowEmpty(row, colCount)) {
      lastOccupied = r;
    }
  }
  return lastOccupied + 1;
}

function parseExcelDateValue(dateStr: string): Date | null {
  const raw = String(dateStr || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  const datePart = digits.match(/^\d{4}-\d{1,2}-\d{1,2}/)?.[0] || digits;
  const match = /^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})$/.exec(datePart);
  if (!match) {
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime())
      ? new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()))
      : null;
  }
  let year: number, month: number, day: number;
  if (match[1].length === 4) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if (match[3].length === 4) {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return check;
}

function copyRowStyle(sourceRow: ExcelJS.Row, targetRow: ExcelJS.Row, colCount: number) {
  if (sourceRow.height) {
    targetRow.height = sourceRow.height;
  }
  for (let c = 1; c <= colCount; c++) {
    const srcCell = sourceRow.getCell(c);
    const dstCell = targetRow.getCell(c);
    dstCell.style = { ...srcCell.style };
  }
}

function ensureWritableRowBeforeTotals(
  ws: ExcelJS.Worksheet,
  targetRowNumber: number,
  sheetInfo: TemplateSheetInfo,
  workbook: ExcelJS.Workbook
): number {
  if (!sheetInfo.totalsRowNumber || targetRowNumber < sheetInfo.totalsRowNumber) {
    return sheetInfo.totalsRowNumber || targetRowNumber;
  }

  // Insert one empty row right at totalsRowNumber, shifting الإجمالي down by 1
  const oldTotalsRow = sheetInfo.totalsRowNumber;
  ws.spliceRows(oldTotalsRow, 0, []);
  const newTotalsRow = oldTotalsRow + 1;
  sheetInfo.totalsRowNumber = newTotalsRow;

  const colCount = sheetInfo.columns.length;
  const templateDataRow = ws.getRow(oldTotalsRow - 1);
  const newlyInsertedRow = ws.getRow(oldTotalsRow);
  copyRowStyle(templateDataRow, newlyInsertedRow, colCount);

  // Rewrite totals formulas explicitly so shared formulas never break on shifted rows
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

  // Update ملخص الأداء references if totals row shifted beyond row 35
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
  columns: TemplateColumnInfo[],
  keywords: string[],
  excludeKeywords: string[] = []
): TemplateColumnInfo | undefined {
  for (const kw of keywords) {
    const match = columns.find(
      (col) => col.name.includes(kw) && !excludeKeywords.some((ex) => col.name.includes(ex))
    );
    if (match) return match;
  }
  return undefined;
}

/**
 * Appends approved invoices into an existing template/workbook buffer using ExcelJS,
 * preserving all formatting, colors, fonts, borders, merges, widths, heights, and formulas,
 * and preventing duplicate exports by unique invoice ID.
 */
export async function appendInvoicesToWorkbookBuffer(
  workbookBuffer: ArrayBuffer,
  invoices: InvoiceRecord[],
  operationId: string,
  alreadyExportedIds: Set<string> = new Set()
): Promise<Omit<ExportExecutionResult, 'fileName' | 'templateSha256'>> {
  const { workbook, sheets } = await validateAndInspectTemplateBuffer(workbookBuffer);
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

  // Dynamic column mapping from inspected template headers
  const salesDateCol = findColumnByKeywords(salesSheetInfo.columns, ['تاريخ الفاتورة', 'تأريخ الفاتورة', 'التاريخ', 'تاريخ', 'تأريخ']);
  const salesDayCol = findColumnByKeywords(salesSheetInfo.columns, ['اليوم']);
  const salesCashCol = findColumnByKeywords(salesSheetInfo.columns, ['المبيعات النقدية', 'النقدية', 'الكاش'], ['رصيد']);
  const salesNetworkCol = findColumnByKeywords(salesSheetInfo.columns, ['الشبكة'], ['رصيد']);
  const salesTotalCol = findColumnByKeywords(salesSheetInfo.columns, ['إجمالي المبيعات', 'الإجمالي']);
  const salesCashBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الكاش']);
  const salesBoxBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الصندوق']);
  const salesNetBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الشبكة']);

  const purOperationCol = findColumnByKeywords(purchasesSheetInfo.columns, ['#', 'رقم العملية']);
  const purSupplierCol = findColumnByKeywords(purchasesSheetInfo.columns, ['اسم المورد', 'المورد']);
  const purPaymentCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الدفع', 'طريقة الدفع']);
  const purDateCol = findColumnByKeywords(purchasesSheetInfo.columns, ['تأريخ الفاتورة', 'تاريخ الفاتورة', 'التاريخ']);
  const purInvoiceNumberCol = findColumnByKeywords(purchasesSheetInfo.columns, ['رقم الفاتورة']);
  const purTaxIdCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الرقم الضريبي']);
  const purSubtotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['المبلغ قبل الضريبة', 'قبل الضريبة']);
  const purTaxCol = findColumnByKeywords(
    purchasesSheetInfo.columns,
    ['ضريبة القيمة المضافة', 'الضريبة'],
    ['قبل الضريبة', 'شامل الضريبة']
  );
  const purTotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['المبلغ شامل الضريبة', 'شامل الضريبة']);
  const purBalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الرصيد']);

  const seenIds = new Set<string>(alreadyExportedIds);
  const entries: ExportTrackingEntry[] = [];
  let salesWritten = 0;
  let purchasesWritten = 0;
  let skippedDuplicates = 0;
  let skippedUnready = 0;

  for (const inv of invoices) {
    if (inv.status !== 'مكتملة') {
      skippedUnready++;
      continue;
    }

    if (inv.documentType !== 'مبيعات' && inv.documentType !== 'مشتريات') {
      skippedUnready++;
      continue;
    }

    if (!inv.invoiceDate || !inv.invoiceDate.trim()) {
      skippedUnready++;
      continue;
    }

    if (seenIds.has(inv.id)) {
      skippedDuplicates++;
      continue;
    }

    if (inv.documentType === 'مبيعات') {
      ensureWritableRowBeforeTotals(salesWs, nextSalesRow, salesSheetInfo, workbook);
      const row = salesWs.getRow(nextSalesRow);

      if (salesDateCol) {
        row.getCell(salesDateCol.colNumber).value = parseExcelDateValue(inv.invoiceDate);
      }
      if (salesDayCol && inv.day) {
        row.getCell(salesDayCol.colNumber).value = inv.day;
      }
      if (salesCashCol && inv.cashSales !== undefined) {
        row.getCell(salesCashCol.colNumber).value = inv.cashSales;
      }
      if (salesNetworkCol && inv.networkSales !== undefined) {
        row.getCell(salesNetworkCol.colNumber).value = inv.networkSales;
      }
      if (salesTotalCol) {
        if (inv.cashSales !== undefined || inv.networkSales !== undefined) {
          const cCol = salesCashCol?.colLetter || 'C';
          const dCol = salesNetworkCol?.colLetter || 'D';
          const calcResult = Number(inv.cashSales ?? 0) + Number(inv.networkSales ?? 0);
          row.getCell(salesTotalCol.colNumber).value = {
            formula: `${cCol}${nextSalesRow}+${dCol}${nextSalesRow}`,
            result: calcResult,
          };
        } else if (inv.grandTotal !== undefined) {
          row.getCell(salesTotalCol.colNumber).value = inv.grandTotal;
        }
      }
      if (salesCashBalCol && inv.cashBalance !== undefined) {
        row.getCell(salesCashBalCol.colNumber).value = inv.cashBalance;
      }
      if (salesBoxBalCol && inv.cashBoxBalance !== undefined) {
        row.getCell(salesBoxBalCol.colNumber).value = inv.cashBoxBalance;
      }
      if (salesNetBalCol && inv.networkBalance !== undefined) {
        row.getCell(salesNetBalCol.colNumber).value = inv.networkBalance;
      }

      const extraSales = inv.extraColumnsData?.[salesSheetInfo.sheetName];
      if (extraSales) {
        for (const col of salesSheetInfo.columns) {
          if (col.fieldKey.startsWith('extra:')) {
            const val = extraSales[col.colLetter];
            if (val !== undefined && val !== '') {
              row.getCell(col.colNumber).value = val;
            }
          }
        }
      }

      seenIds.add(inv.id);
      entries.push({
        invoiceId: inv.id,
        operationId,
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

      if (purOperationCol) row.getCell(purOperationCol.colNumber).value = nextPurchasesRow - purchasesSheetInfo.dataStartRowNumber + 1;
      if (purSupplierCol && inv.issuerName) row.getCell(purSupplierCol.colNumber).value = inv.issuerName;
      if (purPaymentCol) {
        const paymentMethod = inv.customFieldsValues?.__official_payment_method;
        if (paymentMethod !== undefined && paymentMethod !== '') row.getCell(purPaymentCol.colNumber).value = paymentMethod;
      }
      if (purDateCol) {
        row.getCell(purDateCol.colNumber).value = parseExcelDateValue(inv.invoiceDate);
      }
      if (purInvoiceNumberCol && inv.invoiceNumber) row.getCell(purInvoiceNumberCol.colNumber).value = inv.invoiceNumber;
      if (purTaxIdCol && inv.issuerTaxId) row.getCell(purTaxIdCol.colNumber).value = inv.issuerTaxId;
      if (purSubtotalCol && inv.subtotal !== undefined) {
        row.getCell(purSubtotalCol.colNumber).value = inv.subtotal;
      }
      if (purTaxCol && inv.taxAmount !== undefined) {
        row.getCell(purTaxCol.colNumber).value = inv.taxAmount;
      }
      if (purTotalCol) {
        const grossTotal = inv.grandTotal ?? (inv.subtotal !== undefined || inv.taxAmount !== undefined
          ? Number(inv.subtotal ?? 0) + Number(inv.taxAmount ?? 0)
          : undefined);
        if (grossTotal !== undefined) row.getCell(purTotalCol.colNumber).value = grossTotal;
      }
      if (purBalCol && inv.balance !== undefined) {
        row.getCell(purBalCol.colNumber).value = inv.balance;
      }

      const extraPurchases = inv.extraColumnsData?.[purchasesSheetInfo.sheetName];
      if (extraPurchases) {
        for (const col of purchasesSheetInfo.columns) {
          if (col.fieldKey.startsWith('extra:')) {
            const val = extraPurchases[col.colLetter];
            if (val !== undefined && val !== '') {
              row.getCell(col.colNumber).value = val;
            }
          }
        }
      }

      seenIds.add(inv.id);
      entries.push({
        invoiceId: inv.id,
        operationId,
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
    buffer: new Uint8Array(outArrayBuffer as ArrayBuffer),
    exportedCount: entries.length,
    skippedDuplicates,
    skippedUnready,
    salesWritten,
    purchasesWritten,
    entries,
  };
}

export interface OperationExportSummary {
  newReadyInvoices: InvoiceRecord[];
  modifiedReadyInvoices: InvoiceRecord[];
  alreadyExportedUnchangedInvoices: InvoiceRecord[];
  pendingInvoices: InvoiceRecord[];
}

export function getOperationExportSummary(
  operation: Operation,
  tracking: ExportTrackingRecord | null
): OperationExportSummary {
  const entryMap = new Map<string, ExportTrackingEntry>();
  for (const e of tracking?.entries || []) {
    entryMap.set(e.invoiceId, e);
  }
  const exportedIdSet = new Set(tracking?.exportedInvoiceIds || []);

  const newReadyInvoices: InvoiceRecord[] = [];
  const modifiedReadyInvoices: InvoiceRecord[] = [];
  const alreadyExportedUnchangedInvoices: InvoiceRecord[] = [];
  const pendingInvoices: InvoiceRecord[] = [];

  for (const inv of operation.invoices || []) {
    const isReady =
      inv.status === 'مكتملة' &&
      Boolean(inv.invoiceDate && inv.invoiceDate.trim()) &&
      (inv.documentType === 'مبيعات' || inv.documentType === 'مشتريات');

    if (!isReady) {
      pendingInvoices.push(inv);
      continue;
    }

    const prevEntry = entryMap.get(inv.id);
    if (!prevEntry && !exportedIdSet.has(inv.id)) {
      newReadyInvoices.push(inv);
    } else if (
      prevEntry &&
      prevEntry.invoiceUpdatedAt &&
      inv.updatedAt &&
      inv.updatedAt > prevEntry.invoiceUpdatedAt
    ) {
      modifiedReadyInvoices.push(inv);
    } else {
      alreadyExportedUnchangedInvoices.push(inv);
    }
  }

  return {
    newReadyInvoices,
    modifiedReadyInvoices,
    alreadyExportedUnchangedInvoices,
    pendingInvoices,
  };
}

/**
 * Single centralized incremental export pipeline for an organization.
 * Reads real export history BEFORE exporting to strictly block duplicate exports,
 * allows modified-since-export invoices as an explicit new batch while keeping history intact,
 * and registers export tracking ONLY after XLSX buffer creation succeeds.
 */
export async function exportOperationToExcel(
  operation: Operation,
  options?: { includeModified?: boolean }
): Promise<ExportExecutionResult & { batchId: string; modifiedIncluded: number }> {
  const includeModified = options?.includeModified ?? true;
  const template = await getOfficialTemplate();
  const tracking = await getExportTracking(operation.id);
  const summary = getOperationExportSummary(operation, tracking);

  const exportable = includeModified
    ? [...summary.newReadyInvoices, ...summary.modifiedReadyInvoices]
    : [...summary.newReadyInvoices];

  if (exportable.length === 0) {
    if (summary.alreadyExportedUnchangedInvoices.length > 0 && summary.pendingInvoices.length === 0) {
      throw new Error(
        `تم تصدير جميع الفواتير المعتمدة مسبقاً (${summary.alreadyExportedUnchangedInvoices.length} فاتورة) ولا توجد فواتير جديدة للتصدير دون تكرار. يمكنك إعادة تنزيل الملفات السابقة من سجل الدفعات أدناه.`
      );
    }
    if (summary.alreadyExportedUnchangedInvoices.length > 0) {
      throw new Error(
        `لا توجد فواتير معتمدة جديدة للتصدير (${summary.alreadyExportedUnchangedInvoices.length} تم تصديرها مسبقاً، و${summary.pendingInvoices.length} بانتظار المراجعة/إدخال التاريخ).`
      );
    }
    throw new Error(
      'لا توجد فواتير معتمدة ومؤرخة جاهزة للتصدير. يرجى مراجعة الفواتير وإدخال التاريخ واعتمادها أولاً.'
    );
  }

  // Strictly block unchanged previously-exported invoices at workbook writer level
  const blockedIds = new Set(summary.alreadyExportedUnchangedInvoices.map((i) => i.id));
  const result = await appendInvoicesToWorkbookBuffer(
    template.buffer,
    operation.invoices || [],
    operation.id,
    blockedIds
  );

  if (result.exportedCount === 0) {
    throw new Error('لم يتم تصدير أي فاتورة: تأكد من تحديد نوع كل فاتورة وإدخال التاريخ واعتمادها.');
  }

  const batchId = generateUuid();
  const baseRaw = (operation.excelFileName || `${operation.name}_fawater.xlsx`).replace(/\.xlsx$/i, '');
  const batchNumber = (tracking?.batches?.length || 0) + 1;
  const fileName = batchNumber === 1 ? `${baseRaw}.xlsx` : `${baseRaw}_batch${batchNumber}.xlsx`;

  const exactCopy = new Uint8Array(result.buffer.byteLength);
  exactCopy.set(result.buffer);

  // Record tracking + batch file ONLY after XLSX generation succeeded
  await recordExportBatch({
    batchId,
    operationId: operation.id,
    fileName,
    templateSha256: template.sha256,
    entries: result.entries,
    salesCount: result.salesWritten,
    purchasesCount: result.purchasesWritten,
    xlsxBuffer: exactCopy.buffer,
  });

  return {
    ...result,
    batchId,
    modifiedIncluded: includeModified ? summary.modifiedReadyInvoices.length : 0,
    fileName,
    templateSha256: template.sha256,
  };
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadOperationExcel(
  operation: Operation,
  options?: { includeModified?: boolean }
): Promise<ExportExecutionResult & { batchId: string; modifiedIncluded: number }> {
  const result = await exportOperationToExcel(operation, options);
  const blob = new Blob([result.buffer.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerBrowserDownload(blob, result.fileName);
  return result;
}

export async function downloadSavedExportBatch(batchId: string, fallbackFileName?: string): Promise<void> {
  const localFile = await getSavedExportFile(batchId);
  if (localFile?.buffer) {
    const blob = new Blob([localFile.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    triggerBrowserDownload(blob, localFile.fileName || fallbackFileName || 'fawater_export.xlsx');
    return;
  }

  const res = await fetch(`/api/supabase/exports/${encodeURIComponent(batchId)}/download`);
  if (res.ok) {
    const blob = await res.blob();
    triggerBrowserDownload(blob, fallbackFileName || 'fawater_export.xlsx');
    return;
  }

  const bgRes = await fetch(`/api/background/exports/${encodeURIComponent(batchId)}/download`);
  if (bgRes.ok) {
    const blob = await bgRes.blob();
    triggerBrowserDownload(blob, fallbackFileName || 'fawater_export.xlsx');
    return;
  }

  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || 'تعذر تنزيل ملف هذه الدفعة محلياً أو من الخادم.');
}
