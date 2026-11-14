import React from 'react';
import { Download, FileSpreadsheet, ShieldCheck, Sparkles } from 'lucide-react';
import { Operation } from '../types';
import { downloadWorkbook } from '../services/excelService';
import { getWorkbookFromOperation } from '../services/dbService';
import * as XLSX from 'xlsx';

interface ExportCenterProps {
  operation: Operation;
}

export const ExportCenter: React.FC<ExportCenterProps> = ({ operation }) => {
  const handleDownloadFull = () => {
    const wb = getWorkbookFromOperation(operation);
    downloadWorkbook(wb, operation.excelFileName);
  };

  const handleDownloadFiltered = (sheetNameFilter: string, fileNameSuffix: string) => {
    const wb = getWorkbookFromOperation(operation);
    // Keep only the target sheet
    const newWb = XLSX.utils.book_new();
    if (wb.Sheets[sheetNameFilter]) {
      XLSX.utils.book_append_sheet(newWb, wb.Sheets[sheetNameFilter], sheetNameFilter);
    }
    // Also include summary
    if (wb.Sheets['الملخص (Summary)']) {
      XLSX.utils.book_append_sheet(newWb, wb.Sheets['الملخص (Summary)'], 'الملخص (Summary)');
    }
    const nameWithoutExt = operation.excelFileName.replace(/\.xlsx$/i, '');
    downloadWorkbook(newWb, `${nameWithoutExt}_${fileNameSuffix}.xlsx`);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-xs p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-2xl flex items-center justify-center">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-slate-900">مركز التصدير وتنزيل ملفات Excel</h3>
            <p className="text-xs text-slate-500">
              ملف XLSX هو مصدر البيانات الأساسي للعملية. يمكنك تنزيل النسخة الكاملة أو أوراق محددة في أي وقت.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-4">
          <button
            onClick={handleDownloadFull}
            className="p-5 rounded-2xl border border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50 text-right transition flex flex-col justify-between gap-4 group"
          >
            <div>
              <div className="font-bold text-emerald-900 text-base mb-1">تنزيل ملف Excel الكامل</div>
              <div className="text-xs text-slate-600">يتضمن كافة الأوراق (المبيعات، المشتريات، المصروفات، الأصناف، الملخص)</div>
            </div>
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-700 group-hover:translate-x-1 transition-transform">
              <Download className="w-4 h-4" />
              <span>تحميل الآن ({operation.excelFileName})</span>
            </div>
          </button>

          <button
            onClick={() => handleDownloadFiltered('المبيعات (Sales)', 'المبيعات')}
            className="p-5 rounded-2xl border border-slate-200 bg-white hover:border-emerald-500 text-right transition flex flex-col justify-between gap-4 group"
          >
            <div>
              <div className="font-bold text-slate-900 text-base mb-1">تنزيل المبيعات فقط</div>
              <div className="text-xs text-slate-500">تصدير ورقة المبيعات مع بيانات الملخص المالي</div>
            </div>
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-600 group-hover:translate-x-1 transition-transform">
              <Download className="w-4 h-4" />
              <span>تنزيل المبيعات</span>
            </div>
          </button>

          <button
            onClick={() => handleDownloadFiltered('المشتريات (Purchases)', 'المشتريات')}
            className="p-5 rounded-2xl border border-slate-200 bg-white hover:border-emerald-500 text-right transition flex flex-col justify-between gap-4 group"
          >
            <div>
              <div className="font-bold text-slate-900 text-base mb-1">تنزيل المشتريات فقط</div>
              <div className="text-xs text-slate-500">تصدير ورقة المشتريات والموردين</div>
            </div>
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-600 group-hover:translate-x-1 transition-transform">
              <Download className="w-4 h-4" />
              <span>تنزيل المشتريات</span>
            </div>
          </button>

          <button
            onClick={() => handleDownloadFiltered('المصروفات (Expenses)', 'المصروفات')}
            className="p-5 rounded-2xl border border-slate-200 bg-white hover:border-emerald-500 text-right transition flex flex-col justify-between gap-4 group"
          >
            <div>
              <div className="font-bold text-slate-900 text-base mb-1">تنزيل المصروفات فقط</div>
              <div className="text-xs text-slate-500">تصدير ورقة المصروفات ونفقات التشغيل</div>
            </div>
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-600 group-hover:translate-x-1 transition-transform">
              <Download className="w-4 h-4" />
              <span>تنزيل المصروفات</span>
            </div>
          </button>
        </div>

        <div className="mt-8 p-4 bg-slate-50 rounded-2xl border border-slate-200 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-600 space-y-1">
            <span className="font-bold text-slate-800 block">ضمان سلامة البيانات:</span>
            <p>يتم تحديث ملف Excel تلقائياً بعد كل عملية حفظ ومراجعة. الملف المحمّل هو نسختك المستقلة التي يمكنك حفظها ومشاركتها في Microsoft Excel أو Google Sheets.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
