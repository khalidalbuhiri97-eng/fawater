import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

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

function classifyColumnKey(sheetName: string, colLetter: string, headerName: string): string {
  if (sheetName === 'المبيعات') {
    if (headerName.includes('التاريخ') || headerName.includes('تاريخ') || headerName.includes('تأريخ')) return 'invoiceDate';
    if (headerName.includes('اليوم')) return 'day';
    if (
      (headerName.includes('المبيعات النقدية') || headerName.includes('النقدية') || headerName.includes('الكاش')) &&
      !headerName.includes('رصيد')
    ) {
      return 'cashSales';
    }
    if (headerName.includes('الشبكة') && !headerName.includes('رصيد')) return 'networkSales';
    if (headerName.includes('إجمالي المبيعات') || headerName.includes('الإجمالي')) return 'formula:salesTotal';
    if (headerName.includes('رصيد الكاش')) return 'cashBalance';
    if (headerName.includes('رصيد الصندوق')) return 'cashBoxBalance';
    if (headerName.includes('رصيد الشبكة')) return 'networkBalance';
  } else if (sheetName === 'المشتريات والموردين') {
    if (headerName.includes('التاريخ') || headerName.includes('تاريخ') || headerName.includes('تأريخ')) return 'invoiceDate';
    if (headerName.includes('اسم المورد') || headerName.includes('المورد')) return 'issuerName';
    if (headerName.includes('الدفع') || headerName.includes('طريقة الدفع')) return 'paymentMethod';
    if (headerName.includes('رقم الفاتورة')) return 'invoiceNumber';
    if (headerName.includes('قبل الضريبة')) return 'subtotal';
    if (
      (headerName.includes('ضريبة القيمة المضافة') || headerName.includes('الضريبة')) &&
      !headerName.includes('قبل الضريبة') &&
      !headerName.includes('شامل الضريبة')
    ) {
      return 'taxAmount';
    }
    if (headerName.includes('شامل الضريبة') || headerName.includes('الإجمالي')) {
      return 'formula:purchasesTotal';
    }
    if (headerName.includes('الرصيد')) return 'balance';
    if (headerName.includes('الرقم الضريبي')) return 'issuerTaxId';
    if (headerName === '#' || headerName.includes('رقم العملية')) return 'operationNumber';
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

function parseExcelDateValue(dateStr: string): Date | string | null {
  const trimmed = (dateStr || '').trim();
  if (!trimmed) return null;
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (isoMatch) {
    return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  }
  return trimmed;
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
    for (const colLetter of ['C', 'D', 'E']) {
      totalsRow.getCell(colLetter).value = {
        formula: `SUM(${colLetter}${startRow}:${colLetter}${endRow})`,
      };
    }
    totalsRow.getCell('F').value = {
      formula: `IFERROR(LOOKUP(2,1/(F${startRow}:F${endRow}<>""),F${startRow}:F${endRow}),0)`,
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
      summaryWs.getCell('D6').value = { formula: `'المشتريات والموردين'!E${newTotalsRow}` };
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
    const match = columns.find(
      (col) => col.name.includes(kw) && !excludeKeywords.some((ex) => col.name.includes(ex))
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
  const purTotalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['شامل الضريبة', 'الإجمالي']);
  const purBalCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الرصيد']);
  const purPaymentCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الدفع', 'طريقة الدفع']);
  const purInvoiceNumberCol = findColumnByKeywords(purchasesSheetInfo.columns, ['رقم الفاتورة']);
  const purTaxIdCol = findColumnByKeywords(purchasesSheetInfo.columns, ['الرقم الضريبي']);

  const seenIds = new Set<string>(params.alreadyExportedIds || []);
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
      if (purPaymentCol && inv.paymentMethod) row.getCell(purPaymentCol.colNumber).value = inv.paymentMethod;
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
          const cCol = purSubtotalCol?.colLetter || 'G';
          const dCol = purTaxCol?.colLetter || 'H';
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


  // Rebuild totals and summary formulas using the detected data and totals rows.
  const salesTotalsRow = salesSheetInfo.totalsRowNumber;
  if (salesTotalsRow) {
    const totals = salesWs.getRow(salesTotalsRow);
    for (const colLetter of ['C', 'D', 'E']) totals.getCell(colLetter).value = { formula: `SUM(${colLetter}${salesSheetInfo.dataStartRowNumber}:${colLetter}${salesTotalsRow - 1})` };
    for (const colLetter of ['F', 'G', 'H']) totals.getCell(colLetter).value = { formula: `IFERROR(LOOKUP(2,1/(${colLetter}${salesSheetInfo.dataStartRowNumber}:${colLetter}${salesTotalsRow - 1}<>""),${colLetter}${salesSheetInfo.dataStartRowNumber}:${colLetter}${salesTotalsRow - 1}),0)` };
  }
  const purchasesTotalsRow = purchasesSheetInfo.totalsRowNumber;
  if (purchasesTotalsRow) {
    const totals = purchasesWs.getRow(purchasesTotalsRow);
    for (const colLetter of ['G', 'H', 'I']) totals.getCell(colLetter).value = { formula: `SUM(${colLetter}${purchasesSheetInfo.dataStartRowNumber}:${colLetter}${purchasesTotalsRow - 1})` };
    totals.getCell('J').value = { formula: `IFERROR(LOOKUP(2,1/(J${purchasesSheetInfo.dataStartRowNumber}:J${purchasesTotalsRow - 1}<>""),J${purchasesSheetInfo.dataStartRowNumber}:J${purchasesTotalsRow - 1}),0)` };
  }
  const summary = workbook.getWorksheet('ملخص الأداء');
  if (summary) {
    if (salesTotalsRow) summary.getCell('B6').value = { formula: `'المبيعات'!E${salesTotalsRow}` };
    if (purchasesTotalsRow) summary.getCell('D6').value = { formula: `'المشتريات والموردين'!I${purchasesTotalsRow}` };
    summary.getCell('F6').value = { formula: 'B6-D6' };
    const lastSalesRow = (salesTotalsRow || salesSheetInfo.dataStartRowNumber + 1) - 1;
    for (const [cell, col] of [['B9', 'F'], ['D9', 'G'], ['F9', 'H']] as const) {
      summary.getCell(cell).value = { formula: `IFERROR(LOOKUP(2,1/('المبيعات'!${col}${salesSheetInfo.dataStartRowNumber}:${col}${lastSalesRow}<>""),'المبيعات'!${col}${salesSheetInfo.dataStartRowNumber}:${col}${lastSalesRow}),0)` };
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
