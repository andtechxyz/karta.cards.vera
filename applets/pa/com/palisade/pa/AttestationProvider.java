/*
 * Project Palisade — Attestation Provider Interface
 *
 * The ONLY vendor-specific abstraction in the PA. All other code uses
 * standard JavaCard 3.0.5 and GlobalPlatform APIs.
 *
 * Implementations:
 * - NxpAttestation: JCOP 5 attestation via NXP proprietary API
 * - InfineonAttestation: Secora Pay attestation via Infineon proprietary API
 */
package com.palisade.pa;

public interface AttestationProvider {

    /**
     * Sign attestation data using the chip's burned-in attestation key.
     * The attestation key is non-exportable and vendor-provisioned.
     *
     * @param data   buffer containing data to sign
     * @param off    offset into data buffer
     * @param len    length of data to sign
     * @param sig    output buffer for signature (DER-encoded ECDSA)
     * @param sigOff offset into signature buffer
     * @return length of signature written
     */
    short signAttestation(byte[] data, short off, short len,
                          byte[] sig, short sigOff);

    /**
     * Copy the attestation certificate chain into the output buffer.
     * Chain order: leaf cert first, root last.
     *
     * @param out    output buffer
     * @param outOff offset into output buffer
     * @return length of certificate chain written
     */
    short getAttestationCertChain(byte[] out, short outOff);

    /**
     * Copy the hardware ID (CPLC or equivalent) into the output buffer.
     * Used to bind attestation to a specific physical chip.
     *
     * @param out    output buffer
     * @param outOff offset into output buffer
     * @return length of hardware ID written (typically 42 bytes for CPLC)
     */
    short getHardwareId(byte[] out, short outOff);
}
