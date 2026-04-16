/**
 * Data Prep orchestrator — validates, derives, builds, encrypts, stores.
 *
 * Coordinates the complete SAD preparation flow:
 * 1. Load issuer profile by programId
 * 2. Load chip profile
 * 3. Derive EMV keys (iCVV, MK-AC, MK-SMI, MK-SMC) via AWS Payment Cryptography
 * 4. Build SAD (TLV/DGI structures via @vera/emv)
 * 5. Serialise and encrypt SAD blob
 * 6. Store SAD record in Postgres
 * 7. Return proxyCardId
 *
 * Ported from palisade-data-prep/app/services/data_prep.py.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { prisma } from '@vera/db';
import { SADBuilder, ChipProfile } from '@vera/emv';
import type { CardData, IssuerProfileForSad } from '@vera/emv';
import { notFound } from '@vera/core';

import { EmvDerivationService } from './emv-derivation.js';
import { getDataPrepConfig } from '../env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrepareInput {
  cardId: string;
  pan: string;
  expiryYymm: string;
  serviceCode?: string;
  cardSequenceNumber?: string;
  chipSerial?: string;
  programId: string;
}

export interface PrepareResult {
  proxyCardId: string;
  sadRecordId: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DataPrepService {
  private readonly emv: EmvDerivationService;

  constructor() {
    const config = getDataPrepConfig();
    this.emv = new EmvDerivationService(config.AWS_REGION);
  }

  async prepareCard(input: PrepareInput): Promise<PrepareResult> {
    const config = getDataPrepConfig();

    // Step 1: Load issuer profile (includes key ARNs and EMV constants)
    const issuerProfile = await prisma.issuerProfile.findUnique({
      where: { programId: input.programId },
      include: { chipProfile: true },
    });
    if (!issuerProfile) throw notFound('profile_not_found', `Unknown programId: ${input.programId}`);

    // Step 2: Load chip profile from the issuer profile's linked chip profile
    const chipProfile = this.buildChipProfile(issuerProfile.chipProfile);

    // Step 3: Derive EMV keys via AWS Payment Cryptography
    const derived = await this.emv.deriveAllKeys(
      issuerProfile.tmkKeyArn,
      issuerProfile.imkAcKeyArn,
      issuerProfile.imkSmiKeyArn,
      issuerProfile.imkSmcKeyArn,
      input.pan,
      input.expiryYymm,
      input.cardSequenceNumber ?? '01',
    );

    // Step 4: Build SAD (TLV/DGI structures)
    const profileForSad = this.toSadProfile(issuerProfile);
    const cardData: CardData = {
      pan: input.pan,
      expiryDate: input.expiryYymm,
      effectiveDate: this.computeEffectiveDate(input.expiryYymm),
      serviceCode: input.serviceCode ?? '201',
      cardSequenceNumber: input.cardSequenceNumber ?? '01',
      icvv: derived.icvv,
    };

    const dgis = SADBuilder.buildSad(profileForSad, chipProfile, cardData);

    // Step 5: Serialise and encrypt
    const sadBytes = SADBuilder.serialiseDgis(dgis);
    const { encrypted, keyVersion } = this.encryptSad(sadBytes, config.KMS_SAD_KEY_ARN);

    // Step 6: Store SAD record
    const sadRecord = await prisma.sadRecord.create({
      data: {
        cardId: input.cardId,
        proxyCardId: `pxy_${randomBytes(12).toString('hex')}`,
        sadEncrypted: encrypted,
        sadKeyVersion: keyVersion,
        chipSerial: input.chipSerial ?? null,
        status: 'READY',
        expiresAt: new Date(Date.now() + config.SAD_TTL_DAYS * 86400_000),
      },
    });

    // Step 7: Update card's proxyCardId
    await prisma.card.update({
      where: { id: input.cardId },
      data: { proxyCardId: sadRecord.proxyCardId },
    });

    return {
      proxyCardId: sadRecord.proxyCardId,
      sadRecordId: sadRecord.id,
      status: 'READY',
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private buildChipProfile(
    dbProfile: {
      dgiDefinitions: unknown;
      scheme: string;
      vendor: string;
      cvn: number;
      elfAid: string | null;
      moduleAid: string | null;
      paAid: string;
      fidoAid: string;
      iccPrivateKeyDgi: number;
      iccPrivateKeyTag: number;
      mkAcDgi: number;
      mkSmiDgi: number;
      mkSmcDgi: number;
      id: string;
      name: string;
    },
  ): ChipProfile {
    return ChipProfile.fromJson({
      profile_id: dbProfile.id,
      profile_name: dbProfile.name,
      scheme: dbProfile.scheme,
      applet_vendor: dbProfile.vendor,
      cvn: dbProfile.cvn,
      dgi_definitions: dbProfile.dgiDefinitions,
      elf_aid: dbProfile.elfAid ?? '',
      module_aid: dbProfile.moduleAid ?? '',
      pa_aid: dbProfile.paAid,
      fido_aid: dbProfile.fidoAid,
      icc_private_key_dgi: dbProfile.iccPrivateKeyDgi,
      icc_private_key_tag: dbProfile.iccPrivateKeyTag,
      mk_ac_dgi: dbProfile.mkAcDgi,
      mk_smi_dgi: dbProfile.mkSmiDgi,
      mk_smc_dgi: dbProfile.mkSmcDgi,
    });
  }

  private toSadProfile(ip: {
    scheme: string;
    cvn: number;
    aip: string;
    afl: string;
    cvmList: string;
    pdol: string;
    cdol1: string;
    cdol2: string;
    iacDefault: string;
    iacDenial: string;
    iacOnline: string;
    appUsageControl: string;
    currencyCode: string;
    currencyExponent: string;
    countryCode: string;
    sdaTagList: string;
    appVersionNumber: string;
    appPriority: string;
    aid: string;
    appLabel: string;
    appPreferredName: string;
    issuerPkCertificate: string;
    issuerPkRemainder: string;
    issuerPkExponent: string;
    caPkIndex: string;
  }): IssuerProfileForSad {
    return {
      scheme: ip.scheme,
      cvn: ip.cvn,
      aip: ip.aip || undefined,
      afl: ip.afl || undefined,
      cvmList: ip.cvmList || undefined,
      pdol: ip.pdol || undefined,
      cdol1: ip.cdol1 || undefined,
      cdol2: ip.cdol2 || undefined,
      iacDefault: ip.iacDefault || undefined,
      iacDenial: ip.iacDenial || undefined,
      iacOnline: ip.iacOnline || undefined,
      appUsageControl: ip.appUsageControl || undefined,
      currencyCode: ip.currencyCode || undefined,
      currencyExponent: ip.currencyExponent || undefined,
      countryCode: ip.countryCode || undefined,
      sdaTagList: ip.sdaTagList || undefined,
      appVersionNumber: ip.appVersionNumber || undefined,
      appPriority: ip.appPriority || undefined,
      aid: ip.aid || undefined,
      appLabel: ip.appLabel || undefined,
      appPreferredName: ip.appPreferredName || undefined,
      issuerPkCertificate: ip.issuerPkCertificate || undefined,
      issuerPkRemainder: ip.issuerPkRemainder || undefined,
      issuerPkExponent: ip.issuerPkExponent || undefined,
      caPkIndex: ip.caPkIndex || undefined,
    };
  }

  /**
   * Encrypt SAD blob. In production uses KMS; in dev uses a local AES key.
   */
  private encryptSad(sadBytes: Buffer, _kmsKeyArn: string): { encrypted: Buffer; keyVersion: number } {
    // For prototype: AES-256-GCM with a locally-generated key.
    // Production: replace with KMS encrypt call.
    const iv = randomBytes(12);
    const key = randomBytes(32); // In production, this comes from KMS
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(sadBytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv(12) || ciphertext || tag(16)
    return {
      encrypted: Buffer.concat([iv, encrypted, tag]),
      keyVersion: 1,
    };
  }

  private computeEffectiveDate(expiryYymm: string): string {
    const yy = parseInt(expiryYymm.slice(0, 2), 10);
    const mm = expiryYymm.slice(2, 4);
    const effectiveYy = Math.max(0, yy - 5);
    return `${effectiveYy.toString().padStart(2, '0')}${mm}`;
  }
}
