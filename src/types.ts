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
  | 'يحتاج تحديد النوع';

export type InvoiceStatus = 'لم تبدأ' | 'قيد المعالجة' | 'تحتاج مراجعة' | 'مكتملة' | 'فشل';

export type FieldType = 'نص' | 'رقم' | 'تاريخ' | 'مبلغ' | 'نسبة' | 'قائمة خيارات' | 'نعم/لا';

export interface InvoiceItem {
  id: string;
  name: string;
  code?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  discount?: number;
  tax?: number;
  total?: number;
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
  invoiceDate: string; // empty string when unreadable/missing
  documentType: DocumentType;
  entryMethod?: 'ai' | 'manual';
  issuerName: string;
  clientName: string;
  issuerTaxId: string;
  clientTaxId: string;
  currency: string;
  subtotal?: number;
  taxAmount?: number;
  taxRate?: number;
  discount?: number;
  grandTotal?: number;
  notes: string;
  items: InvoiceItem[];
  customFieldsValues: Record<string, any>;
  // Dynamic extra columns read from XLSX template keyed by sheetName -> colLetter
  extraColumnsData?: Record<string, Record<string, string | number | undefined>>;
  status: InvoiceStatus;
  hasImage?: boolean;
  imageBase64?: string; // hydrated from IndexedDB in memory; stripped before localStorage save
  imageMimeType?: string;
  imageFileName?: string;
  errorMessage?: string;
  classificationReason?: string;
  createdAt: string;
  updatedAt: string;
  // Official template specific fields
  cashSales?: number;
  networkSales?: number;
  day?: string;
  cashBalance?: number;
  cashBoxBalance?: number;
  networkBalance?: number;
  balance?: number;
}

export interface ExportTrackingEntry {
  invoiceId: string;
  operationId: string;
  sheetName: string;
  rowNumber: number;
  exportedAt: string;
}

export interface ExportTrackingRecord {
  operationId: string;
  lastExportedAt: string;
  templateSha256: string;
  exportedInvoiceIds: string[];
  entries: ExportTrackingEntry[];
}

export interface Operation {
  id: string;
  name: string;
  activityType: ActivityType;
  createdAt: string;
  updatedAt: string;
  templateType: 'official';
  customFields: CustomField[];
  invoices: InvoiceRecord[];
  excelFileName: string;
}
