/*
 * Project Palisade — CTAP2 Authenticator Handler
 *
 * Implements authenticatorMakeCredential for browser-based provisioning
 * via WebAuthn. The PA acts as a FIDO2 authenticator that provisions
 * the card during credential creation.
 *
 * CTAP2 command flow:
 *   1. Browser calls navigator.credentials.create()
 *   2. Phone sends CTAP2 authenticatorMakeCredential to PA
 *   3. PA extracts SAD + bank_url from "palisade" extension
 *   4. PA does: keygen → STORE DATA → NDEF update → FIDO → COMMIT
 *   5. PA returns attestation response
 *   6. Browser receives credential + provisioning proof
 *
 * CTAP2 transport: NFC uses ISO 7816 framing.
 *   SELECT: A0000006472F0001 (FIDO2 AID)
 *   Command: 00 10 00 00 Lc [CBOR] — CTAP2 MSG
 *   Response: [status_byte] [CBOR] SW1 SW2
 *
 * Reference: FIDO2 CTAP2 specification, Section 6
 */
package com.palisade.pa;

import javacard.framework.APDU;
import javacard.framework.ISO7816;
import javacard.framework.ISOException;
import javacard.framework.Util;
import javacard.security.MessageDigest;

public final class Ctap2Handler {

    // CTAP2 commands
    private static final byte CTAP_MAKE_CREDENTIAL    = (byte) 0x01;
    private static final byte CTAP_GET_ASSERTION       = (byte) 0x02;
    private static final byte CTAP_GET_INFO            = (byte) 0x04;

    // U2F (CTAP1) commands — ISO 7816 INS bytes
    private static final byte U2F_REGISTER            = (byte) 0x01;
    private static final byte U2F_AUTHENTICATE        = (byte) 0x02;
    private static final byte U2F_VERSION             = (byte) 0x03;

    // CTAP2 status codes
    private static final byte CTAP2_OK                 = (byte) 0x00;
    private static final byte CTAP2_ERR_INVALID_CBOR   = (byte) 0x12;
    private static final byte CTAP2_ERR_UNSUPPORTED    = (byte) 0x2C;

    // U2F status words
    private static final short U2F_SW_NO_ERROR         = (short) 0x9000;
    private static final short U2F_SW_CONDITIONS_NOT_SATISFIED = (short) 0x6985;

    // CTAP2 makeCredential parameter keys (CBOR map integer keys)
    private static final short MC_CLIENT_DATA_HASH = (short) 1;
    private static final short MC_RP               = (short) 2;
    private static final short MC_USER             = (short) 3;
    private static final short MC_PUB_KEY_CRED     = (short) 4;
    private static final short MC_EXTENSIONS       = (short) 6;

    // Extension key for Palisade provisioning data
    // In the CBOR extensions map, look for text key "palisade"
    private static final byte[] EXT_KEY_PALISADE = {
        (byte)'p',(byte)'a',(byte)'l',(byte)'i',
        (byte)'s',(byte)'a',(byte)'d',(byte)'e'
    };

    // Palisade extension sub-keys (integer keys within the palisade map)
    private static final short PEXT_SAD      = (short) 1; // byte string: SAD DGI payload
    private static final short PEXT_BANK_URL = (short) 2; // text string: bank domain URL
    private static final short PEXT_BANK_ID  = (short) 3; // uint: bank identifier
    private static final short PEXT_PROG_ID  = (short) 4; // uint: program identifier
    private static final short PEXT_SCHEME   = (short) 5; // uint: scheme (1=MC, 2=Visa, 3=Amex)
    private static final short PEXT_DGI_TAG  = (short) 6; // uint: ICC priv key DGI tag
    private static final short PEXT_EMV_TAG  = (short) 7; // uint: ICC priv key EMV tag

    /** SHA-256 for rpIdHash and clientDataHash. */
    private final MessageDigest sha256;

    /** Reference to the applet's components. */
    private final BufferManager bufMgr;

    public Ctap2Handler(BufferManager bufMgr) {
        this.bufMgr = bufMgr;
        this.sha256 = MessageDigest.getInstance(MessageDigest.ALG_SHA_256, false);
    }

    /**
     * Process a CTAP2 command received via NFC ISO 7816 framing.
     *
     * NFC CTAP2 framing:
     *   Command APDU: 00 10 00 00 Lc [ctap_cmd(1) || cbor_data]
     *   Response: [ctap_status(1) || cbor_response] 90 00
     *
     * @param apdu   the APDU
     * @param provisionCallback  callback to trigger provisioning
     * @return true if this was a CTAP2 command and was handled
     */
    public boolean processCtap2(APDU apdu, ProvisionCallback provisionCallback) {
        byte[] buf = apdu.getBuffer();
        byte cla = buf[ISO7816.OFFSET_CLA];
        byte ins = buf[ISO7816.OFFSET_INS];

        // U2F (CTAP1) over NFC: CLA=00, INS=01/02/03
        if (cla == (byte) 0x00 && (ins == U2F_REGISTER || ins == U2F_AUTHENTICATE || ins == U2F_VERSION)) {
            processU2F(apdu, buf, ins, provisionCallback);
            return true;
        }

        // CTAP2 over NFC uses INS=10 (NFCCTAP_MSG)
        if (ins != (byte) 0x10) {
            return false;
        }

        short dataLen = apdu.setIncomingAndReceive();
        if (dataLen < (short) 1) {
            buf[0] = CTAP2_ERR_INVALID_CBOR;
            apdu.setOutgoingAndSend((short) 0, (short) 1);
            return true;
        }

        byte ctapCmd = buf[ISO7816.OFFSET_CDATA];
        short cborOff = (short)(ISO7816.OFFSET_CDATA + 1);
        short cborLen = (short)(dataLen - 1);

        switch (ctapCmd) {
            case CTAP_GET_INFO:
                processGetInfo(apdu, buf);
                break;
            case CTAP_MAKE_CREDENTIAL:
                processMakeCredential(apdu, buf, cborOff, cborLen, provisionCallback);
                break;
            default:
                buf[0] = CTAP2_ERR_UNSUPPORTED;
                apdu.setOutgoingAndSend((short) 0, (short) 1);
        }

        return true;
    }

    /**
     * authenticatorGetInfo — returns authenticator capabilities.
     */
    private void processGetInfo(APDU apdu, byte[] buf) {
        short pos = (short) 0;

        buf[pos++] = CTAP2_OK;

        // CBOR map with 7 entries (iOS/Android need all of these)
        pos += CborEncoder.encodeMapHeader(buf, pos, (short) 7);

        // 1: versions — ["U2F_V2", "FIDO_2_0"] (both required for compatibility)
        pos += CborEncoder.encodeUint(buf, pos, (short) 1);
        buf[pos++] = (byte) 0x82; // array(2)
        byte[] u2f = {(byte)'U',(byte)'2',(byte)'F',(byte)'_',(byte)'V',(byte)'2'};
        pos += CborEncoder.encodeTstr(buf, pos, u2f, (short) 0, (short) 6);
        byte[] f2 = {(byte)'F',(byte)'I',(byte)'D',(byte)'O',(byte)'_',(byte)'2',(byte)'_',(byte)'0'};
        pos += CborEncoder.encodeTstr(buf, pos, f2, (short) 0, (short) 8);

        // 2: extensions — ["palisade"]
        pos += CborEncoder.encodeUint(buf, pos, (short) 2);
        buf[pos++] = (byte) 0x81;
        pos += CborEncoder.encodeTstr(buf, pos, EXT_KEY_PALISADE, (short) 0, (short) EXT_KEY_PALISADE.length);

        // 3: aaguid (16 bytes)
        pos += CborEncoder.encodeUint(buf, pos, (short) 3);
        byte[] aaguid = {
            (byte)0x50,(byte)0x41,(byte)0x4C,(byte)0x49,
            (byte)0x53,(byte)0x41,(byte)0x44,(byte)0x45,
            (byte)0x2D,(byte)0x50,(byte)0x41,(byte)0x2D,
            (byte)0x56,(byte)0x30,(byte)0x30,(byte)0x32
        };
        pos += CborEncoder.encodeBstr(buf, pos, aaguid, (short) 0, (short) 16);

        // 4: options — {"plat": false, "rk": true, "up": true}
        pos += CborEncoder.encodeUint(buf, pos, (short) 4);
        pos += CborEncoder.encodeMapHeader(buf, pos, (short) 3);
        byte[] plat = {(byte)'p',(byte)'l',(byte)'a',(byte)'t'};
        pos += CborEncoder.encodeTstr(buf, pos, plat, (short) 0, (short) 4);
        pos += CborEncoder.encodeBool(buf, pos, false);
        byte[] rk = {(byte)'r',(byte)'k'};
        pos += CborEncoder.encodeTstr(buf, pos, rk, (short) 0, (short) 2);
        pos += CborEncoder.encodeBool(buf, pos, true);
        byte[] up = {(byte)'u',(byte)'p'};
        pos += CborEncoder.encodeTstr(buf, pos, up, (short) 0, (short) 2);
        pos += CborEncoder.encodeBool(buf, pos, true);

        // 5: maxMsgSize — 1200
        pos += CborEncoder.encodeUint(buf, pos, (short) 5);
        pos += CborEncoder.encodeUint(buf, pos, (short) 1200);

        // 6: pinUvAuthProtocols — [] (empty, no PIN)
        pos += CborEncoder.encodeUint(buf, pos, (short) 6);
        buf[pos++] = (byte) 0x80; // array(0)

        // 9: transports — ["nfc"]
        pos += CborEncoder.encodeUint(buf, pos, (short) 9);
        buf[pos++] = (byte) 0x81; // array(1)
        byte[] nfc = {(byte)'n',(byte)'f',(byte)'c'};
        pos += CborEncoder.encodeTstr(buf, pos, nfc, (short) 0, (short) 3);

        apdu.setOutgoingAndSend((short) 0, pos);
    }

    /**
     * authenticatorMakeCredential — creates credential + provisions card.
     *
     * If the "palisade" extension is present, triggers full provisioning.
     * Otherwise, creates a standard FIDO2 credential.
     */
    private void processMakeCredential(APDU apdu, byte[] buf, short cborOff, short cborLen,
                                        ProvisionCallback provisionCallback) {
        byte[] workBuf = bufMgr.getWorkBuffer();

        // The CBOR data is a map with keys 1-6
        // We need to extract:
        //   1: clientDataHash (32 bytes)
        //   2: rp (map with "id": string)
        //   6: extensions (map, look for "palisade")

        // For the prototype, we extract the palisade extension data
        // and trigger provisioning through the callback.

        // Find extensions (key 6) in the makeCredential map
        short extOff = CborEncoder.findMapIntKey(buf, cborOff, MC_EXTENSIONS);

        if (extOff >= (short) 0) {
            // Has extensions — check for "palisade"
            // The extensions value is a map. We need to find the "palisade" text key.
            // For now, assume the first extension IS palisade (prototype simplification).
            byte extMajor = CborEncoder.getMajorType(buf, extOff);
            if (extMajor == (byte) 0xA0) { // map
                // Extract palisade extension data and trigger provisioning
                short palisadeOff = (short)(extOff + CborEncoder.getHeadSize(buf, extOff));
                // Skip the text key "palisade"
                palisadeOff = CborEncoder.skipCborItem(buf, palisadeOff);
                // palisadeOff now points to the palisade extension value (a map)

                provisionCallback.onProvision(buf, palisadeOff);
            }
        }

        // Build attestation response
        short pos = (short) 0;
        buf[pos++] = CTAP2_OK;

        // Response CBOR map (3 entries):
        //   1: fmt — "packed"
        //   2: authData — authenticator data
        //   3: attStmt — attestation statement
        pos += CborEncoder.encodeMapHeader(buf, pos, (short) 3);

        // 1: fmt = "none"
        pos += CborEncoder.encodeUint(buf, pos, (short) 1);
        byte[] none = {(byte)'n',(byte)'o',(byte)'n',(byte)'e'};
        pos += CborEncoder.encodeTstr(buf, pos, none, (short) 0, (short) none.length);

        // 2: authData — build in work buffer then encode as bstr
        pos += CborEncoder.encodeUint(buf, pos, (short) 2);
        short authDataLen = buildAuthData(workBuf, (short) 0);
        pos += CborEncoder.encodeBstr(buf, pos, workBuf, (short) 0, authDataLen);

        // 3: attStmt = {} (empty for "none" attestation)
        pos += CborEncoder.encodeUint(buf, pos, (short) 3);
        pos += CborEncoder.encodeMapHeader(buf, pos, (short) 0);

        apdu.setOutgoingAndSend((short) 0, pos);
    }

    /**
     * Build authenticator data for the attestation response.
     *
     * Format: rpIdHash(32) || flags(1) || signCount(4) || attestedCredData
     *
     * attestedCredData: aaguid(16) || credIdLen(2) || credId(32) || credPubKey(COSE)
     */
    private short buildAuthData(byte[] out, short outOff) {
        short pos = outOff;

        // rpIdHash — SHA-256("palisadeplatform.com")
        // In production, hash the actual RP ID from the request
        byte[] rpId = {
            (byte)'p',(byte)'a',(byte)'l',(byte)'i',(byte)'s',(byte)'a',(byte)'d',(byte)'e',
            (byte)'p',(byte)'l',(byte)'a',(byte)'t',(byte)'f',(byte)'o',(byte)'r',(byte)'m',
            (byte)'.',(byte)'c',(byte)'o',(byte)'m'
        };
        sha256.reset();
        sha256.doFinal(rpId, (short) 0, (short) rpId.length, out, pos);
        pos = (short)(pos + 32);

        // Flags: UP(1) + AT(1) + ED(1) = 0x45
        out[pos++] = (byte) 0x45;

        // Sign count: 0x00000000
        out[pos++] = (byte) 0x00;
        out[pos++] = (byte) 0x00;
        out[pos++] = (byte) 0x00;
        out[pos++] = (byte) 0x00;

        // AAGUID (16 bytes)
        byte[] aaguid = {
            (byte)0x50,(byte)0x41,(byte)0x4C,(byte)0x49,
            (byte)0x53,(byte)0x41,(byte)0x44,(byte)0x45,
            (byte)0x2D,(byte)0x50,(byte)0x41,(byte)0x2D,
            (byte)0x56,(byte)0x30,(byte)0x30,(byte)0x32
        };
        Util.arrayCopyNonAtomic(aaguid, (short) 0, out, pos, (short) 16);
        pos = (short)(pos + 16);

        // Credential ID length (2 bytes)
        Util.setShort(out, pos, Constants.FIDO_CRED_ID_LEN);
        pos = (short)(pos + 2);

        // Credential ID (32 bytes)
        Util.arrayCopyNonAtomic(bufMgr.getFidoCredId(), (short) 0, out, pos, Constants.FIDO_CRED_ID_LEN);
        pos = (short)(pos + Constants.FIDO_CRED_ID_LEN);

        // Credential public key — COSE_Key (same encoding as FidoCredentialManager)
        pos = encodeCoseKey(bufMgr.getFidoPubKey(), (short) 0, out, pos);

        return (short)(pos - outOff);
    }

    /** Encode ECC P-256 public key as COSE_Key. */
    private short encodeCoseKey(byte[] pubKeyW, short pubKeyOff, byte[] out, short outOff) {
        short pos = outOff;

        // Map with 5 entries
        out[pos++] = (byte) 0xA5;

        // 1 (kty): 2 (EC2)
        out[pos++] = (byte) 0x01;
        out[pos++] = (byte) 0x02;

        // 3 (alg): -7 (ES256)
        out[pos++] = (byte) 0x03;
        out[pos++] = (byte) 0x26;

        // -1 (crv): 1 (P-256)
        out[pos++] = (byte) 0x20;
        out[pos++] = (byte) 0x01;

        // -2 (x): bstr(32)
        out[pos++] = (byte) 0x21;
        out[pos++] = (byte) 0x58;
        out[pos++] = (byte) 0x20;
        Util.arrayCopyNonAtomic(pubKeyW, (short)(pubKeyOff + 1), out, pos, (short) 32);
        pos = (short)(pos + 32);

        // -3 (y): bstr(32)
        out[pos++] = (byte) 0x22;
        out[pos++] = (byte) 0x58;
        out[pos++] = (byte) 0x20;
        Util.arrayCopyNonAtomic(pubKeyW, (short)(pubKeyOff + 33), out, pos, (short) 32);
        pos = (short)(pos + 32);

        return pos;
    }

    // -----------------------------------------------------------------------
    // U2F (CTAP1) — for Android NFC compatibility
    //
    // U2F Register:  CLA=00 INS=01 P1=00 P2=00 Lc=40
    //   Data: challenge(32) || appId(32)
    //   Response: 05 || pubKey(65) || credIdLen(1) || credId(32) || cert || sig
    //
    // U2F Authenticate: CLA=00 INS=02 P1=03/07 P2=00
    //   Data: challenge(32) || appId(32) || credIdLen(1) || credId(32)
    //   Response: userPresence(1) || counter(4) || sig
    //
    // U2F Version: CLA=00 INS=03
    //   Response: "U2F_V2"
    // -----------------------------------------------------------------------

    private void processU2F(APDU apdu, byte[] buf, byte ins, ProvisionCallback callback) {
        switch (ins) {
            case U2F_VERSION:
                processU2FVersion(apdu, buf);
                break;
            case U2F_REGISTER:
                processU2FRegister(apdu, buf, callback);
                break;
            case U2F_AUTHENTICATE:
                processU2FAuthenticate(apdu, buf);
                break;
            default:
                ISOException.throwIt(ISO7816.SW_INS_NOT_SUPPORTED);
        }
    }

    private void processU2FVersion(APDU apdu, byte[] buf) {
        byte[] version = {(byte)'U',(byte)'2',(byte)'F',(byte)'_',(byte)'V',(byte)'2'};
        Util.arrayCopyNonAtomic(version, (short) 0, buf, (short) 0, (short) 6);
        apdu.setOutgoingAndSend((short) 0, (short) 6);
    }

    private void processU2FRegister(APDU apdu, byte[] buf, ProvisionCallback callback) {
        short dataLen = apdu.setIncomingAndReceive();
        if (dataLen < (short) 64) {
            ISOException.throwIt(ISO7816.SW_WRONG_LENGTH);
        }

        // challenge(32) || appId(32) at OFFSET_CDATA
        // For provisioning: if FIDO credential exists, use it
        // Otherwise generate one

        byte[] workBuf = bufMgr.getWorkBuffer();
        short pos = (short) 0;

        // Reserved byte
        buf[pos++] = (byte) 0x05;

        // Public key (65 bytes, uncompressed)
        Util.arrayCopyNonAtomic(bufMgr.getFidoPubKey(), (short) 0, buf, pos, Constants.ICC_PUB_KEY_LEN);
        pos = (short)(pos + Constants.ICC_PUB_KEY_LEN);

        // Credential ID length
        buf[pos++] = (byte) Constants.FIDO_CRED_ID_LEN;

        // Credential ID (32 bytes)
        Util.arrayCopyNonAtomic(bufMgr.getFidoCredId(), (short) 0, buf, pos, Constants.FIDO_CRED_ID_LEN);
        pos = (short)(pos + Constants.FIDO_CRED_ID_LEN);

        // Attestation certificate — empty for prototype
        // Production: include X.509 cert from attestation provider

        // Signature over: 0x00 || appId(32) || challenge(32) || credId(32) || pubKey(65)
        // For prototype: return empty sig placeholder
        // Production: ECDSA sign with attestation key

        apdu.setOutgoingAndSend((short) 0, pos);
    }

    private void processU2FAuthenticate(APDU apdu, byte[] buf) {
        short dataLen = apdu.setIncomingAndReceive();
        if (dataLen < (short) 65) {
            ISOException.throwIt(ISO7816.SW_WRONG_LENGTH);
        }

        // challenge(32) || appId(32) || credIdLen(1) || credId(var)
        // Verify credId matches our stored credential

        byte[] workBuf = bufMgr.getWorkBuffer();
        short pos = (short) 0;

        // User presence byte (1 = user present)
        buf[pos++] = (byte) 0x01;

        // Counter (4 bytes, big-endian) — use tap counter from card info
        bufMgr.incrementTapCounter();
        byte[] cardInfo = bufMgr.getCardInfo();
        Util.arrayCopyNonAtomic(cardInfo, Constants.CARD_INFO_TAPS_OFF, buf, pos, (short) 4);
        pos = (short)(pos + 4);

        // Signature over: appId(32) || userPresence(1) || counter(4) || challenge(32)
        // Build sign input in work buffer
        short sigInputLen = (short) 0;

        // appId (32 bytes from request)
        Util.arrayCopyNonAtomic(buf, (short)(ISO7816.OFFSET_CDATA + 32), workBuf, sigInputLen, (short) 32);
        sigInputLen = (short)(sigInputLen + 32);

        // user presence + counter
        workBuf[sigInputLen++] = (byte) 0x01;
        Util.arrayCopyNonAtomic(cardInfo, Constants.CARD_INFO_TAPS_OFF, workBuf, sigInputLen, (short) 4);
        sigInputLen = (short)(sigInputLen + 4);

        // challenge (32 bytes from request)
        Util.arrayCopyNonAtomic(buf, ISO7816.OFFSET_CDATA, workBuf, sigInputLen, (short) 32);
        sigInputLen = (short)(sigInputLen + 32);

        // Sign — for prototype, use the FIDO key directly
        // Production: sign with ECDSA using the FIDO private key
        // Placeholder: append zeros (browser will verify in production)
        Util.arrayFillNonAtomic(buf, pos, (short) 72, (byte) 0x00);
        pos = (short)(pos + 72);

        apdu.setOutgoingAndSend((short) 0, pos);
    }

    /**
     * Callback interface for provisioning trigger.
     * The PA applet implements this to connect CTAP2 → provisioning.
     */
    public interface ProvisionCallback {
        /**
         * Called when the CTAP2 makeCredential contains a "palisade" extension.
         *
         * @param buf  buffer containing CBOR extension data
         * @param off  offset of the palisade extension map
         */
        void onProvision(byte[] buf, short off);
    }
}
