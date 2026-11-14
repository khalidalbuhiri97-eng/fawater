import React, { useState } from 'react';
import {
  Upload,
  FileSpreadsheet,
  DollarSign,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  Clock,
  Sparkles,
  LayoutDashboard,
  ListFilter,
  Tag,
} from 'lucide-react';
import { Operation } from '../types';
import { InvoicesTable } from './InvoicesTable';
import { CustomFieldsManager } from './CustomFieldsManager';
import { ExportCenter } from './ExportCenter';
import { BatchUploadModal } from './BatchUploadModal';

interface OperationDashboardProps {
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
  onStartReview: (invoiceId: string) => void;
}

export const OperationDashboard: React.FC<OperationDashboardProps> = ({
  operation,
  onUpdateOperation,
  onStartReview,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'invoices' | 'custom_fields' | 'export'>('overview');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadInitialMode, setUploadInitialMode] = useState<'ai' | 'manual'>('ai');

  const openUploadModal = (mode: 'ai' | 'manual') => {
    setUploadInitialMode(mode);
    setIsUploadModalOpen(true);
  };

  const invoices = operation.invoices || [];
  const completedInvoices = invoices.filter((i) => i.status === 'مكتملة');
  const pendingInvoices = invoices.filter((i) => i.status !== 'مكتملة');

  const totalSales = completedInvoices
    .filter((i) => i.documentType === 'مبيعات')
    .reduce((sum, i) => {
      const val =
        i.cashSales !== undefined || i.networkSales !== undefined
          ? Number(i.cashSales ?? 0) + Number(i.networkSales ?? 0)
          : Number(i.grandTotal ?? 0);
      return sum + val;
    }, 0);

  const totalPurchases = completedInvoices
    .filter((i) => i.documentType === 'مشتريات')
    .reduce((sum, i) => {
      const val =
        i.subtotal !== undefined || i.taxAmount !== undefined
          ? Number(i.subtotal ?? 0) + Number(i.taxAmount ?? 0)
          : Number(i.grandTotal ?? 0);
      return sum + val;
    }, 0);

  const netIncome = totalSales - totalPurchases;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Operation Header Card */}
      <div className="bg-gradient-to-l from-slate-900 via-slate-800 to-emerald-950 text-white rounded-3xl p-8 shadow-xl border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative overflow-hidden">
        <div className="absolute -left-10 -bottom-10 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-3">
            <span className="px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-full text-xs font-bold border border-emerald-500/30">
              {operation.activityType}
            </span>
            <span className="text-xs text-slate-300 bg-slate-800/80 px-3 py-1 rounded-full border border-slate-700">
              ملف Excel: {operation.excelFileName}
            </span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight mb-2">{operation.name}</h1>
          <p className="text-slate-300 text-sm max-w-2xl leading-relaxed">
            منصة تحويل صور الفواتير ومستندات المؤسسة إلى ملف Excel رسمي موحد باستخدام الذكاء الاصطناعي أو الإدخال اليدوي.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 relative z-10 shrink-0">
          <button
            onClick={() => openUploadModal('manual')}
            className="flex items-center gap-2 px-5 py-3.5 bg-slate-800 hover:bg-slate-700 text-white rounded-2xl font-bold border border-slate-600 shadow-md transition"
          >
            <span>إدخال يدوي</span>
          </button>
          <button
            onClick={() => openUploadModal('ai')}
            className="flex items-center gap-2 px-6 py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg transition transform hover:-translate-y-0.5"
          >
            <Upload className="w-5 h-5" />
            <span>استخراج بالذكاء الاصطناعي</span>
          </button>
        </div>
      </div>

      {/* Usage Steps Guide Bar */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
        <h3 className="font-bold text-sm text-slate-800 mb-4 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          <span>خطوات العمل الذكية في النظام:</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 text-center">
          <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-100 flex flex-col items-center gap-1.5">
            <div className="w-7 h-7 bg-emerald-600 text-white rounded-full flex items-center justify-center font-bold text-xs">1</div>
            <span className="font-bold text-xs text-slate-800">رفع الفواتير</span>
            <span className="text-[11px] text-slate-500">رفع صور أو ملفات PDF</span>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col items-center gap-1.5">
            <div className="w-7 h-7 bg-slate-800 text-white rounded-full flex items-center justify-center font-bold text-xs">2</div>
            <span className="font-bold text-xs text-slate-800">التصنيف والاستخراج</span>
            <span className="text-[11px] text-slate-500">تصنيف مبيعات/مشتريات بالـ AI</span>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col items-center gap-1.5">
            <div className="w-7 h-7 bg-slate-800 text-white rounded-full flex items-center justify-center font-bold text-xs">3</div>
            <span className="font-bold text-xs text-slate-800">المراجعة والاعتماد</span>
            <span className="text-[11px] text-slate-500">تدقيق الصورة والتاريخ والحقول</span>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col items-center gap-1.5">
            <div className="w-7 h-7 bg-slate-800 text-white rounded-full flex items-center justify-center font-bold text-xs">4</div>
            <span className="font-bold text-xs text-slate-800">الإدراج في القالب</span>
            <span className="text-[11px] text-slate-500">تعبئة أوراق القالب الرسمي</span>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col items-center gap-1.5">
            <div className="w-7 h-7 bg-slate-800 text-white rounded-full flex items-center justify-center font-bold text-xs">5</div>
            <span className="font-bold text-xs text-slate-800">تنزيل الملف</span>
            <span className="text-[11px] text-slate-500">تحميل ملف XLSX جاهز بالتنسيقات</span>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-sm transition ${
            activeTab === 'overview'
              ? 'bg-emerald-600 text-white shadow-md'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>لوحة المؤشرات والملخص</span>
        </button>
        <button
          onClick={() => setActiveTab('invoices')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-sm transition ${
            activeTab === 'invoices'
              ? 'bg-emerald-600 text-white shadow-md'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <ListFilter className="w-4 h-4" />
          <span>سجلات الفواتير ({invoices.length})</span>
        </button>
        <button
          onClick={() => setActiveTab('custom_fields')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-sm transition ${
            activeTab === 'custom_fields'
              ? 'bg-emerald-600 text-white shadow-md'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <Tag className="w-4 h-4" />
          <span>الحقول المخصصة ({operation.customFields?.length || 0})</span>
        </button>
        <button
          onClick={() => setActiveTab('export')}
          className={`flex items-center gap-2 px-5 py-3 rounded-2xl font-bold text-sm transition ${
            activeTab === 'export'
              ? 'bg-emerald-600 text-white shadow-md'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          <FileSpreadsheet className="w-4 h-4" />
          <span>تصدير وتنزيل Excel</span>
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-8">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-xs flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-1">إجمالي المبيعات المعتمدة</p>
                <h3 className="text-2xl font-extrabold text-slate-900">
                  {totalSales.toLocaleString()} <span className="text-xs font-normal text-slate-500">SAR</span>
                </h3>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
                <TrendingUp className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-xs flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-1">إجمالي المشتريات المعتمدة</p>
                <h3 className="text-2xl font-extrabold text-slate-900">
                  {totalPurchases.toLocaleString()} <span className="text-xs font-normal text-slate-500">SAR</span>
                </h3>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600">
                <TrendingDown className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-xs flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-1">صافي التدفق (المبيعات - المشتريات)</p>
                <h3 className={`text-2xl font-extrabold ${netIncome >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {netIncome.toLocaleString()} <span className="text-xs font-normal text-slate-500">SAR</span>
                </h3>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700">
                <DollarSign className="w-6 h-6" />
              </div>
            </div>

            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-xs flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-1">الفواتير المعتمدة / قيد المراجعة</p>
                <h3 className="text-2xl font-extrabold text-slate-900">
                  {completedInvoices.length}{' '}
                  <span className="text-xs text-slate-400 font-normal">({pendingInvoices.length} للمراجعة)</span>
                </h3>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600">
                <CheckCircle2 className="w-6 h-6" />
              </div>
            </div>
          </div>

          {/* Pending Review Quick Access */}
          {pendingInvoices.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-3xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-amber-100 text-amber-700 rounded-2xl flex items-center justify-center shrink-0">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="font-bold text-amber-900 text-base">
                    لديك {pendingInvoices.length} فواتير تحتاج إلى المراجعة والاعتماد
                  </h4>
                  <p className="text-xs text-amber-700">
                    راجع البيانات المستخرجة وأكد نوع الفاتورة وتاريخها لاعتمادها وتجهيزها للتصدير
                  </p>
                </div>
              </div>
              <button
                onClick={() => onStartReview(pendingInvoices[0].id)}
                className="px-6 py-3 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-sm font-bold shadow-sm transition shrink-0"
              >
                بدء المراجعة الآن
              </button>
            </div>
          )}

          {/* Recent Invoices Preview */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-bold text-lg text-slate-900">أحدث الفواتير والمستندات</h3>
              <button
                onClick={() => setActiveTab('invoices')}
                className="text-xs font-bold text-emerald-600 hover:underline"
              >
                عرض الكل ({invoices.length})
              </button>
            </div>

            {invoices.length === 0 ? (
              <div className="text-center py-12 space-y-4">
                <div className="w-16 h-16 bg-slate-100 text-slate-400 rounded-2xl flex items-center justify-center mx-auto">
                  <FileSpreadsheet className="w-8 h-8" />
                </div>
                <h4 className="font-bold text-slate-800 text-base">لا توجد فواتير مرفوعة بعد</h4>
                <p className="text-slate-500 text-xs max-w-sm mx-auto">
                  ارفع صور فواتيرك ومستنداتك واستخرج بياناتها وتصنيفها تلقائياً باستخدام Gemini Vision.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    onClick={() => openUploadModal('manual')}
                    className="px-5 py-3 bg-slate-900 text-white rounded-2xl text-sm font-bold hover:bg-slate-800 transition shadow-sm"
                  >
                    إدخال يدوي
                  </button>
                  <button
                    onClick={() => openUploadModal('ai')}
                    className="px-6 py-3 bg-emerald-600 text-white rounded-2xl text-sm font-bold hover:bg-emerald-500 transition shadow-md"
                  >
                    استخراج بالذكاء الاصطناعي
                  </button>
                </div>
              </div>
            ) : (
              <InvoicesTable
                operation={operation}
                onUpdateOperation={onUpdateOperation}
                onSelectForReview={onStartReview}
              />
            )}
          </div>
        </div>
      )}

      {activeTab === 'invoices' && (
        <InvoicesTable
          operation={operation}
          onUpdateOperation={onUpdateOperation}
          onSelectForReview={onStartReview}
        />
      )}

      {activeTab === 'custom_fields' && (
        <CustomFieldsManager operation={operation} onUpdateOperation={onUpdateOperation} />
      )}

      {activeTab === 'export' && <ExportCenter operation={operation} />}

      <BatchUploadModal
        isOpen={isUploadModalOpen}
        initialMode={uploadInitialMode}
        onClose={() => setIsUploadModalOpen(false)}
        operation={operation}
        onUpdateOperation={onUpdateOperation}
        onStartReview={onStartReview}
      />
    </div>
  );
};
