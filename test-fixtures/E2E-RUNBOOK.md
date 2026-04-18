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

## Step 7 — provisioning (mobile app session)

Out of scope for this session — switch to the mobile app session and continue from `app.karta.cards/provision#hand=<token>`.

Expected: data-prep stage will likely fail because the dummy issuer-key ARNs don't exist in AWS Payment Cryptography.  That's intentional for tonight's setup.  Fix by either:
- importing real test keys into AWS PC and updating IssuerProfile.imkAcKeyArn etc.
- OR adding a "mock mode" to `services/data-prep/src/services/emv-derivation.ts` that returns deterministic fake outputs when an env flag is set.

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
