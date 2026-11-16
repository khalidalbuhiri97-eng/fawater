import React, { useEffect, useState } from 'react';
import {
  X,
  Upload,
  Sparkles,
  PenLine,
  AlertCircle,
  CheckCircle2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Save,
  Image as ImageIcon,
  Trash2,
} from 'lucide-react';
import { InvoiceRecord, Operation } from '../types';
import { saveInvoiceImage } from '../services/dbService';
import { generateUuid } from '../services/localStore';
import { enqueueAiBackgroundBatch } from '../services/backgroundQueueClient';
import {
  getOfficialTemplate,
  getSheetSchemaByType,
  TemplateSheetInfo,
} from '../services/templateService';
import { DynamicTemplateFields } from './DynamicTemplateFields';

interface BatchUploadModalProps {
  isOpen: boolean;
  initialMode?: 'ai' | 'manual';
  onClose: () => void;
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
  onStartReview: (invoiceId: string) => void;
  onBackgroundBatchQueued?: (batchId: string) => void;
}

function createEmptyManualInvoice(docType: 'مبيعات' | 'مشتريات'): InvoiceRecord {
  const nowIso = new Date().toISOString();
  return {
    id: generateUuid(),
    invoiceNumber: '',
    invoiceDate: '', // Never auto-fill today's date
    documentType: docType,
    entryMethod: 'manual',
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
    extraColumnsData: {},
    status: 'تحتاج مراجعة',
    createdAt: nowIso.split('T')[0],
    updatedAt: nowIso,
  };
}

type AiClassificationChoice = 'auto' | 'مبيعات' | 'مشتريات';

export const BatchUploadModal: React.FC<BatchUploadModalProps> = ({
  isOpen,
  initialMode = 'ai',
  onClose,
  operation,
  onUpdateOperation,
  onBackgroundBatchQueued,
}) => {
  const [mode, setMode] = useState<'ai' | 'manual'>(initialMode);
  const [templateSheets, setTemplateSheets] = useState<TemplateSheetInfo[]>([]);
  const [templateError, setTemplateError] = useState('');

  // AI mode state
  const [aiDefaultClassification, setAiDefaultClassification] = useState<AiClassificationChoice>('auto');
  const [selectedFiles, setSelectedFiles] = useState<
    { file: File; base64: string; mimeType: string; classification: AiClassificationChoice }[]
  >([]);
  const [extracting, setExtracting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadProgressLabel, setUploadProgressLabel] = useState('تهيئة الملفات للرفع...');

  // Manual mode state (persists across preview/field edits and type toggles)
  const [manualType, setManualType] = useState<'مبيعات' | 'مشتريات'>('مبيعات');
  const [manualInvoice, setManualInvoice] = useState<InvoiceRecord>(() => createEmptyManualInvoice('مبيعات'));
  const [manualImage, setManualImage] = useState<{ fileName: string; base64: string; mimeType: string } | null>(null);
  const [manualZoom, setManualZoom] = useState(1);
  const [savingManual, setSavingManual] = useState(false);
  const [manualSuccessMsg, setManualSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setErrorMsg('');
      setManualSuccessMsg('');
      getOfficialTemplate()
        .then((tpl) => {
          setTemplateSheets(tpl.sheets);
          setTemplateError('');
        })
        .catch((err) => {
          setTemplateError(err?.message || 'تعذر قراءة أعمدة قالب Excel الرسمي.');
        });
    }
  }, [isOpen, initialMode]);

  if (!isOpen) return null;

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const res = reader.result as string;
        const base64Data = res.split(',')[1] || res;
        resolve(base64Data);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // --- Manual Mode Handlers (NEVER calls Gemini) ---
  const handleManualImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    try {
      const base64 = await fileToBase64(file);
      setManualImage({
        fileName: file.name,
        base64,
        mimeType: file.type || 'image/jpeg',
      });
      setManualZoom(1);
    } catch {
      setErrorMsg('تعذر قراءة ملف الصورة المختار.');
    }
  };

  const handleManualTypeSwitch = (nextType: 'مبيعات' | 'مشتريات') => {
    setManualType(nextType);
    setManualInvoice((prev) => ({
      ...prev,
      documentType: nextType,
    }));
    setErrorMsg('');
    setManualSuccessMsg('');
  };

  const handleSaveManualInvoice = async () => {
    setErrorMsg('');
    setManualSuccessMsg('');

    const hasDate = Boolean(manualInvoice.invoiceDate && manualInvoice.invoiceDate.trim());

    if (manualType === 'مبيعات') {
      const hasAnyValue =
        manualInvoice.cashSales !== undefined ||
        manualInvoice.networkSales !== undefined ||
        manualInvoice.cashBalance !== undefined ||
        manualInvoice.cashBoxBalance !== undefined ||
        manualInvoice.networkBalance !== undefined;
      if (!hasAnyValue) {
        setErrorMsg('يرجى إدخال قيمة المبيعات النقدية (الكاش) أو الشبكة أو أحد حقول المبيعات.');
        return;
      }
    } else {
      const hasAnyPurchase =
        Boolean(manualInvoice.issuerName?.trim()) ||
        manualInvoice.subtotal !== undefined ||
        manualInvoice.taxAmount !== undefined ||
        manualInvoice.balance !== undefined;
      if (!hasAnyPurchase) {
        setErrorMsg('يرجى إدخال اسم المورد أو المبالغ في حقول المشتريات.');
        return;
      }
    }

    setSavingManual(true);
    try {
      const nowIso = new Date().toISOString();
      const newId = manualInvoice.id || generateUuid();

      if (manualImage?.base64) {
        await saveInvoiceImage(newId, manualImage.base64, manualImage.mimeType, {
          organizationId: operation.id,
          fileName: manualImage.fileName,
          enqueueSync: true,
        });
      }

      const nextStatus = hasDate ? 'مكتملة' : 'تحتاج مراجعة';
      const recordToSave: InvoiceRecord = {
        ...manualInvoice,
        id: newId,
        organizationId: operation.id,
        documentType: manualType,
        entryMethod: 'manual',
        status: nextStatus,
        hasImage: Boolean(manualImage?.base64),
        imageBase64: manualImage?.base64,
        imageMimeType: manualImage?.mimeType,
        imageFileName: manualImage?.fileName,
        syncStatus: 'pending',
        updatedAt: nowIso,
      };

      const updatedInvoices = [recordToSave, ...(operation.invoices || [])];
      onUpdateOperation({
        ...operation,
        invoices: updatedInvoices,
        updatedAt: nowIso,
      });

      if (hasDate) {
        setManualSuccessMsg(
          'تم حفظ الفاتورة يدوياً وتجهيزها للتصدير إلى ورقة "' +
            (manualType === 'مبيعات' ? 'المبيعات' : 'المشتريات والموردين') +
            '" في Excel بنجاح.'
        );
      } else {
        setManualSuccessMsg(
          'تم حفظ الفاتورة بحالة «تحتاج مراجعة» لعدم إدخال التاريخ — لن يتم تصديرها إلى Excel حتى إدخال التاريخ واعتمادها.'
        );
      }
      // Reset for next manual entry cleanly
      setManualInvoice(createEmptyManualInvoice(manualType));
      setManualImage(null);
      setManualZoom(1);
    } catch (err: any) {
      setErrorMsg(err?.message || 'حدث خطأ أثناء حفظ الفاتورة.');
    } finally {
      setSavingManual(false);
    }
  };

  // --- AI Mode Handlers ---
  const handleBatchClassificationChange = (choice: AiClassificationChoice) => {
    setAiDefaultClassification(choice);
    setSelectedFiles((prev) => prev.map((f) => ({ ...f, classification: choice })));
  };

  const handleSingleFileClassificationChange = (index: number, choice: AiClassificationChoice) => {
    setSelectedFiles((prev) =>
      prev.map((f, idx) => (idx === index ? { ...f, classification: choice } : f))
    );
  };

  const handleRemoveSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleAiFilesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files);
    setErrorMsg('');

    const newItems: { file: File; base64: string; mimeType: string; classification: AiClassificationChoice }[] = [];
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file);
        newItems.push({
          file,
          base64,
          mimeType: file.type || 'image/jpeg',
          classification: aiDefaultClassification,
        });
      } catch (err) {
        console.error('Error reading file:', err);
        setErrorMsg('تعذر قراءة أحد الملفات المختارة.');
      }
    }
    setSelectedFiles((prev) => [...prev, ...newItems]);
  };

  const handleStartAiExtraction = async () => {
    if (selectedFiles.length === 0) return;

    setExtracting(true);
    setUploadProgress(3);
    setUploadProgressLabel('تهيئة الفواتير ورفعها بأمان...');
    setErrorMsg('');

    try {
      const preparedFiles: Array<{
        invoiceId: string;
        imageBase64: string;
        mimeType: string;
        fileName: string;
        fileSize: number;
        manualDocumentType: 'auto' | 'مبيعات' | 'مشتريات';
      }> = [];

      for (const [index, item] of selectedFiles.entries()) {
        const invId = generateUuid();
        try {
          await saveInvoiceImage(invId, item.base64, item.mimeType, {
            organizationId: operation.id,
            fileName: item.file.name,
            fileSize: item.file.size,
            enqueueSync: false,
          });
        } catch (err) {
          console.error('IndexedDB save image error:', err);
        }

        preparedFiles.push({
          invoiceId: invId,
          imageBase64: item.base64,
          mimeType: item.mimeType,
          fileName: item.file.name,
          fileSize: item.file.size,
          manualDocumentType: item.classification,
        });
        setUploadProgress(Math.min(85, Math.round(5 + ((index + 1) / selectedFiles.length) * 80)));
        setUploadProgressLabel(`تم تجهيز ${index + 1} من ${selectedFiles.length} فاتورة`);
      }

      setUploadProgress(92);
      setUploadProgressLabel('جدولة الفواتير للمعالجة في الخلفية...');
      const queued = await enqueueAiBackgroundBatch({
        organization: operation,
        files: preparedFiles,
      });
      setUploadProgress(100);
      setUploadProgressLabel('اكتمل الرفع والجدولة بنجاح');

      const nowIso = new Date().toISOString();
      onUpdateOperation({
        ...operation,
        invoices: [...queued.initialInvoices, ...(operation.invoices || [])],
        updatedAt: nowIso,
      });

      setSelectedFiles([]);
      onBackgroundBatchQueued?.(queued.batchId);
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'تعذر بدء المعالجة في الخلفية.');
    } finally {
      setExtracting(false);
      setUploadProgress(0);
      setUploadProgressLabel('تهيئة الملفات للرفع...');
    }
  };

  const activeManualSheet = getSheetSchemaByType(templateSheets, manualType);

  return (
    <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl max-w-4xl w-full max-h-[94vh] flex flex-col overflow-hidden border border-slate-200 animate-in fade-in zoom-in duration-200 my-auto">
        {/* Header */}
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            {mode === 'ai' ? (
              <Sparkles className="w-5 h-5 text-emerald-400" />
            ) : (
              <PenLine className="w-5 h-5 text-emerald-400" />
            )}
            <h3 className="font-bold text-base sm:text-lg">
              {mode === 'ai' ? 'استخراج الفواتير بالذكاء الاصطناعي' : 'الإدخال اليدوي المباشر وفق قالب Excel'}
            </h3>
          </div>
          <button
            onClick={onClose}
            disabled={extracting || savingManual}
            className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switcher */}
        {!extracting && (
          <div className="px-6 pt-3 pb-2 bg-slate-50 border-b border-slate-200 shrink-0">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode('manual');
                  setErrorMsg('');
                }}
                className={`p-2 sm:p-2.5 rounded-xl border text-right transition flex items-center gap-2 ${
                  mode === 'manual'
                    ? 'border-slate-900 bg-white text-slate-950 ring-2 ring-slate-900/15 shadow-xs'
                    : 'border-slate-200 bg-slate-100/70 text-slate-600 hover:bg-white'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    mode === 'manual' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  <PenLine className="w-3.5 h-3.5" />
                </div>
                <div>
                  <div className="font-bold text-[11px] sm:text-xs">الوضع الأول: الإدخال اليدوي</div>
                  <div className="text-[10px] text-slate-500 leading-snug">معاينة الصورة وأعمدة Excel (بدون Gemini)</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode('ai');
                  setErrorMsg('');
                  setManualSuccessMsg('');
                }}
                className={`p-2 sm:p-2.5 rounded-xl border text-right transition flex items-center gap-2 ${
                  mode === 'ai'
                    ? 'border-emerald-600 bg-white text-emerald-950 ring-2 ring-emerald-500/20 shadow-xs'
                    : 'border-slate-200 bg-slate-100/70 text-slate-600 hover:bg-white'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    mode === 'ai' ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[11px] sm:text-xs">الوضع الثاني: الذكاء الاصطناعي</div>
                  <div className="text-[10px] text-slate-500 leading-snug">قراءة الصورة وتصنيفها تلقائياً</div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {templateError && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{templateError}</span>
            </div>
          )}

          {errorMsg && (
            <div className="p-3.5 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {manualSuccessMsg && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl text-xs font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{manualSuccessMsg}</span>
            </div>
          )}

          {mode === 'manual' ? (
            /* ==================== MANUAL MODE ==================== */
            <div className="space-y-5">
              {/* 1. Preview Area ON TOP (always visible when uploaded, never disappears while filling fields) */}
              <div className="rounded-2xl border border-slate-200 overflow-hidden bg-slate-950">
                <div className="bg-slate-900 text-white px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <ImageIcon className="w-4 h-4 text-emerald-400" />
                    <span className="font-bold truncate max-w-[240px]">
                      {manualImage ? manualImage.fileName : 'معاينة صورة الفاتورة (اختيارية في الإدخال اليدوي)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {manualImage && (
                      <>
                        <button
                          type="button"
                          onClick={() => setManualZoom((z) => Math.min(z + 0.25, 3))}
                          className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                          title="تكبير"
                        >
                          <ZoomIn className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualZoom((z) => Math.max(z - 0.25, 0.5))}
                          className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                          title="تصغير"
                        >
                          <ZoomOut className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualZoom(1)}
                          className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                          title="إعادة ضبط"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualImage(null)}
                          className="p-1.5 hover:bg-red-900/60 rounded-lg text-red-300 transition"
                          title="إزالة الصورة"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                    <input
                      type="file"
                      accept="image/jpeg, image/png, image/webp, application/pdf"
                      onChange={handleManualImageSelect}
                      className="hidden"
                      id="manualImageUpload"
                    />
                    <label
                      htmlFor="manualImageUpload"
                      className="cursor-pointer px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition"
                    >
                      {manualImage ? 'تغيير الصورة' : 'إرفاق صورة فاتورة'}
                    </label>
                  </div>
                </div>

                {manualImage ? (
                  <div className="p-3 flex items-center justify-center min-h-[240px] max-h-[360px] overflow-auto">
                    {manualImage.mimeType === 'application/pdf' ? (
                      <embed
                        src={`data:application/pdf;base64,${manualImage.base64}`}
                        type="application/pdf"
                        className="w-full h-[320px] rounded-lg"
                      />
                    ) : (
                      <img
                        src={`data:${manualImage.mimeType};base64,${manualImage.base64}`}
                        alt="معاينة الفاتورة"
                        style={{ transform: `scale(${manualZoom})`, transition: 'transform 0.2s ease' }}
                        className="max-h-[320px] object-contain rounded-lg"
                      />
                    )}
                  </div>
                ) : (
                  <label
                    htmlFor="manualImageUpload"
                    className="cursor-pointer py-8 px-4 flex flex-col items-center justify-center text-center text-slate-400 hover:text-slate-200 transition"
                  >
                    <Upload className="w-7 h-7 mb-2 text-emerald-400" />
                    <span className="text-xs font-semibold">انقر لرفع صورة الفاتورة لمعاينتها أثناء الكتابة</span>
                    <span className="text-[11px] text-slate-500 mt-1">يمكنك أيضاً الحفظ بدون صورة في الإدخال اليدوي</span>
                  </label>
                )}
              </div>

              {/* 2. Operation Type Selector (Sales vs Purchases) */}
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-2">
                  اختر نوع الورقة في قالب Excel (تُقرأ الحقول مباشرة من القالب الرسمي):
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => handleManualTypeSwitch('مبيعات')}
                    className={`p-3 rounded-2xl border font-bold text-xs sm:text-sm transition ${
                      manualType === 'مبيعات'
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    ورقة المبيعات (جميع الأعمدة)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleManualTypeSwitch('مشتريات')}
                    className={`p-3 rounded-2xl border font-bold text-xs sm:text-sm transition ${
                      manualType === 'مشتريات'
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    ورقة المشتريات والموردين (جميع الأعمدة)
                  </button>
                </div>
              </div>

              {/* 3. ALL Excel Columns BELOW Image Preview */}
              <div className="p-4 sm:p-5 rounded-2xl border border-slate-200 bg-slate-50/70 space-y-4">
                {activeManualSheet ? (
                  <DynamicTemplateFields
                    sheetInfo={activeManualSheet}
                    invoice={manualInvoice}
                    onUpdateInvoice={setManualInvoice}
                  />
                ) : (
                  <div className="text-xs text-slate-500 py-4 text-center">جاري قراءة أعمدة قالب Excel...</div>
                )}

                {/* Optional metadata (invoice number & notes) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-200">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">رقم الفاتورة (اختياري)</label>
                    <input
                      type="text"
                      value={manualInvoice.invoiceNumber}
                      onChange={(e) => setManualInvoice((p) => ({ ...p, invoiceNumber: e.target.value }))}
                      placeholder="اختياري للسجل الداخلي"
                      className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-xs bg-white text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">ملاحظات (اختياري)</label>
                    <input
                      type="text"
                      value={manualInvoice.notes}
                      onChange={(e) => setManualInvoice((p) => ({ ...p, notes: e.target.value }))}
                      placeholder="أي ملاحظات إضافية"
                      className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-xs bg-white text-slate-900"
                    />
                  </div>
                </div>

                {(operation.customFields || []).length > 0 && (
                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <div className="text-xs font-bold text-slate-700">الحقول المخصصة للمؤسسة</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {operation.customFields.map((cf) => (
                        <div key={cf.id}>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            {cf.name} {cf.required && <span className="text-red-500">*</span>}
                          </label>
                          {cf.type === 'قائمة خيارات' && cf.options?.length ? (
                            <select
                              value={manualInvoice.customFieldsValues?.[cf.id] ?? manualInvoice.customFieldsValues?.[cf.name] ?? ''}
                              onChange={(e) =>
                                setManualInvoice((p) => ({
                                  ...p,
                                  customFieldsValues: { ...p.customFieldsValues, [cf.id]: e.target.value },
                                }))
                              }
                              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white text-slate-900"
                            >
                              <option value="">اختر...</option>
                              {cf.options.map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={cf.type === 'تاريخ' ? 'date' : cf.type === 'رقم' || cf.type === 'مبلغ' || cf.type === 'نسبة' ? 'number' : 'text'}
                              value={manualInvoice.customFieldsValues?.[cf.id] ?? manualInvoice.customFieldsValues?.[cf.name] ?? ''}
                              onChange={(e) =>
                                setManualInvoice((p) => ({
                                  ...p,
                                  customFieldsValues: { ...p.customFieldsValues, [cf.id]: e.target.value },
                                }))
                              }
                              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white text-slate-900"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : extracting ? (
            /* ==================== AI QUEUING ==================== */
            <div className="mx-auto flex min-h-[220px] max-w-xl flex-col justify-center px-2 py-8 text-center space-y-4">
              <div className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-700">
                <span>جاري رفع الفواتير وجدولتها</span>
                <span className="tabular-nums text-emerald-700">{uploadProgress}%</span>
              </div>
              <div
                className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200"
                role="progressbar"
                aria-label="تقدم رفع الفواتير وجدولتها"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadProgress}
              >
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-xs text-slate-500" aria-live="polite">{uploadProgressLabel}</p>
              <p className="text-[11px] text-slate-400">سيستمر تحليل الفواتير في الخلفية بعد اكتمال الجدولة.</p>
            </div>
          ) : (
            /* ==================== AI UPLOAD ==================== */
            <div className="space-y-5">

              {/* Manual / Auto Classification Selector for AI */}
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50/80 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-bold text-slate-800">
                    تصنيف الفواتير للذكاء الاصطناعي:
                  </label>
                  <span className="text-[11px] text-slate-500">
                    يمكنك تحديد النوع يدوياً مسبقاً أو تركه تلقائياً، كما يمكنك التخصيص لكل ملف
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'auto', label: 'تلقائي (AI)', sub: 'يحدد Gemini النوع' },
                      { id: 'مبيعات', label: 'مبيعات', sub: 'توجيه كل الملفات كمبيعات' },
                      { id: 'مشتريات', label: 'مشتريات', sub: 'توجيه كل الملفات كمشتريات' },
                    ] as { id: AiClassificationChoice; label: string; sub: string }[]
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleBatchClassificationChange(opt.id)}
                      className={`p-1.5 sm:p-2 rounded-lg border text-right transition ${
                        aiDefaultClassification === opt.id
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-950 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <div className="font-bold text-[10px] sm:text-[11px]">{opt.label}</div>
                      <div className="text-[9px] leading-tight text-slate-500 mt-0.5">{opt.sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center bg-slate-50 hover:bg-slate-100/50 transition cursor-pointer">
                <input
                  type="file"
                  multiple
                  accept="image/jpeg, image/png, image/webp, application/pdf"
                  onChange={handleAiFilesSelect}
                  className="hidden"
                  id="batchFilesInput"
                />
                <label htmlFor="batchFilesInput" className="cursor-pointer flex flex-col items-center gap-3">
                  <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center">
                    <Upload className="w-6 h-6" />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800 text-sm">
                      انقر لاختيار صور أو ملفات الفواتير للاستخراج الذكي
                    </span>
                    <p className="text-xs text-slate-500 mt-1">
                      {aiDefaultClassification === 'auto'
                        ? 'يتم إرسال محتوى الصورة الفعلي إلى Gemini لتحديد النوع (مبيعات / مشتريات) واستخراج الحقول'
                        : `سيتم توجيه الذكاء الاصطناعي لاستخراج الفواتير بتصنيف "${aiDefaultClassification}" مباشرة`}
                    </p>
                  </div>
                </label>
              </div>

              {selectedFiles.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-xs text-slate-700">الملفات المختارة ({selectedFiles.length})</span>
                    <button onClick={() => setSelectedFiles([])} className="text-xs text-red-600 hover:underline">
                      إزالة الكل
                    </button>
                  </div>
                  <div className="max-h-52 overflow-y-auto space-y-1.5">
                    {selectedFiles.map((f, idx) => (
                      <div
                        key={idx}
                        className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-50 rounded-xl border text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="font-medium text-slate-800 truncate">{f.file.name}</span>
                          <span className="text-slate-400 shrink-0">{(f.file.size / 1024).toFixed(1)} KB</span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
                            {(['auto', 'مبيعات', 'مشتريات'] as AiClassificationChoice[]).map((choice) => (
                              <button
                                key={choice}
                                type="button"
                                onClick={() => handleSingleFileClassificationChange(idx, choice)}
                                className={`px-2 py-1 rounded-md text-[11px] font-bold transition ${
                                  f.classification === choice
                                    ? choice === 'auto'
                                      ? 'bg-slate-800 text-white'
                                      : 'bg-emerald-600 text-white'
                                    : 'text-slate-600 hover:bg-slate-100'
                                }`}
                              >
                                {choice === 'auto' ? 'تلقائي' : choice}
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveSelectedFile(idx)}
                            className="p-1 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition"
                            title="إزالة الملف"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {!extracting && (
          <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-end gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-white"
            >
              إغلاق
            </button>

            {mode === 'manual' ? (
              <button
                type="button"
                disabled={savingManual}
                onClick={handleSaveManualInvoice}
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-md flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                <span>{savingManual ? 'جاري الحفظ...' : 'حفظ الفاتورة وتجهيزها لـ Excel'}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={selectedFiles.length === 0}
                onClick={handleStartAiExtraction}
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-md flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>بدء المعالجة في الخلفية ({selectedFiles.length})</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
