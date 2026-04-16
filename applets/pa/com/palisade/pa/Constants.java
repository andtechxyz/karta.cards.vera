/*
 * Project Palisade — Provisioning Agent Constants
 *
 * CLA/INS bytes, state machine values, buffer sizes, and status words.
 * All values are compile-time constants — no heap allocation.
 */
package com.palisade.pa;

public final class Constants {

    private Constants() {} // Non-instantiable

    // -----------------------------------------------------------------------
    // APDU class and instruction bytes
    // -----------------------------------------------------------------------

    /** Standard ISO 7816 SELECT. */
    public static final byte CLA_ISO = (byte) 0x00;
    public static final byte INS_SELECT = (byte) 0xA4;

    /** Palisade PA proprietary CLA. */
    public static final byte CLA_PROPRIETARY = (byte) 0x80;

    /** GP secure messaging CLA (C-MAC present). */
    public static final byte CLA_GP_SECURE = (byte) 0x84;

    public static final byte INS_GENERATE_KEYS     = (byte) 0xE0;
    public static final byte INS_TRANSFER_SAD       = (byte) 0xE2;
    public static final byte INS_GET_ATTEST_CERT    = (byte) 0xE4;
    public static final byte INS_FINAL_STATUS       = (byte) 0xE6;
    public static final byte INS_CONFIRM            = (byte) 0xE8;
    public static final byte INS_WIPE               = (byte) 0xEA;
    public static final byte INS_GET_PROVENANCE     = (byte) 0xEC;
    public static final byte INS_GET_STATE          = (byte) 0xEE;
    public static final byte INS_GET_CARD_INFO      = (byte) 0xF0;
    public static final byte INS_SET_CARD_INFO      = (byte) 0xF2;

    // -----------------------------------------------------------------------
    // State machine values (NVM, survives power loss)
    // -----------------------------------------------------------------------

    public static final byte STATE_IDLE              = (byte) 0x00;
    public static final byte STATE_KEYGEN_COMPLETE   = (byte) 0x01;
    public static final byte STATE_SAD_RECEIVED      = (byte) 0x02;
    public static final byte STATE_PERSO_IN_PROGRESS = (byte) 0x03;
    public static final byte STATE_COMMITTED         = (byte) 0x04;

    // -----------------------------------------------------------------------
    // Card lifecycle states (EEPROM — visible to bank app via GET_CARD_INFO)
    // -----------------------------------------------------------------------

    public static final byte CARD_BLANK       = (byte) 0x00;
    public static final byte CARD_ACTIVATED   = (byte) 0x01;
    public static final byte CARD_PROVISIONED = (byte) 0x02;
    public static final byte CARD_BLOCKED     = (byte) 0x03;

    // -----------------------------------------------------------------------
    // Card info EEPROM layout (persistent, survives power loss)
    // Offset: field
    //   0: card_state (1 byte)
    //   1: scheme (1 byte) — 0x01=MC, 0x02=Visa, 0x03=Amex
    //   2: bank_id (4 bytes)
    //   6: program_id (4 bytes)
    //  10: provisioned_at (4 bytes, unix epoch seconds)
    //  14: tap_counter (4 bytes, incremented on each GET_CARD_INFO)
    //  18: bank_url_len (1 byte)
    //  19: bank_url (45 bytes max)
    // Total: 64 bytes
    // -----------------------------------------------------------------------

    public static final short CARD_INFO_LEN       = (short) 64;
    public static final short CARD_INFO_STATE_OFF  = (short) 0;
    public static final short CARD_INFO_SCHEME_OFF = (short) 1;
    public static final short CARD_INFO_BANK_OFF   = (short) 2;
    public static final short CARD_INFO_PROG_OFF   = (short) 6;
    public static final short CARD_INFO_TIME_OFF   = (short) 10;
    public static final short CARD_INFO_TAPS_OFF   = (short) 14;
    public static final short CARD_INFO_URL_LEN_OFF = (short) 18;
    public static final short CARD_INFO_URL_OFF    = (short) 19;
    public static final short CARD_INFO_URL_MAX    = (short) 45;

    /** Flag in EEPROM: T4T has been swapped to bank URL. */
    public static final short CARD_INFO_T4T_FLAG_OFF = (short) 63;
    public static final byte T4T_SWAPPED = (byte) 0x01;

    public static final byte SCHEME_MCHIP   = (byte) 0x01;
    public static final byte SCHEME_VSDC    = (byte) 0x02;
    public static final byte SCHEME_AMEX    = (byte) 0x03;

    // -----------------------------------------------------------------------
    // Buffer sizes
    // -----------------------------------------------------------------------

    /** ECC P-256 private key S parameter (32 bytes). */
    public static final short ICC_PRIV_KEY_LEN    = (short) 32;

    /** ECC P-256 uncompressed public key W (04 || X || Y = 65 bytes). */
    public static final short ICC_PUB_KEY_LEN     = (short) 65;

    /** FIDO2 credential private key (32 bytes). */
    public static final short FIDO_PRIV_KEY_LEN   = (short) 32;

    /** FIDO2 credential ID length. */
    public static final short FIDO_CRED_ID_LEN    = (short) 32;

    /** SSD static public key (65 bytes uncompressed). */
    public static final short SSD_PUB_KEY_LEN     = (short) 65;

    /** SAD (Secure Application Data) receive buffer. */
    public static final short SAD_BUFFER_LEN      = (short) 600;

    /** Working buffer for script assembly. */
    public static final short SCRIPT_BUFFER_LEN   = (short) 1024;

    /** Transient work buffer for crypto operations. */
    public static final short WORK_BUFFER_LEN     = (short) 256;

    /** Provenance log: 5 entries x 40 bytes (32 hash + 4 counter + 4 reserved). */
    public static final short PROVENANCE_ENTRY_LEN = (short) 40;
    public static final short PROVENANCE_MAX_ENTRIES = (short) 5;
    public static final short PROVENANCE_LOG_LEN  = (short) 200; // PROVENANCE_ENTRY_LEN(40) * PROVENANCE_MAX_ENTRIES(5)

    /** SCP11c session key length (AES-128). */
    public static final short SESSION_KEY_LEN     = (short) 16;

    /** AES block size. */
    public static final short AES_BLOCK_SIZE      = (short) 16;

    /** C-MAC length (truncated AES-CMAC). */
    public static final short CMAC_LEN            = (short) 8;

    // -----------------------------------------------------------------------
    // SCP11c derivation constants (GP Amendment F, NIST SP 800-108)
    // -----------------------------------------------------------------------

    /** Label for S-ENC derivation. */
    public static final byte[] KDF_LABEL_S_ENC = {
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x00,
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x00,
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x04
    };

    /** Label for S-MAC derivation. */
    public static final byte[] KDF_LABEL_S_MAC = {
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x00,
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x00,
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x06
    };

    /** Label for S-RMAC derivation. */
    public static final byte[] KDF_LABEL_S_RMAC = {
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x00,
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x00,
        (byte) 0x00, (byte) 0x00, (byte) 0x00, (byte) 0x07
    };

    /** Key length marker: 128 bits, big-endian. */
    public static final byte[] KDF_KEY_LEN_128 = {
        (byte) 0x00, (byte) 0x80
    };

    // -----------------------------------------------------------------------
    // GP STORE DATA APDU template
    // -----------------------------------------------------------------------

    public static final byte GP_CLA_STORE_DATA     = (byte) 0x84;
    public static final byte GP_INS_STORE_DATA     = (byte) 0xE2;

    // -----------------------------------------------------------------------
    // Status words
    // -----------------------------------------------------------------------

    public static final short SW_OK                = (short) 0x9000;
    public static final short SW_WRONG_STATE       = (short) 0x6985;
    public static final short SW_AUTH_REQUIRED      = (short) 0x6982;
    public static final short SW_DATA_INVALID       = (short) 0x6984;
    public static final short SW_WRONG_LENGTH       = (short) 0x6700;
    public static final short SW_INS_NOT_SUPPORTED  = (short) 0x6D00;
    public static final short SW_INTERNAL_ERROR     = (short) 0x6F00;

    // -----------------------------------------------------------------------
    // Vendor detection (install parameter byte)
    // -----------------------------------------------------------------------

    public static final byte VENDOR_NXP       = (byte) 0x01;
    public static final byte VENDOR_INFINEON  = (byte) 0x02;

    // -----------------------------------------------------------------------
    // FIDO2 constants
    // -----------------------------------------------------------------------

    /** Authenticator data flags: UP=1, AT=1 → 0x41 + ED flag for attestation → 0x45. */
    public static final byte FIDO_FLAGS_UP_AT = (byte) 0x45;

    /** COSE key type: EC2 = 2. */
    public static final byte COSE_KTY_EC2 = (byte) 0x02;

    /** COSE algorithm: ES256 = -7 (CBOR encoding: 0x26). */
    public static final byte COSE_ALG_ES256 = (byte) 0x26;

    /** COSE curve: P-256 = 1. */
    public static final byte COSE_CRV_P256 = (byte) 0x01;
}
