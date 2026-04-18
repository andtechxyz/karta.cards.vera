// Read-only reference panel for the FI's SFTP endpoint.  v1 provisions
// accounts via the vera/SFTP_USERS Secrets Manager secret — no CRUD in
// the UI yet.  Ops mints a key pair for the partner, pastes the public
// key into SFTP_USERS, and restarts the vera-sftp service.  This panel
// shows the partner-facing connection details so support can hand them
// to the integrator without going digging.

export function SftpAccessSection({ fiSlug }: { fiSlug: string }) {
  const host = 'sftp.karta.cards';
  return (
    <div style={{ marginTop: 24, padding: 16, border: '1px solid var(--edge)', borderRadius: 'var(--radius)', background: 'var(--panel-2)' }}>
      <h3 style={{ marginTop: 0 }}>SFTP access</h3>
      <p className="small" style={{ marginTop: 0 }}>
        Alternative to the HTTP Partner API.  Partners drop batches into their
        home directory; the ingester picks them up every 30 seconds and creates
        a RECEIVED EmbossingBatch.
      </p>
      <table className="kv" style={{ marginBottom: 8 }}>
        <tbody>
          <tr><th>Host</th><td><code>{host}</code></td></tr>
          <tr><th>Port</th><td><code>22</code></td></tr>
          <tr><th>Username</th><td><code>{fiSlug}</code></td></tr>
          <tr><th>Auth</th><td>SSH public key (ed25519 or RSA-4096)</td></tr>
          <tr>
            <th>Upload path</th>
            <td><code>/upload/&lt;programId&gt;/&lt;templateId&gt;/&lt;filename&gt;</code></td>
          </tr>
        </tbody>
      </table>
      <p className="small" style={{ marginTop: 8 }}>
        To onboard a partner: receive their SSH public key, append it to the{' '}
        <code>vera/SFTP_USERS</code> secret with username=<code>{fiSlug}</code>,
        and restart <code>vera-sftp</code>.  Processed files move to{' '}
        <code>/processed/&lt;date&gt;/</code>; rejects to{' '}
        <code>/failed/&lt;date&gt;/</code> with a <code>.err</code> file.
      </p>
    </div>
  );
}
