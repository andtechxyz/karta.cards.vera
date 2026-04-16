// Minimal fetch wrapper.  Everything lives under /api and is served from the
// same origin (Vite proxies to the admin backend in dev; Cloudflare Tunnel
// collapses front+back behind manage.karta.cards in the demo).
//
// Every request carries X-Admin-Key from sessionStorage.  A 401 response
// clears the stored key and triggers the App-level gate to re-prompt.

const KEY_STORAGE = 'vera.adminKey';
const TOKEN_STORAGE = 'admin_token';
// Must match ADMIN_KEY_HEADER in services/admin/src/middleware/require-admin-key.ts.
const ADMIN_KEY_HEADER = 'x-admin-key';

export function getAdminKey(): string | null {
  return sessionStorage.getItem(KEY_STORAGE);
}

export function setAdminKey(key: string): void {
  sessionStorage.setItem(KEY_STORAGE, key);
}

export function clearAdminKey(): void {
  sessionStorage.removeItem(KEY_STORAGE);
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_STORAGE);
}

/**
 * Subscribe to 401 responses from the API layer.  App.tsx uses this to drop
 * back to the key-entry screen without a full page reload, preserving any
 * in-flight user input elsewhere in the UI.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  const adminKey = getAdminKey();
  if (adminKey) headers[ADMIN_KEY_HEADER] = adminKey;
  const authToken = getAuthToken();
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : undefined;
  if (res.status === 401) {
    clearAdminKey();
    unauthorizedHandler?.();
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'unknown_error',
      data?.error?.message ?? res.statusText,
      data,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body),
  patch: <T>(p: string, body?: unknown) => request<T>('PATCH', p, body),
  delete: <T>(p: string) => request<T>('DELETE', p),
  setAuthToken,
};

/** Format an error from `request()` (or any throw) for human display. */
export function errorMsg(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
