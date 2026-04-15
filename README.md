# Vera — Palisade Payment Prototype

End-to-end CNP payment flow authenticated via WebAuthn + server-side OBO
ARQC + provider-agnostic vault, with a desktop → mobile QR hand-off. Built
against `https://pay.karta.cards` via Cloudflare Tunnel.

## Architecture at a glance

```
Browser (desktop)  ──▶  /           MerchantCheckout: cart, Pay with Palisade, QR
                                 │
                                 ▼  create /api/transactions  (cardId, amount)
Browser (mobile)   ──▶  /pay/{rlid}  CustomerPayment: summary, Confirm & Pay
                                 │
                                 ▼  /api/auth/authenticate/verify
Backend (Node + Express + Prisma)
    ├── webauthn/      @simplewebauthn — CTAP1 for NFC, platform for Face ID
    ├── orchestration/ post-auth.ts — the riskiest function: ARQC → token → tokenise → charge
    ├── arqc/          BIN-derived OBO cryptogram — no per-card secrets
    ├── vault/         tokenise, fingerprint dedup, 60s retrieval tokens, audit, proxy
    ├── providers/     PaymentProvider interface — Stripe + Mock in the box
    ├── transactions/  state machine, tier determination
    └── realtime/      SSE bus with 15s heartbeat + late-subscriber replay
```

Everything runs off a single Postgres database. See
`/Users/danderson/.claude/plans/tingly-imagining-sketch.md` for the full
design rationale.

## First run

```bash
# 1) Postgres
docker compose up -d

# 2) Dependencies (backend + frontend)
npm install
npm --prefix frontend install

# 3) Environment — copy and fill in secrets (all 32-byte hex; `openssl rand -hex 32` each)
cp .env.example .env
#   generate 3 keys and paste them in:
#     VAULT_KEY_V1
#     VAULT_FINGERPRINT_KEY
#     VERA_ROOT_ARQC_SEED

# 4) Prisma client + migrations
npx prisma generate
npx prisma migrate dev --name init

# 5) Start both processes
npm run dev
#     backend :3000, frontend :5173
```

`PAYMENT_PROVIDER=mock` is the default — the system runs end-to-end without
any Stripe keys. Flip to `stripe` + test keys when you want to hit the real
Stripe test mode.

## Cloudflare Tunnel (one-time)

WebAuthn needs a real HTTPS origin, not `localhost`. The RP ID is baked into
every registered credential — using `localhost` during development would
orphan those creds once you switched to the demo domain. So we run against
`pay.karta.cards` from day one.

Prereq: `karta.cards` must be on Cloudflare's nameservers (add the zone at
`dash.cloudflare.com` → Add a site; change NS at your registrar).

```bash
brew install cloudflared
cloudflared tunnel login               # pick the karta.cards zone
cloudflared tunnel create vera-pay     # prints the tunnel UUID
cloudflared tunnel route dns vera-pay pay.karta.cards
```

Then create `~/.cloudflared/config.yml`:

```yaml
tunnel: <uuid-from-create-step>
credentials-file: /Users/danderson/.cloudflared/<uuid>.json

ingress:
  - hostname: pay.karta.cards
    service: http://localhost:5173
  - service: http_status:404
```

Run: `cloudflared tunnel run vera-pay` (or `cloudflared service install` for
always-on). Vite proxies `/api/*` to `:3000` so everything ends up on one
origin.

## Manual smoke test

1. `docker compose up -d && npm run dev && cloudflared tunnel run vera-pay`
2. Phone → `https://pay.karta.cards/admin` → Cards → **Create blank card**
3. Vault tab → enter `4242424242424242` / 12 / 28 / 123 / "Test User" → vault succeeds
4. WebAuthn tab → pick the card → **Register passkey** (Platform) → Face ID
5. Desktop → `https://pay.karta.cards/` → cart total appears → select the card → **Pay with Palisade**
6. QR appears with countdown
7. Scan QR on phone → `/pay/{rlid}` → amount + merchant shown → **Confirm & Pay** → Face ID
8. Progress ticks through: authn ✓ → ARQC ✓ → vault ✓ → provider ✓ → charged ✓ → **Complete**
9. Desktop SSE fires → "Payment complete"
10. Admin → Transactions → new row with `status=COMPLETED`
11. Admin → Audit → one CREATE + one TOKEN_MINTED + one TOKEN_CONSUMED + one PROVIDER_TOKENISED

### Tier 2 smoke test (Android Chrome only)

1. Set the cart total over $50 so it falls into Tier 2.
2. In Admin → WebAuthn, register a credential of kind **NFC (CTAP1 — Android Chrome)** against the card.
3. On Android Chrome, open `/pay/{rlid}` and tap the Palisade card against the back of the phone.
4. The CTAP1 config in `src/webauthn/config.ts` is verbatim from New T4T — see the plan doc's "WebAuthn/NFC requirements" section before changing it.

### Stripe live-test mode

1. `.env`: `PAYMENT_PROVIDER=stripe` + `STRIPE_SECRET_KEY=sk_test_...`
2. Restart `npm run dev`.
3. Repeat smoke test — Stripe test-mode dashboard should show a succeeded PaymentIntent per transaction.

### Unit-level spot checks

Before the full flow, these are the cheap ones to validate in isolation:

- Luhn: `luhnValid('4242424242424242')` ✓, `luhnValid('4242424242424241')` ✗
- Vault round-trip: `storeCard` → `mintRetrievalToken` → `consumeRetrievalToken`, PAN matches
- Vault dedup: vaulting the same PAN twice with `onDuplicate=reuse` returns the same vaultEntryId
- Vault proxy: `forwardViaVault` with a destination of `httpbin.org/post` → outbound body has PAN substituted, token not reusable
- ARQC symmetry: `generateArqc(x) === generateArqc(x)`; mutate amount → `validateArqc` fails
- Retrieval-token race: two concurrent `consumeRetrievalToken` calls → exactly one succeeds
- Transaction expiry: create, push `expiresAt` into the past, `getTransactionForAuthOrThrow` rejects
- SSE: subscribe after an event has fired → receive the replay on connect

## Relationship to New T4T and Palisade

Two sibling projects live under `~/Documents/Claude Code/`:

- **`New T4T/`** — the activation flow. Owns SUN verification and the
  canonical FIDO2 credential store for each card. Vera **does not** call
  into New T4T's API for the prototype; it runs its own WebAuthn RP. But
  schemas align: `Card.cardIdentifier` holds the PICC UID hex, the same
  value New T4T stores as `uid`.
- **`Palisade/`** — the card issuance / personalisation platform. Separate
  stack, separate purpose. No code reuse.

To integrate later — so a card registered in New T4T can authenticate for a
payment in Vera — both services would need to run on the same WebAuthn
origin (so RP IDs match) and share the credential store. That's out of
scope for the prototype; the module boundaries here don't block it.

## New T4T-derived rules for WebAuthn/NFC

These are non-negotiable — every deviation in the New T4T history led to
silent NFC failures or `NotAllowedError` with no diagnostic. Do not
improvise; read `/Users/danderson/.claude/plans/tingly-imagining-sketch.md`
before touching `src/webauthn/config.ts`.

- **Android Chrome uses CTAP1 (U2F) over NFC, not CTAP2.**
- Register with `authenticatorAttachment: 'cross-platform'`,
  `residentKey: 'discouraged'`, `userVerification: 'discouraged'`,
  `pubKeyCredParams: [{ alg: -7 }]` (ES256 only).
- Authenticate with `transports: ['nfc']` on the allowCredentials entry —
  omitting this means Chrome will not even attempt NFC.
- Libraries pinned at `@simplewebauthn/{server,browser}@^10` — earlier
  versions have a base64url double-encoding bug on Android Chrome.
- RP ID is **always** read from `WEBAUTHN_RP_ID` env, never inferred from
  Host header.

## Useful paths

- Plan: `/Users/danderson/.claude/plans/tingly-imagining-sketch.md`
- Memory: `/Users/danderson/.claude/projects/-Users-danderson-Vera/memory/`
- Schema: `prisma/schema.prisma`
- Orchestration entry point: `src/orchestration/post-auth.ts`
- Tiering: `src/transactions/tier.ts`
- WebAuthn config: `src/webauthn/config.ts` (CTAP1-verbatim — handle with care)
