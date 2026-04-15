import { request as undiciRequest } from 'undici';
import { badRequest } from '@vera/core';
import { consumeRetrievalToken } from './retrieval.service.js';
import { substitute, substituteHeaders, type TemplateValues } from './template.js';
import { vaultEvents } from './events.js';

// -----------------------------------------------------------------------------
// Generic outbound proxy — the Basis-Theory parallel.
// -----------------------------------------------------------------------------

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface ProxyInput {
  retrievalToken: string;
  destination: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  expectedAmount: number;
  expectedCurrency: string;
  actor: string;
  purpose: string;
  ip?: string;
  ua?: string;
  transactionId?: string;
}

export interface ProxyResult {
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export async function forwardViaVault(input: ProxyInput): Promise<ProxyResult> {
  const method = (input.method ?? 'POST').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw badRequest('method_not_allowed', `Proxy method must be one of ${[...ALLOWED_METHODS].join(', ')}`);
  }

  let url: URL;
  try {
    url = new URL(input.destination);
  } catch {
    throw badRequest('invalid_destination', 'destination must be an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw badRequest(
      'insecure_destination',
      'Proxy destinations must be https:// — refusing to send plaintext over plain HTTP',
    );
  }

  const consumed = await consumeRetrievalToken(input.retrievalToken, {
    expectedAmount: input.expectedAmount,
    expectedCurrency: input.expectedCurrency,
    actor: input.actor,
    purpose: input.purpose,
    ip: input.ip,
    ua: input.ua,
    transactionId: input.transactionId,
  });

  const values: TemplateValues = {
    pan: consumed.card.pan,
    cvc: consumed.card.cvc,
    expMonth: consumed.card.expMonth,
    expYear: consumed.card.expYear,
    cardholderName: consumed.card.cardholderName ?? '',
    last4: consumed.card.last4,
    bin: consumed.card.bin,
  };

  const outHeaders = substituteHeaders(input.headers ?? {}, values);
  const outBody = input.body ? substitute(input.body, values) : undefined;

  try {
    const { statusCode, headers, body } = await undiciRequest(url.toString(), {
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      headers: outHeaders,
      body: outBody,
    });
    const responseBody = await body.text();
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      responseHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }

    vaultEvents.emit({
      type: 'PROXY_FORWARDED',
      vaultEntryId: consumed.vaultEntryId,
      retrievalTokenId: consumed.retrievalTokenId,
      destination: url.toString(),
      actor: input.actor,
      purpose: input.purpose,
      ip: input.ip,
      ua: input.ua,
      success: statusCode < 500,
    });

    return { status: statusCode, responseHeaders, responseBody };
  } catch (err) {
    vaultEvents.emit({
      type: 'PROXY_FORWARDED',
      vaultEntryId: consumed.vaultEntryId,
      retrievalTokenId: consumed.retrievalTokenId,
      destination: url.toString(),
      actor: input.actor,
      purpose: input.purpose,
      ip: input.ip,
      ua: input.ua,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
