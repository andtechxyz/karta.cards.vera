import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Admin from './pages/Admin';
import { clearAdminKey, getAdminKey, onUnauthorized, setAdminKey } from './utils/api';

// AdminKeyGate blocks the admin UI until a 64-char hex key is provided and
// accepted (either sessionStorage has one, or the user enters one).  Any 401
// response from the api layer clears the key and drops back to this screen.

export default function App() {
  const [hasKey, setHasKey] = useState(() => Boolean(getAdminKey()));

  useEffect(() => onUnauthorized(() => setHasKey(false)), []);

  if (!hasKey) {
    return (
      <div className="app">
        <AdminKeyPrompt onAccept={() => setHasKey(true)} />
      </div>
    );
  }

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px' }}>
        <button
          className="btn ghost"
          onClick={() => { clearAdminKey(); setHasKey(false); }}
        >
          Sign out
        </button>
      </div>
      <Routes>
        <Route path="/" element={<Admin />} />
        <Route path="/admin" element={<Admin />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>Not found</h1>
            </div>
          }
        />
      </Routes>
    </div>
  );
}

function AdminKeyPrompt({ onAccept }: { onAccept: () => void }) {
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    // Client-side shape check so a typo doesn't cost a round-trip.  The
    // backend does the authoritative constant-time compare.
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      setErr('Admin key must be 64 hex characters (32 bytes).');
      return;
    }
    setAdminKey(trimmed);
    setErr(null);
    onAccept();
  };

  return (
    <div className="page">
      <h1>Vera Admin</h1>
      <div className="panel" style={{ maxWidth: 560 }}>
        <h2 style={{ marginTop: 0 }}>Admin key required</h2>
        <p className="small">
          Paste the 32-byte hex admin key. Stored in sessionStorage — cleared
          when this tab closes, and any 401 from the backend re-prompts.
        </p>
        <form onSubmit={submit}>
          <label>X-Admin-Key</label>
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mono"
            placeholder="64 hex chars"
          />
          {err && <p className="tag err" style={{ marginTop: 8 }}>{err}</p>}
          <div style={{ marginTop: 12 }}>
            <button type="submit" className="btn primary" disabled={!value.trim()}>
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

