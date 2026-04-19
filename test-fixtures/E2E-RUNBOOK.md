# E2E test runbook — tap → activation → provisioning

Setup baseline (already done on 2026-04-18):

- ✅ Prod schema migration applied (`Program.programType`, `Card.retailSaleStatus`, `Card.retailSoldAt`, `Card_retailSaleStatus_idx`).
- ✅ All 9 ECS services updated to commit `eb41446`.
- ✅ batch-processor and SFTP services live in ECS (the SFTP NLB is at `vera-sftp-ff8d359bada7514a.elb.ap-southeast-2.amazonaws.com`; CNAME `sftp.karta.cards` not added yet).
- ✅ Cognito Lambdas on Node 22.

What's left to do **before tapping the first card**: seed test data via the admin UI.

---

## Step 1 — confirm CI deploy completed

```bash
gh run list --branch main --limit 1
# Expect: latest run "completed / success"

# Quick health check on every service:
for h in tap activation pay vault manage; do
  printf "%-16s " "$h.karta.cards"; \
  curl -s -o /dev/null -w "%{http_code}\n" "https://${h}.karta.cards/api/health";
done
```

Internal services (batch-processor, sftp, data-prep, rca) don't have public health endpoints — check ECS console for "RUNNING / 1 desired".

## Step 2 — seed Financial Institution + programs

Open `https://manage.karta.cards`.  Log in.

**Financial Institutions tab → New FI:**
- Name: `Test Issuer`
- Slug: `testissuer`
- Status: ACTIVE
- BIN, contact: leave blank

**Programs tab → New program** (do twice):

| Field            | Standard test card           | Retail test card              |
|------------------|------------------------------|-------------------------------|
| Program ID       | `prog_test_std`              | `prog_test_retail`            |
| Name             | `Test Standard Card`         | `Test Retail Card`            |
| Currency         | AUD                          | AUD                           |
| **Program type** | **Prepaid (Reloadable)**     | **Retail**                    |
| Tier rules       | (leave defaults)             | (leave defaults)              |
| FI               | Test Issuer                  | Test Issuer                   |
| NDEF templates   | leave blank for now          | leave blank for now           |
| Embossing tpl    | leave blank                  | leave blank                   |

## Step 3 — upload chip profile

**Chip Profiles tab → Upload JSON:** `test-fixtures/chip-profile-mchip-cvn18.json`.

After upload, edit the chip profile and scope it to `prog_test_std` (or leave global).

## Step 4 — register two test cards

The fixture cards in `test-fixtures/embossing-batch-test.csv`:

| cardRef       | UID            | PAN              | program (you assign)  |
|---------------|----------------|------------------|------------------------|
| e2e_test_001  | 04AABBCCDD1122 | 4242424242424242 | `prog_test_std`        |
| e2e_test_002  | 04EEFF1122334455 | 4242424242424259 | `prog_test_retail`     |

Register each one straight against activation (skips the batch queue):

```bash
cd ~/Vera

# Card 1 — standard, will land in PERSONALISED
ACTIVATION_URL=https://activation.karta.cards \
PROGRAM_ID=prog_test_std \
SERVICE_AUTH_BATCH_PROCESSOR_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET \
  --region ap-southeast-2 --query SecretString --output text) \
node test-fixtures/register-test-cards.mjs <(head -2 test-fixtures/embossing-batch-test.csv)

# Card 2 — retail, will land in PERSONALISED + retailSaleStatus=SHIPPED
ACTIVATION_URL=https://activation.karta.cards \
PROGRAM_ID=prog_test_retail \
SERVICE_AUTH_BATCH_PROCESSOR_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET \
  --region ap-southeast-2 --query SecretString --output text) \
node test-fixtures/register-test-cards.mjs <(head -1 test-fixtures/embossing-batch-test.csv && sed -n 3p test-fixtures/embossing-batch-test.csv)
```

Verify in admin UI → Cards tab:
- `e2e_test_001` row: status PERSONALISED, retail sale = `—`.
- `e2e_test_002` row: status PERSONALISED, retail sale = `SHIPPED` with a "Mark sold" button.

## Step 5 — write the SUN URLs onto the physical cards

The card chips (T4T+FIDO preinstalled) need their NDEF file pointed at:

```
https://tap.karta.cards/activate/<cardRef>?e={PICCData}&m={CMAC}
```

Use New T4T desktop tool (or palisade-pa equivalent) to write the URL with the matching SDM keys:

| card               | sdmMetaReadKey                   | sdmFileReadKey                   |
|--------------------|----------------------------------|----------------------------------|
| e2e_test_001       | `00112233445566778899AABBCCDDEEFF` | `FFEEDDCCBBAA99887766554433221100` |
| e2e_test_002       | `11223344556677889900AABBCCDDEEFF` | `EEDDCCBBAA9988776655443322110000` |

(Same hex strings used during registration above — must match exactly or SUN verification fails.)

## Step 6 — tap, observe redirects

### Card 1 (standard) — happy path

1. Tap `e2e_test_001` against an Android phone with NFC enabled.
2. Phone resolves the SUN URL → `tap.karta.cards/activate/e2e_test_001?e=…&m=…`.
3. tap service verifies SUN, advances counter, mints handoff token, 302s to `https://activation.karta.cards/activate#hand=<token>`.
4. Activation frontend renders WebAuthn registration prompt.
5. Complete passkey registration on the phone.
6. Card flips to status=ACTIVATED.  Microsite is not enabled on this program — the success page is the activation frontend's own.
7. Subsequent tap → `MOBILE_APP_URL/provision#hand=<token>` (mobile app session takes over).

### Card 2 (retail SHIPPED) — info-only

1. Tap `e2e_test_002`.
2. tap service detects program type RETAIL + status SHIPPED + microsite enabled.
3. **Microsite NOT yet enabled on `prog_test_retail`** — to test the retail flow, enable a microsite first.  Quickest:
   - Microsites tab → select `prog_test_retail` → upload `microsites/securegift-v1.zip` → Activate.
4. Re-tap.  Phone resolves to `https://microsite.karta.cards/programs/prog_test_retail/?card=e2e_test_002&shipped=true`.
5. The SecureGift microsite renders **info-only** mode — no activate button.

### Card 2 — flip to SOLD, then activate

1. In admin UI → Cards tab → row `e2e_test_002` → click "Mark sold".
2. Confirm; row should show `SOLD` with timestamp.
3. Tap card again.  This time tap service sees `retailSaleStatus=SOLD`, redirects to `activation.karta.cards/activate#hand=<token>`.
4. Complete WebAuthn registration → status flips to ACTIVATED.

## Step 6b — (optional) pre-register a FIDO credential to skip the WebAuthn ceremony

If your test phone is flaky on Android Chrome CTAP1-NFC, you can short-
circuit the runtime WebAuthn registration.  During perso, drive the
FIDO applet on the chip to make a credential, then POST it to admin:

```bash
# Replace with the actual values your perso tool reads off the FIDO applet
curl -X POST https://manage.karta.cards/api/cards/e2e_test_001/credentials \
  -H "authorization: Bearer $ID_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "credentialId": "<base64url credentialId from the applet>",
    "publicKey":    "<base64url COSE public key from the applet>",
    "transports":   ["nfc"],
    "deviceName":   "Pre-registered (perso)"
  }'
```

Or use the admin UI: Cards tab → expand the row (▸ button) →
"Pre-register FIDO credential" form.

After that:

- Tap the card.  tap service does SUN verify, hands off to activation.
- activation `/begin` returns `{ mode: "confirm" }` (no challenge).
- activation `/finish` is called with `{ confirm: true }` — no second NFC
  tap, no Chrome prompt.
- Card flips to ACTIVATED.

The pre-registered credential becomes the regular credential the card
uses for subsequent payment authentications, so the rest of the flow
(provisioning / payments) is unaffected.

## Step 7 — provisioning (mobile app session)

data-prep is running with `DATA_PREP_UDK_BACKEND=local` — EMV key derivation
runs real Method A in Node crypto, keyed by per-ARN dev IMKs HKDF'd from
`DEV_UDK_ROOT_SEED`.  No AWS Payment Cryptography calls.  That means:

- ✅ The full tap → activation → microsite → provisioning chain runs end-to-end.
- ✅ The mobile app sees a real SadRecord and can walk its provisioning state
  machine against the PA applet on the card.
- ✅ Derived MK-AC / MK-SMI / MK-SMC are cryptographically correct for the
  chosen dev IMK; the applet's own secure-messaging works.
- ❌ Real EMV payment transactions against an issuer system would fail —
  the dev IMK isn't the one the scheme has registered.

Create an IssuerProfile for `prog_test_std` so data-prep has a row to read.
Use `test-fixtures/issuer-keys-test.json` as the field reference (the ARN
values are used as HKDF info strings by the `local` backend — they just
need to be non-empty and stable across runs).

Fastest way: admin UI → Programs → `prog_test_std` → "Issuer profile"
section → fill the fields from the JSON fixture.  Link it to the chip
profile uploaded in Step 3.

Then switch to the mobile app session and continue from
`app.karta.cards/provision#hand=<token>`.

### Flipping to real Payment Cryptography

When you're ready for full EMV fidelity (real iCVVs that authorise against
a scheme):

1. Create 4 keys in AWS Payment Cryptography (`ap-southeast-2`):
   - TMK         (`TR31_K0_KEY_ENCRYPTION_KEY`     or `TR31_V1_PIN_VERIFICATION_KEY`)
   - IMK-AC      (`TR31_E0_EMV_MKEY_APP_CRYPTOGRAMS`)
   - IMK-SMI     (`TR31_E1_EMV_MKEY_DATA_INTEGRITY`)
   - IMK-SMC     (`TR31_E2_EMV_MKEY_DATA_ENCIPHERMENT`)
   ~US$1/day per key.
2. Paste the ARNs into the IssuerProfile row.
3. Flip the backend: `aws secretsmanager put-secret-value --secret-id
   vera/DATA_PREP_UDK_BACKEND --secret-string "hsm" --region ap-southeast-2`
   (The legacy `vera/DATA_PREP_MOCK_EMV=false` alias also selects `hsm`.)
4. Force redeploy data-prep.

## Troubleshooting

- **SUN verify fails (`sun_invalid`)**: SDM keys on the chip don't match what's in the DB.  Re-write with the exact hex from the table above.
- **Counter replay (`sun_counter_replay`)**: each tap monotonically increments the SDM counter on the card; tapping the same chip with an older counter is rejected.  Tap again and the counter advances on its own.
- **402 / 502 from activation**: ECS task crashed — check `/ecs/vera-activation` logs in CloudWatch.
- **Card not redirecting to microsite**: verify `Program.micrositeEnabled=true` AND `Program.micrositeActiveVersion` is non-null in the DB.

## Files

- `chip-profile-mchip-cvn18.json` — upload via Chip Profiles tab.
- `issuer-keys-test.json` — reference for IssuerProfile fields if you create one.
- `embossing-template-test.csv` — header-only template (upload via Embossing Templates tab if you want to try the partner/SFTP route).
- `embossing-batch-test.csv` — two test card rows.
- `register-test-cards.mjs` — direct registration helper used in step 4.
