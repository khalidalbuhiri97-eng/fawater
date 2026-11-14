import React, { useState, useEffect } from 'react';
import { Operation } from './types';
import { getOperations, saveOperation, deleteOperation, getWorkbookFromOperation } from './services/dbService';
import { downloadWorkbook } from './services/excelService';
import { Navbar } from './components/Navbar';
import { OperationsList } from './components/OperationsList';
import { NewOperationModal } from './components/NewOperationModal';
import { OperationDashboard } from './components/OperationDashboard';
import { ReviewWorkspace } from './components/ReviewWorkspace';

export default function App() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [currentView, setCurrentView] = useState<'home' | 'dashboard' | 'review'>('home');
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [activeInvoiceId, setActiveInvoiceId] = useState<string | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);

  useEffect(() => {
    const ops = getOperations();
    setOperations(ops);
  }, []);

  const handleOperationCreated = (newOp: Operation) => {
    saveOperation(newOp);
    const updatedOps = getOperations();
    setOperations(updatedOps);
    setActiveOperationId(newOp.id);
    setCurrentView('dashboard');
  };

  const handleUpdateOperation = (updatedOp: Operation) => {
    saveOperation(updatedOp);
    const updatedOps = getOperations();
    setOperations(updatedOps);
  };

  const handleDeleteOperation = (id: string) => {
    deleteOperation(id);
    const updatedOps = getOperations();
    setOperations(updatedOps);
    if (activeOperationId === id) {
      setActiveOperationId(null);
      setCurrentView('home');
    }
  };

  const activeOperation = operations.find(o => o.id === activeOperationId);

  const handleDownloadActiveExcel = () => {
    if (activeOperation) {
      const wb = getWorkbookFromOperation(activeOperation);
      downloadWorkbook(wb, activeOperation.excelFileName);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950 font-sans flex flex-col selection:bg-emerald-500 selection:text-white" dir="rtl">
      <Navbar
        currentOperation={currentView !== 'home' ? activeOperation : undefined}
        onGoHome={() => {
          setCurrentView('home');
          setActiveOperationId(null);
        }}
        onOpenNewOperation={() => setIsNewModalOpen(true)}
        onDownloadExcel={handleDownloadActiveExcel}
      />

      <main className="flex-1">
        {currentView === 'home' && (
          <OperationsList
            operations={operations}
            onSelectOperation={(op) => {
              setActiveOperationId(op.id);
              setCurrentView('dashboard');
            }}
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
