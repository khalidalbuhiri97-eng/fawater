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

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

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
  id: string; // stable UUID
  organizationId?: string;
  invoiceNumber: string;
  invoiceDate: string; // empty string when unreadable/missing; maps to NULL in Supabase
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
  extraColumnsData?: Record<string, any>;
  status: InvoiceStatus;
  processingStatus?: ProcessingStatus;
  hasImage?: boolean;
  storagePath?: string; // private path in Supabase Storage bucket invoice-images
  imageBase64?: string; // hydrated from IndexedDB in memory; never stored in localStorage
  imageMimeType?: string;
  imageFileName?: string;
  imageFileSize?: number;
  errorMessage?: string;
  classificationReason?: string;
  syncStatus?: SyncStatus;
  syncError?: string;
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
  invoiceUpdatedAt?: string;
}

export interface ExportBatchRecord {
  id: string; // UUID
  organizationId: string;
  fileName: string;
  templateSha256: string;
  storagePath?: string;
  exportedCount: number;
  salesCount: number;
  purchasesCount: number;
  exportedAt: string;
  entries: ExportTrackingEntry[];
  syncStatus?: SyncStatus;
}

export interface ExportTrackingRecord {
  operationId: string;
  lastExportedAt: string;
  templateSha256: string;
  exportedInvoiceIds: string[];
  entries: ExportTrackingEntry[];
  batches: ExportBatchRecord[];
}

export interface Operation {
  id: string; // stable UUID
  name: string;
  activityType: ActivityType;
  createdAt: string;
  updatedAt: string;
  templateType: 'official';
  customFields: CustomField[];
  invoices: InvoiceRecord[];
  excelFileName: string;
  syncStatus?: SyncStatus;
  syncError?: string;
}

export interface SyncOverview {
  isOnline: boolean;
  supabaseConfigured: boolean;
  supabaseConnected: boolean;
  pendingCount: number;
  failedCount: number;
  syncingCount: number;
  status: 'offline' | 'local_only' | 'connection_error' | 'pending' | 'syncing' | 'synced' | 'failed';
  lastSyncAt?: string;
  lastError?: string;
}

export interface BackgroundBatchItemSummary {
  invoiceId: string;
  fileName: string;
  manualDocumentType: 'auto' | 'مبيعات' | 'مشتريات';
  status: ProcessingStatus;
  errorMessage?: string;
  updatedAt: string;
  invoiceRecord?: InvoiceRecord;
}

export interface BackgroundBatchSummary {
  batchId: string;
  organizationId: string;
  organizationName: string;
  status: 'pending' | 'processing' | 'completed' | 'partial_failed' | 'failed';
  counts: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    remaining: number;
  };
  supabaseSynced: boolean;
  supabaseWarning?: string;
  dismissed: boolean;
  createdAt: string;
  updatedAt: string;
  items: BackgroundBatchItemSummary[];
}

export interface BackgroundExportJobSummary {
  jobId: string;
  batchId: string;
  organizationId: string;
  organizationName: string;
  fileName: string;
  status: ProcessingStatus;
  exportedCount: number;
  salesCount: number;
  purchasesCount: number;
  templateSha256?: string;
  entries: ExportTrackingEntry[];
  errorMessage?: string;
  supabaseSynced: boolean;
  supabaseWarning?: string;
  dismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundQueueStatus {
  aiBatches: BackgroundBatchSummary[];
  exportJobs: BackgroundExportJobSummary[];
  activeAiCount: number;
  activeExportCount: number;
  hasActiveJobs: boolean;
}

