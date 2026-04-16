/*
 * Project Palisade — NXP JCOP 5 Attestation Implementation
 *
 * Uses NXP proprietary attestation API to access the chip-burned
 * attestation key. This key is provisioned during NXP manufacturing
 * and is non-exportable.
 *
 * NXP JCOP 5 SDK Reference:
 * - com.nxp.id.jcopx.attestation.Attestation
 * - com.nxp.id.jcopx.attestation.AttestationKey
 *
 * NOTE: Exact API names may vary by JCOP 5 SDK version. This implementation
 * uses the documented public API surface. If the SDK uses different class
 * names, update the imports and calls accordingly — the logic is identical.
 */
package com.palisade.pa;

import javacard.framework.Util;
import javacard.security.ECPrivateKey;
import javacard.security.ECPublicKey;
import javacard.security.KeyBuilder;
import javacard.security.KeyPair;
import javacard.security.Signature;

/*
 * Production imports (uncomment when JCOP 5 SDK is available):
 *
 * import com.nxp.id.jcopx.attestation.Attestation;
 * import com.nxp.id.jcopx.attestation.AttestationKey;
 * import com.nxp.id.jcopx.util.SystemInfo;
 */

public class NxpAttestation implements AttestationProvider {

    /*
     * In production, these would be initialized from the NXP attestation API:
     *
     * private final Attestation attestation;
     * private final AttestationKey attestKey;
     * private final Signature signer;
     *
     * public NxpAttestation() {
     *     attestation = Attestation.getInstance();
     *     attestKey = attestation.getAttestationKey(AttestationKey.TYPE_EC_P256);
     *     signer = Signature.getInstance(Signature.ALG_ECDSA_SHA_256, false);
     *     signer.init(attestKey.getPrivateKey(), Signature.MODE_SIGN);
     * }
     */

    /** Pre-allocated signature object. */
    private Signature signer;

    /** Test signing key pair — lazy initialized on first sign call. */
    private KeyPair testKeyPair;

    /** Whether the test key has been generated yet. */
    private boolean keyReady;

    public NxpAttestation() {
        // LIGHTWEIGHT constructor — no ECC keygen here.
        // This runs during INSTALL [for install] which must complete fast
        // on contactless cards. Key generation deferred to first use.
        signer = Signature.getInstance(Signature.ALG_ECDSA_SHA_256, false);
        keyReady = false;
    }

    /**
     * Lazy-init: generate test attestation key on first use.
     * Called from signAttestation, NOT from constructor.
     */
    private void ensureKeyReady() {
        if (keyReady) return;

        testKeyPair = new KeyPair(KeyPair.ALG_EC_FP, KeyBuilder.LENGTH_EC_FP_256);
        ECPublicKey pub = (ECPublicKey) testKeyPair.getPublic();
        ECPrivateKey priv = (ECPrivateKey) testKeyPair.getPrivate();
        pub.setFieldFP(P256_P, (short) 0, (short) P256_P.length);
        pub.setA(P256_A, (short) 0, (short) P256_A.length);
        pub.setB(P256_B, (short) 0, (short) P256_B.length);
        pub.setG(P256_G, (short) 0, (short) P256_G.length);
        pub.setR(P256_N, (short) 0, (short) P256_N.length);
        pub.setK((short) 1);
        priv.setFieldFP(P256_P, (short) 0, (short) P256_P.length);
        priv.setA(P256_A, (short) 0, (short) P256_A.length);
        priv.setB(P256_B, (short) 0, (short) P256_B.length);
        priv.setG(P256_G, (short) 0, (short) P256_G.length);
        priv.setR(P256_N, (short) 0, (short) P256_N.length);
        priv.setK((short) 1);
        testKeyPair.genKeyPair();
        signer.init(priv, Signature.MODE_SIGN);
        keyReady = true;
    }

    /**
     * Sign attestation data using NXP chip-burned attestation key.
     *
     * Production implementation:
     * <pre>
     * signer.init(attestKey.getPrivateKey(), Signature.MODE_SIGN);
     * return signer.sign(data, off, len, sig, sigOff);
     * </pre>
     */
    @Override
    public short signAttestation(byte[] data, short off, short len,
                                  byte[] sig, short sigOff) {
        // Lazy-init test key on first sign (not in constructor — too slow for contactless install)
        ensureKeyReady();
        return signer.sign(data, off, len, sig, sigOff);
    }

    /**
     * Return the NXP attestation certificate chain.
     *
     * Production implementation:
     * <pre>
     * short certLen = attestation.getCertificateChain(out, outOff);
     * return certLen;
     * </pre>
     */
    @Override
    public short getAttestationCertChain(byte[] out, short outOff) {
        /*
         * PLACEHOLDER: In production, this returns the NXP attestation cert chain.
         * Production code: return attestation.getCertificateChain(out, outOff);
         */
        return (short) 0;
    }

    /**
     * Return CPLC (Card Production Life Cycle) data — 42 bytes.
     *
     * Production implementation:
     * <pre>
     * short len = SystemInfo.getCPLC(out, outOff);
     * return len;
     * </pre>
     *
     * Alternative: Use GET DATA (CLA=80, INS=CA, P1=9F, P2=7F) APDU
     * to retrieve CPLC from the Card Manager.
     */
    @Override
    public short getHardwareId(byte[] out, short outOff) {
        /*
         * PLACEHOLDER: In production, retrieve CPLC from NXP JCOP 5 API.
         * CPLC is 42 bytes containing IC fabrication date, IC serial, etc.
         * Production code: return SystemInfo.getCPLC(out, outOff);
         */
        Util.arrayFillNonAtomic(out, outOff, (short) 42, (byte) 0x00);
        return (short) 42;
    }

    // P-256 domain parameters for test key pair
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
}
