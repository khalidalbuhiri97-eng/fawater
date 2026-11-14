export type ActivityType = 
  | 'تجارة عامة'
  | 'مقاولات وبناء'
  | 'استشارات وخدمات'
  | 'مطاعم ومقاهي'
  | 'خدمات تقنية'
  | 'رعاية صحية'
  | 'نقليات وشحن'
  | 'أخرى';

export type DocumentType = 
  | 'مبيعات'
  | 'مشتريات'
  | 'مصروفات'
  | 'مرتجعات'
  | 'فاتورة ضريبية'
  | 'سند قبض'
  | 'سند صرف'
  | 'أخرى';

export type InvoiceStatus = 'لم تبدأ' | 'قيد المعالجة' | 'تحتاج مراجعة' | 'مكتملة' | 'فشل';

export type FieldType = 'نص' | 'رقم' | 'تاريخ' | 'مبلغ' | 'نسبة' | 'قائمة خيارات' | 'نعم/لا';

export interface InvoiceItem {
  id: string;
  name: string;
  code?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discount: number;
  tax: number;
  total: number;
}

export interface CustomField {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  aiExtract: boolean;
  manual: boolean;
  excelSheet: string;
  excelColumn: string;
  options?: string[]; // for قائمة خيارات
}

export interface InvoiceRecord {
  id: string; // internal unique ID
  invoiceNumber: string;
  invoiceDate: string;
  documentType: DocumentType;
  issuerName: string;
  clientName: string;
  issuerTaxId: string;
  clientTaxId: string;
  currency: string;
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  discount: number;
  grandTotal: number;
  notes: string;
  items: InvoiceItem[];
  customFieldsValues: Record<string, any>;
  status: InvoiceStatus;
  imageBase64?: string;
  imageMimeType?: string;
  imageFileName?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExcelMapping {
  sheetName: string;
  columnMap: Record<string, string>; // system field -> excel column name
}

export interface Operation {
  id: string;
  name: string;
  activityType: ActivityType;
  createdAt: string;
  updatedAt: string;
  templateType: 'new' | 'custom';
  customFields: CustomField[];
  invoices: InvoiceRecord[];
  excelFileName: string;
  excelBase64?: string; // stored binary of xlsx file
}
