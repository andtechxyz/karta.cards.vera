# Vera — Palisade Payment Prototype

End-to-end CNP payment flow authenticated via WebAuthn + server-side OBO
ARQC + provider-agnostic vault, with a desktop → mobile QR hand-off. Built
against `https://pay.karta.cards` via Cloudflare Tunnel.

## Architecture at a glance

```
Card lifecycle
   Palisade data-prep ──▶ provisioning-agent ──▶ POST /api/cards/register
                                                  (vaults PAN + creates Card in one txn)
   Cardholder taps    ──▶ NDEF URL fires       ──▶ GET /activate/:cardRef?e=...&m=...
                                                  (SUN verify → mint 60s ActivationSession
                                                   → 302 /activate?session=<opaque-token>)
   Second tap on phone ─▶ /api/activation/sessions/:token/{begin,finish}
                                                  (atomic credential + ACTIVATED + consume)

Payment flow
   Browser (desktop)  ──▶  /           MerchantCheckout: cart, Pay with Palisade, QR
                                    │
                                    ▼  create /api/transactions  (cardId, amount)
   Browser (mobile)   ──▶  /pay/{rlid}  CustomerPayment: summary, Confirm & Pay
                                    │
                                    ▼  /api/auth/authenticate/verify
   Backend (Node + Express + Prisma)
       ├── sun/           NXP AN14683 PICC decrypt + CMAC verify + monotonic counter
       ├── cards/         POST /api/cards/register entry point for provisioning-agent
       ├── activation/    SUN session loader + WebAuthn begin/finish (CROSS_PLATFORM only)
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

Admin is read-only for cards. Card creation goes through the provisioning-
agent path; activation is entirely cardholder-driven via SUN-tap. There is
no "create blank card" or "register passkey" button anymore.

```bash
# 1. Bring everything up
docker compose up -d && npm run dev & cloudflared tunnel run vera-pay

# 2. Register a card via the provisioning-agent endpoint
#    (in production this is called by Palisade's perso pipeline; for
#    development we curl it directly with a representative payload)
curl -X POST https://pay.karta.cards/api/cards/register \
  -H 'Content-Type: application/json' \
  -d '{
    "cardRef": "test-001",
    "uid": "04A3B2C1D2E380",
    "sdmMetaReadKey": "00112233445566778899aabbccddeeff",
    "sdmFileReadKey": "ffeeddccbbaa99887766554433221100",
    "card": {
      "pan": "4242424242424242",
      "expiryMonth": "12",
      "expiryYear": "28",
      "cvc": "123",
      "cardholderName": "Test User"
    }
  }'
```

3. Cardholder taps the physical card → NDEF URL hits `/activate/:cardRef?e=...&m=...` → server verifies SUN → 302 to `/activate?session=<token>`
4. Frontend auto-fires WebAuthn registration on Android Chrome → cardholder taps card again → CROSS_PLATFORM credential stored, card flips to `ACTIVATED`
5. Desktop → `https://pay.karta.cards/` → cart total appears → select the activated card → **Pay with Palisade**
6. QR appears with countdown
7. Scan QR on phone → `/pay/{rlid}` → amount + merchant shown → **Confirm & Pay** → Face ID (Tier 1/3) or NFC tap (Tier 2)
8. Progress ticks through: authn ✓ → ARQC ✓ → vault ✓ → provider ✓ → charged ✓ → **Complete**
9. Desktop SSE fires → "Payment complete"
10. Admin → Transactions → new row with `status=COMPLETED`
11. Admin → Audit → one CREATE + one TOKEN_MINTED + one TOKEN_CONSUMED + one PROVIDER_TOKENISED

### Tier 2 smoke test (Android Chrome only)

1. The demo cart totals AUD 87, which sits under Vera's default AUD 100 threshold (biometric only). To trigger the NFC-tap branch either:
   - bump the cart in `frontend/src/pages/MerchantCheckout.tsx` above AUD 100, or
   - via Admin → Programs, link the card to a program with a lower `CROSS_PLATFORM` threshold.
2. The SUN-tap activation already registered a CROSS_PLATFORM credential — no extra registration step needed.
3. On Android Chrome, open `/pay/{rlid}` and tap the Palisade card against the back of the phone.
4. The CTAP1 config in `src/webauthn/config.ts` is verbatim from New T4T — see the plan doc's "WebAuthn/NFC requirements" section before changing it.

### Stripe live-test mode

1. `.env`: `PAYMENT_PROVIDER=stripe` + `STRIPE_SECRET_KEY=sk_test_...`
2. Restart `npm run dev`.
3. Repeat smoke test — Stripe test-mode dashboard should show a succeeded PaymentIntent per transaction.

### Unit tests

```bash
npm test            # vitest run — 60+ unit tests, ~200ms
```

Coverage today (no DB / no network — pure crypto + in-process pub/sub):

- **SUN**: AES-CMAC against NIST SP 800-38B vectors, PICC decrypt against a
  known card vector, end-to-end URL verifier with synthesized PICC + MAC
  (mutation tests for tampered MAC, wrong key, missing `&m=`)
- **ARQC**: generate/validate symmetry; asymmetry under amount / ATC /
  cardId / BIN / currency / merchantRef / nonce mutations; malformed
  candidate handling
- **HKDF**: RFC 5869 §A.1 vector
- **Vault encryption**: AES-256-GCM round-trip, random-IV non-determinism,
  tag-tamper rejection, version-byte rejection
- **Vault fingerprint**: deterministic, normalises spaces/dashes, distinct
  for distinct PANs
- **Luhn**: canonical Stripe PAN ✓, single-digit corruption ✗
- **Template substitution**: known placeholders, fail-closed on unknown,
  no whitespace tolerance
- **SSE bus**: late-subscriber replay, header set (incl. Cloudflare
  `X-Accel-Buffering: no`), per-RLID isolation, `forget()` drops history

Things that need a Postgres test database (not yet wired): vault dedup,
retrieval-token concurrent-consume race, transaction expiry, audit log
shape, activation session lifecycle.

## Relationship to New T4T and Palisade

Two sibling projects live under `~/Documents/Claude Code/` (mirrored into
`external/` here as read-only references):

- **`New T4T/`** — the original SUN-tap activation prototype (Python + Next.js).
  Vera's `src/sun/` is a 1:1 port of `palisade-sun`'s `sun_validator.py` and
  `key_manager.py`, validated against the same NIST CMAC vectors and
  real-card PICC test vector. Vera runs its own WebAuthn RP — it does not
  call into New T4T's API for the prototype.
- **`Palisade/`** — the card issuance / personalisation platform. Vera's
  `POST /api/cards/register` is the ingest endpoint Palisade's
  provisioning-agent calls after data-prep + perso. Schemas align on the
  PICC UID, but in Vera the UID lives only as ciphertext (`uidEncrypted`)
  + a deterministic HMAC fingerprint (`uidFingerprint`) — never plaintext
  on any HTTP boundary or in admin UI. The opaque public handle is
  `cardRef`.

To integrate later — so a card registered in New T4T can authenticate for a
payment in Vera — both services would need to run on the same WebAuthn
origin (so RP IDs match) and share the credential store. That's out of
scope for the prototype; the module boundaries here don't block it.

### Palisade integration endpoints

The Palisade provisioning-agent and NDEF-updater talk to Vera through a
narrow surface. Each endpoint maps to a single moment in the card lifecycle:

| Moment | Endpoint | What Palisade does |
|---|---|---|
| Program seeded (admin) | `POST /api/programs` | Defines a card product: `{ id, name, currency, tierRules, preActivationNdefUrlTemplate?, postActivationNdefUrlTemplate? }`. Templates are validated (must contain `{cardRef}`; may contain SDM markers `{PICCData}` / `{CMAC}` passed through verbatim). Null templates fall back to `WEBAUTHN_ORIGIN`-derived defaults. |
| Program edited | `PATCH /api/programs/:id` | Partial update. Same Zod validation as create; unchanged fields stay as-is. Rules re-validated for contiguity on every write. |
| Perso time — NDEF URL lookup | `GET /api/programs/cards/by-ref/:cardRef/ndef-urls` (or by cuid: `/api/programs/cards/:cardId/ndef-urls`) | Returns `{ preActivation, postActivation }` with `{cardRef}` already substituted and SDM markers preserved. Palisade's perso pipeline writes `preActivation` into the card's NDEF file. |
| Card registered | `POST /api/cards/register` | Ingest: vaults the PAN, creates the Card row, stores `uidEncrypted` + `uidFingerprint`. Idempotent on `(cardRef)`. |
| Cardholder taps (first time) | `GET /activate/:cardRef?e=<PICCData>&m=<CMAC>` (mounted at root, **not** `/api`) | Vera verifies SUN + mints a 60s ActivationSession → 302 → `/activate?session=<token>`. |
| Registration ceremony | `POST /api/activation/sessions/:token/{begin,finish}` | `finish` returns `{ cardActivated: true, credentialId, postActivationNdefUrl }`. The `postActivationNdefUrl` is the already-rendered post-activation template (from the card's program, or default). **Palisade's NDEF updater reads this response and writes the URL to the card via authenticated APDU** so subsequent taps route to the payment-initiation flow instead of activation. |

Tier rules are authoritative at `POST /api/transactions` creation time — the
server computes `allowedCredentialKinds` from the card's program (or
`DEFAULT_TIER_RULES` if the card is unlinked) and stores it on the
Transaction. The customer page reads that field and never has to know about
rule shape or program ID.

Currencies are ISO 4217 (3-letter); `POST /api/transactions` rejects a
transaction whose currency doesn't match the card's program currency, so a
USD cart against an AUD program fails loud instead of silently miscomputing
the tier.

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
- SUN verifier (do not improvise — mirrors palisade-sun): `src/sun/`
- Activation flow (begin/finish bound to opaque session token): `src/activation/`
- Provisioning ingest: `src/cards/register.service.ts` + `src/routes/cards.routes.ts`
- SUN-tap landing: `src/routes/sun-tap.routes.ts` (mounted at `/`, not `/api`)
- Orchestration entry point: `src/orchestration/post-auth.ts`
- Tiering: `src/transactions/tier.ts` (evaluates per-program `TierRuleSet`)
- Program CRUD + NDEF URL resolution: `src/programs/` + `src/routes/programs.routes.ts`
- Program defaults (AUD 100 bio/tap cutover): `DEFAULT_TIER_RULES` in `src/programs/tier-rules.ts`
- WebAuthn config: `src/webauthn/config.ts` (CTAP1-verbatim — handle with care)
