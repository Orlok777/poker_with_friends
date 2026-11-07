import { describe, expect, it } from 'vitest';
import { bestHand, CATEGORY } from '../server/hand.js';
import type { Card, Rank, Suit } from '../shared/types.js';
import { RANKINGS, rankingKey, rulesGroups, type RankingKey } from '../client/guideContent.js';

const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

/** The ranking row each evaluator category belongs to (a royal flush is a straight flush that tops out at an ace). */
function expectedKey(category: number, high: number): RankingKey {
  switch (category) {
    case CATEGORY.straightFlush:
      return high === 14 ? 'royalFlush' : 'straightFlush';
    case CATEGORY.four:
      return 'four';
    case CATEGORY.fullHouse:
      return 'fullHouse';
    case CATEGORY.flush:
      return 'flush';
    case CATEGORY.straight:
      return 'straight';
    case CATEGORY.three:
      return 'three';
    case CATEGORY.twoPair:
      return 'twoPair';
    case CATEGORY.pair:
      return 'pair';
    default:
      return 'highCard';
  }
}

describe('hand rankings list', () => {
  it('lists every hand category the evaluator has, best first', () => {
    const scores = RANKINGS.map((r) => bestHand(r.example).score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    // Nine categories, and the royal flush as the top of the straight flushes.
    const categories = new Set(RANKINGS.map((r) => bestHand(r.example).category));
    expect([...categories].sort()).toEqual(Object.values(CATEGORY).sort());
    expect(RANKINGS).toHaveLength(Object.keys(CATEGORY).length + 1);
    expect(RANKINGS.map((r) => r.key)).toEqual([
      'royalFlush', 'straightFlush', 'four', 'fullHouse', 'flush', 'straight', 'three', 'twoPair', 'pair', 'highCard',
    ]);
  });

  it('shows five cards that make exactly the hand named, with the name the evaluator prints', () => {
    for (const row of RANKINGS) {
      expect(row.example).toHaveLength(5);
      const best = bestHand(row.example);
      expect(row.name).toBe(best.name);
      expect(rankingKey(best.name)).toBe(row.key);
      expect(expectedKey(best.category, best.values[0]!)).toBe(row.key);
    }
    expect(RANKINGS.map((r) => r.name)).toEqual([
      'Royal flush',
      'Straight flush, nine high',
      'Four nines',
      'Full house, kings over sevens',
      'Flush, ace high',
      'Straight, ten high',
      'Three sevens',
      'Two pair, aces and sevens',
      'Pair of kings',
      'High card, ace',
    ]);
  });

  it('uses five different cards in every example', () => {
    for (const row of RANKINGS) {
      const keys = new Set(row.example.map((c) => `${c.rank}${c.suit}`));
      expect(keys.size).toBe(5);
    }
  });
});

describe('rankingKey', () => {
  it('maps every name the evaluator can print to the same row as its category', () => {
    // A deterministic spread of hands, plus every rank of each pattern so every name form is seen.
    let seed = 12345;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const deck: Card[] = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
    const seen = new Set<RankingKey>();
    for (let n = 0; n < 4000; n++) {
      const pool = [...deck];
      const seven: Card[] = [];
      for (let i = 0; i < 7; i++) seven.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
      const best = bestHand(seven);
      const key = rankingKey(best.name);
      expect(key, best.name).toBe(expectedKey(best.category, best.values[0]!));
      seen.add(key!);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  it('maps every straight flush, including the royal flush and the steel wheel', () => {
    const flushOf = (ranks: Rank[]) => ranks.map((rank) => ({ rank, suit: 'H' as Suit }));
    const runs: Rank[][] = [['A', '2', '3', '4', '5']];
    for (let top = 4; top < RANKS.length; top++) runs.push(RANKS.slice(top - 4, top + 1));
    for (const run of runs) {
      const best = bestHand(flushOf(run));
      expect(rankingKey(best.name), best.name).toBe(run.includes('K') && run.includes('A') ? 'royalFlush' : 'straightFlush');
    }
  });

  it('knows nothing about names that are not hands', () => {
    expect(rankingKey(null)).toBeNull();
    expect(rankingKey(undefined)).toBeNull();
    expect(rankingKey('')).toBeNull();
    expect(rankingKey('Folded')).toBeNull();
  });
});

describe('rules text', () => {
  const text = (sb: number, bb: number) =>
    rulesGroups({ smallBlind: sb, bigBlind: bb })
      .flatMap((g) => [g.title, ...g.items.flatMap((i) => [i.term, i.text])])
      .join('\n');

  it('takes the blinds from the table settings', () => {
    const a = text(5, 10);
    expect(a).toContain('small blind (5)');
    expect(a).toContain('big blind (10)');
    expect(a).toContain('10, the big blind');
    const b = text(25, 50);
    expect(b).toContain('small blind (25)');
    expect(b).toContain('big blind (50)');
    expect(b).toContain('50, the big blind');
    expect(b).not.toContain('(10)');
  });

  it('covers the topics the spec lists', () => {
    const t = text(5, 10);
    for (const word of ['Preflop', 'Flop', 'Turn', 'River', 'Fold', 'Check', 'Call', 'Bet', 'Raise to 60', 'Minimum raise', 'All in', 'Side pots', 'Showdown']) {
      expect(t).toContain(word);
    }
    expect(t).toContain('60 in total in front of you this round');
    // The spec has no keyboard shortcuts, so the text must not teach any.
    expect(t).toContain('no keyboard shortcuts');
  });

  it('says nothing about odds or what to do', () => {
    const t = text(5, 10).toLowerCase();
    for (const word of ['odds', 'equity', 'should', 'strategy', 'probability']) expect(t).not.toContain(word);
  });
});
