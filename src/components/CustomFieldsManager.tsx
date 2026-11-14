import React, { useState } from 'react';
import { Plus, Trash2, Tag, Sparkles } from 'lucide-react';
import { CustomField, FieldType, Operation } from '../types';

interface CustomFieldsManagerProps {
  operation: Operation;
  onUpdateOperation: (op: Operation) => void;
}

export const CustomFieldsManager: React.FC<CustomFieldsManagerProps> = ({
  operation,
  onUpdateOperation,
}) => {
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('نص');
  const [required, setRequired] = useState(false);
  const [aiExtract, setAiExtract] = useState(true);
  const [excelSheet, setExcelSheet] = useState('الملخص (Summary)');
  const [excelColumn, setExcelColumn] = useState('');
  const [optionsStr, setOptionsStr] = useState('');

  const fields = operation.customFields || [];

  const handleAddField = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newField: CustomField = {
      id: 'cf_' + Date.now(),
      name: name.trim(),
      type,
      required,
      aiExtract,
      manual: true,
      excelSheet,
      excelColumn: excelColumn.trim() || name.trim(),
      options: type === 'قائمة خيارات' ? optionsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined
    };

    const updatedFields = [...fields, newField];
    onUpdateOperation({
      ...operation,
      customFields: updatedFields,
      updatedAt: new Date().toISOString().split('T')[0]
    });

    setName('');
    setExcelColumn('');
    setOptionsStr('');
  };

  const handleDeleteField = (id: string) => {
    const updatedFields = fields.filter(f => f.id !== id);
    onUpdateOperation({
      ...operation,
      customFields: updatedFields,
      updatedAt: new Date().toISOString().split('T')[0]
    });
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-xs p-6">
        <h3 className="font-bold text-lg text-slate-900 mb-2">إدارة الحقول المخصصة للمؤسسة</h3>
        <p className="text-xs text-slate-500 mb-6">
          أضف حقولاً إضافية لاستخراجها وإدارتها (مثل رقم السجل التجاري، رقم الهاتف، مركز التكلفة، اسم الفرع، إلخ)
        </p>

        <form onSubmit={handleAddField} className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-200">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">اسم الحقل</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: اسم الفرع"
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">نوع الحقل</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as FieldType)}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none text-slate-800"
            >
              {['نص', 'رقم', 'تاريخ', 'مبلغ', 'نسبة', 'قائمة خيارات', 'نعم/لا'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">ورقة Excel المرتبطة</label>
            <select
              value={excelSheet}
              onChange={(e) => setExcelSheet(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none text-slate-800"
            >
              <option value="المبيعات (Sales)">المبيعات (Sales)</option>
              <option value="المشتريات (Purchases)">المشتريات (Purchases)</option>
              <option value="المصروفات (Expenses)">المصروفات (Expenses)</option>
              <option value="الملخص (Summary)">الملخص (Summary)</option>
            </select>
          </div>

          {type === 'قائمة خيارات' && (
            <div className="sm:col-span-3">
              <label className="block text-xs font-semibold text-slate-700 mb-1">الخيارات (مفصولة بفواصل)</label>
              <input
                type="text"
                value={optionsStr}
                onChange={(e) => setOptionsStr(e.target.value)}
                placeholder="الفرع الرئيسي, فرع الشمال, فرع الغرب"
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs bg-white outline-none"
              />
            </div>
          )}

          <div className="sm:col-span-3 flex items-center justify-between pt-2 border-t border-slate-200">
            <div className="flex items-center gap-4 text-xs text-slate-700">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={aiExtract}
                  onChange={(e) => setAiExtract(e.target.checked)}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium">استخراج بالذكاء الاصطناعي (Gemini)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                  className="rounded text-emerald-600 focus:ring-emerald-500"
                />
                <span className="font-medium">حقل مطلوب</span>
              </label>
            </div>

            <button
              type="submit"
              className="flex items-center gap-1.5 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span>إضافة الحقل</span>
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-xs overflow-hidden p-6">
        <h4 className="font-bold text-sm text-slate-900 mb-4">الحقول المخصصة الحالية ({fields.length})</h4>
        {fields.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-xs">لا توجد حقول مخصصة مضافة حالياً.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map(cf => (
              <div key={cf.id} className="p-4 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Tag className="w-4 h-4 text-emerald-600" />
                    <span className="font-bold text-slate-800 text-sm">{cf.name}</span>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded text-[10px] font-bold">{cf.type}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    يحفظ في: {cf.excelSheet} ({cf.excelColumn}) {cf.aiExtract && '• استخراج ذكي'}
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteField(cf.id)}
                  className="text-slate-400 hover:text-red-600 p-2 rounded-xl hover:bg-red-50 transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
