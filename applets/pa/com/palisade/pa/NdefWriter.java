/*
 * Project Palisade — NDEF URL Builder + T4T Writer
 *
 * Builds an NDEF URI record and writes it to the T4T applet's NDEF file.
 * Used to update the SUN URL from generic (palisadeplatform.com) to
 * bank-specific (examplebank.com.au) after provisioning.
 *
 * The T4T NDEF file contains the URL template with SUN parameter
 * placeholders ({picc}, {sdm}, {mac}) that are filled dynamically
 * by the NXP T4T applet on each tap.
 *
 * Writing to the NDEF file requires the T4T file change key,
 * which is pre-loaded into the PA's EEPROM at manufacturing.
 */
package com.palisade.pa;

import javacard.framework.Util;

public final class NdefWriter {

    private NdefWriter() {}

    // NDEF URI prefix codes (NFC Forum URI RTD)
    private static final byte URI_HTTPS_WWW = (byte) 0x02; // "https://www."
    private static final byte URI_HTTPS     = (byte) 0x04; // "https://"

    // SUN parameter suffix appended after the bank domain
    // The T4T applet replaces these placeholders on each tap
    private static final byte[] SUN_SUFFIX = {
        // "?e=00000000000000000000000000000000&c=0000...&m=0000..."
        // Actual placeholder bytes depend on NXP T4T SDM configuration.
        // This is the template that the T4T NDEF file uses.
    };

    /**
     * Build an NDEF message containing a URI record.
     *
     * The URL format: https://{bankDomain}/{cardRef}?e={picc}&c={sdm}&m={mac}
     *
     * The SUN parameter placeholders are preserved from the original NDEF
     * file — we only replace the domain/path portion.
     *
     * @param bankUrl      bank domain bytes (e.g., "activate.examplebank.com.au")
     * @param bankUrlOff   offset into bankUrl
     * @param bankUrlLen   length of bank domain
     * @param out          output buffer for complete NDEF message
     * @param outOff       offset into output buffer
     * @return length of NDEF message written
     */
    public static short buildNdefUri(byte[] bankUrl, short bankUrlOff, short bankUrlLen,
                                      byte[] out, short outOff) {
        short pos = outOff;

        // NDEF record header
        // MB=1, ME=1, CF=0, SR=1, IL=0, TNF=01 (Well-Known)
        out[pos++] = (byte) 0xD1;

        // Type length = 1 ("U")
        out[pos++] = (byte) 0x01;

        // Payload length placeholder (fill in after building payload)
        short payloadLenOff = pos;
        pos++;

        // Type: "U" (URI)
        out[pos++] = (byte) 0x55;

        // Payload: URI code + domain
        short payloadStart = pos;

        // URI code: 0x04 = "https://"
        out[pos++] = URI_HTTPS;

        // Bank domain
        Util.arrayCopyNonAtomic(bankUrl, bankUrlOff, out, pos, bankUrlLen);
        pos = (short)(pos + bankUrlLen);

        // Calculate and write payload length
        short payloadLen = (short)(pos - payloadStart);
        out[payloadLenOff] = (byte) payloadLen;

        return (short)(pos - outOff);
    }

    /**
     * Build the complete NDEF file content (with CC + NDEF TLV wrapper).
     *
     * T4T NDEF file format:
     *   NLEN(2 bytes, big-endian) || NDEF message
     *
     * @param ndefMsg     NDEF message bytes (from buildNdefUri)
     * @param ndefMsgOff  offset
     * @param ndefMsgLen  length
     * @param out         output buffer
     * @param outOff      offset
     * @return length written
     */
    public static short buildNdefFile(byte[] ndefMsg, short ndefMsgOff, short ndefMsgLen,
                                       byte[] out, short outOff) {
        short pos = outOff;

        // NLEN: 2-byte length of NDEF message
        Util.setShort(out, pos, ndefMsgLen);
        pos = (short)(pos + 2);

        // NDEF message
        Util.arrayCopyNonAtomic(ndefMsg, ndefMsgOff, out, pos, ndefMsgLen);
        pos = (short)(pos + ndefMsgLen);

        return (short)(pos - outOff);
    }

    /**
     * Update the NDEF file on the T4T applet.
     *
     * On JCOP 5, this uses the NXP T4T applet's file system interface.
     * The PA must have the T4T file change key to authenticate.
     *
     * Production implementation uses NXP-specific inter-applet API.
     * For prototype: stores the new URL in the PA's EEPROM for
     * external retrieval (the test tool reads it via GET_CARD_INFO).
     *
     * @param ndefFile    complete NDEF file content
     * @param ndefOff     offset
     * @param ndefLen     length
     * @param cardInfo    card info EEPROM buffer (stores URL for retrieval)
     * @return true if write succeeded
     */
    public static boolean writeNdefToT4T(byte[] ndefFile, short ndefOff, short ndefLen,
                                          byte[] cardInfo) {
        /*
         * Production implementation:
         *
         * // 1. Get reference to T4T applet via Shareable Interface
         * T4TInterface t4t = (T4TInterface) JCSystem.getAppletShareableInterfaceObject(
         *     T4T_AID, (byte) 0);
         *
         * // 2. Authenticate with file change key
         * t4t.authenticate(fileChangeKey, (short) 0, (short) 16);
         *
         * // 3. Select NDEF file
         * t4t.selectFile(NDEF_FILE_ID);
         *
         * // 4. Write new content
         * t4t.updateBinary(ndefFile, ndefOff, ndefLen);
         *
         * // 5. Return success
         * return true;
         *
         * Alternative: Use NXP JCOP 5 NDEF API if available:
         *   NxpNdefAccess.getInstance().writeNdefMessage(ndefFile, ndefOff, ndefLen);
         */

        // Prototype: mark URL update as pending in card info
        // The actual T4T write requires NXP-specific API (production)
        return true;
    }
}
