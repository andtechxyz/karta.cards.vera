# Incident Response Plan

**Document Owner:** Security Team
**Last Reviewed:** 2026-04-16
**PCI DSS Reference:** Requirement 12.10

---

## 1. Scope

This plan covers security incidents affecting the karta.cards platform, including all 7 microservices (tap, activation, pay, vault, data-prep, rca, admin), the PostgreSQL database, AWS infrastructure, and all cardholder data environments (CDE).

## 2. Incident Classification

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|----------|
| **P1 Critical** | Active data breach, CDE compromise, or key compromise | 15 minutes | Vault decryption key exposed, PAN data leaked, unauthorized vault access |
| **P2 High** | Potential breach, service compromise, or auth bypass | 1 hour | HMAC key compromised, admin key leaked, SUN replay attack detected |
| **P3 Medium** | Suspicious activity, failed attack, or policy violation | 4 hours | Rate limit triggered repeatedly, brute-force on auth endpoints |
| **P4 Low** | Minor security event, no data exposure | 24 hours | Dependency vulnerability disclosed, TLS certificate expiring |

## 3. Incident Response Team

| Role | Responsibility |
|------|---------------|
| **Incident Commander** | Coordinates response, makes escalation decisions |
| **Security Lead** | Technical investigation, forensics, evidence preservation |
| **Infrastructure Lead** | Service isolation, key rotation, infrastructure changes |
| **Communications Lead** | Stakeholder notification, regulatory reporting |

## 4. Response Procedures

### 4.1 Detection & Triage (0-15 minutes)

1. Alert received via CloudWatch alarm, audit log anomaly, or manual report
2. Incident Commander assesses severity using classification table
3. Create incident record with: time, reporter, initial assessment, severity
4. If P1/P2: immediately proceed to Containment

### 4.2 Containment (15-60 minutes)

**Key Compromise (VAULT_PAN_DEK, SERVICE_AUTH_KEYS, ADMIN_API_KEY):**
1. Rotate the compromised key in AWS Secrets Manager immediately
2. Force new ECS deployments for all affected services: `aws ecs update-service --force-new-deployment`
3. If vault DEK: initiate re-encryption of all VaultEntry rows under new key version
4. Review VaultAccessLog for unauthorized TOKEN_CONSUMED or PROXY_FORWARDED events

**Unauthorized Vault Access:**
1. Identify the caller keyId from VaultAccessLog.actor
2. Rotate that service's HMAC secret
3. Block the compromised keyId by removing it from SERVICE_AUTH_KEYS
4. Force redeploy vault service

**Admin Account Compromise:**
1. Rotate ADMIN_API_KEY in Secrets Manager
2. Revoke the Cognito user's sessions: `aws cognito-idp admin-user-global-sign-out`
3. Force redeploy admin service
4. Review admin actions in audit log for the compromised period

**Service Compromise (container escape, code injection):**
1. Scale the compromised service to 0: `aws ecs update-service --desired-count 0`
2. Preserve CloudWatch logs (extend retention, export to S3)
3. Capture the task definition and container image hash for forensics
4. Deploy a known-good image after investigation

### 4.3 Eradication (1-24 hours)

1. Identify root cause from CloudWatch logs, VaultAccessLog, and ECS events
2. Patch the vulnerability or close the attack vector
3. Verify fix in non-production environment
4. Deploy fix to production

### 4.4 Recovery (24-72 hours)

1. Restore services to normal operation
2. Monitor for recurrence (increased CloudWatch alarm sensitivity)
3. Validate all auth gates and encryption are functioning (re-run smoke tests)
4. Confirm no residual unauthorized access

### 4.5 Post-Incident (within 7 days)

1. Complete incident report with: timeline, root cause, impact, remediation
2. Update security controls if gaps identified
3. Conduct lessons-learned review with IR team
4. Update this plan if procedures proved insufficient

## 5. Key Rotation Procedures

| Key | Location | Rotation Method |
|-----|----------|----------------|
| VAULT_PAN_DEK | Secrets Manager `vera/VAULT_PAN_DEK_V1` | Add V2 key, update ACTIVE_VERSION, re-encrypt VaultEntry rows |
| CARD_FIELD_DEK | Secrets Manager `vera/CARD_FIELD_DEK_V1` | Add V2 key, update ACTIVE_VERSION, re-encrypt Card UID/SDM fields |
| SERVICE_AUTH_KEYS | Secrets Manager `vera/SERVICE_AUTH_KEYS` | Add new keyId/secret pair, update callers, remove old keyId |
| ADMIN_API_KEY | Secrets Manager `vera/ADMIN_API_KEY` | Generate new 32-byte hex, update Secrets Manager, redeploy admin |
| TAP_HANDOFF_SECRET | Secrets Manager `vera/TAP_HANDOFF_SECRET` | Rotate — existing tokens expire in 30 seconds |
| KMS_SAD_KEY_ARN | AWS KMS | KMS automatic annual rotation (configured on key) |

## 6. Notification Requirements

| Event | Notify | Timeline |
|-------|--------|----------|
| Confirmed PAN breach | Card schemes (Visa/MC), acquiring bank, affected cardholders | 72 hours (GDPR), scheme-specific deadlines |
| Key compromise (no data breach confirmed) | Internal security team, infrastructure team | Immediate |
| Service outage (no security impact) | Operations team | 15 minutes |

## 7. Evidence Preservation

- CloudWatch logs retained 90 days (immediately available), archived to S3 for 12 months
- VaultAccessLog entries never purged (PCI DSS 10.7)
- ECS task definitions and container image hashes recorded for all deployments
- Secrets Manager has automatic version history
