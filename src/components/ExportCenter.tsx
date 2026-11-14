import React, { useEffect, useState } from 'react';
import { Download, FileSpreadsheet, ShieldCheck, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Operation } from '../types';
import { downloadOperationExcel } from '../services/excelService';
import {
  checkForTemplateUpdate,
  getOfficialTemplate,
  LOCAL_OFFICIAL_TEMPLATE_PATH,
  StoredOfficialTemplate,
} from '../services/templateService';
import { getExportTracking } from '../services/dbService';

interface ExportCenterProps {
  operation: Operation;
}

export const ExportCenter: React.FC<ExportCenterProps> = ({ operation }) => {
  const [updating, setUpdating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [templateInfo, setTemplateInfo] = useState<StoredOfficialTemplate | null>(null);
  const [exportMsg, setExportMsg] = useState<{ success: boolean; text: string } | null>(null);
  const [updateMsg, setUpdateMsg] = useState<{ success: boolean; text: string } | null>(null);

  const invoices = operation.invoices || [];
  const approvedInvoices = invoices.filter((i) => i.status === 'مكتملة');
  const pendingInvoices = invoices.filter((i) => i.status !== 'مكتملة');
  const exportTracking = getExportTracking(operation.id);

  useEffect(() => {
    getOfficialTemplate()
      .then((tpl) => setTemplateInfo(tpl))
      .catch((err) => {
        setUpdateMsg({ success: false, text: err?.message || 'تعذر قراءة القالب الرسمي' });
      });
  }, []);

  const handleDownloadFull = async () => {
    setDownloading(true);
    setExportMsg(null);
    try {
      const result = await downloadOperationExcel(operation);
      setExportMsg({
        success: true,
        text: `تم إنشاء وتنزيل الملف "${result.fileName}" بنجاح (${result.salesWritten} مبيعات، ${result.purchasesWritten} مشتريات).`,
      });
    } catch (err: any) {
      setExportMsg({
        success: false,
        text: err?.message || 'فشل تصدير ملف Excel.',
      });
    } finally {
      setDownloading(false);
    }
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    setUpdateMsg(null);
    try {
      const res = await checkForTemplateUpdate();
      setUpdateMsg({ success: res.success, text: res.message });
      const latest = await getOfficialTemplate();
      setTemplateInfo(latest);
    } catch (err: any) {
      setUpdateMsg({ success: false, text: err?.message || 'حدث خطأ أثناء التحقق من التحديث' });
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-xs p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-2xl flex items-center justify-center">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-900">تصدير ملف Excel الرسمي (XLSX)</h3>
            <p className="text-xs text-slate-500">
              يتم تصدير الفواتير المعتمدة فقط داخل نسخة من قالب Fawater الرسمي مع الحفاظ التام على الأوراق الثلاث والتنسيقات والمعادلات.
            </p>
          </div>
        </div>

        {/* Summary counters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200">
            <span className="text-emerald-700 font-semibold block">فواتير معتمدة جاهزة للتصدير</span>
            <span className="text-xl font-extrabold text-emerald-900">{approvedInvoices.length}</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200">
            <span className="text-amber-700 font-semibold block">فواتير بانتظار المراجعة/التصنيف</span>
            <span className="text-xl font-extrabold text-amber-900">{pendingInvoices.length}</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
            <span className="text-slate-600 font-semibold block">آخر تصدير مسجل</span>
            <span className="text-xs font-bold text-slate-800 block mt-1">
              {exportTracking
                ? `${exportTracking.exportedInvoiceIds.length} فاتورة (${exportTracking.lastExportedAt.split('T')[0]})`
                : 'لم يتم التصدير بعد'}
            </span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-4 pt-1">
          <button
            onClick={handleDownloadFull}
            disabled={downloading || approvedInvoices.length === 0}
            className="w-full sm:w-auto px-6 py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-2xl font-bold text-sm shadow-md transition flex items-center justify-center gap-2"
          >
            <Download className="w-5 h-5" />
            <span>
              {downloading
                ? 'جاري تجهيز ملف Excel...'
                : `تنزيل ملف Excel النهائي (${operation.excelFileName || 'fawater_export.xlsx'})`}
            </span>
          </button>
        </div>

        {exportMsg && (
          <div
            className={`p-3.5 rounded-xl text-xs font-medium flex items-center gap-2 ${
              exportMsg.success
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {exportMsg.success ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            )}
            <span>{exportMsg.text}</span>
          </div>
        )}

        {/* Template Update & Inspection Section */}
        <div className="border-t border-slate-200 pt-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="font-bold text-sm text-slate-800">التحقق من تحديث قالب Excel الرسمي</h4>
              <p className="text-xs text-slate-500">
                فحص أحدث نسخة من {LOCAL_OFFICIAL_TEMPLATE_PATH} في مستودع GitHub والتحقق من البصمة الرقمية SHA-256
              </p>
            </div>
            <button
              onClick={handleCheckUpdate}
              disabled={updating}
              className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              <RefreshCw className={`w-4 h-4 ${updating ? 'animate-spin' : ''}`} />
              <span>{updating ? 'جاري التحقق...' : 'التحقق من التحديث'}</span>
            </button>
          </div>

          {updateMsg && (
            <div
              className={`p-3 rounded-xl text-xs font-medium ${
                updateMsg.success
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {updateMsg.text}
            </div>
          )}

          {templateInfo && (
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-xs text-slate-700 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-slate-900">تفاصيل القالب النشط:</span>
                <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                  المصدر: {templateInfo.source === 'github' ? 'GitHub الرسمي' : 'النسخة المرفقة بالمشروع'}
                </span>
              </div>
              <div className="font-mono text-[11px] text-slate-500 break-all">
                SHA-256: {templateInfo.sha256}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {templateInfo.sheets.map((s) => (
                  <span
                    key={s.sheetName}
                    className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[11px] font-medium"
                  >
                    {s.sheetName} (بداية البيانات: صف {s.dataStartRowNumber})
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-600 space-y-1">
            <span className="font-bold text-slate-800 block">ضمان سلامة البيانات والتنسيق:</span>
            <p>
              يتم الإدراج في أوراق «المبيعات» و«المشتريات والموردين» بدءاً من أول صف فارغ متاح مع الإبقاء على الألوان، الخطوط، الحدود، الخلايا المدمجة، المعادلات، وأوراق القالب الأصلية دون تعديل.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
