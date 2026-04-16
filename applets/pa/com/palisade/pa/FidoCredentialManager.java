/*
 * Project Palisade — FIDO2 Credential Manager
 *
 * Generates FIDO2/WebAuthn credentials on-card:
 * - ECC P-256 key pair for credential
 * - 32-byte random credential ID
 * - Authenticator data with COSE_Key (hand-encoded CBOR — no library on JavaCard)
 * - ECDSA attestation signature
 *
 * CBOR encoding follows RFC 8949 (minimal encoding).
 * COSE_Key format follows RFC 8152 Section 13.1.1.
 */
package com.palisade.pa;

import javacard.framework.Util;
import javacard.security.ECPrivateKey;
import javacard.security.ECPublicKey;
import javacard.security.KeyBuilder;
import javacard.security.KeyPair;
import javacard.security.MessageDigest;
import javacard.security.RandomData;
import javacard.security.Signature;

public final class FidoCredentialManager {

    /** FIDO2 key pair. */
    private final KeyPair fidoKeyPair;

    /** SHA-256 for rpIdHash. */
    private final MessageDigest sha256;

    /** ECDSA signer for attestation. */
    private final Signature ecdsa;

    /** Secure random for credential ID. */
    private final RandomData random;

    /** Reference to BufferManager. */
    private final BufferManager bufMgr;

    /** AAGUID for this authenticator type (16 bytes, configurable). */
    private static final byte[] AAGUID = {
        (byte)0x50, (byte)0x41, (byte)0x4C, (byte)0x49, // "PALI"
        (byte)0x53, (byte)0x41, (byte)0x44, (byte)0x45, // "SADE"
        (byte)0x2D, (byte)0x50, (byte)0x41, (byte)0x2D, // "-PA-"
        (byte)0x56, (byte)0x30, (byte)0x30, (byte)0x31  // "V001"
    };

    public FidoCredentialManager(BufferManager bufMgr) {
        this.bufMgr = bufMgr;

        fidoKeyPair = new KeyPair(KeyPair.ALG_EC_FP, KeyBuilder.LENGTH_EC_FP_256);
        initP256Params((ECPublicKey) fidoKeyPair.getPublic());
        initP256Params((ECPrivateKey) fidoKeyPair.getPrivate());

        sha256 = MessageDigest.getInstance(MessageDigest.ALG_SHA_256, false);
        ecdsa = Signature.getInstance(Signature.ALG_ECDSA_SHA_256, false);
        random = RandomData.getInstance(RandomData.ALG_TRNG);
    }

    /**
     * Generate a FIDO2 credential: key pair + credential ID.
     * Stores private key and credential ID in persistent NVM via BufferManager.
     * Stores public key for later retrieval.
     */
    public void generateCredential() {
        // Generate FIDO key pair
        fidoKeyPair.genKeyPair();

        // Store private key S
        ECPrivateKey priv = (ECPrivateKey) fidoKeyPair.getPrivate();
        priv.getS(bufMgr.getFidoPrivKey(), (short) 0);

        // Store public key W
        ECPublicKey pub = (ECPublicKey) fidoKeyPair.getPublic();
        pub.getW(bufMgr.getFidoPubKey(), (short) 0);

        // Generate random credential ID (32 bytes)
        random.nextBytes(bufMgr.getFidoCredId(), (short) 0, Constants.FIDO_CRED_ID_LEN);
    }

    /**
     * Build the FIDO2 authenticator data for registration.
     *
     * Layout (per WebAuthn spec):
     *   rpIdHash(32) || flags(1) || signCount(4) || aaguid(16)
     *   || credIdLen(2) || credentialId(32)
     *   || credentialPublicKey(COSE_Key, ~77 bytes)
     *
     * @param rpId       relying party ID string (e.g., "palisade.example.com")
     * @param rpIdOff    offset into rpId
     * @param rpIdLen    length of rpId
     * @param out        output buffer
     * @param outOff     offset into output buffer
     * @return length of authenticator data written
     */
    public short buildAuthenticatorData(byte[] rpId, short rpIdOff, short rpIdLen,
                                        byte[] out, short outOff) {
        short pos = outOff;

        // rpIdHash = SHA-256(rpId)
        sha256.reset();
        sha256.doFinal(rpId, rpIdOff, rpIdLen, out, pos);
        pos = (short) (pos + 32);

        // flags: UP=1, AT=1 → 0x45
        out[pos++] = Constants.FIDO_FLAGS_UP_AT;

        // signCount: 0x00000000 (initial)
        out[pos++] = (byte) 0x00;
        out[pos++] = (byte) 0x00;
        out[pos++] = (byte) 0x00;
        out[pos++] = (byte) 0x00;

        // aaguid (16 bytes)
        Util.arrayCopyNonAtomic(AAGUID, (short) 0, out, pos, (short) 16);
        pos = (short) (pos + 16);

        // credentialIdLength (2 bytes, big-endian)
        Util.setShort(out, pos, Constants.FIDO_CRED_ID_LEN);
        pos = (short) (pos + 2);

        // credentialId (32 bytes)
        Util.arrayCopyNonAtomic(bufMgr.getFidoCredId(), (short) 0, out, pos, Constants.FIDO_CRED_ID_LEN);
        pos = (short) (pos + Constants.FIDO_CRED_ID_LEN);

        // credentialPublicKey (COSE_Key in CBOR)
        pos = encodeCoseKey(bufMgr.getFidoPubKey(), (short) 0, out, pos);

        return (short) (pos - outOff);
    }

    /**
     * Sign attestation: ECDSA(attestation_key, authData || clientDataHash).
     *
     * @param attestProvider  attestation provider for signing
     * @param authData        authenticator data buffer
     * @param authDataOff     offset of auth data
     * @param authDataLen     length of auth data
     * @param clientDataHash  SHA-256 of client data JSON (32 bytes)
     * @param cdHashOff       offset into clientDataHash
     * @param sig             output buffer for DER-encoded signature
     * @param sigOff          offset into signature buffer
     * @return length of signature
     */
    public short signAttestation(AttestationProvider attestProvider,
                                 byte[] authData, short authDataOff, short authDataLen,
                                 byte[] clientDataHash, short cdHashOff,
                                 byte[] sig, short sigOff) {
        // Concatenate authData || clientDataHash in work buffer
        byte[] workBuf = bufMgr.getWorkBuffer();
        Util.arrayCopyNonAtomic(authData, authDataOff, workBuf, (short) 0, authDataLen);
        Util.arrayCopyNonAtomic(clientDataHash, cdHashOff, workBuf, authDataLen, (short) 32);

        short totalLen = (short) (authDataLen + 32);
        return attestProvider.signAttestation(workBuf, (short) 0, totalLen, sig, sigOff);
    }

    /**
     * Copy credential data for the final status response.
     *
     * @param out     output buffer
     * @param outOff  offset into output buffer
     * @return length written: credIdLen(1) + credId(32) + pubKeyLen(1) + pubKey(65) = 99 bytes
     */
    public short getCredentialData(byte[] out, short outOff) {
        short pos = outOff;

        // Credential ID length + data
        out[pos++] = (byte) Constants.FIDO_CRED_ID_LEN;
        Util.arrayCopyNonAtomic(bufMgr.getFidoCredId(), (short) 0, out, pos, Constants.FIDO_CRED_ID_LEN);
        pos = (short) (pos + Constants.FIDO_CRED_ID_LEN);

        // Public key length + data
        out[pos++] = (byte) Constants.ICC_PUB_KEY_LEN;
        Util.arrayCopyNonAtomic(bufMgr.getFidoPubKey(), (short) 0, out, pos, Constants.ICC_PUB_KEY_LEN);
        pos = (short) (pos + Constants.ICC_PUB_KEY_LEN);

        return (short) (pos - outOff);
    }

    // -----------------------------------------------------------------------
    // COSE_Key encoding (hand-encoded CBOR per RFC 8152 Section 13.1.1)
    // -----------------------------------------------------------------------

    /**
     * Encode an ECC P-256 public key as a COSE_Key in CBOR format.
     *
     * COSE_Key map (5 entries):
     *   1 (kty):  2 (EC2)
     *   3 (alg): -7 (ES256)
     *  -1 (crv):  1 (P-256)
     *  -2 (x):    bstr(32)
     *  -3 (y):    bstr(32)
     *
     * CBOR encoding (minimal deterministic):
     *   A5                     -- map(5)
     *   01 02                  -- 1: 2
     *   03 26                  -- 3: -7 (encoded as 0x26)
     *   20 01                  -- -1: 1
     *   21 5820 [32 bytes]     -- -2: bstr(32) = X coordinate
     *   22 5820 [32 bytes]     -- -3: bstr(32) = Y coordinate
     *
     * Total: 1 + 2 + 2 + 2 + (2+32) + (2+32) = 77 bytes
     *
     * @param pubKeyW   uncompressed public key (04 || X || Y, 65 bytes)
     * @param pubKeyOff offset of pubKeyW
     * @param out       output buffer
     * @param outOff    offset into output buffer
     * @return new offset after COSE_Key
     */
    private short encodeCoseKey(byte[] pubKeyW, short pubKeyOff, byte[] out, short outOff) {
        short pos = outOff;

        // Map with 5 entries
        out[pos++] = (byte) 0xA5;

        // 1 (kty): 2 (EC2)
        out[pos++] = (byte) 0x01;
        out[pos++] = Constants.COSE_KTY_EC2;

        // 3 (alg): -7 (ES256) — CBOR negative int: -1-n, so -7 = 0x26
        out[pos++] = (byte) 0x03;
        out[pos++] = Constants.COSE_ALG_ES256;

        // -1 (crv): 1 (P-256) — CBOR negative key: -1 = 0x20
        out[pos++] = (byte) 0x20;
        out[pos++] = Constants.COSE_CRV_P256;

        // -2 (x): bstr(32) — CBOR negative key: -2 = 0x21
        out[pos++] = (byte) 0x21;
        out[pos++] = (byte) 0x58; // bstr with 1-byte length
        out[pos++] = (byte) 0x20; // 32 bytes
        // X coordinate starts at pubKeyW[1] (skip 0x04 prefix)
        Util.arrayCopyNonAtomic(pubKeyW, (short) (pubKeyOff + 1), out, pos, (short) 32);
        pos = (short) (pos + 32);

        // -3 (y): bstr(32) — CBOR negative key: -3 = 0x22
        out[pos++] = (byte) 0x22;
        out[pos++] = (byte) 0x58;
        out[pos++] = (byte) 0x20;
        // Y coordinate starts at pubKeyW[33]
        Util.arrayCopyNonAtomic(pubKeyW, (short) (pubKeyOff + 33), out, pos, (short) 32);
        pos = (short) (pos + 32);

        return pos;
    }

    // -----------------------------------------------------------------------
    // P-256 parameter setup (shared with SCP11cScriptBuilder)
    // -----------------------------------------------------------------------

    private static final byte[] P256_P = {
        (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF, (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x01,
        (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00, (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00,
        (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00, (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF,
        (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF, (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF
    };

    private static final byte[] P256_A = {
        (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF, (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x01,
        (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00, (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00,
        (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00, (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF,
        (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF, (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFC
    };

    private static final byte[] P256_B = {
        (byte)0x5A,(byte)0xC6,(byte)0x35,(byte)0xD8, (byte)0xAA,(byte)0x3A,(byte)0x93,(byte)0xE7,
        (byte)0xB3,(byte)0xEB,(byte)0xBD,(byte)0x55, (byte)0x76,(byte)0x98,(byte)0x86,(byte)0xBC,
        (byte)0x65,(byte)0x1D,(byte)0x06,(byte)0xB0, (byte)0xCC,(byte)0x53,(byte)0xB0,(byte)0xF6,
        (byte)0x3B,(byte)0xCE,(byte)0x3C,(byte)0x3E, (byte)0x27,(byte)0xD2,(byte)0x60,(byte)0x4B
    };

    private static final byte[] P256_G = {
        (byte)0x04,
        (byte)0x6B,(byte)0x17,(byte)0xD1,(byte)0xF2, (byte)0xE1,(byte)0x2C,(byte)0x42,(byte)0x47,
        (byte)0xF8,(byte)0xBC,(byte)0xE6,(byte)0xE5, (byte)0x63,(byte)0xA4,(byte)0x40,(byte)0xF2,
        (byte)0x77,(byte)0x03,(byte)0x7D,(byte)0x81, (byte)0x2D,(byte)0xEB,(byte)0x33,(byte)0xA0,
        (byte)0xF4,(byte)0xA1,(byte)0x39,(byte)0x45, (byte)0xD8,(byte)0x98,(byte)0xC2,(byte)0x96,
        (byte)0x4F,(byte)0xE3,(byte)0x42,(byte)0xE2, (byte)0xFE,(byte)0x1A,(byte)0x7F,(byte)0x9B,
        (byte)0x8E,(byte)0xE7,(byte)0xEB,(byte)0x4A, (byte)0x7C,(byte)0x0F,(byte)0x9E,(byte)0x16,
        (byte)0x2B,(byte)0xCE,(byte)0x33,(byte)0x57, (byte)0x6B,(byte)0x31,(byte)0x5E,(byte)0xCE,
        (byte)0xCB,(byte)0xB6,(byte)0x40,(byte)0x68, (byte)0x37,(byte)0xBF,(byte)0x51,(byte)0xF5
    };

    private static final byte[] P256_N = {
        (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF, (byte)0x00,(byte)0x00,(byte)0x00,(byte)0x00,
        (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF, (byte)0xFF,(byte)0xFF,(byte)0xFF,(byte)0xFF,
        (byte)0xBC,(byte)0xE6,(byte)0xFA,(byte)0xAD, (byte)0xA7,(byte)0x17,(byte)0x9E,(byte)0x84,
        (byte)0xF3,(byte)0xB9,(byte)0xCA,(byte)0xC2, (byte)0xFC,(byte)0x63,(byte)0x25,(byte)0x51
    };

    private static void initP256Params(ECPublicKey key) {
        key.setFieldFP(P256_P, (short) 0, (short) P256_P.length);
        key.setA(P256_A, (short) 0, (short) P256_A.length);
        key.setB(P256_B, (short) 0, (short) P256_B.length);
        key.setG(P256_G, (short) 0, (short) P256_G.length);
        key.setR(P256_N, (short) 0, (short) P256_N.length);
        key.setK((short) 1);
    }

    private static void initP256Params(ECPrivateKey key) {
        key.setFieldFP(P256_P, (short) 0, (short) P256_P.length);
        key.setA(P256_A, (short) 0, (short) P256_A.length);
        key.setB(P256_B, (short) 0, (short) P256_B.length);
        key.setG(P256_G, (short) 0, (short) P256_G.length);
        key.setR(P256_N, (short) 0, (short) P256_N.length);
        key.setK((short) 1);
    }
}
