import { EnvKeyProvider, type KeyProvider } from '@vera/core';
import { getVaultConfig } from '../env.js';

// -----------------------------------------------------------------------------
// Vault-service-local KeyProvider — wraps the VAULT_PAN_DEK keyspace.
//
// Only vault-service encrypts or decrypts PANs; no other service reads this
// key.  Separate from the card-field DEK used by activation + tap to contain
// blast radius (PCI-DSS 3.5/3.6).
// -----------------------------------------------------------------------------

let _kp: EnvKeyProvider | null = null;

export function getVaultPanKeyProvider(): KeyProvider {
  if (!_kp) {
    const config = getVaultConfig();
    _kp = new EnvKeyProvider({
      activeVersion: config.VAULT_PAN_DEK_ACTIVE_VERSION,
      keys: { 1: config.VAULT_PAN_DEK_V1 },
    });
  }
  return _kp;
}

/** Test hook — reset the cached provider after env changes. */
export function _resetVaultPanKeyProvider(): void {
  _kp = null;
}
