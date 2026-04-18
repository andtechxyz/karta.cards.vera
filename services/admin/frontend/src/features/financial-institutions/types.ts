import type { Program } from '../programs/types';

export interface FinancialInstitution {
  id: string;
  name: string;
  slug: string;
  bin: string | null;
  contactEmail: string | null;
  contactName: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  updatedAt: string;
  _count?: { programs: number };
  programs?: Program[];
}
