import React, { useState } from 'react';
import { Plus, Building2, FileSpreadsheet, Download, Trash2, Edit3, ArrowRight, Sparkles, FolderOpen, Calendar } from 'lucide-react';
import { Operation } from '../types';
import { downloadWorkbook } from '../services/excelService';
import { getWorkbookFromOperation, saveOperation } from '../services/dbService';

interface OperationsListProps {
  operations: Operation[];
  onSelectOperation: (op: Operation) => void;
  onOpenNewModal: () => void;
  onDeleteOperation: (id: string) => void;
  onUpdateOperation: (op: Operation) => void;
}

export const OperationsList: React.FC<OperationsListProps> = ({
  operations,
  onSelectOperation,
  onOpenNewModal,
  onDeleteOperation,
  onUpdateOperation,
}) => {
  const [editingOp, setEditingOp] = useState<Operation | null>(null);
  const [newName, setNewName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleStartRename = (op: Operation) => {
    setEditingOp(op);
    setNewName(op.name);
  };

  const handleSaveRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingOp && newName.trim()) {
      const updated = { ...editingOp, name: newName.trim(), updatedAt: new Date().toISOString().split('T')[0] };
      onUpdateOperation(updated);
      setEditingOp(null);
    }
  };

  const handleDownload = (op: Operation) => {
    const wb = getWorkbookFromOperation(op);
    downloadWorkbook(wb, op.excelFileName);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero Section */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-emerald-950 text-white rounded-3xl p-8 mb-8 shadow-xl border border-slate-800 relative overflow-hidden">
        <div className="absolute -left-10 -bottom-10 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-full text-xs font-semibold mb-4 border border-emerald-500/30">
            <Sparkles className="w-3.5 h-3.5" />
            <span>نظام استخراج الفواتير وإدارتها الذكي عبر Excel</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            إدارة فواتير ومستندات مؤسستك باحترافية
          </h1>
          <p className="text-slate-300 text-base leading-relaxed mb-6">
            ارفع صور فواتيرك ومستنداتك واستخرج بياناتها بدقة خارقة باستخدام Gemini Vision AI، راجعها واحفظها مباشرة داخل ملف Excel خاص بكل عملية ومؤسسة دون الحاجة لقواعد بيانات معقدة.
          </p>
          <button
            onClick={onOpenNewModal}
            className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold shadow-lg transition transform hover:-translate-y-0.5"
          >
            <Plus className="w-5 h-5" />
            <span>إنشاء عملية / مؤسسة جديدة</span>
          </button>
        </div>
      </div>

      {/* Operations Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">العمليات والمشروعات الحالية</h2>
          <p className="text-sm text-slate-500">كل عملية تمثل مشروعاً مستقلًا مع ملف Excel الخاص به</p>
        </div>
        <span className="px-3 py-1 bg-emerald-100 text-emerald-800 rounded-full font-bold text-sm">
          {operations.length} عمليات
        </span>
      </div>

      {operations.length === 0 ? (
        <div className="bg-white rounded-3xl p-12 text-center border border-slate-200 shadow-xs">
          <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4 text-slate-400">
            <FolderOpen className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-1">لا توجد عمليات مسجلة</h3>
          <p className="text-slate-500 text-sm mb-6">ابدأ بإنشاء أول عملية أو مؤسسة لإدارة فواتيرك</p>
          <button
            onClick={onOpenNewModal}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl font-medium text-sm hover:bg-emerald-500 transition"
          >
            <Plus className="w-4 h-4" />
            <span>إنشاء عملية جديدة</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {operations.map((op) => {
            const completedCount = op.invoices?.filter(i => i.status === 'مكتملة').length || 0;
            const totalCount = op.invoices?.length || 0;

            return (
              <div 
                key={op.id}
                className="bg-white rounded-2xl border border-slate-200 shadow-xs hover:shadow-lg transition flex flex-col justify-between overflow-hidden group"
              >
                <div className="p-6">
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600 shrink-0 group-hover:bg-emerald-600 group-hover:text-white transition">
                      <Building2 className="w-6 h-6" />
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleStartRename(op)}
                        className="p-2 text-slate-400 hover:text-emerald-600 hover:bg-slate-50 rounded-lg transition"
                        title="تعديل اسم العملية"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(op.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                        title="حذف العملية"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <h3 className="font-bold text-lg text-slate-900 mb-1 group-hover:text-emerald-600 transition">
                    {op.name}
                  </h3>
                  <div className="flex items-center gap-2 mb-4">
                    <span className="px-2.5 py-0.5 bg-slate-100 text-slate-700 rounded-md text-xs font-medium">
                      {op.activityType}
                    </span>
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      {op.createdAt}
                    </span>
                  </div>

                  <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 flex items-center justify-between text-xs text-slate-600 mb-4">
                    <div className="flex items-center gap-1.5 font-medium">
                      <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                      <span className="truncate max-w-[150px]">{op.excelFileName}</span>
                    </div>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full font-bold">
                      {completedCount} / {totalCount} فواتير
                    </span>
                  </div>
                </div>

                <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                  <button
                    onClick={() => handleDownload(op)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-emerald-600 transition py-2 px-3 rounded-lg hover:bg-white"
                  >
                    <Download className="w-4 h-4" />
                    <span>تحميل Excel</span>
                  </button>
                  <button
                    onClick={() => onSelectOperation(op)}
                    className="flex items-center gap-1.5 text-xs font-bold text-white bg-slate-900 hover:bg-emerald-600 transition py-2 px-4 rounded-xl shadow-xs"
                  >
                    <span>فتح العملية</span>
                    <ArrowRight className="w-4 h-4 rotate-180" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rename Modal */}
      {editingOp && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">تعديل اسم العملية</h3>
            <form onSubmit={handleSaveRename} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">اسم المؤسسة أو المشروع</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 focus:ring-2 focus:ring-emerald-500 outline-none text-slate-800"
                  required
                />
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingOp(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-bold shadow-sm"
                >
                  حفظ التعديل
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 text-center">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">تأكيد حذف العملية</h3>
            <p className="text-sm text-slate-500 mb-6">
              هل أنت متأكد من حذف هذه العملية؟ سيتم إزالة كافة السجلات المرتبطة بها محلياً دون المساس بالملفات الأخرى.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
              >
                تراجع
              </button>
              <button
                onClick={() => {
                  onDeleteOperation(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
                className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-sm font-bold shadow-sm"
              >
                نعم، حذف نهائي
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
