import React, { useState, useEffect } from 'react';
import { Operation } from './types';
import {
  getOperations,
  saveOperation,
  deleteOperation,
  hydrateOperationImages,
} from './services/dbService';
import { downloadOperationExcel } from './services/excelService';
import { getOfficialTemplate } from './services/templateService';
import { Navbar } from './components/Navbar';
import { OperationsList } from './components/OperationsList';
import { NewOperationModal } from './components/NewOperationModal';
import { OperationDashboard } from './components/OperationDashboard';
import { ReviewWorkspace } from './components/ReviewWorkspace';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export default function App() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [currentView, setCurrentView] = useState<'home' | 'dashboard' | 'review'>('home');
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [activeInvoiceId, setActiveInvoiceId] = useState<string | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [banner, setBanner] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    try {
      const ops = getOperations();
      setOperations(ops);
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'تعذر تحميل البيانات المحلية' });
    }
    // Pre-validate official template on startup
    getOfficialTemplate().catch((err) => {
      console.error('Official template initialization error:', err);
    });
  }, []);

  const handleOperationCreated = (newOp: Operation) => {
    try {
      saveOperation(newOp);
      setOperations(getOperations());
      setActiveOperationId(newOp.id);
      setCurrentView('dashboard');
    } catch (err: any) {
      setBanner({ type: 'error', text: err?.message || 'فشل حفظ العملية الجديدة' });
    }
  };

  const handleUpdateOperation = (updatedOp: Operation) => {
    try {
      saveOperation(updatedOp);
      setOperations((prev) => {
        const exists = prev.some((o) => o.id === updatedOp.id);
        return exists
          ? prev.map((o) => (o.id === updatedOp.id ? updatedOp : o))
          : [updatedOp, ...prev];
      });
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

  const handleDeleteOperation = (id: string) => {
    deleteOperation(id);
    setOperations(getOperations());
    if (activeOperationId === id) {
      setActiveOperationId(null);
      setCurrentView('home');
    }
  };

  const activeOperation = operations.find((o) => o.id === activeOperationId);

  const handleDownloadActiveExcel = async () => {
    if (!activeOperation) return;
    setBanner(null);
    try {
      const result = await downloadOperationExcel(activeOperation);
      setBanner({
        type: 'success',
        text: `تم تصدير "${result.fileName}" بنجاح (${result.salesWritten} مبيعات، ${result.purchasesWritten} مشتريات).`,
      });
    } catch (err: any) {
      setBanner({
        type: 'error',
        text: err?.message || 'تعذر تصدير ملف Excel.',
      });
    }
  };

  return (
    <div
      className="min-h-screen bg-slate-100 text-slate-950 font-sans flex flex-col selection:bg-emerald-500 selection:text-white"
      dir="rtl"
    >
      <Navbar
        currentOperation={currentView !== 'home' ? activeOperation : undefined}
        onGoHome={() => {
          setCurrentView('home');
          setActiveOperationId(null);
        }}
        onOpenNewOperation={() => setIsNewModalOpen(true)}
        onDownloadExcel={handleDownloadActiveExcel}
      />

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

      <main className="flex-1">
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
      </main>

      <NewOperationModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onOperationCreated={handleOperationCreated}
      />
    </div>
  );
}
