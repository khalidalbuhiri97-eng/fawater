import { getSupabaseBrowserClient } from './supabaseClient';

let installed = false;

/** Attach the current Supabase access token to same-origin API calls. */
export function installAuthenticatedFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const target = window;
  const nativeFetch = typeof target.fetch === 'function' ? target.fetch.bind(target) : undefined;
  if (!nativeFetch) return;

  const authenticatedFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(rawUrl, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
        return nativeFetch(input, init);
      }
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      }
      try {
        const { data } = await getSupabaseBrowserClient().auth.getSession();
        if (data.session?.access_token) {
          headers.set('Authorization', `Bearer ${data.session.access_token}`);
        }
      } catch {
        // Supabase client may not be configured yet or session may be empty
      }
      return nativeFetch(input, { ...init, headers });
    } catch {
      return nativeFetch(input, init);
    }
  };

  // Safely define fetch on window/globalThis using Object.defineProperty to prevent
  // "TypeError: Cannot set property fetch of #<Window> which has only a getter"
  let applied = false;

  try {
    Object.defineProperty(target, 'fetch', {
      value: authenticatedFetch,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    applied = true;
  } catch {}

  if (!applied) {
    try {
      if (typeof Window !== 'undefined' && Window.prototype) {
        Object.defineProperty(Window.prototype, 'fetch', {
          value: authenticatedFetch,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        applied = true;
      }
    } catch {}
  }

  if (!applied && typeof globalThis !== 'undefined') {
    try {
      Object.defineProperty(globalThis, 'fetch', {
        value: authenticatedFetch,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      applied = true;
    } catch {}
  }

  if (!applied) {
    try {
      (target as any).fetch = authenticatedFetch;
    } catch (err) {
      console.warn('Unable to patch global fetch:', err);
    }
  }
}

