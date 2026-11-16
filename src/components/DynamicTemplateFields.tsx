import React from 'react';
import { Calculator } from 'lucide-react';
import { InvoiceRecord } from '../types';
import { TemplateColumnInfo, TemplateSheetInfo } from '../services/templateService';

interface DynamicTemplateFieldsProps {
  sheetInfo: TemplateSheetInfo;
  invoice: InvoiceRecord;
  onUpdateInvoice: (updater: (prev: InvoiceRecord) => InvoiceRecord) => void;
}

function parseOptionalNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : undefined;
}

export const DynamicTemplateFields: React.FC<DynamicTemplateFieldsProps> = ({
  sheetInfo,
  invoice,
  onUpdateInvoice,
}) => {
  const getFieldValue = (col: TemplateColumnInfo): string | number | undefined => {
    switch (col.fieldKey) {
      case 'invoiceDate':
        return invoice.invoiceDate || '';
      case 'day':
        return invoice.day || '';
      case 'invoiceNumber':
        return invoice.invoiceNumber || '';
      case 'issuerTaxId':
        return invoice.issuerTaxId || '';
      case 'cashSales':
        return invoice.cashSales;
      case 'networkSales':
        return invoice.networkSales;
      case 'cashBalance':
        return invoice.cashBalance;
      case 'cashBoxBalance':
        return invoice.cashBoxBalance;
      case 'networkBalance':
        return invoice.networkBalance;
      case 'issuerName':
        return invoice.issuerName || '';
      case 'subtotal':
        return invoice.subtotal;
      case 'taxAmount':
        return invoice.taxAmount;
      case 'balance':
        return invoice.balance;
      case 'grandTotal':
        return invoice.grandTotal;
      case 'paymentMethod':
        return invoice.customFieldsValues?.__official_payment_method || '';
      case 'operationNumber':
        return '#';
      default:
        if (col.fieldKey.startsWith('extra:')) {
          return invoice.extraColumnsData?.[sheetInfo.sheetName]?.[col.colLetter];
        }
        return undefined;
    }
  };

  const getComputedFormulaDisplay = (col: TemplateColumnInfo): string => {
    if (col.fieldKey === 'formula:salesTotal') {
      if (invoice.cashSales !== undefined || invoice.networkSales !== undefined) {
        return (Number(invoice.cashSales ?? 0) + Number(invoice.networkSales ?? 0)).toFixed(2);
      }
      return 'يُحسب تلقائياً (= الكاش + الشبكة)';
    }
    if (col.fieldKey === 'formula:purchasesTotal') {
      if (invoice.subtotal !== undefined || invoice.taxAmount !== undefined) {
        return (Number(invoice.subtotal ?? 0) + Number(invoice.taxAmount ?? 0)).toFixed(2);
      }
      if (invoice.grandTotal !== undefined) {
        return `${invoice.grandTotal.toFixed(2)} (إجمالي مستخرج)`;
      }
      return 'يُحسب تلقائياً (= قبل الضريبة + الضريبة)';
    }
    return col.formulaHint ? `معادلة (${col.formulaHint})` : 'معادلة تلقائية';
  };

  const handleFieldChange = (col: TemplateColumnInfo, rawValue: string) => {
    onUpdateInvoice((prev) => {
      const nowIso = new Date().toISOString();
      const next: InvoiceRecord = { ...prev, updatedAt: nowIso };

      if (col.kind === 'number') {
        const numVal = parseOptionalNumber(rawValue);
        switch (col.fieldKey) {
          case 'cashSales':
            next.cashSales = numVal;
            break;
          case 'networkSales':
            next.networkSales = numVal;
            break;
          case 'cashBalance':
            next.cashBalance = numVal;
            break;
          case 'cashBoxBalance':
            next.cashBoxBalance = numVal;
            break;
          case 'networkBalance':
            next.networkBalance = numVal;
            break;
          case 'subtotal':
            next.subtotal = numVal;
            break;
          case 'taxAmount':
            next.taxAmount = numVal;
            break;
          case 'balance':
            next.balance = numVal;
            break;
          case 'grandTotal':
            next.grandTotal = numVal;
            break;
          default:
            if (col.fieldKey.startsWith('extra:')) {
              next.extraColumnsData = {
                ...(next.extraColumnsData || {}),
                [sheetInfo.sheetName]: {
                  ...(next.extraColumnsData?.[sheetInfo.sheetName] || {}),
                  [col.colLetter]: numVal,
                },
              };
            }
        }
      } else {
        switch (col.fieldKey) {
          case 'invoiceDate':
            next.invoiceDate = rawValue;
            break;
          case 'day':
            next.day = rawValue;
            break;
          case 'invoiceNumber':
            next.invoiceNumber = rawValue;
            break;
          case 'issuerName':
            next.issuerName = rawValue;
            break;
          case 'issuerTaxId':
            next.issuerTaxId = rawValue;
            break;
          case 'paymentMethod':
            next.customFieldsValues = { ...(next.customFieldsValues || {}), __official_payment_method: rawValue };
            break;
          default:
            if (col.fieldKey.startsWith('extra:')) {
              next.extraColumnsData = {
                ...(next.extraColumnsData || {}),
                [sheetInfo.sheetName]: {
                  ...(next.extraColumnsData?.[sheetInfo.sheetName] || {}),
                  [col.colLetter]: rawValue || undefined,
                },
              };
            }
        }
      }

      // Recalculate totals from source amounts, but preserve an explicit edit to the gross-total field.
      if (col.fieldKey !== 'grandTotal' && next.documentType === 'مبيعات') {
        if (next.cashSales !== undefined || next.networkSales !== undefined) {
          next.grandTotal = Number(next.cashSales ?? 0) + Number(next.networkSales ?? 0);
        }
      } else if (next.documentType === 'مشتريات') {
        if (next.subtotal !== undefined || next.taxAmount !== undefined) {
          next.grandTotal = Number(next.subtotal ?? 0) + Number(next.taxAmount ?? 0);
        }
      }

      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          الورقة: <strong className="text-slate-800">{sheetInfo.sheetName}</strong> • صف العناوين:{' '}
          <strong className="text-slate-800">{sheetInfo.headerRowNumber}</strong> • بداية البيانات:{' '}
          <strong className="text-slate-800">الصف {sheetInfo.dataStartRowNumber}</strong>
        </span>
        <span className="text-[11px] bg-slate-100 px-2.5 py-0.5 rounded-full text-slate-700 font-medium">
          {sheetInfo.columns.length} أعمدة من القالب الرسمي
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sheetInfo.columns.filter((col) => !col.fieldKey.startsWith('ignored:')).map((col) => {
          const val = getFieldValue(col);
          const isDateMissing = col.fieldKey === 'invoiceDate' && !String(val || '').trim();

          if (col.isFormula) {
            return (
              <div
                key={col.colLetter}
                className="p-3.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 flex flex-col justify-between gap-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-emerald-950">{col.name}</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    عمود {col.colLetter} • معادلة
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-sm font-extrabold text-emerald-800 pt-1">
                  <Calculator className="w-4 h-4 shrink-0 text-emerald-600" />
                  <span>{getComputedFormulaDisplay(col)}</span>
                </div>
                {col.fieldKey === 'formula:salesTotal' &&
                  invoice.grandTotal !== undefined &&
                  invoice.cashSales === undefined &&
                  invoice.networkSales === undefined && (
                    <span className="text-[11px] text-amber-700 font-medium">
                      مرجع مستخرج: {invoice.grandTotal.toFixed(2)} {invoice.currency}
                    </span>
                  )}
              </div>
            );
          }

          return (
            <div key={col.colLetter} className="space-y-1">
              <label className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-700">
                <span>
                  {col.name}
                  {col.fieldKey === 'invoiceDate' && <span className="text-red-500 mr-0.5">*</span>}
                </span>
                <span className="text-[10px] font-mono text-slate-400">عمود {col.colLetter}</span>
              </label>

              {col.fieldKey === 'operationNumber' ? (
                <div className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-100 text-xs font-bold text-slate-500 flex items-center justify-between">
                  <span>رقم تلقائي (#)</span>
                  <span className="text-[10px] bg-slate-200 px-2 py-0.5 rounded text-slate-700">تلقائي</span>
                </div>
              ) : col.kind === 'date' ? (
                <input
                  type="date"
                  value={String(val || '')}
                  onChange={(e) => handleFieldChange(col, e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-xs outline-none bg-white text-slate-900 font-medium focus:ring-2 focus:ring-emerald-500 ${
                    isDateMissing ? 'border-amber-400 bg-amber-50/30' : 'border-slate-300'
                  }`}
                />
              ) : col.kind === 'number' ? (
                <input
                  type="number"
                  step="0.01"
                  value={val ?? ''}
                  onChange={(e) => handleFieldChange(col, e.target.value)}
                  placeholder="اتركه فارغاً إذا غير متوفر"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-900 font-bold focus:ring-2 focus:ring-emerald-500"
                />
              ) : (
                <input
                  type="text"
                  value={String(val ?? '')}
                  onChange={(e) => handleFieldChange(col, e.target.value)}
                  placeholder={col.fieldKey === 'day' ? 'مثال: السبت' : `أدخل ${col.name}`}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs outline-none bg-white text-slate-900 focus:ring-2 focus:ring-emerald-500"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
