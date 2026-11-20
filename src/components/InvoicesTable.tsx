import React, { useState } from 'react';
import { Search, Trash2, Edit3, AlertCircle } from 'lucide-react';
import { DocumentType, Operation } from '../types';
import { clearOperationInvoicesConfirmed, deleteInvoiceImage } from '../services/dbService';

interface InvoicesTableProps {
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
  onSelectForReview: (id: string) => void;
  onInvoicesCleared?: () => void;
}

export const InvoicesTable: React.FC<InvoicesTableProps> = ({
  operation,
  onUpdateOperation,
  onSelectForReview,
  onInvoicesCleared,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [actionError, setActionError] = useState('');
  const invoices = operation.invoices || [];

  const filteredInvoices = invoices.filter((inv) => {
    const matchesSearch =
      (inv.invoiceNumber && inv.invoiceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (inv.issuerName && inv.issuerName.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (inv.clientName && inv.clientName.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (inv.notes && inv.notes.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesType = filterType === 'all' || inv.documentType === filterType;
    return matchesSearch && matchesType;
  });

  const handleDelete = (id: string) => {
    deleteInvoiceImage(id).catch(() => {});
    const newInvoices = invoices.filter((i) => i.id !== id);
    onUpdateOperation({
      ...operation,
      invoices: newInvoices,
      updatedAt: new Date().toISOString(),
    });
  };

  const handleClearAllInvoices = async () => {
    setClearingAll(true);
    setActionError('');
    try {
      const updated = await clearOperationInvoicesConfirmed(operation.id);
      if (updated) {
        onUpdateOperation(updated);
      } else {
        onUpdateOperation({
          ...operation,
          invoices: [],
          updatedAt: new Date().toISOString(),
        });
      }
      setClearConfirmOpen(false);
      onInvoicesCleared?.();
    } catch (err: any) {
      setActionError(err?.message || 'تعذر حذف الفواتير السابقة.');
      setClearConfirmOpen(false);
    } finally {
      setClearingAll(false);
    }
  };

  const handleDocumentTypeChange = (id: string, nextType: DocumentType) => {
    const nowIso = new Date().toISOString();
    const newInvoices = invoices.map((inv) => {
      if (inv.id !== id) return inv;
      const nextStatus =
        nextType === 'يحتاج تحديد النوع' && inv.status === 'مكتملة'
          ? 'تحتاج مراجعة'
          : inv.status;
      return {
        ...inv,
        documentType: nextType,
        classificationReason: `تصنيف يدوي (${nextType})`,
        status: nextStatus,
        syncStatus: 'pending' as const,
        updatedAt: nowIso,
      };
    });
    onUpdateOperation({
      ...operation,
      invoices: newInvoices,
      updatedAt: nowIso,
    });
  };

  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h3 className="font-bold text-lg text-slate-900">سجلات الفواتير والمستندات ({filteredInvoices.length})</h3>
          <p className="text-xs text-slate-500">استعرض كافة الفواتير المستخرجة والمعتمدة للتصدير إلى ملف Excel</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="بحث برقم الفاتورة، البائع، العميل..."
              className="w-full pr-9 pl-4 py-2 rounded-xl border border-slate-300 text-xs outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50"
            />
          </div>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-300 text-xs outline-none bg-slate-50 text-slate-800"
          >
            <option value="all">كافة الأنواع</option>
            {['مبيعات', 'مشتريات', 'يحتاج تحديد النوع'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {invoices.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setActionError('');
                setClearConfirmOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 bg-red-50 text-red-700 hover:bg-red-600 hover:text-white text-xs font-bold transition shrink-0"
              title="حذف جميع الفواتير السابقة في هذه العملية"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>حذف الفواتير السابقة</span>
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mx-6 mt-4 p-3 rounded-xl border border-red-200 bg-red-50 text-red-800 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {filteredInvoices.length === 0 ? (
        <div className="p-12 text-center text-slate-500 text-sm">لا توجد فواتير مطابقة لبحثك.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="p-4">رقم الفاتورة</th>
                <th className="p-4">التاريخ</th>
                <th className="p-4">نوع المستند</th>
                <th className="p-4">المصدر (البائع/المورد)</th>
                <th className="p-4">قبل الضريبة / كاش</th>
                <th className="p-4">الضريبة / شبكة</th>
                <th className="p-4">الإجمالي النهائي</th>
                <th className="p-4">الحالة</th>
                <th className="p-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.map((inv) => {
                const isSales = inv.documentType === 'مبيعات';
                const col1 = isSales ? inv.cashSales : inv.subtotal;
                const col2 = isSales ? inv.networkSales : inv.taxAmount;
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/50 transition">
                    <td className="p-4 font-bold text-slate-900">{inv.invoiceNumber || 'بدون رقم'}</td>
                    <td className="p-4 text-slate-600">
                      {inv.invoiceDate || <span className="text-amber-600 font-semibold">غير محدد</span>}
                    </td>
                    <td className="p-4">
                      <select
                        value={inv.documentType}
                        onChange={(e) => handleDocumentTypeChange(inv.id, e.target.value as DocumentType)}
                        aria-label="تصنيف الفاتورة"
                        className={`px-2.5 py-1 rounded-lg font-bold text-xs border outline-none cursor-pointer transition ${
                          inv.documentType === 'يحتاج تحديد النوع'
                            ? 'bg-amber-50 border-amber-300 text-amber-800'
                            : inv.documentType === 'مبيعات'
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                            : 'bg-blue-50 border-blue-300 text-blue-800'
                        }`}
                      >
                        <option value="مبيعات">مبيعات</option>
                        <option value="مشتريات">مشتريات</option>
                        <option value="يحتاج تحديد النوع">يحتاج تحديد النوع</option>
                      </select>
                    </td>
                    <td className="p-4 text-slate-800 font-medium">{inv.issuerName || '—'}</td>
                    <td className="p-4 text-slate-700">{col1 !== undefined ? col1.toFixed(2) : '—'}</td>
                    <td className="p-4 text-slate-700">{col2 !== undefined ? col2.toFixed(2) : '—'}</td>
                    <td className="p-4 font-extrabold text-emerald-700">
                      {inv.grandTotal !== undefined ? `${inv.grandTotal.toFixed(2)} ${inv.currency || ''}` : '—'}
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col gap-1 items-start">
                        <span
                          title={inv.errorMessage || undefined}
                          className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] ${
                            inv.status === 'مكتملة'
                              ? 'bg-emerald-100 text-emerald-800'
                              : inv.status === 'فشل' || inv.processingStatus === 'failed'
                              ? 'bg-red-100 text-red-800'
                              : inv.status === 'قيد المعالجة' || inv.processingStatus === 'processing'
                              ? 'bg-blue-100 text-blue-800 animate-pulse'
                              : inv.status === 'لم تبدأ' || inv.processingStatus === 'pending'
                              ? 'bg-slate-200 text-slate-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {inv.status === 'لم تبدأ'
                            ? 'بانتظار المعالجة'
                            : inv.status === 'قيد المعالجة'
                            ? 'جاري الاستخراج...'
                            : inv.status}
                        </span>
                        {inv.errorMessage && inv.status === 'فشل' && (
                          <span className="text-[10px] text-red-600 max-w-[160px] truncate" title={inv.errorMessage}>
                            {inv.errorMessage}
                          </span>
                        )}
                        {inv.syncStatus && inv.syncStatus !== 'synced' && (
                          <span className="text-[10px] text-slate-500">
                            {inv.syncStatus === 'failed'
                              ? 'فشل المزامنة'
                              : inv.syncStatus === 'syncing'
                              ? 'جاري المزامنة'
                              : 'محلي (بانتظار المزامنة)'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          onClick={() => onSelectForReview(inv.id)}
                          className="p-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white rounded-lg transition"
                          title="مراجعة وتعديل"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(inv.id)}
                          className="p-1.5 bg-red-50 text-red-600 hover:bg-red-600 hover:text-white rounded-lg transition"
                          title="حذف"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {clearConfirmOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 text-center">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">حذف الفواتير السابقة لهذه العملية</h3>
            <p className="text-sm text-slate-500 mb-6">
              هل تريد حذف جميع الفواتير السابقة ({invoices.length}) وصورها في عملية "{operation.name}"؟ بعد الحذف يمكنك إعادة رفع الصور مجدداً دون اعتبارها مكررة.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                disabled={clearingAll}
                onClick={() => setClearConfirmOpen(false)}
                className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                تراجع
              </button>
              <button
                type="button"
                disabled={clearingAll}
                onClick={() => void handleClearAllInvoices()}
                className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-sm font-bold shadow-sm disabled:opacity-50"
              >
                {clearingAll ? 'جاري الحذف...' : 'نعم، حذف الفواتير السابقة'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
