import ExcelJS from 'exceljs';
import { ExportTrackingEntry, InvoiceRecord, Operation } from '../types';
import {
  getOfficialTemplate,
  TemplateColumnInfo,
  TemplateSheetInfo,
  validateAndInspectTemplateBuffer,
} from './templateService';
import { recordExportBatch } from './dbService';

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

function parseExcelDateValue(dateStr: string): Date | string | null {
  const trimmed = (dateStr || '').trim();
  if (!trimmed) return null;
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]) - 1;
    const d = Number(isoMatch[3]);
    return new Date(Date.UTC(y, m, d));
  }
  return trimmed;
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
    for (const colLetter of ['C', 'D', 'E']) {
      totalsRow.getCell(colLetter).value = {
        formula: `SUM(${colLetter}${startRow}:${colLetter}${endRow})`,
      };
    }
    totalsRow.getCell('F').value = {
      formula: `IFERROR(LOOKUP(2,1/(F${startRow}:F${endRow}<>""),F${startRow}:F${endRow}),0)`,
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
      summaryWs.getCell('D6').value = { formula: `'المشتريات والموردين'!E${newTotalsRow}` };
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
  const salesDateCol = findColumnByKeywords(salesSheetInfo.columns, ['التاريخ']);
  const salesDayCol = findColumnByKeywords(salesSheetInfo.columns, ['اليوم']);
  const salesCashCol = findColumnByKeywords(salesSheetInfo.columns, ['المبيعات النقدية', 'النقدية', 'الكاش'], ['رصيد']);
  const salesNetworkCol = findColumnByKeywords(salesSheetInfo.columns, ['الشبكة'], ['رصيد']);
  const salesTotalCol = findColumnByKeywords(salesSheetInfo.columns, ['إجمالي المبيعات', 'الإجمالي']);
  const salesCashBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الكاش']);
  const salesBoxBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الصندوق']);
  const salesNetBalCol = findColumnByKeywords(salesSheetInfo.columns, ['رصيد الشبكة']);

  const purDateCol = findColumnByKeywords(purchasesSheetInfo.columns, ['التاريخ']);
  const purSupplierCol = findColumnByKeywords(purchasesSheetInfo.columns, ['اسم المورد', 'المورد']);
  const purSubtotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['المبلغ قبل الضريبة', 'قبل الضريبة']);
  const purTaxCol = findColumnByKeywords(
    purchasesSheetInfo.columns,
    ['ضريبة القيمة المضافة', 'الضريبة'],
    ['قبل الضريبة', 'شامل الضريبة']
  );
  const purTotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الإجمالي شامل الضريبة', 'الإجمالي']);
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

      // Any dynamic extra columns defined in future XLSX templates
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
      });
      nextSalesRow++;
      salesWritten++;
    } else if (inv.documentType === 'مشتريات') {
      ensureWritableRowBeforeTotals(purchasesWs, nextPurchasesRow, purchasesSheetInfo, workbook);
      const row = purchasesWs.getRow(nextPurchasesRow);

      if (purDateCol) {
        row.getCell(purDateCol.colNumber).value = parseExcelDateValue(inv.invoiceDate);
      }
      if (purSupplierCol && inv.issuerName) {
        row.getCell(purSupplierCol.colNumber).value = inv.issuerName;
      }
      if (purSubtotalCol && inv.subtotal !== undefined) {
        row.getCell(purSubtotalCol.colNumber).value = inv.subtotal;
      }
      if (purTaxCol && inv.taxAmount !== undefined) {
        row.getCell(purTaxCol.colNumber).value = inv.taxAmount;
      }
      if (purTotalCol) {
        if (inv.subtotal !== undefined || inv.taxAmount !== undefined) {
          const cCol = purSubtotalCol?.colLetter || 'C';
          const dCol = purTaxCol?.colLetter || 'D';
          const calcResult = Number(inv.subtotal ?? 0) + Number(inv.taxAmount ?? 0);
          row.getCell(purTotalCol.colNumber).value = {
            formula: `${cCol}${nextPurchasesRow}+${dCol}${nextPurchasesRow}`,
            result: calcResult,
          };
        } else if (inv.grandTotal !== undefined) {
          row.getCell(purTotalCol.colNumber).value = inv.grandTotal;
        }
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

/**
 * Single centralized export pipeline for an operation.
 * Always loads the verified official template (from IndexedDB or public/assets/templates/fawater_template.xlsx).
 */
export async function exportOperationToExcel(operation: Operation): Promise<ExportExecutionResult> {
  const template = await getOfficialTemplate();
  const approvedInvoices = (operation.invoices || []).filter((inv) => inv.status === 'مكتملة');
  if (approvedInvoices.length === 0) {
    throw new Error('لا توجد فواتير معتمدة (مكتملة) جاهزة للتصدير. يرجى مراجعة الفواتير واعتمادها أولاً.');
  }

  const result = await appendInvoicesToWorkbookBuffer(
    template.buffer,
    operation.invoices || [],
    operation.id,
    new Set()
  );

  if (result.exportedCount === 0) {
    throw new Error('لم يتم تصدير أي فاتورة: تأكد من تحديد نوع كل فاتورة (مبيعات أو مشتريات) وإدخال التاريخ ثم اعتمادها.');
  }

  recordExportBatch(operation.id, template.sha256, result.entries);

  const rawName = operation.excelFileName || `${operation.name}_fawater.xlsx`;
  const fileName = rawName.toLowerCase().endsWith('.xlsx') ? rawName : `${rawName}.xlsx`;

  return {
    ...result,
    fileName,
    templateSha256: template.sha256,
  };
}

export async function downloadOperationExcel(operation: Operation): Promise<ExportExecutionResult> {
  const result = await exportOperationToExcel(operation);
  const blob = new Blob([result.buffer.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return result;
}
