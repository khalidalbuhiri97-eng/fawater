import { Operation, InvoiceRecord } from '../types';
import * as XLSX from 'xlsx';

const STORAGE_KEY = 'sooq_operations_db_v2';
const TEMPLATE_STORAGE_KEY = 'fawater_custom_template_base64';

export function getOperations(): Operation[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) {
      const defaultOp: Operation = {
        id: 'op_' + Date.now(),
        name: 'حسابات المؤسسة',
        activityType: 'تجارة عامة',
        createdAt: new Date().toISOString().split('T')[0],
        updatedAt: new Date().toISOString().split('T')[0],
        templateType: 'new',
        customFields: [],
        invoices: [],
        excelFileName: 'fawater_export.xlsx'
      };
      saveOperations([defaultOp]);
      return [defaultOp];
    }
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading operations:', e);
    return [];
  }
}

export function saveOperations(ops: Operation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
  } catch (e) {
    console.error('LocalStorage quota exceeded, trimming image base64:', e);
    const trimmed = ops.map(op => ({
      ...op,
      invoices: (op.invoices || []).map(inv => ({
        ...inv,
        imageBase64: inv.imageBase64 && inv.imageBase64.length > 50000 ? undefined : inv.imageBase64
      }))
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  }
}

export function getOperationById(id: string): Operation | undefined {
  const ops = getOperations();
  return ops.find(o => o.id === id);
}

export function saveOperation(op: Operation) {
  const ops = getOperations();
  const index = ops.findIndex(o => o.id === op.id);
  op.updatedAt = new Date().toISOString().split('T')[0];
  if (index >= 0) {
    ops[index] = op;
  } else {
    ops.unshift(op);
  }
  saveOperations(ops);
}

export function deleteOperation(id: string) {
  const ops = getOperations();
  const filtered = ops.filter(o => o.id !== id);
  saveOperations(filtered);
}

/**
 * Loads the official template from /assets/templates/fawater_template.xlsx or fallback
 */
export async function loadOfficialTemplateWorkbook(): Promise<XLSX.WorkBook> {
  const customTpl = localStorage.getItem(TEMPLATE_STORAGE_KEY);
  if (customTpl) {
    try {
      const bytes = Uint8Array.from(atob(customTpl), c => c.charCodeAt(0));
      return XLSX.read(bytes, { type: 'array', cellStyles: true, cellDates: true });
    } catch (e) {
      console.error('Error reading custom template, falling back to default:', e);
    }
  }

  try {
    const res = await fetch('/assets/templates/fawater_template.xlsx');
    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return XLSX.read(arrayBuf, { type: 'array', cellStyles: true, cellDates: true });
    }
  } catch (e) {
    console.warn('Could not fetch fawater_template.xlsx from assets, generating pristine workbook:', e);
  }

  const wb = XLSX.utils.book_new();
  
  const wsSummary = XLSX.utils.aoa_to_sheet([
    ['', 'نظام إدارة الحسابات - Fawater'],
    ['', 'ملخص المبيعات اليومية، المشتريات، والأرصدة المالية'],
    ['', ''],
    ['', 'إجمالي المبيعات', '', 'إجمالي المشتريات (شامل الضريبة)', '', 'صافي التدفق (المبيعات - المشتريات)'],
    ['', 0, '', 0, '', 0],
    ['', ''],
    ['', 'آخر رصيد كاش', '', 'آخر رصيد صندوق', '', 'آخر رصيد شبكة (بنك)'],
    ['', '#N/A', '', '#N/A', '', '#N/A']
  ]);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخص الأداء');

  const wsSales = XLSX.utils.aoa_to_sheet([
    ['سجل المبيعات اليومية والأرصدة', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['بيانات المبيعات اليومية', '', '', '', '', 'الأرصدة وتتبع النقدية', '', ''],
    ['التاريخ', 'اليوم', 'المبيعات النقدية (الكاش)', 'الشبكة', 'إجمالي المبيعات', 'رصيد الكاش', 'رصيد الصندوق', 'رصيد الشبكة (البنك)']
  ]);
  XLSX.utils.book_append_sheet(wb, wsSales, 'المبيعات');

  const wsPurchases = XLSX.utils.aoa_to_sheet([
    ['سجل المشتريات والموردين', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['التاريخ', 'اسم المورد', 'المبلغ قبل الضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة', 'الرصيد']
  ]);
  XLSX.utils.book_append_sheet(wb, wsPurchases, 'المشتريات والموردين');

  return wb;
}

export function getWorkbookFromOperation(op: Operation): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  
  const wsSummary = XLSX.utils.aoa_to_sheet([
    ['', `نظام إدارة الحسابات - ${op.name}`],
    ['', 'ملخص المبيعات اليومية، المشتريات، والأرصدة المالية'],
    ['', ''],
    ['', 'إجمالي المبيعات', '', 'إجمالي المشتريات (شامل الضريبة)', '', 'صافي التدفق (المبيعات - المشتريات)'],
    ['', 0, '', 0, '', 0],
    ['', ''],
    ['', 'آخر رصيد كاش', '', 'آخر رصيد صندوق', '', 'آخر رصيد شبكة (بنك)'],
    ['', '#N/A', '', '#N/A', '', '#N/A']
  ]);
  XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخص الأداء');

  const wsSales = XLSX.utils.aoa_to_sheet([
    [`سجل المبيعات اليومية والأرصدة - ${op.name}`, '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['بيانات المبيعات اليومية', '', '', '', '', 'الأرصدة وتتبع النقدية', '', ''],
    ['التاريخ', 'اليوم', 'المبيعات النقدية (الكاش)', 'الشبكة', 'إجمالي المبيعات', 'رصيد الكاش', 'رصيد الصندوق', 'رصيد الشبكة (البنك)']
  ]);
  XLSX.utils.book_append_sheet(wb, wsSales, 'المبيعات');

  const wsPurchases = XLSX.utils.aoa_to_sheet([
    [`سجل المشتريات والموردين - ${op.name}`, '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['التاريخ', 'اسم المورد', 'المبلغ قبل الضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة', 'الرصيد']
  ]);
  XLSX.utils.book_append_sheet(wb, wsPurchases, 'المشتريات والموردين');

  return wb;
}

export function createOperationObject(
  name: string,
  activityType: any,
  templateType: 'new' | 'custom',
  excelFileName: string,
  _customWb?: any
): Operation {
  return {
    id: 'op_' + Date.now() + Math.random().toString(36).substring(2, 6),
    name,
    activityType,
    createdAt: new Date().toISOString().split('T')[0],
    updatedAt: new Date().toISOString().split('T')[0],
    templateType,
    customFields: [],
    invoices: [],
    excelFileName: 'fawater_export.xlsx'
  };
}

export async function checkForTemplateUpdate(remoteUrl?: string): Promise<{ success: boolean; message: string }> {
  const url = remoteUrl || 'https://raw.githubusercontent.com/your-repo/fawater/main/public/assets/templates/fawater_template.xlsx';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('فشل الاتصال برابط التحديث');
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true, cellStyles: true });

    const sheets = wb.SheetNames;
    if (!sheets.includes('المبيعات') || !sheets.includes('المشتريات والموردين') || !sheets.includes('ملخص الأداء')) {
      throw new Error('ملف القالب غير متوافق: مفقود إحدى أوراق العمل الرئيسية');
    }

    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    localStorage.setItem(TEMPLATE_STORAGE_KEY, btoa(binary));
    return { success: true, message: 'تم تحديث قالب Excel والتحقق من سلامته بنجاح' };
  } catch (err: any) {
    return { success: false, message: err.message || 'فشل التحقق من التحديث أو الملف غير صالح' };
  }
}
