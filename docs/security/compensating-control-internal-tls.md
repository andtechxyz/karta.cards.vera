# Compensating Control: Internal Service Communication

**PCI DSS Requirement:** 4.1.1 — Strong cryptography for CHD transmission
**Control Replaced:** TLS on internal ALB listeners
**Document Owner:** Security Team
**Last Reviewed:** 2026-04-16

---

## 1. Original Requirement

PCI DSS 4.1.1 requires strong cryptography to protect cardholder data during transmission over open, public networks. Section 4.2.1 extends this to all networks where CHD is transmitted.

The internal ALB (`vera-internal`) carries HMAC-authenticated HTTP traffic between services, including vault responses containing decrypted cardholder data (PAN, CVC) within the retrieval token consumption flow.

## 2. Why the Original Control Is Not Applied

AWS Application Load Balancers require ACM certificates for HTTPS listeners. Internal ALBs with private DNS names cannot use public ACM certificates. AWS Certificate Manager Private CA (ACM PCA) would be required at a cost of $400/month, which is disproportionate to the risk profile given the existing compensating controls.

## 3. Compensating Controls in Place

### 3.1 Network Isolation (exceeds TLS network protection)

- Internal ALB (`vera-internal`) is deployed in **private subnets** with no internet gateway route
- Security group `vera-vault-cde` (`sg-060cc505a1052faa3`) restricts inbound traffic to **only** the ECS service security group on specific ports (3004, 3006, 3007)
- No public IP assigned to any ECS task (`assignPublicIp=DISABLED`)
- VPC has no NAT gateway route to the internal ALB subnets
- Traffic between services NEVER traverses the public internet

### 3.2 Message-Level Integrity (exceeds TLS integrity protection)

Every internal request is HMAC-SHA256 signed via the `@vera/service-auth` package:

- **Canonical string:** `METHOD\nPATH_AND_QUERY\nTIMESTAMP\nBODY_SHA256_HEX`
- **Header:** `Authorization: VeraHmac keyId=<id>,ts=<unix>,sig=<hex>`
- **Key strength:** 256-bit (32-byte hex) per caller identity
- **Replay window:** 60 seconds (clock-skew tolerance)
- **Body binding:** SHA-256 of the complete request body is included in the signed canonical string — any modification of the body (including CHD) invalidates the signature
- **Timing-safe comparison:** Signature verification uses `crypto.timingSafeEqual` to prevent timing attacks

This provides **stronger integrity guarantees than TLS alone**, because:
- TLS authenticates the server but not the client (without mTLS)
- HMAC authenticates the specific caller identity (keyId)
- TLS protects the transport channel; HMAC protects the message itself
- A compromised TLS termination point could MITM traffic; HMAC signatures are end-to-end

### 3.3 Data Minimisation

- Full PAN is transmitted internally only during retrieval token consumption (vault → pay service)
- This occurs in a single HTTP request/response, in memory only
- The PAN is never written to disk, logs, or intermediate storage during transit
- Retrieval tokens are single-use and expire in 60 seconds

### 3.4 Audit Trail

Every vault operation that transmits CHD generates a `VaultAccessLog` entry with:
- Event type, actor (cryptographically attested keyId), purpose
- Timestamp, IP address, user agent
- Retrieval token ID, transaction ID
- Success/failure result

### 3.5 Access Control

Only three keyIds can consume retrieval tokens: `pay`, `activation`, `admin`. Each has an independent 256-bit HMAC secret. Compromise of one does not affect others.

## 4. Risk Assessment

| Threat | TLS Mitigation | Compensating Control Mitigation |
|--------|---------------|-------------------------------|
| Network eavesdropping | Encryption in transit | Private subnet, no internet route, SG isolation |
| Man-in-the-middle | Server certificate validation | HMAC body binding (end-to-end integrity) |
| Replay attacks | TLS session binding | 60-second timestamp window + body hash |
| Unauthorized caller | None (without mTLS) | Per-caller HMAC keyId with 256-bit secret |
| Data modification | TLS integrity | SHA-256 body hash in HMAC signature |

## 5. Validation

This compensating control is validated by:
1. Security group rules audited quarterly (AWS Config)
2. HMAC signature verification tested in unit tests (23 tests in `service-auth/src/index.test.ts`)
3. VaultAccessLog reviewed for anomalous access patterns (admin UI Audit tab)
4. Smoke tests verify all unauthenticated requests are rejected (CI/CD smoke test suite)

## 6. Review Schedule

This compensating control will be reviewed:
- Annually, or
- When the network architecture changes, or
- When new services are added to the CDE boundary, or
- When ACM PCA pricing changes to make internal TLS cost-effective
