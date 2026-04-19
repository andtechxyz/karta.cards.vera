// Dual-backend fetch wrapper.  The shared admin SPA talks to two services:
//
//   - Vera admin  (vault, transactions, audit, tokenisation-programs)
//   - Palisade admin  (cards, programs, embossing, provisioning, microsites)
//
// `api.vera` and `api.palisade` resolve the paths against their respective
// base URLs so a feature page just picks the right client.  Defaults
// (`/api` and `/palisade-api`) assume a reverse proxy at the edge; dev
// uses Vite proxies to route to localhost backends on different ports.
//
// Every request carries the same Cognito ID token (Authorization: Bearer) —
// both backends validate against the same user pool.  A 401 on either
// clears the token and triggers the re-login prompt.

const ID_TOKEN_STORAGE = 'vera.adminIdToken';
const REFRESH_TOKEN_STORAGE = 'vera.adminRefreshToken';

const VERA_BASE: string =
  (import.meta.env.VITE_VERA_BASE_URL as string | undefined) ?? '/api';
const PALISADE_BASE: string =
  (import.meta.env.VITE_PALISADE_BASE_URL as string | undefined) ?? '/palisade-api';

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

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  const token = getAuthToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
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

function makeClient(baseUrl: string) {
  return {
    get: <T>(p: string) => request<T>(baseUrl, 'GET', p),
    post: <T>(p: string, body?: unknown) => request<T>(baseUrl, 'POST', p, body),
    patch: <T>(p: string, body?: unknown) => request<T>(baseUrl, 'PATCH', p, body),
    delete: <T>(p: string) => request<T>(baseUrl, 'DELETE', p),
  };
}

export const api = {
  vera: makeClient(VERA_BASE),
  palisade: makeClient(PALISADE_BASE),
  setAuthToken,
};

export interface Capabilities {
  hasVera: boolean;
  hasPalisade: boolean;
}

/**
 * Fetch the capability flags from Vera admin.  Called before login so the
 * login screen renders the correct tab groups, and again after login so the
 * token isn't wasted on an anonymous endpoint twice.
 */
export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await fetch(`${VERA_BASE}/capabilities`);
  if (!res.ok) {
    // If Vera is unreachable the SPA is useless anyway; surface a pessimistic
    // default rather than masking the outage.
    throw new ApiError(res.status, 'capabilities_unavailable', res.statusText);
  }
  return (await res.json()) as Capabilities;
}

/** Format an error from `request()` (or any throw) for human display. */
export function errorMsg(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
