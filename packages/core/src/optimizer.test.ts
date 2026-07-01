import { describe, it, expect } from 'vitest';
import { optimize } from './optimizer.js';
import type { OptimizerInput } from '@meals/shared';

function providersOf(
  defs: Array<{ id: string; travel: number; costs: Record<string, number> }>,
): OptimizerInput['providers'] {
  return defs.map((d) => ({
    providerId: d.id,
    name: d.id,
    travelMinutes: d.travel,
    itemCosts: Object.fromEntries(
      Object.entries(d.costs).map(([itemId, cost]) => [itemId, { productId: `${d.id}:${itemId}`, cost }]),
    ),
  }));
}

describe('optimize (time-vs-savings)', () => {
  it('splits across stores when savings beat travel time', () => {
    const input: OptimizerInput = {
      items: [
        { itemId: 'A', name: 'A', baseQuantityNeeded: 1, unit: 'EACH' },
        { itemId: 'B', name: 'B', baseQuantityNeeded: 1, unit: 'EACH' },
      ],
      providers: providersOf([
        { id: 'S1', travel: 5, costs: { A: 10, B: 1 } },
        { id: 'S2', travel: 5, costs: { A: 1, B: 10 } },
      ]),
      timeValuePerMinute: 0.1,
    };
    const res = optimize(input);
    const rec = res.options[res.recommendedIndex]!;
    expect(rec.totalMoney).toBe(2); // A@S2 (1) + B@S1 (1)
    expect(rec.storeSubtotals).toHaveLength(2);
    expect(rec.totalObjective).toBeCloseTo(3, 6); // 2 money + 0.1 * 10 min
    // baseline is the best single store (money 11) -> savings 9
    expect(rec.savingsVsBaseline).toBe(9);
    expect(res.cheapestPossibleMoney).toBe(2);
  });

  it('stays single-store when time is expensive', () => {
    const input: OptimizerInput = {
      items: ['A', 'B', 'C'].map((id) => ({ itemId: id, name: id, baseQuantityNeeded: 1, unit: 'EACH' as const })),
      providers: providersOf([
        { id: 'S1', travel: 10, costs: { A: 10, B: 10, C: 10 } },
        { id: 'S2', travel: 10, costs: { A: 9, B: 9, C: 9 } },
      ]),
      timeValuePerMinute: 100,
    };
    const res = optimize(input);
    const rec = res.options[res.recommendedIndex]!;
    expect(rec.storeSubtotals).toHaveLength(1);
    expect(rec.storeSubtotals[0]!.providerId).toBe('S2');
    expect(rec.totalMoney).toBe(27);
  });

  it('reports items no store stocks', () => {
    const input: OptimizerInput = {
      items: [
        { itemId: 'A', name: 'A', baseQuantityNeeded: 1, unit: 'EACH' },
        { itemId: 'D', name: 'D', baseQuantityNeeded: 1, unit: 'EACH' },
      ],
      providers: providersOf([{ id: 'S1', travel: 5, costs: { A: 3 } }]),
      timeValuePerMinute: 0.25,
    };
    const res = optimize(input);
    const rec = res.options[res.recommendedIndex]!;
    expect(rec.unstockedItemIds).toEqual(['D']);
    expect(rec.totalMoney).toBe(3);
  });

  it('honours a maxStores cap', () => {
    const input: OptimizerInput = {
      items: ['A', 'B'].map((id) => ({ itemId: id, name: id, baseQuantityNeeded: 1, unit: 'EACH' as const })),
      providers: providersOf([
        { id: 'S1', travel: 1, costs: { A: 1, B: 100 } },
        { id: 'S2', travel: 1, costs: { A: 100, B: 1 } },
        { id: 'S3', travel: 1, costs: { A: 50, B: 50 } },
      ]),
      timeValuePerMinute: 0.01,
      maxStores: 1,
    };
    const res = optimize(input);
    const rec = res.options[res.recommendedIndex]!;
    expect(rec.storeSubtotals).toHaveLength(1);
    expect(rec.storeSubtotals[0]!.providerId).toBe('S3'); // only single store covering both
  });
});
