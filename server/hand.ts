// Pure hand evaluator: the best five cards out of up to seven, their ranking and their name.
// No networking, no timers, no randomness.

import type { Card, Rank } from '../shared/types.js';

export const CATEGORY = {
  highCard: 0,
  pair: 1,
  twoPair: 2,
  three: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  four: 7,
  straightFlush: 8,
} as const;

export interface HandRank {
  /** 0 (high card) to 8 (straight flush). */
  category: number;
  /** Ranks that decide ties within the category, most important first (2 to 14, ace high). */
  values: number[];
  /** One number that orders hands: higher is better, equal means a tie. */
  score: number;
  /** The cards that make the hand, best first. Five when at least five cards were given. */
  cards: Card[];
  /** For example "Pair of kings" or "Straight, ten high". */
  name: string;
}

const VALUE: Record<Rank, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14,
};

const SINGULAR: Record<number, string> = {
  2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
  9: 'nine', 10: 'ten', 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace',
};

const PLURAL: Record<number, string> = {
  2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes', 7: 'sevens', 8: 'eights',
  9: 'nines', 10: 'tens', 11: 'jacks', 12: 'queens', 13: 'kings', 14: 'aces',
};

export function rankValue(rank: Rank): number {
  return VALUE[rank];
}

function scoreOf(category: number, values: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (values[i] ?? 0);
  return score;
}

function nameOf(category: number, v: number[]): string {
  switch (category) {
    case CATEGORY.straightFlush:
      return v[0] === 14 ? 'Royal flush' : `Straight flush, ${SINGULAR[v[0]!]} high`;
    case CATEGORY.four:
      return `Four ${PLURAL[v[0]!]}`;
    case CATEGORY.fullHouse:
      return `Full house, ${PLURAL[v[0]!]} over ${PLURAL[v[1]!]}`;
    case CATEGORY.flush:
      return `Flush, ${SINGULAR[v[0]!]} high`;
    case CATEGORY.straight:
      return `Straight, ${SINGULAR[v[0]!]} high`;
    case CATEGORY.three:
      return `Three ${PLURAL[v[0]!]}`;
    case CATEGORY.twoPair:
      return `Two pair, ${PLURAL[v[0]!]} and ${PLURAL[v[1]!]}`;
    case CATEGORY.pair:
      return `Pair of ${PLURAL[v[0]!]}`;
    default:
      return `High card, ${SINGULAR[v[0]!]}`;
  }
}

/** The top card of a straight in these values (distinct, sorted high to low), or 0. The wheel counts as five high. */
function straightHigh(distinct: number[]): number {
  if (distinct.length < 5) return 0;
  for (let i = 0; i + 4 < distinct.length; i++) {
    if (distinct[i]! - distinct[i + 4]! === 4) return distinct[i]!;
  }
  // A-2-3-4-5: the ace plays low. No wraparound beyond that.
  const has = (n: number) => distinct.includes(n);
  if (has(14) && has(5) && has(4) && has(3) && has(2)) return 5;
  return 0;
}

/** Ranks up to five cards exactly as given. Fewer than five cards can only make pairs, trips or quads. */
export function rankFive(cards: Card[]): HandRank {
  const sorted = [...cards].sort((a, b) => VALUE[b.rank] - VALUE[a.rank]);
  const counts = new Map<number, number>();
  for (const c of sorted) counts.set(VALUE[c.rank], (counts.get(VALUE[c.rank]) ?? 0) + 1);
  // Groups by size, then by rank: [[13, 3], [7, 2]] for kings full of sevens.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const distinct = [...counts.keys()].sort((a, b) => b - a);

  const flush = cards.length === 5 && cards.every((c) => c.suit === cards[0]!.suit);
  const high = cards.length === 5 && distinct.length === 5 ? straightHigh(distinct) : 0;

  let category: number;
  let values: number[];
  if (flush && high) {
    category = CATEGORY.straightFlush;
    values = [high];
  } else if (groups[0]![1] === 4) {
    category = CATEGORY.four;
    values = groups.map((g) => g[0]);
  } else if (groups[0]![1] === 3 && groups[1]?.[1] === 2) {
    category = CATEGORY.fullHouse;
    values = [groups[0]![0], groups[1]![0]];
  } else if (flush) {
    category = CATEGORY.flush;
    values = distinct;
  } else if (high) {
    category = CATEGORY.straight;
    values = [high];
  } else if (groups[0]![1] === 3) {
    category = CATEGORY.three;
    values = groups.map((g) => g[0]);
  } else if (groups[0]![1] === 2 && groups[1]?.[1] === 2) {
    category = CATEGORY.twoPair;
    values = groups.map((g) => g[0]);
  } else if (groups[0]![1] === 2) {
    category = CATEGORY.pair;
    values = groups.map((g) => g[0]);
  } else {
    category = CATEGORY.highCard;
    values = distinct;
  }

  // Order the cards the way the hand reads: the groups first, and a wheel with its ace last.
  let ordered: Card[];
  if (high) {
    ordered = high === 5 ? [...sorted.slice(1), sorted[0]!] : sorted;
  } else {
    const order = new Map(groups.map((g, i) => [g[0], i]));
    ordered = [...sorted].sort((a, b) => order.get(VALUE[a.rank])! - order.get(VALUE[b.rank])!);
  }
  return { category, values, score: scoreOf(category, values), cards: ordered, name: nameOf(category, values) };
}

function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick: T[] = [];
  const walk = (start: number) => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i <= items.length - (k - pick.length); i++) {
      pick.push(items[i]!);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

/** The best hand that can be made from these cards (two hole cards plus up to five board cards). */
export function bestHand(cards: Card[]): HandRank {
  if (cards.length === 0) throw new Error('bestHand needs at least one card');
  if (cards.length <= 5) return rankFive(cards);
  let best: HandRank | null = null;
  for (const five of combinations(cards, 5)) {
    const r = rankFive(five);
    if (!best || r.score > best.score) best = r;
  }
  return best!;
}

/** Positive when a beats b, negative when b beats a, 0 for an exact tie. */
export function compareHands(a: HandRank, b: HandRank): number {
  return a.score - b.score;
}

/** The hand name as it reads inside a sentence: "a flush, ace high", "two pair, kings and sevens". */
export function inSentence(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  if (/^(pair|straight|flush|full house|royal)/.test(lower)) return `a ${lower}`;
  return lower;
}
