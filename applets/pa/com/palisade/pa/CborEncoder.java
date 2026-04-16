/*
 * Project Palisade — Minimal CBOR Encoder/Decoder for CTAP2
 *
 * Handles only the CBOR types needed for WebAuthn/CTAP2:
 *   - Unsigned integers (major type 0)
 *   - Negative integers (major type 1)
 *   - Byte strings (major type 2)
 *   - Text strings (major type 3)
 *   - Maps (major type 5)
 *   - Boolean true/false (major type 7, simple values)
 *
 * All operations work on byte arrays with offsets — zero allocation.
 * JavaCard safe: no int arithmetic, all short.
 */
package com.palisade.pa;

import javacard.framework.Util;

public final class CborEncoder {

    private CborEncoder() {}

    // CBOR major types
    private static final byte MAJOR_UINT   = (byte) 0x00; // 0 << 5
    private static final byte MAJOR_NINT   = (byte) 0x20; // 1 << 5
    private static final byte MAJOR_BSTR   = (byte) 0x40; // 2 << 5
    private static final byte MAJOR_TSTR   = (byte) 0x60; // 3 << 5
    private static final byte MAJOR_MAP    = (byte) 0xA0; // 5 << 5

    private static final byte CBOR_FALSE   = (byte) 0xF4;
    private static final byte CBOR_TRUE    = (byte) 0xF5;

    // -----------------------------------------------------------------------
    // Encoding
    // -----------------------------------------------------------------------

    /** Encode an unsigned integer. Returns bytes written. */
    public static short encodeUint(byte[] buf, short off, short value) {
        return encodeHead(buf, off, MAJOR_UINT, value);
    }

    /** Encode a negative integer (-1 - value). Returns bytes written. */
    public static short encodeNint(byte[] buf, short off, short value) {
        return encodeHead(buf, off, MAJOR_NINT, value);
    }

    /** Encode byte string header (caller writes data after). Returns bytes written for header. */
    public static short encodeBstrHeader(byte[] buf, short off, short len) {
        return encodeHead(buf, off, MAJOR_BSTR, len);
    }

    /** Encode text string header (caller writes data after). Returns bytes written for header. */
    public static short encodeTstrHeader(byte[] buf, short off, short len) {
        return encodeHead(buf, off, MAJOR_TSTR, len);
    }

    /** Encode map header with N entries. Returns bytes written. */
    public static short encodeMapHeader(byte[] buf, short off, short numEntries) {
        return encodeHead(buf, off, MAJOR_MAP, numEntries);
    }

    /** Encode boolean. Returns 1. */
    public static short encodeBool(byte[] buf, short off, boolean val) {
        buf[off] = val ? CBOR_TRUE : CBOR_FALSE;
        return (short) 1;
    }

    /** Encode a complete byte string (header + data). Returns total bytes written. */
    public static short encodeBstr(byte[] buf, short off, byte[] data, short dataOff, short dataLen) {
        short hdrLen = encodeBstrHeader(buf, off, dataLen);
        Util.arrayCopyNonAtomic(data, dataOff, buf, (short)(off + hdrLen), dataLen);
        return (short)(hdrLen + dataLen);
    }

    /** Encode a complete text string (header + data). Returns total bytes written. */
    public static short encodeTstr(byte[] buf, short off, byte[] data, short dataOff, short dataLen) {
        short hdrLen = encodeTstrHeader(buf, off, dataLen);
        Util.arrayCopyNonAtomic(data, dataOff, buf, (short)(off + hdrLen), dataLen);
        return (short)(hdrLen + dataLen);
    }

    // -----------------------------------------------------------------------
    // Decoding
    // -----------------------------------------------------------------------

    /** Get the major type (top 3 bits) of the CBOR item at off. */
    public static byte getMajorType(byte[] buf, short off) {
        return (byte)(buf[off] & (byte) 0xE0);
    }

    /** Get the additional info (low 5 bits) of the CBOR item at off. */
    public static byte getAdditionalInfo(byte[] buf, short off) {
        return (byte)(buf[off] & (byte) 0x1F);
    }

    /**
     * Decode the integer value of a CBOR head at off.
     * Works for uint, nint, bstr len, tstr len, map count, array count.
     * Returns the value as a short.
     */
    public static short decodeHeadValue(byte[] buf, short off) {
        byte ai = getAdditionalInfo(buf, off);
        if (ai < (byte) 24) {
            return (short)(ai & 0x00FF);
        }
        if (ai == (byte) 24) {
            return (short)(buf[(short)(off + 1)] & 0x00FF);
        }
        if (ai == (byte) 25) {
            return Util.makeShort(buf[(short)(off + 1)], buf[(short)(off + 2)]);
        }
        // 4-byte and 8-byte not needed for CTAP2 on JavaCard
        return (short) 0;
    }

    /** Get the number of bytes used by the CBOR head at off. */
    public static short getHeadSize(byte[] buf, short off) {
        byte ai = getAdditionalInfo(buf, off);
        if (ai < (byte) 24) return (short) 1;
        if (ai == (byte) 24) return (short) 2;
        if (ai == (byte) 25) return (short) 3;
        if (ai == (byte) 26) return (short) 5;
        return (short) 9; // ai == 27
    }

    /**
     * Find a key in a CBOR map and return the offset of its value.
     * Only supports integer keys (positive and negative).
     *
     * @param buf     buffer containing CBOR map
     * @param mapOff  offset of the map header byte
     * @param key     integer key to find (positive or negative encoded as CBOR)
     * @return offset of the value, or -1 if not found
     */
    public static short findMapIntKey(byte[] buf, short mapOff, short key) {
        short numEntries = decodeHeadValue(buf, mapOff);
        short pos = (short)(mapOff + getHeadSize(buf, mapOff));

        for (short i = 0; i < numEntries; i++) {
            // Decode key
            short keyVal;
            byte major = getMajorType(buf, pos);
            if (major == MAJOR_UINT) {
                keyVal = decodeHeadValue(buf, pos);
            } else if (major == MAJOR_NINT) {
                // Negative: -1 - n (avoid int promotion from negation)
                short rawVal = decodeHeadValue(buf, pos);
                keyVal = (short)(~rawVal); // ~n == -1 - n, stays as short
            } else {
                // Skip non-integer keys
                keyVal = (short) 0x7FFF; // won't match
            }
            pos = (short)(pos + getHeadSize(buf, pos));

            if (keyVal == key) {
                return pos; // offset of the value
            }

            // Skip value
            pos = skipCborItem(buf, pos);
        }

        return (short) -1;
    }

    /**
     * Skip a complete CBOR item at the given offset.
     * Returns the offset after the item.
     */
    public static short skipCborItem(byte[] buf, short off) {
        byte major = getMajorType(buf, off);
        short headSize = getHeadSize(buf, off);
        short val = decodeHeadValue(buf, off);

        switch (major) {
            case MAJOR_UINT:
            case MAJOR_NINT:
                return (short)(off + headSize);
            case MAJOR_BSTR:
            case MAJOR_TSTR:
                return (short)(off + headSize + val);
            case MAJOR_MAP: {
                short pos = (short)(off + headSize);
                for (short i = 0; i < val; i++) {
                    pos = skipCborItem(buf, pos); // skip key
                    pos = skipCborItem(buf, pos); // skip value
                }
                return pos;
            }
            default:
                // Simple values, booleans, etc.
                return (short)(off + headSize);
        }
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /** Encode a CBOR head (major type + value). Returns bytes written. */
    private static short encodeHead(byte[] buf, short off, byte majorType, short value) {
        if (value < (short) 24) {
            buf[off] = (byte)(majorType | (byte)(value & 0x1F));
            return (short) 1;
        }
        if (value < (short) 256) {
            buf[off] = (byte)(majorType | (byte) 24);
            buf[(short)(off + 1)] = (byte) value;
            return (short) 2;
        }
        buf[off] = (byte)(majorType | (byte) 25);
        Util.setShort(buf, (short)(off + 1), value);
        return (short) 3;
    }
}
