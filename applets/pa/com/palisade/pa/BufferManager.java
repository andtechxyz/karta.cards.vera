/*
 * Project Palisade — Buffer Manager
 *
 * Pre-allocated NVM and transient RAM buffers. All allocation happens in
 * install() — zero allocation in process(). Provides zeroization methods
 * for PCI DSS key material cleanup.
 */
package com.palisade.pa;

import javacard.framework.JCSystem;
import javacard.framework.Util;

public final class BufferManager {

    // -----------------------------------------------------------------------
    // Persistent NVM buffers (survive power loss)
    // -----------------------------------------------------------------------

    /** ICC ECC P-256 private key S parameter. Zeroized after COMMIT. */
    private final byte[] iccPrivKey;

    /** ICC ECC P-256 public key W (uncompressed). Kept for final status. */
    private final byte[] iccPubKey;

    /** FIDO2 credential private key S parameter. Permanent. */
    private final byte[] fidoPrivKey;

    /** FIDO2 credential ID (32 random bytes). Permanent. */
    private final byte[] fidoCredId;

    /** FIDO2 public key W (uncompressed). Permanent. */
    private final byte[] fidoPubKey;

    /** Provenance log — circular buffer of hashed session records. */
    private final byte[] provenanceLog;

    /** Card info EEPROM — bank, program, scheme, lifecycle state, tap counter. */
    private final byte[] cardInfo;

    /** State machine flag (1 byte). */
    private final byte[] state;

    // -----------------------------------------------------------------------
    // Transient RAM buffers (CLEAR_ON_DESELECT — auto-cleared on deselect)
    // -----------------------------------------------------------------------

    /** SSD static public key for SCP11c ECDH. */
    private final byte[] ssdPubKey;

    /** SAD (Secure Application Data) receive buffer. */
    private final byte[] sadBuffer;

    /** Script assembly buffer for SCP11c-wrapped commands. */
    private final byte[] scriptBuffer;

    /** General-purpose working buffer for crypto intermediates. */
    private final byte[] workBuffer;

    /** SCP11c S-ENC session key. */
    private final byte[] sessionKeyEnc;

    /** SCP11c S-MAC session key. */
    private final byte[] sessionKeyMac;

    /** SCP11c S-RMAC session key. */
    private final byte[] sessionKeyRmac;

    /** MAC chaining value (16 bytes). */
    private final byte[] macChaining;

    /** SAD data length tracker. */
    private final short[] sadLength;

    /**
     * Allocate all buffers. MUST be called only from install().
     * No further allocation happens anywhere in the applet lifecycle.
     */
    public BufferManager() {
        // NVM persistent
        iccPrivKey    = new byte[Constants.ICC_PRIV_KEY_LEN];
        iccPubKey     = new byte[Constants.ICC_PUB_KEY_LEN];
        fidoPrivKey   = new byte[Constants.FIDO_PRIV_KEY_LEN];
        fidoCredId    = new byte[Constants.FIDO_CRED_ID_LEN];
        fidoPubKey    = new byte[Constants.ICC_PUB_KEY_LEN];
        provenanceLog = new byte[Constants.PROVENANCE_LOG_LEN];
        cardInfo      = new byte[Constants.CARD_INFO_LEN];
        state         = new byte[1];

        // Transient RAM — cleared on deselect
        ssdPubKey      = JCSystem.makeTransientByteArray(Constants.SSD_PUB_KEY_LEN, JCSystem.CLEAR_ON_DESELECT);
        sadBuffer      = JCSystem.makeTransientByteArray(Constants.SAD_BUFFER_LEN, JCSystem.CLEAR_ON_DESELECT);
        scriptBuffer   = JCSystem.makeTransientByteArray(Constants.SCRIPT_BUFFER_LEN, JCSystem.CLEAR_ON_DESELECT);
        workBuffer     = JCSystem.makeTransientByteArray(Constants.WORK_BUFFER_LEN, JCSystem.CLEAR_ON_DESELECT);
        sessionKeyEnc  = JCSystem.makeTransientByteArray(Constants.SESSION_KEY_LEN, JCSystem.CLEAR_ON_DESELECT);
        sessionKeyMac  = JCSystem.makeTransientByteArray(Constants.SESSION_KEY_LEN, JCSystem.CLEAR_ON_DESELECT);
        sessionKeyRmac = JCSystem.makeTransientByteArray(Constants.SESSION_KEY_LEN, JCSystem.CLEAR_ON_DESELECT);
        macChaining    = JCSystem.makeTransientByteArray(Constants.AES_BLOCK_SIZE, JCSystem.CLEAR_ON_DESELECT);
        sadLength      = JCSystem.makeTransientShortArray((short) 1, JCSystem.CLEAR_ON_DESELECT);
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    public byte[] getIccPrivKey()     { return iccPrivKey; }
    public byte[] getIccPubKey()      { return iccPubKey; }
    public byte[] getFidoPrivKey()    { return fidoPrivKey; }
    public byte[] getFidoCredId()     { return fidoCredId; }
    public byte[] getFidoPubKey()     { return fidoPubKey; }
    public byte[] getProvenanceLog()  { return provenanceLog; }
    public byte[] getCardInfo()       { return cardInfo; }
    public byte[] getSsdPubKey()      { return ssdPubKey; }
    public byte[] getSadBuffer()      { return sadBuffer; }
    public byte[] getScriptBuffer()   { return scriptBuffer; }
    public byte[] getWorkBuffer()     { return workBuffer; }
    public byte[] getSessionKeyEnc()  { return sessionKeyEnc; }
    public byte[] getSessionKeyMac()  { return sessionKeyMac; }
    public byte[] getSessionKeyRmac() { return sessionKeyRmac; }
    public byte[] getMacChaining()    { return macChaining; }

    public short getSadLength() {
        return sadLength[0];
    }

    public void setSadLength(short len) {
        sadLength[0] = len;
    }

    // -----------------------------------------------------------------------
    // State access (NVM)
    // -----------------------------------------------------------------------

    public byte getState() {
        return state[0];
    }

    public void setState(byte newState) {
        state[0] = newState;
    }

    // -----------------------------------------------------------------------
    // Card info EEPROM access
    // -----------------------------------------------------------------------

    public byte getCardState() {
        return cardInfo[Constants.CARD_INFO_STATE_OFF];
    }

    public void setCardState(byte cardState) {
        cardInfo[Constants.CARD_INFO_STATE_OFF] = cardState;
    }

    public void setCardScheme(byte scheme) {
        cardInfo[Constants.CARD_INFO_SCHEME_OFF] = scheme;
    }

    /** Write bank_id (4 bytes) from source buffer. */
    public void setBankId(byte[] src, short srcOff) {
        Util.arrayCopyNonAtomic(src, srcOff, cardInfo, Constants.CARD_INFO_BANK_OFF, (short) 4);
    }

    /** Write program_id (4 bytes) from source buffer. */
    public void setProgramId(byte[] src, short srcOff) {
        Util.arrayCopyNonAtomic(src, srcOff, cardInfo, Constants.CARD_INFO_PROG_OFF, (short) 4);
    }

    /** Write provisioned_at timestamp (4 bytes) from source buffer. */
    public void setProvisionedAt(byte[] src, short srcOff) {
        Util.arrayCopyNonAtomic(src, srcOff, cardInfo, Constants.CARD_INFO_TIME_OFF, (short) 4);
    }

    /** Store bank URL for T4T swap and self-healing. */
    public void setBankUrl(byte[] url, short urlOff, short urlLen) {
        if (urlLen > Constants.CARD_INFO_URL_MAX) {
            urlLen = Constants.CARD_INFO_URL_MAX;
        }
        cardInfo[Constants.CARD_INFO_URL_LEN_OFF] = (byte) urlLen;
        Util.arrayCopyNonAtomic(url, urlOff, cardInfo, Constants.CARD_INFO_URL_OFF, urlLen);
    }

    /** Get stored bank URL length. */
    public short getBankUrlLen() {
        return (short)(cardInfo[Constants.CARD_INFO_URL_LEN_OFF] & 0x00FF);
    }

    /** Get bank URL offset in cardInfo buffer. */
    public short getBankUrlOff() {
        return Constants.CARD_INFO_URL_OFF;
    }

    /** Mark T4T as swapped. */
    public void setT4TSwapped() {
        cardInfo[Constants.CARD_INFO_T4T_FLAG_OFF] = Constants.T4T_SWAPPED;
    }

    /** Check if T4T was swapped (should be present with bank URL). */
    public boolean isT4TSwapped() {
        return cardInfo[Constants.CARD_INFO_T4T_FLAG_OFF] == Constants.T4T_SWAPPED;
    }

    /** Increment tap counter (4 bytes big-endian). */
    public void incrementTapCounter() {
        short off = Constants.CARD_INFO_TAPS_OFF;
        for (short i = (short)(off + 3); i >= off; i--) {
            short val = (short) ((cardInfo[i] & 0x00FF) + (short)1);
            cardInfo[i] = (byte) val;
            if (val <= (short)0xFF) break;
        }
    }

    /** Copy full card info to output buffer. */
    public short getCardInfoBytes(byte[] out, short outOff) {
        Util.arrayCopyNonAtomic(cardInfo, (short) 0, out, outOff, Constants.CARD_INFO_LEN);
        return Constants.CARD_INFO_LEN;
    }

    // -----------------------------------------------------------------------
    // Zeroization — PCI DSS key material cleanup
    // -----------------------------------------------------------------------

    /** Zeroize ICC private key. Called after COMMIT or during cleanup. */
    public void zeroizeIccPrivKey() {
        Util.arrayFillNonAtomic(iccPrivKey, (short) 0, Constants.ICC_PRIV_KEY_LEN, (byte) 0x00);
    }

    /** Zeroize FIDO credential keys. Called during WIPE. */
    public void zeroizeFidoKeys() {
        Util.arrayFillNonAtomic(fidoPrivKey, (short) 0, Constants.FIDO_PRIV_KEY_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(fidoCredId, (short) 0, Constants.FIDO_CRED_ID_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(fidoPubKey, (short) 0, Constants.ICC_PUB_KEY_LEN, (byte) 0x00);
    }

    /** Zeroize SCP11c session keys. Called after script build. */
    public void zeroizeSessionKeys() {
        Util.arrayFillNonAtomic(sessionKeyEnc, (short) 0, Constants.SESSION_KEY_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(sessionKeyMac, (short) 0, Constants.SESSION_KEY_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(sessionKeyRmac, (short) 0, Constants.SESSION_KEY_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(macChaining, (short) 0, Constants.AES_BLOCK_SIZE, (byte) 0x00);
    }

    /** Zeroize SSD public key. Called after ECDH completes. */
    public void zeroizeSsdPubKey() {
        Util.arrayFillNonAtomic(ssdPubKey, (short) 0, Constants.SSD_PUB_KEY_LEN, (byte) 0x00);
    }

    /**
     * Full cleanup: zeroize ALL key material and reset transient buffers.
     * Called during interrupted-state recovery on SELECT and during WIPE.
     */
    public void zeroizeAll() {
        zeroizeIccPrivKey();
        zeroizeFidoKeys();
        zeroizeSessionKeys();
        zeroizeSsdPubKey();
        Util.arrayFillNonAtomic(iccPubKey, (short) 0, Constants.ICC_PUB_KEY_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(sadBuffer, (short) 0, Constants.SAD_BUFFER_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(scriptBuffer, (short) 0, Constants.SCRIPT_BUFFER_LEN, (byte) 0x00);
        Util.arrayFillNonAtomic(workBuffer, (short) 0, Constants.WORK_BUFFER_LEN, (byte) 0x00);
        sadLength[0] = (short) 0;
    }
}
