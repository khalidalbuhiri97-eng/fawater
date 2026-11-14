import React, { useState } from 'react';
import { X, Building2, FileSpreadsheet, Sparkles, ShieldCheck } from 'lucide-react';
import { ActivityType, Operation } from '../types';
import { createOperationObject } from '../services/dbService';

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
  'أخرى',
];

export const NewOperationModal: React.FC<NewOperationModalProps> = ({
  isOpen,
  onClose,
  onOperationCreated,
}) => {
  const [name, setName] = useState('');
  const [activityType, setActivityType] = useState<ActivityType>('تجارة عامة');
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
      const newOp = createOperationObject(name.trim(), activityType);
      setName('');
      onOperationCreated(newOp);
      onClose();
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'حدث خطأ أثناء إنشاء المؤسسة');
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
                <option key={act} value={act}>
                  {act}
                </option>
              ))}
            </select>
          </div>

          <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/60 flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div className="text-xs text-emerald-950 space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                <span>الاعتماد التلقائي على قالب Fawater الرسمي</span>
              </div>
              <p className="text-emerald-800 leading-relaxed">
                ترتبط كل مؤسسة تلقائياً بقالب Excel الرسمي المعتمد (ملخص الأداء، المبيعات، المشتريات والموردين) مع الحفاظ على جميع التنسيقات والمعادلات.
              </p>
            </div>
          </div>

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
              disabled={loading}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white rounded-xl font-medium text-sm transition shadow-md flex items-center gap-2"
            >
              {loading ? (
                <span>جاري الإنشاء...</span>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>إنشاء المؤسسة</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
