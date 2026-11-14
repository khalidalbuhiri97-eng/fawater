import React, { useEffect, useState } from 'react';
import {
  ChevronRight,
  ChevronLeft,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sparkles,
  Save,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import { InvoiceRecord, Operation, DocumentType } from '../types';
import { getInvoiceImage } from '../services/dbService';

interface ReviewWorkspaceProps {
  operation: Operation;
  activeInvoiceId: string;
  onUpdateOperation: (op: Operation) => void;
  onBackToDashboard: () => void;
  onSelectInvoice: (id: string) => void;
}

function toOptionalNum(val: any): number | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

function parseNumericInput(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : undefined;
}

export const ReviewWorkspace: React.FC<ReviewWorkspaceProps> = ({
  operation,
  activeInvoiceId,
  onUpdateOperation,
  onBackToDashboard,
  onSelectInvoice,
}) => {
  const invoices = operation.invoices || [];
  const currentIndex = Math.max(
    0,
    invoices.findIndex((i) => i.id === activeInvoiceId)
  );
  const currentInvoice = invoices[currentIndex] || invoices[0];

  const [zoom, setZoom] = useState(1);
  const [extractingSingle, setExtractingSingle] = useState(false);
  const [hydratedImages, setHydratedImages] = useState<Record<string, { base64: string; mimeType: string }>>({});
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadImages() {
      const updates: Record<string, { base64: string; mimeType: string }> = {};
      for (const inv of invoices) {
        if (inv.imageBase64) {
          updates[inv.id] = {
            base64: inv.imageBase64,
            mimeType: inv.imageMimeType || 'image/jpeg',
          };
        } else if (!hydratedImages[inv.id]) {
          const stored = await getInvoiceImage(inv.id);
          if (stored && !cancelled) {
            updates[inv.id] = {
              base64: stored.imageBase64,
              mimeType: stored.imageMimeType || 'image/jpeg',
            };
          }
        }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setHydratedImages((prev) => ({ ...prev, ...updates }));
      }
    }
    loadImages();
    return () => {
      cancelled = true;
    };
  }, [operation.id, invoices.length]);

  if (!currentInvoice) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center">
        <h3 className="text-xl font-bold text-slate-800 mb-2">لا توجد فواتير للمراجعة</h3>
        <p className="text-slate-500 mb-6">يرجى رفع صور أو فواتير جديدة أولاً.</p>
        <button
          onClick={onBackToDashboard}
          className="px-6 py-3 bg-emerald-600 text-white rounded-2xl font-bold shadow-md hover:bg-emerald-500 transition"
        >
          العودة للوحة التحكم
        </button>
      </div>
    );
  }

  const activeImg = currentInvoice.imageBase64
    ? { base64: currentInvoice.imageBase64, mimeType: currentInvoice.imageMimeType || 'image/jpeg' }
    : hydratedImages[currentInvoice.id];

  const isSales = currentInvoice.documentType === 'مبيعات';
  const isPurchases = currentInvoice.documentType === 'مشتريات';
  const needsType = currentInvoice.documentType === 'يحتاج تحديد النوع';
  const missingDate = !currentInvoice.invoiceDate || !currentInvoice.invoiceDate.trim();
  const missingCashNetworkSplit =
    isSales && currentInvoice.cashSales === undefined && currentInvoice.networkSales === undefined;

  const updateInvoiceInList = (updatedInv: InvoiceRecord) => {
    const newInvoices = invoices.map((inv) => (inv.id === updatedInv.id ? updatedInv : inv));
    onUpdateOperation({
      ...operation,
      invoices: newInvoices,
      updatedAt: new Date().toISOString().split('T')[0],
    });
  };

  const handleFieldChange = (field: keyof InvoiceRecord, value: any) => {
    const updated: InvoiceRecord = {
      ...currentInvoice,
      [field]: value,
      updatedAt: new Date().toISOString().split('T')[0],
    };

    if (updated.documentType === 'مبيعات') {
      if (field === 'cashSales' || field === 'networkSales') {
        const cash = field === 'cashSales' ? value : currentInvoice.cashSales;
        const net = field === 'networkSales' ? value : currentInvoice.networkSales;
        if (cash !== undefined || net !== undefined) {
          updated.grandTotal = Number(cash ?? 0) + Number(net ?? 0);
        }
      }
    } else if (updated.documentType === 'مشتريات') {
      if (field === 'subtotal' || field === 'taxAmount') {
        const sub = field === 'subtotal' ? value : currentInvoice.subtotal;
        const tax = field === 'taxAmount' ? value : currentInvoice.taxAmount;
        if (sub !== undefined || tax !== undefined) {
          updated.grandTotal = Number(sub ?? 0) + Number(tax ?? 0);
        }
      }
    }

    updateInvoiceInList(updated);
  };

  const handleApproveAndNext = () => {
    if (needsType) {
      setMsg({ type: 'error', text: 'يرجى تحديد نوع الفاتورة (مبيعات أو مشتريات) قبل الاعتماد.' });
      return;
    }
    if (missingDate) {
      setMsg({ type: 'error', text: 'يرجى إدخال تاريخ الفاتورة قبل الاعتماد (لا يتم افتراض تاريخ تلقائي).' });
      return;
    }
    if (isSales && missingCashNetworkSplit) {
      setMsg({
        type: 'error',
        text: 'يرجى إدخال قيمة المبيعات النقدية (الكاش) أو الشبكة على الأقل قبل اعتماد فاتورة المبيعات.',
      });
      return;
    }

    const updated: InvoiceRecord = {
      ...currentInvoice,
      status: 'مكتملة',
      updatedAt: new Date().toISOString().split('T')[0],
    };
    updateInvoiceInList(updated);
    setMsg({
      type: 'success',
      text: 'تم اعتماد الفاتورة وحفظ بياناتها؛ يمكنك تنزيل ملف Excel المحدث من مركز التصدير.',
    });
    setTimeout(() => setMsg(null), 3500);

    if (currentIndex < invoices.length - 1) {
      onSelectInvoice(invoices[currentIndex + 1].id);
    }
  };

  const handleRunAiForThis = async () => {
    if (!activeImg?.base64) return;
    setExtractingSingle(true);
    setMsg(null);

    try {
      const res = await fetch('/api/extract-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: activeImg.base64,
          mimeType: activeImg.mimeType || 'image/jpeg',
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

        const updated: InvoiceRecord = {
          ...currentInvoice,
          documentType: classifiedType,
          classificationReason: ext.classificationReason || '',
          invoiceNumber: ext.invoiceNumber || currentInvoice.invoiceNumber,
          invoiceDate: ext.invoiceDate || currentInvoice.invoiceDate,
          day: ext.day || currentInvoice.day,
          issuerName: ext.issuerName || currentInvoice.issuerName,
          clientName: ext.clientName || currentInvoice.clientName,
          issuerTaxId: ext.issuerTaxId || currentInvoice.issuerTaxId,
          clientTaxId: ext.clientTaxId || currentInvoice.clientTaxId,
          currency: ext.currency || currentInvoice.currency,
          subtotal: toOptionalNum(ext.subtotal) ?? currentInvoice.subtotal,
          taxAmount: toOptionalNum(ext.taxAmount) ?? currentInvoice.taxAmount,
          taxRate: toOptionalNum(ext.taxRate) ?? currentInvoice.taxRate,
          discount: toOptionalNum(ext.discount) ?? currentInvoice.discount,
          grandTotal: toOptionalNum(ext.grandTotal) ?? currentInvoice.grandTotal,
          cashSales: toOptionalNum(ext.cashSales) ?? currentInvoice.cashSales,
          networkSales: toOptionalNum(ext.networkSales) ?? currentInvoice.networkSales,
          notes: ext.notes || currentInvoice.notes,
          items: Array.isArray(ext.items)
            ? ext.items.map((it: any, idx: number) => ({
                id: `${currentInvoice.id}_item_${idx}`,
                name: String(it?.name || ''),
                code: it?.code ? String(it.code) : undefined,
                quantity: toOptionalNum(it?.quantity),
                unit: it?.unit ? String(it.unit) : undefined,
                unitPrice: toOptionalNum(it?.unitPrice),
                discount: toOptionalNum(it?.discount),
                tax: toOptionalNum(it?.tax),
                total: toOptionalNum(it?.total),
              }))
            : currentInvoice.items,
          customFieldsValues:
            ext.customFieldsExtracted && typeof ext.customFieldsExtracted === 'object'
              ? { ...currentInvoice.customFieldsValues, ...ext.customFieldsExtracted }
              : currentInvoice.customFieldsValues,
          status: 'تحتاج مراجعة',
          errorMessage: undefined,
          updatedAt: new Date().toISOString().split('T')[0],
        };
        updateInvoiceInList(updated);
        setMsg({ type: 'success', text: 'تم استخراج بيانات الفاتورة وتصنيفها عبر Gemini AI.' });
      } else {
        setMsg({ type: 'error', text: data.error || 'فشل الاستخراج الذكي' });
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || 'خطأ في الاتصال بالخادم' });
    } finally {
      setExtractingSingle(false);
    }
  };

  const salesCalculatedTotal =
    currentInvoice.cashSales !== undefined || currentInvoice.networkSales !== undefined
      ? Number(currentInvoice.cashSales ?? 0) + Number(currentInvoice.networkSales ?? 0)
      : undefined;

  const purchasesCalculatedTotal =
    currentInvoice.subtotal !== undefined || currentInvoice.taxAmount !== undefined
      ? Number(currentInvoice.subtotal ?? 0) + Number(currentInvoice.taxAmount ?? 0)
      : currentInvoice.grandTotal;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Top Header & Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackToDashboard}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
          >
            العودة للوحة التحكم
          </button>
          <div className="h-5 w-px bg-slate-300"></div>
          <span className="text-sm font-bold text-slate-800">
            فاتورة {currentIndex + 1} من {invoices.length}
          </span>
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold ${
              currentInvoice.status === 'مكتملة'
                ? 'bg-emerald-100 text-emerald-800'
                : currentInvoice.status === 'فشل'
                ? 'bg-red-100 text-red-800'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {currentInvoice.status}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            disabled={currentIndex === 0}
            onClick={() => onSelectInvoice(invoices[currentIndex - 1].id)}
            className="flex items-center gap-1 px-4 py-2 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 disabled:opacity-40 hover:bg-slate-50 transition"
          >
            <ChevronRight className="w-4 h-4" />
            <span>السابق</span>
          </button>
          <button
            disabled={currentIndex >= invoices.length - 1}
            onClick={() => onSelectInvoice(invoices[currentIndex + 1].id)}
            className="flex items-center gap-1 px-4 py-2 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 disabled:opacity-40 hover:bg-slate-50 transition"
          >
            <span>التالي</span>
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      {msg && (
        <div
          className={`p-4 rounded-2xl text-sm font-medium flex items-center gap-2 ${
            msg.type === 'success'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}
        >
          {msg.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
          )}
          <span>{msg.text}</span>
        </div>
      )}

      {/* Warnings for missing critical fields */}
      {(needsType || missingDate || missingCashNetworkSplit || currentInvoice.errorMessage) && (
        <div className="space-y-2">
          {currentInvoice.errorMessage && (
            <div className="p-3.5 rounded-2xl bg-red-50 border border-red-200 text-red-800 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>خطأ الاستخراج السابق: {currentInvoice.errorMessage}</span>
            </div>
          )}
          {needsType && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                يحتاج تحديد النوع: لم يحسم الذكاء الاصطناعي ما إذا كانت الفاتورة مبيعات أم مشتريات. يرجى اختيار التصنيف الصحيح أدناه.
              </span>
            </div>
          )}
          {missingDate && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>تاريخ الفاتورة غير مقروء أو غير موجود في المستند. يرجى إدخال التاريخ يدوياً قبل الاعتماد.</span>
            </div>
          )}
          {missingCashNetworkSplit && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                تقسيم المبيعات بين الكاش والشبكة غير مذكور في الفاتورة
                {currentInvoice.grandTotal !== undefined
                  ? ` (الإجمالي المستخرج: ${currentInvoice.grandTotal.toFixed(2)})`
                  : ''}
                . لم يتم افتراض أي تقسيم تلقائي؛ يرجى إدخالهما يدوياً.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Side: Invoice Image Viewer */}
        <div className="lg:col-span-5 bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden sticky top-20">
          <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-bold truncate max-w-[220px]">
              {currentInvoice.imageFileName || 'صورة المستند'}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setZoom((z) => Math.min(z + 0.25, 3))}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                title="تكبير"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                title="تصغير"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                onClick={() => setZoom(1)}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                title="إعادة ضبط"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="p-4 bg-slate-950 flex items-center justify-center min-h-[460px] max-h-[580px] overflow-auto relative">
            {activeImg?.base64 ? (
              activeImg.mimeType === 'application/pdf' ? (
                <embed
                  src={`data:application/pdf;base64,${activeImg.base64}`}
                  type="application/pdf"
                  className="w-full h-[520px] rounded-lg"
                />
              ) : (
                <img
                  src={`data:${activeImg.mimeType || 'image/jpeg'};base64,${activeImg.base64}`}
                  alt="معاينة الفاتورة"
                  style={{ transform: `scale(${zoom})`, transition: 'transform 0.2s ease' }}
                  className="max-h-[530px] object-contain rounded-lg shadow-md"
                />
              )
            ) : (
              <div className="text-slate-500 text-sm">لا توجد صورة مرفقة لهذه الفاتورة</div>
            )}
          </div>

          <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
            <button
              onClick={handleRunAiForThis}
              disabled={extractingSingle || !activeImg?.base64}
              className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              <Sparkles className="w-4 h-4" />
              <span>{extractingSingle ? 'جاري الاستخراج...' : 'إعادة الاستخراج بالذكاء الاصطناعي'}</span>
            </button>

            <span
              className={`px-3 py-1 rounded-full text-xs font-bold ${
                needsType
                  ? 'bg-amber-100 text-amber-800'
                  : isSales
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-blue-100 text-blue-800'
              }`}
            >
              {currentInvoice.documentType}
            </span>
          </div>

          {/* Thumbnails strip */}
          <div className="p-3 bg-white border-t border-slate-200 flex gap-2 overflow-x-auto">
            {invoices.map((inv, idx) => {
              const thumb = inv.imageBase64
                ? { base64: inv.imageBase64, mimeType: inv.imageMimeType || 'image/jpeg' }
                : hydratedImages[inv.id];
              return (
                <button
                  key={inv.id}
                  onClick={() => onSelectInvoice(inv.id)}
                  className={`w-12 h-12 rounded-xl border-2 shrink-0 overflow-hidden relative transition ${
                    inv.id === currentInvoice.id
                      ? 'border-emerald-600 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 opacity-60 hover:opacity-100'
                  }`}
                >
                  {thumb?.base64 && thumb.mimeType !== 'application/pdf' ? (
                    <img
                      src={`data:${thumb.mimeType};base64,${thumb.base64}`}
                      alt={`فاتورة ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-slate-100 flex items-center justify-center text-[10px] font-bold">
                      {idx + 1}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Side: Editable Structured Form */}
        <div className="lg:col-span-7 bg-white rounded-3xl border border-slate-200 shadow-xs p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <h3 className="font-extrabold text-lg text-slate-900">
                {isSales
                  ? 'مراجعة بيانات المبيعات'
                  : isPurchases
                  ? 'مراجعة بيانات المشتريات والموردين'
                  : 'مراجعة وتحديد نوع الفاتورة'}
              </h3>
              <p className="text-xs text-slate-500">
                حقول الإدخال مطابقة لأعمدة قالب Excel الرسمي دون أي افتراضات تلقائية
              </p>
            </div>
            <button
              onClick={handleApproveAndNext}
              className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-sm font-bold shadow-md transition"
            >
              <Save className="w-4 h-4" />
              <span>اعتماد الفاتورة والتالية</span>
            </button>
          </div>

          {/* Classification selector */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-bold text-slate-800">تصنيف الفاتورة (الورقة المستهدفة في Excel):</label>
              {currentInvoice.classificationReason && (
                <span className="text-[11px] text-slate-500">سبب التصنيف: {currentInvoice.classificationReason}</span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(['مبيعات', 'مشتريات', 'يحتاج تحديد النوع'] as DocumentType[]).map((typeOpt) => (
                <button
                  key={typeOpt}
                  type="button"
                  onClick={() => handleFieldChange('documentType', typeOpt)}
                  className={`py-2.5 px-3 rounded-xl text-xs font-bold border transition ${
                    currentInvoice.documentType === typeOpt
                      ? typeOpt === 'يحتاج تحديد النوع'
                        ? 'bg-amber-100 border-amber-500 text-amber-900'
                        : 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {typeOpt}
                </button>
              ))}
            </div>
          </div>

          {isSales ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  التاريخ <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={currentInvoice.invoiceDate || ''}
                  onChange={(e) => handleFieldChange('invoiceDate', e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-xs outline-none bg-white text-slate-800 font-medium ${
                    missingDate ? 'border-amber-400 bg-amber-50/30' : 'border-slate-300'
                  }`}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">اليوم</label>
                <input
                  type="text"
                  value={currentInvoice.day || ''}
                  onChange={(e) => handleFieldChange('day', e.target.value)}
                  placeholder="مثال: السبت"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">المبيعات النقدية (الكاش)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.cashSales ?? ''}
                  onChange={(e) => handleFieldChange('cashSales', parseNumericInput(e.target.value))}
                  placeholder="غير محدد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">الشبكة (POS)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.networkSales ?? ''}
                  onChange={(e) => handleFieldChange('networkSales', parseNumericInput(e.target.value))}
                  placeholder="غير محدد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div className="sm:col-span-2 bg-emerald-50/60 p-4 rounded-2xl border border-emerald-200 flex items-center justify-between">
                <div>
                  <label className="block text-xs font-bold text-emerald-900 mb-1">
                    إجمالي المبيعات (يُحسب بمعادلة Excel: =C+D)
                  </label>
                  <div className="text-xl font-extrabold text-emerald-800">
                    {salesCalculatedTotal !== undefined ? `${salesCalculatedTotal.toFixed(2)}` : 'بانتظار إدخال الكاش/الشبكة'}
                  </div>
                </div>
                {currentInvoice.grandTotal !== undefined && (
                  <div className="text-left text-xs text-slate-600">
                    <span className="block text-[11px] text-slate-500">الإجمالي المستخرج من الفاتورة:</span>
                    <span className="font-bold">{currentInvoice.grandTotal.toFixed(2)} {currentInvoice.currency}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">رصيد الكاش (اختياري)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.cashBalance ?? ''}
                  onChange={(e) => handleFieldChange('cashBalance', parseNumericInput(e.target.value))}
                  placeholder="يُترك فارغاً إذا لم يوجد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">رصيد الصندوق (اختياري)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.cashBoxBalance ?? ''}
                  onChange={(e) => handleFieldChange('cashBoxBalance', parseNumericInput(e.target.value))}
                  placeholder="يُترك فارغاً إذا لم يوجد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">رصيد الشبكة / البنك (اختياري)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.networkBalance ?? ''}
                  onChange={(e) => handleFieldChange('networkBalance', parseNumericInput(e.target.value))}
                  placeholder="يُترك فارغاً إذا لم يوجد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  التاريخ <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={currentInvoice.invoiceDate || ''}
                  onChange={(e) => handleFieldChange('invoiceDate', e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-xs outline-none bg-white text-slate-800 font-medium ${
                    missingDate ? 'border-amber-400 bg-amber-50/30' : 'border-slate-300'
                  }`}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">اسم المورد</label>
                <input
                  type="text"
                  value={currentInvoice.issuerName || ''}
                  onChange={(e) => handleFieldChange('issuerName', e.target.value)}
                  placeholder="اسم المورد أو الشركة"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">المبلغ قبل الضريبة</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.subtotal ?? ''}
                  onChange={(e) => handleFieldChange('subtotal', parseNumericInput(e.target.value))}
                  placeholder="غير محدد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ضريبة القيمة المضافة (VAT)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.taxAmount ?? ''}
                  onChange={(e) => handleFieldChange('taxAmount', parseNumericInput(e.target.value))}
                  placeholder="غير محدد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div className="sm:col-span-2 bg-emerald-50/60 p-4 rounded-2xl border border-emerald-200 flex items-center justify-between">
                <div>
                  <label className="block text-xs font-bold text-emerald-900 mb-1">
                    الإجمالي شامل الضريبة (يُحسب بمعادلة Excel: =C+D)
                  </label>
                  <div className="text-xl font-extrabold text-emerald-800">
                    {purchasesCalculatedTotal !== undefined ? `${purchasesCalculatedTotal.toFixed(2)}` : 'غير محدد'}
                  </div>
                </div>
                {currentInvoice.taxRate !== undefined && (
                  <span className="text-xs font-semibold text-emerald-900">
                    نسبة الضريبة المستخرجة: {currentInvoice.taxRate}%
                  </span>
                )}
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">الرصيد (اختياري)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.balance ?? ''}
                  onChange={(e) => handleFieldChange('balance', parseNumericInput(e.target.value))}
                  placeholder="يُترك فارغاً إذا لم يوجد"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>
            </div>
          )}

          {/* Extra extracted metadata */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-100">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">رقم الفاتورة</label>
              <input
                type="text"
                value={currentInvoice.invoiceNumber || ''}
                onChange={(e) => handleFieldChange('invoiceNumber', e.target.value)}
                placeholder="—"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 text-slate-800"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">اسم العميل</label>
              <input
                type="text"
                value={currentInvoice.clientName || ''}
                onChange={(e) => handleFieldChange('clientName', e.target.value)}
                placeholder="—"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 text-slate-800"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">الرقم الضريبي</label>
              <input
                type="text"
                value={currentInvoice.issuerTaxId || ''}
                onChange={(e) => handleFieldChange('issuerTaxId', e.target.value)}
                placeholder="—"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 text-slate-800"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">العملة</label>
              <input
                type="text"
                value={currentInvoice.currency || ''}
                onChange={(e) => handleFieldChange('currency', e.target.value)}
                placeholder="—"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 text-slate-800"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">ملاحظات إضافية</label>
            <textarea
              rows={2}
              value={currentInvoice.notes || ''}
              onChange={(e) => handleFieldChange('notes', e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
