import { useCallback, useEffect, useState } from 'react';
import { api as allApi } from '../utils/api';
import type { Card } from '../features/cards/types';

// Vault-owned list — cardRef/status are Palisade's but the /admin/vault/cards
// route aggregates with vault entry + credential state.  Stays Vera-side
// until the cross-repo Phase 6 cutover.
const api = allApi.vera;

export function useCards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const r = await api.get<Card[]>('/admin/vault/cards');
    setCards(r);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { cards, reload, loading };
}
