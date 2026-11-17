import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { getSupabaseAdmin, testSupabaseConnection } from './server/supabaseAdmin.js';
import {
  extractInvoiceWithGemini,
  ExtractionValidationError,
  isRetryableGeminiError,
  normalizeMimeType,
  stripDataUrlPrefix,
} from './server/geminiExtractor.js';
import { batchQueue } from './server/batchQueue.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export async function createServerApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // =========================================================================
  // Health & Status
  // =========================================================================
  app.get('/api/health/live', (_req, res) => res.status(200).json({ ok: true }));

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
  // Authentication and tenant authorization for every API route below.
  // The browser sends a Supabase access token; service-role access is only
  // used after the user and their organization membership are verified.
  // =========================================================================
  app.use('/api', async (req, res, next) => {
    const authorization = req.headers.authorization || '';
    if (
      req.path === '/background/worker' &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      authorization === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
    ) {
      (req as any).internalWorker = true;
      return next();
    }
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const publicKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_1hfYV443ep4J0mN2aO_e2g_BBPJmcXq';
    const url = process.env.SUPABASE_URL || 'https://fryrlbgonkvounnarfwd.supabase.co';
    if (!token || !publicKey || !url) {
      return res.status(401).json({ success: false, error: 'يلزم تسجيل الدخول للمتابعة.' });
    }

    try {
      const authClient = createClient(url, publicKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: authData, error: authError } = await authClient.auth.getUser(token);
      if (authError || !authData.user) {
        return res.status(401).json({ success: false, error: 'جلسة الدخول غير صالحة أو انتهت. سجّل الدخول مجدداً.' });
      }
      (req as any).authUser = authData.user;

      // Publicly-created accounts can access the app shell but not tenant data.
      if (req.path === '/health' || req.path === '/supabase/status') {
        return next();
      }

      const admin = requireSupabaseOr503(res);
      if (!admin) return;
      const { data: memberships, error: memberError } = await admin
        .from('organization_members')
        .select('organization_id,role')
        .eq('user_id', authData.user.id)
        .eq('status', 'active');
      if (memberError) throw memberError;

      const memberRows = memberships || [];
      const memberOrgIds = new Set(memberRows.map((m: any) => m.organization_id));
      const roles = new Map(memberRows.map((m: any) => [m.organization_id, m.role]));
      let organizationId =
        req.body?.organization?.id ||
        req.body?.organizationId ||
        (req.path === '/supabase/organizations' ? req.body?.id : '') ||
        (typeof req.query.organizationId === 'string' ? req.query.organizationId : '') ||
        '';

      if (!organizationId && req.path.startsWith('/supabase/organizations/')) {
        organizationId = req.path.split('/')[3] || '';
      }

      // Resolve tenant IDs from resource IDs when the client only supplies a record ID.
      if (!organizationId && req.path.startsWith('/supabase/invoices/')) {
        const { data } = await admin.from('invoices').select('organization_id').eq('id', req.path.split('/')[3]).maybeSingle();
        organizationId = data?.organization_id || '';
      }
      if (!organizationId && req.path.startsWith('/supabase/attachments/')) {
        const { data } = await admin.from('invoices').select('organization_id').eq('id', req.path.split('/')[3]).maybeSingle();
        organizationId = data?.organization_id || '';
      }
      if (!organizationId && req.path.startsWith('/supabase/custom-fields/')) {
        const { data } = await admin.from('custom_fields').select('organization_id').eq('id', req.path.split('/')[3]).maybeSingle();
        organizationId = data?.organization_id || '';
      }
      if (!organizationId && req.path.startsWith('/supabase/exports/')) {
        const { data } = await admin.from('export_batches').select('organization_id').eq('id', req.path.split('/')[3]).maybeSingle();
        organizationId = data?.organization_id || '';
      }

      if (req.path === '/supabase/templates') {
        if (!memberRows.some((m: any) => ['owner','admin'].includes(m.role))) {
          return res.status(403).json({ success: false, error: 'تحديث القالب متاح لمالك أو مدير مؤسسة فقط.' });
        }
        return next();
      }

      if (req.path === '/background/status' && !organizationId) {
        if (memberOrgIds.size === 0) return res.status(403).json({ success: false, error: 'لا توجد مؤسسة مرتبطة بهذا الحساب.' });
        res.locals.allowedOrgIds = Array.from(memberOrgIds);
        return next();
      }

      if (req.path.startsWith('/background/ai-batches/') && req.path.endsWith('/retry')) {
        const batchId = req.path.split('/')[3];
        const ownedOrgId = Array.from(memberOrgIds).find((orgId: any) =>
          batchQueue.getStatus(orgId).aiBatches.some((b: any) => b.batchId === batchId)
        );
        if (!ownedOrgId) return res.status(404).json({ success: false, error: 'لم يتم العثور على الدفعة.' });
        if (!['owner','admin','accountant','sales','employee'].includes(roles.get(ownedOrgId) as string)) {
          return res.status(403).json({ success: false, error: 'ليس لديك صلاحية إعادة معالجة الفواتير.' });
        }
        return next();
      }
      if (req.path.startsWith('/background/exports/') && req.path.endsWith('/download')) {
        const jobId = req.path.split('/')[3];
        const owned = Array.from(memberOrgIds).some((orgId: any) =>
          batchQueue.getStatus(orgId).exportJobs.some((j: any) => j.jobId === jobId || j.batchId === jobId)
        );
        if (!owned) return res.status(404).json({ success: false, error: 'لم يتم العثور على مهمة التصدير.' });
        return next();
      }
      if (req.path.startsWith('/background/jobs/') && req.path.endsWith('/dismiss')) {
        const jobId = req.path.split('/')[3];
        const owned = Array.from(memberOrgIds).some((orgId: any) => {
          const status = batchQueue.getStatus(orgId);
          return status.aiBatches.some((b: any) => b.batchId === jobId) ||
            status.exportJobs.some((j: any) => j.jobId === jobId || j.batchId === jobId);
        });
        if (!owned) return res.status(404).json({ success: false, error: 'لم يتم العثور على المهمة.' });
        return next();
      }

      if (req.path === '/supabase/bootstrap') {
        if (memberOrgIds.size === 0) {
          return res.status(403).json({ success: false, error: 'لا توجد مؤسسة مرتبطة بهذا الحساب. أنشئ مؤسسة أو اطلب دعوة.' });
        }
        res.locals.allowedOrgIds = Array.from(memberOrgIds);
        return next();
      }

      // A new organization may be created by any authenticated user. Existing
      // organizations require an owner/admin before they can be changed.
      if (req.path === '/supabase/organizations' && req.method === 'POST') {
        const { data: existing } = await admin.from('organizations').select('id').eq('id', organizationId).maybeSingle();
        if (!existing) return next();
        const currentRole = roles.get(organizationId);
        if (!['owner','admin'].includes(currentRole as string)) {
          return res.status(403).json({ success: false, error: 'تعديل إعدادات المؤسسة متاح للمالك أو المدير.' });
        }
      }
      if (req.path === '/background/ai-batches' && !['owner','admin','accountant','sales','employee'].includes(roles.get(organizationId) as string)) {
        return res.status(403).json({ success: false, error: 'ليس لديك صلاحية إضافة فواتير إلى المعالجة.' });
      }
      if (req.path === '/background/exports' && !['owner','admin','accountant'].includes(roles.get(organizationId) as string)) {
        return res.status(403).json({ success: false, error: 'تصدير ملفات المؤسسة متاح للمالك والمدير والمحاسب.' });
      }

      if (!organizationId || !memberOrgIds.has(organizationId)) {
        return res.status(403).json({ success: false, error: 'ليس لديك عضوية نشطة أو صلاحية الوصول إلى هذه المؤسسة.' });
      }

      const role = roles.get(organizationId);
      const isOwnerAdmin = role === 'owner' || role === 'admin';
      if (req.path === '/extract-invoice' && !['owner','admin','accountant','sales','employee'].includes(role as string)) {
        return res.status(403).json({ success: false, error: 'ليس لديك صلاحية تحليل فواتير هذه المؤسسة.' });
      }
      const staffRoles = ['owner','admin','accountant','sales','employee'];
      if (req.method === 'DELETE' && req.path.startsWith('/supabase/organizations/') && role !== 'owner') {
        return res.status(403).json({ success: false, error: 'حذف المؤسسة متاح للمالك فقط.' });
      }
      if (req.method === 'DELETE' && req.path.startsWith('/supabase/invoices/') && !isOwnerAdmin) {
        return res.status(403).json({ success: false, error: 'حذف الفواتير متاح للمالك أو المدير فقط.' });
      }
      if (req.path === '/supabase/invoices' && !staffRoles.includes(role as string)) {
        return res.status(403).json({ success: false, error: 'ليس لديك صلاحية إدخال الفواتير.' });
      }
      if (req.path === '/supabase/attachments' && !staffRoles.includes(role as string)) {
        return res.status(403).json({ success: false, error: 'ليس لديك صلاحية رفع المرفقات.' });
      }
      if (req.path.startsWith('/supabase/custom-fields') && !['owner','admin','accountant'].includes(role as string)) {
        return res.status(403).json({ success: false, error: 'إدارة الحقول المخصصة متاحة للمالك والمدير والمحاسب.' });
      }
      if (req.path.startsWith('/supabase/exports') && !['owner','admin','accountant'].includes(role as string)) {
        return res.status(403).json({ success: false, error: 'تصدير البيانات متاح للمالك والمدير والمحاسب.' });
      }
      res.locals.organizationRole = role;
      return next();
    } catch (error: any) {
      console.error('API authentication/authorization error:', error?.message || error);
      return res.status(401).json({ success: false, error: 'تعذر التحقق من صلاحيات الحساب.' });
    }
  });

  // =========================================================================
  // Gemini Invoice Extraction (Single Sync + Background Batch Queue)
  // =========================================================================
  app.post('/api/extract-invoice', async (req, res) => {
    const extractionController = new AbortController();
    const cancelOnDisconnect = () => {
      if (!res.writableEnded) extractionController.abort();
    };
    req.on('aborted', cancelOnDisconnect);
    res.on('close', cancelOnDisconnect);
    try {
      const input = { ...(req.body || {}) };
      if (!UUID_REGEX.test(input.organizationId || '') || !UUID_REGEX.test(input.invoiceId || '')) {
        return res.status(400).json({ success: false, error: 'معرف المؤسسة والفاتورة مطلوبان لتحليل المستند.' });
      }
      if (input.storagePath) {
        const expectedPrefix = `${input.organizationId}/${input.invoiceId}/`;
        if (typeof input.storagePath !== 'string' || !input.storagePath.startsWith(expectedPrefix)) {
          return res.status(403).json({ success: false, error: 'مسار الصورة لا يتبع هذه الفاتورة والمؤسسة.' });
        }
        const client = requireSupabaseOr503(res);
        if (!client) return;
        const { data: invoiceRow, error: invoiceError } = await client
          .from('invoices').select('organization_id').eq('id', input.invoiceId).maybeSingle();
        if (invoiceError) throw invoiceError;
        if (!invoiceRow || invoiceRow.organization_id !== input.organizationId) {
          return res.status(404).json({ success: false, error: 'لم يتم العثور على الفاتورة ضمن المؤسسة المحددة.' });
        }
        const { data: blob, error: downloadError } = await client.storage.from('invoice-images').download(input.storagePath);
        if (downloadError || !blob) {
          return res.status(404).json({ success: false, error: downloadError?.message || 'صورة الفاتورة غير موجودة في التخزين.' });
        }
        input.imageBase64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
        input.mimeType = blob.type || input.mimeType || 'image/jpeg';
      }
      if (!input.imageBase64) {
        return res.status(400).json({ success: false, error: 'صورة الفاتورة مطلوبة للتحليل.' });
      }
      const sanitized = await extractInvoiceWithGemini(input, extractionController.signal);
      if (extractionController.signal.aborted || res.destroyed) return;
      res.json({ success: true, data: sanitized });
    } catch (error: any) {
      if (extractionController.signal.aborted || res.destroyed) return;
      const errMsg = error?.message || 'حدث خطأ أثناء معالجة الفاتورة بالذكاء الاصطناعي';
      console.error('Error in /api/extract-invoice:', errMsg);
      const rawStatus =
        error instanceof ExtractionValidationError
          ? error.status
          : Number(error?.status || error?.statusCode);
      const status =
        rawStatus >= 400 && rawStatus < 600
          ? rawStatus
          : isRetryableGeminiError(error)
          ? 503
          : 500;
      res.status(status).json({ success: false, error: errMsg });
    }
  });

  app.post('/api/background/worker', (req, res) => {
    if (!(req as any).internalWorker) {
      return res.status(401).json({ success: false, error: 'غير مصرح بتشغيل عامل المعالجة.' });
    }
    return res.status(202).json({ success: true, accepted: true });
  });

  app.post('/api/background/ai-batches', async (req, res) => {
    try {
      const { organization, files } = req.body || {};
      if (!organization?.id || !UUID_REGEX.test(organization.id)) {
        return res.status(400).json({ success: false, error: 'معرف المؤسسة UUID مطلوب للمعالجة.' });
      }
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ success: false, error: 'لم يتم إرفاق أي فواتير للمعالجة.' });
      }
      if (files.length > 50) {
        return res.status(413).json({ success: false, error: 'الحد الأقصى للدفعة الواحدة 50 فاتورة.' });
      }
      for (const file of files) {
        const hasBase64 = typeof file?.imageBase64 === 'string' && file.imageBase64.length > 0;
        const hasStoredPath = typeof file?.storagePath === 'string' && file.storagePath.length > 0;
        if ((!hasBase64 && !hasStoredPath) || !file?.fileName || !file?.mimeType) {
          return res.status(400).json({ success: false, error: 'إحدى الفواتير لا تحتوي على ملف أو بيانات تخزين صالحة.' });
        }
      }

      const authUser = (req as any).authUser;
      if (!authUser?.id) {
        return res.status(401).json({ success: false, error: 'تعذر تحديد المستخدم الذي أنشأ مهمة المعالجة.' });
      }
      const queued = await batchQueue.enqueueAiBatch({
        createdBy: authUser.id,
        organization,
        files,
      });
      if (process.env.VERCEL) waitUntil(batchQueue.processPendingQueues());
      return res.status(202).json({
        success: true,
        batchId: queued.batch.batchId,
        supabaseSynced: queued.batch.supabaseSynced,
        supabaseWarning: queued.batch.supabaseWarning,
        initialInvoices: queued.initialInvoices,
      });
    } catch (error: any) {
      console.error('[background-ai] enqueue failed:', error?.message || error);
      return res.status(500).json({
        success: false,
        error: error?.message || 'تعذر حفظ الفواتير في طابور المعالجة الخلفية.',
      });
    }
  });

  app.post('/api/background/ai-batches/:batchId/retry', async (req, res) => {
    try {
      const batch = await batchQueue.retryFailedAiBatchItems(req.params.batchId);
      if (!batch) return res.status(404).json({ success: false, error: 'لم يتم العثور على دفعة المعالجة.' });
      if (process.env.VERCEL) waitUntil(batchQueue.processPendingQueues());
      return res.json({ success: true, batchId: batch.batchId });
    } catch (error: any) {
      console.error('[background-ai] retry failed:', error?.message || error);
      return res.status(500).json({ success: false, error: error?.message || 'تعذرت إعادة المحاولة.' });
    }
  });

  app.post('/api/background/exports', async (req, res) => {
    try {
      const { organization, invoices, alreadyExportedIds } = req.body || {};
      if (!organization?.id || !UUID_REGEX.test(organization.id)) {
        return res.status(400).json({ success: false, error: 'معرف المؤسسة UUID مطلوب للتصدير.' });
      }
      if (!Array.isArray(invoices) || invoices.length === 0) {
        return res.status(400).json({ success: false, error: 'لا توجد فواتير مرسلة للتصدير.' });
      }

      const job = await batchQueue.enqueueExportJob({
        organization,
        invoices,
        alreadyExportedIds: Array.isArray(alreadyExportedIds) ? alreadyExportedIds : [],
      });
      if (process.env.VERCEL) waitUntil(batchQueue.processPendingQueues());

      res.status(202).json({
        success: true,
        jobId: job.jobId,
        batchId: job.batchId,
        fileName: job.fileName,
        status: job.status,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'تعذر جدولة مهمة تصدير Excel.' });
    }
  });

  app.get('/api/background/exports/:jobId/download', async (req, res) => {
    try {
      const file = await batchQueue.getExportBuffer(req.params.jobId);
      if (!file) {
        return res.status(404).json({ success: false, error: 'ملف التصدير غير جاهز أو غير موجود.' });
      }
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.fileName)}"`);
      res.send(file.buffer);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'تعذر تنزيل ملف Excel.' });
    }
  });

  app.get('/api/background/status', (req, res) => {
    const organizationId =
      typeof req.query.organizationId === 'string' && req.query.organizationId.trim()
        ? req.query.organizationId.trim()
        : undefined;
    const allowedOrgIds = (res.locals.allowedOrgIds as string[] | undefined) || [];
    const scopedStatuses = organizationId
      ? [batchQueue.getStatus(organizationId)]
      : allowedOrgIds.map((id) => batchQueue.getStatus(id));
    const aiBatches = scopedStatuses.flatMap((status) => status.aiBatches);
    const exportJobs = scopedStatuses.flatMap((status) => status.exportJobs);
    res.json({
      success: true,
      hasActiveJobs: scopedStatuses.some((status) => status.hasActiveJobs),
      aiBatches,
      exportJobs,
    });
  });

  app.post('/api/background/jobs/:id/dismiss', async (req, res) => {
    await batchQueue.dismissJob(req.params.id);
    res.json({ success: true });
  });

  // =========================================================================
  // Supabase Server-Side Proxy Routes (Service Role only, never exposed to UI)
  // =========================================================================
  app.get('/api/supabase/status', async (_req, res) => {
    const status = await testSupabaseConnection();
    const ready = Boolean(status.connected && status.bucketsReady);
    res.status(ready ? 200 : 503).json({
      success: ready,
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

      const allowedOrgIds = new Set<string>(res.locals.allowedOrgIds || []);
      const organizations = (orgsRes.data || []).filter((row: any) => allowedOrgIds.has(row.id));
      const organizationInvoices = (invRes.data || []).filter((row: any) => allowedOrgIds.has(row.organization_id));
      const invoiceIds = new Set(organizationInvoices.map((row: any) => row.id));
      const organizationCustomFields = (cfRes.data || []).filter((row: any) => allowedOrgIds.has(row.organization_id));
      const customFieldIds = new Set(organizationCustomFields.map((row: any) => row.id));
      const exportBatches = (batchRes.data || []).filter((row: any) => allowedOrgIds.has(row.organization_id));
      const exportBatchIds = new Set(exportBatches.map((row: any) => row.id));
      res.json({
        success: true,
        data: {
          organizations,
          invoices: organizationInvoices,
          invoice_items: (itemsRes.data || []).filter((row: any) => invoiceIds.has(row.invoice_id)),
          invoice_attachments: (attRes.data || []).filter((row: any) => invoiceIds.has(row.invoice_id)),
          custom_fields: organizationCustomFields,
          invoice_custom_values: (icvRes.data || []).filter((row: any) => invoiceIds.has(row.invoice_id) && customFieldIds.has(row.custom_field_id)),
          export_batches: exportBatches,
          export_batch_items: (batchItemsRes.data || []).filter((row: any) => exportBatchIds.has(row.export_batch_id) && invoiceIds.has(row.invoice_id)),
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

      const authUser = (req as any).authUser;
      if (authUser?.id) {
        const { error: ownerError } = await client.from('organization_members').insert({
          organization_id: id,
          user_id: authUser.id,
          role: 'owner',
          status: 'active',
          joined_at: new Date().toISOString(),
        });
        // A pre-existing member must never be promoted by an organization upsert.
        if (ownerError && ownerError.code !== '23505') throw ownerError;
      }

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
      const { error: auditDelErr } = await client.from('audit_logs').delete().eq('organization_id', id);
      if (auditDelErr) throw auditDelErr;
      const { error: batchDelErr } = await client.from('export_batches').delete().eq('organization_id', id);
      if (batchDelErr) throw batchDelErr;
      if (invIds.length > 0) {
        const { error: invDelErr } = await client.from('invoices').delete().in('id', invIds);
        if (invDelErr) throw invDelErr;
      }
      const { error: cfDelErr } = await client.from('custom_fields').delete().eq('organization_id', id);
      if (cfDelErr) throw cfDelErr;
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

      // Prevent primary-key collisions from moving an invoice across tenants.
      const { data: existingInvoice, error: existingInvoiceError } = await client
        .from('invoices').select('organization_id').eq('id', invoice.id).maybeSingle();
      if (existingInvoiceError) throw existingInvoiceError;
      if (existingInvoice && existingInvoice.organization_id !== organization.id) {
        return res.status(403).json({ success: false, error: 'لا يمكن نقل فاتورة بين المؤسسات.' });
      }

      // Ensure organization exists first
      const { error: orgErr } = await client.from('organizations').upsert(
        {
          id: organization.id,
          name: organization.name,
          activity_type: organization.activityType || 'أخرى',
          excel_file_name: organization.excelFileName || 'fawater_export.xlsx',
        },
        { onConflict: 'id' }
      );
      if (orgErr) throw orgErr;

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
      const { error: delItemsErr } = await client.from('invoice_items').delete().eq('invoice_id', invoice.id);
      if (delItemsErr) throw delItemsErr;
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

      // Sync custom field values if matching custom_fields rows exist (match by UUID or name)
      const customEntries = Object.entries(invoice.customFieldsValues || {});
      if (customEntries.length > 0 && Array.isArray(organization.customFields)) {
        const orgFields = organization.customFields.filter((cf: any) => UUID_REGEX.test(cf?.id || ''));
        if (orgFields.length > 0) {
          const fieldByIdOrName = new Map<string, string>();
          for (const cf of orgFields) {
            fieldByIdOrName.set(cf.id, cf.id);
            if (cf.name) fieldByIdOrName.set(cf.name, cf.id);
          }

          const rowsMap = new Map<string, { invoice_id: string; custom_field_id: string; value: any }>();
          for (const [k, value] of customEntries) {
            const resolvedFieldId = fieldByIdOrName.get(k);
            if (resolvedFieldId) {
              rowsMap.set(resolvedFieldId, {
                invoice_id: invoice.id,
                custom_field_id: resolvedFieldId,
                value: value ?? null,
              });
            }
          }
          const rowsToUpsert = Array.from(rowsMap.values());
          if (rowsToUpsert.length > 0) {
            const { error: icvErr } = await client
              .from('invoice_custom_values')
              .upsert(rowsToUpsert, { onConflict: 'invoice_id,custom_field_id' });
            if (icvErr) throw icvErr;
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

      const { data: targetInvoice, error: targetInvoiceError } = await client
        .from('invoices').select('organization_id').eq('id', invoiceId).maybeSingle();
      if (targetInvoiceError) throw targetInvoiceError;
      if (!targetInvoice || targetInvoice.organization_id !== organizationId) {
        return res.status(403).json({ success: false, error: 'الفاتورة لا تتبع المؤسسة المحددة.' });
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
      const { data: existingField, error: existingFieldError } = await client
        .from('custom_fields').select('organization_id').eq('id', field.id).maybeSingle();
      if (existingFieldError) throw existingFieldError;
      if (existingField && existingField.organization_id !== organizationId) {
        return res.status(403).json({ success: false, error: 'لا يمكن نقل حقل مخصص بين المؤسسات.' });
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

      const { data: existingBatch, error: existingBatchError } = await client
        .from('export_batches').select('organization_id').eq('id', batchId).maybeSingle();
      if (existingBatchError) throw existingBatchError;
      if (existingBatch && existingBatch.organization_id !== organizationId) {
        return res.status(403).json({ success: false, error: 'دفعة التصدير لا تتبع المؤسسة المحددة.' });
      }
      if (Array.isArray(entries) && entries.length > 0) {
        const invoiceIds = [...new Set(entries.map((entry: any) => entry.invoiceId).filter(Boolean))];
        const { data: ownedInvoices, error: ownedInvoicesError } = await client
          .from('invoices').select('id').eq('organization_id', organizationId).in('id', invoiceIds);
        if (ownedInvoicesError) throw ownedInvoicesError;
        if ((ownedInvoices || []).length !== invoiceIds.length) {
          return res.status(403).json({ success: false, error: 'تتضمن دفعة التصدير فواتير لا تتبع المؤسسة.' });
        }
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
  if (process.env.VERCEL) {
    // Vercel serves the Vite output as static assets; this function handles API routes only.
  } else if (!isProduction) {
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

  // Recover any pending or interrupted background jobs on server startup
  try {
    await batchQueue.recoverPendingJobs();
  } catch (err) {
    console.error('[batchQueue] Startup recovery error:', err);
  }

  return app;
}

export const serverAppPromise = createServerApp();

// Vercel invokes the exported Express app as a serverless function.
// Persistent Bun/Docker deployments start a normal HTTP listener.
if (!process.env.VERCEL) {
  void serverAppPromise.then((app) => {
    const port = Number(process.env.PORT || 3000);
    app.listen(port, '0.0.0.0', () => {
      console.log(`Server running on http://0.0.0.0:${port}`);
    });
  });
}
