# Vera — payment service

Vera is the payment half of the Karta card stack: it tokenises PANs
(vault), generates OBO ARQCs for BIN-derived authentication, orchestrates
transactions through provider adapters (Stripe, mock), and runs the
desktop → mobile QR hand-off. It is entirely payment-side — card
issuance, personalisation, SUN-tap, activation, and chip authentication
live in the Palisade repo.

This repo is one half of a two-repo split:

- **Vera** (this repo) — vault + OBO ARQC + payment orchestration.
- **Palisade** (`/Users/danderson/Palisade`) — card issuance,
  personalisation, activation, SUN-tap, RCA.

Clients can subscribe to either or both. The only cross-repo runtime
dependency is Palisade → Vera: Palisade calls Vera's vault over
HMAC-signed HTTP at card-issue time to tokenise the PAN and get back an
opaque `vaultToken`. Palisade stores that token on its Card row; Vera
never learns about cards.

## Architecture at a glance

```
Payment flow
   Browser (desktop)  ──▶  /           MerchantCheckout: cart, Pay, QR
                                    │
                                    ▼  create /api/transactions  (vaultToken, amount)
   Browser (mobile)   ──▶  /pay/{rlid}  CustomerPayment: summary, Confirm & Pay
                                    │
                                    ▼  /api/auth/authenticate/verify
   3 backend services (Node + Express + Prisma, npm workspaces)
       services/
       ├── pay/           Transactions, auth, ARQC, orchestration, SSE, providers
       ├── vault/         Tokenise, fingerprint dedup, 60s retrieval tokens, audit, proxy
       └── admin/         Admin vault proxy + transactions view, X-Admin-Key gate
       packages/
       ├── core/          Encryption, ApiError, validation, key-provider interface
       ├── db/            Prisma schema (Vera-owned tables only) + shared client
       ├── webauthn/      @simplewebauthn — CTAP1 for NFC, platform for Face ID (checkout auth)
       ├── programs/      Tier-rule engine (tier rules authoritative at txn-create time)
       ├── service-auth/  HMAC-SHA256 request signing + verification middleware
       ├── vault-client/  Typed HMAC-signed HTTP client for the vault service
       ├── cognito-auth/  AWS Cognito middleware for admin routes
       ├── retention/     PCI-DSS TTL sweeps
       └── handoff/       QR + retrieval-link helpers
```

All service-to-service calls into the vault are HMAC-signed; the vault
records the verified caller identity in every audit row (PCI-DSS 10.2.1).
Palisade's calls arrive with `keyId=palisade` in the signature.

## First run

```bash
docker compose up -d
npm install
cp .env.example .env
#   generate keys and paste them in:
#     VAULT_KEY_V1, VAULT_FINGERPRINT_KEY, VERA_ROOT_ARQC_SEED
#     SERVICE_AUTH_PAY_SECRET, SERVICE_AUTH_ADMIN_SECRET
#     ADMIN_API_KEY
#     SERVICE_AUTH_KEYS JSON (match pay / admin / palisade entries)
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Default ports:

| Process | Port | Notes |
|---|---|---|
| pay (backend) | 3003 | Transactions, auth, orchestration, SSE |
| vault (backend) | 3004 | Tokenise, retrieval tokens, audit, proxy |
| admin (backend) | 3005 | Programs CRUD, admin vault proxy |
| pay (frontend) | 5175 | MerchantCheckout + CustomerPayment |
| admin (frontend) | 5176 | Admin dashboard |

`PAYMENT_PROVIDER=mock` is the default — the system runs end-to-end
without any Stripe keys. Flip to `stripe` + test keys when you want to
hit real Stripe test mode.

## Cloudflare Tunnel

WebAuthn needs a real HTTPS origin, not `localhost`. The RP ID is baked
into every registered credential — using `localhost` during development
would orphan those creds once you switched to the demo domain.

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create vera-pay
cloudflared tunnel route dns vera-pay pay.karta.cards
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <uuid-from-create-step>
credentials-file: /Users/danderson/.cloudflared/<uuid>.json

ingress:
  - hostname: pay.karta.cards
    service: http://localhost:5175
  - service: http_status:404
```

## Palisade integration surface

Palisade calls exactly one Vera endpoint at card-issue time:

| Moment | Endpoint | Palisade sends | Vera returns |
|---|---|---|---|
| Card personalised | `POST /api/vault/register` (HMAC-signed with `keyId=palisade`) | `{ pan, cvc?, expiryMonth, expiryYear, cardholderName, idempotencyKey }` | `{ vaultToken, panLast4 }` |

Idempotency is keyed on `idempotencyKey` (caller-supplied) so Palisade
can retry safely. Vera's existing fingerprint dedup still applies: two
calls with the same PAN return the same `vaultToken`.

At transaction-create time, Palisade does **not** participate. The
customer page reaches Vera with a `vaultToken` (obtained from Palisade
at card-issue time and stored on the card) and the rest of the flow is
Vera-only.

## Tier rules

Tier rules are authoritative at `POST /api/transactions` creation time
— the server computes `allowedCredentialKinds` from the card's program
(or `DEFAULT_TIER_RULES` if unlinked) and stores it on the Transaction.
Today that ruleset still lives in `@vera/programs`; a follow-up will
change this surface so Palisade pushes tier rules into Vera at txn-create
time rather than Vera owning the Program row.

## Tests

```bash
npm test    # vitest run — pure crypto + in-process pub/sub, no DB / no network
```

Coverage:
- **ARQC**: generate/validate symmetry; asymmetry under amount / ATC /
  cardId / BIN / currency / merchantRef / nonce mutations; malformed
  candidate handling
- **HKDF**: RFC 5869 §A.1 vector
- **Vault encryption**: AES-256-GCM round-trip, random-IV non-determinism,
  tag-tamper rejection, version-byte rejection
- **Vault fingerprint**: deterministic, normalises spaces/dashes, distinct
  for distinct PANs
- **Luhn**: canonical Stripe PAN ✓, single-digit corruption ✗
- **SSE bus**: late-subscriber replay, header set (incl. Cloudflare
  `X-Accel-Buffering: no`), per-RLID isolation, `forget()` drops history

## Useful paths

- Plan: `/Users/danderson/.claude/plans/tingly-imagining-sketch.md`
- Memory: `/Users/danderson/.claude/projects/-Users-danderson-Vera/memory/`
- Schema: `packages/db/prisma/schema.prisma`
- Orchestration entry point: `services/pay/src/orchestration/post-auth.ts`
- Tiering: `services/pay/src/transactions/tier.ts`
- WebAuthn config: `packages/webauthn/src/config.ts` (CTAP1-verbatim)
- Vault client: `packages/vault-client/src/index.ts`
- Service auth: `packages/service-auth/src/index.ts`
- Admin auth gate: `services/admin/src/middleware/require-admin-key.ts`
- Retention sweeps: `packages/retention/src/`
