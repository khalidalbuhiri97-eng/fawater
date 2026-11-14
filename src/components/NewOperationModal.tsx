import React, { useState } from 'react';
import { X, Building2, FileSpreadsheet, Upload, Sparkles, CheckCircle2 } from 'lucide-react';
import { ActivityType, Operation } from '../types';
import { createOperationObject } from '../services/dbService';
import { parseUploadedExcel } from '../services/excelService';

interface NewOperationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOperationCreated: (op: Operation) => void;
}

const activityTypes: ActivityType[] = [
  'تجارة عامة',
  'مقاولات وبناء',
  'استشارات وخدمات',
  'مطاعم ومقاهي',
  'خدمات تقنية',
  'رعاية صحية',
  'نقليات وشحن',
  'أخرى'
];

export const NewOperationModal: React.FC<NewOperationModalProps> = ({
  isOpen,
  onClose,
  onOperationCreated,
}) => {
  const [name, setName] = useState('');
  const [activityType, setActivityType] = useState<ActivityType>('تجارة عامة');
  const [templateMode, setTemplateMode] = useState<'new' | 'custom'>('new');
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('يرجى إدخال اسم المؤسسة أو المشروع');
      return;
    }

    setLoading(true);
    setError('');

    try {
      let newOp: Operation;
      if (templateMode === 'custom' && customFile) {
        const parsed = await parseUploadedExcel(customFile);
        newOp = createOperationObject(
          name.trim(),
          activityType,
          'custom',
          customFile.name,
          parsed.workbook
        );
      } else {
        const filename = `${name.trim().replace(/\s+/g, '_')}_سجلات.xlsx`;
        newOp = createOperationObject(
          name.trim(),
          activityType,
          'new',
          filename
        );
      }

      onOperationCreated(newOp);
      onClose();
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'حدث خطأ أثناء إنشاء العملية أو قراءة ملف Excel');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-slate-100 animate-in fade-in zoom-in duration-200">
        <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-emerald-400" />
            <h3 className="font-bold text-lg">إنشاء عملية جديدة (مشروع / مؤسسة)</h3>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              اسم المؤسسة أو المشروع <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: مؤسسة النور للتموين"
              className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none text-slate-800"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              نوع النشاط أو العمل
            </label>
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value as ActivityType)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none bg-white text-slate-800"
            >
              {activityTypes.map((act) => (
                <option key={act} value={act}>{act}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              مصدر ملف Excel (قاعدة البيانات الأساسية)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setTemplateMode('new')}
                className={`p-4 rounded-xl border text-right transition flex flex-col gap-2 ${
                  templateMode === 'new'
                    ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 ring-2 ring-emerald-500/20'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <FileSpreadsheet className={`w-6 h-6 ${templateMode === 'new' ? 'text-emerald-600' : 'text-slate-500'}`} />
                  {templateMode === 'new' && <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
                </div>
                <div>
                  <div className="font-bold text-sm">قالب منظم جديد</div>
                  <div className="text-xs text-slate-500 mt-0.5">يُنشئ أوراق مبيعات، مشتريات، مصروفات وأصناف تلقائياً</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setTemplateMode('custom')}
                className={`p-4 rounded-xl border text-right transition flex flex-col gap-2 ${
                  templateMode === 'custom'
                    ? 'border-emerald-600 bg-emerald-50/50 text-emerald-900 ring-2 ring-emerald-500/20'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <Upload className={`w-6 h-6 ${templateMode === 'custom' ? 'text-emerald-600' : 'text-slate-500'}`} />
                  {templateMode === 'custom' && <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
                </div>
                <div>
                  <div className="font-bold text-sm">رفع ملف Excel جاهز</div>
                  <div className="text-xs text-slate-500 mt-0.5">استخدام قالبك الخاص كقاعدة بيانات للعملية</div>
                </div>
              </button>
            </div>
          </div>

          {templateMode === 'custom' && (
            <div className="p-4 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 text-center">
              <input
                type="file"
                accept=".xlsx, .xls"
                onChange={(e) => e.target.files && setCustomFile(e.target.files[0])}
                className="hidden"
                id="customExcelUpload"
              />
              <label htmlFor="customExcelUpload" className="cursor-pointer flex flex-col items-center gap-2">
                <FileSpreadsheet className="w-8 h-8 text-emerald-600" />
                <span className="text-sm font-medium text-slate-700">
                  {customFile ? customFile.name : 'انقر لاختيار ملف Excel (XLSX)'}
                </span>
                <span className="text-xs text-slate-500">يدعم كافة صيغ الجداول وجداول البيانات</span>
              </label>
            </div>
          )}

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium text-sm transition"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={loading || (templateMode === 'custom' && !customFile)}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl font-medium text-sm transition shadow-md flex items-center gap-2"
            >
              {loading ? (
                <span>جاري الإنشاء...</span>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>بدء العملية وإنشاء الملف</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
