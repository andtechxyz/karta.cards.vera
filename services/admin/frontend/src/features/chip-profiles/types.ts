// ChipProfile — matches the full prisma model.  `dgiDefinitions` is an
// opaque JSON blob we round-trip through the API.  The authoritative
// shape is in packages/emv/src/chip-profile.ts (ChipProfile.fromJson).

export interface ChipProfile {
  id: string;
  name: string;
  scheme: string;
  vendor: string;
  cvn: number;
  dgiDefinitions: unknown;
  elfAid: string | null;
  moduleAid: string | null;
  paAid: string;
  fidoAid: string;
  iccPrivateKeyDgi: number;
  iccPrivateKeyTag: number;
  mkAcDgi: number;
  mkSmiDgi: number;
  mkSmcDgi: number;
  programId: string | null;
  program?: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export const SCHEME_OPTIONS: { value: string; label: string }[] = [
  { value: 'mchip_advance', label: 'Mastercard M/Chip Advance' },
  { value: 'vsdc', label: 'Visa VSDC' },
];
