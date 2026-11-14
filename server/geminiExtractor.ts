import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { getSupabaseAdmin } from './supabaseAdmin.js';

export const GEMINI_MODEL = 'gemini-4-hydrogen';
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

    const orgContext = organizationName
      ? `اسم المؤسسة صاحبة الحساب في التطبيق: "${organizationName}" (${activityType || 'نشاط تجاري'}).`
      : 'حلّل أطراف الفاتورة ومحتواها لتحديد ما إذا كانت عملية بيع صادرة أم عملية شراء واردة.';

    const classificationInstruction = hasManualClassification
      ? normalizedManualType === 'مبيعات'
        ? `1. documentType: حدّد المستخدم مسبقاً أن هذه الفاتورة هي "مبيعات" يدوياً. يجب إرجاع "مبيعات" كما هي، واستخراج البيانات على أساس أنها عملية بيع أو تقرير مبيعات يومي/نقطة بيع صادرة عن المؤسسة (وركّز على استخراج المبيعات النقدية cashSales ومبيعات الشبكة networkSales والإجمالي grandTotal والتاريخ واليوم).`
        : `1. documentType: حدّد المستخدم مسبقاً أن هذه الفاتورة هي "مشتريات" يدوياً. يجب إرجاع "مشتريات" كما هي، واستخراج البيانات على أساس أنها فاتورة شراء واردة من مورد (وركّز على استخراج اسم المورد issuerName والمبلغ قبل الضريبة subtotal وضريبة القيمة المضافة taxAmount والإجمالي grandTotal والتاريخ).`
      : `1. documentType: تصنيف نوع الفاتورة تلقائياً من محتوى الصورة والأطراف والعبارات فقط:
   - "مبيعات": إذا كانت الفاتورة تمثل عملية بيع صادرة عن المؤسسة إلى عميل أو ملخص مبيعات/نقطة بيع يومي (Z-Report / إغلاق وردية / تقرير مبيعات كاش وشبكة).
   - "مشتريات": إذا كانت الفاتورة تمثل عملية شراء قامت بها المؤسسة من مورد أو تاجر جملة أو مزود خدمة.
   - "يحتاج تحديد النوع": إذا كانت الصورة غير واضحة أو تعذر الجزم بين المبيعات والمشتريات من محتوى المستند.`;

    const prompt = `أنت خبير محاسبي ومستخرج بيانات ذكي للفواتير والمستندات التجارية.
${orgContext}
قم بقراءة وتحليل محتوى صورة/مستند الفاتورة المرفق فعلياً واستخرج البيانات بدقة بصيغة JSON صالحة فقط.

الحقول المطلوب استخراجها (ضع null لأي حقل غير موجود أو غير مقروء في الصورة):
${classificationInstruction}
2. classificationReason: سبب قصير بالعربية لتصنيف نوع الفاتورة بناءً على ما ظهر في الصورة.
3. invoiceNumber: رقم الفاتورة (أو null).
4. invoiceDate: تاريخ الفاتورة المطبوع بصيغة YYYY-MM-DD إن أمكن تحويله بدقة، أو null إذا لم يكن التاريخ موجوداً أو كان غير مقروء. (ممنوع اختراع تاريخ اليوم).
5. day: اسم اليوم بالعربية (مثل السبت، الأحد...) فقط إذا كان مكتوباً أو مستنتجاً من تاريخ صحيح مقروء، وإلا null.
6. issuerName: اسم الجهة المصدرة للفاتورة / المورد / البائع (أو null).
7. clientName: اسم العميل / المشتري المستلم للفاتورة (أو null).
8. issuerTaxId: الرقم الضريبي للجهة المصدرة (أو null).
9. clientTaxId: الرقم الضريبي للعميل (أو null).
10. currency: رمز العملة المطبوع مثل SAR أو USD (أو null).
11. subtotal: المبلغ قبل الضريبة (رقم أو null).
12. taxAmount: قيمة ضريبة القيمة المضافة (رقم أو null).
13. taxRate: نسبة الضريبة المكتوبة فعلياً مثل 15 أو 5 أو 0 (رقم أو null — لا تفترض 15%).
14. discount: قيمة الخصم إن وجدت (رقم أو null).
15. grandTotal: الإجمالي النهائي شامل الضريبة (رقم أو null).
16. cashSales: المبيعات النقدية (الكاش) فقط إذا كانت مفصولة ومكتوبة صراحة في المستند (رقم أو null).
17. networkSales: مبيعات الشبكة / البطاقة / مدى / POS فقط إذا كانت مفصولة ومكتوبة صراحة في المستند (رقم أو null).
18. notes: أي ملاحظات مهمة مكتوبة في الفاتورة (أو null).
19. items: مصفوفة الأصناف إن وجدت (name, code, quantity, unit, unitPrice, discount, tax, total) أو [].
20. customFieldsExtracted: كائن للحقول الإضافية التالية إن وجدت: ${JSON.stringify(customFields || [])}.

قواعد صارمة:
- اقرأ محتوى الصورة الفعلي فقط ولا تعتمد على أي اسم ملف.
- لا تخترع أو تكمّل أي بيانات غير موجودة في الصورة.
- لا تحوّل الحقول المجهولة إلى 0؛ أرجع null بوضوح.
- لا تفترض تاريخ اليوم إذا كان التاريخ غائباً؛ أرجع null.
- أرجع JSON صالح فقط.`;

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
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
