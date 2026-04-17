// Minimal fetch wrapper.  Everything lives under /api and is served from the
// same origin (Vite proxies to the admin backend in dev; Cloudflare routes
// manage.karta.cards to the admin service in production).
//
// Every request carries a Cognito ID token (Authorization: Bearer).  A 401
// response clears stored tokens and triggers a re-login prompt.

const ID_TOKEN_STORAGE = 'vera.adminIdToken';
const REFRESH_TOKEN_STORAGE = 'vera.adminRefreshToken';

export function getAuthToken(): string | null {
  return localStorage.getItem(ID_TOKEN_STORAGE);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(ID_TOKEN_STORAGE, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(ID_TOKEN_STORAGE);
  localStorage.removeItem(REFRESH_TOKEN_STORAGE);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_STORAGE);
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_TOKEN_STORAGE, token);
}

/**
 * Subscribe to 401 responses from the API layer.  Admin.tsx uses this to drop
 * back to the login screen when the JWT expires.
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
  const token = getAuthToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : undefined;
  if (res.status === 401) {
    clearAuthToken();
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
