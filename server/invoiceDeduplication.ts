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

function resolveAmount(inv: any): number | null {
  const directTotal = toFiniteNumber(inv?.grandTotal ?? inv?.grand_total);
  if (directTotal !== null) return directTotal;
  const docType = inv?.documentType ?? inv?.document_type;
  if (docType === 'مبيعات') {
    const c = toFiniteNumber(inv?.cashSales ?? inv?.cash_sales);
    const n = toFiniteNumber(inv?.networkSales ?? inv?.network_sales);
    if (c !== null || n !== null) return (c ?? 0) + (n ?? 0);
  } else {
    const s = toFiniteNumber(inv?.subtotal);
    const t = toFiniteNumber(inv?.taxAmount ?? inv?.tax_amount);
    if (s !== null || t !== null) return (s ?? 0) + (t ?? 0);
  }
  return null;
}

function amountsEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.01;
}

export function getServerInvoiceSha256(inv: any): string {
  const sha = inv?.extraColumnsData?.imageSha256 ?? inv?.extra_columns_data?.imageSha256;
  return typeof sha === 'string' && sha.trim() ? sha.trim().toLowerCase() : '';
}

export function findDuplicateInvoiceServer(
  candidate: any,
  existingList: any[]
): { isDuplicate: boolean; matchedInvoice?: any; reason?: string } {
  const candId = candidate?.id;
  const candSha = getServerInvoiceSha256(candidate);
  const candNum = normalizeInvoiceNumber(candidate?.invoiceNumber ?? candidate?.invoice_number);
  const candVendor = normalizeText(candidate?.issuerName ?? candidate?.issuer_name);
  const candTax = normalizeTaxId(candidate?.issuerTaxId ?? candidate?.issuer_tax_id);
  const candDate = normalizeDate(candidate?.invoiceDate ?? candidate?.invoice_date);
  const candDocType = candidate?.documentType ?? candidate?.document_type;
  const candTotal = resolveAmount(candidate);
  const candCash = toFiniteNumber(candidate?.cashSales ?? candidate?.cash_sales);
  const candNet = toFiniteNumber(candidate?.networkSales ?? candidate?.network_sales);

  for (const existing of existingList) {
    if (!existing || (candId && existing.id && candId === existing.id)) continue;

    const exSha = getServerInvoiceSha256(existing);
    if (candSha && exSha && candSha === exSha) {
      return {
        isDuplicate: true,
        matchedInvoice: existing,
        reason: 'نفس صورة الفاتورة مرفوعة مسبقاً',
      };
    }

    const exNum = normalizeInvoiceNumber(existing?.invoiceNumber ?? existing?.invoice_number);
    if (candNum && exNum && candNum !== exNum) {
      continue;
    }

    const exDocType = existing?.documentType ?? existing?.document_type;
    const sameDocType =
      !candDocType ||
      !exDocType ||
      candDocType === exDocType ||
      candDocType === 'يحتاج تحديد النوع' ||
      exDocType === 'يحتاج تحديد النوع';

    if (!sameDocType) continue;

    const exVendor = normalizeText(existing?.issuerName ?? existing?.issuer_name);
    const exTax = normalizeTaxId(existing?.issuerTaxId ?? existing?.issuer_tax_id);
    const exDate = normalizeDate(existing?.invoiceDate ?? existing?.invoice_date);
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
          reason: `فاتورة مكررة بنفس الرقم (${candidate?.invoiceNumber ?? candidate?.invoice_number})`,
        };
      }
    }

    if (candDocType === 'مشتريات' || exDocType === 'مشتريات') {
      if (sameDate && sameVendor && sameTotal && candTotal !== null && candTotal > 0) {
        return {
          isDuplicate: true,
          matchedInvoice: existing,
          reason: `فاتورة مشتريات مكررة لنفس المورد (${existing?.issuerName ?? existing?.issuer_name ?? ''}) والتاريخ والمبلغ`,
        };
      }
    } else if (candDocType === 'مبيعات' && exDocType === 'مبيعات') {
      const exCash = toFiniteNumber(existing?.cashSales ?? existing?.cash_sales);
      const exNet = toFiniteNumber(existing?.networkSales ?? existing?.network_sales);
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
