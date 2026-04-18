import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMsg } from '../utils/api';
import { biometricHint, detectDevice, deviceNameGuess } from '../utils/device';
import { activateWithSession } from '../utils/webauthn';

// /activate — identity-blind activation page.
//
// The user lands here in one of three ways:
//   1. SUN-tap success: `#hand=<handoff-token>` in the URL fragment, set by
//      the tap service's redirect.  The page exchanges the handoff token for
//      an activation session, then drives the WebAuthn ceremony.
//   2. SUN-tap failure: `?error=<code>`.  Show a friendly message and ask
//      the user to tap again.
//   3. No params at all: probably someone hand-typed /activate.  Show the
//      "tap your card" prompt.
//
// The handoff token lives in the URL *fragment* so it never appears in server
// logs — the server only sees the subsequent POST to /api/activation/handoff.

type Phase = 'idle' | 'exchanging' | 'busy' | 'done';

function extractHandToken(): string | null {
  const hash = window.location.hash; // e.g. "#hand=<token>"
  if (!hash.startsWith('#hand=')) return null;
  return decodeURIComponent(hash.slice('#hand='.length)) || null;
}

export default function Activate() {
  const [params] = useSearchParams();
  const sunError = params.get('error');

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [micrositeUrl, setMicrositeUrl] = useState<string | null>(null);

  const device = useMemo(detectDevice, []);

  // Exchange the handoff token for an activation session on mount.
  useEffect(() => {
    const handToken = extractHandToken();
    if (!handToken) return;

    setPhase('exchanging');
    api
      .post<{ sessionToken: string }>('/activation/handoff', { token: handToken })
      .then(({ sessionToken: tok }) => {
        setSessionToken(tok);
        // Clear the fragment so the token isn't bookmarked or logged.
        history.replaceState(null, '', window.location.pathname + window.location.search);
        setPhase('idle');
      })
      .catch((e) => {
        setErr(errorMsg(e));
        setPhase('idle');
      });
  }, []);

  const onActivate = useCallback(async () => {
    if (!sessionToken) return;
    setPhase('busy');
    setErr(null);
    try {
      const result = await activateWithSession({ sessionToken, deviceLabel: deviceNameGuess() });
      if (result.micrositeUrl) {
        setMicrositeUrl(result.micrositeUrl);
      }
      setPhase('done');
    } catch (e) {
      setErr(errorMsg(e));
      setPhase('idle');
    }
  }, [sessionToken]);

  // When activation succeeds and the program has a microsite configured,
  // redirect after a 2s delay so the user sees the confirmation screen first.
  useEffect(() => {
    if (phase === 'done' && micrositeUrl) {
      const t = setTimeout(() => {
        window.location.href = micrositeUrl;
      }, 2000);
      return () => clearTimeout(t);
    }
  }, [phase, micrositeUrl]);

  // Auto-fire activation as soon as we have a session — the user has already
  // tapped once to get here; making them push a button is busywork.  We
  // auto-fire on every device because the server's /begin response dictates
  // whether we need a second NFC WebAuthn tap (mode=register — Android only)
  // or we can confirm silently (mode=confirm — works on any device).
  useEffect(() => {
    if (sessionToken && phase === 'idle' && !err) {
      onActivate();
    }
  }, [sessionToken, phase, err, onActivate]);

  if (sunError) return <ErrorPanel title="Tap not recognised" code={sunError} />;

  if (phase === 'exchanging') {
    return (
      <Page title="Starting activation…">
        <p className="small">Verifying your tap…</p>
      </Page>
    );
  }

  if (!sessionToken && !err) {
    return (
      <Page title="Tap your card">
        <p className="small">
          Hold your Palisade card flat against the back of your phone to start
          activation. The phone will redirect to a fresh page when it sees the card.
        </p>
      </Page>
    );
  }

  if (!sessionToken && err) {
    return (
      <Page title="Activation failed" tone="err">
        <p className="small">{err}</p>
        <p className="small">Tap the card to your phone again to retry.</p>
      </Page>
    );
  }

  if (phase === 'done') {
    return (
      <Page title="Card activated" tone="ok">
        {micrositeUrl ? (
          <p className="small">
            Redirecting you to your card's welcome page…
          </p>
        ) : (
          <p className="small">
            You can now use the card for payments. {biometricHint(device)} can be added
            at first checkout.
          </p>
        )}
      </Page>
    );
  }

  // Show the "use Android Chrome" message ONLY if we hit an error on
  // non-Android — pre-registered credentials (confirm mode) don't need a
  // WebAuthn ceremony and work on any device, so we don't gate the page
  // on device until we have evidence the current flow actually needs it.
  if (device !== 'android' && err) {
    return (
      <Page title="Open this on Android Chrome">
        <p className="small">
          This card needs a fresh WebAuthn registration, and Android Chrome is
          the only widely-supported browser for NFC WebAuthn today.  Open the
          same link there, then tap your card.
        </p>
        <p className="small" style={{ marginTop: 12, opacity: 0.7 }}>
          Error: <span className="mono">{err}</span>
        </p>
      </Page>
    );
  }

  return (
    <Page title="Tap your card again">
      <p className="small">
        Hold the card against the back of your phone.{' '}
        {phase === 'busy' && 'Waiting for tap…'}
      </p>
      {err && <p className="tag err" style={{ marginTop: 12 }}>{err}</p>}
      {err && (
        <button
          className="btn primary"
          onClick={onActivate}
          disabled={phase === 'busy'}
          style={{ width: '100%', marginTop: 12 }}
        >
          Try again
        </button>
      )}
    </Page>
  );
}

function Page({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'ok' | 'err';
  children: React.ReactNode;
}) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="panel">
        {tone && <p className={`tag ${tone}`} style={{ marginBottom: 12 }}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

function ErrorPanel({ title, code }: { title: string; code: string }) {
  return (
    <Page title={title} tone="err">
      <p className="small">
        Reason: <span className="mono">{code}</span>
      </p>
      <p className="small">Tap the card to your phone again to retry.</p>
    </Page>
  );
}
