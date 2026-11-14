import React, { useState } from 'react';
import { X, Upload, Sparkles, Loader2, PenLine, AlertCircle } from 'lucide-react';
import { InvoiceRecord, Operation, DocumentType } from '../types';
import { saveInvoiceImage } from '../services/dbService';

interface BatchUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
  onStartReview: (invoiceId: string) => void;
}

function toOptionalNum(val: any): number | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

async function fetchWithRetry(url: string, options: RequestInit, maxAttempts = 2): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, options);
    lastRes = res;
    if (res.status !== 429 && res.status !== 503) {
      return res;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  return lastRes!;
}

export const BatchUploadModal: React.FC<BatchUploadModalProps> = ({
  isOpen,
  onClose,
  operation,
  onUpdateOperation,
  onStartReview,
}) => {
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [manualType, setManualType] = useState<'مبيعات' | 'مشتريات'>('مبيعات');
  const [selectedFiles, setSelectedFiles] = useState<{ file: File; base64: string; mimeType: string }[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, success: 0, failed: 0 });
  const [errorMsg, setErrorMsg] = useState('');

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

  const handleFilesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files);
    setErrorMsg('');

    const newItems: { file: File; base64: string; mimeType: string }[] = [];
    for (const file of files) {
      try {
        const base64 = await fileToBase64(file);
        newItems.push({
          file,
          base64,
          mimeType: file.type || 'image/jpeg',
        });
      } catch (err) {
        console.error('Error reading file:', err);
        setErrorMsg('تعذر قراءة أحد الملفات المختارة.');
      }
    }

    setSelectedFiles((prev) => [...prev, ...newItems]);
  };

  const handleStartProcessing = async () => {
    if (selectedFiles.length === 0) return;

    const useAI = mode === 'ai';
    setExtracting(true);
    setErrorMsg('');
    setProgress({ current: 0, total: selectedFiles.length, success: 0, failed: 0 });

    let workingInvoices = [...(operation.invoices || [])];
    let successCount = 0;
    let failedCount = 0;
    let firstCreatedId: string | null = null;

    for (let i = 0; i < selectedFiles.length; i++) {
      setProgress((p) => ({ ...p, current: i + 1 }));
      const item = selectedFiles[i];
      const invId = 'inv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      if (!firstCreatedId) firstCreatedId = invId;
      const nowDate = new Date().toISOString().split('T')[0];

      // Persist image immediately in IndexedDB
      try {
        await saveInvoiceImage(invId, item.base64, item.mimeType);
      } catch (err) {
        console.error('IndexedDB save image error:', err);
      }

      const newRecord: InvoiceRecord = {
        id: invId,
        invoiceNumber: '',
        invoiceDate: '', // NEVER default missing invoice date to today
        documentType: useAI ? 'يحتاج تحديد النوع' : manualType,
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
        status: useAI ? 'قيد المعالجة' : 'تحتاج مراجعة',
        hasImage: true,
        imageBase64: item.base64,
        imageMimeType: item.mimeType,
        imageFileName: item.file.name,
        createdAt: nowDate,
        updatedAt: nowDate,
      };

      if (useAI) {
        try {
          const res = await fetchWithRetry('/api/extract-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageBase64: item.base64,
              mimeType: item.mimeType,
              customFields: operation.customFields,
              organizationName: operation.name,
              activityType: operation.activityType,
            }),
          });

          const data = await res.json();
          if (res.ok && data.success && data.data) {
            const ext = data.data;
            const classifiedType: DocumentType =
              ext.documentType === 'مبيعات' || ext.documentType === 'مشتريات'
                ? ext.documentType
                : 'يحتاج تحديد النوع';

            newRecord.documentType = classifiedType;
            newRecord.classificationReason = ext.classificationReason || '';
            newRecord.invoiceNumber = ext.invoiceNumber || '';
            newRecord.invoiceDate = ext.invoiceDate || '';
            newRecord.day = ext.day || '';
            newRecord.issuerName = ext.issuerName || '';
            newRecord.clientName = ext.clientName || '';
            newRecord.issuerTaxId = ext.issuerTaxId || '';
            newRecord.clientTaxId = ext.clientTaxId || '';
            newRecord.currency = ext.currency || '';
            newRecord.subtotal = toOptionalNum(ext.subtotal);
            newRecord.taxAmount = toOptionalNum(ext.taxAmount);
            newRecord.taxRate = toOptionalNum(ext.taxRate);
            newRecord.discount = toOptionalNum(ext.discount);
            newRecord.grandTotal = toOptionalNum(ext.grandTotal);
            newRecord.cashSales = toOptionalNum(ext.cashSales);
            newRecord.networkSales = toOptionalNum(ext.networkSales);
            newRecord.notes = ext.notes || '';
            newRecord.items = Array.isArray(ext.items)
              ? ext.items.map((it: any, idx: number) => ({
                  id: `${invId}_item_${idx}`,
                  name: String(it?.name || ''),
                  code: it?.code ? String(it.code) : undefined,
                  quantity: toOptionalNum(it?.quantity),
                  unit: it?.unit ? String(it.unit) : undefined,
                  unitPrice: toOptionalNum(it?.unitPrice),
                  discount: toOptionalNum(it?.discount),
                  tax: toOptionalNum(it?.tax),
                  total: toOptionalNum(it?.total),
                }))
              : [];
            newRecord.customFieldsValues =
              ext.customFieldsExtracted && typeof ext.customFieldsExtracted === 'object'
                ? ext.customFieldsExtracted
                : {};
            newRecord.status = 'تحتاج مراجعة';
            successCount++;
          } else {
            newRecord.status = 'فشل';
            newRecord.errorMessage = data.error || 'فشل الاستخراج الذكي لهذه الفاتورة';
            failedCount++;
          }
        } catch (err: any) {
          newRecord.status = 'فشل';
          newRecord.errorMessage = err?.message || 'خطأ في الاتصال بالخادم';
          failedCount++;
        }
      } else {
        successCount++;
      }

      workingInvoices = [newRecord, ...workingInvoices];
      onUpdateOperation({
        ...operation,
        invoices: workingInvoices,
        updatedAt: nowDate,
      });

      setProgress((p) => ({ ...p, success: successCount, failed: failedCount }));
      if (useAI && i < selectedFiles.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    setExtracting(false);
    setSelectedFiles([]);
    onClose();
    if (firstCreatedId) {
      onStartReview(firstCreatedId);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full overflow-hidden border border-slate-100 animate-in fade-in zoom-in duration-200">
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-emerald-400" />
            <h3 className="font-bold text-lg">رفع وإضافة الفواتير والمستندات</h3>
          </div>
          <button
            onClick={onClose}
            disabled={extracting}
            className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {extracting ? (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mx-auto" />
              <div>
                <h4 className="font-bold text-slate-800 text-lg mb-1">
                  {mode === 'ai'
                    ? 'جاري تحليل وتصنيف الفواتير بالذكاء الاصطناعي...'
                    : 'جاري حفظ الفواتير للإدخال اليدوي...'}
                </h4>
                <p className="text-sm text-slate-500">
                  تمت معالجة {progress.current} من أصل {progress.total} ملفات (نجح: {progress.success} • فشل:{' '}
                  {progress.failed})
                </p>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 max-w-md mx-auto overflow-hidden">
                <div
                  className="bg-emerald-600 h-full transition-all duration-300"
                  style={{ width: `${(progress.current / Math.max(progress.total, 1)) * 100}%` }}
                ></div>
              </div>
            </div>
          ) : (
            <>
              {/* Processing mode */}
              <div>
                <label className="block text-sm font-bold text-slate-800 mb-2">طريقة الإضافة والمعالجة:</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setMode('ai')}
                    className={`p-4 rounded-2xl border text-right transition flex flex-col gap-1.5 ${
                      mode === 'ai'
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-950 ring-2 ring-emerald-500/20'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold text-sm">
                      <Sparkles className={`w-4 h-4 ${mode === 'ai' ? 'text-emerald-600' : 'text-slate-500'}`} />
                      <span>استخراج وتصنيف تلقائي (AI)</span>
                    </div>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      يحلل الذكاء الاصطناعي كل فاتورة تلقائياً لتحديد نوعها (مبيعات أو مشتريات) واستخراج بياناتها دون اختيار مسبق.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setMode('manual')}
                    className={`p-4 rounded-2xl border text-right transition flex flex-col gap-1.5 ${
                      mode === 'manual'
                        ? 'border-slate-800 bg-slate-50 text-slate-950 ring-2 ring-slate-500/20'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold text-sm">
                      <PenLine className="w-4 h-4 text-slate-700" />
                      <span>إدخال يدوي</span>
                    </div>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      اختر نوع الفاتورة يدوياً (مبيعات أو مشتريات) وأدخل القيم بنفسك في شاشة المراجعة.
                    </p>
                  </button>
                </div>
              </div>

              {/* Manual-only type selection */}
              {mode === 'manual' && (
                <div>
                  <label className="block text-sm font-bold text-slate-800 mb-2">نوع الفواتير المضافة يدوياً:</label>
                  <div className="grid grid-cols-2 gap-4">
                    <button
                      type="button"
                      onClick={() => setManualType('مبيعات')}
                      className={`p-3.5 rounded-2xl border font-bold text-sm transition ${
                        manualType === 'مبيعات'
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      مبيعات
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualType('مشتريات')}
                      className={`p-3.5 rounded-2xl border font-bold text-sm transition ${
                        manualType === 'مشتريات'
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      مشتريات
                    </button>
                  </div>
                </div>
              )}

              {/* Upload area */}
              <div className="border-2 border-dashed border-slate-300 rounded-2xl p-6 text-center bg-slate-50 hover:bg-slate-100/50 transition cursor-pointer">
                <input
                  type="file"
                  multiple
                  accept="image/jpeg, image/png, image/webp, application/pdf"
                  onChange={handleFilesSelect}
                  className="hidden"
                  id="batchFilesInput"
                />
                <label htmlFor="batchFilesInput" className="cursor-pointer flex flex-col items-center gap-3">
                  <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center">
                    <Upload className="w-6 h-6" />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800 text-sm">انقر لاختيار صور أو ملفات الفواتير</span>
                    <p className="text-xs text-slate-500 mt-0.5">JPG, PNG, WEBP, PDF</p>
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
                  <div className="max-h-36 overflow-y-auto space-y-1.5">
                    {selectedFiles.map((f, idx) => (
                      <div key={idx} className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border text-xs">
                        <span className="font-medium text-slate-800 truncate">{f.file.name}</span>
                        <span className="text-slate-400">{(f.file.size / 1024).toFixed(1)} KB</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={selectedFiles.length === 0}
                  onClick={handleStartProcessing}
                  className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-md flex items-center gap-2"
                >
                  {mode === 'ai' ? <Sparkles className="w-4 h-4" /> : <PenLine className="w-4 h-4" />}
                  <span>
                    {mode === 'ai'
                      ? `بدء الاستخراج والتصنيف (${selectedFiles.length})`
                      : `إضافة للإدخال اليدوي (${selectedFiles.length})`}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
