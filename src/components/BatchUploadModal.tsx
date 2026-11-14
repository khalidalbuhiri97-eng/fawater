import React, { useState } from 'react';
import { X, Upload, Sparkles, FileText, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { InvoiceRecord, Operation, DocumentType } from '../types';

interface BatchUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
  onStartReview: (invoiceId: string) => void;
}

export const BatchUploadModal: React.FC<BatchUploadModalProps> = ({
  isOpen,
  onClose,
  operation,
  onUpdateOperation,
  onStartReview,
}) => {
  const [entryType, setEntryType] = useState<DocumentType>('مبيعات');
  const [selectedFiles, setSelectedFiles] = useState<{ file: File; base64: string; mimeType: string }[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, success: 0, failed: 0 });
  const [errorMsg, setErrorMsg] = useState('');

  if (!isOpen) return null;

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
          mimeType: file.type || 'image/jpeg'
        });
      } catch (err) {
        console.error('Error reading file:', err);
      }
    }

    setSelectedFiles(prev => [...prev, ...newItems]);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const res = reader.result as string;
        const base64Data = res.split(',')[1] || res;
        resolve(base64Data);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleStartExtraction = async (useAI: boolean) => {
    if (selectedFiles.length === 0) return;

    setExtracting(true);
    setProgress({ current: 0, total: selectedFiles.length, success: 0, failed: 0 });

    const updatedInvoices = [...(operation.invoices || [])];
    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < selectedFiles.length; i++) {
      setProgress(p => ({ ...p, current: i + 1 }));
      const item = selectedFiles[i];
      const invId = 'inv_' + Date.now() + Math.random().toString(36).substring(2, 6);

      const newRecord: InvoiceRecord = {
        id: invId,
        invoiceNumber: '',
        invoiceDate: new Date().toISOString().split('T')[0],
        documentType: entryType,
        issuerName: '',
        clientName: '',
        issuerTaxId: '',
        clientTaxId: '',
        currency: 'SAR',
        subtotal: 0,
        taxAmount: 0,
        taxRate: 0,
        discount: 0,
        grandTotal: 0,
        notes: '',
        items: [],
        customFieldsValues: {},
        status: useAI ? 'قيد المعالجة' : 'تحتاج مراجعة',
        imageBase64: item.base64,
        imageMimeType: item.mimeType,
        imageFileName: item.file.name,
        createdAt: new Date().toISOString().split('T')[0],
        updatedAt: new Date().toISOString().split('T')[0]
      };

      if (useAI) {
        try {
          const res = await fetch('/api/extract-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageBase64: item.base64,
              mimeType: item.mimeType,
              customFields: operation.customFields
            })
          });

          const data = await res.json();
          if (data.success && data.data) {
            const ext = data.data;
            newRecord.invoiceNumber = ext.invoiceNumber || '';
            newRecord.invoiceDate = ext.invoiceDate || newRecord.invoiceDate;
            newRecord.documentType = entryType;
            newRecord.issuerName = ext.issuerName || '';
            newRecord.subtotal = Number(ext.subtotal || 0);
            newRecord.taxAmount = Number(ext.taxAmount || 0);
            newRecord.grandTotal = Number(ext.grandTotal || (newRecord.subtotal + newRecord.taxAmount));
            
            // For sales: leave cash & network sales empty if not explicitly split
            if (entryType === 'مبيعات') {
              newRecord.grandTotal = Number(ext.grandTotal || ext.subtotal || 0);
            }

            newRecord.status = 'تحتاج مراجعة';
            successCount++;
          } else {
            newRecord.status = 'فشل';
            newRecord.errorMessage = data.error || 'فشل الاستخراج';
            failedCount++;
          }
        } catch (err: any) {
          newRecord.status = 'فشل';
          newRecord.errorMessage = err.message || 'خطأ في الاتصال بالخادم';
          failedCount++;
        }
      } else {
        successCount++;
      }

      updatedInvoices.unshift(newRecord);
      onUpdateOperation({
        ...operation,
        invoices: updatedInvoices,
        updatedAt: new Date().toISOString().split('T')[0]
      });

      setProgress(p => ({ ...p, success: successCount, failed: failedCount }));
      await new Promise(r => setTimeout(r, 800));
    }

    setExtracting(false);
    setSelectedFiles([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full overflow-hidden border border-slate-100 animate-in fade-in zoom-in duration-200">
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-emerald-400" />
            <h3 className="font-bold text-lg">تسجيل ورفع الفواتير والمستندات</h3>
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
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
              {errorMsg}
            </div>
          )}

          {extracting ? (
            <div className="py-12 text-center space-y-4">
              <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mx-auto" />
              <div>
                <h4 className="font-bold text-slate-800 text-lg mb-1">جاري معالجة الفواتير واستخراج البيانات...</h4>
                <p className="text-sm text-slate-500">
                  تمت معالجة {progress.current} من أصل {progress.total} ملفات
                </p>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 max-w-md mx-auto overflow-hidden">
                <div 
                  className="bg-emerald-600 h-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                ></div>
              </div>
            </div>
          ) : (
            <>
              {/* Type selection */}
              <div>
                <label className="block text-sm font-bold text-slate-800 mb-2">اختر نوع العملية:</label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setEntryType('مبيعات')}
                    className={`p-4 rounded-2xl border font-bold text-sm transition flex items-center justify-center gap-2 ${
                      entryType === 'مبيعات' 
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20' 
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span>تسجيل مبيعات</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEntryType('مشتريات')}
                    className={`p-4 rounded-2xl border font-bold text-sm transition flex items-center justify-center gap-2 ${
                      entryType === 'مشتريات' 
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20' 
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span>تسجيل مشتريات</span>
                  </button>
                </div>
              </div>

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
                    <span className="font-bold text-slate-800 text-sm">انقر لاختيار صور الفواتير أو اسحبها هنا</span>
                    <p className="text-xs text-slate-500 mt-0.5">JPG, PNG, WEBP, PDF</p>
                  </div>
                </label>
              </div>

              {selectedFiles.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-xs text-slate-700">الملفات المختارة ({selectedFiles.length})</span>
                    <button onClick={() => setSelectedFiles([])} className="text-xs text-red-600 hover:underline">إزالة الكل</button>
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
                  onClick={() => handleStartExtraction(false)}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-sm"
                >
                  إدخال يدوي مباشر ({selectedFiles.length})
                </button>
                <button
                  type="button"
                  disabled={selectedFiles.length === 0}
                  onClick={() => handleStartExtraction(true)}
                  className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-sm font-bold shadow-md flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>استخراج بالذكاء الاصطناعي ({selectedFiles.length})</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
