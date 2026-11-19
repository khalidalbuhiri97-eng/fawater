import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  ChevronLeft,
  ChevronRight,
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
    { file: File; classification: AiClassificationChoice }[]
  >([]);
  const [extracting, setExtracting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadProgressLabel, setUploadProgressLabel] = useState('تهيئة الملفات للرفع...');

  // Manual mode state (persists across preview/field edits and type toggles)
  const [manualType, setManualType] = useState<'مبيعات' | 'مشتريات'>('مبيعات');
  const [manualInvoice, setManualInvoice] = useState<InvoiceRecord>(() => createEmptyManualInvoice('مبيعات'));
  const [manualImage, setManualImage] = useState<{ fileName: string; base64: string; mimeType: string } | null>(null);
  const [manualFiles, setManualFiles] = useState<File[]>([]);
  const [activeManualImageIndex, setActiveManualImageIndex] = useState(0);
  const [manualDrafts, setManualDrafts] = useState<Record<number, InvoiceRecord>>({});
  const [manualCompletedIndexes, setManualCompletedIndexes] = useState<number[]>([]);
  const [manualTouchStartX, setManualTouchStartX] = useState<number | null>(null);
  const [manualZoom, setManualZoom] = useState(1);
  const [manualRotation, setManualRotation] = useState(0);
  const [imageLightboxOpen, setImageLightboxOpen] = useState(false);
  const lightboxPointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchDistance = useRef<number | null>(null);
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
  const loadManualImage = async (file: File) => {
    const base64 = await fileToBase64(file);
    setManualImage({ fileName: file.name, base64, mimeType: file.type || 'image/jpeg' });
    setManualZoom(1);
    setManualRotation(0);
  };

  const handleManualImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((file) => file.type.startsWith('image/') || file.type === 'application/pdf');
    if (!files.length) return;
    setErrorMsg('');
    setManualFiles((prev) => [...prev, ...files]);
    try {
      if (manualFiles.length === 0 || manualCompletedIndexes.length >= manualFiles.length) {
        const firstNewIndex = manualFiles.length;
        setActiveManualImageIndex(firstNewIndex);
        await loadManualImage(files[0]);
      }
    }
    catch { setErrorMsg('تعذر قراءة أحد ملفات الصور المختارة.'); }
    e.target.value = '';
  };

  const navigateManualImage = async (direction: -1 | 1) => {
    const available = manualFiles.map((_, index) => index).filter((index) => !manualCompletedIndexes.includes(index));
    const position = available.indexOf(activeManualImageIndex);
    const nextIndex = available[position + direction];
    if (nextIndex === undefined) return;
    setManualDrafts((prev) => ({ ...prev, [activeManualImageIndex]: manualInvoice }));
    setManualInvoice(manualDrafts[nextIndex] || createEmptyManualInvoice(manualType));
    setActiveManualImageIndex(nextIndex);
    setErrorMsg('');
    try { await loadManualImage(manualFiles[nextIndex]); }
    catch { setErrorMsg('تعذر تحميل الصورة التالية.'); }
  };
  const removeCurrentManualImage = async () => {
    const remaining = manualFiles.filter((_, index) => index !== activeManualImageIndex);
    const nextDrafts: Record<number, InvoiceRecord> = {};
    Object.entries(manualDrafts).forEach(([key, value]) => {
      const oldIndex = Number(key);
      if (oldIndex < activeManualImageIndex) nextDrafts[oldIndex] = value;
      if (oldIndex > activeManualImageIndex) nextDrafts[oldIndex - 1] = value;
    });
    setManualFiles(remaining);
    setManualDrafts(nextDrafts);
    setManualCompletedIndexes((prev) => prev.filter((index) => index !== activeManualImageIndex).map((index) => index > activeManualImageIndex ? index - 1 : index));
    const nextIndex = Math.min(activeManualImageIndex, remaining.length - 1);
    setActiveManualImageIndex(Math.max(0, nextIndex));
    if (nextIndex >= 0) {
      setManualInvoice(nextDrafts[nextIndex] || createEmptyManualInvoice(manualType));
      await loadManualImage(remaining[nextIndex]);
    } else {
      setManualImage(null);
      setManualInvoice(createEmptyManualInvoice(manualType));
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
        manualInvoice.grandTotal !== undefined ||
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
      if (manualFiles.length > 0) {
        setManualCompletedIndexes((prev) => [...prev, activeManualImageIndex]);
        const nextIndex = manualFiles.findIndex((_, index) => index !== activeManualImageIndex && !manualCompletedIndexes.includes(index));
        if (nextIndex >= 0) {
          setManualDrafts((prev) => ({ ...prev, [activeManualImageIndex]: manualInvoice }));
          setActiveManualImageIndex(nextIndex);
          setManualInvoice(manualDrafts[nextIndex] || createEmptyManualInvoice(manualType));
          await loadManualImage(manualFiles[nextIndex]);
          setManualSuccessMsg(`تم حفظ الفاتورة. انتقلت إلى الصورة ${nextIndex + 1} من ${manualFiles.length}.`);
        } else {
          setManualInvoice(createEmptyManualInvoice(manualType));
          setManualSuccessMsg('اكتمل الإدخال اليدوي وحفظ جميع الصور المختارة.');
        }
      } else {
        setManualInvoice(createEmptyManualInvoice(manualType));
        setManualImage(null);
        setManualZoom(1);
      }
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

  const handleAiFilesSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((file) => file.type.startsWith('image/') || file.type === 'application/pdf');
    if (!files.length) return;
    setErrorMsg('');
    setSelectedFiles((prev) => [...prev, ...files.map((file) => ({ file, classification: aiDefaultClassification }))]);
    e.target.value = '';
  };
  const handleStartAiExtraction = async () => {
    if (selectedFiles.length === 0 || extracting) return;
    if (selectedFiles.length > 50) { setErrorMsg('الحد الأقصى للدفعة الواحدة 50 فاتورة.'); return; }
    const totalBytes = selectedFiles.reduce((sum, item) => sum + item.file.size, 0);
    if (totalBytes > 150 * 1024 * 1024) { setErrorMsg('إجمالي حجم الدفعة يتجاوز 150 ميغابايت. قسّم الفواتير إلى دفعات أصغر.'); return; }
    setExtracting(true);
    setUploadProgress(0);
    setUploadProgressLabel('تهيئة الرفع الآمن إلى التخزين السحابي...');
    setErrorMsg('');
    try {
      const files = selectedFiles.map((item) => {
        if (item.file.size > 15 * 1024 * 1024) throw new Error(`حجم الملف "${item.file.name}" يتجاوز 15 ميغابايت.`);
        return {
          invoiceId: generateUuid(), file: item.file, mimeType: item.file.type || 'image/jpeg',
          fileName: item.file.name, fileSize: item.file.size, manualDocumentType: item.classification,
        };
      });
      const queued = await enqueueAiBackgroundBatch({
        organization: operation,
        files,
        onProgress: (completed, total, fileName) => {
          setUploadProgress(Math.round((completed / Math.max(total, 1)) * 75));
          setUploadProgressLabel(`تم رفع ${completed} من ${total}: ${fileName}`);
        },
      });
      setUploadProgress(92);
      setUploadProgressLabel('تم حفظ المهام والبيانات في قاعدة البيانات...');
      if (queued.initialInvoices.length > 0) {
        onUpdateOperation({ ...operation, invoices: [...queued.initialInvoices, ...(operation.invoices || [])], updatedAt: new Date().toISOString() });
      }
      setUploadProgress(100);
      setUploadProgressLabel(`تم حفظ ${queued.initialInvoices.length} فاتورة في الطابور. سيستمر التحليل بعد إغلاق الصفحة.`);
      setSelectedFiles([]);
      onBackgroundBatchQueued?.(queued.batchId);
      onClose();
    } catch (error: any) {
      setErrorMsg(error?.message || 'تعذر رفع الفواتير إلى التخزين الآمن أو جدولة التحليل.');
    } finally {
      setExtracting(false);
      setUploadProgress(0);
      setUploadProgressLabel('حفظ الفواتير في طابور المعالجة...');
    }
  };

  const activeManualSheet = getSheetSchemaByType(templateSheets, manualType);

  return createPortal((
    <div className="fixed inset-0 z-50 h-[100dvh] w-screen bg-black/65 backdrop-blur-xs flex items-center justify-center p-0 sm:p-4 overflow-hidden overscroll-none">
      <div className="bg-white rounded-none sm:rounded-3xl shadow-2xl w-full max-w-4xl h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[94dvh] flex flex-col min-h-0 overflow-hidden border border-slate-200 animate-in fade-in zoom-in duration-200">
        {/* Header */}
        <div className="bg-slate-900 text-white px-3 py-3 sm:px-6 sm:py-4 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5">
            {mode === 'ai' ? (
              <Sparkles className="w-5 h-5 text-emerald-400" />
            ) : (
              <PenLine className="w-5 h-5 text-emerald-400" />
            )}
            <h3 className="min-w-0 font-bold text-xs sm:text-lg leading-snug">
              {mode === 'ai' ? 'استخراج الفواتير بالذكاء الاصطناعي' : 'الإدخال اليدوي المباشر وفق قالب Excel'}
            </h3>
          </div>
          <button
            onClick={onClose}
            disabled={savingManual}
            className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode Switcher */}
        {!extracting && (
          <div className="px-3 sm:px-4 pt-2 pb-2 bg-slate-50 border-b border-slate-200 shrink-0">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setMode('manual');
                  setErrorMsg('');
                }}
                className={`min-w-0 p-1.5 sm:p-2 rounded-lg border text-right transition flex items-center gap-1.5 ${
                  mode === 'manual'
                    ? 'border-slate-900 bg-white text-slate-950 ring-2 ring-slate-900/15 shadow-xs'
                    : 'border-slate-200 bg-slate-100/70 text-slate-600 hover:bg-white'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
                    mode === 'manual' ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  <PenLine className="w-3 h-3" />
                </div>
                <div>
                  <div className="font-bold text-[10px] sm:text-[11px] leading-tight">الوضع الأول: الإدخال اليدوي</div>
                  <div className="hidden sm:block text-[9px] text-slate-500 leading-tight">معاينة الصورة وأعمدة Excel (بدون Gemini)</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode('ai');
                  setErrorMsg('');
                  setManualSuccessMsg('');
                }}
                className={`min-w-0 p-1.5 sm:p-2 rounded-lg border text-right transition flex items-center gap-1.5 ${
                  mode === 'ai'
                    ? 'border-emerald-600 bg-white text-emerald-950 ring-2 ring-emerald-500/20 shadow-xs'
                    : 'border-slate-200 bg-slate-100/70 text-slate-600 hover:bg-white'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
                    mode === 'ai' ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[10px] sm:text-[11px] leading-tight">الوضع الثاني: الذكاء الاصطناعي</div>
                  <div className="hidden sm:block text-[9px] text-slate-500 leading-tight">قراءة الصورة وتصنيفها تلقائياً</div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="px-2 py-2 sm:p-6 flex min-h-0 flex-1 flex-col gap-2 sm:gap-3 overflow-hidden">
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
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {/* اختيار نوع الفاتورة قبل بدء الإدخال */}
              <div className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <label className="mb-2 block text-xs font-bold text-slate-800">حدد نوع الفاتورة أولاً:</label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => handleManualTypeSwitch('مبيعات')} className={`rounded-xl border p-3 text-xs font-bold transition ${
                    manualType === 'مبيعات' ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20' : 'border-slate-200 bg-white text-slate-700'
                  }`}>مبيعات</button>
                  <button type="button" onClick={() => handleManualTypeSwitch('مشتريات')} className={`rounded-xl border p-3 text-xs font-bold transition ${
                    manualType === 'مشتريات' ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20' : 'border-slate-200 bg-white text-slate-700'
                  }`}>مشتريات</button>
                </div>
              </div>

              {/* 1. Preview Area ON TOP (always visible when uploaded, never disappears while filling fields) */}
              <div className="relative z-10 shrink-0 rounded-2xl border border-slate-200 overflow-hidden bg-slate-950 shadow-lg">
                <div className="bg-slate-900 text-white px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <ImageIcon className="w-4 h-4 text-emerald-400" />
                    <span className="font-bold truncate max-w-[240px]">
                      {manualImage ? `${manualImage.fileName} · ${activeManualImageIndex + 1} / ${manualFiles.length}` : 'معاينة صور الفاتورة (اختيارية في الإدخال اليدوي)'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {manualImage && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setManualZoom(1); setImageLightboxOpen(true); }}
                          className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                          title="تكبير"
                        >
                          <ZoomIn className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualRotation((angle) => (angle + 90) % 360)}
                          className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                          title="تدوير الصورة 90 درجة"
                          aria-label="تدوير الصورة 90 درجة"
                        >
                          <RotateCcw className="w-4 h-4" />
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
                          onClick={removeCurrentManualImage}
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
                      multiple
                      onChange={handleManualImageSelect}
                      className="hidden"
                      id="manualImageUpload"
                    />
                    <label
                      htmlFor="manualImageUpload"
                      className="cursor-pointer px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition"
                    >
                      إضافة صور الفواتير
                    </label>
                  </div>
                </div>

                {manualImage ? (
                  <div
                    className="relative flex h-[24dvh] min-h-[145px] max-h-[270px] items-center justify-center overflow-hidden p-2"
                    onTouchStart={(event) => setManualTouchStartX(event.touches[0]?.clientX ?? null)}
                    onTouchEnd={(event) => {
                      if (manualTouchStartX === null) return;
                      const delta = (event.changedTouches[0]?.clientX ?? manualTouchStartX) - manualTouchStartX;
                      if (Math.abs(delta) > 55) navigateManualImage(delta < 0 ? 1 : -1);
                      setManualTouchStartX(null);
                    }}
                  >
                    {manualFiles.length > 1 && (
                      <>
                        <button type="button" onClick={() => navigateManualImage(-1)} className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white" aria-label="الصورة السابقة"><ChevronRight className="h-4 w-4" /></button>
                        <button type="button" onClick={() => navigateManualImage(1)} className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white" aria-label="الصورة التالية"><ChevronLeft className="h-4 w-4" /></button>
                        <span className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-[10px] text-white">{activeManualImageIndex + 1} / {manualFiles.length}</span>
                      </>
                    )}
                    {manualImage.mimeType === 'application/pdf' ? (
                      <embed
                        src={`data:application/pdf;base64,${manualImage.base64}`}
                        type="application/pdf"
                        className="h-full w-full rounded-lg"
                      />
                    ) : (
                      <img
                        onClick={() => { setManualZoom(1); setImageLightboxOpen(true); }}
                        src={`data:${manualImage.mimeType};base64,${manualImage.base64}`}
                        alt="معاينة الفاتورة"
                        style={{ transform: `rotate(${manualRotation}deg) scale(${manualZoom})`, transition: 'transform 0.2s ease' }}
                        className="max-h-full max-w-full object-contain rounded-lg cursor-zoom-in"
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

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-4 pb-2">
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
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-3 sm:space-y-5 pb-2">

              {/* Manual / Auto Classification Selector for AI */}
              <div className="p-2 sm:p-3 rounded-xl border border-slate-200 bg-slate-50/80 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-bold text-slate-800">
                    تصنيف الفواتير للذكاء الاصطناعي:
                  </label>
                  <span className="text-[10px] sm:text-[11px] text-slate-500 leading-snug">
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

              <div className="border-2 border-dashed border-slate-300 rounded-2xl p-4 sm:p-8 text-center bg-slate-50 hover:bg-slate-100/50 transition cursor-pointer">
                <input
                  type="file"
                  multiple
                  accept="image/jpeg, image/png, image/webp, application/pdf"
                  onChange={handleAiFilesSelect}
                  className="hidden"
                  id="batchFilesInput"
                />
                <label htmlFor="batchFilesInput" className="cursor-pointer flex flex-col items-center gap-3">
                  <div className="w-10 h-10 sm:w-12 sm:h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center">
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
          <div className="px-3 py-3 sm:px-6 sm:py-4 bg-slate-50 border-t border-slate-200 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-white"
            >
              إغلاق
            </button>

            {mode === 'manual' ? (
              <button
                type="button"
                disabled={savingManual || manualCompletedIndexes.includes(activeManualImageIndex)}
                onClick={handleSaveManualInvoice}
                className="w-full sm:w-auto justify-center px-4 sm:px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-md flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                <span>{savingManual ? 'جاري الحفظ...' : 'حفظ الفاتورة وتجهيزها لـ Excel'}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={selectedFiles.length === 0}
                onClick={handleStartAiExtraction}
                className="w-full sm:w-auto justify-center px-4 sm:px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-md flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>بدء المعالجة في الخلفية ({selectedFiles.length})</span>
              </button>
            )}
          </div>
        )}
      </div>
      {imageLightboxOpen && manualImage && manualImage.mimeType !== "application/pdf" && (
        <div
          className="fixed inset-0 z-[100] flex h-[100dvh] w-screen flex-col overflow-hidden bg-black"
          role="dialog"
          aria-modal="true"
          aria-label="تكبير صورة الفاتورة"
          style={{ touchAction: 'none', overscrollBehavior: 'none' }}
        >
          <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 bg-slate-950 px-3 py-3 text-white">
            <span className="min-w-0 truncate text-xs font-semibold">{manualImage.fileName}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => setManualZoom((z) => Math.min(z + 0.25, 5))} className="rounded-lg bg-white/10 p-2" aria-label="تكبير الصورة"><ZoomIn className="h-4 w-4" /></button>
              <button type="button" onClick={() => setManualZoom((z) => Math.max(z - 0.25, 1))} className="rounded-lg bg-white/10 p-2" aria-label="تصغير الصورة"><ZoomOut className="h-4 w-4" /></button>
              <button type="button" onClick={() => setManualRotation((angle) => (angle + 90) % 360)} className="rounded-lg bg-white/10 p-2" aria-label="تدوير الصورة 90 درجة"><RotateCcw className="h-4 w-4" /></button>
              <button type="button" onClick={() => { setManualZoom(1); setManualRotation(0); }} className="rounded-lg bg-white/10 p-2" aria-label="إعادة ضبط"><RotateCcw className="h-4 w-4" /></button>
              <button type="button" onClick={() => { setImageLightboxOpen(false); setManualZoom(1); lightboxPointers.current.clear(); pinchDistance.current = null; }} className="rounded-lg bg-white/10 p-2" aria-label="إغلاق التكبير"><X className="h-5 w-5" /></button>
            </div>
          </div>
          <div
            className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2"
            style={{ touchAction: 'none', overscrollBehavior: 'none' }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              lightboxPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              if (lightboxPointers.current.size === 2) {
                const pts = Array.from(lightboxPointers.current.values());
                pinchDistance.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
              }
            }}
            onPointerMove={(event) => {
              if (!lightboxPointers.current.has(event.pointerId)) return;
              lightboxPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              if (lightboxPointers.current.size === 2 && pinchDistance.current) {
                const pts = Array.from(lightboxPointers.current.values());
                const nextDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                const ratio = nextDistance / pinchDistance.current;
                setManualZoom((z) => Math.max(1, Math.min(5, z * ratio)));
                pinchDistance.current = nextDistance;
              }
            }}
            onPointerUp={(event) => {
              lightboxPointers.current.delete(event.pointerId);
              pinchDistance.current = null;
            }}
            onPointerCancel={(event) => {
              lightboxPointers.current.delete(event.pointerId);
              pinchDistance.current = null;
            }}
          >
            <img
              draggable={false}
              src={`data:${manualImage.mimeType};base64,${manualImage.base64}`}
              alt="صورة الفاتورة مكبرة"
              style={{ transform: `rotate(${manualRotation}deg) scale(${manualZoom})`, transformOrigin: "center center", transition: "transform 0.08s linear", maxHeight: "100%", maxWidth: "100%", objectFit: "contain", pointerEvents: "none", userSelect: "none" }}
            />
          </div>
        </div>
      )}
    </div>
    ), document.body);
};