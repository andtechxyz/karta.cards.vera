/*
 * Project Palisade — Infineon Secora Pay Attestation Implementation
 *
 * Uses Infineon proprietary attestation API to access the chip-burned
 * attestation key on Secora Pay secure elements.
 *
 * Infineon Secora SDK Reference:
 * - com.infineon.secora.attestation.ChipAttestation
 * - com.infineon.secora.attestation.AttestationService
 *
 * NOTE: Exact API names may vary by Secora SDK version. This implementation
 * documents the expected interface. Update imports when SDK is available.
 */
package com.palisade.pa;

import javacard.framework.Util;
import javacard.security.Signature;

/*
 * Production imports (uncomment when Secora SDK is available):
 *
 * import com.infineon.secora.attestation.ChipAttestation;
 * import com.infineon.secora.attestation.AttestationService;
 * import com.infineon.secora.platform.PlatformInfo;
 */

public class InfineonAttestation implements AttestationProvider {

    /** Pre-allocated signature object. */
    private final Signature signer;

    public InfineonAttestation() {
        signer = Signature.getInstance(Signature.ALG_ECDSA_SHA_256, false);
        // Production: init with Infineon attestation key
        // AttestationService svc = AttestationService.getInstance();
        // ChipAttestation attest = svc.getAttestation(ChipAttestation.ALG_EC_P256);
        // signer.init(attest.getPrivateKey(), Signature.MODE_SIGN);
    }

    /**
     * Sign attestation data using Infineon chip-burned attestation key.
     *
     * Production implementation:
     * <pre>
     * AttestationService svc = AttestationService.getInstance();
     * ChipAttestation attest = svc.getAttestation(ChipAttestation.ALG_EC_P256);
     * signer.init(attest.getPrivateKey(), Signature.MODE_SIGN);
     * return signer.sign(data, off, len, sig, sigOff);
     * </pre>
     */
    @Override
    public short signAttestation(byte[] data, short off, short len,
                                  byte[] sig, short sigOff) {
        return signer.sign(data, off, len, sig, sigOff);
    }

    /**
     * Return the Infineon attestation certificate chain.
     *
     * Production implementation:
     * <pre>
     * AttestationService svc = AttestationService.getInstance();
     * return svc.getCertificateChain(out, outOff);
     * </pre>
     */
    @Override
    public short getAttestationCertChain(byte[] out, short outOff) {
        // Production: return svc.getCertificateChain(out, outOff);
        return (short) 0;
    }

    /**
     * Return Infineon chip identifier.
     *
     * Secora Pay uses a different hardware ID format than NXP CPLC.
     * The Infineon platform provides chip-unique data through PlatformInfo.
     *
     * Production implementation:
     * <pre>
     * return PlatformInfo.getChipId(out, outOff);
     * </pre>
     */
    @Override
    public short getHardwareId(byte[] out, short outOff) {
        // Production: return PlatformInfo.getChipId(out, outOff);
        Util.arrayFillNonAtomic(out, outOff, (short) 42, (byte) 0x00);
        return (short) 42;
    }
}
