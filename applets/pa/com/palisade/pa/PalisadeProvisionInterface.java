/*
 * Project Palisade — Shareable Interface for FIDO2Applet delegation.
 *
 * The FIDO2Applet calls this interface when it receives a makeCredential
 * with the "palisade" extension. The PA performs provisioning and returns
 * a status byte.
 *
 * This is how two applets on the same card communicate:
 *   FIDO2Applet (A0000006472F0001) → SIO → PA (A00000006250414C)
 */
package com.palisade.pa;

import javacard.framework.Shareable;

public interface PalisadeProvisionInterface extends Shareable {

    /**
     * Trigger provisioning from the FIDO2Applet.
     *
     * Called during makeCredential when the "palisade" extension is present.
     * The PA performs: keygen → STORE DATA build → FIDO credential → EEPROM → commit.
     *
     * @return 0x00 on success, non-zero on error
     */
    byte provision();
}
