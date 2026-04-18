export interface ChipProfile {
  id: string;
  name: string;
  scheme: string;
  vendor: string;
  cvn: number;
  dgiDefinitions: unknown;
  elfAid: string | null;
  moduleAid: string | null;
  programId: string | null;
  program: { id: string; name: string } | null;
  createdAt: string;
}
