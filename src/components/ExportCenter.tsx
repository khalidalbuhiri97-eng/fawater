import React, { useEffect, useState } from 'react';
import {
  Download,
  FileSpreadsheet,
  ShieldCheck,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  History,
  Layers,
} from 'lucide-react';
import { BackgroundExportJobSummary, ExportTrackingRecord, Operation } from '../types';
import {
  downloadSavedExportBatch,
  getOperationExportSummary,
} from '../services/excelService';
import {
  downloadBackgroundExportFile,
  enqueueBackgroundExcelExport,
  fetchBackgroundQueueStatus,
} from '../services/backgroundQueueClient';
import {
  checkForTemplateUpdate,
  getOfficialTemplate,
  LOCAL_OFFICIAL_TEMPLATE_PATH,
  StoredOfficialTemplate,
} from '../services/templateService';
import { getExportTracking } from '../services/dbService';
import { getTemplateVersionHistory, TemplateVersionHistoryItem } from '../services/localStore';

interface ExportCenterProps {
  operation: Operation;
  onBackgroundExportQueued?: (jobId: string) => void;
}

export const ExportCenter: React.FC<ExportCenterProps> = ({
  operation,
  onBackgroundExportQueued,
}) => {
  const [updating, setUpdating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadingBatchId, setDownloadingBatchId] = useState<string | null>(null);
  const [templateInfo, setTemplateInfo] = useState<StoredOfficialTemplate | null>(null);
  const [templateHistory, setTemplateHistory] = useState<TemplateVersionHistoryItem[]>([]);
  const [exportTracking, setExportTracking] = useState<ExportTrackingRecord | null>(null);
  const [activeOrgExportJob, setActiveOrgExportJob] = useState<BackgroundExportJobSummary | null>(null);
  const [exportMsg, setExportMsg] = useState<{ success: boolean; text: string } | null>(null);
  const [updateMsg, setUpdateMsg] = useState<{ success: boolean; text: string } | null>(null);

  const loadExportData = async () => {
    try {
      const [tpl, history, tracking, bgStatus] = await Promise.all([
        getOfficialTemplate().catch(() => null),
        getTemplateVersionHistory().catch(() => []),
        getExportTracking(operation.id).catch(() => null),
        fetchBackgroundQueueStatus(operation.id).catch(() => null),
      ]);
      if (tpl) setTemplateInfo(tpl);
      setTemplateHistory(history);
      setExportTracking(tracking);
      if (bgStatus?.exportJobs?.length) {
        const latest = bgStatus.exportJobs.find((j) => !j.dismissed) || bgStatus.exportJobs[0];
        setActiveOrgExportJob(latest || null);
      } else {
        setActiveOrgExportJob(null);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadExportData();
  }, [operation.id, operation.updatedAt, operation.invoices?.length]);

  useEffect(() => {
    if (
      !activeOrgExportJob ||
      (activeOrgExportJob.status !== 'pending' && activeOrgExportJob.status !== 'processing')
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      loadExportData();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeOrgExportJob?.jobId, activeOrgExportJob?.status, operation.id]);

  const summary = getOperationExportSummary(operation, exportTracking);
  const exportableCount = summary.newReadyInvoices.length + summary.modifiedReadyInvoices.length;

  const handleDownloadNewBatch = async () => {
    setDownloading(true);
    setExportMsg(null);
    try {
      const alreadyIds = summary.alreadyExportedUnchangedInvoices.map((i) => i.id);
      const queued = await enqueueBackgroundExcelExport({
        organization: operation,
        alreadyExportedIds: alreadyIds,
      });
      onBackgroundExportQueued?.(queued.jobId);
      await loadExportData();
      setExportMsg({
        success: true,
        text: `تم إرسال مهمة التصدير "${queued.fileName}" إلى طابور الخلفية بنجاح (مع قفل الحماية على مستوى المؤسسة). يمكنك متابعة العمل في أي صفحة أخرى وسيظهر الملف فور جاهزيته.`,
      });
    } catch (err: any) {
      setExportMsg({
        success: false,
        text: err?.message || 'فشل جدولة تصدير ملف Excel في الخلفية.',
      });
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadHistoryBatch = async (batchId: string, fileName: string) => {
    setDownloadingBatchId(batchId);
    setExportMsg(null);
    try {
      await downloadSavedExportBatch(batchId, fileName);
    } catch (err: any) {
      setExportMsg({
        success: false,
        text: err?.message || 'تعذر إعادة تنزيل الدفعة المختارة.',
      });
    } finally {
      setDownloadingBatchId(null);
    }
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    setUpdateMsg(null);
    try {
      const res = await checkForTemplateUpdate();
      setUpdateMsg({ success: res.success, text: res.message });
      const [latest, history] = await Promise.all([
        getOfficialTemplate().catch(() => null),
        getTemplateVersionHistory().catch(() => []),
      ]);
      if (latest) setTemplateInfo(latest);
      setTemplateHistory(history);
    } catch (err: any) {
      setUpdateMsg({ success: false, text: err?.message || 'حدث خطأ أثناء التحقق من التحديث' });
    } finally {
      setUpdating(false);
    }
  };

  const batches = exportTracking?.batches || [];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-xs p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-2xl flex items-center justify-center">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-900">تصدير ملف Excel الرسمي (XLSX)</h3>
            <p className="text-xs text-slate-500">
              تصدير تراكمي آمن يمنع تكرار الفواتير المصدّرة مسبقاً، مع حفظ سجل كل دفعة تصدير وربطه بقالب Fawater الرسمي.
            </p>
          </div>
        </div>

        {/* Summary counters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200">
            <span className="text-emerald-700 font-semibold block">فواتير جديدة جاهزة للتصدير</span>
            <span className="text-xl font-extrabold text-emerald-900">{summary.newReadyInvoices.length}</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-blue-50 border border-blue-200">
            <span className="text-blue-700 font-semibold block">فواتير معدّلة بعد التصدير</span>
            <span className="text-xl font-extrabold text-blue-900">{summary.modifiedReadyInvoices.length}</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
            <span className="text-slate-600 font-semibold block">مصدّرة مسبقاً (محمية من التكرار)</span>
            <span className="text-xl font-extrabold text-slate-800">
              {summary.alreadyExportedUnchangedInvoices.length}
            </span>
          </div>
          <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200">
            <span className="text-amber-700 font-semibold block">تحتاج مراجعة / تاريخ</span>
            <span className="text-xl font-extrabold text-amber-900">{summary.pendingInvoices.length}</span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-4 pt-1">
          <button
            onClick={handleDownloadNewBatch}
            disabled={
              downloading ||
              exportableCount === 0 ||
              activeOrgExportJob?.status === 'pending' ||
              activeOrgExportJob?.status === 'processing'
            }
            className="w-full sm:w-auto px-6 py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-2xl font-bold text-sm shadow-md transition flex items-center justify-center gap-2"
          >
            <Download className="w-5 h-5" />
            <span>
              {downloading
                ? 'جاري إرسال المهمة للخلفية...'
                : activeOrgExportJob?.status === 'pending' || activeOrgExportJob?.status === 'processing'
                ? 'جاري تجهيز ملف Excel في الخلفية...'
                : exportableCount === 0
                ? 'لا توجد فواتير جديدة للتصدير (الكل مصدّر)'
                : `بدء التصدير في الخلفية (${exportableCount} فاتورة)`}
            </span>
          </button>

          {activeOrgExportJob && activeOrgExportJob.status === 'completed' && (
            <button
              type="button"
              onClick={() =>
                downloadBackgroundExportFile(activeOrgExportJob.jobId, activeOrgExportJob.fileName)
              }
              className="w-full sm:w-auto px-5 py-3.5 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-bold text-sm shadow-md transition flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              <span>تنزيل آخر ملف جاهز ({activeOrgExportJob.fileName})</span>
            </button>
          )}
        </div>

        {activeOrgExportJob && (activeOrgExportJob.status === 'pending' || activeOrgExportJob.status === 'processing') && (
          <div className="p-3.5 rounded-xl text-xs font-medium bg-blue-50 text-blue-900 border border-blue-200 flex items-center justify-between gap-2">
            <span>
              جاري تنفيذ تصدير "{activeOrgExportJob.fileName}" في الخلفية (طابور مستقل مع قفل حماية المؤسسة)...
            </span>
          </div>
        )}

        {activeOrgExportJob && activeOrgExportJob.status === 'failed' && activeOrgExportJob.errorMessage && (
          <div className="p-3.5 rounded-xl text-xs font-medium bg-red-50 text-red-800 border border-red-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>فشل آخر تصدير في الخلفية: {activeOrgExportJob.errorMessage}</span>
          </div>
        )}

        {exportMsg && (
          <div
            className={`p-3.5 rounded-xl text-xs font-medium flex items-center gap-2 ${
              exportMsg.success
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {exportMsg.success ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            )}
            <span>{exportMsg.text}</span>
          </div>
        )}

        {/* Export Batches History */}
        <div className="border-t border-slate-200 pt-6 space-y-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-slate-700" />
            <h4 className="font-bold text-sm text-slate-800">سجل دفعات التصدير السابقة ({batches.length})</h4>
          </div>
          {batches.length === 0 ? (
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-500">
              لم يتم تصدير أي دفعة لهذه المؤسسة بعد.
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {batches.map((b) => (
                <div
                  key={b.id}
                  className="p-3.5 rounded-2xl border border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900">{b.fileName}</span>
                      <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                        {b.exportedCount} فاتورة ({b.salesCount} مبيعات / {b.purchasesCount} مشتريات)
                      </span>
                      {b.syncStatus && (
                        <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 text-[10px]">
                          {b.syncStatus === 'synced' ? 'متزامن' : b.syncStatus === 'failed' ? 'فشل مزامنة' : 'محلي / معلق'}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {new Date(b.exportedAt).toLocaleString('ar-SA')} • SHA-256: {b.templateSha256.slice(0, 14)}...
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={downloadingBatchId === b.id}
                    onClick={() => handleDownloadHistoryBatch(b.id, b.fileName)}
                    className="px-3.5 py-2 bg-white hover:bg-slate-100 border border-slate-300 rounded-xl font-bold text-slate-800 flex items-center gap-1.5 transition"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{downloadingBatchId === b.id ? 'جاري التنزيل...' : 'إعادة تنزيل'}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Template Update & Version History */}
        <div className="border-t border-slate-200 pt-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="font-bold text-sm text-slate-800">التحقق من تحديث قالب Excel الرسمي</h4>
              <p className="text-xs text-slate-500">
                فحص أحدث نسخة من {LOCAL_OFFICIAL_TEMPLATE_PATH} في مستودع GitHub والتحقق من البصمة الرقمية SHA-256
              </p>
            </div>
            <button
              onClick={handleCheckUpdate}
              disabled={updating}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              <RefreshCw className={`w-4 h-4 ${updating ? 'animate-spin' : ''}`} />
              <span>{updating ? 'جاري التحقق...' : 'التحقق من التحديث'}</span>
            </button>
          </div>

          {updateMsg && (
            <div
              className={`p-3 rounded-xl text-xs font-medium ${
                updateMsg.success
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {updateMsg.text}
            </div>
          )}

          {templateInfo && (
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-xs text-slate-700 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-slate-900">تفاصيل القالب النشط:</span>
                <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                  المصدر: {templateInfo.source === 'github' ? 'GitHub الرسمي' : 'النسخة المرفقة بالمشروع'}
                </span>
              </div>
              <div className="font-mono text-[11px] text-slate-500 break-all">
                SHA-256: {templateInfo.sha256}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {templateInfo.sheets.map((s) => (
                  <span
                    key={s.sheetName}
                    className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[11px] font-medium"
                  >
                    {s.sheetName} (بداية البيانات: صف {s.dataStartRowNumber})
                  </span>
                ))}
              </div>
            </div>
          )}

          {templateHistory.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                <Layers className="w-3.5 h-3.5" />
                <span>سجل إصدارات القالب المحفوظة ({templateHistory.length})</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {templateHistory.map((ver) => (
                  <div
                    key={ver.sha256}
                    className={`p-2.5 rounded-xl border text-[11px] flex items-center justify-between gap-2 ${
                      ver.isActive ? 'bg-emerald-50/70 border-emerald-200' : 'bg-white border-slate-200'
                    }`}
                  >
                    <div className="truncate">
                      <div className="font-bold text-slate-800">
                        {ver.version} ({ver.source === 'github' ? 'GitHub' : 'محلي'})
                      </div>
                      <div className="font-mono text-slate-500 truncate">{ver.sha256.slice(0, 20)}...</div>
                    </div>
                    {ver.isActive && (
                      <span className="px-2 py-0.5 bg-emerald-600 text-white rounded text-[10px] font-bold shrink-0">
                        نشط
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-600 space-y-1">
            <span className="font-bold text-slate-800 block">ضمان سلامة البيانات والتنسيق:</span>
            <p>
              يتم الإدراج في أوراق «المبيعات» و«المشتريات والموردين» بدءاً من أول صف فارغ متاح مع الإبقاء على الألوان، الخطوط، الحدود، الخلايا المدمجة، المعادلات، وأوراق القالب الأصلية دون تعديل.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
