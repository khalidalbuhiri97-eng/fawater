import React, { useState } from 'react';
import { Download, FileSpreadsheet, ShieldCheck, Sparkles, RefreshCw } from 'lucide-react';
import { Operation } from '../types';
import { downloadExportWorkbook } from '../services/excelService';
import { checkForTemplateUpdate } from '../services/dbService';

interface ExportCenterProps {
  operation: Operation;
}

export const ExportCenter: React.FC<ExportCenterProps> = ({ operation }) => {
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ success: boolean; text: string } | null>(null);

  const handleDownloadFull = async () => {
    await downloadExportWorkbook(
      operation.invoices || [],
      operation.name,
      operation.activityType,
      operation.excelFileName || 'fawater_export.xlsx'
    );
  };

  const handleCheckUpdate = async () => {
    setUpdating(true);
    setUpdateMsg(null);
    try {
      const res = await checkForTemplateUpdate();
      setUpdateMsg({ success: res.success, text: res.message });
    } catch (err: any) {
      setUpdateMsg({ success: false, text: err.message || 'حدث خطأ أثناء التحقق من التحديث' });
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
              يتم دمج وتصدير الفواتير المعتمدة مباشرة داخل قالب فواتير الرسمي مع الحفاظ على الأوراق الثلاث والمعادلات.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-4 pt-2">
          <button
            onClick={handleDownloadFull}
            className="w-full sm:w-auto px-6 py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold text-sm shadow-md transition flex items-center justify-center gap-2"
          >
            <Download className="w-5 h-5" />
            <span>تنزيل ملف Excel النهائي ({operation.excelFileName || 'fawater_export.xlsx'})</span>
          </button>
        </div>

        {/* Template Update Section */}
        <div className="border-t border-slate-200 pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-bold text-sm text-slate-800">التحقق من تحديث قالب Excel</h4>
              <p className="text-xs text-slate-500">التحقق من وجود نسخة أحدث من القالب في المستودع وتنزيلها تلقائياً</p>
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
            <div className={`p-3 rounded-xl text-xs font-medium ${
              updateMsg.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'
            }`}>
              {updateMsg.text}
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-600 space-y-1">
            <span className="font-bold text-slate-800 block">ضمان سلامة البيانات والتنسيق:</span>
            <p>التصدير يعتمد بشكل مباشر على القالب الثابت في المشروع مع إضافة السجلات الجديدة في الصفوف المخصصة لكل ورقة (المبيعات والمشتريات).</p>
          </div>
        </div>
      </div>
    </div>
  );
};
