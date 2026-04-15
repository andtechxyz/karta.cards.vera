import { getConfig } from '../config.js';

/**
 * Provides raw data-encryption keys (DEKs) by version.
 *
 * For v0 this reads from env (VAULT_KEY_V1 etc.).  Swapping to AWS KMS is
 * a one-file replacement: implement KeyProvider.getKey to call kms.Decrypt
 * on a wrapped DEK; the rest of the vault module doesn't change.
 */
export interface KeyProvider {
  /** Current active key version for new writes. */
  readonly activeVersion: number;
  /** Returns the raw DEK bytes for a given version. Throws if unknown. */
  getKey(version: number): Buffer;
}

export class EnvKeyProvider implements KeyProvider {
  readonly activeVersion: number;
  private keys = new Map<number, Buffer>();

  constructor() {
    const config = getConfig();
    this.activeVersion = config.VAULT_KEY_ACTIVE_VERSION;
    // Only v1 is defined for v0 of the prototype; extend by adding VAULT_KEY_V2
    // to config + a lookup here. The versioning machinery is what matters.
    this.keys.set(1, Buffer.from(config.VAULT_KEY_V1, 'hex'));
    if (!this.keys.has(this.activeVersion)) {
      throw new Error(
        `VAULT_KEY_ACTIVE_VERSION=${this.activeVersion} but no VAULT_KEY_V${this.activeVersion} is configured`,
      );
    }
  }

  getKey(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown vault key version: ${version}`);
    return key;
  }
}

let cached: KeyProvider | null = null;
export function getKeyProvider(): KeyProvider {
  if (!cached) cached = new EnvKeyProvider();
  return cached;
}
