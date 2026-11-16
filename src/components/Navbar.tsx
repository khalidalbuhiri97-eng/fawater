import React, { useEffect, useState } from 'react';
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
  Sparkles,
  UserRound,
  Settings,
  LogOut,
  X,
  ShieldCheck,
} from 'lucide-react';
import { getSupabaseBrowserClient } from '../auth/supabaseClient';
import { Operation, SyncOverview } from '../types';

interface NavbarProps {
  currentOperation?: Operation;
  syncOverview?: SyncOverview;
  onManualSync?: () => void;
  onGoHome: () => void;
  onOpenNewOperation: () => void;
  onDownloadExcel: () => void;
  onOpenProcessingDialog?: () => void;
  hasActiveJobs?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentOperation,
  syncOverview,
  onManualSync,
  onGoHome,
  onOpenNewOperation,
  onDownloadExcel,
  onOpenProcessingDialog,
  hasActiveJobs,
}) => {
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [accountName, setAccountName] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [accountError, setAccountError] = useState('');

  useEffect(() => {
    let active = true;
    getSupabaseBrowserClient().auth.getUser().then(({ data }) => {
      if (!active) return;
      setAccountEmail(data.user?.email || '');
      setAccountName(String(data.user?.user_metadata?.full_name || data.user?.user_metadata?.name || ''));
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const handleLogout = async () => {
    setLogoutBusy(true);
    setAccountError('');
    try {
      const { error } = await getSupabaseBrowserClient().auth.signOut();
      if (error) throw error;
      setAccountOpen(false);
    } catch (error: any) {
      setAccountError(error?.message || 'تعذر تسجيل الخروج. حاول مرة أخرى.');
    } finally {
      setLogoutBusy(false);
    }
  };

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

          {onOpenProcessingDialog && (
            <button
              type="button"
              onClick={onOpenProcessingDialog}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition border ${
                hasActiveJobs
                  ? 'bg-blue-600 hover:bg-blue-500 text-white border-blue-500 animate-pulse'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="متابعة حالة معالجة الفواتير في الخلفية"
            >
              <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
              <span>معالجة الفواتير {hasActiveJobs ? '(قيد المعالجة)' : ''}</span>
            </button>
          )}

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
          <button
            type="button"
            onClick={() => { setAccountOpen(true); setSettingsOpen(false); setAccountError(''); }}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-slate-200 transition hover:border-emerald-500 hover:bg-slate-700 hover:text-emerald-300"
            aria-label="فتح القائمة الجانبية للحساب والإعدادات"
            title="الحساب والإعدادات"
          >
            <UserRound className="h-5 w-5" />
          </button>
        </div>
      </div>
      {accountOpen && (
        <div className="fixed inset-0 z-[80]">
          <button type="button" aria-label="إغلاق القائمة الجانبية" onClick={() => setAccountOpen(false)} className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]" />
          <aside dir="rtl" className="absolute right-0 top-0 flex h-full w-[min(88vw,360px)] flex-col border-l border-slate-200 bg-white text-slate-900 shadow-2xl animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-900 px-5 py-5 text-white">
              <div className="flex items-center gap-3 min-w-0">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-300"><UserRound className="h-6 w-6" /></div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold">{accountName || 'حساب المستخدم'}</div>
                  <div className="truncate text-xs text-slate-300">{accountEmail || 'حساب Fawater'}</div>
                </div>
              </div>
              <button type="button" onClick={() => setAccountOpen(false)} className="rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-white" aria-label="إغلاق"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              <div className="px-2 pb-1 text-[11px] font-bold text-slate-400">الحساب</div>
              <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                <UserRound className="h-5 w-5 text-slate-500" />
                <div className="min-w-0"><div className="text-sm font-semibold">الملف الشخصي</div><div className="truncate text-xs text-slate-500">{accountEmail || 'بيانات الحساب'}</div></div>
              </div>
              <button type="button" onClick={() => setSettingsOpen((open) => !open)} className="flex w-full items-center justify-between rounded-xl border border-slate-200 p-3 text-right transition hover:border-emerald-300 hover:bg-emerald-50/50">
                <span className="flex items-center gap-3"><Settings className="h-5 w-5 text-slate-500" /><span className="text-sm font-semibold">الإعدادات</span></span>
                <span className="text-xs text-slate-400">{settingsOpen ? 'إخفاء' : 'عرض'}</span>
              </button>
              {settingsOpen && (
                <div className="space-y-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm">
                  <div className="flex items-center gap-2 font-semibold text-slate-700"><ShieldCheck className="h-4 w-4 text-emerald-600" /> أمان الحساب</div>
                  <p className="text-xs leading-6 text-slate-500">يتم تأمين تسجيل الدخول وإدارة الجلسة بواسطة Supabase. استخدم خيار استعادة كلمة المرور من شاشة تسجيل الدخول لتغيير كلمة المرور.</p>
                  <div className="text-xs text-slate-500">البريد الإلكتروني: <span className="font-medium text-slate-700">{accountEmail || 'غير متاح'}</span></div>
                </div>
              )}
              {accountError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{accountError}</p>}
            </div>
            <div className="border-t border-slate-100 p-4">
              <button type="button" onClick={handleLogout} disabled={logoutBusy} className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 transition hover:bg-red-100 disabled:opacity-60">
                {logoutBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                {logoutBusy ? 'جارٍ تسجيل الخروج...' : 'تسجيل الخروج'}
              </button>
            </div>
          </aside>
        </div>
      )}
    </header>
  );
};
