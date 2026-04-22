import { useCallback, useEffect, useState } from 'react';
import { api as allApi } from '../utils/api';
import type { Card } from '../features/cards/types';

interface TokenisationProgram {
  id: string;
  name: string;
  currency: string;
}

// Cards list — Palisade-owned card rows joined client-side with
// Vera-owned TokenisationProgram rows (same id; split architecture).
// Palisade stores card-domain fields (programType, NDEF templates,
// FI, embossing) and Vera stores token-control fields (currency,
// tier rules).  Joining here instead of server-side because the two
// concerns live in different DBs and a cross-service call per Card
// endpoint call would add a hop.  Vault entries (panLast4, panBin,
// cardholderName) are still fetched on demand per-card from the
// Vera vault-proxy when the drawer opens.
export function useCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    // Fan-out + join.  Tolerates the tokenisation-programs request
    // failing (UI falls back to undefined currency); a 404 there
    // shouldn't block the Cards tab.
    const [rows, tpRows] = await Promise.all([
      allApi.palisade.get<Card[]>('/cards'),
      allApi.vera
        .get<TokenisationProgram[]>('/admin/tokenisation-programs')
        .catch(() => [] as TokenisationProgram[]),
    ]);
    const currencyByProgramId = new Map<string, string>(
      tpRows.map((tp) => [tp.id, tp.currency]),
    );
    const joined: Card[] = rows.map((c) =>
      c.program
        ? {
            ...c,
            program: {
              ...c.program,
              currency: currencyByProgramId.get(c.program.id),
            },
          }
        : c,
    );
    setCards(joined);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { cards, reload, loading };
}
