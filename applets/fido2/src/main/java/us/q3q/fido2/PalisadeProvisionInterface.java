/*
 * Palisade Provisioning Interface — shared between FIDO2Applet and PA.
 * Must be in the FIDO2Applet's package for SIO access.
 */
package us.q3q.fido2;

import javacard.framework.Shareable;

public interface PalisadeProvisionInterface extends Shareable {
    byte provision();
}
