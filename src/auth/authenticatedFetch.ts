import { getSupabaseBrowserClient } from './supabaseClient';

let installed = false;

/** Attach the current Supabase access token to same-origin API calls. */
export function installAuthenticatedFetch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    try {
      const { data } = await getSupabaseBrowserClient().auth.getSession();
      if (data.session?.access_token) headers.set('Authorization', `Bearer ${data.session.access_token}`);
    } catch {
      // The server will reject an API call without a valid bearer token.
    }
    return nativeFetch(input, { ...init, headers });
  };
}
