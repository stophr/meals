import type {
  OptimizerInput,
  OptimizerProvider,
  OptimizationOption,
  OptimizationResult,
  ItemAssignment,
} from '@meals/shared';

// Time-vs-savings deal optimizer.
//
// Objective to MINIMIZE:  Σ cost(item -> chosen store)  +  λ · Σ travelMinutes(used stores)
// where λ = timeValuePerMinute. Each item is bought whole at one store (single-sourcing),
// and a store's travel time is only paid if at least one item is actually bought there.
//
// MVP note: for the small instance sizes this app sees (< ~12 stores), we enumerate store
// subsets, which is EXACT for this single-sourcing model. Above that we fall back to a
// greedy prune. A richer MILP (pack rounding, multi-buy deals, Pareto frontier) is Phase 2.

const EPS = 1e-9;
const EXACT_STORE_LIMIT = 12;

interface EvalResult {
  assignments: ItemAssignment[];
  usedProviderIds: string[];
  totalMoney: number;
  totalTimeMinutes: number;
  objective: number;
  covered: boolean;
}

/** Assign each coverable item to its cheapest store among `openIds`; price the result. */
function evaluate(
  itemIds: string[],
  openIds: string[],
  providersById: Map<string, OptimizerProvider>,
  timeValuePerMinute: number,
): EvalResult {
  const assignments: ItemAssignment[] = [];
  const usedProviderIds = new Set<string>();
  let totalMoney = 0;
  let covered = true;

  for (const itemId of itemIds) {
    let best: ItemAssignment | undefined;
    for (const pid of openIds) {
      const entry = providersById.get(pid)?.itemCosts[itemId];
      if (!entry) continue;
      if (!best || entry.cost < best.cost) {
        best = { itemId, providerId: pid, productId: entry.productId, cost: entry.cost };
      }
    }
    if (!best) {
      covered = false;
      continue;
    }
    assignments.push(best);
    usedProviderIds.add(best.providerId);
    totalMoney += best.cost;
  }

  let totalTimeMinutes = 0;
  for (const pid of usedProviderIds) {
    totalTimeMinutes += providersById.get(pid)?.travelMinutes ?? 0;
  }

  return {
    assignments,
    usedProviderIds: [...usedProviderIds],
    totalMoney,
    totalTimeMinutes,
    objective: totalMoney + timeValuePerMinute * totalTimeMinutes,
    covered,
  };
}

function* subsets<T>(arr: T[], maxSize: number): Generator<T[]> {
  const n = arr.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const pick: T[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) pick.push(arr[i]!);
    if (pick.length <= maxSize) yield pick;
  }
}

/** Best feasible open-set (exact for small n, greedy prune otherwise). */
function bestOpenSet(
  itemIds: string[],
  providers: OptimizerProvider[],
  providersById: Map<string, OptimizerProvider>,
  timeValuePerMinute: number,
  maxStores: number,
): EvalResult | undefined {
  const allIds = providers.map((p) => p.providerId);

  if (providers.length <= EXACT_STORE_LIMIT) {
    let best: EvalResult | undefined;
    for (const combo of subsets(allIds, maxStores)) {
      const r = evaluate(itemIds, combo, providersById, timeValuePerMinute);
      if (!r.covered) continue;
      if (!best || r.objective < best.objective - EPS) best = r;
    }
    return best;
  }

  // Greedy prune from the money-optimal (all-stores) solution.
  let current = allIds;
  let best = evaluate(itemIds, current, providersById, timeValuePerMinute);
  if (!best.covered) return undefined;
  for (;;) {
    let improved = false;
    for (const pid of best.usedProviderIds) {
      const trial = current.filter((id) => id !== pid);
      const r = evaluate(itemIds, trial, providersById, timeValuePerMinute);
      if (r.covered && r.objective < best.objective - EPS) {
        best = r;
        current = trial;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  // Force down to maxStores if needed (accept objective increase, keep feasibility).
  while (best.usedProviderIds.length > maxStores) {
    let next: EvalResult | undefined;
    for (const pid of best.usedProviderIds) {
      const trial = current.filter((id) => id !== pid);
      const r = evaluate(itemIds, trial, providersById, timeValuePerMinute);
      if (r.covered && (!next || r.objective < next.objective - EPS)) {
        next = r;
      }
    }
    if (!next) break;
    best = next;
    current = next.usedProviderIds;
  }
  return best;
}

function toOption(
  strategy: string,
  r: EvalResult,
  providersById: Map<string, OptimizerProvider>,
  timeValuePerMinute: number,
  unstockedItemIds: string[],
): OptimizationOption {
  const storeSubtotals = r.usedProviderIds.map((pid) => {
    const p = providersById.get(pid)!;
    const itemCost = r.assignments
      .filter((a) => a.providerId === pid)
      .reduce((s, a) => s + a.cost, 0);
    return {
      providerId: pid,
      name: p.name,
      itemCost,
      travelMinutes: p.travelMinutes,
      timeCost: timeValuePerMinute * p.travelMinutes,
    };
  });
  return {
    strategy,
    assignments: r.assignments,
    storeSubtotals,
    totalMoney: round2(r.totalMoney),
    totalTimeMinutes: r.totalTimeMinutes,
    totalObjective: round2(r.objective),
    savingsVsBaseline: 0, // filled in by caller once baseline is known
    unstockedItemIds,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function signature(o: OptimizationOption): string {
  return [...o.assignments]
    .sort((a, b) => a.itemId.localeCompare(b.itemId))
    .map((a) => `${a.itemId}:${a.providerId}`)
    .join('|');
}

export function optimize(input: OptimizerInput): OptimizationResult {
  const { items, providers, timeValuePerMinute } = input;
  const maxStores = input.maxStores ?? (providers.length || 1);
  const providersById = new Map(providers.map((p) => [p.providerId, p]));

  const stocked = (itemId: string) => providers.some((p) => p.itemCosts[itemId]);
  const coverableIds = items.filter((i) => stocked(i.itemId)).map((i) => i.itemId);
  const unstockedItemIds = items.filter((i) => !stocked(i.itemId)).map((i) => i.itemId);

  const cheapestPossibleMoney = round2(
    coverableIds.reduce((sum, itemId) => {
      const min = Math.min(
        ...providers.filter((p) => p.itemCosts[itemId]).map((p) => p.itemCosts[itemId]!.cost),
      );
      return sum + min;
    }, 0),
  );

  const options: OptimizationOption[] = [];

  // Recommended: best feasible open-set under the store cap. This — not a global argmin —
  // is what recommendedIndex points at, so the recommendation always honours maxStores even
  // though we also surface a possibly-cheaper "cheapest" option that ignores the cap.
  const best = bestOpenSet(coverableIds, providers, providersById, timeValuePerMinute, maxStores);
  let recommendedSig: string | undefined;
  if (best) {
    const recOption = toOption(
      'recommended',
      best,
      providersById,
      timeValuePerMinute,
      unstockedItemIds,
    );
    recommendedSig = signature(recOption);
    options.push(recOption);
  }

  // Single-store: cheapest single store that stocks everything coverable.
  const single = bestOpenSet(coverableIds, providers, providersById, timeValuePerMinute, 1);
  if (single) {
    options.push(
      toOption('single-store', single, providersById, timeValuePerMinute, unstockedItemIds),
    );
  }

  // Max-savings: every item at its cheapest store, ignoring store count.
  const cheapest = evaluate(
    coverableIds,
    providers.map((p) => p.providerId),
    providersById,
    timeValuePerMinute,
  );
  if (cheapest.covered) {
    options.push(
      toOption('cheapest', cheapest, providersById, timeValuePerMinute, unstockedItemIds),
    );
  }

  // Deduplicate identical strategies (single store often == recommended).
  const seen = new Set<string>();
  const distinct: OptimizationOption[] = [];
  for (const o of options) {
    const sig = signature(o);
    if (seen.has(sig)) continue;
    seen.add(sig);
    distinct.push(o);
  }

  // Baseline for savings = best single-store money if one exists, else the priciest option.
  const baselineMoney = single
    ? round2(single.totalMoney)
    : Math.max(0, ...distinct.map((o) => o.totalMoney));
  for (const o of distinct) {
    o.savingsVsBaseline = round2(Math.max(0, baselineMoney - o.totalMoney));
  }

  // Point at the cap-respecting recommended option (falls back to lowest objective).
  let recommendedIndex = recommendedSig
    ? distinct.findIndex((o) => signature(o) === recommendedSig)
    : 0;
  if (recommendedIndex < 0) recommendedIndex = 0;

  return { options: distinct, recommendedIndex, cheapestPossibleMoney };
}
