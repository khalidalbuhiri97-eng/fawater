import { Operation } from '../types';
import { createNewStructuredWorkbook } from './excelService';
import * as XLSX from 'xlsx';

const STORAGE_KEY = 'sooq_operations_db_v1';

export function getOperations(): Operation[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) {
      // Seed default demo operation
      const defaultOp: Operation = {
        id: 'op_' + Date.now(),
        name: 'مؤسسة النور للتجارة',
        activityType: 'تجارة عامة',
        createdAt: new Date().toISOString().split('T')[0],
        updatedAt: new Date().toISOString().split('T')[0],
        templateType: 'new',
        customFields: [
          { id: 'cf_1', name: 'رقم السجل التجاري', type: 'نص', required: false, aiExtract: true, manual: true, excelSheet: 'الملخص (Summary)', excelColumn: 'سجل تجاري' },
          { id: 'cf_2', name: 'اسم الفرع', type: 'قائمة خيارات', required: false, aiExtract: true, manual: true, excelSheet: 'المبيعات (Sales)', excelColumn: 'الفرع', options: ['الفرع الرئيسي', 'فرع الشمال', 'فرع الغرب'] },
          { id: 'cf_3', name: 'مركز التكلفة', type: 'نص', required: false, aiExtract: false, manual: true, excelSheet: 'المصروفات (Expenses)', excelColumn: 'مركز التكلفة' }
        ],
        invoices: [],
        excelFileName: 'مؤسسة_النور_للتجارة.xlsx'
      };
      saveOperations([defaultOp]);
      return [defaultOp];
    }
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading operations from localStorage:', e);
    return [];
  }
}

export function saveOperations(ops: Operation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
  } catch (e) {
    console.error('Error saving operations to localStorage (quota exceeded?):', e);
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

export function createOperationObject(
  name: string,
  activityType: any,
  templateType: 'new' | 'custom',
  excelFileName: string,
  customWb?: XLSX.WorkBook
): Operation {
  const wb = customWb || createNewStructuredWorkbook(name, activityType);
  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });

  return {
    id: 'op_' + Date.now() + Math.random().toString(36).substring(2, 6),
    name,
    activityType,
    createdAt: new Date().toISOString().split('T')[0],
    updatedAt: new Date().toISOString().split('T')[0],
    templateType,
    customFields: [
      { id: 'cf_1', name: 'رقم السجل التجاري', type: 'نص', required: false, aiExtract: true, manual: true, excelSheet: 'الملخص (Summary)', excelColumn: 'سجل تجاري' },
      { id: 'cf_2', name: 'اسم الفرع', type: 'قائمة خيارات', required: false, aiExtract: true, manual: true, excelSheet: 'المبيعات (Sales)', excelColumn: 'الفرع', options: ['الفرع الرئيسي', 'فرع الإدارة'] }
    ],
    invoices: [],
    excelFileName: excelFileName.endsWith('.xlsx') ? excelFileName : `${excelFileName}.xlsx`,
    excelBase64: excelBuffer
  };
}

export function getWorkbookFromOperation(op: Operation): XLSX.WorkBook {
  if (op.excelBase64) {
    try {
      const binaryString = atob(op.excelBase64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return XLSX.read(bytes, { type: 'array' });
    } catch (e) {
      console.error('Error reading stored excelBase64, recreating workbook:', e);
    }
  }
  return createNewStructuredWorkbook(op.name, op.activityType);
}
