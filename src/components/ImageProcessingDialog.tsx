import React from 'react';
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  X,
  FileText,
  ArrowLeft,
} from 'lucide-react';
import { BackgroundQueueStatus } from '../types';

interface ImageProcessingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  bgStatus: BackgroundQueueStatus | null;
  onRetryBatch: (batchId: string) => void;
  onDismissJob: (id: string) => void;
  onOpenReview: (orgId: string, invoiceId?: string) => void;
}

export const ImageProcessingDialog: React.FC<ImageProcessingDialogProps> = ({
  isOpen,
  onClose,
  bgStatus,
  onRetryBatch,
  onDismissJob,
  onOpenReview,
}) => {
  if (!isOpen) return null;

  const aiBatches = (bgStatus?.aiBatches || []).filter((b) => !b.dismissed);
  const exportJobs = (bgStatus?.exportJobs || []).filter((j) => !j.dismissed);
  const hasActive = (bgStatus?.hasActiveJobs) || aiBatches.length > 0 || exportJobs.length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-slate-200 animate-in fade-in zoom-in duration-200 my-auto">
        {/* Header */}
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="font-bold text-base sm:text-lg">حالة معالجة الفواتير بالذكاء الاصطناعي</h3>
              <p className="text-[11px] text-slate-400">
                المعالجة تعمل في الخلفية — يمكنك إغلاق النافذة أو مغادرة الصفحة في أي وقت
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition p-1.5 rounded-xl hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6 overflow-y-auto flex-1 bg-slate-50/50">
          {!hasActive ? (
            <div className="py-16 text-center space-y-3">
              <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h4 className="font-bold text-slate-900 text-base">لا توجد مهام معالجة نشطة حالياً</h4>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                تم اكتمال جميع عمليات استخراج وتصدير الفواتير بنجاح.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition"
              >
                إغلاق النافذة
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {aiBatches.map((batch) => {
                const total = batch.counts.total;
                const completed = batch.counts.completed;
                const failed = batch.counts.failed;
                const remaining = batch.counts.remaining;
                const done = completed + failed;
                const pct = Math.round((done / Math.max(total, 1)) * 100);
                const isRunning = remaining > 0;
                const firstCompleted = batch.items.find((it) => it.status === 'completed');

                return (
                  <div
                    key={batch.batchId}
                    className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                          {batch.organizationName}
                        </span>
                        <h4 className="font-bold text-slate-900 text-sm mt-1">دفعة استخراج فواتير</h4>
                      </div>
                      <div className="flex items-center gap-2">
                        {isRunning ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 text-blue-800 rounded-full text-xs font-bold border border-blue-200">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />
                            <span>قيد المعالجة في الخلفية</span>
                          </span>
                        ) : failed > 0 ? (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 text-amber-800 rounded-full text-xs font-bold border border-amber-200">
                            <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                            <span>انتهت مع أخطاء جزئية</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-800 rounded-full text-xs font-bold border border-emerald-200">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            <span>اكتملت بنجاح</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar & Counters */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
                        <span>نسبة الإنجاز الإجمالية</span>
                        <span className="font-mono font-bold text-slate-900">{pct}%</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden p-0.5 border border-slate-200">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            failed > 0 && !isRunning ? 'bg-amber-500' : 'bg-emerald-600'
                          }`}
                          style={{ width: `${Math.max(pct, isRunning ? 5 : 0)}%` }}
                        />
                      </div>
                      <div className="grid grid-cols-4 gap-2 pt-1 text-center text-xs">
                        <div className="p-2 rounded-xl bg-slate-50 border border-slate-200">
                          <span className="text-slate-500 block text-[10px]">الإجمالي</span>
                          <span className="font-extrabold text-slate-900">{total}</span>
                        </div>
                        <div className="p-2 rounded-xl bg-emerald-50 border border-emerald-200">
                          <span className="text-emerald-700 block text-[10px]">مكتملة</span>
                          <span className="font-extrabold text-emerald-900">{completed}</span>
                        </div>
                        <div className="p-2 rounded-xl bg-blue-50 border border-blue-200">
                          <span className="text-blue-700 block text-[10px]">قيد التنفيذ</span>
                          <span className="font-extrabold text-blue-900">{remaining}</span>
                        </div>
                        <div className="p-2 rounded-xl bg-red-50 border border-red-200">
                          <span className="text-red-700 block text-[10px]">فاشلة</span>
                          <span className="font-extrabold text-red-900">{failed}</span>
                        </div>
                      </div>
                    </div>

                    {/* Processing Stages Checklist */}
                    <div className="pt-2 border-t border-slate-100 space-y-2.5">
                      <div className="text-xs font-bold text-slate-700">مراحل المعالجة الحالية:</div>
                      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 text-center text-[11px]">
                        <div className="p-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 flex flex-col items-center gap-1">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          <span className="font-bold">1. رفع الصور</span>
                        </div>
                        <div
                          className={`p-2 rounded-xl border flex flex-col items-center gap-1 ${
                            completed > 0 || !isRunning
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                              : isRunning
                              ? 'bg-blue-50 border-blue-200 text-blue-900 animate-pulse'
                              : 'bg-slate-50 border-slate-200 text-slate-500'
                          }`}
                        >
                          {completed > 0 || !isRunning ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                          )}
                          <span className="font-bold">2. تحليل AI</span>
                        </div>
                        <div
                          className={`p-2 rounded-xl border flex flex-col items-center gap-1 ${
                            completed > 0
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                              : isRunning
                              ? 'bg-blue-50 border-blue-200 text-blue-900 animate-pulse'
                              : 'bg-slate-50 border-slate-200 text-slate-500'
                          }`}
                        >
                          {completed > 0 ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                          )}
                          <span className="font-bold">3. استخراج البيانات</span>
                        </div>
                        <div
                          className={`p-2 rounded-xl border flex flex-col items-center gap-1 ${
                            completed > 0
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                              : 'bg-slate-50 border-slate-200 text-slate-500'
                          }`}
                        >
                          {completed > 0 ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <div className="w-4 h-4 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-[9px] font-bold">
                              4
                            </div>
                          )}
                          <span className="font-bold">4. التحقق</span>
                        </div>
                        <div
                          className={`p-2 rounded-xl border flex flex-col items-center gap-1 ${
                            completed > 0
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                              : 'bg-slate-50 border-slate-200 text-slate-500'
                          }`}
                        >
                          {completed > 0 ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <div className="w-4 h-4 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-[9px] font-bold">
                              5
                            </div>
                          )}
                          <span className="font-bold">5. الحفظ والتصدير</span>
                        </div>
                      </div>
                    </div>

                    {/* Items List Details */}
                    <div className="max-h-40 overflow-y-auto space-y-1.5 pt-2">
                      {batch.items.map((item, idx) => (
                        <div
                          key={idx}
                          className="p-2.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                            <span className="font-medium text-slate-800 truncate">{item.fileName}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                item.status === 'completed'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : item.status === 'failed'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-blue-100 text-blue-800 animate-pulse'
                              }`}
                            >
                              {item.status === 'completed'
                                ? 'مكتملة'
                                : item.status === 'failed'
                                ? 'فشل المعالجة'
                                : 'قيد المعالجة'}
                            </span>
                            {item.status === 'completed' && (
                              <button
                                type="button"
                                onClick={() => {
                                  onClose();
                                  onOpenReview(batch.organizationId, item.invoiceId);
                                }}
                                className="px-2.5 py-1 bg-emerald-600 text-white rounded-lg text-[10px] font-bold hover:bg-emerald-500 transition"
                              >
                                مراجعة
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
                      {failed > 0 && !isRunning && (
                        <button
                          type="button"
                          onClick={() => onRetryBatch(batch.batchId)}
                          className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>إعادة محاولة الفاشلة ({failed})</span>
                        </button>
                      )}
                      {firstCompleted && (
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onOpenReview(batch.organizationId, firstCompleted.invoiceId);
                          }}
                          className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition"
                        >
                          <span>الانتقال لشاشة المراجعة</span>
                          <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!isRunning && (
                        <button
                          type="button"
                          onClick={() => onDismissJob(batch.batchId)}
                          className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
                        >
                          إخفاء المهمة
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-100 border-t border-slate-200 flex items-center justify-between shrink-0">
          <span className="text-xs text-slate-500">
            النظام يحفظ كافة النتائج تلقائياً في قاعدة البيانات المحلية ويدعم المزامنة المستمرة.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition"
          >
            إخفاء النافذة
          </button>
        </div>
      </div>
    </div>
  );
};
