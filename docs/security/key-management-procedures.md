# Key Management Procedures

**Document Owner:** Security Team
**Last Reviewed:** 2026-04-16
**PCI DSS Reference:** Requirements 3.5, 3.6, 3.7

---

## 1. Key Inventory

| Key Name | Algorithm | Length | Purpose | Storage | Rotation |
|----------|-----------|--------|---------|---------|----------|
| VAULT_PAN_DEK | AES-256-GCM | 256-bit | Encrypt PANs + CVC at rest | Secrets Manager | Manual (versioned) |
| VAULT_PAN_FINGERPRINT_KEY | HMAC-SHA256 | 256-bit | Deterministic PAN dedup | Secrets Manager | Manual |
| CARD_FIELD_DEK | AES-256-GCM | 256-bit | Encrypt UIDs + SDM keys | Secrets Manager | Manual (versioned) |
| CARD_UID_FINGERPRINT_KEY | HMAC-SHA256 | 256-bit | Deterministic UID dedup | Secrets Manager | Manual |
| SERVICE_AUTH_KEYS | HMAC-SHA256 | 256-bit per keyId | Service-to-service auth | Secrets Manager | Manual (per keyId) |
| ADMIN_API_KEY | Constant-time compare | 256-bit | Admin UI authentication | Secrets Manager | Manual |
| TAP_HANDOFF_SECRET | HMAC-SHA256 | 256-bit | SUN tap handoff tokens (30s TTL) | Secrets Manager | Manual |
| CALLBACK_HMAC_SECRET | HMAC-SHA256 | 256-bit | RCA completion callback | Secrets Manager | Manual |
| KMS_SAD_KEY_ARN | AES-256 (KMS) | 256-bit | Encrypt SAD blobs | AWS KMS | Automatic (annual) |
| IMK-AC/SMI/SMC | TDES-2KEY | 128-bit | EMV issuer master keys | AWS Payment Cryptography HSM | Per scheme/program |
| TMK | TDES-2KEY | 128-bit | iCVV derivation | AWS Payment Cryptography HSM | Per scheme/program |
| Issuer PK | RSA-2048 | 2048-bit | Sign ICC PK certificates | AWS Payment Cryptography HSM | Per CA enrollment |

## 2. Key Generation

### Application Keys (DEK, HMAC, Auth)
```bash
# Generate a 256-bit key
openssl rand -hex 32
```
- Generated on a trusted workstation or via AWS CLI
- Never generated on a production server
- Immediately stored in Secrets Manager, never written to disk

### AWS KMS Keys
- Created via AWS Console or CDK with `enableKeyRotation: true`
- Key material generated within FIPS 140-2 Level 2 HSM
- Automatic annual rotation (KMS manages internally)

### AWS Payment Cryptography Keys (EMV)
- Created via AWS Payment Cryptography console or API
- Key material generated within FIPS 140-2 Level 3 HSM
- Never exportable in plaintext
- Imported via TR-31 key blocks when migrating from other HSMs

## 3. Key Rotation Procedures

### 3.1 VAULT_PAN_DEK Rotation

1. Generate new key: `openssl rand -hex 32`
2. Store as `vera/VAULT_PAN_DEK_V2` in Secrets Manager
3. Update `vera/VAULT_PAN_DEK_ACTIVE_VERSION` to `2`
4. Redeploy vault service (picks up new key on startup)
5. New vault entries encrypted under V2; existing entries readable under V1
6. Run re-encryption job: iterate VaultEntry rows where `keyVersion=1`, decrypt with V1, re-encrypt with V2
7. After all rows migrated: retire V1 (remove from env, keep in Secrets Manager for audit)

### 3.2 SERVICE_AUTH_KEYS Rotation (per keyId)

1. Generate new secret: `openssl rand -hex 32`
2. Add temporary second keyId (e.g. `pay_v2`) to SERVICE_AUTH_KEYS JSON in vault's Secrets Manager
3. Update the caller service's secret (e.g. `vera/SERVICE_AUTH_PAY_SECRET`) to the new value
4. Redeploy the caller service first, then the vault service
5. Verify HMAC auth works with new key
6. Remove old keyId from SERVICE_AUTH_KEYS, redeploy vault
7. Zero-downtime rotation: both keys accepted during transition

### 3.3 ADMIN_API_KEY Rotation

1. Generate new key: `openssl rand -hex 32`
2. Update `vera/ADMIN_API_KEY` in Secrets Manager
3. Redeploy admin service
4. Distribute new key to admin users (out of band)
5. Old key immediately invalid (no transition period — admin sessions are stateless)

## 4. Key Storage

- **All application keys** stored in AWS Secrets Manager with default encryption (AES-256)
- **EMV keys** stored in AWS Payment Cryptography HSM (FIPS 140-2 Level 3)
- **KMS keys** stored in AWS KMS (FIPS 140-2 Level 2)
- **No keys stored in source code, environment files, or Docker images**
- Keys injected at runtime via ECS task definition `secrets` block (Secrets Manager → env var)

## 5. Key Access Control

| Key | Accessible By | IAM Policy |
|-----|--------------|------------|
| VAULT_PAN_DEK | vault ECS task role only | `secretsmanager:GetSecretValue` on `vera/VAULT_PAN_DEK_*` |
| CARD_FIELD_DEK | activation + tap ECS task roles | `secretsmanager:GetSecretValue` on `vera/CARD_FIELD_DEK_*` |
| SERVICE_AUTH_KEYS | vault ECS task role only | `secretsmanager:GetSecretValue` on `vera/SERVICE_AUTH_KEYS` |
| KMS_SAD_KEY_ARN | data-prep ECS task role only | `kms:Encrypt`, `kms:Decrypt` on the specific key |
| EMV keys (IMK/TMK) | data-prep ECS task role only | `payment-cryptography:*`, `payment-cryptography-data:*` |

## 6. Dual Control & Split Knowledge

- **EMV issuer master keys** are generated within AWS Payment Cryptography HSM. No single person has access to the raw key material.
- **Application keys** are generated on a trusted workstation and stored directly in Secrets Manager. The person who generates the key can see it once; subsequent access requires IAM permissions.
- **Future enhancement:** Implement key ceremony with two custodians, each contributing half the key via XOR split.

## 7. Key Destruction

- **Secrets Manager:** Deleted secrets have a 7-30 day recovery window, then permanently destroyed
- **KMS:** Key deletion scheduled with 7-30 day waiting period, then permanently destroyed
- **Payment Cryptography:** Key deletion is immediate and irreversible
- **In-memory keys:** Zeroed on process exit (Node.js garbage collection handles Buffer cleanup)
