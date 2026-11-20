import { InvoiceRecord } from '../types';

export interface DuplicateMatchResult {
  isDuplicate: boolean;
  matchedInvoice?: InvoiceRecord;
  reason?: string;
}

function normalizeDigits(val: unknown): string {
  return String(val ?? '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function normalizeText(val: unknown): string {
  return normalizeDigits(val)
    .replace(/[\u064B-\u065F\u0670ـ]/g, '')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeInvoiceNumber(val: unknown): string {
  const cleaned = normalizeText(val).replace(/^[#:\-_/]+/, '').trim();
  if (!cleaned) return '';
  if (
    cleaned === 'بدون رقم' ||
    cleaned === 'null' ||
    cleaned === 'undefined' ||
    cleaned === 'n/a' ||
    cleaned === '-' ||
    cleaned === '—' ||
    cleaned === '0'
  ) {
    return '';
  }
  return cleaned;
}

function normalizeTaxId(val: unknown): string {
  const digits = normalizeDigits(val).replace(/[^0-9a-z]/gi, '').trim().toLowerCase();
  return digits.length >= 5 ? digits : '';
}

function normalizeDate(val: unknown): string {
  return normalizeDigits(val).trim();
}

function toFiniteNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function resolveAmount(inv: Partial<InvoiceRecord>): number | null {
  const directTotal = toFiniteNumber(inv.grandTotal);
  if (directTotal !== null) return directTotal;
  if (inv.documentType === 'مبيعات') {
    const c = toFiniteNumber(inv.cashSales);
    const n = toFiniteNumber(inv.networkSales);
    if (c !== null || n !== null) return (c ?? 0) + (n ?? 0);
  } else {
    const s = toFiniteNumber(inv.subtotal);
    const t = toFiniteNumber(inv.taxAmount);
    if (s !== null || t !== null) return (s ?? 0) + (t ?? 0);
  }
  return null;
}

function amountsEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.01;
}

export function getInvoiceSha256(inv: Partial<InvoiceRecord> | any): string {
  const sha = inv?.extraColumnsData?.imageSha256 ?? inv?.extra_columns_data?.imageSha256;
  return typeof sha === 'string' && sha.trim() ? sha.trim().toLowerCase() : '';
}

/**
 * Checks whether a candidate invoice logically duplicates any invoice already in `existingList`.
 * Distinct non-empty invoice numbers are never treated as duplicates of each other.
 */
export function findDuplicateInvoice<T extends Partial<InvoiceRecord> & { id?: string }>(
  candidate: T,
  existingList: T[]
): { isDuplicate: boolean; matchedInvoice?: T; reason?: string } {
  const candSha = getInvoiceSha256(candidate);
  const candNum = normalizeInvoiceNumber(candidate.invoiceNumber);
  const candVendor = normalizeText(candidate.issuerName);
  const candTax = normalizeTaxId(candidate.issuerTaxId);
  const candDate = normalizeDate(candidate.invoiceDate);
  const candTotal = resolveAmount(candidate);
  const candCash = toFiniteNumber(candidate.cashSales);
  const candNet = toFiniteNumber(candidate.networkSales);

  for (const existing of existingList) {
    if (!existing || (candidate.id && existing.id && candidate.id === existing.id)) continue;

    const exSha = getInvoiceSha256(existing);
    if (candSha && exSha && candSha === exSha) {
      return {
        isDuplicate: true,
        matchedInvoice: existing,
        reason: 'نفس صورة الفاتورة مرفوعة مسبقاً',
      };
    }

    const exNum = normalizeInvoiceNumber(existing.invoiceNumber);
    if (candNum && exNum && candNum !== exNum) {
      continue;
    }

    const sameDocType =
      !candidate.documentType ||
      !existing.documentType ||
      candidate.documentType === existing.documentType ||
      candidate.documentType === 'يحتاج تحديد النوع' ||
      existing.documentType === 'يحتاج تحديد النوع';

    if (!sameDocType) continue;

    const exVendor = normalizeText(existing.issuerName);
    const exTax = normalizeTaxId(existing.issuerTaxId);
    const exDate = normalizeDate(existing.invoiceDate);
    const exTotal = resolveAmount(existing);

    const sameTaxId = Boolean(candTax && exTax && candTax === exTax);
    const sameVendorName = Boolean(candVendor && exVendor && candVendor === exVendor);
    const sameVendor = sameTaxId || sameVendorName;
    const sameDate = Boolean(candDate && exDate && candDate === exDate);
    const sameTotal = amountsEqual(candTotal, exTotal);

    if (candNum && exNum && candNum === exNum) {
      if (sameVendor || (sameDate && sameTotal) || (candNum.length >= 4 && sameTotal)) {
        return {
          isDuplicate: true,
          matchedInvoice: existing,
          reason: `فاتورة مكررة بنفس الرقم (${candidate.invoiceNumber})`,
        };
      }
    }

    // Fallback match for receipts missing an invoice number (or read without number in one copy)
    if (candidate.documentType === 'مشتريات' || existing.documentType === 'مشتريات') {
      if (sameDate && sameVendor && sameTotal && candTotal !== null && candTotal > 0) {
        return {
          isDuplicate: true,
          matchedInvoice: existing,
          reason: `فاتورة مشتريات مكررة لنفس المورد (${existing.issuerName || candidate.issuerName}) والتاريخ والمبلغ`,
        };
      }
    } else if (candidate.documentType === 'مبيعات' && existing.documentType === 'مبيعات') {
      const exCash = toFiniteNumber(existing.cashSales);
      const exNet = toFiniteNumber(existing.networkSales);
      const bothHaveSplit =
        (candCash !== null || candNet !== null) && (exCash !== null || exNet !== null);
      const splitMatches = bothHaveSplit
        ? amountsEqual(candCash ?? 0, exCash ?? 0) && amountsEqual(candNet ?? 0, exNet ?? 0)
        : true;
      if (sameDate && sameTotal && splitMatches && candTotal !== null && candTotal > 0) {
        return {
          isDuplicate: true,
          matchedInvoice: existing,
          reason: `فاتورة مبيعات مكررة بنفس التاريخ (${candDate}) والمبلغ`,
        };
      }
    }
  }

  return { isDuplicate: false };
}
