/**
 * Provisioning session lifecycle management.
 *
 * Coordinates the complete provisioning flow through 6 phases:
 *   Phase 0: PA SELECT + FCI validation
 *   Phase 1: SCP11c session establishment
 *   Phase 2: Key generation + attestation
 *   Phase 3: SAD transfer
 *   Phase 4: Awaiting final status
 *   Phase 5: CONFIRM + callback
 *
 * Ported from palisade-rca/app/services/session_manager.py.
 */

import { prisma } from '@vera/db';
import { APDUBuilder } from '@vera/emv';

import { getRcaConfig } from '../env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WSMessage {
  type: 'apdu' | 'response' | 'complete' | 'error' | 'pa_fci';
  hex?: string;
  sw?: string;
  phase?: string;
  progress?: number;
  code?: string;
  message?: string;
  proxyCardId?: string;
}

interface SessionState {
  sessionId: string;
  proxyCardId: string;
  cardId: string;
  sadRecordId: string;
  phase: string;
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

export class SessionManager {
  /**
   * Start a provisioning session.
   * Validates the card has a READY SAD record, creates a ProvisioningSession.
   */
  async startSession(proxyCardId: string): Promise<SessionState> {
    // Find the SAD record
    const sadRecord = await prisma.sadRecord.findUnique({
      where: { proxyCardId },
    });
    if (!sadRecord || sadRecord.status !== 'READY') {
      throw new Error(`No READY SAD record for proxyCardId: ${proxyCardId}`);
    }

    // Create provisioning session
    const session = await prisma.provisioningSession.create({
      data: {
        cardId: sadRecord.cardId,
        sadRecordId: sadRecord.id,
        phase: 'INIT',
      },
    });

    console.log(`[rca] session created: ${session.id} for card ${sadRecord.cardId}`);

    return {
      sessionId: session.id,
      proxyCardId,
      cardId: sadRecord.cardId,
      sadRecordId: sadRecord.id,
      phase: 'INIT',
    };
  }

  /**
   * Process an incoming WebSocket message and return response messages.
   * This drives the provisioning state machine.
   */
  async handleMessage(sessionId: string, message: WSMessage): Promise<WSMessage[]> {
    if (message.type === 'pa_fci') {
      return this.handlePaFci(sessionId);
    }

    if (message.type === 'response') {
      return this.handleCardResponse(sessionId, message);
    }

    if (message.type === 'error') {
      await this.handleError(sessionId, message);
      return [];
    }

    return [];
  }

  // -----------------------------------------------------------------------
  // Phase handlers
  // -----------------------------------------------------------------------

  /**
   * Phase 0: PA FCI received → send GENERATE_KEYS directly (no SCP11).
   *
   * Palisade dropped SCP11c entirely (it never worked end-to-end with the
   * real PA applet — see palisade/tools/test_ssd_e2e.py which is the
   * working reference flow).  The sequence is:
   *   SELECT PA → FCI → GENERATE_KEYS → TRANSFER_SAD (direct delivery)
   *               → re-SELECT PA → FINAL_STATUS → CONFIRM
   *
   * No PSO, no ECDH, no script wrapping.  The SAD is transferred as
   * cleartext over the WebSocket relay because the relay is already
   * inside our trust boundary (HMAC-signed APDU stream from the mobile
   * app the cardholder is logged into).
   */
  private async handlePaFci(sessionId: string): Promise<WSMessage[]> {
    await prisma.provisioningSession.update({
      where: { id: sessionId },
      data: { phase: 'KEYGEN' },
    });

    // GENERATE_KEYS = 80 E0 00 00 01 01 — single-byte payload `01`
    // means "ECC P-256 keypair please".  No session ID — passing one
    // appends 16 bytes the PA discards (or worse).  Matches the exact
    // hex in the Palisade SSD e2e trace.
    const keygenHex = APDUBuilder.generateKeys();

    return [{
      type: 'apdu',
      hex: keygenHex,
      phase: 'key_generation',
      progress: 0.1,
    }];
  }

  /**
   * Route card responses based on the current phase.
   */
  private async handleCardResponse(sessionId: string, msg: WSMessage): Promise<WSMessage[]> {
    const [, sw] = APDUBuilder.parseResponse(
      (msg.hex ?? '') + (msg.sw ?? ''),
    );

    // Check for card error
    if (sw !== 0x9000) {
      console.warn(`[rca] card error SW=${sw.toString(16).padStart(4, '0')} in session ${sessionId}`);
      return [{
        type: 'error',
        code: 'CARD_ERROR',
        message: `Card returned error SW=${sw.toString(16).padStart(4, '0').toUpperCase()}`,
      }];
    }

    const session = await prisma.provisioningSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return [];

    switch (session.phase) {
      case 'KEYGEN':
        return this.handleKeygenResponse(sessionId, msg);
      case 'SAD_TRANSFER':
        return this.handleSadResponse(sessionId);
      case 'AWAITING_FINAL':
        return this.handleFinalStatus(sessionId, msg);
      default:
        return [];
    }
  }

  /**
   * Phase 2: Process keygen response, store ICC public key, send TRANSFER_SAD.
   * Response: ICC_PubKey(65) || Attest_Sig(~72) || CPLC(42)
   */
  private async handleKeygenResponse(sessionId: string, msg: WSMessage): Promise<WSMessage[]> {
    const respData = Buffer.from(msg.hex ?? '', 'hex');
    const iccPubkey = respData.subarray(0, Math.min(65, respData.length));

    // Load session with SAD record and card's program/chip profile
    const session = await prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      include: {
        sadRecord: true,
        card: {
          include: {
            program: {
              include: { issuerProfile: { include: { chipProfile: true } } },
            },
          },
        },
      },
    });

    if (!session) return [];

    await prisma.provisioningSession.update({
      where: { id: sessionId },
      data: { phase: 'SAD_TRANSFER', iccPublicKey: iccPubkey },
    });

    // Get the real SAD payload
    let sadPayload: Buffer;
    if (session.sadRecord && session.sadRecord.sadEncrypted.length > 0) {
      // In dev mode (no KMS), sadEncrypted is just the raw SAD bytes
      // In production, it would need KMS decryption first
      sadPayload = Buffer.from(session.sadRecord.sadEncrypted);
    } else {
      // Fallback: minimal SAD for testing
      sadPayload = Buffer.from('0101085008 PALISADE'.replace(/ /g, ''), 'hex');
    }

    // Get chip profile DGI references
    const chipProfile = session.card?.program?.issuerProfile?.chipProfile;
    const iccPrivDgi = chipProfile?.iccPrivateKeyDgi ?? 0x8001;
    const iccPrivTag = chipProfile?.iccPrivateKeyTag ?? 0x9F48;

    // Build timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    const tsBuf = Buffer.alloc(4);
    tsBuf.writeUInt32BE(timestamp, 0);

    // Build TRANSFER_SAD APDU data
    const dgiRef = Buffer.alloc(4);
    dgiRef.writeUInt16BE(iccPrivDgi, 0);
    dgiRef.writeUInt16BE(iccPrivTag, 2);

    const transferData = Buffer.concat([sadPayload, tsBuf, dgiRef]);

    const lc = transferData.length;
    let transferApdu: Buffer;
    if (lc <= 255) {
      transferApdu = Buffer.concat([
        Buffer.from([0x80, 0xE2, 0x00, 0x00, lc]),
        transferData,
      ]);
    } else {
      // Extended APDU for large SAD
      const lcBuf = Buffer.alloc(2);
      lcBuf.writeUInt16BE(lc, 0);
      transferApdu = Buffer.concat([
        Buffer.from([0x80, 0xE2, 0x00, 0x00, 0x00]),
        lcBuf,
        transferData,
      ]);
    }

    return [{
      type: 'apdu',
      hex: transferApdu.toString('hex').toUpperCase(),
      phase: 'provisioning',
      progress: 0.55,
    }];
  }

  /**
   * Phase 3: SAD transfer complete → send FINAL_STATUS.
   */
  private async handleSadResponse(sessionId: string): Promise<WSMessage[]> {
    await prisma.provisioningSession.update({
      where: { id: sessionId },
      data: { phase: 'AWAITING_FINAL' },
    });

    return [{
      type: 'apdu',
      hex: APDUBuilder.finalStatus(),
      phase: 'finalizing',
      progress: 0.80,
    }];
  }

  /**
   * Phase 4-5: Process final status, send CONFIRM, fire callback.
   */
  private async handleFinalStatus(sessionId: string, msg: WSMessage): Promise<WSMessage[]> {
    const respData = Buffer.from(msg.hex ?? '', 'hex');
    const statusByte = respData.length > 0 ? respData[0] : 0;
    const success = statusByte === 0x01;

    if (!success) {
      await prisma.provisioningSession.update({
        where: { id: sessionId },
        data: { phase: 'FAILED', failedAt: new Date(), failureReason: 'PA_FAILED' },
      });
      return [{
        type: 'error',
        code: 'PA_FAILED',
        message: 'Provisioning failed on card',
      }];
    }

    // Extract provenance hash (32 bytes) + FIDO data
    const provHash = respData.length > 33 ? respData.subarray(1, 33).toString('hex') : '';
    let fidoCredData = '';
    if (respData.length > 66) {
      const credIdLen = respData[65];
      const credId = respData.subarray(66, 66 + credIdLen);
      fidoCredData = credId.toString('base64url');
    }

    // Update session to COMPLETE
    const session = await prisma.provisioningSession.update({
      where: { id: sessionId },
      data: {
        phase: 'COMPLETE',
        completedAt: new Date(),
        provenance: provHash,
        fidoCredData,
      },
      include: { card: true, sadRecord: true },
    });

    // Update card status to PROVISIONED
    await prisma.card.update({
      where: { id: session.cardId },
      data: { status: 'PROVISIONED', provisionedAt: new Date() },
    });

    // Mark SAD as consumed
    await prisma.sadRecord.update({
      where: { id: session.sadRecordId },
      data: { status: 'CONSUMED' },
    });

    console.log(`[rca] provisioning complete: session=${sessionId}, card=${session.cardId}`);

    // Fire callback to activation service (async, non-blocking)
    this.fireCallback(session.card.cardRef, session.card.chipSerial ?? '').catch((err) =>
      console.error('[rca] callback failed:', err),
    );

    return [
      { type: 'apdu', hex: APDUBuilder.confirm(), phase: 'confirming', progress: 0.95 },
      { type: 'complete', proxyCardId: session.sadRecord.proxyCardId },
    ];
  }

  /**
   * Handle app-reported error (NFC lost, etc.)
   */
  private async handleError(sessionId: string, msg: WSMessage): Promise<void> {
    await prisma.provisioningSession.update({
      where: { id: sessionId },
      data: {
        phase: 'FAILED',
        failedAt: new Date(),
        failureReason: msg.code ?? 'APP_ERROR',
      },
    });
    console.warn(`[rca] session error: ${sessionId} — ${msg.code}`);
  }

  /**
   * Fire HMAC-signed callback to the activation service.
   */
  private async fireCallback(cardRef: string, chipSerial: string): Promise<void> {
    const config = getRcaConfig();
    const { signRequest } = await import('@vera/service-auth');
    const { request } = await import('undici');

    const path = `/api/cards/${encodeURIComponent(cardRef)}/provision-complete`;
    const body = JSON.stringify({ chipSerial });
    const bodyBuf = Buffer.from(body, 'utf8');

    const authorization = signRequest({
      method: 'POST',
      pathAndQuery: path,
      body: bodyBuf,
      keyId: 'rca',
      secret: config.CALLBACK_HMAC_SECRET,
    });

    await request(`${config.ACTIVATION_CALLBACK_URL}${path}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: bodyBuf,
    });
  }
}
