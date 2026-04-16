# Palisade Provisioning Agent (PA) — JavaCard 3.0.5

Split-authority provisioning applet for JCOP 5 (NXP) and Secora Pay (Infineon) secure elements. The PA orchestrates on-card personalisation of prebuilt payment applets using **SCP11c script-based personalisation only**.

**This is a prototype/reference implementation.** Production will be outsourced with identical functional requirements. Cannot compile without NXP JCOP tools or Infineon Secora SDK.

## Architecture Overview

```
Phone App (RCA relay)          Secure Element
     |                              |
     |  SELECT PA                   |
     |----------------------------->| cleanup if interrupted
     |                              |
     |  GENERATE_KEYS               |
     |----------------------------->| ECC P-256 keygen
     |<-----------------------------| W(65) + attestation + CPLC
     |                              |
     |  TRANSFER_SAD                |
     |  (SAD + SSD_pubkey + tags)   |
     |----------------------------->| 1. Parse SAD
     |                              | 2. ECDH(ephemeral, SSD_pub)
     |                              | 3. KDF -> S-ENC, S-MAC, S-RMAC
     |                              | 4. Build STORE DATA per DGI
     |                              | 5. Build ICC privkey STORE DATA
     |                              | 6. Wrap each cmd with C-MAC + C-ENC
     |                              | 7. Zeroize session keys
     |<-----------------------------| opaque script blob
     |                              |
     |  [relay script to SSD]       |
     |  [SSD decrypts & executes]   |
     |                              |
     |  FINAL_STATUS                |
     |----------------------------->| provenance + FIDO + hashes
     |<-----------------------------| zeroize ICC priv key
     |                              |
     |  CONFIRM                     |
     |----------------------------->| state = COMMITTED
```

**Key insight:** The RCA never sees the ICC private key. It's wrapped in the SCP11c envelope — only the SSD can decrypt it. The RCA relays opaque ciphertext.

## SCP11c Script-Based Personalisation

Instead of interactive SCP03 sessions, the PA pre-computes the entire personalisation script:

1. **Generate ephemeral ECC P-256 key pair** — fresh for each session
2. **ECDH** with SSD's static public key (`KeyAgreement.ALG_EC_SVDP_DH_PLAIN`)
3. **Derive session keys** via NIST SP 800-108 KDF (AES-CMAC as PRF):
   - S-ENC: label `0x00..0x04` (12 bytes)
   - S-MAC: label `0x00..0x06` (12 bytes)
   - S-RMAC: label `0x00..0x07` (12 bytes)
4. **Build PSO command data** — ephemeral public key for SSD session initiation
5. **For each SAD DGI**: build STORE DATA APDU, apply C-MAC (AES-CMAC), apply C-DECRYPTION (AES-CBC)
6. **Build ICC private key STORE DATA** — wrapped in same SCP11c session (RCA cannot decrypt)
7. **Output**: ephemeral pubkey + wrapped command list as opaque blob

Reference: GlobalPlatform Card Specification Amendment F (SCP11c)

## State Machine

```
                 GENERATE_KEYS         TRANSFER_SAD           CONFIRM
  IDLE ───────────────> KEYGEN_COMPLETE ──────> PERSO_IN_PROGRESS ──────> COMMITTED
   ^                                                                         |
   |                                                                         |
   |  WIPE (requires SCP11)                                      WIPE (requires SCP11)
   |<────────────────────────────────────────────────────────────────────────-+
   |
   |  SELECT (if interrupted: state != IDLE && != COMMITTED)
   |<──── automatic cleanup: zeroize keys + GP DELETE + reset
```

- State persists in NVM — survives power loss
- Interrupted provisioning (power loss mid-flow) triggers automatic cleanup on next SELECT
- WIPE requires authenticated SCP11 session (prevents rogue wipe)
- COMMITTED is terminal until WIPE

## APDU Interface

| CLA  | INS  | Command            | Auth Required       | State Requirement              |
|------|------|--------------------|---------------------|-------------------------------|
| `00` | `A4` | SELECT             | None                | Any (cleanup if interrupted)   |
| `80` | `E0` | GENERATE_KEYS      | SCP11 session       | IDLE                          |
| `80` | `E2` | TRANSFER_SAD       | SCP11 session       | KEYGEN_COMPLETE               |
| `80` | `E4` | GET_ATTESTATION_CERT | None              | Any                           |
| `80` | `E6` | FINAL_STATUS       | After perso         | PERSO_IN_PROGRESS             |
| `80` | `E8` | CONFIRM            | After final status  | PERSO_IN_PROGRESS             |
| `80` | `EA` | WIPE               | SCP11 session       | Any                           |
| `80` | `EC` | GET_PROVENANCE     | None                | Any                           |
| `80` | `EE` | GET_STATE          | None                | Any                           |

### Error Status Words

| SW     | Meaning                    |
|--------|----------------------------|
| `9000` | Success                    |
| `6985` | Wrong state for command     |
| `6982` | Authentication required     |
| `6984` | Invalid data                |
| `6700` | Wrong length                |
| `6D00` | INS not supported           |
| `6F00` | Internal error              |

## Happy Path APDU Trace

```
>> 00 A4 04 00 [AID]                          # SELECT PA
<< 9000

>> 80 E0 00 00 00                              # GENERATE_KEYS
<< [W:65] [attestation_sig:~72] [CPLC:42] 9000

>> 80 E2 00 00 [Lc] [SAD||SSD_pub||tags]      # TRANSFER_SAD
<< [script_blob:var] 9000                      # opaque SCP11c-wrapped script

   # RCA relays script blob to SSD via phone
   # SSD decrypts and executes STORE DATA commands

>> 80 E6 00 00 00                              # FINAL_STATUS
<< [status:1] [prov_hash:32] [icc_pub_hash:32]
   [fido_cred_id_len:1] [fido_cred_id:32]
   [fido_pub_len:1] [fido_pub:65] 9000

>> 80 E8 00 00 00                              # CONFIRM
<< 9000                                        # COMMITTED
```

## Memory Audit

### NVM (Non-Volatile Memory) — Persistent

| Buffer              | Size    | Allocated In          | Used By                      | Zeroized When                |
|---------------------|---------|-----------------------|------------------------------|------------------------------|
| `iccPrivKey`        | 32 B    | `BufferManager()`     | `GENERATE_KEYS`, script build | `FINAL_STATUS` (after build)  |
| `iccPubKey`         | 65 B    | `BufferManager()`     | `GENERATE_KEYS`, attestation  | `WIPE` / cleanup             |
| `fidoPrivKey`       | 32 B    | `BufferManager()`     | `FIDO` credential gen         | `WIPE` only                  |
| `fidoCredId`        | 32 B    | `BufferManager()`     | `FIDO` credential gen         | `WIPE` only                  |
| `fidoPubKey`        | 65 B    | `BufferManager()`     | `FIDO` credential gen         | `WIPE` only                  |
| `provenanceLog`     | 200 B   | `BufferManager()`     | `ProvenanceLog`               | Never (audit trail)          |
| `state`             | 1 B     | `BufferManager()`     | State machine                 | Reset to IDLE on cleanup     |
| `position` (prov)   | 1 B     | `ProvenanceLog()`     | Circular index                | Never                        |
| `counter` (prov)    | 4 B     | `ProvenanceLog()`     | Monotonic counter             | Never                        |
| **Total NVM**       | **~432 B** |                    |                              |                              |

### RAM (Transient) — CLEAR_ON_DESELECT

| Buffer              | Size     | Used By                       |
|---------------------|----------|-------------------------------|
| `ssdPubKey`         | 65 B     | SSD static pubkey for ECDH     |
| `sadBuffer`         | 600 B    | SAD receive + parse            |
| `scriptBuffer`      | 1024 B   | SCP11c script assembly         |
| `workBuffer`        | 256 B    | Crypto intermediates           |
| `sessionKeyEnc`     | 16 B     | SCP11c S-ENC                   |
| `sessionKeyMac`     | 16 B     | SCP11c S-MAC                   |
| `sessionKeyRmac`    | 16 B     | SCP11c S-RMAC                  |
| `macChaining`       | 16 B     | C-MAC chaining value           |
| `sadLength`         | 2 B      | SAD accumulation tracker       |
| **Total RAM**       | **~2011 B** |                             |

### Crypto Objects (allocated once)

| Object                 | Allocated In              |
|------------------------|---------------------------|
| `KeyPair` (ICC)        | `ProvisioningAgent()`     |
| `KeyPair` (ephemeral)  | `SCP11cScriptBuilder()`   |
| `KeyPair` (FIDO)       | `FidoCredentialManager()` |
| `KeyAgreement` (ECDH)  | `SCP11cScriptBuilder()`   |
| `Signature` (CMAC)     | `SCP11cScriptBuilder()`   |
| `Cipher` (AES-CBC)     | `SCP11cScriptBuilder()`   |
| `Cipher` (AES-ECB)     | `SCP11cScriptBuilder()`   |
| `Signature` (ECDSA)    | `NxpAttestation()` / `InfineonAttestation()` |
| `Signature` (ECDSA)    | `FidoCredentialManager()` |
| `MessageDigest` (SHA)  | `ProvenanceLog()`, `ProvisioningAgent()` |
| `RandomData`           | `FidoCredentialManager()` |
| `AESKey` (temp)        | `SCP11cScriptBuilder()`   |

**Zero allocation guarantee:** All `new` calls occur in `install()`. No object creation in `process()`.

## Security Invariant Checklist

| # | Invariant | Enforced In | How |
|---|-----------|-------------|-----|
| 1 | ICC private key never in APDU response | `ProvisioningAgent.processGenerateKeys()` | Only W (public key) returned |
| 2 | ICC private key wrapped in SCP11c | `SCP11cScriptBuilder.buildScript()` | `wrapCommand()` applies C-MAC + C-ENC |
| 3 | RCA sees only ciphertext | `ProvisioningAgent.processTransferSad()` | Returns opaque `scriptBuf` blob |
| 4 | WIPE requires SCP11 | `ProvisioningAgent.processWipe()` | GP runtime enforces SCP11 |
| 5 | Interrupted cleanup | `ProvisioningAgent.select()` | `performCleanup()` if state interrupted |
| 6 | Session keys zeroized after script | `SCP11cScriptBuilder.buildScript()` | `bufMgr.zeroizeSessionKeys()` at end |
| 7 | SSD pubkey zeroized after ECDH | `SCP11cScriptBuilder.buildScript()` | `bufMgr.zeroizeSsdPubKey()` at end |
| 8 | ICC privkey zeroized after FINAL_STATUS | `ProvisioningAgent.processFinalStatus()` | `bufMgr.zeroizeIccPrivKey()` |
| 9 | No allocation in process() | All classes | Every `new` is in constructor/install |
| 10 | Provenance is immutable | `ProvenanceLog` | Append-only circular log, monotonic counter |

## Vendor Portability

All code uses standard JavaCard 3.0.5 / GlobalPlatform APIs **except** the `AttestationProvider` interface:

```
AttestationProvider (interface)
├── NxpAttestation      — JCOP 5 attestation API
└── InfineonAttestation — Secora Pay attestation API
```

Vendor selection via install parameter byte:
- `0x01` = NXP (default)
- `0x02` = Infineon

## Compilation

Requires (not included):
- NXP JCOP 5 SDK (Eclipse plugin) or Infineon Secora toolchain
- JavaCard 3.0.5 SDK
- GlobalPlatform 2.3 export files

```bash
# Example with JCOP tools (paths vary by installation):
javac -target 1.6 -source 1.6 \
  -cp jcdk/lib/api_classic.jar:gp/export \
  src/com/palisade/pa/*.java

# Generate .cap with converter tool
java -jar jcdk/bin/converter.jar \
  -classdir build \
  -exportpath gp/export \
  -applet 0xA0:0x00:0x00:0x00:0x62:0x50:0x41:0x4C com.palisade.pa.ProvisioningAgent \
  com.palisade.pa 0xA0:0x00:0x00:0x00:0x62:0x50:0x41 1.0
```

## File Structure

```
palisade-pa/
├── src/com/palisade/pa/
│   ├── ProvisioningAgent.java      — Main applet, state machine, APDU dispatch
│   ├── Constants.java              — CLA/INS/state/SW/buffer constants
│   ├── BufferManager.java          — NVM + transient buffer allocation, zeroization
│   ├── TLVUtil.java                — Minimal on-card BER-TLV parser
│   ├── AttestationProvider.java    — Vendor-portable attestation interface
│   ├── NxpAttestation.java         — NXP JCOP 5 implementation
│   ├── InfineonAttestation.java    — Infineon Secora Pay implementation
│   ├── SCP11cScriptBuilder.java    — ECDH + KDF + script assembly (core)
│   ├── StoreDataBuilder.java       — STORE DATA APDU construction
│   ├── FidoCredentialManager.java  — FIDO2 credential generation + COSE_Key
│   └── ProvenanceLog.java          — Circular persistent audit log
└── README.md                       — This file
```
