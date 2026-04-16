/*
 * Project Palisade — Provenance Log
 *
 * Circular persistent log of provisioning sessions. Each entry is a
 * SHA-256 hash of the session context plus a monotonic counter.
 * Maximum 5 entries — oldest entry overwritten when full.
 *
 * No RTC on JavaCard, so we use a monotonic counter instead of timestamps.
 */
package com.palisade.pa;

import javacard.framework.Util;
import javacard.security.MessageDigest;

public final class ProvenanceLog {

    /** SHA-256 digest instance (allocated once in install). */
    private final MessageDigest sha256;

    /** Reference to the provenance log buffer in BufferManager. */
    private final byte[] log;

    /** Current write position (circular index 0..4). Persistent NVM. */
    private final byte[] position;

    /** Monotonic event counter (4 bytes, big-endian). Persistent NVM. */
    private final byte[] counter;

    /**
     * @param logBuffer the provenance log buffer from BufferManager
     */
    public ProvenanceLog(byte[] logBuffer) {
        this.log = logBuffer;
        this.sha256 = MessageDigest.getInstance(MessageDigest.ALG_SHA_256, false);
        this.position = new byte[1];
        this.counter = new byte[4];
    }

    /**
     * Record a provisioning event in the circular log.
     *
     * Hash input: counter(4) || iccPubKeyHash(32) || sessionContext(var)
     *
     * @param iccPubKey       ICC public key W buffer
     * @param iccPubKeyOff    offset into iccPubKey
     * @param iccPubKeyLen    length of ICC public key
     * @param sessionCtx      session context data (e.g., card_ref bytes)
     * @param sessionCtxOff   offset into sessionCtx
     * @param sessionCtxLen   length of session context
     * @param workBuf         temporary work buffer (>= 32 bytes)
     * @param workOff         offset into work buffer
     */
    public void recordEvent(byte[] iccPubKey, short iccPubKeyOff, short iccPubKeyLen,
                            byte[] sessionCtx, short sessionCtxOff, short sessionCtxLen,
                            byte[] workBuf, short workOff) {

        // Increment monotonic counter
        incrementCounter();

        // Hash the ICC public key first
        sha256.reset();
        sha256.update(iccPubKey, iccPubKeyOff, iccPubKeyLen);
        sha256.doFinal(workBuf, workOff, (short) 0, workBuf, workOff);
        // workBuf[workOff..workOff+31] = SHA-256(iccPubKey)

        // Now hash: counter || iccPubKeyHash || sessionContext
        sha256.reset();
        sha256.update(counter, (short) 0, (short) 4);
        sha256.update(workBuf, workOff, (short) 32);

        // Calculate entry offset in circular log
        // Note: multiplication and modulo produce int in Java — use loop instead
        short pos = (short)(position[0] & 0x00FF);
        short entryOff = 0;
        for (short i = 0; i < pos; i++) {
            entryOff += Constants.PROVENANCE_ENTRY_LEN;
        }

        // Write hash directly to log entry
        sha256.doFinal(sessionCtx, sessionCtxOff, sessionCtxLen, log, entryOff);

        // Write counter after hash (bytes 32-35 of the entry)
        Util.arrayCopyNonAtomic(counter, (short) 0, log, (short) (entryOff + 32), (short) 4);

        // Advance circular position
        short newPos = (short)((short)(position[0] & 0x00FF) + (short)1);
        if (newPos >= Constants.PROVENANCE_MAX_ENTRIES) newPos = 0;
        position[0] = (byte) newPos;
    }

    /**
     * Record a wipe event in the log.
     *
     * @param workBuf  temporary work buffer (>= 32 bytes)
     * @param workOff  offset into work buffer
     */
    public void recordWipe(byte[] workBuf, short workOff) {
        incrementCounter();

        // Hash: counter || 0xFF (wipe marker)
        sha256.reset();
        sha256.update(counter, (short) 0, (short) 4);
        workBuf[workOff] = (byte) 0xFF; // wipe marker

        short pos2 = (short)(position[0] & 0x00FF);
        short entryOff = 0;
        for (short i = 0; i < pos2; i++) {
            entryOff += Constants.PROVENANCE_ENTRY_LEN;
        }
        sha256.doFinal(workBuf, workOff, (short) 1, log, entryOff);
        Util.arrayCopyNonAtomic(counter, (short) 0, log, (short) (entryOff + 32), (short) 4);

        short newPos2 = (short)((short)(position[0] & 0x00FF) + (short)1);
        if (newPos2 >= Constants.PROVENANCE_MAX_ENTRIES) newPos2 = 0;
        position[0] = (byte) newPos2;
    }

    /**
     * Copy the full provenance log to the output buffer.
     *
     * @param out    output buffer
     * @param outOff offset into output buffer
     * @return number of bytes written
     */
    public short getLog(byte[] out, short outOff) {
        Util.arrayCopyNonAtomic(log, (short) 0, out, outOff, Constants.PROVENANCE_LOG_LEN);
        return Constants.PROVENANCE_LOG_LEN;
    }

    /**
     * Get the current monotonic counter value.
     *
     * @param out    output buffer
     * @param outOff offset into output buffer
     * @return 4
     */
    public short getCounter(byte[] out, short outOff) {
        Util.arrayCopyNonAtomic(counter, (short) 0, out, outOff, (short) 4);
        return (short) 4;
    }

    /** Increment the 4-byte big-endian monotonic counter. */
    private void incrementCounter() {
        for (short i = 3; i >= 0; i--) {
            short val = (short) ((counter[i] & 0x00FF) + 1);
            counter[i] = (byte) val;
            if (val <= 0xFF) {
                break; // no carry
            }
        }
    }
}
