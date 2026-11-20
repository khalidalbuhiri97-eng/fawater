import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { extractInvoiceWithGemini, normalizeMimeType, stripDataUrlPrefix } from './geminiExtractor.js';
import { generateOfficialExcelOnServer, ServerExportEntry } from './excelServerExporter.js';
import { normalizeInvoiceDate } from './dateUtils.js';
import { findDuplicateInvoiceServer } from './invoiceDeduplication.js';

export type TaskProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AiBatchItemState {
  invoiceId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  manualDocumentType: 'auto' | 'مبيعات' | 'مشتريات';
  status: TaskProcessingStatus;
  attempts: number;
  errorMessage?: string;
  storagePath?: string;
  uploadRelPath?: string;
  invoiceRecord?: any;
  updatedAt: string;
}

export interface AiBatchState {
  batchId: string;
  createdBy: string;
  organizationId: string;
  organizationName: string;
  activityType: string;
  excelFileName: string;
  customFields: any[];
  items: AiBatchItemState[];
  supabaseSynced: boolean;
  supabaseWarning?: string;
  dismissed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExportJobState {
  jobId: string;
  batchId: string;
  organizationId: string;
  organizationName: string;
  fileName: string;
  status: TaskProcessingStatus;
  attempts: number;
  invoicesSnapshot: any[];
  alreadyExportedIds: string[];
  templateSha256?: string;
  storagePath?: string;
  exportRelPath?: string;
  exportedCount?: number;
  salesCount?: number;
  purchasesCount?: number;
  entries?: ServerExportEntry[];
  errorMessage?: string;
  supabaseSynced: boolean;
  supabaseWarning?: string;
  dismissed?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PersistedQueueState {
  aiBatches: AiBatchState[];
  exportJobs: ExportJobState[];
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_DATA_DIR = process.env.VERCEL ? '/tmp/fawater-queue' : path.resolve(process.cwd(), 'server/.queue_data');
const UPLOADS_DIR = path.join(QUEUE_DATA_DIR, 'uploads');
const EXPORTS_DIR = path.join(QUEUE_DATA_DIR, 'exports');
const STATE_FILE = path.join(QUEUE_DATA_DIR, 'queue-state.json');

function toOptionalNum(val: any): number | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

function mapQueueStatusToInvoiceStatus(status: TaskProcessingStatus): string {
  switch (status) {
    case 'pending':
      return 'لم تبدأ';
    case 'processing':
      return 'قيد المعالجة';
    case 'completed':
      return 'تحتاج مراجعة';
    case 'failed':
      return 'فشل';
  }
}

function mapInvoiceStatusToQueueStatus(invStatus: string): TaskProcessingStatus {
  if (invStatus === 'لم تبدأ') return 'pending';
  if (invStatus === 'قيد المعالجة') return 'processing';
  if (invStatus === 'فشل') return 'failed';
  return 'completed';
}

export class ServerBatchQueueManager {
  private state: PersistedQueueState = { aiBatches: [], exportJobs: [] };
  private aiQueue: Array<{ batchId: string; invoiceId: string }> = [];
  private aiWorkerRunning = false;
  private exportQueue: string[] = [];
  private exportWorkerRunning = false;
  private pendingProcessorRunning = false;
  private orgExportLocks = new Map<string, Promise<void>>();
  private persistChain: Promise<void> = Promise.resolve();
  private initialized = false;

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  }

  private async persistLocalState(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      await this.ensureDirs();
      const tmpFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmpFile, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.rename(tmpFile, STATE_FILE);
    });
    return this.persistChain;
  }

  private async saveAiBatchToSupabase(batch: AiBatchState): Promise<{ ok: boolean; warning?: string }> {
    const client = getSupabaseAdmin();
    if (!client) {
      return { ok: false, warning: 'Supabase غير مهيأ على الخادم' };
    }
    try {
      const completedCount = batch.items.filter((item) => item.status === 'completed').length;
      const failedCount = batch.items.filter((item) => item.status === 'failed').length;
      const activeCount = batch.items.filter((item) => item.status === 'pending' || item.status === 'processing').length;
      const batchStatus = activeCount > 0 ? (batch.items.some((item) => item.status === 'processing') ? 'processing' : 'pending')
        : failedCount === batch.items.length ? 'failed' : 'completed';

      const { error: batchError } = await client.from('ai_processing_batches').upsert({
        id: batch.batchId,
        organization_id: batch.organizationId,
        created_by: batch.createdBy,
        status: batchStatus,
        total_count: batch.items.length,
        completed_count: completedCount,
        failed_count: failedCount,
        updated_at: batch.updatedAt,
      }, { onConflict: 'id' });
      if (batchError) return { ok: false, warning: batchError.message };

      const jobRows = batch.items.filter((item) => Boolean(item.storagePath)).map((item) => ({
        batch_id: batch.batchId,
        organization_id: batch.organizationId,
        invoice_id: item.invoiceId,
        created_by: batch.createdBy,
        file_name: item.fileName,
        mime_type: item.mimeType,
        file_size: item.fileSize || 0,
        storage_path: item.storagePath,
        manual_document_type: item.manualDocumentType,
        status: item.status,
        attempts: item.attempts,
        error_message: item.errorMessage || null,
        extracted_data: item.invoiceRecord || null,
        locked_at: item.status === 'processing' ? item.updatedAt : null,
        completed_at: item.status === 'completed' ? item.updatedAt : null,
        updated_at: item.updatedAt,
      }));
      if (jobRows.length !== batch.items.length) {
        return { ok: false, warning: 'لم تُرفع كل صور الفواتير إلى Storage؛ لا يمكن اعتماد الدفعة.' };
      }
      const { error: jobsError } = await client.from('ai_processing_jobs').upsert(jobRows, { onConflict: 'invoice_id' });
      if (jobsError) return { ok: false, warning: jobsError.message };

      const compactBatch = {
        ...batch,
        items: batch.items.map((it) => ({
          ...it,
          invoiceRecord: it.invoiceRecord ? { ...it.invoiceRecord, imageBase64: undefined } : undefined,
        })),
      };
      const { error: legacyError } = await client.from('app_settings').upsert(
        { setting_key: `bg_ai_batch_${batch.batchId}`, setting_value: compactBatch },
        { onConflict: 'setting_key' }
      );
      if (legacyError) return { ok: false, warning: legacyError.message };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, warning: err?.message || 'فشل حفظ الدفعة في Supabase' };
    }
  }

  private async saveExportJobToSupabase(job: ExportJobState): Promise<{ ok: boolean; warning?: string }> {
    const client = getSupabaseAdmin();
    if (!client) {
      return { ok: false, warning: 'Supabase غير مهيأ على الخادم' };
    }
    try {
      const compactJob = {
        ...job,
        // Keep payload lean inside app_settings
        invoicesSnapshot: [],
      };
      const { error } = await client.from('app_settings').upsert(
        {
          setting_key: `bg_export_job_${job.jobId}`,
          setting_value: compactJob,
        },
        { onConflict: 'setting_key' }
      );
      if (error) return { ok: false, warning: error.message };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, warning: err?.message || 'فشل حفظ مهمة التصدير في Supabase' };
    }
  }

  private async upsertOrganizationAndInvoiceToSupabase(params: {
    organization: { id: string; name: string; activityType: string; excelFileName: string; customFields: any[] };
    invoice: any;
  }): Promise<{ ok: boolean; warning?: string }> {
    const client = getSupabaseAdmin();
    if (!client) return { ok: false, warning: 'Supabase غير مهيأ' };
    try {
      const { organization, invoice } = params;
      if (!UUID_REGEX.test(organization.id) || !UUID_REGEX.test(invoice.id)) {
        return { ok: false, warning: 'UUID غير صالح' };
      }

      const { error: orgErr } = await client.from('organizations').upsert(
        {
          id: organization.id,
          name: organization.name || 'مؤسسة',
          activity_type: organization.activityType || 'أخرى',
          excel_file_name: organization.excelFileName || 'fawater_export.xlsx',
        },
        { onConflict: 'id' }
      );
      if (orgErr) return { ok: false, warning: orgErr.message };

      const safeDate = normalizeInvoiceDate(invoice.invoiceDate);

      const { error: invErr } = await client.from('invoices').upsert(
        {
          id: invoice.id,
          organization_id: organization.id,
          document_type: invoice.documentType || 'يحتاج تحديد النوع',
          entry_method: invoice.entryMethod || 'ai',
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
      if (invErr) return { ok: false, warning: invErr.message };

      const { error: delItemsErr } = await client.from('invoice_items').delete().eq('invoice_id', invoice.id);
      if (delItemsErr) return { ok: false, warning: delItemsErr.message };

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
        if (itemErr) return { ok: false, warning: itemErr.message };
      }

      // Custom fields mapping by id or name
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
            if (icvErr) return { ok: false, warning: icvErr.message };
          }
        }
      }

      return { ok: true };
    } catch (err: any) {
      return { ok: false, warning: err?.message || 'فشل حفظ الفاتورة في Supabase' };
    }
  }

  private async uploadAttachmentToSupabase(params: {
    organizationId: string;
    invoiceId: string;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
  }): Promise<{ ok: boolean; storagePath?: string; warning?: string }> {
    const client = getSupabaseAdmin();
    if (!client) return { ok: false, warning: 'Supabase غير مهيأ' };
    try {
      const ext = params.mimeType.split('/')[1] || 'jpg';
      const safeName = (params.fileName || `invoice.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${params.organizationId}/${params.invoiceId}/${safeName}`;

      const { error: upErr } = await client.storage
        .from('invoice-images')
        .upload(storagePath, params.buffer, { contentType: params.mimeType, upsert: true });
      if (upErr) return { ok: false, warning: upErr.message };

      const { error: metaErr } = await client.from('invoice_attachments').upsert(
        {
          invoice_id: params.invoiceId,
          storage_path: storagePath,
          file_name: params.fileName || safeName,
          mime_type: params.mimeType,
          file_size: params.buffer.byteLength,
        },
        { onConflict: 'invoice_id,storage_path' }
      );
      if (metaErr) return { ok: false, warning: metaErr.message };
      return { ok: true, storagePath };
    } catch (err: any) {
      return { ok: false, warning: err?.message || 'فشل رفع الصورة إلى Storage' };
    }
  }

  private async verifyUploadedStorageFile(params: {
    storagePath: string;
    reportedSize?: number;
  }): Promise<{ ok: boolean; fileSize: number; warning?: string }> {
    const client = getSupabaseAdmin();
    if (!client) return { ok: false, fileSize: 0, warning: 'Supabase غير مهيأ' };
    try {
      const bucket = client.storage.from('invoice-images');
      const { data: infoData, error: infoError } = await bucket.info(params.storagePath);
      if (!infoError && infoData) {
        const size = Number(infoData.size ?? infoData.metadata?.size ?? params.reportedSize ?? 0);
        if (size <= 0 || size > 15 * 1024 * 1024) {
          return { ok: false, fileSize: size, warning: 'حجم الصورة المخزنة غير صالح أو يتجاوز 15 ميغابايت.' };
        }
        return { ok: true, fileSize: size };
      }

      // Fallback metadata check if .info() is unavailable on the storage gateway
      const { data: existsData, error: existsError } = await bucket.exists(params.storagePath);
      if (!existsError && existsData) {
        const fallbackSize = Number(params.reportedSize || 0);
        if (fallbackSize <= 0 || fallbackSize > 15 * 1024 * 1024) {
          return { ok: false, fileSize: fallbackSize, warning: 'حجم الصورة المخزنة غير صالح أو يتجاوز 15 ميغابايت.' };
        }
        return { ok: true, fileSize: fallbackSize };
      }

      return {
        ok: false,
        fileSize: 0,
        warning: infoError?.message || existsError?.message || 'الصورة المرفوعة غير موجودة في التخزين الآمن.',
      };
    } catch (err: any) {
      return { ok: false, fileSize: 0, warning: err?.message || 'فشل التحقق من ملف الفاتورة في Storage.' };
    }
  }

  /**
   * Restores pending and interrupted processing jobs after server restart
   * WITHOUT duplicating already-completed invoices.
   */
  public async recoverPendingJobs(): Promise<{
    recoveredAiItems: number;
    recoveredExportJobs: number;
  }> {
    await this.ensureDirs();
    if (!this.initialized) {
      this.initialized = true;
      try {
        const raw = await fs.readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.aiBatches) && Array.isArray(parsed.exportJobs)) {
          this.state = parsed;
        }
      } catch {
        // clean state on first run
      }

      // Also pull any batches/jobs persisted in Supabase app_settings
      const client = getSupabaseAdmin();
      if (client) {
        try {
          const { data: settingsRows } = await client
            .from('app_settings')
            .select('setting_key, setting_value')
            .or('setting_key.like.bg_ai_batch_%,setting_key.like.bg_export_job_%');

          for (const row of settingsRows || []) {
            if (row.setting_key.startsWith('bg_ai_batch_') && row.setting_value?.batchId) {
              const remoteBatch = row.setting_value as AiBatchState;
              const localIdx = this.state.aiBatches.findIndex((b) => b.batchId === remoteBatch.batchId);
              if (localIdx === -1) {
                this.state.aiBatches.push(remoteBatch);
              } else if (remoteBatch.updatedAt > this.state.aiBatches[localIdx].updatedAt) {
                // Preserve local uploadRelPath references while syncing newer status
                const localItems = new Map(
                  this.state.aiBatches[localIdx].items.map((i) => [i.invoiceId, i])
                );
                this.state.aiBatches[localIdx] = {
                  ...remoteBatch,
                  items: remoteBatch.items.map((ri) => ({
                    ...ri,
                    uploadRelPath: ri.uploadRelPath || localItems.get(ri.invoiceId)?.uploadRelPath,
                  })),
                };
              }
            } else if (row.setting_key.startsWith('bg_export_job_') && row.setting_value?.jobId) {
              const remoteJob = row.setting_value as ExportJobState;
              const localIdx = this.state.exportJobs.findIndex((j) => j.jobId === remoteJob.jobId);
              if (localIdx === -1) {
                this.state.exportJobs.push(remoteJob);
              } else if (remoteJob.updatedAt > this.state.exportJobs[localIdx].updatedAt) {
                this.state.exportJobs[localIdx] = {
                  ...remoteJob,
                  exportRelPath: remoteJob.exportRelPath || this.state.exportJobs[localIdx].exportRelPath,
                };
              }
            }
          }

          // The normalized queue tables are the source of truth; app_settings is only a legacy mirror.
          const { data: durableBatches, error: durableBatchError } = await client
            .from('ai_processing_batches')
            .select('*')
            .in('status', ['pending', 'processing', 'completed', 'failed']);
          if (durableBatchError) throw durableBatchError;

          const durableBatchIds = (durableBatches || []).map((row: any) => row.id);
          if (durableBatchIds.length > 0) {
            const orgIds = Array.from(new Set((durableBatches || []).map((row: any) => row.organization_id)));
            const [{ data: durableJobs, error: durableJobsError }, { data: orgRows, error: orgError }, { data: customRows, error: customError }] =
              await Promise.all([
                client.from('ai_processing_jobs').select('*').in('batch_id', durableBatchIds),
                client.from('organizations').select('id,name,activity_type,excel_file_name').in('id', orgIds),
                client.from('custom_fields').select('*').in('organization_id', orgIds),
              ]);
            if (durableJobsError) throw durableJobsError;
            if (orgError) throw orgError;
            if (customError) throw customError;

            const orgMap = new Map((orgRows || []).map((row: any) => [row.id, row]));
            const fieldsByOrg = new Map<string, any[]>();
            for (const field of customRows || []) {
              const list = fieldsByOrg.get(field.organization_id) || [];
              list.push(field);
              fieldsByOrg.set(field.organization_id, list);
            }

            for (const durableBatch of durableBatches || []) {
              const org: any = orgMap.get(durableBatch.organization_id);
              if (!org) continue;
              const jobs = (durableJobs || []).filter((job: any) => job.batch_id === durableBatch.id);
              const restored: AiBatchState = {
                batchId: durableBatch.id,
                createdBy: durableBatch.created_by,
                organizationId: durableBatch.organization_id,
                organizationName: org.name,
                activityType: org.activity_type,
                excelFileName: org.excel_file_name,
                customFields: fieldsByOrg.get(org.id) || [],
                supabaseSynced: true,
                dismissed: false,
                createdAt: durableBatch.created_at,
                updatedAt: durableBatch.updated_at,
                items: jobs.map((job: any) => ({
                  invoiceId: job.invoice_id,
                  fileName: job.file_name,
                  mimeType: job.mime_type,
                  fileSize: Number(job.file_size || 0),
                  manualDocumentType: job.manual_document_type,
                  status: job.status === 'cancelled' ? 'failed' : job.status,
                  attempts: Number(job.attempts || 0),
                  errorMessage: job.error_message || undefined,
                  storagePath: job.storage_path,
                  invoiceRecord: job.extracted_data || undefined,
                  updatedAt: job.updated_at,
                })),
              };
              const existingIndex = this.state.aiBatches.findIndex((batch) => batch.batchId === restored.batchId);
              if (existingIndex < 0) {
                this.state.aiBatches.push(restored);
              } else {
                const existing = this.state.aiBatches[existingIndex];
                const restoredItems = new Map(restored.items.map((item) => [item.invoiceId, item]));
                existing.createdBy = restored.createdBy;
                existing.items = existing.items.map((item) => {
                  const durable = restoredItems.get(item.invoiceId);
                  return durable && durable.updatedAt >= item.updatedAt ? { ...item, ...durable } : item;
                });
                existing.updatedAt = restored.updatedAt > existing.updatedAt ? restored.updatedAt : existing.updatedAt;
              }
            }
          }

          // Cross-check Supabase invoices table so completed invoices are NEVER duplicated
          const allInvIds = this.state.aiBatches.flatMap((b) => b.items.map((i) => i.invoiceId));
          if (allInvIds.length > 0) {
            const { data: remoteInvs } = await client
              .from('invoices')
              .select('id, status')
              .in('id', allInvIds);
            const remoteStatusMap = new Map((remoteInvs || []).map((r: any) => [r.id, r.status]));
            for (const batch of this.state.aiBatches) {
              for (const item of batch.items) {
                const dbStatus = remoteStatusMap.get(item.invoiceId);
                if (dbStatus === 'تحتاج مراجعة' || dbStatus === 'مكتملة') {
                  item.status = 'completed';
                }
              }
            }
          }
        } catch {
          // Non-fatal Supabase recovery fallback
        }
      }
    }

    let recoveredAiItems = 0;
    let recoveredExportJobs = 0;

    // Re-queue unfinished work after process restarts. Images are recovered from private Supabase Storage.
    for (const batch of this.state.aiBatches) {
      let batchModified = false;
      for (const item of batch.items) {
        if (item.status === 'completed' || item.status === 'failed') continue;
        if (!item.storagePath) {
          item.status = 'failed';
          item.errorMessage = 'ملف الفاتورة غير محفوظ في التخزين السحابي؛ أعد رفعه.';
          item.updatedAt = new Date().toISOString();
          batchModified = true;
          continue;
        }
        if (item.status === 'processing') {
          const lastLock = Date.parse(item.updatedAt || '');
          const lockIsRecent = Number.isFinite(lastLock) && Date.now() - lastLock < 90 * 1000;
          if (lockIsRecent) continue;
          item.status = 'pending';
          batchModified = true;
        }
        if (!this.aiQueue.some((queued) => queued.batchId === batch.batchId && queued.invoiceId === item.invoiceId)) {
          this.aiQueue.push({ batchId: batch.batchId, invoiceId: item.invoiceId });
          recoveredAiItems++;
        }
      }
      if (batchModified) {
        await this.saveAiBatchToSupabase(batch);
      }
    }

    for (const job of this.state.exportJobs) {
      if (job.status === 'completed' || job.status === 'failed') continue;
      if (job.status === 'processing') {
        job.status = 'pending';
        job.updatedAt = new Date().toISOString();
        void this.saveExportJobToSupabase(job);
      }
      if (!this.exportQueue.includes(job.jobId)) {
        this.exportQueue.push(job.jobId);
        recoveredExportJobs++;
      }
    }

    await this.persistLocalState();

    if (recoveredAiItems > 0) {
      console.info(`[batchQueue] Recovered ${recoveredAiItems} pending/interrupted AI invoice task(s).`);
      if (!process.env.VERCEL) void this.processAiQueue();
    }
    if (recoveredExportJobs > 0) {
      console.info(`[batchQueue] Recovered ${recoveredExportJobs} pending/interrupted Excel export job(s).`);
      if (!process.env.VERCEL) void this.processExportQueue();
    }

    return { recoveredAiItems, recoveredExportJobs };
  }

  public async enqueueAiBatch(params: {
    createdBy: string;
    organization: {
      id: string;
      name: string;
      activityType?: string;
      excelFileName?: string;
      customFields?: any[];
    };
    files: Array<{
      invoiceId?: string;
      imageBase64?: string;
      storagePath?: string;
      mimeType?: string;
      fileName: string;
      fileSize?: number;
      fileSha256?: string;
      manualDocumentType?: 'auto' | 'مبيعات' | 'مشتريات';
    }>;
  }): Promise<{
    batch: AiBatchState;
    initialInvoices: any[];
    skippedDuplicates: number;
  }> {
    await this.ensureDirs();
    const batchId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const orgId = params.organization.id;
    const orgMeta = {
      id: orgId,
      name: params.organization.name || 'مؤسسة',
      activityType: params.organization.activityType || 'أخرى',
      excelFileName: params.organization.excelFileName || 'fawater_export.xlsx',
      customFields: Array.isArray(params.organization.customFields)
        ? params.organization.customFields
        : [],
    };

    const client = getSupabaseAdmin();
    if (!client) {
      throw new Error('اتصال Supabase الإداري غير مهيأ.');
    }

    const items: AiBatchItemState[] = [];
    const initialInvoices: any[] = [];
    const invoiceRows: any[] = [];
    const attachmentRows: any[] = [];
    let allSupabaseSynced = true;
    let firstWarning: string | undefined;

    // 1. Validate all files & metadata first without redundant downloads
    const preparedFiles = params.files.map((f) => {
      const invoiceId = f.invoiceId && UUID_REGEX.test(f.invoiceId) ? f.invoiceId : crypto.randomUUID();
      const safeMime = normalizeMimeType(f.mimeType, f.fileName);
      if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(safeMime)) {
        throw new Error(`نوع الملف "${f.fileName}" غير مدعوم.`);
      }
      const manualChoice: 'auto' | 'مبيعات' | 'مشتريات' =
        f.manualDocumentType === 'مبيعات' || f.manualDocumentType === 'مشتريات'
          ? f.manualDocumentType
          : 'auto';
      const initialDocType =
        manualChoice === 'مبيعات' || manualChoice === 'مشتريات'
          ? manualChoice
          : 'يحتاج تحديد النوع';
      const storagePath = String(f.storagePath || '').trim();
      if (storagePath) {
        const safeName = (f.fileName || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '_') || 'invoice';
        const expectedPath = `${orgId}/${invoiceId}/${safeName}`;
        if (storagePath !== expectedPath) {
          throw new Error('مسار الصورة لا يطابق المؤسسة والفاتورة المحددتين.');
        }
      } else if (!f.imageBase64) {
        throw new Error(`لم يتم رفع ملف الفاتورة "${f.fileName}" إلى التخزين.`);
      }
      const fileSha256 = typeof f.fileSha256 === 'string' && /^[0-9a-f]{64}$/i.test(f.fileSha256.trim())
        ? f.fileSha256.trim().toLowerCase()
        : '';
      return { f, invoiceId, safeMime, manualChoice, initialDocType, storagePath, fileSha256 };
    });

    // 1b. Deduplicate against existing invoices/attachments in the same operation AND within the batch
    const existingHashes = new Set<string>();
    const existingNameSizes = new Set<string>();
    const makeNameSizeKey = (name?: string, size?: number) => {
      const n = String(name || '').trim().toLowerCase();
      const s = Number(size || 0);
      return n && s > 0 ? `${n}::${s}` : '';
    };

    const { data: existingOrgInvoices } = await client
      .from('invoices')
      .select('id, extra_columns_data, invoice_attachments(file_name, file_size)')
      .eq('organization_id', orgId);

    for (const row of existingOrgInvoices || []) {
      const sha = row?.extra_columns_data?.imageSha256;
      if (typeof sha === 'string' && sha.trim()) existingHashes.add(sha.trim().toLowerCase());
      for (const att of row?.invoice_attachments || []) {
        const key = makeNameSizeKey(att?.file_name, att?.file_size);
        if (key) existingNameSizes.add(key);
      }
    }

    const uniquePreparedFiles: typeof preparedFiles = [];
    const duplicateStoragePaths: string[] = [];
    for (const entry of preparedFiles) {
      const nameSizeKey = makeNameSizeKey(entry.f.fileName, entry.f.fileSize);
      const isDuplicateHash = Boolean(entry.fileSha256 && existingHashes.has(entry.fileSha256));
      const isDuplicateNameSize = Boolean(nameSizeKey && existingNameSizes.has(nameSizeKey));
      if (isDuplicateHash || isDuplicateNameSize) {
        if (entry.storagePath) duplicateStoragePaths.push(entry.storagePath);
        continue;
      }
      if (entry.fileSha256) existingHashes.add(entry.fileSha256);
      if (nameSizeKey) existingNameSizes.add(nameSizeKey);
      uniquePreparedFiles.push(entry);
    }

    if (duplicateStoragePaths.length > 0) {
      await client.storage.from('invoice-images').remove(duplicateStoragePaths).catch(() => {});
    }

    const skippedDuplicates = preparedFiles.length - uniquePreparedFiles.length;
    if (uniquePreparedFiles.length === 0) {
      throw new Error(
        'جميع الصور المختارة مكررة وموجودة مسبقاً في هذه العملية. يمكنك حذف الفواتير أو العمليات السابقة أولاً إذا أردت إعادة رفعها.'
      );
    }

    // 2. Verify pre-uploaded storage files in parallel metadata waves (0 bytes downloaded)
    const storageEntries = uniquePreparedFiles.filter((p) => Boolean(p.storagePath));
    const verifiedSizes = new Map<string, number>();
    const VERIFY_CONCURRENCY = 10;
    for (let i = 0; i < storageEntries.length; i += VERIFY_CONCURRENCY) {
      const chunk = storageEntries.slice(i, i + VERIFY_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (entry) => {
          const check = await this.verifyUploadedStorageFile({
            storagePath: entry.storagePath,
            reportedSize: entry.f.fileSize,
          });
          if (!check.ok) {
            throw new Error(check.warning || `تعذر التحقق من "${entry.f.fileName}" في Storage.`);
          }
          return { invoiceId: entry.invoiceId, fileSize: check.fileSize };
        })
      );
      for (const r of results) verifiedSizes.set(r.invoiceId, r.fileSize);
    }

    // 3. Upsert organization ONCE before writing invoices
    const { error: orgErr } = await client.from('organizations').upsert(
      {
        id: orgMeta.id,
        name: orgMeta.name,
        activity_type: orgMeta.activityType,
        excel_file_name: orgMeta.excelFileName,
      },
      { onConflict: 'id' }
    );
    if (orgErr) throw new Error(orgErr.message || 'تعذر حفظ بيانات المؤسسة في Supabase.');

    // 4. Handle any direct base64 uploads (legacy fallback) & build batch DB rows
    for (const entry of uniquePreparedFiles) {
      const { f, invoiceId, safeMime, manualChoice, initialDocType, fileSha256 } = entry;
      let storagePath = entry.storagePath;
      let buffer: Buffer | undefined;
      let relPath: string | undefined;
      let resolvedSize = verifiedSizes.get(invoiceId) ?? Number(f.fileSize || 0);
      const extraColumnsData = fileSha256 ? { imageSha256: fileSha256 } : {};

      if (!storagePath && f.imageBase64) {
        const cleanBase64 = stripDataUrlPrefix(f.imageBase64);
        buffer = Buffer.from(cleanBase64, 'base64');
        if (buffer.byteLength <= 0 || buffer.byteLength > 15 * 1024 * 1024) {
          throw new Error('حجم ملف الفاتورة غير صالح أو يتجاوز 15 ميغابايت.');
        }
        resolvedSize = buffer.byteLength;
        relPath = `${invoiceId}.bin`;
        await fs.writeFile(path.join(UPLOADS_DIR, relPath), buffer);

        const ext = safeMime.split('/')[1] || 'jpg';
        const safeName = (f.fileName || `invoice.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const targetPath = `${orgId}/${invoiceId}/${safeName}`;
        const { error: upErr } = await client.storage
          .from('invoice-images')
          .upload(targetPath, buffer, { contentType: safeMime, upsert: true });
        if (upErr) throw new Error(upErr.message || 'تعذر رفع الصورة إلى Storage.');
        storagePath = targetPath;
      }

      const initialInvoice = {
        id: invoiceId,
        organizationId: orgId,
        invoiceNumber: '',
        invoiceDate: '',
        documentType: initialDocType,
        entryMethod: 'ai',
        issuerName: '',
        clientName: '',
        issuerTaxId: '',
        clientTaxId: '',
        currency: '',
        subtotal: undefined,
        taxAmount: undefined,
        taxRate: undefined,
        discount: undefined,
        grandTotal: undefined,
        notes: '',
        items: [],
        customFieldsValues: {},
        extraColumnsData,
        status: 'لم تبدأ',
        processingStatus: 'pending' as TaskProcessingStatus,
        hasImage: true,
        storagePath,
        imageFileName: f.fileName,
        imageMimeType: safeMime,
        imageFileSize: resolvedSize,
        syncStatus: 'synced',
        createdAt: nowIso.split('T')[0],
        updatedAt: nowIso,
      };

      invoiceRows.push({
        id: invoiceId,
        organization_id: orgId,
        document_type: initialDocType,
        entry_method: 'ai',
        invoice_number: '',
        invoice_date: null,
        day: '',
        issuer_name: '',
        client_name: '',
        issuer_tax_id: '',
        client_tax_id: '',
        currency: '',
        subtotal: null,
        tax_amount: null,
        tax_rate: null,
        discount: null,
        grand_total: null,
        cash_sales: null,
        network_sales: null,
        cash_balance: null,
        cash_box_balance: null,
        network_balance: null,
        balance: null,
        notes: '',
        classification_reason: '',
        status: 'لم تبدأ',
        error_message: null,
        custom_fields_values: {},
        extra_columns_data: extraColumnsData,
        updated_at: nowIso,
      });

      attachmentRows.push({
        invoice_id: invoiceId,
        storage_path: storagePath,
        file_name: f.fileName,
        mime_type: safeMime,
        file_size: resolvedSize,
      });

      items.push({
        invoiceId,
        fileName: f.fileName,
        mimeType: safeMime,
        fileSize: resolvedSize,
        manualDocumentType: manualChoice,
        status: 'pending',
        attempts: 0,
        storagePath,
        uploadRelPath: relPath,
        invoiceRecord: initialInvoice,
        updatedAt: nowIso,
      });
      initialInvoices.push(initialInvoice);
    }

    // 5. Batch upsert all invoices & attachments in 2 queries instead of 250+ sequential queries
    if (invoiceRows.length > 0) {
      const { error: invBatchErr } = await client.from('invoices').upsert(invoiceRows, { onConflict: 'id' });
      if (invBatchErr) throw new Error(invBatchErr.message || 'تعذر إنشاء سجلات الفواتير في Supabase.');
    }
    if (attachmentRows.length > 0) {
      const { error: attBatchErr } = await client
        .from('invoice_attachments')
        .upsert(attachmentRows, { onConflict: 'invoice_id,storage_path' });
      if (attBatchErr) throw new Error(attBatchErr.message || 'تعذر تسجيل مرفقات الفواتير في Supabase.');
    }

    const batch: AiBatchState = {
      batchId,
      createdBy: params.createdBy,
      organizationId: orgId,
      organizationName: orgMeta.name,
      activityType: orgMeta.activityType,
      excelFileName: orgMeta.excelFileName,
      customFields: orgMeta.customFields,
      items,
      supabaseSynced: allSupabaseSynced,
      supabaseWarning: firstWarning,
      dismissed: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const batchDbRes = await this.saveAiBatchToSupabase(batch);
    if (!batchDbRes.ok) {
      batch.supabaseSynced = false;
      if (!batch.supabaseWarning) batch.supabaseWarning = batchDbRes.warning;
    }

    this.state.aiBatches.unshift(batch);
    // Keep max 30 recent batches in memory/state file to stay tidy
    if (this.state.aiBatches.length > 30) {
      this.state.aiBatches = this.state.aiBatches.slice(0, 30);
    }

    for (const item of batch.items) {
      this.aiQueue.push({ batchId: batch.batchId, invoiceId: item.invoiceId });
    }

    await this.persistLocalState();
    // Vercel requests register the worker with waitUntil in the API handler; persistent servers start it here.
    if (!process.env.VERCEL) void this.processAiQueue();

    return { batch, initialInvoices, skippedDuplicates };
  }

  public async removeOrganizationQueues(organizationId: string): Promise<void> {
    const removedAiBatchIds = this.state.aiBatches
      .filter((b) => b.organizationId === organizationId)
      .map((b) => b.batchId);
    const removedExportIds = this.state.exportJobs
      .filter((j) => j.organizationId === organizationId)
      .map((j) => j.jobId);

    this.state.aiBatches = this.state.aiBatches.filter((b) => b.organizationId !== organizationId);
    this.state.exportJobs = this.state.exportJobs.filter((j) => j.organizationId !== organizationId);
    const batchIdSet = new Set(removedAiBatchIds);
    const exportIdSet = new Set(removedExportIds);
    this.aiQueue = this.aiQueue.filter((q) => !batchIdSet.has(q.batchId));
    this.exportQueue = this.exportQueue.filter((id) => !exportIdSet.has(id));

    const client = getSupabaseAdmin();
    if (client) {
      const settingKeys = [
        ...removedAiBatchIds.map((id) => `bg_ai_batch_${id}`),
        ...removedExportIds.map((id) => `bg_export_job_${id}`),
      ];
      try {
        if (settingKeys.length > 0) {
          await client.from('app_settings').delete().in('setting_key', settingKeys);
        }
        await client.from('ai_processing_jobs').delete().eq('organization_id', organizationId);
        await client.from('ai_processing_batches').delete().eq('organization_id', organizationId);
      } catch {
        // non-fatal cleanup fallback
      }
    }
    await this.persistLocalState().catch(() => {});
  }

  public async removeInvoiceFromQueues(invoiceId: string): Promise<void> {
    this.aiQueue = this.aiQueue.filter((q) => q.invoiceId !== invoiceId);
    let changed = false;
    const nowIso = new Date().toISOString();
    for (const batch of this.state.aiBatches) {
      const before = batch.items.length;
      batch.items = batch.items.filter((i) => i.invoiceId !== invoiceId);
      if (batch.items.length !== before) {
        batch.updatedAt = nowIso;
        changed = true;
        if (batch.items.length === 0) {
          const client = getSupabaseAdmin();
          if (client) {
            try {
              await client.from('app_settings').delete().eq('setting_key', `bg_ai_batch_${batch.batchId}`);
              await client.from('ai_processing_batches').delete().eq('id', batch.batchId);
            } catch {
              // non-fatal cleanup fallback
            }
          }
        } else {
          await this.saveAiBatchToSupabase(batch);
        }
      }
    }
    this.state.aiBatches = this.state.aiBatches.filter((b) => b.items.length > 0);
    const client = getSupabaseAdmin();
    if (client) {
      try {
        await client.from('ai_processing_jobs').delete().eq('invoice_id', invoiceId);
      } catch {
        // non-fatal cleanup fallback
      }
    }
    if (changed) await this.persistLocalState().catch(() => {});
  }

  public async retryFailedAiBatchItems(batchId: string): Promise<AiBatchState | null> {
    const batch = this.state.aiBatches.find((b) => b.batchId === batchId);
    if (!batch) return null;

    const nowIso = new Date().toISOString();
    let retried = 0;

    for (const item of batch.items) {
      if (item.status === 'failed') {
        item.status = 'pending';
        item.errorMessage = undefined;
        item.updatedAt = nowIso;
        if (item.invoiceRecord) {
          item.invoiceRecord.status = 'لم تبدأ';
          item.invoiceRecord.processingStatus = 'pending';
          item.invoiceRecord.errorMessage = undefined;
          item.invoiceRecord.updatedAt = nowIso;
          await this.upsertOrganizationAndInvoiceToSupabase({
            organization: {
              id: batch.organizationId,
              name: batch.organizationName,
              activityType: batch.activityType,
              excelFileName: batch.excelFileName,
              customFields: batch.customFields,
            },
            invoice: item.invoiceRecord,
          });
        }
        const queued = this.aiQueue.some(
          (q) => q.batchId === batch.batchId && q.invoiceId === item.invoiceId
        );
        if (!queued) {
          this.aiQueue.push({ batchId: batch.batchId, invoiceId: item.invoiceId });
        }
        retried++;
      }
    }

    if (retried > 0) {
      batch.dismissed = false;
      batch.updatedAt = nowIso;
      await this.saveAiBatchToSupabase(batch);
      await this.persistLocalState();
      if (!process.env.VERCEL) void this.processAiQueue();
    }

    return batch;
  }

  private async loadAttachmentBase64(item: AiBatchItemState): Promise<string> {
    // 1. Try server durable upload cache first
    if (item.uploadRelPath) {
      try {
        const buf = await fs.readFile(path.join(UPLOADS_DIR, item.uploadRelPath));
        if (buf.byteLength > 0) return buf.toString('base64');
      } catch {
        // fallback to Supabase Storage
      }
    }

    // 2. Fallback to Supabase Storage (important when recovering on ephemeral container with Supabase)
    const client = getSupabaseAdmin();
    if (client && item.storagePath) {
      const { data: blob, error } = await client.storage
        .from('invoice-images')
        .download(item.storagePath);
      if (!error && blob) {
        const arrBuf = await blob.arrayBuffer();
        return Buffer.from(arrBuf).toString('base64');
      }
    }

    throw new Error('تعذر العثور على ملف الفاتورة في الخادم أو التخزين السحابي للمعالجة.');
  }

  public async processPendingQueues(maxAiJobs = process.env.VERCEL ? 1 : Number.POSITIVE_INFINITY): Promise<void> {
    if (this.pendingProcessorRunning) return;
    this.pendingProcessorRunning = true;
    try {
      // Vercel instances are ephemeral. Refresh the durable Supabase queue on
      // every worker invocation, not only once per warm module instance.
      if (process.env.VERCEL) {
        this.initialized = false;
        await this.recoverPendingJobs();
      }
      const aiWorkerAlreadyRunning = this.aiWorkerRunning;
      const exportWorkerAlreadyRunning = this.exportWorkerRunning;
      await Promise.all([this.processAiQueue(maxAiJobs), this.processExportQueue()]);

      // Vercel background functions have a finite execution window. Chain a fresh
      // invocation while durable jobs remain so large batches continue after the
      // original upload request and after the user closes the page.
      if (process.env.VERCEL && !aiWorkerAlreadyRunning && !exportWorkerAlreadyRunning && (this.aiQueue.length > 0 || this.exportQueue.length > 0)) {
      const configuredAppUrl = process.env.APP_URL?.trim();
      const baseUrl = (configuredAppUrl?.startsWith('https://') || configuredAppUrl?.startsWith('http://')
        ? configuredAppUrl
        : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://fawater-mocha.vercel.app').replace(/\/$/, '');
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (baseUrl && serviceKey) {
        try {
          const response = await fetch(`${baseUrl}/api/background/worker`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (!response.ok) throw new Error(`worker endpoint returned ${response.status}`);
        } catch (error: any) {
          console.error('[batchQueue] Could not schedule the next Vercel worker invocation:', error?.message || error);
        }
      } else {
        console.error('[batchQueue] VERCEL_URL/APP_URL or SUPABASE_SERVICE_ROLE_KEY is missing; remaining background jobs will resume on the next API request.');
      }
    }
    } finally {
      this.pendingProcessorRunning = false;
    }
  }

  private async claimAiJob(item: AiBatchItemState): Promise<boolean> {
    const client = getSupabaseAdmin();
    if (!client) throw new Error('Supabase غير مهيأ؛ تعذر حجز مهمة التحليل.');
    const now = new Date().toISOString();
    const { data, error } = await client
      .from('ai_processing_jobs')
      .update({
        status: 'processing',
        attempts: item.attempts + 1,
        locked_at: now,
        started_at: now,
        updated_at: now,
      })
      .eq('invoice_id', item.invoiceId)
      .eq('status', 'pending')
      .select('invoice_id')
      .maybeSingle();
    if (error) throw error;
    return Boolean(data?.invoice_id);
  }

  private async processAiQueue(maxJobs = Number.POSITIVE_INFINITY): Promise<void> {
    if (this.aiWorkerRunning) return;
    this.aiWorkerRunning = true;

    let processedCount = 0;
    try {
      while (this.aiQueue.length > 0 && processedCount < maxJobs) {
        const next = this.aiQueue.shift()!;
        const batch = this.state.aiBatches.find((b) => b.batchId === next.batchId);
        if (!batch) continue;
        const item = batch.items.find((i) => i.invoiceId === next.invoiceId);
        if (!item) continue;

        // Idempotency guard: never re-process completed invoices.
        // A conditional database update claims the pending job atomically across serverless instances.
        if (item.status === 'completed') continue;
        let claimed = false;
        try {
          claimed = await this.claimAiJob(item);
        } catch (claimError) {
          // Preserve the in-memory item so a transient database outage cannot drop the job.
          this.aiQueue.unshift(next);
          throw claimError;
        }
        if (!claimed) continue;
        processedCount++;

        const nowIso = new Date().toISOString();
        item.status = 'processing';
        item.attempts += 1;
        item.updatedAt = nowIso;
        if (item.invoiceRecord) {
          item.invoiceRecord.status = mapQueueStatusToInvoiceStatus('processing');
          item.invoiceRecord.processingStatus = 'processing';
          item.invoiceRecord.updatedAt = nowIso;
        }
        batch.updatedAt = nowIso;

        await this.upsertOrganizationAndInvoiceToSupabase({
          organization: {
            id: batch.organizationId,
            name: batch.organizationName,
            activityType: batch.activityType,
            excelFileName: batch.excelFileName,
            customFields: batch.customFields,
          },
          invoice: item.invoiceRecord,
        });
        await this.saveAiBatchToSupabase(batch);
        await this.persistLocalState();

        try {
          const base64 = await this.loadAttachmentBase64(item);
          const ext = await extractInvoiceWithGemini({
            invoiceId: item.invoiceId,
            imageBase64: base64,
            mimeType: item.mimeType,
            fileName: item.fileName,
            customFields: batch.customFields,
            organizationName: batch.organizationName,
            activityType: batch.activityType,
            manualDocumentType: item.manualDocumentType,
          });

          const classifiedType =
            item.manualDocumentType === 'مبيعات' || item.manualDocumentType === 'مشتريات'
              ? item.manualDocumentType
              : ext.documentType;

          const doneIso = new Date().toISOString();
          const completedRecord = {
            ...(item.invoiceRecord || {}),
            id: item.invoiceId,
            organizationId: batch.organizationId,
            entryMethod: 'ai',
            documentType: classifiedType,
            classificationReason: ext.classificationReason || '',
            invoiceNumber: ext.invoiceNumber || '',
            invoiceDate: ext.invoiceDate || '',
            day: ext.day || '',
            issuerName: ext.issuerName || '',
            clientName: ext.clientName || '',
            issuerTaxId: ext.issuerTaxId || '',
            clientTaxId: ext.clientTaxId || '',
            currency: ext.currency || '',
            subtotal: toOptionalNum(ext.subtotal),
            taxAmount: toOptionalNum(ext.taxAmount),
            taxRate: toOptionalNum(ext.taxRate),
            discount: toOptionalNum(ext.discount),
            grandTotal: toOptionalNum(ext.grandTotal),
            cashSales: toOptionalNum(ext.cashSales),
            networkSales: toOptionalNum(ext.networkSales),
            notes: ext.notes || '',
            items: Array.isArray(ext.items)
              ? ext.items.map((it: any) => ({
                  id: it?.id && UUID_REGEX.test(it.id) ? it.id : crypto.randomUUID(),
                  name: String(it?.name || ''),
                  code: it?.code ? String(it.code) : undefined,
                  quantity: toOptionalNum(it?.quantity),
                  unit: it?.unit ? String(it.unit) : undefined,
                  unitPrice: toOptionalNum(it?.unitPrice),
                  discount: toOptionalNum(it?.discount),
                  tax: toOptionalNum(it?.tax),
                  total: toOptionalNum(it?.total),
                }))
              : [],
            customFieldsValues: {
              ...(ext.customFieldsExtracted && typeof ext.customFieldsExtracted === 'object' ? ext.customFieldsExtracted : {}),
              ...(ext.paymentMethod ? { __official_payment_method: ext.paymentMethod } : {}),
            },
            status: mapQueueStatusToInvoiceStatus('completed'),
            processingStatus: 'completed' as TaskProcessingStatus,
            errorMessage: undefined,
            updatedAt: doneIso,
          };

          try {
            const orgPool: any[] = [];
            for (const b of this.state.aiBatches) {
              if (b.organizationId !== batch.organizationId) continue;
              for (const otherItem of b.items) {
                if (
                  otherItem.invoiceId !== item.invoiceId &&
                  otherItem.status === 'completed' &&
                  otherItem.invoiceRecord
                ) {
                  orgPool.push(otherItem.invoiceRecord);
                }
              }
            }
            const sbClient = getSupabaseAdmin();
            if (sbClient) {
              const { data: existingRows } = await sbClient
                .from('invoices')
                .select(
                  'id, document_type, invoice_number, invoice_date, issuer_name, issuer_tax_id, subtotal, tax_amount, grand_total, cash_sales, network_sales, extra_columns_data, status'
                )
                .eq('organization_id', batch.organizationId)
                .neq('id', item.invoiceId)
                .neq('status', 'فشل');
              for (const row of existingRows || []) {
                orgPool.push(row);
              }
            }
            const dupCheck = findDuplicateInvoiceServer(completedRecord, orgPool);
            if (dupCheck.isDuplicate) {
              const prefix = `تنبيه تكرار (مستبعدة من Excel): ${dupCheck.reason || 'مطابقة لفاتورة سابقة'}`;
              completedRecord.classificationReason = completedRecord.classificationReason
                ? `${prefix} — ${completedRecord.classificationReason}`
                : prefix;
            }
          } catch {
            // non-fatal duplicate annotation
          }

          const dbSave = await this.upsertOrganizationAndInvoiceToSupabase({
            organization: {
              id: batch.organizationId,
              name: batch.organizationName,
              activityType: batch.activityType,
              excelFileName: batch.excelFileName,
              customFields: batch.customFields,
            },
            invoice: completedRecord,
          });
          completedRecord.syncStatus = dbSave.ok ? 'synced' : 'pending';

          item.status = 'completed';
          item.errorMessage = undefined;
          item.invoiceRecord = completedRecord;
          item.updatedAt = doneIso;
          batch.supabaseSynced = batch.supabaseSynced && dbSave.ok;
          if (!dbSave.ok && !batch.supabaseWarning) batch.supabaseWarning = dbSave.warning;
          batch.updatedAt = doneIso;
        } catch (err: any) {
          // Single-invoice failure NEVER stops the rest of the batch
          const failIso = new Date().toISOString();
          const errText = err?.message || 'فشل استخراج الفاتورة بالذكاء الاصطناعي';
          item.status = 'failed';
          item.errorMessage = errText;
          item.updatedAt = failIso;
          if (item.invoiceRecord) {
            item.invoiceRecord.status = mapQueueStatusToInvoiceStatus('failed');
            item.invoiceRecord.processingStatus = 'failed';
            item.invoiceRecord.errorMessage = errText;
            item.invoiceRecord.updatedAt = failIso;
            const dbFail = await this.upsertOrganizationAndInvoiceToSupabase({
              organization: {
                id: batch.organizationId,
                name: batch.organizationName,
                activityType: batch.activityType,
                excelFileName: batch.excelFileName,
                customFields: batch.customFields,
              },
              invoice: item.invoiceRecord,
            });
            item.invoiceRecord.syncStatus = dbFail.ok ? 'synced' : 'pending';
          }
          batch.updatedAt = failIso;
        }

        // Persist immediately after each invoice finishes
        await this.saveAiBatchToSupabase(batch);
        await this.persistLocalState();

        if (this.aiQueue.length > 0) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } finally {
      this.aiWorkerRunning = false;
      if (this.aiQueue.length > 0 && !process.env.VERCEL) {
        await this.processAiQueue(maxJobs);
      }
    }
  }

  // =========================================================================
  // Independent Background Excel Export Queue (Per-Organization Mutex Lock)
  // =========================================================================

  private withOrganizationExportLock<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.orgExportLocks.get(organizationId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.orgExportLocks.set(organizationId, tail);
    return run;
  }

  public async enqueueExportJob(params: {
    organization: {
      id: string;
      name: string;
      excelFileName?: string;
    };
    invoices: any[];
    alreadyExportedIds?: string[];
  }): Promise<ExportJobState> {
    await this.ensureDirs();
    const jobId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const completedPriorCount = this.state.exportJobs.filter(
      (j) => j.organizationId === params.organization.id && j.status === 'completed'
    ).length;

    const baseRaw = (params.organization.excelFileName || `${params.organization.name}_fawater.xlsx`).replace(
      /\.xlsx$/i,
      ''
    );
    const fileName =
      completedPriorCount === 0 ? `${baseRaw}.xlsx` : `${baseRaw}_batch${completedPriorCount + 1}.xlsx`;

    const job: ExportJobState = {
      jobId,
      batchId,
      organizationId: params.organization.id,
      organizationName: params.organization.name,
      fileName,
      status: 'pending',
      attempts: 0,
      invoicesSnapshot: (params.invoices || []).map((inv) => {
        const { imageBase64: _drop, ...clean } = inv;
        return clean;
      }),
      alreadyExportedIds: Array.from(new Set(params.alreadyExportedIds || [])),
      supabaseSynced: true,
      dismissed: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const dbSave = await this.saveExportJobToSupabase(job);
    if (!dbSave.ok) {
      job.supabaseSynced = false;
      job.supabaseWarning = dbSave.warning;
    }

    this.state.exportJobs.unshift(job);
    if (this.state.exportJobs.length > 30) {
      this.state.exportJobs = this.state.exportJobs.slice(0, 30);
    }
    this.exportQueue.push(jobId);

    await this.persistLocalState();
    if (!process.env.VERCEL) void this.processExportQueue();
    return job;
  }

  private async processExportQueue(): Promise<void> {
    if (this.exportWorkerRunning) return;
    this.exportWorkerRunning = true;

    try {
      while (this.exportQueue.length > 0) {
        const jobId = this.exportQueue.shift()!;
        const job = this.state.exportJobs.find((j) => j.jobId === jobId);
        if (!job || job.status === 'completed') continue;

        // Per-organization mutex prevents conflicting updates to the same organization's Excel file
        await this.withOrganizationExportLock(job.organizationId, async () => {
          job.status = 'processing';
          job.attempts += 1;
          job.updatedAt = new Date().toISOString();
          await this.saveExportJobToSupabase(job);
          await this.persistLocalState();

          try {
            // Merge any already-exported IDs recorded in previous completed server export jobs + Supabase
            const blockedIds = new Set<string>(job.alreadyExportedIds || []);
            for (const prevJob of this.state.exportJobs) {
              if (
                prevJob.jobId !== job.jobId &&
                prevJob.organizationId === job.organizationId &&
                prevJob.status === 'completed'
              ) {
                for (const entry of prevJob.entries || []) {
                  // Only skip if invoice wasn't modified since that export
                  const matchingInv = job.invoicesSnapshot.find((i) => i.id === entry.invoiceId);
                  if (
                    matchingInv &&
                    entry.invoiceUpdatedAt &&
                    matchingInv.updatedAt &&
                    matchingInv.updatedAt > entry.invoiceUpdatedAt
                  ) {
                    continue;
                  }
                  blockedIds.add(entry.invoiceId);
                }
              }
            }

            const client = getSupabaseAdmin();
            if (client) {
              try {
                const { data: dbBatches } = await client
                  .from('export_batches')
                  .select('id, exported_at')
                  .eq('organization_id', job.organizationId);
                const dbBatchIds = (dbBatches || []).map((b: any) => b.id);
                if (dbBatchIds.length > 0) {
                  const { data: dbItems } = await client
                    .from('export_batch_items')
                    .select('invoice_id')
                    .in('export_batch_id', dbBatchIds);
                  for (const di of dbItems || []) {
                    const matchingInv = job.invoicesSnapshot.find((i) => i.id === di.invoice_id);
                    if (!matchingInv) {
                      blockedIds.add(di.invoice_id);
                    }
                  }
                }
              } catch {
                // ignore if Supabase unavailable
              }
            }

            const result = await generateOfficialExcelOnServer({
              organizationId: job.organizationId,
              invoices: job.invoicesSnapshot,
              alreadyExportedIds: blockedIds,
            });

            if (result.exportedCount === 0) {
              throw new Error(
                'لا توجد فواتير معتمدة ومؤرخة جديدة للتصدير (أو تم تصديرها مسبقاً دون تعديل).'
              );
            }

            const relPath = `${job.batchId}.xlsx`;
            await fs.writeFile(path.join(EXPORTS_DIR, relPath), result.buffer);

            let storagePath: string | undefined;
            let supabaseOk = false;
            let supabaseWarn: string | undefined;

            if (client) {
              try {
                const safeName = job.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
                storagePath = `${job.organizationId}/${job.batchId}_${safeName}`;
                const { error: upErr } = await client.storage
                  .from('invoice-exports')
                  .upload(storagePath, result.buffer, {
                    contentType:
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    upsert: true,
                  });
                if (upErr) throw upErr;

                const { error: batchErr } = await client.from('export_batches').upsert(
                  {
                    id: job.batchId,
                    organization_id: job.organizationId,
                    file_name: job.fileName,
                    template_sha256: result.templateSha256,
                    storage_path: storagePath,
                    exported_count: result.exportedCount,
                    sales_count: result.salesWritten,
                    purchases_count: result.purchasesWritten,
                    exported_at: new Date().toISOString(),
                  },
                  { onConflict: 'id' }
                );
                if (batchErr) throw batchErr;

                const itemRows = result.entries.map((e) => ({
                  export_batch_id: job.batchId,
                  invoice_id: e.invoiceId,
                  sheet_name: e.sheetName,
                  row_number: e.rowNumber,
                }));
                const { error: itemErr } = await client
                  .from('export_batch_items')
                  .upsert(itemRows, { onConflict: 'export_batch_id,invoice_id' });
                if (itemErr) throw itemErr;

                await client.from('audit_logs').insert({
                  organization_id: job.organizationId,
                  action: 'background_excel_export',
                  details: {
                    jobId: job.jobId,
                    batchId: job.batchId,
                    fileName: job.fileName,
                    exportedCount: result.exportedCount,
                  },
                });
                supabaseOk = true;
              } catch (sbErr: any) {
                supabaseOk = false;
                supabaseWarn = sbErr?.message || 'تم توليد الملف على الخادم وتعذر رفعه إلى Supabase';
              }
            }

            job.status = 'completed';
            job.templateSha256 = result.templateSha256;
            job.storagePath = storagePath;
            job.exportRelPath = relPath;
            job.exportedCount = result.exportedCount;
            job.salesCount = result.salesWritten;
            job.purchasesCount = result.purchasesWritten;
            job.entries = result.entries;
            job.errorMessage = undefined;
            job.supabaseSynced = supabaseOk;
            job.supabaseWarning = supabaseWarn;
            job.updatedAt = new Date().toISOString();
          } catch (err: any) {
            job.status = 'failed';
            job.errorMessage = err?.message || 'فشل تصدير ملف Excel في الخلفية';
            job.updatedAt = new Date().toISOString();
          }

          await this.saveExportJobToSupabase(job);
          await this.persistLocalState();
        });
      }
    } finally {
      this.exportWorkerRunning = false;
      if (this.exportQueue.length > 0) {
        await this.processExportQueue();
      }
    }
  }

  public async getExportBuffer(jobId: string): Promise<{ buffer: Buffer; fileName: string } | null> {
    const job = this.state.exportJobs.find((j) => j.jobId === jobId || j.batchId === jobId);
    if (!job || job.status !== 'completed') return null;

    if (job.exportRelPath) {
      try {
        const buf = await fs.readFile(path.join(EXPORTS_DIR, job.exportRelPath));
        return { buffer: buf, fileName: job.fileName };
      } catch {
        // fallback to Supabase Storage
      }
    }

    const client = getSupabaseAdmin();
    if (client && job.storagePath) {
      const { data: blob, error } = await client.storage
        .from('invoice-exports')
        .download(job.storagePath);
      if (!error && blob) {
        const arrBuf = await blob.arrayBuffer();
        return { buffer: Buffer.from(arrBuf), fileName: job.fileName };
      }
    }
    return null;
  }

  public async dismissJob(id: string): Promise<void> {
    let changed = false;
    for (const b of this.state.aiBatches) {
      if (b.batchId === id) {
        b.dismissed = true;
        b.updatedAt = new Date().toISOString();
        void this.saveAiBatchToSupabase(b);
        changed = true;
      }
    }
    for (const j of this.state.exportJobs) {
      if (j.jobId === id || j.batchId === id) {
        j.dismissed = true;
        j.updatedAt = new Date().toISOString();
        void this.saveExportJobToSupabase(j);
        changed = true;
      }
    }
    if (changed) await this.persistLocalState();
  }

  public getStatus(organizationId?: string) {
    const aiBatches = this.state.aiBatches
      .filter((b) => !organizationId || b.organizationId === organizationId)
      .map((b) => {
        const total = b.items.length;
        const pending = b.items.filter((i) => i.status === 'pending').length;
        const processing = b.items.filter((i) => i.status === 'processing').length;
        const completed = b.items.filter((i) => i.status === 'completed').length;
        const failed = b.items.filter((i) => i.status === 'failed').length;
        const remaining = pending + processing;

        let status: 'pending' | 'processing' | 'completed' | 'partial_failed' | 'failed' = 'pending';
        if (processing > 0 || (pending > 0 && (completed > 0 || failed > 0))) {
          status = 'processing';
        } else if (remaining > 0) {
          status = 'pending';
        } else if (failed > 0 && completed > 0) {
          status = 'partial_failed';
        } else if (failed === total && total > 0) {
          status = 'failed';
        } else {
          status = 'completed';
        }

        return {
          batchId: b.batchId,
          organizationId: b.organizationId,
          organizationName: b.organizationName,
          status,
          counts: { total, pending, processing, completed, failed, remaining },
          supabaseSynced: b.supabaseSynced,
          supabaseWarning: b.supabaseWarning,
          dismissed: Boolean(b.dismissed),
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          items: b.items.map((it) => ({
            invoiceId: it.invoiceId,
            fileName: it.fileName,
            manualDocumentType: it.manualDocumentType,
            status: it.status,
            errorMessage: it.errorMessage,
            updatedAt: it.updatedAt,
            invoiceRecord: it.invoiceRecord,
          })),
        };
      });

    const exportJobs = this.state.exportJobs
      .filter((j) => !organizationId || j.organizationId === organizationId)
      .map((j) => ({
        jobId: j.jobId,
        batchId: j.batchId,
        organizationId: j.organizationId,
        organizationName: j.organizationName,
        fileName: j.fileName,
        status: j.status,
        exportedCount: j.exportedCount || 0,
        salesCount: j.salesCount || 0,
        purchasesCount: j.purchasesCount || 0,
        templateSha256: j.templateSha256,
        entries: j.entries || [],
        errorMessage: j.errorMessage,
        supabaseSynced: j.supabaseSynced,
        supabaseWarning: j.supabaseWarning,
        dismissed: Boolean(j.dismissed),
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      }));

    const activeAiCount = aiBatches.reduce((sum, b) => sum + b.counts.remaining, 0);
    const activeExportCount = exportJobs.filter(
      (j) => j.status === 'pending' || j.status === 'processing'
    ).length;

    return {
      aiBatches,
      exportJobs,
      activeAiCount,
      activeExportCount,
      hasActiveJobs: activeAiCount > 0 || activeExportCount > 0,
    };
  }
}

export const batchQueue = new ServerBatchQueueManager();
