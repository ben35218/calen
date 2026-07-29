// packValueFraming drives the pack store's badges and pre-selection: the % bonus
// in credits-per-dollar vs the first (Starter) pack, and which pack is "best".
// Pure catalog math — no rendering, same stub pattern as shared.test.ts.
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  Pressable: 'Pressable',
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (s: any) => s },
}));
jest.mock('../../../components/ui', () => ({ Button: 'Button' }));
jest.mock('../shared', () => ({ humanCredits: (n: number) => String(n) }));

import { packValueFraming } from '../PackStore';
import type { CreditPack } from '../../../api';

const CATALOG: CreditPack[] = [
  { productId: 'credits_499', label: 'Starter', price: 4.99, credits: 500 },
  { productId: 'credits_999', label: 'Plus', price: 9.99, credits: 1050 },
  { productId: 'credits_1999', label: 'Best value', price: 19.99, credits: 2200 },
];

describe('packValueFraming', () => {
  it('computes the % bonus of each pack over the first pack, rounded to whole %', () => {
    const { bonuses } = packValueFraming(CATALOG);
    // 500/$4.99 baseline; 1050/$9.99 ≈ +5%; 2200/$19.99 ≈ +10%.
    expect(bonuses).toEqual([0, 5, 10]);
  });

  it('marks the richest pack best, with ties going to the biggest', () => {
    expect(packValueFraming(CATALOG).bestIndex).toBe(2);
    const flat = CATALOG.map((p) => ({ ...p, credits: p.price * 100 }));
    expect(packValueFraming(flat).bestIndex).toBe(2);
  });

  it('never divides by zero on a degenerate catalog', () => {
    const free = [{ productId: 'x', label: 'x', price: 0, credits: 100 }] as CreditPack[];
    expect(packValueFraming(free)).toEqual({ bestIndex: 0, bonuses: [0] });
    expect(packValueFraming([])).toEqual({ bestIndex: 0, bonuses: [] });
  });
});
