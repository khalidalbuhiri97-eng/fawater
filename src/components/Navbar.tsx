import React from 'react';
import {
  FileSpreadsheet,
  Building2,
  Plus,
  Home,
  Download,
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { Operation, SyncOverview } from '../types';

interface NavbarProps {
  currentOperation?: Operation;
  syncOverview?: SyncOverview;
  onManualSync?: () => void;
  onGoHome: () => void;
  onOpenNewOperation: () => void;
  onDownloadExcel: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentOperation,
  syncOverview,
  onManualSync,
  onGoHome,
  onOpenNewOperation,
  onDownloadExcel,
}) => {
  const renderSyncPill = () => {
    if (!syncOverview) return null;

    if (!syncOverview.isOnline) {
      return (
        <div
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-950/80 border border-amber-700/60 text-amber-200 text-xs"
          title="غير متصل بالإنترنت — يتم الحفظ محلياً في IndexedDB وستتم المزامنة عند عودة الاتصال"
        >
          <WifiOff className="w-3.5 h-3.5 text-amber-400" />
          <span>غير متصل ({syncOverview.pendingCount} معلق)</span>
        </div>
      );
    }

    if (!syncOverview.supabaseConfigured) {
      return (
        <div
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs"
          title="قاعدة البيانات السحابية غير مهيأة بعد — الحفظ يعمل محلياً عبر IndexedDB"
        >
          <Wifi className="w-3.5 h-3.5 text-slate-400" />
          <span>تخزين محلي (IndexedDB)</span>
        </div>
      );
    }

    if (syncOverview.status === 'syncing') {
      return (
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-950/80 border border-blue-700/60 text-blue-200 text-xs">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />
          <span>جاري المزامنة...</span>
        </div>
      );
    }

    if (syncOverview.status === 'connection_error' || (syncOverview.supabaseConfigured && !syncOverview.supabaseConnected)) {
      return (
        <button
          type="button"
          onClick={onManualSync}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-950/80 border border-red-700/60 text-red-200 text-xs hover:bg-red-900/80 transition"
          title={syncOverview.lastError || 'اتصال Supabase غير جاهز — الحفظ يعمل محلياً في IndexedDB'}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span>تعذر ربط Supabase (حفظ محلي)</span>
        </button>
      );
    }

    if (syncOverview.status === 'failed') {
      return (
        <button
          type="button"
          onClick={onManualSync}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-950/80 border border-red-700/60 text-red-200 text-xs hover:bg-red-900/80 transition"
          title={syncOverview.lastError || 'فشل بعض عمليات المزامنة — انقر لإعادة المحاولة'}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          <span>فشل مزامنة ({syncOverview.failedCount}) • إعادة</span>
        </button>
      );
    }

    if (syncOverview.pendingCount > 0) {
      return (
        <button
          type="button"
          onClick={onManualSync}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-950/80 border border-amber-700/60 text-amber-200 text-xs hover:bg-amber-900/80 transition"
        >
          <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
          <span>بانتظار المزامنة ({syncOverview.pendingCount})</span>
        </button>
      );
    }

    if (syncOverview.supabaseConnected && syncOverview.status === 'synced') {
      return (
        <button
          type="button"
          onClick={onManualSync}
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/80 border border-emerald-700/50 text-emerald-200 text-xs hover:bg-emerald-900/70 transition"
          title="متصل ومتزامن مع Supabase"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span>متصل ومتزامن</span>
        </button>
      );
    }

    return null;
  };

  return (
    <header className="bg-slate-900 text-white shadow-md sticky top-0 z-40 border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onGoHome}
            className="flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition font-bold text-base sm:text-lg shrink-0"
          >
            <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <span>نظام Fawater للفواتير الذكية</span>
          </button>

          {currentOperation && (
            <div className="hidden lg:flex items-center gap-2 mr-4 px-3 py-1 bg-slate-800 rounded-lg border border-slate-700 text-sm">
              <Building2 className="w-4 h-4 text-emerald-400" />
              <span className="font-medium text-slate-200 truncate max-w-[160px]">{currentOperation.name}</span>
              <span className="text-xs px-2 py-0.5 bg-emerald-950 text-emerald-300 rounded-full border border-emerald-800/50">
                {currentOperation.activityType}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {renderSyncPill()}

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
