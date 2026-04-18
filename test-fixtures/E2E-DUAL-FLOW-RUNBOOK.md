# E2E dual-flow runbook — retail + FI product, same session

Two tests, same infrastructure:

1. **Retail flow** — SecureGift card (InComm / RETAIL program, microsite)
2. **FI product flow** — Karta Platinum card (Karta Bank / PREPAID_RELOADABLE, no microsite)

Both cards are **already seeded in prod**.  See
`e2e-cards-seeded.txt` for the exact values (cardRef, PAN, UID, SDM keys, pre-registered FIDO cred IDs).

---

## Pre-flight

```bash
# All green?
for h in tap activation pay manage; do
  printf "%-25s " "$h.karta.cards"
  curl -s -o /dev/null -w "%{http_code}\n" "https://${h}.karta.cards/api/health"
done
# Expect 4 × 200.
```

Two one-time prep steps before tapping:

### Step A — physically perso both cards

Both `e2e_retail_58e4` and `e2e_fi_2590` exist in the backend DB already.
The physical chips need the FIDO + T4T applets loaded and SDM keys written
so their emitted SUN URLs match what the backend expects.  Use the New T4T
perso tool (`external/new-t4t/perso/`) with the UID + SDM Meta/File keys
from `e2e-cards-seeded.txt`.

Cards ship with the NDEF URL already baked in:
`https://tap.karta.cards/activate/<cardRef>?e={PICCData}&m={CMAC}`

### Step B — upload the SecureGift microsite

Only needed for the **retail** flow.  Without an active microsite version,
tap service skips the info-only redirect and falls back to activation — the
retail gate would still work but you can't observe the microsite mode.

1. Open `https://manage.karta.cards` and log in.
2. Programs → `securegift` → Microsites tab.
3. Upload `microsites/securegift-v1.zip`.
4. Click **Activate** on the newly uploaded version.

That flips `Program.micrositeActiveVersion` on the row — tap service now
has the three conditions it needs (programType=RETAIL, retailSaleStatus ≠
SOLD, microsite active) to route to the info-only page.

---

## Test 1 — Retail flow (SecureGift)

### 1a. Shipped card → microsite info-only

Tap `e2e_retail_58e4` on an Android phone with NFC enabled.

**Expected:**
- Phone follows the card's SUN URL.
- tap service verifies SUN, increments the counter, sees program=RETAIL +
  retailSaleStatus=SHIPPED + microsite active.
- 302 → `https://microsite.karta.cards/programs/securegift/?card=e2e_retail_58e4&shipped=true`
- SecureGift microsite renders info-only mode (no activate CTA).

### 1b. Mark sold → re-tap → activation

From the admin UI → Cards tab → `e2e_retail_58e4` row → **Mark sold**.
Confirm the prompt.  Row shows `SOLD` with timestamp.

Or via curl:
```bash
ADMIN_ID_TOKEN=<your-cognito-id-token>
curl -X POST https://manage.karta.cards/api/cards/e2e_retail_58e4/mark-sold \
  -H "authorization: Bearer $ADMIN_ID_TOKEN"
```

Tap again.

**Expected:**
- tap service: program=RETAIL + retailSaleStatus=SOLD → falls through to
  normal activation (not microsite-info).
- 302 → `https://activation.karta.cards/activate#hand=<token>`
- activation frontend POSTs `/begin` → server sees a pre-registered FIDO
  credential → returns `{ mode: "confirm" }`.
- activation frontend POSTs `/finish` with `{ confirm: true }` → no
  WebAuthn prompt on the phone.
- Card flips to ACTIVATED.  micrositeUrl = microsite URL with `activated=true`.
- Frontend auto-redirects after 2s → microsite "activated" mode.

---

## Test 2 — FI product flow (Karta Platinum)

### 2. Tap the card

Tap `e2e_fi_2590`.

**Expected:**
- tap service verifies SUN, hands off to activation (not retail, no
  microsite configured).
- activation frontend POSTs `/begin` → `{ mode: "confirm" }` (pre-reg cred
  present).
- activation frontend POSTs `/finish` with `{ confirm: true }`.
- Card flips to ACTIVATED.  No microsite — lands on activation success page.

### 2b. (Optional) Force the WebAuthn ceremony path

If you want to exercise the full register-mode path on this card:
admin UI → Cards tab → expand `e2e_fi_2590` → delete the pre-registered
credential.  Re-tap.  `/begin` now returns `{ mode: "register", options }`
and the phone prompts for WebAuthn as usual.

---

## DB sanity checks during/after

```sql
-- Card states
SELECT "cardRef", status, "retailSaleStatus", "retailSoldAt"
FROM "Card"
WHERE "cardRef" IN ('e2e_retail_58e4', 'e2e_fi_2590');

-- Credentials per card
SELECT c."cardRef", w.id, w.preregistered, w.kind, w."lastUsedAt"
FROM "WebAuthnCredential" w JOIN "Card" c ON c.id = w."cardId"
WHERE c."cardRef" IN ('e2e_retail_58e4', 'e2e_fi_2590');

-- Activation session history
SELECT s.id, c."cardRef", s."consumedAt", s."consumedDeviceLabel"
FROM "ActivationSession" s JOIN "Card" c ON c.id = s."cardId"
WHERE c."cardRef" IN ('e2e_retail_58e4', 'e2e_fi_2590')
ORDER BY s."createdAt" DESC;
```

Run via a one-off ECS task (same pattern the smoke test uses):
see `/tmp/smoke.mjs`'s `sql()` helper.

---

## Expected matrix

| State on tap                            | Redirect to                                 | Card flips to | UI prompt |
|----------------------------------------|---------------------------------------------|---------------|-----------|
| RETAIL + SHIPPED + microsite-active     | microsite `?shipped=true`                   | no change     | info-only |
| RETAIL + SOLD (pre-reg cred)            | activation → confirm → microsite `?activated=true` | ACTIVATED | none      |
| RETAIL + SOLD (no pre-reg cred)         | activation → register → WebAuthn → microsite | ACTIVATED     | WebAuthn  |
| PREPAID_RELOADABLE (pre-reg cred)       | activation → confirm → success page         | ACTIVATED     | none      |
| PREPAID_RELOADABLE (no pre-reg cred)    | activation → register → WebAuthn → success  | ACTIVATED     | WebAuthn  |

---

## Troubleshooting

- **SUN verify fails** — chip SDM keys don't match DB.  Re-perso with the
  hex values from `e2e-cards-seeded.txt`.
- **Counter replay** — each tap must present a strictly higher SDM counter
  than the DB's `lastReadCounter`.  Tap the card a second time; counter
  auto-advances.
- **Microsite redirect missing** — verify `Program.micrositeActiveVersion`
  is not NULL.  Upload + activate the microsite zip first.
- **Confirm mode not firing** — check the Card row expansion in admin UI;
  should show a row labelled "Pre-registered".  If missing, the SQL-
  injected cred row was rolled back — re-run `/tmp/seed-test-cards.mjs`.
- **HMAC bad_signature on /api/cards/register** — check vault's
  SERVICE_AUTH_KEYS JSON against activation's SERVICE_AUTH_ACTIVATION_SECRET
  (they must match on the "activation" key).  Already aligned as of
  2026-04-18; smoke test `/tmp/smoke.mjs` Phase 5 will catch regression.
