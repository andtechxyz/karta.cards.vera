/*
 * Project Palisade — Minimal On-Card TLV Parser
 *
 * Operates entirely on byte arrays with offsets — zero dynamic allocation.
 * Handles BER-TLV tag parsing (1-3 byte tags) and length decoding.
 */
package com.palisade.pa;

import javacard.framework.ISOException;
import javacard.framework.Util;

public final class TLVUtil {

    private TLVUtil() {} // Non-instantiable

    /**
     * Find a tag within a TLV structure and return the offset of its value.
     *
     * @param buf    buffer containing TLV data
     * @param off    offset into buffer where TLV data starts
     * @param len    length of TLV data
     * @param tag    tag to search for (1-3 bytes, right-aligned in short)
     * @return offset of the value field, or -1 if not found
     */
    public static short findTag(byte[] buf, short off, short len, short tag) {
        short end = (short) (off + len);
        short pos = off;

        while (pos < end) {
            // Skip padding bytes (0x00)
            if (buf[pos] == (byte) 0x00) {
                pos++;
                continue;
            }

            // Parse tag
            short currentTag = parseTag(buf, pos);
            short tagLen = getTagLength(buf, pos);
            pos = (short) (pos + tagLen);

            // Parse length
            short valLen = parseLength(buf, pos);
            short lenBytes = getLengthBytes(buf, pos);
            pos = (short) (pos + lenBytes);

            if (currentTag == tag) {
                return pos; // offset of value
            }

            // Skip value
            pos = (short) (pos + valLen);
        }

        return (short) -1;
    }

    /**
     * Parse the tag at the given position.
     *
     * @return tag value (1-2 bytes, right-aligned in short)
     */
    public static short parseTag(byte[] buf, short off) {
        byte first = buf[off];

        // Single-byte tag: low 5 bits are NOT all 1s
        if ((first & (byte) 0x1F) != (byte) 0x1F) {
            return (short) (first & 0x00FF);
        }

        // Two-byte tag — use Util.makeShort to avoid int promotion
        byte second = buf[(short) (off + 1)];
        return Util.makeShort(first, second);
    }

    /**
     * Get the number of bytes used by the tag at the given position.
     */
    public static short getTagLength(byte[] buf, short off) {
        byte first = buf[off];
        if ((first & (byte) 0x1F) != (byte) 0x1F) {
            return (short) 1;
        }
        // Multi-byte tag — second byte present
        // For JavaCard applets, 2-byte tags are sufficient
        return (short) 2;
    }

    /**
     * Parse the BER-TLV length at the given position.
     *
     * @return the length value
     */
    public static short parseLength(byte[] buf, short off) {
        short first = (short) (buf[off] & 0x00FF);

        if (first < (short) 0x80) {
            // Short form: single byte
            return first;
        }

        if (first == (short) 0x81) {
            // Long form: 1 subsequent byte
            return (short) (buf[(short) (off + 1)] & 0x00FF);
        }

        if (first == (short) 0x82) {
            // Long form: 2 subsequent bytes — use Util.makeShort to avoid int promotion
            return Util.makeShort(buf[(short) (off + 1)], buf[(short) (off + 2)]);
        }

        // Lengths > 65535 not supported on JavaCard
        ISOException.throwIt(Constants.SW_DATA_INVALID);
        return (short) 0; // unreachable
    }

    /**
     * Get the number of bytes used by the length encoding at the given position.
     */
    public static short getLengthBytes(byte[] buf, short off) {
        short first = (short) (buf[off] & 0x00FF);

        if (first < (short) 0x80) {
            return (short) 1;
        }
        if (first == (short) 0x81) {
            return (short) 2;
        }
        if (first == (short) 0x82) {
            return (short) 3;
        }

        ISOException.throwIt(Constants.SW_DATA_INVALID);
        return (short) 0; // unreachable
    }

    /**
     * Get the value length for the tag found at the given offset.
     * Combines tag skip + length parse.
     *
     * @param buf buffer containing TLV
     * @param off offset of the tag start
     * @return length of the value field
     */
    public static short getTagValueLength(byte[] buf, short off) {
        short tagLen = getTagLength(buf, off);
        return parseLength(buf, (short) (off + tagLen));
    }

    /**
     * Get the offset where the value starts for the TLV at the given position.
     *
     * @param buf buffer containing TLV
     * @param off offset of the tag start
     * @return offset of the value field
     */
    public static short getTagValueOffset(byte[] buf, short off) {
        short tagLen = getTagLength(buf, off);
        short lenBytes = getLengthBytes(buf, (short) (off + tagLen));
        return (short) (off + tagLen + lenBytes);
    }

    /**
     * Encode a BER-TLV length into the buffer.
     *
     * @param buf buffer to write into
     * @param off offset to start writing
     * @param len the length value to encode
     * @return number of bytes written
     */
    public static short encodeLength(byte[] buf, short off, short len) {
        if (len < (short) 0x80) {
            buf[off] = (byte) len;
            return (short) 1;
        }
        if (len < (short) 0x100) {
            buf[off] = (byte) 0x81;
            buf[(short) (off + 1)] = (byte) len;
            return (short) 2;
        }
        buf[off] = (byte) 0x82;
        buf[(short) (off + 1)] = (byte) (len >> 8);
        buf[(short) (off + 2)] = (byte) len;
        return (short) 3;
    }
}
