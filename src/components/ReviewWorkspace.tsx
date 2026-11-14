import React, { useState } from 'react';
import { 
  ChevronRight, ChevronLeft, ZoomIn, ZoomOut, RotateCcw, Sparkles, Save, Trash2, Plus, 
  CheckCircle2, AlertCircle, FileText, Building2, Calendar, Hash, DollarSign, Percent, Tag 
} from 'lucide-react';
import { InvoiceRecord, Operation, DocumentType } from '../types';

interface ReviewWorkspaceProps {
  operation: Operation;
  activeInvoiceId: string;
  onUpdateOperation: (op: Operation) => void;
  onBackToDashboard: () => void;
  onSelectInvoice: (id: string) => void;
}

export const ReviewWorkspace: React.FC<ReviewWorkspaceProps> = ({
  operation,
  activeInvoiceId,
  onUpdateOperation,
  onBackToDashboard,
  onSelectInvoice,
}) => {
  const invoices = operation.invoices || [];
  const currentIndex = invoices.findIndex(i => i.id === activeInvoiceId);
  const currentInvoice = invoices[currentIndex] || invoices[0];

  const [zoom, setZoom] = useState(1);
  const [extractingSingle, setExtractingSingle] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  const isSales = currentInvoice.documentType === 'مبيعات' || currentInvoice.documentType === 'فاتورة ضريبية';

  const handleFieldChange = (field: keyof InvoiceRecord, value: any) => {
    const updated = { ...currentInvoice, [field]: value, updatedAt: new Date().toISOString().split('T')[0] };
    
    if (isSales) {
      if (['cashSales', 'networkSales'].includes(field)) {
        const cash = Number(field === 'cashSales' ? value : currentInvoice.cashSales || 0);
        const net = Number(field === 'networkSales' ? value : currentInvoice.networkSales || 0);
        updated.grandTotal = cash + net;
      }
    } else {
      if (['subtotal', 'taxAmount'].includes(field)) {
        const sub = Number(field === 'subtotal' ? value : currentInvoice.subtotal || 0);
        const tax = Number(field === 'taxAmount' ? value : currentInvoice.taxAmount || 0);
        updated.grandTotal = sub + tax;
      }
    }

    updateInvoiceInList(updated);
  };

  const updateInvoiceInList = (updatedInv: InvoiceRecord) => {
    const newInvoices = invoices.map(inv => inv.id === updatedInv.id ? updatedInv : inv);
    onUpdateOperation({
      ...operation,
      invoices: newInvoices,
      updatedAt: new Date().toISOString().split('T')[0]
    });
  };

  const handleSaveAndNext = () => {
    const updated = { ...currentInvoice, status: 'مكتملة' as const };
    updateInvoiceInList(updated);
    setMsg({ type: 'success', text: 'تم حفظ الفاتورة وتحديث ملف Excel بالمعادلات بنجاح' });
    setTimeout(() => setMsg(null), 3000);

    if (currentIndex < invoices.length - 1) {
      onSelectInvoice(invoices[currentIndex + 1].id);
    }
  };

  const handleRunAiForThis = async () => {
    if (!currentInvoice.imageBase64) return;
    setExtractingSingle(true);
    setMsg(null);

    try {
      const res = await fetch('/api/extract-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: currentInvoice.imageBase64,
          mimeType: currentInvoice.imageMimeType || 'image/jpeg',
          customFields: operation.customFields
        })
      });

      const data = await res.json();
      if (data.success && data.data) {
        const ext = data.data;
        const updated: InvoiceRecord = {
          ...currentInvoice,
          invoiceDate: ext.invoiceDate || currentInvoice.invoiceDate,
          issuerName: ext.issuerName || currentInvoice.issuerName,
          subtotal: Number(ext.subtotal || currentInvoice.subtotal),
          taxAmount: Number(ext.taxAmount || currentInvoice.taxAmount),
          grandTotal: Number(ext.grandTotal || (Number(ext.subtotal || 0) + Number(ext.taxAmount || 0))),
          status: 'تحتاج مراجعة'
        };
        updateInvoiceInList(updated);
        setMsg({ type: 'success', text: 'تم استخراج بيانات الفاتورة بنجاح عبر Gemini AI' });
      } else {
        setMsg({ type: 'error', text: data.error || 'فشل الاستخراج الذكي' });
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || 'خطأ في الاتصال بالخادم' });
    } finally {
      setExtractingSingle(false);
      setTimeout(() => setMsg(null), 4000);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Top Header & Navigation */}
      <div className="flex items-center justify-between bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
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
          <span className={`px-3 py-1 rounded-full text-xs font-bold ${
            currentInvoice.status === 'مكتملة' ? 'bg-emerald-100 text-emerald-800' :
            currentInvoice.status === 'فشل' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
          }`}>
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
            disabled={currentIndex === invoices.length - 1}
            onClick={() => onSelectInvoice(invoices[currentIndex + 1].id)}
            className="flex items-center gap-1 px-4 py-2 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 disabled:opacity-40 hover:bg-slate-50 transition"
          >
            <span>التالي</span>
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      {msg && (
        <div className={`p-4 rounded-2xl text-sm font-medium flex items-center gap-2 ${
          msg.type === 'success' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {msg.type === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <AlertCircle className="w-5 h-5 text-red-600" />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Side: Invoice Image Viewer */}
        <div className="lg:col-span-5 bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden sticky top-20">
          <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between">
            <span className="text-xs font-bold truncate max-w-[220px]">{currentInvoice.imageFileName || 'صورة المستند'}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setZoom(z => Math.min(z + 0.25, 3))}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                title="تكبير"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => setZoom(z => Math.max(z - 0.25, 0.5))}
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

          <div className="p-4 bg-slate-950 flex items-center justify-center min-h-[480px] max-h-[600px] overflow-auto relative">
            {currentInvoice.imageBase64 ? (
              <img
                src={`data:${currentInvoice.imageMimeType || 'image/jpeg'};base64,${currentInvoice.imageBase64}`}
                alt="Invoice preview"
                style={{ transform: `scale(${zoom})`, transition: 'transform 0.2s ease' }}
                className="max-h-[550px] object-contain rounded-lg shadow-md"
              />
            ) : (
              <div className="text-slate-500 text-sm">لا توجد صورة مرفقة لهذه الفاتورة</div>
            )}
          </div>

          <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
            <button
              onClick={handleRunAiForThis}
              disabled={extractingSingle || !currentInvoice.imageBase64}
              className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              <Sparkles className="w-4 h-4" />
              <span>{extractingSingle ? 'جاري الاستخراج...' : 'استخراج بالذكاء الاصطناعي'}</span>
            </button>

            <span className="px-3 py-1 bg-emerald-100 text-emerald-800 rounded-full text-xs font-bold">
              {currentInvoice.documentType}
            </span>
          </div>

          {/* Thumbnails strip */}
          <div className="p-3 bg-white border-t border-slate-200 flex gap-2 overflow-x-auto">
            {invoices.map((inv, idx) => (
              <button
                key={inv.id}
                onClick={() => onSelectInvoice(inv.id)}
                className={`w-12 h-12 rounded-xl border-2 shrink-0 overflow-hidden relative transition ${
                  inv.id === currentInvoice.id ? 'border-emerald-600 ring-2 ring-emerald-500/20' : 'border-slate-200 opacity-60 hover:opacity-100'
                }`}
              >
                {inv.imageBase64 ? (
                  <img src={`data:${inv.imageMimeType || 'image/jpeg'};base64,${inv.imageBase64}`} alt="thumb" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-slate-100 flex items-center justify-center text-[10px] font-bold">{idx + 1}</div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Right Side: Structured Form matching exact official template columns */}
        <div className="lg:col-span-7 bg-white rounded-3xl border border-slate-200 shadow-xs p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <h3 className="font-extrabold text-lg text-slate-900">
                {isSales ? 'تسجيل ومراجعة المبيعات' : 'تسجيل ومراجعة المشتريات والموردين'}
              </h3>
              <p className="text-xs text-slate-500">حقول البيانات مطابقة تماماً لأعمدة قالب Excel الرسمي</p>
            </div>
            <button
              onClick={handleSaveAndNext}
              className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-sm font-bold shadow-md transition"
            >
              <Save className="w-4 h-4" />
              <span>حفظ والانتقال للتالية</span>
            </button>
          </div>

          {isSales ? (
            /* Sales Fields matching official template */
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">التاريخ</label>
                <input
                  type="date"
                  value={currentInvoice.invoiceDate || ''}
                  onChange={(e) => handleFieldChange('invoiceDate', e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-medium"
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
                  value={currentInvoice.cashSales || 0}
                  onChange={(e) => handleFieldChange('cashSales', parseFloat(e.target.value) || 0)}
                  placeholder="0.00"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">الشبكة (POS)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.networkSales || 0}
                  onChange={(e) => handleFieldChange('networkSales', parseFloat(e.target.value) || 0)}
                  placeholder="0.00"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div className="sm:col-span-2 bg-emerald-50/60 p-4 rounded-2xl border border-emerald-200">
                <label className="block text-xs font-bold text-emerald-900 mb-1">إجمالي المبيعات (يحسب بمعادلة Excel: =C+D)</label>
                <div className="text-xl font-extrabold text-emerald-800">
                  {((currentInvoice.cashSales || 0) + (currentInvoice.networkSales || 0)).toFixed(2)} SAR
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">رصيد الكاش</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.cashBalance || 0}
                  onChange={(e) => handleFieldChange('cashBalance', parseFloat(e.target.value) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">رصيد الصندوق</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.cashBoxBalance || 0}
                  onChange={(e) => handleFieldChange('cashBoxBalance', parseFloat(e.target.value) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">رصيد الشبكة (البنك)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.networkBalance || 0}
                  onChange={(e) => handleFieldChange('networkBalance', parseFloat(e.target.value) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
              </div>
            </div>
          ) : (
            /* Purchases Fields matching official template */
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">التاريخ</label>
                <input
                  type="date"
                  value={currentInvoice.invoiceDate || ''}
                  onChange={(e) => handleFieldChange('invoiceDate', e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-medium"
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
                  value={currentInvoice.subtotal || 0}
                  onChange={(e) => handleFieldChange('subtotal', parseFloat(e.target.value) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ضريبة القيمة المضافة (VAT)</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.taxAmount || 0}
                  onChange={(e) => handleFieldChange('taxAmount', parseFloat(e.target.value) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800 font-bold"
                />
              </div>

              <div className="sm:col-span-2 bg-emerald-50/60 p-4 rounded-2xl border border-emerald-200">
                <label className="block text-xs font-bold text-emerald-900 mb-1">الإجمالي شامل الضريبة (يحسب بمعادلة Excel: =C+D)</label>
                <div className="text-xl font-extrabold text-emerald-800">
                  {((currentInvoice.subtotal || 0) + (currentInvoice.taxAmount || 0)).toFixed(2)} SAR
                </div>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">الرصيد</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentInvoice.balance || 0}
                  onChange={(e) => handleFieldChange('balance', parseFloat(e.target.value) || 0)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                />
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
