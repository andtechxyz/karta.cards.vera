import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errorMsg } from '../utils/api';
import { biometricHint, detectDevice, deviceNameGuess } from '../utils/device';
import { activateWithSession } from '../utils/webauthn';

// /activate — identity-blind activation page.
//
// The user lands here in one of three ways:
//   1. SUN-tap success: `?session=<opaque-token>` set by the server's
//      `/activate/:cardRef` handler.  The page never knows the cardRef, UID,
//      last4, or cardholder name — that's the whole point of being a stolen-
//      card-resistant flow.
//   2. SUN-tap failure: `?error=<code>`.  Show a friendly message and ask
//      the user to tap again.
//   3. No params at all: probably someone hand-typed /activate.  Show the
//      "tap your card" prompt.
//
// The single user action is "tap the card again to register a passkey".

type Phase = 'idle' | 'busy' | 'done';

export default function Activate() {
  const [params] = useSearchParams();
  const sessionToken = params.get('session');
  const sunError = params.get('error');

  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string | null>(null);

  const device = useMemo(detectDevice, []);

  const onActivate = useCallback(async () => {
    if (!sessionToken) return;
    setPhase('busy');
    setErr(null);
    try {
      await activateWithSession({ sessionToken, deviceLabel: deviceNameGuess() });
      setPhase('done');
    } catch (e) {
      setErr(errorMsg(e));
      setPhase('idle');
    }
  }, [sessionToken]);

  // Auto-fire the WebAuthn ceremony as soon as we have a session — the user
  // has already tapped once to get here; making them push a button before
  // the second tap is busywork.  Skip on non-Android since the platform
  // doesn't speak NFC + CTAP1 reliably.
  useEffect(() => {
    if (sessionToken && phase === 'idle' && !err && device === 'android') {
      onActivate();
    }
  }, [sessionToken, phase, err, device, onActivate]);

  if (sunError) return <ErrorPanel title="Tap not recognised" code={sunError} />;

  if (!sessionToken) {
    return (
      <Page title="Tap your card">
        <p className="small">
          Hold your Palisade card flat against the back of your phone to start
          activation. The phone will redirect to a fresh page when it sees the card.
        </p>
      </Page>
    );
  }

  if (phase === 'done') {
    return (
      <Page title="Card activated" tone="ok">
        <p className="small">
          You can now use the card for payments. {biometricHint(device)} can be added
          at first checkout.
        </p>
      </Page>
    );
  }

  if (device !== 'android') {
    return (
      <Page title="Open this on Android Chrome">
        <p className="small">
          Activation needs an NFC tap, and Android Chrome is the only widely-supported
          browser for it today. Open this same link there, then tap your card.
        </p>
      </Page>
    );
  }

  return (
    <Page title="Tap your card again">
      <p className="small">
        Hold the card against the back of your phone. {phase === 'busy' && 'Waiting for tap…'}
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
