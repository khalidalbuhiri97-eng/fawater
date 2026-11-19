/**
 * Normalize invoice dates received from AI, manual entry, or persisted queue data.
 * Returns an ISO calendar date or null; accepts ISO, YYYY/MM/DD, DD/MM/YYYY and DD-MM-YYYY.
 */
export function normalizeInvoiceDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const digits = raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  const datePart = digits.match(/^\d{4}-\d{1,2}-\d{1,2}/)?.[0] || digits;
  const match = /^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})$/.exec(datePart);
  if (!match) {
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) return null;
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
  }
  let year: number, month: number, day: number;
  if (match[1].length === 4) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if (match[3].length === 4) {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
