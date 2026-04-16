/*
 * Project Palisade — STORE DATA APDU Builder
 *
 * Builds raw STORE DATA APDUs from SAD (Secure Application Data) and
 * the ICC private key DGI. These APDUs are then wrapped by
 * SCP11cScriptBuilder before being relayed to the SSD.
 *
 * STORE DATA format: CLA(84) INS(E2) P1(xx) P2(xx) Lc DGI(2) Len Data
 *
 * P1 encoding (GP 2.3 Table 11-36):
 *   b8: last block flag (1 = last)
 *   b5-b4: encryption (00 = app-dep, 01 = none, 10 = encrypted, 11 = reserved)
 *   b1-b2: structure (00 = not DGI, 01 = DGI, 10 = BER-TLV)
 */
package com.palisade.pa;

import javacard.framework.Util;

public final class StoreDataBuilder {

    private StoreDataBuilder() {} // Non-instantiable

    /** P1 flag: DGI format. */
    private static final byte P1_DGI = (byte) 0x01;

    /** P1 flag: last block. */
    private static final byte P1_LAST = (byte) 0x80;

    /** P1 flag: encryption indicator for application-dependent. */
    private static final byte P1_ENC_NONE = (byte) 0x10;

    /**
     * Build a STORE DATA APDU for a single DGI from the SAD buffer.
     *
     * @param dgiTag   the 2-byte DGI tag (e.g., 0x0101)
     * @param data     buffer containing DGI value data
     * @param dataOff  offset into data buffer
     * @param dataLen  length of DGI value data
     * @param isLast   true if this is the last STORE DATA in the sequence
     * @param out      output buffer for the complete APDU
     * @param outOff   offset into output buffer
     * @return length of the APDU written to output buffer
     */
    public static short buildStoreDataApdu(
            short dgiTag, byte[] data, short dataOff, short dataLen,
            boolean isLast, byte[] out, short outOff) {

        short pos = outOff;

        // APDU header: CLA INS P1 P2
        out[pos++] = Constants.GP_CLA_STORE_DATA;
        out[pos++] = Constants.GP_INS_STORE_DATA;
        out[pos++] = (byte) (P1_DGI | P1_ENC_NONE | (isLast ? P1_LAST : 0));
        out[pos++] = (byte) 0x00; // P2 = block number (0 for simplicity)

        // Build DGI container: DGI_tag(2) || length || data
        // Calculate total Lc = 2 (DGI tag) + length-encoding-bytes + dataLen
        short lenBytes = getLengthEncodingSize(dataLen);
        short containerLen = (short) (2 + lenBytes + dataLen);

        // Lc
        out[pos++] = (byte) containerLen;

        // DGI tag (2 bytes, big-endian)
        out[pos++] = (byte) (dgiTag >> 8);
        out[pos++] = (byte) dgiTag;

        // DGI length
        pos = encodeLength(out, pos, dataLen);

        // DGI data
        Util.arrayCopyNonAtomic(data, dataOff, out, pos, dataLen);
        pos = (short) (pos + dataLen);

        return (short) (pos - outOff);
    }

    /**
     * Build a STORE DATA APDU for the ICC private key DGI.
     * This DGI is constructed entirely on-card — the private key
     * NEVER came from the RCA (patent-relevant).
     *
     * @param iccPrivDgiTag  DGI tag for ICC private key (from chip profile)
     * @param iccPrivKey     buffer containing the 32-byte ECC private key S
     * @param iccPrivKeyOff  offset into iccPrivKey
     * @param emvTag         EMV tag to wrap the key in (e.g., 0x9F10 or chip-specific)
     * @param isLast         true if this is the last STORE DATA
     * @param out            output buffer
     * @param outOff         offset into output buffer
     * @return length of the APDU written
     */
    public static short buildIccPrivKeyStoreData(
            short iccPrivDgiTag, byte[] iccPrivKey, short iccPrivKeyOff,
            short emvTag, boolean isLast,
            byte[] out, short outOff) {

        short pos = outOff;

        // APDU header
        out[pos++] = Constants.GP_CLA_STORE_DATA;
        out[pos++] = Constants.GP_INS_STORE_DATA;
        out[pos++] = (byte) (P1_DGI | P1_ENC_NONE | (isLast ? P1_LAST : 0));
        out[pos++] = (byte) 0x00;

        // Build DGI value: EMV_tag || len || privkey_S(32)
        // EMV tag can be 1 or 2 bytes
        short emvTagBytes;
        if ((short)(emvTag & (short)0xFF00) != (short)0) {
            emvTagBytes = (short) 2;
        } else {
            emvTagBytes = (short) 1;
        }

        short innerDataLen = (short) (emvTagBytes + 1 + Constants.ICC_PRIV_KEY_LEN);
        // 1 byte for length of privkey (always 0x20 = 32, fits in short form)

        short dgiLenBytes = getLengthEncodingSize(innerDataLen);
        short containerLen = (short) (2 + dgiLenBytes + innerDataLen);

        // Lc
        out[pos++] = (byte) containerLen;

        // DGI tag
        out[pos++] = (byte) (iccPrivDgiTag >> 8);
        out[pos++] = (byte) iccPrivDgiTag;

        // DGI length
        pos = encodeLength(out, pos, innerDataLen);

        // EMV tag
        if (emvTagBytes == (short) 2) {
            out[pos++] = (byte) (emvTag >> 8);
        }
        out[pos++] = (byte) emvTag;

        // EMV length
        out[pos++] = (byte) Constants.ICC_PRIV_KEY_LEN;

        // Private key S (32 bytes)
        Util.arrayCopyNonAtomic(iccPrivKey, iccPrivKeyOff, out, pos, Constants.ICC_PRIV_KEY_LEN);
        pos = (short) (pos + Constants.ICC_PRIV_KEY_LEN);

        return (short) (pos - outOff);
    }

    /**
     * Parse the SAD buffer and count the number of DGIs present.
     * SAD format: repeated [DGI_tag(2) || length || data]
     *
     * @param sad    SAD buffer
     * @param sadOff offset into SAD buffer
     * @param sadLen length of SAD data
     * @return number of DGIs found
     */
    public static short countDGIs(byte[] sad, short sadOff, short sadLen) {
        short count = 0;
        short pos = sadOff;
        short end = (short) (sadOff + sadLen);

        while (pos < end) {
            // Skip DGI tag (2 bytes)
            pos = (short) (pos + 2);

            // Parse length
            short dataLen = decodeLength(sad, pos);
            short lenBytes = getLengthEncodingSize(dataLen);
            pos = (short) (pos + lenBytes + dataLen);

            count++;
        }

        return count;
    }

    // -----------------------------------------------------------------------
    // Length encoding helpers
    // -----------------------------------------------------------------------

    private static short getLengthEncodingSize(short len) {
        if (len < (short) 0x80) return (short) 1;
        if (len < (short) 0x100) return (short) 2;
        return (short) 3;
    }

    private static short encodeLength(byte[] buf, short off, short len) {
        if (len < (short) 0x80) {
            buf[off] = (byte) len;
            return (short) (off + 1);
        }
        if (len < (short) 0x100) {
            buf[off] = (byte) 0x81;
            buf[(short) (off + 1)] = (byte) len;
            return (short) (off + 2);
        }
        buf[off] = (byte) 0x82;
        buf[(short) (off + 1)] = (byte) (len >> 8);
        buf[(short) (off + 2)] = (byte) len;
        return (short) (off + 3);
    }

    private static short decodeLength(byte[] buf, short off) {
        short first = (short) (buf[off] & 0x00FF);
        if (first < (short) 0x80) return first;
        if (first == (short) 0x81) return (short) (buf[(short) (off + 1)] & 0x00FF);
        // 0x82 — use Util.makeShort to avoid int promotion from << and |
        return Util.makeShort(buf[(short) (off + 1)], buf[(short) (off + 2)]);
    }
}
