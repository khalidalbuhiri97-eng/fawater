import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BackgroundQueueStatus, Operation, SyncOverview } from './types';
import { authenticatedFetch } from './auth/supabaseClient';
import {
  initializeDatabase,
  getOperations,
  saveOperation,
  deleteOperationConfirmed,
  hydrateOperationImages,
  getExportTracking,
} from './services/dbService';
import { getOperationExportSummary } from './services/excelService';
import { getOfficialTemplate } from './services/templateService';
import { getSyncOverview, subscribeSyncStatus, syncAllPending } from './services/syncService';
import {
  dismissBackgroundJob,
  downloadBackgroundExportFile,
  enqueueBackgroundExcelExport,
  fetchBackgroundQueueStatus,
  mergeBackgroundResultsIntoLocalStore,
  retryBackgroundAiBatch,
} from './services/backgroundQueueClient';
import { Navbar } from './components/Navbar';
import { OperationsList } from './components/OperationsList';
import { NewOperationModal } from './components/NewOperationModal';
import { OperationDashboard } from './components/OperationDashboard';
import { ReviewWorkspace } from './components/ReviewWorkspace';
import { ImageProcessingDialog } from './components/ImageProcessingDialog';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';

export default function App() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [syncOverview, setSyncOverview] = useState<SyncOverview | undefined>(undefined);
  const [bgStatus, setBgStatus] = useState<BackgroundQueueStatus | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<{ geminiConfigured: boolean; supabase?: { connected: boolean; bucketsReady: boolean; error?: string; missingBuckets?: string[]; missingOrDeniedTables?: string[] } } | null>(null);
  const [retryingBatchId, setRetryingBatchId] = useState<string | null>(null);
  const [isProcessingDialogOpen, setIsProcessingDialogOpen] = useState(false);
  const [currentView, setCurrentView] = useState<'home' | 'dashboard' | 'review'>('home');
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [activeInvoiceId, setActiveInvoiceId] = useState<string | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [banner, setBanner] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const sessionExportJobsRef = useRef<Set<string>>(new Set());
  const autoDownloadedJobsRef = useRef<Set<string>>(new Set());
  const activeOpIdRef = useRef<string | null>(null);
  activeOpIdRef.current = activeOperationId;

  const pollBackgroundStatus = useCallback(async () => {
    const status = await fetchBackgroundQueueStatus();
    if (!status) return;
    setBgStatus(status);

    const changed = await mergeBackgroundResultsIntoLocalStore(status);
    if (changed) {
      let freshOps = await getOperations();
      if (activeOpIdRef.current) {
        const target = freshOps.find((o) => o.id === activeOpIdRef.current);
        if (target) {
          const hydrated = await hydrateOperationImages(target).catch(() => target);
          freshOps = freshOps.map((o) => (o.id === hydrated.id ? hydrated : o));
        }
      }
      setOperations(freshOps);
    }

    // Auto-download Excel files triggered by the user in this browser session once finished
    for (const job of status.exportJobs) {
      if (
        job.status === 'completed' &&
        sessionExportJobsRef.current.has(job.jobId) &&
        !autoDownloadedJobsRef.current.has(job.jobId)
      ) {
        autoDownloadedJobsRef.current.add(job.jobId);
        downloadBackgroundExportFile(job.jobId, job.fileName).catch(() => {});
        setBanner({
          type: 'success',
          text: `اكتمل تجهيز ملف Excel "${job.fileName}" في الخلفية (${job.exportedCount} فاتورة) وبدأ تنزيله.`,
        });
      }
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSyncStatus((overview) => {
      setSyncOverview(overview);
    });

    initializeDatabase()
      .then(async (ops) => {
        setOperations(ops);
        await pollBackgroundStatus();
      })
      .catch((err: any) => {
        setBanner({ type: 'error', text: err?.message || 'تعذر تحميل البيانات من IndexedDB' });
      })
      .finally(() => {
        setInitializing(false);
      });

    // Pre-validate official template on startup
    getOfficialTemplate().catch((err) => {
      console.error('Official template initialization error:', err);
    });

    return () => {
      unsubscribe();
    };
  }, [pollBackgroundStatus]);

  useEffect(() => {
    let mounted = true;
    const checkRuntimeHealth = async () => {
      try {
        const [healthResponse, supabaseResponse] = await Promise.all([
          fetch('/api/health', { cache: 'no-store' }),
          authenticatedFetch('/api/supabase/status', { cache: 'no-store' }),
        ]);
        const health = await healthResponse.json().catch(() => ({}));
        // The detailed Supabase diagnostics require a valid signed-in session.
        if (supabaseResponse.status === 401) {
          if (mounted) setRuntimeHealth(null);
          return;
        }
        const supabase = await supabaseResponse.json().catch(() => ({}));
        if (mounted) setRuntimeHealth({
          geminiConfigured: Boolean(health.geminiConfigured),
          supabase: {
            connected: Boolean(supabase.connected),
            bucketsReady: Boolean(supabase.bucketsReady),
            error: supabase.error,
            missingBuckets: supabase.missingBuckets || [],
            missingOrDeniedTables: supabase.missingOrDeniedTables || [],
          },
        });
      } catch (error: any) {
        if (error?.message?.includes('انتهت جلسة الدخول')) {
          if (mounted) setRuntimeHealth(null);
          return;
        }
        if (mounted) setRuntimeHealth({
          geminiConfigured: false,
          supabase: { connected: false, bucketsReady: false, error: 'تعذر الوصول إلى خادم التطبيق.' },
        });
      }
    };
    void checkRuntimeHealth();
    const interval = window.setInterval(() => void checkRuntimeHealth(), 300000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!bgStatus?.hasActiveJobs) return;
    const interval = window.setInterval(() => {
      void pollBackgroundStatus();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [bgStatus?.hasActiveJobs, pollBackgroundStatus]);

  const handleManualSync = async () => {
    const res = await syncAllPending();
    const overview = getSyncOverview();
    const freshOps = await getOperations();
    setOperations(freshOps);
    if (res.skipped && !overview.supabaseConnected) {
      setBanner({
        type: 'error',
        text: overview.lastError || 'تعذر الاتصال بـ Supabase — البيانات محفوظة بأمان محلياً في IndexedDB.',
      });
    } else if (res.failed > 0) {
      setBanner({
        type: 'error',
        text: `تمت مزامنة ${res.synced} عنصر وتعذر مزامنة ${res.failed} عنصر. تم حفظها بأمان محلياً لإعادة المحاولة.`,
      });
    } else if (res.synced > 0) {
      setBanner({
        type: 'success',
        text: `تمت مزامنة ${res.synced} سجل بنجاح مع قاعدة البيانات.`,
      });
    } else if (overview.supabaseConnected) {
      setBanner({
        type: 'success',
        text: 'تم فحص الاتصال: جميع البيانات متزامنة مع Supabase بنجاح.',
      });
    }
  };

  const handleOperationCreated = async (newOp: Operation) => {
    try {
      const saved = await saveOperation(newOp);
      setOperations(await getOperations());
      setActiveOperationId(saved.id);
      setCurrentView('dashboard');
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'فشل حفظ العملية الجديدة' });
    }
  };

  const handleUpdateOperation = async (updatedOp: Operation) => {
    try {
      // Optimistically update in-memory state immediately so UI remains responsive
      setOperations((prev) => {
        const exists = prev.some((o) => o.id === updatedOp.id);
        return exists
          ? prev.map((o) => (o.id === updatedOp.id ? updatedOp : o))
          : [updatedOp, ...prev];
      });
      await saveOperation(updatedOp);
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'فشل حفظ التعديلات' });
    }
  };

  const handleSelectOperation = async (op: Operation) => {
    setActiveOperationId(op.id);
    setCurrentView('dashboard');
    try {
      const hydrated = await hydrateOperationImages(op);
      setOperations((prev) => prev.map((o) => (o.id === hydrated.id ? hydrated : o)));
    } catch {
      // non-fatal hydration fallback
    }
  };

  const handleDeleteOperation = async (id: string) => {
    try {
      await deleteOperationConfirmed(id, true);
      setOperations(await getOperations());
      if (activeOperationId === id) {
        setActiveOperationId(null);
        setCurrentView('home');
      }
      await pollBackgroundStatus();
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر حذف العملية' });
    }
  };

  const activeOperation = operations.find((o) => o.id === activeOperationId);

  const handleDownloadActiveExcel = async () => {
    if (!activeOperation) return;
    setBanner(null);
    try {
      const tracking = await getExportTracking(activeOperation.id);
      const summary = getOperationExportSummary(activeOperation, tracking);
      if (summary.newReadyInvoices.length + summary.modifiedReadyInvoices.length === 0) {
        throw new Error(
          'لا توجد فواتير معتمدة ومؤرخة جديدة للتصدير حالياً (أو تم تصدير جميع الفواتير الجاهزة مسبقاً).'
        );
      }
      const alreadyIds = summary.alreadyExportedUnchangedInvoices.map((i) => i.id);
      const queued = await enqueueBackgroundExcelExport({
        organization: activeOperation,
        alreadyExportedIds: alreadyIds,
      });
      sessionExportJobsRef.current.add(queued.jobId);
      setBanner({
        type: 'success',
        text: `بدأت مهمة تصدير "${queued.fileName}" في الخلفية وسيتم تنزيل الملف تلقائياً فور انتهائه.`,
      });
      await pollBackgroundStatus();
    } catch (err: any) {
      setBanner({
        type: 'error',
        text: err?.message || 'تعذر بدء تصدير ملف Excel في الخلفية.',
      });
    }
  };

  const handleRetryBatch = async (batchId: string) => {
    setRetryingBatchId(batchId);
    try {
      await retryBackgroundAiBatch(batchId);
      await pollBackgroundStatus();
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر إعادة المحاولة.' });
    } finally {
      setRetryingBatchId(null);
    }
  };

  const handleDismissBackgroundJob = async (id: string) => {
    await dismissBackgroundJob(id);
    await pollBackgroundStatus();
  };

  const handleOpenBatchReview = async (organizationId: string, invoiceId?: string) => {
    const targetOp = operations.find((o) => o.id === organizationId);
    if (!targetOp) return;
    setActiveOperationId(targetOp.id);
    const hydrated = await hydrateOperationImages(targetOp).catch(() => targetOp);
    setOperations((prev) => prev.map((o) => (o.id === hydrated.id ? hydrated : o)));

    const firstId = invoiceId || hydrated.invoices?.[0]?.id;
    if (firstId) {
      setActiveInvoiceId(firstId);
      setCurrentView('review');
    } else {
      setCurrentView('dashboard');
    }
  };

  const visibleAiBatches = (bgStatus?.aiBatches || []).filter((b) => !b.dismissed);
  const visibleExportJobs = (bgStatus?.exportJobs || []).filter((j) => !j.dismissed);

  return (
    <div
      className="min-h-screen bg-slate-100 text-slate-950 font-sans flex flex-col selection:bg-emerald-500 selection:text-white"
      dir="rtl"
    >
      <Navbar
        currentOperation={currentView !== 'home' ? activeOperation : undefined}
        syncOverview={syncOverview}
        onManualSync={handleManualSync}
        onGoHome={() => {
          setCurrentView('home');
          setActiveOperationId(null);
        }}
        onOpenNewOperation={() => setIsNewModalOpen(true)}
        onDownloadExcel={handleDownloadActiveExcel}
        onOpenProcessingDialog={() => setIsProcessingDialogOpen(true)}
        hasActiveJobs={bgStatus?.hasActiveJobs}
      />

      {runtimeHealth && (!runtimeHealth.geminiConfigured || !runtimeHealth.supabase?.connected || !runtimeHealth.supabase?.bucketsReady) && (
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 pt-3">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-950 space-y-1.5">
            <div className="font-extrabold">يوجد إعداد ناقص في بيئة الخادم</div>
            {!runtimeHealth.geminiConfigured && <p>مفتاح Gemini غير مضبوط على الخادم؛ تحليل الذكاء الاصطناعي لن يعمل حتى ضبط GEMINI_API_KEY في أسرار الاستضافة.</p>}
            {!runtimeHealth.supabase?.connected && <p>اتصال Supabase الإداري غير جاهز؛ تحقق من SUPABASE_SERVICE_ROLE_KEY على الخادم. لا تستخدم المفتاح العام بدلاً منه. {runtimeHealth.supabase?.error || ''}</p>}
            {runtimeHealth.supabase?.connected && !runtimeHealth.supabase?.bucketsReady && <p>تخزين الصور أو ملفات Excel غير مكتمل: {(runtimeHealth.supabase.missingBuckets || []).join('، ')}.</p>}
          </div>
        </div>
      )}

      {banner && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 pt-4">
          <div
            className={`p-3.5 rounded-2xl border text-xs font-medium flex items-center justify-between gap-3 ${
              banner.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}
          >
            <div className="flex items-center gap-2">
              {banner.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              )}
              <span>{banner.text}</span>
            </div>
            <button onClick={() => setBanner(null)} className="p-1 hover:opacity-70">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Background Queues Progress Bar (persists across pages & reloads) */}
      {(visibleAiBatches.length > 0 || visibleExportJobs.length > 0) && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 pt-4 space-y-2.5">
          {visibleAiBatches.map((batch) => {
            const done = batch.counts.completed + batch.counts.failed;
            const pct = Math.round((done / Math.max(batch.counts.total, 1)) * 100);
            const isRunning = batch.counts.remaining > 0;
            const firstCompletedItem = batch.items.find((it) => it.status === 'completed');

            return (
              <div
                key={batch.batchId}
                className="bg-white rounded-2xl border border-slate-200 shadow-xs p-3.5 sm:p-4 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2.5">
                    {isRunning ? (
                      <Loader2 className="w-4 h-4 text-emerald-600 animate-spin shrink-0" />
                    ) : batch.counts.failed > 0 ? (
                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                    ) : (
                      <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                    )}
                    <span className="font-bold text-slate-900">
                      معالجة الخلفية ({batch.organizationName})
                    </span>
                    <span className="text-slate-600">
                      مكتملة: <strong className="text-emerald-700">{batch.counts.completed}</strong> •
                      متبقية: <strong className="text-blue-700">{batch.counts.remaining}</strong> •
                      فاشلة: <strong className="text-red-600">{batch.counts.failed}</strong> من{' '}
                      {batch.counts.total}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {firstCompletedItem && (
                      <button
                        type="button"
                        onClick={() =>
                          handleOpenBatchReview(batch.organizationId, firstCompletedItem.invoiceId)
                        }
                        className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-xl font-bold transition"
                      >
                        مراجعة المكتملة
                      </button>
                    )}
                    {batch.counts.failed > 0 && !isRunning && (
                      <button
                        type="button"
                        disabled={retryingBatchId === batch.batchId}
                        onClick={() => handleRetryBatch(batch.batchId)}
                        className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-xl font-bold flex items-center gap-1 transition disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${
                            retryingBatchId === batch.batchId ? 'animate-spin' : ''
                          }`}
                        />
                        <span>إعادة محاولة الفاشلة ({batch.counts.failed})</span>
                      </button>
                    )}
                    {!isRunning && (
                      <button
                        type="button"
                        onClick={() => handleDismissBackgroundJob(batch.batchId)}
                        className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
                        title="إخفاء"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      batch.counts.failed > 0 && !isRunning ? 'bg-amber-500' : 'bg-emerald-600'
                    }`}
                    style={{ width: `${Math.max(pct, isRunning ? 6 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}

          {visibleExportJobs.map((job) => {
            const isRunning = job.status === 'pending' || job.status === 'processing';
            return (
              <div
                key={job.jobId}
                className="bg-white rounded-2xl border border-slate-200 shadow-xs p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-center gap-2.5">
                  {isRunning ? (
                    <Loader2 className="w-4 h-4 text-emerald-600 animate-spin shrink-0" />
                  ) : job.status === 'failed' ? (
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                  ) : (
                    <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" />
                  )}
                  <span className="font-bold text-slate-900">
                    طابور تصدير Excel ({job.organizationName}):
                  </span>
                  <span className="text-slate-600">
                    {isRunning
                      ? `جاري تجهيز "${job.fileName}" في الخلفية...`
                      : job.status === 'completed'
                      ? `اكتمل "${job.fileName}" (${job.exportedCount} فاتورة)`
                      : job.errorMessage || 'تعذر إتمام التصدير'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {job.status === 'completed' && (
                    <button
                      type="button"
                      onClick={() => downloadBackgroundExportFile(job.jobId, job.fileName)}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold flex items-center gap-1.5 transition"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>تنزيل Excel</span>
                    </button>
                  )}
                  {!isRunning && (
                    <button
                      type="button"
                      onClick={() => handleDismissBackgroundJob(job.jobId)}
                      className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
                      title="إخفاء"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <main className="flex-1">
        {initializing ? (
          <div className="max-w-7xl mx-auto px-4 py-20 text-center space-y-3">
            <Loader2 className="w-10 h-10 text-emerald-600 animate-spin mx-auto" />
            <p className="text-sm font-semibold text-slate-600">
              جاري تهيئة قاعدة البيانات المحلية (IndexedDB) والتحقق من المزامنة...
            </p>
          </div>
        ) : (
          <>
            {currentView === 'home' && (
              <OperationsList
                operations={operations}
                onSelectOperation={handleSelectOperation}
                onOpenNewModal={() => setIsNewModalOpen(true)}
                onDeleteOperation={handleDeleteOperation}
                onUpdateOperation={handleUpdateOperation}
              />
            )}

            {currentView === 'dashboard' && activeOperation && (
              <OperationDashboard
                operation={activeOperation}
                onUpdateOperation={handleUpdateOperation}
                onStartReview={(invId) => {
                  setActiveInvoiceId(invId);
                  setCurrentView('review');
                }}
                onBackgroundJobQueued={() => {
                  void pollBackgroundStatus();
                }}
              />
            )}

            {currentView === 'review' && activeOperation && activeInvoiceId && (
              <ReviewWorkspace
                operation={activeOperation}
                activeInvoiceId={activeInvoiceId}
                onUpdateOperation={handleUpdateOperation}
                onBackToDashboard={() => setCurrentView('dashboard')}
                onSelectInvoice={(invId) => setActiveInvoiceId(invId)}
              />
            )}
          </>
        )}
      </main>

      <NewOperationModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onOperationCreated={handleOperationCreated}
      />

      <ImageProcessingDialog
        isOpen={isProcessingDialogOpen}
        onClose={() => setIsProcessingDialogOpen(false)}
        bgStatus={bgStatus}
        onRetryBatch={handleRetryBatch}
        onDismissJob={handleDismissBackgroundJob}
        onOpenReview={(orgId, invId) => {
          setIsProcessingDialogOpen(false);
          void handleOpenBatchReview(orgId, invId);
        }}
      />
    </div>
  );
}
