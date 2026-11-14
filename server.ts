import express from 'express';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { getSupabaseAdmin, isSupabaseConfigured, testSupabaseConnection } from './server/supabaseAdmin.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_MODEL = 'gemini-4-hydrogen';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    msg.includes('unavailable') ||
    msg.includes('timeout')
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

function normalizeMimeType(mimeType?: string, fileName?: string): string {
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

function stripDataUrlPrefix(base64: string): string {
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

function requireSupabaseOr503(res: express.Response) {
  const client = getSupabaseAdmin();
  if (!client) {
    res.status(503).json({
      success: false,
      configured: false,
      error: 'اتصال Supabase غير مهيأ على الخادم (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY غير موجودة).',
    });
    return null;
  }
  return client;
}

async function logAiExtraction(params: {
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // =========================================================================
  // Health & Status
  // =========================================================================
  app.get('/api/health', async (_req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    const geminiConfigured = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
    const supabaseStatus = await testSupabaseConnection();
    res.json({
      ok: true,
      geminiConfigured,
      supabase: supabaseStatus,
    });
  });

  // =========================================================================
  // Gemini Invoice Extraction
  // =========================================================================
  app.post('/api/extract-invoice', async (req, res) => {
    const startedAt = Date.now();
    const { imageBase64, mimeType, fileName, customFields, organizationName, activityType, invoiceId } = req.body || {};

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.status(400).json({ success: false, error: 'صورة الفاتورة مطلوبة (imageBase64 missing)' });
      }

      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        return res.status(500).json({
          success: false,
          error: 'مفتاح Gemini API غير مهيأ (GEMINI_API_KEY). يرجى تعيينه في إعدادات الأسرار (Settings > Secrets).',
        });
      }

      const cleanBase64 = stripDataUrlPrefix(imageBase64);
      const safeMimeType = normalizeMimeType(mimeType, fileName);

      if (!ALLOWED_MIME_TYPES.has(safeMimeType)) {
        return res.status(400).json({
          success: false,
          error: `نوع الملف غير مدعوم (${safeMimeType}). المسموح: JPG, PNG, WEBP, PDF.`,
        });
      }

      const decodedSize = Buffer.byteLength(cleanBase64, 'base64');
      if (decodedSize < 32) {
        return res.status(400).json({
          success: false,
          error: 'محتوى الصورة المرسل غير صالح أو فارغ.',
        });
      }
      if (decodedSize > MAX_IMAGE_BYTES) {
        return res.status(413).json({
          success: false,
          error: 'حجم الملف يتجاوز الحد الأقصى المسموح (15 ميجابايت).',
        });
      }

      console.info(
        `[/api/extract-invoice] Processing (${safeMimeType}, ${(decodedSize / 1024).toFixed(1)} KB) for "${organizationName || 'N/A'}"`
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

      const prompt = `أنت خبير محاسبي ومستخرج بيانات ذكي للفواتير والمستندات التجارية.
${orgContext}
قم بقراءة وتحليل محتوى صورة/مستند الفاتورة المرفق فعلياً واستخرج البيانات بدقة بصيغة JSON صالحة فقط.

الحقول المطلوب استخراجها (ضع null لأي حقل غير موجود أو غير مقروء في الصورة):
1. documentType: تصنيف نوع الفاتورة تلقائياً من محتوى الصورة والأطراف والعبارات فقط:
   - "مبيعات": إذا كانت الفاتورة تمثل عملية بيع صادرة عن المؤسسة إلى عميل أو ملخص مبيعات/نقطة بيع يومي (Z-Report / إغلاق وردية / تقرير مبيعات كاش وشبكة).
   - "مشتريات": إذا كانت الفاتورة تمثل عملية شراء قامت بها المؤسسة من مورد أو تاجر جملة أو مزود خدمة.
   - "يحتاج تحديد النوع": إذا كانت الصورة غير واضحة أو تعذر الجزم بين المبيعات والمشتريات من محتوى المستند.
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

      await logAiExtraction({
        invoiceId,
        status: 'success',
        extractedData: sanitized,
        processingTimeMs: Date.now() - startedAt,
      });

      res.json({ success: true, data: sanitized });
    } catch (error: any) {
      const errMsg = error?.message || 'حدث خطأ أثناء معالجة الفاتورة بالذكاء الاصطناعي';
      console.error('Error in /api/extract-invoice:', errMsg);

      await logAiExtraction({
        invoiceId,
        status: 'failed',
        errorMessage: errMsg,
        processingTimeMs: Date.now() - startedAt,
      });

      const rawStatus = Number(error?.status || error?.statusCode);
      const status =
        rawStatus >= 400 && rawStatus < 600
          ? rawStatus
          : isRetryableGeminiError(error)
          ? 503
          : 500;
      res.status(status).json({
        success: false,
        error: errMsg,
      });
    }
  });

  // =========================================================================
  // Supabase Server-Side Proxy Routes (Service Role only, never exposed to UI)
  // =========================================================================
  app.get('/api/supabase/status', async (_req, res) => {
    const status = await testSupabaseConnection();
    res.status(status.configured ? 200 : 503).json({
      success: status.connected,
      ...status,
    });
  });

  app.get('/api/supabase/bootstrap', async (_req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const [orgsRes, invRes, itemsRes, attRes, cfRes, icvRes, batchRes, batchItemsRes, tplRes] =
        await Promise.all([
          client.from('organizations').select('*').order('created_at', { ascending: false }),
          client.from('invoices').select('*').order('created_at', { ascending: false }),
          client.from('invoice_items').select('*'),
          client.from('invoice_attachments').select('*'),
          client.from('custom_fields').select('*'),
          client.from('invoice_custom_values').select('*'),
          client.from('export_batches').select('*').order('exported_at', { ascending: false }),
          client.from('export_batch_items').select('*'),
          client.from('template_versions').select('*').order('created_at', { ascending: false }),
        ]);

      const firstErr =
        orgsRes.error ||
        invRes.error ||
        itemsRes.error ||
        attRes.error ||
        cfRes.error ||
        icvRes.error ||
        batchRes.error ||
        batchItemsRes.error ||
        tplRes.error;

      if (firstErr) {
        return res.status(500).json({ success: false, error: firstErr.message });
      }

      res.json({
        success: true,
        data: {
          organizations: orgsRes.data || [],
          invoices: invRes.data || [],
          invoice_items: itemsRes.data || [],
          invoice_attachments: attRes.data || [],
          custom_fields: cfRes.data || [],
          invoice_custom_values: icvRes.data || [],
          export_batches: batchRes.data || [],
          export_batch_items: batchItemsRes.data || [],
          template_versions: tplRes.data || [],
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل تحميل البيانات من Supabase' });
    }
  });

  app.post('/api/supabase/organizations', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const { id, name, activityType, excelFileName, createdAt, updatedAt } = req.body || {};
      if (!id || !UUID_REGEX.test(id) || !name) {
        return res.status(400).json({ success: false, error: 'معرف UUID واسم المؤسسة مطلوبان.' });
      }

      const { error } = await client.from('organizations').upsert(
        {
          id,
          name: String(name).trim(),
          activity_type: activityType || 'أخرى',
          excel_file_name: excelFileName || 'fawater_export.xlsx',
          created_at: createdAt || undefined,
          updated_at: updatedAt || new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (error) throw error;

      await client.from('audit_logs').insert({
        organization_id: id,
        action: 'organization_upsert',
        details: { name, activityType },
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل حفظ المؤسسة في Supabase' });
    }
  });

  app.delete('/api/supabase/organizations/:id', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    const { id } = req.params;
    const confirmed = req.query.confirm === 'true';
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ success: false, error: 'معرف المؤسسة غير صالح.' });
    }
    if (!confirmed) {
      return res.status(400).json({ success: false, error: 'يلزم تأكيد الحذف صراحة قبل إزالة المؤسسة وبياناتها.' });
    }

    try {
      const { data: invs } = await client.from('invoices').select('id').eq('organization_id', id);
      const invIds = (invs || []).map((r) => r.id);

      if (invIds.length > 0) {
        const { data: atts } = await client
          .from('invoice_attachments')
          .select('storage_path')
          .in('invoice_id', invIds);
        const paths = (atts || []).map((a) => a.storage_path).filter(Boolean);
        if (paths.length > 0) {
          await client.storage.from('invoice-images').remove(paths);
        }
      }

      const { data: batches } = await client
        .from('export_batches')
        .select('id, storage_path')
        .eq('organization_id', id);
      const exportPaths = (batches || []).map((b) => b.storage_path).filter(Boolean) as string[];
      if (exportPaths.length > 0) {
        await client.storage.from('invoice-exports').remove(exportPaths);
      }

      // Delete dependent records explicitly in safe order (since schema uses ON DELETE RESTRICT on orgs)
      await client.from('audit_logs').delete().eq('organization_id', id);
      await client.from('export_batches').delete().eq('organization_id', id);
      if (invIds.length > 0) {
        await client.from('invoices').delete().in('id', invIds);
      }
      await client.from('custom_fields').delete().eq('organization_id', id);
      const { error } = await client.from('organizations').delete().eq('id', id);
      if (error) throw error;

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل حذف المؤسسة من Supabase' });
    }
  });

  app.post('/api/supabase/invoices', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const { organization, invoice } = req.body || {};
      if (!organization?.id || !invoice?.id || !UUID_REGEX.test(organization.id) || !UUID_REGEX.test(invoice.id)) {
        return res.status(400).json({ success: false, error: 'معرف المؤسسة ومعرف الفاتورة UUID مطلوبان.' });
      }

      // Ensure organization exists first
      await client.from('organizations').upsert(
        {
          id: organization.id,
          name: organization.name,
          activity_type: organization.activityType || 'أخرى',
          excel_file_name: organization.excelFileName || 'fawater_export.xlsx',
        },
        { onConflict: 'id' }
      );

      const safeDate =
        invoice.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(String(invoice.invoiceDate).trim())
          ? String(invoice.invoiceDate).trim()
          : null;

      const { error: invErr } = await client.from('invoices').upsert(
        {
          id: invoice.id,
          organization_id: organization.id,
          document_type: invoice.documentType,
          entry_method: invoice.entryMethod || null,
          invoice_number: invoice.invoiceNumber || '',
          invoice_date: safeDate,
          day: invoice.day || '',
          issuer_name: invoice.issuerName || '',
          client_name: invoice.clientName || '',
          issuer_tax_id: invoice.issuerTaxId || '',
          client_tax_id: invoice.clientTaxId || '',
          currency: invoice.currency || '',
          subtotal: invoice.subtotal ?? null,
          tax_amount: invoice.taxAmount ?? null,
          tax_rate: invoice.taxRate ?? null,
          discount: invoice.discount ?? null,
          grand_total: invoice.grandTotal ?? null,
          cash_sales: invoice.cashSales ?? null,
          network_sales: invoice.networkSales ?? null,
          cash_balance: invoice.cashBalance ?? null,
          cash_box_balance: invoice.cashBoxBalance ?? null,
          network_balance: invoice.networkBalance ?? null,
          balance: invoice.balance ?? null,
          notes: invoice.notes || '',
          classification_reason: invoice.classificationReason || '',
          status: invoice.status,
          error_message: invoice.errorMessage || null,
          custom_fields_values: invoice.customFieldsValues || {},
          extra_columns_data: invoice.extraColumnsData || {},
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (invErr) throw invErr;

      // Sync items idempotently
      await client.from('invoice_items').delete().eq('invoice_id', invoice.id);
      if (Array.isArray(invoice.items) && invoice.items.length > 0) {
        const itemsPayload = invoice.items.map((it: any) => ({
          id: it.id && UUID_REGEX.test(it.id) ? it.id : undefined,
          invoice_id: invoice.id,
          name: it.name || '',
          code: it.code || null,
          quantity: it.quantity ?? null,
          unit: it.unit || null,
          unit_price: it.unitPrice ?? null,
          discount: it.discount ?? null,
          tax: it.tax ?? null,
          total: it.total ?? null,
        }));
        const { error: itemErr } = await client.from('invoice_items').insert(itemsPayload);
        if (itemErr) throw itemErr;
      }

      // Sync custom field values if matching custom_fields rows exist
      const customEntries = Object.entries(invoice.customFieldsValues || {});
      if (customEntries.length > 0) {
        const validFieldIds = (organization.customFields || [])
          .map((cf: any) => cf.id)
          .filter((id: string) => UUID_REGEX.test(id));
        if (validFieldIds.length > 0) {
          const rowsToUpsert = customEntries
            .filter(([k]) => validFieldIds.includes(k))
            .map(([custom_field_id, value]) => ({
              invoice_id: invoice.id,
              custom_field_id,
              value: value ?? null,
            }));
          if (rowsToUpsert.length > 0) {
            await client
              .from('invoice_custom_values')
              .upsert(rowsToUpsert, { onConflict: 'invoice_id,custom_field_id' });
          }
        }
      }

      await client.from('audit_logs').insert({
        organization_id: organization.id,
        invoice_id: invoice.id,
        action: 'invoice_upsert',
        details: { status: invoice.status, documentType: invoice.documentType },
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل حفظ الفاتورة في Supabase' });
    }
  });

  app.delete('/api/supabase/invoices/:id', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ success: false, error: 'معرف الفاتورة غير صالح.' });
    }

    try {
      const { data: atts } = await client
        .from('invoice_attachments')
        .select('storage_path')
        .eq('invoice_id', id);
      const paths = (atts || []).map((a) => a.storage_path).filter(Boolean);
      if (paths.length > 0) {
        await client.storage.from('invoice-images').remove(paths);
      }
      const { error } = await client.from('invoices').delete().eq('id', id);
      if (error) throw error;
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل حذف الفاتورة من Supabase' });
    }
  });

  app.post('/api/supabase/attachments', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const { organizationId, invoiceId, imageBase64, mimeType, fileName } = req.body || {};
      if (!UUID_REGEX.test(organizationId || '') || !UUID_REGEX.test(invoiceId || '') || !imageBase64) {
        return res.status(400).json({ success: false, error: 'بيانات المرفق غير مكتملة.' });
      }

      const cleanBase64 = stripDataUrlPrefix(imageBase64);
      const safeMime = normalizeMimeType(mimeType, fileName);
      const buf = Buffer.from(cleanBase64, 'base64');
      const ext = safeMime.split('/')[1] || 'jpg';
      const safeName = (fileName || `invoice.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${organizationId}/${invoiceId}/${safeName}`;

      const { error: upErr } = await client.storage.from('invoice-images').upload(storagePath, buf, {
        contentType: safeMime,
        upsert: true,
      });
      if (upErr) throw upErr;

      const { error: metaErr } = await client.from('invoice_attachments').upsert(
        {
          invoice_id: invoiceId,
          storage_path: storagePath,
          file_name: fileName || safeName,
          mime_type: safeMime,
          file_size: buf.byteLength,
        },
        { onConflict: 'invoice_id,storage_path' }
      );
      if (metaErr) throw metaErr;

      res.json({ success: true, storagePath });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل رفع صورة الفاتورة إلى Storage' });
    }
  });

  app.get('/api/supabase/attachments/:invoiceId', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    const { invoiceId } = req.params;
    if (!UUID_REGEX.test(invoiceId)) {
      return res.status(400).json({ success: false, error: 'معرف الفاتورة غير صالح.' });
    }

    try {
      const { data: att, error: attErr } = await client
        .from('invoice_attachments')
        .select('*')
        .eq('invoice_id', invoiceId)
        .limit(1)
        .maybeSingle();
      if (attErr) throw attErr;
      if (!att) return res.status(404).json({ success: false, error: 'لا يوجد مرفق لهذه الفاتورة' });

      const { data: fileBlob, error: dlErr } = await client.storage
        .from('invoice-images')
        .download(att.storage_path);
      if (dlErr || !fileBlob) throw dlErr || new Error('فشل تنزيل المرفق من Storage');

      const arrBuf = await fileBlob.arrayBuffer();
      const base64 = Buffer.from(arrBuf).toString('base64');
      res.json({
        success: true,
        imageBase64: base64,
        mimeType: att.mime_type,
        fileName: att.file_name,
        storagePath: att.storage_path,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل جلب المرفق من Storage' });
    }
  });

  app.post('/api/supabase/custom-fields', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const { organizationId, field } = req.body || {};
      if (!UUID_REGEX.test(organizationId || '') || !UUID_REGEX.test(field?.id || '')) {
        return res.status(400).json({ success: false, error: 'معرفات UUID للحقل المخصص مطلوبة.' });
      }
      const { error } = await client.from('custom_fields').upsert(
        {
          id: field.id,
          organization_id: organizationId,
          name: field.name,
          field_type: field.type,
          is_required: Boolean(field.required),
          ai_extract: Boolean(field.aiExtract),
          manual_entry: Boolean(field.manual),
          excel_sheet: field.excelSheet,
          excel_column: field.excelColumn,
          options: field.options || null,
        },
        { onConflict: 'id' }
      );
      if (error) throw error;
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل حفظ الحقل المخصص' });
    }
  });

  app.delete('/api/supabase/custom-fields/:id', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    const { id } = req.params;
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ success: false, error: 'معرف الحقل غير صالح.' });
    }
    try {
      const { error } = await client.from('custom_fields').delete().eq('id', id);
      if (error) throw error;
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل حذف الحقل المخصص' });
    }
  });

  app.post('/api/supabase/exports', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const {
        batchId,
        organizationId,
        fileName,
        templateSha256,
        salesCount,
        purchasesCount,
        exportedAt,
        entries,
        xlsxBase64,
      } = req.body || {};

      if (!UUID_REGEX.test(batchId || '') || !UUID_REGEX.test(organizationId || '')) {
        return res.status(400).json({ success: false, error: 'معرفات التصدير UUID مطلوبة.' });
      }

      let storagePath: string | null = null;
      if (xlsxBase64) {
        const buf = Buffer.from(xlsxBase64, 'base64');
        const safeName = String(fileName || 'export.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
        storagePath = `${organizationId}/${batchId}_${safeName}`;
        const { error: upErr } = await client.storage.from('invoice-exports').upload(storagePath, buf, {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          upsert: true,
        });
        if (upErr) throw upErr;
      }

      let templateVersionId: string | null = null;
      if (templateSha256) {
        const { data: tplRow } = await client
          .from('template_versions')
          .select('id')
          .eq('sha256', templateSha256)
          .maybeSingle();
        if (tplRow) templateVersionId = tplRow.id;
      }

      const { error: batchErr } = await client.from('export_batches').upsert(
        {
          id: batchId,
          organization_id: organizationId,
          file_name: fileName,
          template_sha256: templateSha256,
          template_version_id: templateVersionId,
          storage_path: storagePath,
          exported_count: Array.isArray(entries) ? entries.length : 0,
          sales_count: Number(salesCount || 0),
          purchases_count: Number(purchasesCount || 0),
          exported_at: exportedAt || new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (batchErr) throw batchErr;

      if (Array.isArray(entries) && entries.length > 0) {
        const itemRows = entries.map((e: any) => ({
          export_batch_id: batchId,
          invoice_id: e.invoiceId,
          sheet_name: e.sheetName,
          row_number: e.rowNumber,
        }));
        const { error: itemErr } = await client
          .from('export_batch_items')
          .upsert(itemRows, { onConflict: 'export_batch_id,invoice_id' });
        if (itemErr) throw itemErr;
      }

      await client.from('audit_logs').insert({
        organization_id: organizationId,
        action: 'excel_export_batch',
        details: { batchId, fileName, exportedCount: entries?.length || 0, templateSha256 },
      });

      res.json({ success: true, storagePath });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل تسجيل دفعة التصدير في Supabase' });
    }
  });

  app.get('/api/supabase/exports/:batchId/download', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    const { batchId } = req.params;
    if (!UUID_REGEX.test(batchId)) {
      return res.status(400).json({ success: false, error: 'معرف دفعة التصدير غير صالح.' });
    }
    try {
      const { data: batch, error: bErr } = await client
        .from('export_batches')
        .select('*')
        .eq('id', batchId)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!batch?.storage_path) {
        return res.status(404).json({ success: false, error: 'الملف غير موجود في التخزين السحابي.' });
      }
      const { data: fileBlob, error: dlErr } = await client.storage
        .from('invoice-exports')
        .download(batch.storage_path);
      if (dlErr || !fileBlob) throw dlErr || new Error('فشل تنزيل ملف Excel');

      const arrBuf = await fileBlob.arrayBuffer();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(batch.file_name)}"`);
      res.send(Buffer.from(arrBuf));
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل تنزيل الملف' });
    }
  });

  app.post('/api/supabase/templates', async (req, res) => {
    const client = requireSupabaseOr503(res);
    if (!client) return;

    try {
      const { version, filePath, sha256 } = req.body || {};
      if (!sha256) {
        return res.status(400).json({ success: false, error: 'بصمة SHA-256 مطلوبة.' });
      }
      await client.from('template_versions').update({ is_active: false }).neq('sha256', sha256);
      const { error } = await client.from('template_versions').upsert(
        {
          version: version || new Date().toISOString().slice(0, 10),
          file_path: filePath || 'public/assets/templates/fawater_template.xlsx',
          sha256,
          is_active: true,
        },
        { onConflict: 'sha256' }
      );
      if (error) throw error;

      await client.from('app_settings').upsert(
        {
          setting_key: 'official_template_sha256',
          setting_value: { sha256, filePath, updatedAt: new Date().toISOString() },
        },
        { onConflict: 'setting_key' }
      );

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'فشل تسجيل نسخة القالب في Supabase' });
    }
  });

  // =========================================================================
  // Vite Middleware / Production Static Serve
  // =========================================================================
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
