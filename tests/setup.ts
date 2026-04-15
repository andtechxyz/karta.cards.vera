// Vitest global setup.  Provides deterministic env defaults so getConfig()
// validates and crypto-keyed helpers produce stable outputs across runs.
//
// Tests that need a different config can override process.env and call
// _resetConfigCache() before exercising the SUT.

const HEX32 = '0'.repeat(64);
const HEX32_B = '1'.repeat(64);
const HEX32_C = '2'.repeat(64);

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  // DATABASE_URL is required by the schema but unit tests never connect.
  DATABASE_URL: 'postgresql://test:test@localhost:5432/vera_test?schema=public',
  WEBAUTHN_RP_ID: 'pay.karta.cards',
  WEBAUTHN_ORIGIN: 'https://pay.karta.cards',
  WEBAUTHN_ORIGINS: 'https://pay.karta.cards,https://tap.karta.cards,https://activation.karta.cards,https://admin.karta.cards,https://vault.karta.cards',
  WEBAUTHN_RP_NAME: 'Palisade Pay',
  VAULT_KEY_V1: HEX32,
  VAULT_KEY_ACTIVE_VERSION: '1',
  VAULT_FINGERPRINT_KEY: HEX32_B,
  VERA_ROOT_ARQC_SEED: HEX32_C,
  PAYMENT_PROVIDER: 'mock',
  TRANSACTION_TTL_SECONDS: '300',
  RETRIEVAL_TOKEN_TTL_SECONDS: '60',
};

for (const [k, v] of Object.entries(defaults)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
