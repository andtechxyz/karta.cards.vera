# Data Classification Policy

**Document Owner:** Security Team
**Last Reviewed:** 2026-04-16
**PCI DSS Reference:** Requirements 3, 4, 7, 9

---

## 1. Classification Levels

| Level | Definition | Handling Requirements |
|-------|-----------|----------------------|
| **RESTRICTED** | Cardholder data, cryptographic keys, authentication secrets | Encrypted at rest + in transit, access logged, need-to-know only |
| **CONFIDENTIAL** | Internal system data, configuration, audit logs | Access controlled, not publicly accessible |
| **INTERNAL** | Operational data, non-sensitive metadata | Standard access controls |
| **PUBLIC** | Published APIs, documentation, open-source code | No restrictions |

## 2. Data Inventory

### RESTRICTED Data

| Data Element | PCI Category | Storage Location | Encryption | Access Control |
|---|---|---|---|---|
| PAN (Primary Account Number) | CHD | `VaultEntry.encryptedPan` (RDS) | AES-256-GCM (VAULT_PAN_DEK) | HMAC-gated vault service only |
| CVC/CVV | SAD | Inside `VaultEntry.encryptedPan` JSON | AES-256-GCM (VAULT_PAN_DEK) | Same as PAN |
| PICC UID (card identifier) | — | `Card.uidEncrypted` (RDS) | AES-256-GCM (CARD_FIELD_DEK) | Activation + tap services only |
| SDM keys (NFC crypto) | — | `Card.sdmMetaReadKeyEncrypted`, `sdmFileReadKeyEncrypted` | AES-256-GCM (CARD_FIELD_DEK) | Tap service only |
| SAD (Static Authority Data) | — | `SadRecord.sadEncrypted` (RDS) | AES-256-GCM or KMS envelope | Data-prep + RCA services only |
| VAULT_PAN_DEK | Key | AWS Secrets Manager `vera/VAULT_PAN_DEK_V1` | Secrets Manager encryption | ECS execution role only |
| CARD_FIELD_DEK | Key | AWS Secrets Manager `vera/CARD_FIELD_DEK_V1` | Secrets Manager encryption | ECS execution role only |
| SERVICE_AUTH_KEYS | Key | AWS Secrets Manager `vera/SERVICE_AUTH_KEYS` | Secrets Manager encryption | ECS execution role only |
| ADMIN_API_KEY | Key | AWS Secrets Manager `vera/ADMIN_API_KEY` | Secrets Manager encryption | Admin service only |
| AWS PC Issuer Master Keys | Key | AWS Payment Cryptography HSM | HSM-protected (FIPS 140-2 L3) | Data-prep service IAM role only |

### CONFIDENTIAL Data

| Data Element | Storage | Access |
|---|---|---|
| Cardholder name | `VaultEntry.cardholderName` (plaintext) | Vault service, admin proxy |
| PAN last 4 | `VaultEntry.panLast4` (plaintext) | All services (display only) |
| PAN BIN (first 6) | `VaultEntry.panBin` (plaintext) | All services (routing only) |
| Expiry month/year | `VaultEntry.panExpiryMonth/Year` (plaintext) | All services (display only) |
| PAN fingerprint | `VaultEntry.panFingerprint` (HMAC-SHA256) | Vault service (dedup only) |
| UID fingerprint | `Card.uidFingerprint` (HMAC-SHA256) | Activation service (dedup only) |
| Vault audit logs | `VaultAccessLog` (RDS) | Admin service (read-only) |
| Provisioning sessions | `ProvisioningSession` (RDS) | RCA + admin services |
| Issuer profiles (key ARNs) | `IssuerProfile` (RDS) | Data-prep + admin services |

### INTERNAL Data

| Data Element | Storage | Notes |
|---|---|---|
| Card status, cardRef | `Card` (RDS) | Opaque identifiers, no PII |
| Transaction rlid, status | `Transaction` (RDS) | Short-lived, random |
| WebAuthn credential IDs | `WebAuthnCredential` (RDS) | Public keys, non-secret |
| Program tier rules | `Program` (RDS) | Business configuration |
| Chip profile DGI defs | `ChipProfile` (RDS) | EMV specification data |

## 3. Data Flow Boundaries

```
Browser ──HTTPS──▶ Public ALB ──HTTP──▶ pay/admin/activation/tap
                                              │
                                         HMAC-signed HTTP
                                              │
                                              ▼
                                    Internal ALB ──▶ vault (PAN decrypt)
                                                 ──▶ data-prep (EMV keys)
                                                 ──▶ rca (provisioning relay)
```

**CDE Boundary:** vault, data-prep, and rca services. These are the only services that handle RESTRICTED data in plaintext (in memory, never at rest).

**Non-CDE services** (tap, activation, pay, admin) handle only CONFIDENTIAL or INTERNAL data. They never decrypt PANs or handle raw key material.

## 4. Data Retention

| Data | Retention | Justification |
|---|---|---|
| VaultEntry (encrypted PAN/CVC) | Indefinite (until card revoked) | Required for tokenised payments |
| VaultAccessLog | 12 months minimum | PCI DSS 10.7 |
| RetrievalToken | 60 seconds (purged by sweeper) | Single-use, short-lived |
| ActivationSession | 60 seconds (purged by sweeper) | Single-use, short-lived |
| RegistrationChallenge | 60 seconds (purged by sweeper) | Single-use, short-lived |
| Transaction | Indefinite | Business records, audit trail |
| SadRecord | 30 days (TTL) | Consumed during provisioning |
| ProvisioningSession | 90 days | Audit trail |
| CloudWatch logs | 90 days | PCI DSS 10.7 |

## 5. Data Destruction

When a card is revoked:
1. VaultEntry is NOT deleted (audit trail preserved) but no new retrieval tokens can be minted
2. Card status set to REVOKED — all auth/payment endpoints reject
3. SadRecord soft-deleted (status = REVOKED)
4. Encryption keys remain — data can be decrypted for legal/compliance requests only
