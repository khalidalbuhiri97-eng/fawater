import React, { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from './supabaseClient';
import { setLocalStoreUserScope } from '../services/localStore';
import { LockKeyhole, Mail, KeyRound, Loader2, LogIn, UserPlus, RotateCcw } from 'lucide-react';

type Mode = 'login' | 'signup' | 'reset';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let supabase;
    try {
      supabase = getSupabaseBrowserClient();
    } catch (e: any) {
      setError(e?.message || 'تعذر تهيئة خدمة الدخول.');
      setReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      if (active) { setLocalStoreUserScope(data.session?.user.id || null); setSession(data.session); setReady(true); }
    }).catch(() => { if (active) setReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) { setLocalStoreUserScope(nextSession?.user.id || null); setSession(nextSession); }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const supabase = getSupabaseBrowserClient();
      if (mode === 'login') {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
      } else if (mode === 'signup') {
        if (password.length < 10) throw new Error('استخدم كلمة مرور من 10 أحرف على الأقل.');
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: window.location.origin },
        });
        if (authError) throw authError;
        if (!data.session) setMessage('تم إنشاء الحساب. تحقق من بريدك الإلكتروني لتأكيده ثم سجّل الدخول.');
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin,
        });
        if (authError) throw authError;
        setMessage('إذا كان البريد مسجلاً، فستصلك رسالة لاستعادة كلمة المرور.');
      }
    } catch (e: any) {
      setError(e?.message || 'تعذر إكمال العملية. حاول مرة أخرى.');
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try { await getSupabaseBrowserClient().auth.signOut(); }
    finally { setBusy(false); }
  }

  if (!ready) return <div dir="rtl" className="min-h-screen grid place-items-center bg-slate-100"><Loader2 className="animate-spin text-emerald-600" /></div>;
  if (session) {
    return <>{children}<button onClick={logout} disabled={busy} className="fixed bottom-4 left-4 z-[100] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-lg hover:bg-slate-50 disabled:opacity-50">{busy ? 'جارٍ الخروج...' : 'تسجيل الخروج'}</button></>;
  }

  return (
    <main dir="rtl" className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 px-4 py-10 flex items-center justify-center">
      <section className="w-full max-w-md rounded-3xl border border-white/10 bg-white p-7 sm:p-9 shadow-2xl">
        <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-emerald-100 text-emerald-700"><LockKeyhole size={27}/></div>
        <h1 className="text-center text-2xl font-black text-slate-900">فواتير | Fawater</h1>
        <p className="mt-2 text-center text-sm text-slate-500">{mode === 'login' ? 'سجّل الدخول إلى مساحة عملك' : mode === 'signup' ? 'أنشئ حسابك للبدء' : 'استعادة الوصول إلى حسابك'}</p>
        <form onSubmit={submit} className="mt-7 space-y-4">
          {mode === 'signup' && <label className="block text-sm font-semibold text-slate-700">الاسم الكامل<input required value={fullName} onChange={e=>setFullName(e.target.value)} autoComplete="name" className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-emerald-500"/></label>}
          <label className="block text-sm font-semibold text-slate-700"><span className="flex items-center gap-2"><Mail size={16}/> البريد الإلكتروني</span><input required type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-emerald-500" placeholder="name@example.com"/></label>
          {mode !== 'reset' && <label className="block text-sm font-semibold text-slate-700"><span className="flex items-center gap-2"><KeyRound size={16}/> كلمة المرور</span><input required type="password" value={password} onChange={e=>setPassword(e.target.value)} minLength={mode==='signup'?10:1} autoComplete={mode==='login'?'current-password':'new-password'} className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-emerald-500" placeholder={mode==='signup'?'10 أحرف على الأقل':'••••••••••'}/></label>}
          {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
          <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3.5 font-bold text-white hover:bg-emerald-500 disabled:opacity-60">{busy?<Loader2 className="animate-spin" size={18}/>:mode==='login'?<LogIn size={18}/>:mode==='signup'?<UserPlus size={18}/>:<RotateCcw size={18}/>} {mode==='login'?'تسجيل الدخول':mode==='signup'?'إنشاء الحساب':'إرسال رابط الاستعادة'}</button>
        </form>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
          {mode!=='login' && <button onClick={()=>{setMode('login');setError('');setMessage('');}} className="font-semibold text-emerald-700">العودة لتسجيل الدخول</button>}
          {mode==='login' && <><button onClick={()=>{setMode('signup');setError('');setMessage('');}} className="font-semibold text-emerald-700">إنشاء حساب جديد</button><button onClick={()=>{setMode('reset');setError('');setMessage('');}} className="text-slate-500 hover:text-slate-800">نسيت كلمة المرور؟</button></>}
        </div>
        <p className="mt-7 text-center text-xs leading-6 text-slate-400">تسجيل الدخول لا يمنح صلاحية الوصول إلى مؤسسة تلقائيًا؛ يجب أن تكون عضوًا معتمدًا فيها.</p>
      </section>
    </main>
  );
}
