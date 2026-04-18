import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api';
import type { Card } from '../features/cards/types';

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
