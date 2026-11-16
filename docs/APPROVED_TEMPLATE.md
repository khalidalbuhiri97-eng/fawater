# Approved Fawater workbook

The approved source workbook was validated before activation.

- Workbook: fawater_template.xlsx
- Sheets: ملخص الأداء, المبيعات, المشتريات والموردين
- Purchase headers (A:J): #, اسم المورد, الدفع, رقم الفاتورة, تأريخ الفاتورة, المبلغ قبل الضريبة, ضريبة القيمة المضافة, المبلغ شامل الضريبة, الرصيد, الرقم الضريبي للمورد
- Supplier name and supplier tax ID each occur in one dedicated column only.
- No restaurant-specific “ماكس” label exists in the purchases sheet.
- Preserved the workbook layout, merged cells, styles and totals formulas.
- Corrected the net-flow summary formula to =B6-D6, referencing the merged KPI value cells (B6 and D6).
- Validation was performed with openpyxl by reopening the generated XLSX and rechecking the purchase headers and formula.

This file is the canonical application asset at public/assets/templates/fawater_template.xlsx.
