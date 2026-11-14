import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_MODEL = 'gemini-4-hydrogen';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error: any): boolean {
  const status = error?.status || error?.statusCode || error?.code;
  const msg = String(error?.message || '').toLowerCase();
  return (
    status === 429 ||
    status === 503 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('rate limit') ||
    msg.includes('resource exhausted') ||
    msg.includes('unavailable')
  );
}

function toOptionalNumber(val: any): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const cleaned = String(val).replace(/[,،\s]/g, '').trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeDocumentType(raw: any): 'مبيعات' | 'مشتريات' | 'يحتاج تحديد النوع' {
  const text = String(raw || '').trim();
  if (text === 'مبيعات' || text.toLowerCase() === 'sales') return 'مبيعات';
  if (text === 'مشتريات' || text.toLowerCase() === 'purchases') return 'مشتريات';
  return 'يحتاج تحديد النوع';
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  const apiKey = process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({
    apiKey: apiKey || 'dummy-key',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  app.post('/api/extract-invoice', async (req, res) => {
    try {
      const { imageBase64, mimeType, customFields, organizationName, activityType } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ success: false, error: 'صورة الفاتورة مطلوبة (imageBase64 missing)' });
      }

      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        return res.status(500).json({
          success: false,
          error: 'مفتاح Gemini API غير مهيأ (GEMINI_API_KEY). يرجى تعيينه في إعدادات الأسرار (Secrets).',
        });
      }

      const orgContext = organizationName
        ? `اسم المؤسسة صاحبة الحساب في التطبيق: "${organizationName}" (${activityType || 'نشاط تجاري'}).`
        : 'حلّل أطراف الفاتورة ومحتواها لتحديد ما إذا كانت عملية بيع صادرة أم عملية شراء واردة.';

      const prompt = `أنت خبير محاسبي ومستخرج بيانات ذكي للفواتير والمستندات التجارية.
${orgContext}
قم بتحليل صورة الفاتورة أو المستند المرفق بدقة واستخرج البيانات بصيغة JSON صالحة فقط بدون أي نص إضافي أو علامات Markdown.

الحقول المطلوب استخراجها (ضع null لأي حقل غير موجود أو غير مقروء):
1. documentType: تصنيف نوع الفاتورة تلقائياً بناءً على محتوى الفاتورة وأطرافها وعباراتها (وليس من اسم الملف أو التخمين):
   - "مبيعات": إذا كانت الفاتورة تمثل عملية بيع صادرة عن المؤسسة إلى عميل أو ملخص مبيعات/نقطة بيع يومي (Z-Report / إغلاق وردية / تقرير مبيعات كاش وشبكة).
   - "مشتريات": إذا كانت الفاتورة تمثل عملية شراء قامت بها المؤسسة من مورد أو تاجر جملة أو شركة خدمات.
   - "يحتاج تحديد النوع": إذا تعذر الجزم بين المبيعات والمشتريات من محتوى المستند.
2. classificationReason: سبب قصير بالعربية لتصنيف نوع الفاتورة.
3. invoiceNumber: رقم الفاتورة (أو null).
4. invoiceDate: تاريخ الفاتورة المطبوع بصيغة YYYY-MM-DD إن أمكن تحويله بدقة، أو النص المطبوع، أو null إذا لم يكن التاريخ موجوداً أو كان غير مقروء. (ممنوع اختراع تاريخ اليوم).
5. day: اسم اليوم بالعربية (مثل السبت، الأحد...) فقط إذا كان مكتوباً أو مستنتجاً من تاريخ صحيح مقروء، وإلا null.
6. issuerName: اسم الجهة المصدرة للفاتورة / المورد / البائع (أو null).
7. clientName: اسم العميل / المشتري المستلم للفاتورة (أو null).
8. issuerTaxId: الرقم الضريبي للجهة المصدرة (أو null).
9. clientTaxId: الرقم الضريبي للعميل (أو null).
10. currency: رمز العملة المطبوع مثل SAR أو USD (أو null إذا لم يُذكر).
11. subtotal: المبلغ قبل الضريبة (رقم أو null).
12. taxAmount: قيمة ضريبة القيمة المضافة (رقم أو null).
13. taxRate: نسبة الضريبة المكتوبة فعلياً مثل 15 أو 5 أو 0 (رقم أو null — لا تفترض 15% من عندك).
14. discount: قيمة الخصم إن وجدت (رقم أو null).
15. grandTotal: الإجمالي النهائي شامل الضريبة (رقم أو null).
16. cashSales: المبيعات النقدية (الكاش) فقط إذا كانت مفصولة ومكتوبة صراحة في المستند (رقم أو null — لا تفترض 100% كاش).
17. networkSales: مبيعات الشبكة / البطاقة / مدى / POS فقط إذا كانت مفصولة ومكتوبة صراحة في المستند (رقم أو null — لا تفترض 100% شبكة).
18. notes: أي ملاحظات أو شروط مهمة مكتوبة في الفاتورة (أو null).
19. items: مصفوفة الأصناف إن وجدت (name, code, quantity, unit, unitPrice, discount, tax, total) أو [].
20. customFieldsExtracted: كائن للحقول الإضافية التالية إن وجدت: ${JSON.stringify(customFields || [])}.

قواعد صارمة:
- لا تخترع أو تكمّل أي بيانات غير موجودة في الصورة.
- لا تحوّل الحقول المجهولة إلى 0؛ أرجع null بوضوح.
- لا تفترض تاريخ اليوم إذا كان التاريخ غائباً؛ أرجع null.
- لا تفترض ضريبة 15% أو تقسيم كاش/شبكة إذا لم يكن مطبوعاً بوضوح.
- التزم بإرجاع كائن JSON صالح فقط.`;

      let response: any;
      let lastError: any;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      data: imageBase64,
                      mimeType: mimeType || 'image/jpeg',
                    },
                  },
                  {
                    text: prompt,
                  },
                ],
              },
            ],
          });
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

      const sanitized = {
        documentType: normalizeDocumentType(parsedData.documentType),
        classificationReason: parsedData.classificationReason ? String(parsedData.classificationReason) : '',
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

      res.json({ success: true, data: sanitized });
    } catch (error: any) {
      console.error('Error in /api/extract-invoice:', error);
      const status = isRetryableGeminiError(error) ? 503 : 500;
      res.status(status).json({
        success: false,
        error: error?.message || 'حدث خطأ أثناء معالجة الفاتورة بالذكاء الاصطناعي',
      });
    }
  });

  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}

startServer();
