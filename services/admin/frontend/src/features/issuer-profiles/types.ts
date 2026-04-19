// IssuerProfile — the full shape returned by the /api/issuer-profiles
// detail endpoint.  Some fields (the ARN ones) come back masked from
// the list endpoint but unmasked from /:id.  The `*_Arn` fields are
// always strings (schema default is "") even when unset, so the UI can
// treat a blank string as "no key yet".

export type IssuerScheme = 'mchip_advance' | 'vsdc';

export interface IssuerProfile {
  id: string;
  programId: string;
  chipProfileId: string;
  scheme: IssuerScheme | string; // permissive for legacy rows
  cvn: number;
  imkAlgorithm: string;
  derivationMethod: string;

  tmkKeyArn: string;
  imkAcKeyArn: string;
  imkSmiKeyArn: string;
  imkSmcKeyArn: string;
  imkIdnKeyArn: string;
  issuerPkKeyArn: string;

  caPkIndex: string;
  issuerPkCertificate: string;
  issuerPkRemainder: string;
  issuerPkExponent: string;

  aid: string;
  appLabel: string;
  appPreferredName: string;
  appPriority: string;
  appVersionNumber: string;
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

  createdAt: string;
  updatedAt: string;

  program?: { id: string; name: string } | null;
  chipProfile?: { id: string; name: string; scheme: string } | null;
}

// The list endpoint masks all ARN fields to `***xxxx` (last 4).  Shape
// is otherwise identical; we keep one type and trust the caller to
// remember which endpoint it hit.
export type IssuerProfileListItem = IssuerProfile;

export const SCHEME_OPTIONS: { value: IssuerScheme; label: string }[] = [
  { value: 'mchip_advance', label: 'Mastercard M/Chip Advance' },
  { value: 'vsdc', label: 'Visa VSDC' },
];

// Fields validated as hex on the client before a save.  Mirrors the
// backend Zod schema's hexField regex so the user gets immediate
// feedback instead of waiting for a 400.
export const HEX_FIELDS = [
  'caPkIndex',
  'issuerPkCertificate',
  'issuerPkRemainder',
  'issuerPkExponent',
  'aid',
  'appPriority',
  'appVersionNumber',
  'aip',
  'afl',
  'cvmList',
  'pdol',
  'cdol1',
  'cdol2',
  'iacDefault',
  'iacDenial',
  'iacOnline',
  'appUsageControl',
  'currencyCode',
  'currencyExponent',
  'countryCode',
  'sdaTagList',
] as const;

export type HexField = (typeof HEX_FIELDS)[number];

export const HEX_REGEX = /^[0-9A-Fa-f]*$/;

export function isHex(s: string): boolean {
  return HEX_REGEX.test(s);
}
