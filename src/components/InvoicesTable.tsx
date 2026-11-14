import React, { useState } from 'react';
import { Search, Trash2, Edit3 } from 'lucide-react';
import { Operation } from '../types';
import { deleteInvoiceImage } from '../services/dbService';

interface InvoicesTableProps {
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
  onSelectForReview: (id: string) => void;
}

export const InvoicesTable: React.FC<InvoicesTableProps> = ({
  operation,
  onUpdateOperation,
  onSelectForReview,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
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
      updatedAt: new Date().toISOString().split('T')[0],
    });
  };

  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h3 className="font-bold text-lg text-slate-900">سجلات الفواتير والمستندات ({filteredInvoices.length})</h3>
          <p className="text-xs text-slate-500">استعرض كافة الفواتير المستخرجة والمعتمدة للتصدير إلى ملف Excel</p>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
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
        </div>
      </div>

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
                      <span
                        className={`px-2.5 py-0.5 rounded-md font-medium ${
                          inv.documentType === 'يحتاج تحديد النوع'
                            ? 'bg-amber-100 text-amber-800'
                            : inv.documentType === 'مبيعات'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {inv.documentType}
                      </span>
                    </td>
                    <td className="p-4 text-slate-800 font-medium">{inv.issuerName || '—'}</td>
                    <td className="p-4 text-slate-700">{col1 !== undefined ? col1.toFixed(2) : '—'}</td>
                    <td className="p-4 text-slate-700">{col2 !== undefined ? col2.toFixed(2) : '—'}</td>
                    <td className="p-4 font-extrabold text-emerald-700">
                      {inv.grandTotal !== undefined ? `${inv.grandTotal.toFixed(2)} ${inv.currency || ''}` : '—'}
                    </td>
                    <td className="p-4">
                      <span
                        className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] ${
                          inv.status === 'مكتملة'
                            ? 'bg-emerald-100 text-emerald-800'
                            : inv.status === 'فشل'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {inv.status}
                      </span>
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
    </div>
  );
};
