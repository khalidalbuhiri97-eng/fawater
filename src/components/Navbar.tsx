import React from 'react';
import { FileSpreadsheet, Building2, Plus, Sparkles, Home, Download, Settings } from 'lucide-react';
import { Operation } from '../types';

interface NavbarProps {
  currentOperation?: Operation;
  onGoHome: () => void;
  onOpenNewOperation: () => void;
  onDownloadExcel: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentOperation,
  onGoHome,
  onOpenNewOperation,
  onDownloadExcel,
}) => {
  return (
    <header className="bg-slate-900 text-white shadow-md sticky top-0 z-40 border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button 
            onClick={onGoHome}
            className="flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition font-bold text-lg"
          >
            <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <span>نظام "سوق" للفواتير الذكية</span>
          </button>

          {currentOperation && (
            <div className="hidden md:flex items-center gap-2 mr-6 px-3 py-1 bg-slate-800 rounded-lg border border-slate-700 text-sm">
              <Building2 className="w-4 h-4 text-emerald-400" />
              <span className="font-medium text-slate-200">{currentOperation.name}</span>
              <span className="text-xs px-2 py-0.5 bg-emerald-950 text-emerald-300 rounded-full border border-emerald-800/50">
                {currentOperation.activityType}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {currentOperation ? (
            <>
              <button
                onClick={onGoHome}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition border border-slate-700"
              >
                <Home className="w-4 h-4" />
                <span>العمليات</span>
              </button>
              <button
                onClick={onDownloadExcel}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition shadow-sm"
              >
                <Download className="w-4 h-4" />
                <span>تحميل Excel</span>
              </button>
            </>
          ) : (
            <button
              onClick={onOpenNewOperation}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-medium transition shadow-md"
            >
              <Plus className="w-4 h-4" />
              <span>إنشاء عملية جديدة</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
