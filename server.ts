import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Initialize Gemini AI client server-side
  const apiKey = process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey: apiKey || 'dummy-key' });

  // API endpoint for invoice extraction using Gemini Vision
  app.post('/api/extract-invoice', async (req, res) => {
    try {
      const { imageBase64, mimeType, customFields } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: 'صورة الفاتورة مطلوبة (imageBase64 missing)' });
      }

      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        return res.status(500).json({ 
          error: 'مفتاح Gemini API غير مهيأ (GEMINI_API_KEY). يرجى تعيينه في إعدادات الأسرار (Secrets).' 
        });
      }

      const prompt = `أنت خبير محاسبي ومستخرج بيانات ذكي لفواتير ومستندات الأنشطة التجارية المختلفة.
قم بتحليل صورة الفاتورة أو المستند المرفق بدقة شديدة واستخرج البيانات بدقة بصيغة JSON فقط دون أي نصوص إضافية أو علامات ماركداون (لا تستخدم \`\`\`json بل أرجع كائن JSON مباشرة أو نص JSON خالص).

المطلوب استخراج الحقول التالية إذا وجدت:
1. issuerName: اسم المؤسسة المصدرة للفاتورة (البائع).
2. clientName: اسم العميل أو الجهة المستلمة.
3. issuerTaxId: الرقم الضريبي للمؤسسة المصدرة.
4. clientTaxId: الرقم الضريبي للعميل (إن وجد).
5. invoiceNumber: رقم الفاتورة.
6. invoiceDate: تاريخ الفاتورة المطبوع (بالصيغة YYYY-MM-DD أو كما هو).
7. documentType: نوع المستند (يجب تحليله بدقة شديدة من محتوى الفاتورة والأطراف والعبارات، حصرياً: "مبيعات" إذا كانت صادرة عن المؤسسة لعميل، أو "مشتريات" إذا كانت واردة من مورد للمؤسسة. إذا كان المحتوى غير واضح أو تعذر التحديد، أرجع القيمة "يحتاج تحديد النوع").
8. currency: العملة (مثل SAR, USD, EUR, AED، أو الافتراضية).
9. subtotal: الإجمالي قبل الضريبة (رقم فقط بدون عملة).
10. taxAmount: قيمة الضريبة (رقم فقط).
11. taxRate: نسبة الضريبة الفعليّة المكتوبة (رقم مثل 15 أو 5 أو 0، لا تفترض 15% بل استخرج المكتوب فعلياً).
12. discount: قيمة الخصم (رقم فقط).
13. grandTotal: الإجمالي النهائي أو الإجمالي المستحق (رقم فقط).
14. notes: أي ملاحظات أو شروط في الفاتورة.
15. items: مصفوفة تفاصيل الأصناف (كل عنصر يحتوي على: name (اسم الصنف)، code (كود الصنف)، quantity (الكمية - رقم)، unit (الوحدة مثل حبة، كغ، خدمة)، unitPrice (سعر الوحدة - رقم)، discount (خصم الصنف - رقم)، tax (ضريبة الصنف - رقم)، total (إجمالي الصنف - رقم)).
16. customFieldsExtracted: كائن يحتوي على القيم المستخرجة لأي حقول إضافية أو مخصصة تظهر في المستند مثل (رقم السجل التجاري، رقم الهاتف، اسم الفرع، اسم المندوب، رقم أمر الشراء، رقم العقد، مركز التكلفة) بناءً على المطلوب: ${JSON.stringify(customFields || [])}.

قواعد صارمة:
- لا تخترع أي معلومات غير موجودة في المستند.
- إذا تعذر قراءة حقل، اتركه فارغاً (null أو "" أو 0).
- لا تفترض نسب ضريبية افتراضية؛ التزم بالنص المكتوب.
- تأكد أن الناتج كائن JSON صالح فقط.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
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

      const textOutput = response.text || '';
      let jsonStr = textOutput.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      let parsedData;
      try {
        parsedData = JSON.parse(jsonStr);
      } catch (e) {
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          parsedData = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
        } else {
          throw new Error('فشل تحليل استجابة الذكاء الاصطناعي إلى JSON صالح: ' + textOutput.substring(0, 200));
        }
      }

      res.json({ success: true, data: parsedData });
    } catch (error: any) {
      console.error('Error in /api/extract-invoice:', error);
      res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء معالجة الفاتورة بالذكاء الاصطناعي' });
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
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}

startServer();
