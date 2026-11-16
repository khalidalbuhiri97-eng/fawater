import { GoogleGenAI } from '@google/genai';
import { getSupabaseAdmin } from './supabaseAdmin.js';

// Use the quota-friendly Flash-Lite model by default; allow an explicit server-side override.
export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash-lite';
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableGeminiError(error: any): boolean {
  const status = error?.status || error?.statusCode || error?.code;
  const msg = String(error?.message || '').toLowerCase();
  return (
    status === 429 ||
    status === 503 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('rate limit') ||
    msg.includes('resource exhausted') ||
    msg.includes('unavailable') ||
    msg.includes('timeout')
  );
}

export function toOptionalNumber(val: any): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const cleaned = String(val).replace(/[,،\s]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function normalizeDocumentType(raw: any): 'مبيعات' | 'مشتريات' | 'يحتاج تحديد النوع' {
  const text = String(raw || '').trim();
  if (text === 'مبيعات' || text.toLowerCase() === 'sales') return 'مبيعات';
  if (text === 'مشتريات' || text.toLowerCase() === 'purchases') return 'مشتريات';
  return 'يحتاج تحديد النوع';
}

export function normalizeMimeType(mimeType?: string, fileName?: string): string {
  const m = String(mimeType || '').trim().toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  if (ALLOWED_MIME_TYPES.has(m)) return m;
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return m || 'image/jpeg';
}

export function stripDataUrlPrefix(base64: string): string {
  const idx = base64.indexOf(',');
  if (base64.startsWith('data:') && idx !== -1) {
    return base64.slice(idx + 1).trim();
  }
  return base64.trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function logAiExtraction(params: {
  invoiceId?: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  extractedData?: any;
  processingTimeMs: number;
}) {
  if (!params.invoiceId || !UUID_REGEX.test(params.invoiceId)) return;
  const client = getSupabaseAdmin();
  if (!client) return;
  try {
    await client.from('ai_extraction_logs').insert({
      invoice_id: params.invoiceId,
      provider: 'gemini',
      model_name: GEMINI_MODEL,
      status: params.status,
      error_message: params.errorMessage || null,
      extracted_data: params.extractedData || null,
      processing_time_ms: params.processingTimeMs,
    });
  } catch {
    // Non-fatal logging failure
  }
}

export interface ExtractInvoiceInput {
  invoiceId?: string;
  imageBase64: string;
  mimeType?: string;
  fileName?: string;
  customFields?: any[];
  organizationName?: string;
  activityType?: string;
  manualDocumentType?: string;
}

export interface ExtractedInvoiceData {
  documentType: 'مبيعات' | 'مشتريات' | 'يحتاج تحديد النوع';
  classificationReason: string;
  invoiceNumber: string;
  invoiceDate: string;
  day: string;
  issuerName: string;
  paymentMethod: string;
  clientName: string;
  issuerTaxId: string;
  clientTaxId: string;
  currency: string;
  subtotal: number | null;
  taxAmount: number | null;
  taxRate: number | null;
  discount: number | null;
  grandTotal: number | null;
  cashSales: number | null;
  networkSales: number | null;
  notes: string;
  items: any[];
  customFieldsExtracted: Record<string, any>;
}

export class ExtractionValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function extractInvoiceWithGemini(
  input: ExtractInvoiceInput
): Promise<ExtractedInvoiceData> {
  const startedAt = Date.now();
  const {
    imageBase64,
    mimeType,
    fileName,
    customFields,
    organizationName,
    activityType,
    invoiceId,
    manualDocumentType,
  } = input;

  const normalizedManualType = normalizeDocumentType(manualDocumentType);
  const hasManualClassification =
    normalizedManualType === 'مبيعات' || normalizedManualType === 'مشتريات';

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      throw new ExtractionValidationError('صورة الفاتورة مطلوبة (imageBase64 missing)', 400);
    }

    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      throw new ExtractionValidationError(
        'مفتاح Gemini API غير مهيأ (GEMINI_API_KEY). يرجى تعيينه في إعدادات الأسرار (Settings > Secrets).',
        500
      );
    }

    const cleanBase64 = stripDataUrlPrefix(imageBase64);
    const safeMimeType = normalizeMimeType(mimeType, fileName);

    if (!ALLOWED_MIME_TYPES.has(safeMimeType)) {
      throw new ExtractionValidationError(
        `نوع الملف غير مدعوم (${safeMimeType}). المسموح: JPG, PNG, WEBP, PDF.`,
        400
      );
    }

    const decodedSize = Buffer.byteLength(cleanBase64, 'base64');
    if (decodedSize < 32) {
      throw new ExtractionValidationError('محتوى الصورة المرسل غير صالح أو فارغ.', 400);
    }
    if (decodedSize > MAX_IMAGE_BYTES) {
      throw new ExtractionValidationError('حجم الملف يتجاوز الحد الأقصى المسموح (15 ميجابايت).', 413);
    }

    console.info(
      `[geminiExtractor] Processing (${safeMimeType}, ${(decodedSize / 1024).toFixed(1)} KB, type=${
        hasManualClassification ? normalizedManualType : 'auto'
      }) for "${organizationName || 'N/A'}"`
    );

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    // Keep the per-invoice prompt compact to reduce input-token usage on the free quota.
    const customFieldNames = (customFields || [])
      .filter((field: any) => field?.aiExtract !== false)
      .map((field: any) => `${field.name || field.label || field.id}:${field.type || 'نص'}`)
      .filter((field: string) => !field.startsWith('undefined:'))
      .join('، ');

    const typeInstruction = hasManualClassification
      ? `النوع محدد يدوياً: ${normalizedManualType}؛ لا تغيّره.`
      : 'صنّف إلى مبيعات (بيع صادر/تقرير نقطة بيع)، أو مشتريات (شراء وارد)، أو يحتاج تحديد النوع عند الشك.';

    const prompt = `استخرج بيانات المستند المرفق كـ JSON فقط، دون شرح.
السياق: ${organizationName || 'مؤسسة'}؛ النشاط: ${activityType || 'تجاري'}.
${typeInstruction}
المفاتيح:
documentType, classificationReason, invoiceNumber, invoiceDate(YYYY-MM-DD), day(عربي),
issuerName, paymentMethod, clientName, issuerTaxId, clientTaxId, currency,
subtotal, taxAmount, taxRate, discount, grandTotal, cashSales, networkSales,
notes, items[{name,code,quantity,unit,unitPrice,discount,tax,total}],
customFieldsExtracted.
الحقول غير المقروءة أو غير الموجودة = null، وitems = [] عند عدم وجود أصناف.
لا تخمّن أي قيمة أو تاريخ؛ لا تفترض نسبة ضريبة. استخرج cashSales وnetworkSales فقط إذا ظهرتا منفصلتين صراحة.
نوع المستند وأطرافه: المبيعات صادرة من المؤسسة، والمشتريات واردة إليها.
${customFieldNames ? `الحقول الإضافية المطلوبة: ${customFieldNames}. أعد قيمها داخل customFieldsExtracted باستخدام الاسم كمفتاح.` : 'customFieldsExtracted: {}'}
أعد JSON صالحاً فقط وبالمفاتيح المحددة.`;

    let response: any;
    let lastError: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await withTimeout(
          ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: safeMimeType,
                    data: cleanBase64,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
            config: {
              responseMimeType: 'application/json',
            },
          }),
          45000,
          'انتهت مهلة الاتصال بخدمة Gemini (45 ثانية). يرجى إعادة المحاولة.'
        );
        break;
      } catch (err: any) {
        lastError = err;
        if (attempt < 2 && isRetryableGeminiError(err)) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      throw lastError || new Error('لم ترد استجابة من خدمة Gemini');
    }

    const textOutput = response.text || '';
    if (!textOutput.trim()) {
      throw new Error('أعاد Gemini استجابة فارغة؛ يرجى التأكد من وضوح الصورة والمحاولة مجدداً.');
    }

    let jsonStr = textOutput.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    let parsedData: any;
    try {
      parsedData = JSON.parse(jsonStr);
    } catch {
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        parsedData = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
      } else {
        throw new Error('فشل تحليل استجابة الذكاء الاصطناعي إلى JSON صالح');
      }
    }

    const sanitized: ExtractedInvoiceData = {
      documentType: hasManualClassification
        ? normalizedManualType
        : normalizeDocumentType(parsedData.documentType),
      classificationReason: hasManualClassification
        ? `تصنيف يدوي (${normalizedManualType})${
            parsedData.classificationReason ? `: ${String(parsedData.classificationReason)}` : ''
          }`
        : parsedData.classificationReason
        ? String(parsedData.classificationReason)
        : '',
      invoiceNumber: parsedData.invoiceNumber ? String(parsedData.invoiceNumber) : '',
      invoiceDate: parsedData.invoiceDate ? String(parsedData.invoiceDate).trim() : '',
      day: parsedData.day ? String(parsedData.day).trim() : '',
      issuerName: parsedData.issuerName ? String(parsedData.issuerName).trim() : '',
      paymentMethod: parsedData.paymentMethod ? String(parsedData.paymentMethod).trim() : '',
      clientName: parsedData.clientName ? String(parsedData.clientName).trim() : '',
      issuerTaxId: parsedData.issuerTaxId ? String(parsedData.issuerTaxId).trim() : '',
      clientTaxId: parsedData.clientTaxId ? String(parsedData.clientTaxId).trim() : '',
      currency: parsedData.currency ? String(parsedData.currency).trim() : '',
      subtotal: toOptionalNumber(parsedData.subtotal),
      taxAmount: toOptionalNumber(parsedData.taxAmount),
      taxRate: toOptionalNumber(parsedData.taxRate),
      discount: toOptionalNumber(parsedData.discount),
      grandTotal: toOptionalNumber(parsedData.grandTotal),
      cashSales: toOptionalNumber(parsedData.cashSales),
      networkSales: toOptionalNumber(parsedData.networkSales),
      notes: parsedData.notes ? String(parsedData.notes).trim() : '',
      items: Array.isArray(parsedData.items) ? parsedData.items : [],
      customFieldsExtracted:
        parsedData.customFieldsExtracted && typeof parsedData.customFieldsExtracted === 'object'
          ? parsedData.customFieldsExtracted
          : {},
    };

    await logAiExtraction({
      invoiceId,
      status: 'success',
      extractedData: sanitized,
      processingTimeMs: Date.now() - startedAt,
    });

    return sanitized;
  } catch (error: any) {
    const errMsg = error?.message || 'حدث خطأ أثناء معالجة الفاتورة بالذكاء الاصطناعي';
    await logAiExtraction({
      invoiceId,
      status: 'failed',
      errorMessage: errMsg,
      processingTimeMs: Date.now() - startedAt,
    });
    throw error;
  }
}
