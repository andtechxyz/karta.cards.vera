import { useCallback, useEffect, useState } from 'react';
import { api as allApi } from '../utils/api';
import type { Card } from '../features/cards/types';

// Cards list — Palisade-owned (Card model lives in the Palisade DB
// post-split).  Vault entries (panLast4, panBin, cardholderName) are
// fetched on demand per-card from the Vera vault-proxy when the
// drawer opens, NOT included here — saves N cross-service calls and
// aligns with the cross-repo split.
const api = allApi.palisade;

export function useCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const r = await api.get<Card[]>('/cards');
    setCards(r);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { cards, reload, loading };
}
