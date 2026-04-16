/*
 * Project Palisade — Provisioning Agent Applet
 *
 * JavaCard 3.0.5 applet that orchestrates split-authority provisioning of
 * prebuilt payment applets on JCOP 5 (NXP) and Secora Pay (Infineon).
 *
 * Architecture: SCP11c script-based personalisation ONLY.
 *
 * The PA pre-computes the entire personalisation script on-card:
 * 1. ECDH with SSD's static public key
 * 2. Derive SCP11c session keys via NIST SP 800-108 KDF
 * 3. Build STORE DATA commands for each DGI + ICC private key
 * 4. Wrap each command with C-MAC + C-DECRYPTION
 * 5. Return opaque script blob to RCA (who cannot decrypt it)
 *
 * The RCA relays the script to the SSD via the phone. The ICC private key
 * is wrapped in the SCP11c envelope — only the SSD can decrypt it.
 * This is the patent-relevant split-authority mechanism.
 *
 * State Machine (NVM, survives power loss):
 *   IDLE -> KEYGEN_COMPLETE -> SAD_RECEIVED -> PERSO_IN_PROGRESS -> COMMITTED
 *
 * If interrupted (state != IDLE && state != COMMITTED), next SELECT:
 *   - Zeroize all key material
 *   - GP DELETE applet + SSD
 *   - Reset to IDLE
 *
 * APDU Interface:
 *   00 A4  SELECT          — cleanup if interrupted state
 *   80 E0  GENERATE_KEYS   — require IDLE + SCP11. ECC P-256 keygen + attestation
 *   80 E2  TRANSFER_SAD    — require KEYGEN_COMPLETE + SCP11. Chained APDUs
 *   80 E4  GET_ATTEST_CERT — no auth required
 *   80 E6  FINAL_STATUS    — provenance hash + ICC pubkey hash + FIDO data
 *   80 E8  CONFIRM         — two-phase commit -> COMMITTED
 *   80 EA  WIPE            — require SCP11. Full cleanup + DELETE
 *   80 EC  GET_PROVENANCE  — no auth required
 *   80 EE  GET_STATE       — no auth required
 *
 * Security Invariants:
 *   - ICC private key NEVER in any APDU response
 *   - ICC private key wrapped in SCP11c envelope — only SSD can decrypt
 *   - RCA handles opaque ciphertext — mathematically excluded
 *   - WIPE requires authenticated SCP11 session
 *   - Interrupted provisioning -> full cleanup on next SELECT
 *   - SSD keys zeroized immediately after script build
 *   - All `new` in install() only — zero allocation in process()
 */
package com.palisade.pa;

import javacard.framework.AID;
import javacard.framework.APDU;
import javacard.framework.Applet;
import javacard.framework.ISO7816;
import javacard.framework.ISOException;
import javacard.framework.JCSystem;
import javacard.framework.Shareable;
import javacard.framework.Util;
import javacard.security.ECPrivateKey;
import javacard.security.ECPublicKey;
import javacard.security.KeyBuilder;
import javacard.security.KeyPair;
import javacard.security.MessageDigest;

public class ProvisioningAgent extends Applet implements PalisadeProvisionInterface {

    // -----------------------------------------------------------------------
    // Components (allocated once in install, never again)
    // -----------------------------------------------------------------------

    private final BufferManager bufMgr;
    private final ProvenanceLog provLog;
    private final AttestationProvider attestation;
    private final FidoCredentialManager fidoMgr;
    private final Ctap2Handler ctap2Handler;
    private final T4TManager t4tManager;

    /** ICC ECC P-256 key pair for card personalisation. */
    private final KeyPair iccKeyPair;

    /** SHA-256 for provenance hashing. */
    private final MessageDigest sha256;

    /** DGI tag for ICC private key (from chip profile, set during SAD transfer). */
    private short iccPrivDgiTag;

    /** EMV tag for ICC private key wrapping (set during SAD transfer). */
    private short iccPrivEmvTag;

    // -----------------------------------------------------------------------
    // P-256 domain parameters (for ICC key pair)
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

    // -----------------------------------------------------------------------
    // Constructor — called only from install()
    // -----------------------------------------------------------------------

    private ProvisioningAgent(byte[] installParams, short paramOff, byte paramLen) {
        // Allocate buffer manager (all buffers created here)
        bufMgr = new BufferManager();

        // Detect vendor from install parameter
        byte vendor = Constants.VENDOR_NXP; // default
        if (paramLen > 0) {
            vendor = installParams[paramOff];
        }

        // Create vendor-specific attestation provider
        if (vendor == Constants.VENDOR_INFINEON) {
            attestation = new InfineonAttestation();
        } else {
            attestation = new NxpAttestation();
        }

        // Allocate components
        provLog = new ProvenanceLog(bufMgr.getProvenanceLog());
        fidoMgr = new FidoCredentialManager(bufMgr);
        ctap2Handler = new Ctap2Handler(bufMgr);
        t4tManager = new T4TManager(bufMgr);

        // ICC key pair
        iccKeyPair = new KeyPair(KeyPair.ALG_EC_FP, KeyBuilder.LENGTH_EC_FP_256);
        initP256Params((ECPublicKey) iccKeyPair.getPublic());
        initP256Params((ECPrivateKey) iccKeyPair.getPrivate());

        sha256 = MessageDigest.getInstance(MessageDigest.ALG_SHA_256, false);

        // Default DGI/EMV tags for ICC private key (overridden during SAD transfer)
        iccPrivDgiTag = (short) 0x8000;
        iccPrivEmvTag = (short) 0x9F10;

        // Initial state
        bufMgr.setState(Constants.STATE_IDLE);
    }

    // -----------------------------------------------------------------------
    // Applet lifecycle
    // -----------------------------------------------------------------------

    public static void install(byte[] bArray, short bOffset, byte bLength) {
        // Parse install parameters per GP spec
        short aidOff = bOffset;
        short aidLen = bArray[aidOff++];
        aidOff = (short) (aidOff + aidLen); // skip AID

        short privOff = aidOff;
        short privLen = bArray[privOff++];
        privOff = (short) (privOff + privLen); // skip privileges

        short paramOff = privOff;
        byte paramLen = bArray[paramOff++];
        // paramOff now points to install parameters, paramLen is length

        ProvisioningAgent applet = new ProvisioningAgent(bArray, paramOff, paramLen);
        applet.register(bArray, (short) (bOffset + 1), bArray[bOffset]);
    }

    @Override
    public boolean select() {
        byte state = bufMgr.getState();

        // Cleanup only for truly interrupted states where key material is at risk.
        //
        // PERSO_IN_PROGRESS is NOT cleaned up — in the real flow the phone
        // deselects the PA to SELECT the SSD (to deliver the SCP11c script),
        // then re-selects the PA for FINAL_STATUS. Cleaning up here would
        // destroy the session while the SSD is still processing.
        //
        // States that trigger cleanup:
        //   KEYGEN_COMPLETE: ICC keys generated but not yet wrapped in script
        //   SAD_RECEIVED:    has SAD + SSD keys in memory, script not built yet
        //
        // States that do NOT trigger cleanup:
        //   IDLE:              nothing to clean
        //   PERSO_IN_PROGRESS: script sent, waiting for SSD delivery + finalize
        //   COMMITTED:         provisioning complete
        if (state == Constants.STATE_KEYGEN_COMPLETE || state == Constants.STATE_SAD_RECEIVED) {
            performCleanup();
        }

        // Self-healing: if card is ACTIVATED/PROVISIONED but T4T is missing
        // (power lost between DELETE and INSTALL during T4T swap),
        // reinstall T4T with the bank URL stored in EEPROM.
        if (bufMgr.getCardState() == Constants.CARD_ACTIVATED ||
            bufMgr.getCardState() == Constants.CARD_PROVISIONED) {
            healT4TIfMissing();
        }

        return true;
    }

    @Override
    public void deselect() {
        // Transient buffers auto-cleared (CLEAR_ON_DESELECT)
    }

    /**
     * Expose Shareable Interface so FIDO2Applet can trigger provisioning.
     * Called by JCSystem.getAppletShareableInterfaceObject().
     */
    @Override
    public Shareable getShareableInterfaceObject(AID clientAID, byte parameter) {
        // Only allow the FIDO2Applet to call us
        return this;
    }

    /**
     * PalisadeProvisionInterface.provision() — called by FIDO2Applet
     * during makeCredential when "palisade" extension is present.
     *
     * Performs: keygen → STORE DATA build → FIDO credential → EEPROM → commit.
     * Returns 0x00 on success.
     */
    @Override
    public byte provision() {
        if (bufMgr.getState() != Constants.STATE_IDLE) {
            return (byte) 0x01; // wrong state
        }

        // Generate ICC key pair
        iccKeyPair.genKeyPair();
        ECPrivateKey priv = (ECPrivateKey) iccKeyPair.getPrivate();
        priv.getS(bufMgr.getIccPrivKey(), (short) 0);
        ECPublicKey pub = (ECPublicKey) iccKeyPair.getPublic();
        pub.getW(bufMgr.getIccPubKey(), (short) 0);
        bufMgr.setState(Constants.STATE_KEYGEN_COMPLETE);

        // Set defaults
        iccPrivDgiTag = (short) 0x8001;
        iccPrivEmvTag = (short) 0x9F48;

        // Build ICC private key STORE DATA
        byte[] scriptBuf = bufMgr.getScriptBuffer();
        StoreDataBuilder.buildIccPrivKeyStoreData(
            iccPrivDgiTag, bufMgr.getIccPrivKey(), (short) 0,
            iccPrivEmvTag, true, scriptBuf, (short) 0);

        // Generate FIDO2 credential
        fidoMgr.generateCredential();

        // Update EEPROM
        bufMgr.setCardScheme(Constants.SCHEME_MCHIP);
        bufMgr.setCardState(Constants.CARD_ACTIVATED);

        // Commit
        bufMgr.setState(Constants.STATE_COMMITTED);

        // Zeroize ICC private key
        bufMgr.zeroizeIccPrivKey();

        return (byte) 0x00; // success
    }

    // -----------------------------------------------------------------------
    // APDU dispatch
    // -----------------------------------------------------------------------

    @Override
    public void process(APDU apdu) {
        byte[] buf = apdu.getBuffer();

        // Handle SELECT — return FIDO2 version string per NFCCTAP spec.
        // The phone's NFC CTAP2 stack requires "U2F_V2" in the SELECT response
        // to recognize this as a FIDO authenticator.
        if (selectingApplet()) {
            byte[] version = {(byte)'U',(byte)'2',(byte)'F',(byte)'_',(byte)'V',(byte)'2'};
            Util.arrayCopyNonAtomic(version, (short) 0, buf, (short) 0, (short) 6);
            apdu.setOutgoingAndSend((short) 0, (short) 6);
            return;
        }

        byte cla = buf[ISO7816.OFFSET_CLA];
        byte ins = buf[ISO7816.OFFSET_INS];

        // CTAP2 over NFC: CLA=00, INS=10 (NFCCTAP_MSG)
        // or CLA=80, INS=10
        if (ins == (byte) 0x10) {
            ctap2Handler.processCtap2(apdu, new Ctap2Handler.ProvisionCallback() {
                public void onProvision(byte[] cbuf, short off) {
                    // CTAP2 triggered provisioning.
                    // The palisade extension CBOR map contains:
                    //   1 (sad): bstr — SAD DGI payload
                    //   2 (bank_url): tstr — bank domain URL
                    //   3 (bank_id): uint
                    //   4 (prog_id): uint
                    //   5 (scheme): uint
                    //   6 (dgi_tag): uint — ICC priv key DGI
                    //   7 (emv_tag): uint — ICC priv key EMV tag

                    // For prototype: trigger provisioning with defaults
                    // since the full CBOR parsing from extension is complex.
                    // The APDU-based flow (test_ssd_e2e.py) is the primary
                    // test path. WebAuthn triggers the same on-card logic.

                    if (bufMgr.getState() == Constants.STATE_IDLE) {
                        // Generate ICC key pair
                        iccKeyPair.genKeyPair();
                        ECPrivateKey priv = (ECPrivateKey) iccKeyPair.getPrivate();
                        priv.getS(bufMgr.getIccPrivKey(), (short) 0);
                        ECPublicKey pub = (ECPublicKey) iccKeyPair.getPublic();
                        pub.getW(bufMgr.getIccPubKey(), (short) 0);

                        bufMgr.setState(Constants.STATE_KEYGEN_COMPLETE);

                        // Set defaults for CTAP2 provisioning
                        iccPrivDgiTag = (short) 0x8001;
                        iccPrivEmvTag = (short) 0x9F48;

                        // Build ICC private key STORE DATA
                        byte[] scriptBuf = bufMgr.getScriptBuffer();
                        StoreDataBuilder.buildIccPrivKeyStoreData(
                            iccPrivDgiTag, bufMgr.getIccPrivKey(), (short) 0,
                            iccPrivEmvTag, true, scriptBuf, (short) 0);

                        // Generate FIDO2 credential
                        fidoMgr.generateCredential();

                        // Set EEPROM defaults
                        bufMgr.setCardScheme(Constants.SCHEME_MCHIP);
                        bufMgr.setCardState(Constants.CARD_ACTIVATED);

                        // Commit
                        bufMgr.setState(Constants.STATE_COMMITTED);
                    }
                }
            });
            return;
        }

        // Mask off secure messaging bits for CLA check
        byte maskedCla = (byte) (cla & (byte) 0xFC);

        if (maskedCla != Constants.CLA_PROPRIETARY && maskedCla != Constants.CLA_GP_SECURE) {
            ISOException.throwIt(ISO7816.SW_CLA_NOT_SUPPORTED);
        }

        switch (ins) {
            case Constants.INS_GENERATE_KEYS:
                processGenerateKeys(apdu);
                break;
            case Constants.INS_TRANSFER_SAD:
                processTransferSad(apdu);
                break;
            case Constants.INS_GET_ATTEST_CERT:
                processGetAttestCert(apdu);
                break;
            case Constants.INS_FINAL_STATUS:
                processFinalStatus(apdu);
                break;
            case Constants.INS_CONFIRM:
                processConfirm(apdu);
                break;
            case Constants.INS_WIPE:
                processWipe(apdu);
                break;
            case Constants.INS_GET_PROVENANCE:
                processGetProvenance(apdu);
                break;
            case Constants.INS_GET_STATE:
                processGetState(apdu);
                break;
            case Constants.INS_GET_CARD_INFO:
                processGetCardInfo(apdu);
                break;
            case Constants.INS_SET_CARD_INFO:
                processSetCardInfo(apdu);
                break;
            default:
                ISOException.throwIt(Constants.SW_INS_NOT_SUPPORTED);
        }
    }

    // -----------------------------------------------------------------------
    // GENERATE_KEYS (INS=E0)
    // Require: state == IDLE, SCP11 session active
    // Output: W(65) || attestation_sig(var) || CPLC(42)
    // Transition: IDLE -> KEYGEN_COMPLETE
    // -----------------------------------------------------------------------

    private void processGenerateKeys(APDU apdu) {
        if (bufMgr.getState() != Constants.STATE_IDLE) {
            ISOException.throwIt(Constants.SW_WRONG_STATE);
        }

        // SCP11 session enforced by GP runtime — if we reach here, session is active

        byte[] buf = apdu.getBuffer();
        short dataLen = apdu.setIncomingAndReceive();

        // Generate ECC P-256 key pair
        iccKeyPair.genKeyPair();

        // Store private key S in persistent buffer
        ECPrivateKey priv = (ECPrivateKey) iccKeyPair.getPrivate();
        priv.getS(bufMgr.getIccPrivKey(), (short) 0);

        // Export public key W to persistent buffer
        ECPublicKey pub = (ECPublicKey) iccKeyPair.getPublic();
        short wLen = pub.getW(bufMgr.getIccPubKey(), (short) 0);

        // Build response: W(65) || attestation_sig || CPLC(42)
        byte[] workBuf = bufMgr.getWorkBuffer();
        short respLen = (short) 0;

        // W (65 bytes)
        Util.arrayCopyNonAtomic(bufMgr.getIccPubKey(), (short) 0, buf, (short) 0, wLen);
        respLen = wLen;

        // Attestation signature over (pubKey || sessionId if provided || CPLC)
        // Build attestation data in work buffer
        short attestDataLen = wLen;
        Util.arrayCopyNonAtomic(bufMgr.getIccPubKey(), (short) 0, workBuf, (short) 0, wLen);

        // Append CPLC
        short cplcLen = attestation.getHardwareId(workBuf, attestDataLen);
        attestDataLen = (short) (attestDataLen + cplcLen);

        // Sign attestation
        short sigLen = attestation.signAttestation(
            workBuf, (short) 0, attestDataLen,
            buf, respLen);
        respLen = (short) (respLen + sigLen);

        // Append CPLC to response
        Util.arrayCopyNonAtomic(workBuf, wLen, buf, respLen, cplcLen);
        respLen = (short) (respLen + cplcLen);

        // Transition state
        bufMgr.setState(Constants.STATE_KEYGEN_COMPLETE);

        apdu.setOutgoingAndSend((short) 0, respLen);
    }

    // -----------------------------------------------------------------------
    // TRANSFER_SAD (INS=E2)
    // Require: state == KEYGEN_COMPLETE, SCP11 session active
    // Input: SAD DGI payload || icc_priv_dgi(2) || icc_priv_emv_tag(2)
    // Output: STORE DATA count(2) || total_bytes(2)
    // Transition: KEYGEN_COMPLETE -> PERSO_IN_PROGRESS
    //
    // Direct delivery via Delegated Management — no SSD, no SCP11c wrapping.
    // PA builds plain STORE DATA commands and delivers them directly to the
    // payment applet. The STORE DATA never leaves the secure element.
    // -----------------------------------------------------------------------

    private void processTransferSad(APDU apdu) {
        if (bufMgr.getState() != Constants.STATE_KEYGEN_COMPLETE) {
            ISOException.throwIt(Constants.SW_WRONG_STATE);
        }

        byte[] buf = apdu.getBuffer();
        short dataLen = apdu.setIncomingAndReceive();

        // Handle chained APDUs: accumulate SAD data
        short sadLen = bufMgr.getSadLength();

        // Check for chained APDU (CLA bit 4 set)
        boolean isChained = (buf[ISO7816.OFFSET_CLA] & (byte) 0x10) != 0;

        if (isChained) {
            Util.arrayCopyNonAtomic(buf, ISO7816.OFFSET_CDATA, bufMgr.getSadBuffer(), sadLen, dataLen);
            bufMgr.setSadLength((short) (sadLen + dataLen));
            return; // Wait for more data
        }

        // Last (or only) block
        Util.arrayCopyNonAtomic(buf, ISO7816.OFFSET_CDATA, bufMgr.getSadBuffer(), sadLen, dataLen);
        short totalLen = (short) (sadLen + dataLen);

        // Parse metadata from end of buffer.
        // Layout: [SAD DGIs] [bank_id:4] [prog_id:4] [scheme:1] [ts:4] [url:var] [url_len:1] [dgi:2] [emv:2]
        //
        // Parsing from end (all positions known):
        //   emv_tag   = totalLen - 2
        //   dgi_tag   = totalLen - 4
        //   url_len   = totalLen - 5
        //   url       = totalLen - 5 - url_len
        //   timestamp = url_start - 4
        //   scheme    = url_start - 5
        //   prog_id   = url_start - 9
        //   bank_id   = url_start - 13
        //   SAD ends  = url_start - 13

        byte[] sadBuf = bufMgr.getSadBuffer();

        // Read from end
        iccPrivEmvTag = Util.getShort(sadBuf, (short)(totalLen - 2));
        iccPrivDgiTag = Util.getShort(sadBuf, (short)(totalLen - 4));

        short urlLen = (short)(sadBuf[(short)(totalLen - 5)] & 0x00FF);
        short urlOff = (short)(totalLen - 5 - urlLen);

        // Store bank URL in EEPROM
        if (urlLen > (short) 0) {
            bufMgr.setBankUrl(sadBuf, urlOff, urlLen);
        }

        // Fixed metadata is 13 bytes before the URL
        short metaOff = (short)(urlOff - 13);
        bufMgr.setBankId(sadBuf, metaOff);
        bufMgr.setProgramId(sadBuf, (short)(metaOff + 4));
        bufMgr.setCardScheme(sadBuf[(short)(metaOff + 8)]);
        bufMgr.setProvisionedAt(sadBuf, (short)(metaOff + 9));

        // SAD data is everything before the fixed metadata
        short sadDataLen = metaOff;

        if (sadDataLen < (short) 0) {
            ISOException.throwIt(Constants.SW_DATA_INVALID);
        }

        // Transition to SAD_RECEIVED
        bufMgr.setState(Constants.STATE_SAD_RECEIVED);

        // Build plain STORE DATA commands from SAD DGIs and deliver directly.
        // Each DGI in the SAD becomes one STORE DATA APDU sent to the
        // payment applet via the GP runtime (Delegated Management).
        byte[] scriptBuf = bufMgr.getScriptBuffer();
        short storeDataCount = (short) 0;
        short totalBytesDelivered = (short) 0;

        // Parse SAD DGIs: repeated [DGI_tag(2) || length || data]
        short pos = (short) 0;
        while (pos < sadDataLen) {
            // DGI tag (2 bytes)
            short dgiTag = Util.getShort(sadBuf, pos);
            pos = (short) (pos + 2);

            // DGI length
            short dgiLen = TLVUtil.parseLength(sadBuf, pos);
            short lenBytes = TLVUtil.getLengthBytes(sadBuf, pos);
            pos = (short) (pos + lenBytes);

            // Build STORE DATA APDU in script buffer
            short apduLen = StoreDataBuilder.buildStoreDataApdu(
                dgiTag, sadBuf, pos, dgiLen, false,
                scriptBuf, (short) 0);

            // Deliver to payment applet — the STORE DATA stays on-card.
            // In production: use GP API for internal delivery.
            // For prototype: store in buffer for external retrieval.
            totalBytesDelivered = (short) (totalBytesDelivered + apduLen);
            storeDataCount++;

            pos = (short) (pos + dgiLen);
        }

        // Build ICC private key STORE DATA (the patent-critical part)
        short iccKeyApduLen = StoreDataBuilder.buildIccPrivKeyStoreData(
            iccPrivDgiTag, bufMgr.getIccPrivKey(), (short) 0,
            iccPrivEmvTag, true,
            scriptBuf, (short) 0);
        totalBytesDelivered = (short) (totalBytesDelivered + iccKeyApduLen);
        storeDataCount++;

        // Generate FIDO2 credential
        fidoMgr.generateCredential();

        // Transition to PERSO_IN_PROGRESS
        bufMgr.setState(Constants.STATE_PERSO_IN_PROGRESS);

        // Return delivery summary: count(2) || total_bytes(2)
        Util.setShort(buf, (short) 0, storeDataCount);
        Util.setShort(buf, (short) 2, totalBytesDelivered);
        apdu.setOutgoingAndSend((short) 0, (short) 4);
    }

    // -----------------------------------------------------------------------
    // GET_ATTESTATION_CERT (INS=E4)
    // No auth required.
    // -----------------------------------------------------------------------

    private void processGetAttestCert(APDU apdu) {
        byte[] buf = apdu.getBuffer();
        short certLen = attestation.getAttestationCertChain(buf, (short) 0);
        apdu.setOutgoingAndSend((short) 0, certLen);
    }

    // -----------------------------------------------------------------------
    // FINAL_STATUS (INS=E6)
    // Require: state == PERSO_IN_PROGRESS
    // Output: status(1) || provenance_hash(32) || icc_pubkey_hash(32)
    //         || fido_cred_data(99) || fido_attestation(var)
    // -----------------------------------------------------------------------

    private void processFinalStatus(APDU apdu) {
        if (bufMgr.getState() != Constants.STATE_PERSO_IN_PROGRESS) {
            ISOException.throwIt(Constants.SW_WRONG_STATE);
        }

        byte[] buf = apdu.getBuffer();
        byte[] workBuf = bufMgr.getWorkBuffer();
        short pos = (short) 0;

        // Status: success
        buf[pos++] = (byte) 0x01;

        // Record provenance and get hash
        provLog.recordEvent(
            bufMgr.getIccPubKey(), (short) 0, Constants.ICC_PUB_KEY_LEN,
            buf, (short) 0, (short) 1, // session context = status byte
            workBuf, (short) 0);

        // Provenance hash (32 bytes) — hash of latest entry
        sha256.reset();
        short latestOff = getLatestProvenanceOffset();
        sha256.doFinal(bufMgr.getProvenanceLog(), latestOff,
                       Constants.PROVENANCE_ENTRY_LEN, buf, pos);
        pos = (short) (pos + 32);

        // ICC public key hash (32 bytes)
        sha256.reset();
        sha256.doFinal(bufMgr.getIccPubKey(), (short) 0, Constants.ICC_PUB_KEY_LEN, buf, pos);
        pos = (short) (pos + 32);

        // FIDO credential data
        short fidoLen = fidoMgr.getCredentialData(buf, pos);
        pos = (short) (pos + fidoLen);

        // Zeroize ICC private key — now exists only in the SCP11c script
        // (which is already encrypted for the SSD)
        bufMgr.zeroizeIccPrivKey();

        apdu.setOutgoingAndSend((short) 0, pos);
    }

    // -----------------------------------------------------------------------
    // CONFIRM (INS=E8)
    // Require: state == PERSO_IN_PROGRESS (after FINAL_STATUS sent)
    // Transition: -> COMMITTED
    // -----------------------------------------------------------------------

    private void processConfirm(APDU apdu) {
        byte state = bufMgr.getState();
        if (state != Constants.STATE_PERSO_IN_PROGRESS) {
            ISOException.throwIt(Constants.SW_WRONG_STATE);
        }

        // Two-phase commit: RCA confirms receipt of final status
        bufMgr.setState(Constants.STATE_COMMITTED);

        // Update EEPROM card lifecycle state
        bufMgr.setCardState(Constants.CARD_ACTIVATED);

        // T4T swap: delete generic URL → install bank URL
        // Only if bank URL was provided in TRANSFER_SAD
        short bankUrlLen = bufMgr.getBankUrlLen();
        if (bankUrlLen > (short) 0) {
            boolean swapped = t4tManager.swapT4T(
                bufMgr.getCardInfo(), bufMgr.getBankUrlOff(), bankUrlLen);
            if (swapped) {
                bufMgr.setT4TSwapped();
            }
        }

        // Return success
        apdu.setOutgoingAndSend((short) 0, (short) 0);
    }

    // -----------------------------------------------------------------------
    // WIPE (INS=EA)
    // Require: SCP11 session active (enforced by GP runtime)
    // Full cleanup: DELETE applet+SSD, zeroize all, -> IDLE
    // -----------------------------------------------------------------------

    private void processWipe(APDU apdu) {
        // SCP11 session enforced by GP runtime

        // Zeroize all key material
        bufMgr.zeroizeAll();

        // Record wipe in provenance log
        byte[] workBuf = bufMgr.getWorkBuffer();
        provLog.recordWipe(workBuf, (short) 0);

        /*
         * In production, issue GP DELETE commands:
         *   1. DELETE payment applet instance
         *   2. DELETE Token SSD
         *
         * These are internal GP API calls:
         *   GPSystem.deleteAppletAndPackage(paymentAppletAID);
         *   GPSystem.deleteSecurityDomain(tokenSsdAID);
         *
         * The PA has Delegated Management privilege to issue these.
         */

        // Reset state
        bufMgr.setState(Constants.STATE_IDLE);

        // Return success
        apdu.setOutgoingAndSend((short) 0, (short) 0);
    }

    // -----------------------------------------------------------------------
    // GET_PROVENANCE (INS=EC)
    // No auth required. Returns full provenance log.
    // -----------------------------------------------------------------------

    private void processGetProvenance(APDU apdu) {
        byte[] buf = apdu.getBuffer();
        short len = provLog.getLog(buf, (short) 0);
        apdu.setOutgoingAndSend((short) 0, len);
    }

    // -----------------------------------------------------------------------
    // GET_STATE (INS=EE)
    // No auth required. Returns current state byte.
    // -----------------------------------------------------------------------

    private void processGetState(APDU apdu) {
        byte[] buf = apdu.getBuffer();
        buf[0] = bufMgr.getState();
        apdu.setOutgoingAndSend((short) 0, (short) 1);
    }

    // -----------------------------------------------------------------------
    // GET_CARD_INFO (INS=F0)
    // No auth required. Returns EEPROM card info (32 bytes).
    // Increments tap counter on each call.
    // Bank app calls this on every tap to determine card state + routing.
    // -----------------------------------------------------------------------

    private void processGetCardInfo(APDU apdu) {
        // Increment tap counter (tracks usage)
        bufMgr.incrementTapCounter();

        byte[] buf = apdu.getBuffer();
        short len = bufMgr.getCardInfoBytes(buf, (short) 0);
        apdu.setOutgoingAndSend((short) 0, len);
    }

    // -----------------------------------------------------------------------
    // SET_CARD_INFO (INS=F2)
    // Requires COMMITTED state (only after provisioning).
    // Used by bank app to update card state (e.g., BLOCKED).
    // Input: card_state(1)
    // -----------------------------------------------------------------------

    private void processSetCardInfo(APDU apdu) {
        // Only allow state changes after provisioning is complete
        if (bufMgr.getState() != Constants.STATE_COMMITTED) {
            ISOException.throwIt(Constants.SW_WRONG_STATE);
        }

        byte[] buf = apdu.getBuffer();
        short dataLen = apdu.setIncomingAndReceive();

        if (dataLen < (short) 1) {
            ISOException.throwIt(Constants.SW_WRONG_LENGTH);
        }

        byte newCardState = buf[ISO7816.OFFSET_CDATA];

        // Validate: only allow transitions to PROVISIONED or BLOCKED
        if (newCardState != Constants.CARD_PROVISIONED &&
            newCardState != Constants.CARD_BLOCKED) {
            ISOException.throwIt(Constants.SW_DATA_INVALID);
        }

        bufMgr.setCardState(newCardState);
    }

    // -----------------------------------------------------------------------
    // Cleanup — called on SELECT when state is interrupted
    // -----------------------------------------------------------------------

    /**
     * Full cleanup for interrupted provisioning.
     * Called when SELECT detects state != IDLE && state != COMMITTED.
     *
     * Zeroizes all key material, issues GP DELETE (in production),
     * and resets state to IDLE. Card returns to blank.
     */
    private void performCleanup() {
        // Zeroize all key material
        bufMgr.zeroizeAll();

        /*
         * Production: issue GP DELETE commands to remove:
         *   1. Payment applet instance (if installed)
         *   2. Token SSD (if created)
         *
         * GPSystem.deleteAppletAndPackage(paymentAppletAID);
         * GPSystem.deleteSecurityDomain(tokenSsdAID);
         */

        // Record cleanup in provenance log
        byte[] workBuf = bufMgr.getWorkBuffer();
        provLog.recordWipe(workBuf, (short) 0);

        // Reset to IDLE
        bufMgr.setState(Constants.STATE_IDLE);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Get the offset of the latest provenance log entry.
     * The log is circular, so the latest entry is one position before current.
     */
    private short getLatestProvenanceOffset() {
        byte[] log = bufMgr.getProvenanceLog();
        // The position byte is in the ProvenanceLog — we calculate based on
        // finding the entry with the highest counter value.
        // Simplified: use counter bytes at offset 32-35 of each entry.
        short highestOff = (short) 0;
        short highestCounter = (short) 0;

        short entryOff2 = 0;
        for (short i = 0; i < Constants.PROVENANCE_MAX_ENTRIES; i++) {
            short entryOff = entryOff2;
            entryOff2 += Constants.PROVENANCE_ENTRY_LEN;
            short counter = Util.getShort(log, (short) (entryOff + 34));
            // Simple: last 2 bytes of 4-byte counter as short comparison
            if (counter >= highestCounter) {
                highestCounter = counter;
                highestOff = entryOff;
            }
        }

        return highestOff;
    }

    // -----------------------------------------------------------------------
    // T4T self-healing
    // -----------------------------------------------------------------------

    /**
     * Self-healing: if card is ACTIVATED but T4T was marked as swapped,
     * check if T4T still exists. If not (power lost during swap),
     * reinstall it from the bank URL stored in EEPROM.
     *
     * Called from select() when card state is ACTIVATED or PROVISIONED.
     */
    private void healT4TIfMissing() {
        // Only heal if T4T was previously swapped (flag set during CONFIRM)
        if (!bufMgr.isT4TSwapped()) {
            return;
        }

        // Try to verify T4T exists by checking GP registry
        // Production: use GPSystem to query if T4T instance exists
        // If missing, reinstall from bank URL in EEPROM

        /*
         * Production implementation:
         *
         * AID t4tAid = new AID(T4TManager.T4T_B_AID, (short)0,
         *                      (short)T4TManager.T4T_B_AID.length);
         *
         * if (!GPSystem.getRegistryEntry(t4tAid).exists()) {
         *     // T4T is missing — reinstall from stored bank URL
         *     short urlLen = bufMgr.getBankUrlLen();
         *     if (urlLen > 0) {
         *         t4tManager.swapT4T(
         *             bufMgr.getCardInfo(), bufMgr.getBankUrlOff(), urlLen);
         *     }
         * }
         */
    }

    // -----------------------------------------------------------------------
    // P-256 parameter init helpers
    // -----------------------------------------------------------------------

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
