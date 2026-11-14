import React, { useState } from 'react';
import { 
  ChevronRight, ChevronLeft, ZoomIn, ZoomOut, RotateCcw, Sparkles, Save, Trash2, Plus, 
  CheckCircle2, AlertCircle, FileText, Building2, Calendar, Hash, DollarSign, Percent, Tag 
} from 'lucide-react';
import { InvoiceRecord, Operation, DocumentType, InvoiceItem } from '../types';

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

  const handleFieldChange = (field: keyof InvoiceRecord, value: any) => {
    const updated = { ...currentInvoice, [field]: value, updatedAt: new Date().toISOString().split('T')[0] };
    
    if (['subtotal', 'taxAmount', 'discount'].includes(field)) {
      const sub = Number(field === 'subtotal' ? value : currentInvoice.subtotal || 0);
      const tax = Number(field === 'taxAmount' ? value : currentInvoice.taxAmount || 0);
      const disc = Number(field === 'discount' ? value : currentInvoice.discount || 0);
      updated.grandTotal = sub + tax - disc;
    }

    updateInvoiceInList(updated);
  };

  const handleCustomFieldChange = (cfId: string, val: any) => {
    const customVals = { ...(currentInvoice.customFieldsValues || {}), [cfId]: val };
    const updated = { ...currentInvoice, customFieldsValues: customVals, updatedAt: new Date().toISOString().split('T')[0] };
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

  const handleAddItem = () => {
    const newItem: InvoiceItem = {
      id: 'item_' + Date.now(),
      name: '',
      code: '',
      quantity: 1,
      unit: 'حبة',
      unitPrice: 0,
      discount: 0,
      tax: 0,
      total: 0
    };
    const updatedItems = [...(currentInvoice.items || []), newItem];
    updateInvoiceInList({ ...currentInvoice, items: updatedItems });
  };

  const handleUpdateItem = (itemId: string, field: keyof InvoiceItem, val: any) => {
    const updatedItems = (currentInvoice.items || []).map(item => {
      if (item.id === itemId) {
        const updated = { ...item, [field]: val };
        if (['quantity', 'unitPrice', 'discount', 'tax'].includes(field)) {
          const qty = Number(field === 'quantity' ? val : item.quantity);
          const price = Number(field === 'unitPrice' ? val : item.unitPrice);
          const disc = Number(field === 'discount' ? val : item.discount);
          updated.total = (qty * price) - disc;
        }
        return updated;
      }
      return item;
    });
    updateInvoiceInList({ ...currentInvoice, items: updatedItems });
  };

  const handleDeleteItem = (itemId: string) => {
    const updatedItems = (currentInvoice.items || []).filter(item => item.id !== itemId);
    updateInvoiceInList({ ...currentInvoice, items: updatedItems });
  };

  const handleSaveAndNext = () => {
    const updated = { ...currentInvoice, status: 'مكتملة' as const };
    updateInvoiceInList(updated);
    setMsg({ type: 'success', text: 'تم حفظ الفاتورة وتحديث ملف Excel بنجاح' });
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
          invoiceNumber: ext.invoiceNumber || currentInvoice.invoiceNumber,
          invoiceDate: ext.invoiceDate || currentInvoice.invoiceDate,
          documentType: ext.documentType || currentInvoice.documentType,
          issuerName: ext.issuerName || currentInvoice.issuerName,
          clientName: ext.clientName || currentInvoice.clientName,
          issuerTaxId: ext.issuerTaxId || currentInvoice.issuerTaxId,
          clientTaxId: ext.clientTaxId || currentInvoice.clientTaxId,
          currency: ext.currency || currentInvoice.currency,
          subtotal: Number(ext.subtotal || currentInvoice.subtotal),
          taxAmount: Number(ext.taxAmount || currentInvoice.taxAmount),
          taxRate: Number(ext.taxRate || currentInvoice.taxRate),
          discount: Number(ext.discount || currentInvoice.discount),
          grandTotal: Number(ext.grandTotal || currentInvoice.grandTotal),
          notes: ext.notes || currentInvoice.notes,
          items: ext.items ? ext.items.map((it: any, idx: number) => ({
            id: 'item_' + idx + '_' + Date.now(),
            name: it.name || '',
            code: it.code || '',
            quantity: Number(it.quantity || 1),
            unit: it.unit || 'حبة',
            unitPrice: Number(it.unitPrice || 0),
            discount: Number(it.discount || 0),
            tax: Number(it.tax || 0),
            total: Number(it.total || 0)
          })) : currentInvoice.items,
          customFieldsValues: ext.customFieldsExtracted ? { ...currentInvoice.customFieldsValues, ...ext.customFieldsExtracted } : currentInvoice.customFieldsValues,
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

      {/* Main Split Workspace: Left side Image, Right side Data Form */}
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

            <span className="text-xs text-slate-500 font-medium">
              النوع: {currentInvoice.documentType}
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

        {/* Right Side: Structured Form */}
        <div className="lg:col-span-7 bg-white rounded-3xl border border-slate-200 shadow-xs p-6 space-y-6">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <h3 className="font-extrabold text-lg text-slate-900">مراجعة بيانات الفاتورة والمستند</h3>
              <p className="text-xs text-slate-500">قم بمراجعة البيانات وتعديلها يدوياً أو عبر الذكاء الاصطناعي</p>
            </div>
            <button
              onClick={handleSaveAndNext}
              className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-sm font-bold shadow-md transition"
            >
              <Save className="w-4 h-4" />
              <span>حفظ والانتقال للتالية</span>
            </button>
          </div>

          {/* Basic Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">نوع المستند</label>
              <select
                value={currentInvoice.documentType}
                onChange={(e) => handleFieldChange('documentType', e.target.value as DocumentType)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none bg-white text-slate-800"
              >
                {['مبيعات', 'مشتريات', 'مصروفات', 'مرتجعات', 'فاتورة ضريبية', 'سند قبض', 'سند صرف', 'أخرى'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">رقم الفاتورة</label>
              <input
                type="text"
                value={currentInvoice.invoiceNumber || ''}
                onChange={(e) => handleFieldChange('invoiceNumber', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
                placeholder="مثال: INV-2026-001"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">تاريخ الفاتورة</label>
              <input
                type="date"
                value={currentInvoice.invoiceDate || ''}
                onChange={(e) => handleFieldChange('invoiceDate', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">العملة</label>
              <input
                type="text"
                value={currentInvoice.currency || 'SAR'}
                onChange={(e) => handleFieldChange('currency', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">اسم المؤسسة المصدرة (البائع / المورد)</label>
              <input
                type="text"
                value={currentInvoice.issuerName || ''}
                onChange={(e) => handleFieldChange('issuerName', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">اسم العميل / المستلم</label>
              <input
                type="text"
                value={currentInvoice.clientName || ''}
                onChange={(e) => handleFieldChange('clientName', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">الرقم الضريبي للمؤسسة</label>
              <input
                type="text"
                value={currentInvoice.issuerTaxId || ''}
                onChange={(e) => handleFieldChange('issuerTaxId', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">الرقم الضريبي للعميل</label>
              <input
                type="text"
                value={currentInvoice.clientTaxId || ''}
                onChange={(e) => handleFieldChange('clientTaxId', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
              />
            </div>
          </div>

          {/* Financial Totals */}
          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">الإجمالي قبل الضريبة</label>
              <input
                type="number"
                step="0.01"
                value={currentInvoice.subtotal || 0}
                onChange={(e) => handleFieldChange('subtotal', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-bold bg-white outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">قيمة الضريبة</label>
              <input
                type="number"
                step="0.01"
                value={currentInvoice.taxAmount || 0}
                onChange={(e) => handleFieldChange('taxAmount', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-bold bg-white outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-600 mb-1">الخصم</label>
              <input
                type="number"
                step="0.01"
                value={currentInvoice.discount || 0}
                onChange={(e) => handleFieldChange('discount', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs font-bold bg-white outline-none text-slate-800"
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-emerald-700 mb-1">الإجمالي النهائي</label>
              <input
                type="number"
                step="0.01"
                value={currentInvoice.grandTotal || 0}
                onChange={(e) => handleFieldChange('grandTotal', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-emerald-400 text-xs font-extrabold bg-emerald-50 outline-none text-emerald-900"
              />
            </div>
          </div>

          {/* Custom Fields */}
          {operation.customFields && operation.customFields.length > 0 && (
            <div className="border-t border-slate-200 pt-4">
              <h4 className="font-bold text-xs text-slate-800 mb-3 uppercase tracking-wider">الحقول المخصصة للمؤسسة</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {operation.customFields.map((cf) => (
                  <div key={cf.id}>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">{cf.name}</label>
                    {cf.type === 'قائمة خيارات' && cf.options ? (
                      <select
                        value={currentInvoice.customFieldsValues?.[cf.id] || ''}
                        onChange={(e) => handleCustomFieldChange(cf.id, e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                      >
                        <option value="">اختر...</option>
                        {cf.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input
                        type={cf.type === 'رقم' || cf.type === 'مبلغ' ? 'number' : 'text'}
                        value={currentInvoice.customFieldsValues?.[cf.id] || ''}
                        onChange={(e) => handleCustomFieldChange(cf.id, e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-800"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Invoice Items Table */}
          <div className="border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-bold text-xs text-slate-800 uppercase tracking-wider">تفاصيل الأصناف ({currentInvoice.items?.length || 0})</h4>
              <button
                onClick={handleAddItem}
                className="flex items-center gap-1 px-3.5 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 rounded-xl text-xs font-bold transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>إضافة صنف</span>
              </button>
            </div>

            {(!currentInvoice.items || currentInvoice.items.length === 0) ? (
              <div className="p-4 bg-slate-50 rounded-xl text-center text-xs text-slate-500">
                لا توجد أصناف مضافة. انقر على "إضافة صنف" أو اعتمد على الاستخراج الذكي.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="bg-slate-100 text-slate-700">
                    <tr>
                      <th className="p-2.5">الصنف</th>
                      <th className="p-2.5 w-16">الكمية</th>
                      <th className="p-2.5 w-20">الوحدة</th>
                      <th className="p-2.5 w-24">السعر</th>
                      <th className="p-2.5 w-24">الإجمالي</th>
                      <th className="p-2.5 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {currentInvoice.items.map((item) => (
                      <tr key={item.id}>
                        <td className="p-2.5">
                          <input
                            type="text"
                            value={item.name}
                            onChange={(e) => handleUpdateItem(item.id, 'name', e.target.value)}
                            placeholder="اسم الصنف"
                            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 outline-none bg-white"
                          />
                        </td>
                        <td className="p-2.5">
                          <input
                            type="number"
                            value={item.quantity}
                            onChange={(e) => handleUpdateItem(item.id, 'quantity', parseFloat(e.target.value) || 0)}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 outline-none bg-white"
                          />
                        </td>
                        <td className="p-2.5">
                          <input
                            type="text"
                            value={item.unit}
                            onChange={(e) => handleUpdateItem(item.id, 'unit', e.target.value)}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 outline-none bg-white"
                          />
                        </td>
                        <td className="p-2.5">
                          <input
                            type="number"
                            step="0.01"
                            value={item.unitPrice}
                            onChange={(e) => handleUpdateItem(item.id, 'unitPrice', parseFloat(e.target.value) || 0)}
                            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 outline-none bg-white"
                          />
                        </td>
                        <td className="p-2.5 font-bold text-emerald-700">
                          {item.total.toFixed(2)}
                        </td>
                        <td className="p-2.5 text-center">
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="text-slate-400 hover:text-red-600 p-1 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">ملاحظات الفاتورة</label>
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
