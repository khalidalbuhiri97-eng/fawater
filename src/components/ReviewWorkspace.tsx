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
  Image as ImageIcon,
} from 'lucide-react';
import { InvoiceRecord, Operation, DocumentType } from '../types';
import { getInvoiceImage, saveInvoiceImage } from '../services/dbService';
import { generateUuid } from '../services/localStore';
import {
  getOfficialTemplate,
  getSheetSchemaByType,
  TemplateSheetInfo,
} from '../services/templateService';
import { DynamicTemplateFields } from './DynamicTemplateFields';

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
  const [aiClassifyHint, setAiClassifyHint] = useState<'auto' | 'مبيعات' | 'مشتريات'>('auto');
  const [templateSheets, setTemplateSheets] = useState<TemplateSheetInfo[]>([]);
  const [hydratedImages, setHydratedImages] = useState<Record<string, { base64: string; mimeType: string }>>({});
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!currentInvoice) return;
    if (currentInvoice.documentType === 'مبيعات' || currentInvoice.documentType === 'مشتريات') {
      setAiClassifyHint(currentInvoice.documentType);
    } else {
      setAiClassifyHint('auto');
    }
  }, [currentInvoice?.id]);

  useEffect(() => {
    getOfficialTemplate()
      .then((tpl) => setTemplateSheets(tpl.sheets))
      .catch(() => {});
  }, []);

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
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-100 px-4 py-16 text-center">
        <h3 className="text-xl font-bold text-slate-800 mb-2">لا توجد فواتير للمراجعة</h3>
        <p className="text-slate-500 mb-6">يرجى رفع صور أو إضافة فواتير جديدة أولاً.</p>
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

  const activeSheetInfo =
    isSales || isPurchases ? getSheetSchemaByType(templateSheets, isSales ? 'مبيعات' : 'مشتريات') : undefined;

  const updateInvoiceInList = (updatedInv: InvoiceRecord) => {
    const nowIso = new Date().toISOString();
    const normalizedInv: InvoiceRecord = {
      ...updatedInv,
      syncStatus: 'pending',
      updatedAt: nowIso,
      status:
        updatedInv.status === 'مكتملة' &&
        (!updatedInv.invoiceDate?.trim() || updatedInv.documentType === 'يحتاج تحديد النوع')
          ? 'تحتاج مراجعة'
          : updatedInv.status,
    };
    const newInvoices = invoices.map((inv) => (inv.id === normalizedInv.id ? normalizedInv : inv));
    onUpdateOperation({
      ...operation,
      invoices: newInvoices,
      updatedAt: nowIso,
    });
  };

  const handleUpdateCurrentInvoice = (updater: (prev: InvoiceRecord) => InvoiceRecord) => {
    const next = updater(currentInvoice);
    updateInvoiceInList(next);
  };

  const handleFieldChange = (field: keyof InvoiceRecord, value: any) => {
    updateInvoiceInList({
      ...currentInvoice,
      [field]: value,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleApproveAndNext = async () => {
    if (needsType) {
      setMsg({ type: 'error', text: 'يرجى تحديد نوع الفاتورة (مبيعات أو مشتريات) قبل الاعتماد.' });
      return;
    }
    if (missingDate) {
      setMsg({ type: 'error', text: 'يرجى إدخال تاريخ الفاتورة قبل الاعتماد (لا يتم افتراض تاريخ تلقائي).' });
      return;
    }
    if (isSales) {
      const hasAnySales =
        currentInvoice.cashSales !== undefined ||
        currentInvoice.networkSales !== undefined ||
        currentInvoice.cashBalance !== undefined ||
        currentInvoice.cashBoxBalance !== undefined ||
        currentInvoice.networkBalance !== undefined;
      if (!hasAnySales) {
        setMsg({
          type: 'error',
          text: 'يرجى إدخال قيمة المبيعات النقدية (الكاش) أو الشبكة على الأقل قبل اعتماد فاتورة المبيعات.',
        });
        return;
      }
    }

    try {
      if (activeImg?.base64) {
        await saveInvoiceImage(currentInvoice.id, activeImg.base64, activeImg.mimeType, {
          organizationId: operation.id,
          fileName: currentInvoice.imageFileName,
          enqueueSync: true,
        });
      }

      const updated: InvoiceRecord = {
        ...currentInvoice,
        status: 'مكتملة',
        hasImage: Boolean(activeImg?.base64 || currentInvoice.hasImage),
        updatedAt: new Date().toISOString(),
      };
      updateInvoiceInList(updated);
      setMsg({
        type: 'success',
        text: 'تم اعتماد الفاتورة وحفظ جميع حقولها فعلياً؛ وهي جاهزة الآن للتصدير إلى Excel.',
      });

      if (currentIndex < invoices.length - 1) {
        onSelectInvoice(invoices[currentIndex + 1].id);
      }
    } catch (err: any) {
      setMsg({
        type: 'error',
        text: err?.message || 'فشل حفظ الفاتورة في التخزين المحلي.',
      });
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
          invoiceId: currentInvoice.id,
          imageBase64: activeImg.base64,
          mimeType: activeImg.mimeType || 'image/jpeg',
          fileName: currentInvoice.imageFileName,
          customFields: operation.customFields,
          organizationName: operation.name,
          activityType: operation.activityType,
          manualDocumentType: aiClassifyHint,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success && data.data) {
        const ext = data.data;
        const classifiedType: DocumentType =
          aiClassifyHint === 'مبيعات' || aiClassifyHint === 'مشتريات'
            ? aiClassifyHint
            : ext.documentType === 'مبيعات' || ext.documentType === 'مشتريات'
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
            ? ext.items.map((it: any) => ({
                id: generateUuid(),
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
          customFieldsValues: {
            ...(currentInvoice.customFieldsValues || {}),
            ...(ext.customFieldsExtracted && typeof ext.customFieldsExtracted === 'object' ? ext.customFieldsExtracted : {}),
            ...(ext.paymentMethod ? { __official_payment_method: ext.paymentMethod } : {}),
          },
          status: 'تحتاج مراجعة',
          errorMessage: undefined,
          updatedAt: new Date().toISOString(),
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

  return (
    <div className="fixed inset-0 z-[100] flex h-[100dvh] w-screen flex-col overflow-hidden bg-slate-100 p-2 text-slate-950 sm:p-3">
      {/* Top Header & Navigation */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-2 py-1.5 shadow-xs sm:px-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackToDashboard}
            className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 sm:px-3"
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
          {currentInvoice.entryMethod && (
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700">
              {currentInvoice.entryMethod === 'manual' ? 'إدخال يدوي' : 'ذكاء اصطناعي'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            disabled={currentIndex === 0}
            onClick={() => onSelectInvoice(invoices[currentIndex - 1].id)}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
            <span>السابق</span>
          </button>
          <button
            disabled={currentIndex >= invoices.length - 1}
            onClick={() => onSelectInvoice(invoices[currentIndex + 1].id)}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <span>التالي</span>
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      {msg && (
        <div
          className={`mx-1 my-1 flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${
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
        <div className="mx-1 my-1 max-h-20 shrink-0 space-y-1 overflow-y-auto">
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
              <span>تاريخ الفاتورة غير مقروء أو غير موجود. يرجى إدخال التاريخ يدوياً قبل الاعتماد.</span>
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

      {/* Split Screen Layout: Fixed/Sticky Image Viewer (Left) + Independent Scrollable Form Fields (Right) */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,46dvh)_minmax(0,1fr)] gap-2 overflow-hidden p-1 lg:grid-cols-12 lg:grid-rows-1 lg:gap-3">
        {/* Left Column (Sticky Image Viewer - remains fixed and visible while scrolling form fields on desktop; top fixed container on mobile) */}
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden lg:col-span-7">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 bg-slate-900 px-3 py-2 text-white">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold truncate max-w-[200px]">
                  {currentInvoice.imageFileName || 'معاينة المستند'}
                </span>
              </div>
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

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-950 p-2 sm:p-3">
              {activeImg?.base64 ? (
                activeImg.mimeType === 'application/pdf' ? (
                  <embed
                    src={`data:application/pdf;base64,${activeImg.base64}`}
                    type="application/pdf"
                    className="h-full min-h-[220px] w-full rounded-lg"
                  />
                ) : (
                  <img
                    src={`data:${activeImg.mimeType || 'image/jpeg'};base64,${activeImg.base64}`}
                    alt="معاينة الفاتورة"
                    style={{ transform: `scale(${zoom})`, transition: 'transform 0.2s ease' }}
                    className="h-auto max-h-full max-w-full object-contain rounded-lg shadow-md"
                  />
                )
              ) : (
                <div className="text-slate-400 text-xs py-12 text-center">لا توجد صورة مرفقة (إدخال يدوي)</div>
              )}
            </div>

            {activeImg?.base64 && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-800 bg-slate-900 px-2 py-1.5">
                <select
                  value={aiClassifyHint}
                  onChange={(e) => setAiClassifyHint(e.target.value as 'auto' | 'مبيعات' | 'مشتريات')}
                  disabled={extractingSingle}
                  aria-label="تصنيف الفاتورة للذكاء الاصطناعي"
                  className="max-w-[118px] rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-100 outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="auto">تلقائي (AI)</option>
                  <option value="مبيعات">مبيعات</option>
                  <option value="مشتريات">مشتريات</option>
                </select>
                <button
                  onClick={handleRunAiForThis}
                  disabled={extractingSingle}
                  title="إعادة تحليل بالذكاء الاصطناعي" aria-label="إعادة تحليل بالذكاء الاصطناعي" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-500 disabled:bg-slate-700"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="sr-only">{extractingSingle ? 'جاري التحليل...' : 'إعادة تحليل بالـ AI'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Thumbnails strip */}
          {invoices.length > 1 && (
            <div className="shrink-0 space-y-1 rounded-xl border border-slate-200 bg-white p-2 shadow-xs">
              <div className="text-[11px] font-bold text-slate-600">فواتير الدفعة ({invoices.length})</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
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
          )}
        </div>

        {/* Right Column (Scrollable Form Fields Area with NO duplicate fields) */}
        <div className="min-h-0 overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-xs sm:p-4 lg:col-span-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <h3 className="font-extrabold text-lg text-slate-900">
                {isSales
                  ? 'حقول ورقة المبيعات (من قالب Excel الرسمي)'
                  : isPurchases
                  ? 'حقول ورقة المشتريات والموردين (من قالب Excel الرسمي)'
                  : 'تحديد نوع الفاتورة لعرض حقول Excel'}
              </h3>
              <p className="text-xs text-slate-500">
                جميع الأعمدة مقروءة ديناميكياً من القالب الرسمي وتُحفظ لكل فاتورة بشكل مستقل (بدون أي حقول مكررة)
              </p>
            </div>
            <button
              onClick={handleApproveAndNext}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white shadow-sm transition hover:bg-emerald-500"
            >
              <Save className="w-4 h-4" />
              <span>حفظ واعتماد الفاتورة لـ Excel</span>
            </button>
          </div>

          {/* Independent Document Type Selector per Invoice */}
          <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
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
                  onClick={() => {
                    handleFieldChange('documentType', typeOpt);
                    setAiClassifyHint(typeOpt === 'يحتاج تحديد النوع' ? 'auto' : typeOpt);
                  }}
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

          {/* Dynamic Excel Fields */}
          {activeSheetInfo ? (
            <DynamicTemplateFields
              sheetInfo={activeSheetInfo}
              invoice={currentInvoice}
              onUpdateInvoice={handleUpdateCurrentInvoice}
            />
          ) : needsType ? (
            <div className="p-6 text-center rounded-2xl border border-dashed border-amber-300 bg-amber-50/40 text-xs text-amber-900">
              يرجى اختيار <strong>مبيعات</strong> أو <strong>مشتريات</strong> أعلاه لعرض جميع أعمدة ورقة Excel المقابلة.
            </div>
          ) : (
            <div className="text-xs text-slate-500 py-4 text-center">جاري تحميل حقول القالب الرسمي...</div>
          )}

          {/* Secondary Supplementary Metadata (Strictly NO duplicates with template columns) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 border-t border-slate-100">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">اسم العميل (اختياري)</label>
              <input
                type="text"
                value={currentInvoice.clientName || ''}
                onChange={(e) => handleFieldChange('clientName', e.target.value)}
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
                placeholder="SAR"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-slate-50 text-slate-800"
              />
            </div>
          </div>

          {(operation.customFields || []).length > 0 && (
            <div className="pt-4 border-t border-slate-100 space-y-2">
              <h4 className="text-xs font-bold text-slate-800">الحقول المخصصة للمؤسسة</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {operation.customFields.map((cf) => {
                  const currentVal =
                    currentInvoice.customFieldsValues?.[cf.id] ??
                    currentInvoice.customFieldsValues?.[cf.name] ??
                    '';
                  return (
                    <div key={cf.id}>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        {cf.name} ({cf.excelSheet})
                      </label>
                      {cf.type === 'قائمة خيارات' && cf.options?.length ? (
                        <select
                          value={currentVal}
                          onChange={(e) =>
                            handleFieldChange('customFieldsValues', {
                              ...currentInvoice.customFieldsValues,
                              [cf.id]: e.target.value,
                            })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white text-slate-800"
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
                          type={
                            cf.type === 'تاريخ'
                              ? 'date'
                              : cf.type === 'رقم' || cf.type === 'مبلغ' || cf.type === 'نسبة'
                              ? 'number'
                              : 'text'
                          }
                          value={currentVal}
                          onChange={(e) =>
                            handleFieldChange('customFieldsValues', {
                              ...currentInvoice.customFieldsValues,
                              [cf.id]: e.target.value,
                            })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs bg-white text-slate-800"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

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
