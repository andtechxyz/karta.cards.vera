#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Register E2E test cards directly via activation/api/cards/register, signed
// with the batch-processor HMAC secret.
//
// Why not the partner API?  The partner path requires admin →
// /api/partners/embossing-batches → S3 → batch-processor → activation.
// Cleaner for E2E to skip the queue and call activation directly.
//
// Usage:
//   ACTIVATION_URL=https://activation.karta.cards \
//   PROGRAM_ID=prog_test_std \
//   SERVICE_AUTH_BATCH_PROCESSOR_SECRET=<hex> \
//     node test-fixtures/register-test-cards.mjs test-fixtures/embossing-batch-test.csv
//
// SERVICE_AUTH_BATCH_PROCESSOR_SECRET MUST match the value stored under
// vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET in Secrets Manager AND appear
// inside vera/PROVISION_AUTH_KEYS under keyId 'batch-processor'.
//
// Get the secret with:
//   aws secretsmanager get-secret-value \
//     --secret-id vera/SERVICE_AUTH_BATCH_PROCESSOR_SECRET \
//     --region ap-southeast-2 --query SecretString --output text
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { createHmac, createHash } from 'node:crypto';

const ACTIVATION_URL = process.env.ACTIVATION_URL || 'https://activation.karta.cards';
const PROGRAM_ID = process.env.PROGRAM_ID;
const SECRET = process.env.SERVICE_AUTH_BATCH_PROCESSOR_SECRET;
const KEY_ID = 'batch-processor';

if (!PROGRAM_ID) { console.error('PROGRAM_ID env required'); process.exit(2); }
if (!SECRET || !/^[0-9a-fA-F]{64}$/.test(SECRET)) {
  console.error('SERVICE_AUTH_BATCH_PROCESSOR_SECRET must be 32-byte hex'); process.exit(2);
}

const csvPath = process.argv[2];
if (!csvPath) { console.error('usage: register-test-cards.mjs <csv-file>'); process.exit(2); }

// --- Parse CSV ---
const text = readFileSync(csvPath, 'utf-8');
const [headerLine, ...dataLines] = text.split(/\r?\n/).filter((l) => l.trim());
const cols = headerLine.split(',').map((c) => c.trim().toLowerCase());

function rowToObject(row) {
  const vals = row.split(',');
  const o = {};
  cols.forEach((c, i) => (o[c] = vals[i]?.trim()));
  return o;
}

// --- HMAC sign — matches @vera/service-auth canonical exactly ---
function signRequest({ method, pathAndQuery, body }) {
  const ts = Math.floor(Date.now() / 1000);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const canonical = `${method.toUpperCase()}\n${pathAndQuery}\n${ts}\n${bodyHash}`;
  const sig = createHmac('sha256', Buffer.from(SECRET, 'hex'))
    .update(canonical).digest('hex');
  return `VeraHmac keyId=${KEY_ID},ts=${ts},sig=${sig}`;
}

// --- Register each card ---
const path = '/api/cards/register';
let ok = 0, fail = 0;

for (const line of dataLines) {
  const r = rowToObject(line);
  const body = JSON.stringify({
    cardRef: r.card_ref,
    uid: r.uid,
    chipSerial: r.chip_serial,
    sdmMetaReadKey: r.sdm_meta_read_key,
    sdmFileReadKey: r.sdm_file_read_key,
    programId: PROGRAM_ID,
    card: {
      pan: r.pan,
      cvc: r.cvc,
      expiryMonth: r.expiry_month,
      expiryYear: r.expiry_year,
      cardholderName: r.cardholder_name,
    },
  });
  const auth = signRequest({ method: 'POST', pathAndQuery: path, body: Buffer.from(body) });

  const resp = await fetch(`${ACTIVATION_URL}${path}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body,
  });
  const respText = await resp.text();
  if (resp.ok) {
    console.log(`OK   ${r.card_ref}  →  ${respText.slice(0, 200)}`);
    ok++;
  } else {
    console.log(`FAIL ${r.card_ref}  →  ${resp.status} ${respText.slice(0, 200)}`);
    fail++;
  }
}

console.log(`\nDone: ${ok} succeeded, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
