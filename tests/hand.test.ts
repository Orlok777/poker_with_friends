import { describe, expect, it } from 'vitest';
import { CATEGORY, bestHand, compareHands, inSentence, rankFive } from '../server/hand.js';
import { cards, show } from './cards.js';

const best = (text: string) => bestHand(cards(text));
const cmp = (a: string, b: string) => Math.sign(compareHands(best(a), best(b)));

describe('hand categories and names', () => {
  const cases: [string, number, string][] = [
    ['AS KD 9H 7C 3S', CATEGORY.highCard, 'High card, ace'],
    ['KS KD 9H 7C 3S', CATEGORY.pair, 'Pair of kings'],
    ['AS AD 7H 7C 3S', CATEGORY.twoPair, 'Two pair, aces and sevens'],
    ['7S 7D 7H KC 3S', CATEGORY.three, 'Three sevens'],
    ['10S 9D 8H 7C 6S', CATEGORY.straight, 'Straight, ten high'],
    ['AH JH 9H 4H 2H', CATEGORY.flush, 'Flush, ace high'],
    ['KS KD KH 7C 7S', CATEGORY.fullHouse, 'Full house, kings over sevens'],
    ['9S 9D 9H 9C 3S', CATEGORY.four, 'Four nines'],
    ['9H 8H 7H 6H 5H', CATEGORY.straightFlush, 'Straight flush, nine high'],
    ['AS KS QS JS 10S', CATEGORY.straightFlush, 'Royal flush'],
    ['6S 6D 2H 4C 9S', CATEGORY.pair, 'Pair of sixes'],
  ];
  for (const [hand, category, name] of cases) {
    it(`${hand} is ${name}`, () => {
      const r = best(hand);
      expect(r.category).toBe(category);
      expect(r.name).toBe(name);
      expect(r.cards).toHaveLength(5);
    });
  }

  it('ranks the categories in order', () => {
    const order = cases.slice(0, 10).map(([hand]) => best(hand).score);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]!);
  });

  it('names hands of fewer than five cards (hole cards before the flop)', () => {
    expect(best('7S 7D').name).toBe('Pair of sevens');
    expect(best('AS 4D').name).toBe('High card, ace');
    expect(best('QS QD QH 2C').name).toBe('Three queens');
  });

  it('puts hand names into sentences', () => {
    expect(inSentence('Flush, ace high')).toBe('a flush, ace high');
    expect(inSentence('Two pair, kings and sevens')).toBe('two pair, kings and sevens');
    expect(inSentence('Pair of kings')).toBe('a pair of kings');
    expect(inSentence('Royal flush')).toBe('a royal flush');
    expect(inSentence('Three sevens')).toBe('three sevens');
    expect(inSentence('High card, ace')).toBe('high card, ace');
  });
});

describe('kickers and ties', () => {
  it('breaks ties with kickers, up to five cards', () => {
    expect(cmp('AS AD KH 7C 3S', 'AH AC QH JC 10S')).toBe(1);
    expect(cmp('AS KD 9H 7C 4S', 'AH KC 9D 7S 3S')).toBe(1);
    expect(cmp('KS KD 7H 7C AS', 'KH KC 7D 7S QS')).toBe(1);
    expect(cmp('7S 7D 7H AC 2S', '7H 7C 7D KS QS')).toBe(1);
    expect(cmp('9S 9D 9H 9C AS', '9H 9C 9D 9S KS')).toBe(1);
  });

  it('compares full houses by the three first, then the pair', () => {
    expect(cmp('KS KD KH 2C 2S', 'QS QD QH AC AS')).toBe(1);
    expect(cmp('KS KD KH 9C 9S', 'KS KD KH 8C 8S')).toBe(1);
  });

  it('compares flushes card by card', () => {
    expect(cmp('AH JH 9H 4H 3H', 'AS JS 9S 4S 2S')).toBe(1);
  });

  it('treats equal hands as an exact tie: suits never break ties', () => {
    expect(cmp('AS KD 9H 7C 3S', 'AH KC 9D 7S 3D')).toBe(0);
    expect(cmp('10S 9D 8H 7C 6S', '10H 9C 8D 7S 6D')).toBe(0);
    expect(cmp('AH JH 9H 4H 2H', 'AS JS 9S 4S 2S')).toBe(0);
  });

  it('ignores cards beyond the best five', () => {
    // Both make aces with K Q J kickers; the sixth and seventh cards do not count.
    expect(cmp('AS AD KH QC JS 3D 2C', 'AH AC KD QS JD 9H 8S')).toBe(0);
  });
});

describe('straights', () => {
  it('counts the wheel A-2-3-4-5 as five high, below a six-high straight', () => {
    const wheel = best('AS 2D 3H 4C 5S');
    expect(wheel.category).toBe(CATEGORY.straight);
    expect(wheel.name).toBe('Straight, five high');
    expect(show(wheel.cards)).toBe('5S 4C 3H 2D AS');
    expect(cmp('6S 2D 3H 4C 5S', 'AS 2D 3H 4C 5S')).toBe(1);
  });

  it('counts the steel wheel as a straight flush, five high', () => {
    const r = best('AH 2H 3H 4H 5H');
    expect(r.category).toBe(CATEGORY.straightFlush);
    expect(r.name).toBe('Straight flush, five high');
  });

  it('has no wraparound straights', () => {
    expect(best('QS KD AH 2C 3S').category).toBe(CATEGORY.highCard);
    expect(best('KS AD 2H 3C 4S').category).toBe(CATEGORY.highCard);
  });

  it('takes the highest straight from six connected cards', () => {
    expect(best('5S 6D 7H 8C 9S 10D 2C').name).toBe('Straight, ten high');
  });

  it('ace high straight beats king high', () => {
    expect(cmp('AS KD QH JC 10S', 'KS QD JH 10C 9S')).toBe(1);
  });
});

describe('best five of seven', () => {
  it('finds a flush hidden among seven cards', () => {
    const r = best('2H 7H KS QH 9H 4H 4S');
    expect(r.name).toBe('Flush, queen high');
    expect(r.cards.every((c) => c.suit === 'H')).toBe(true);
  });

  it('prefers a straight flush over a plain flush and four of a kind', () => {
    expect(best('9H 8H 7H 6H 5H AH 9S').name).toBe('Straight flush, nine high');
    expect(best('9H 8H 7H 6H 5H 9S 9D').name).toBe('Straight flush, nine high');
  });

  it('makes a full house from two sets of three', () => {
    expect(best('KS KD KH 7C 7S 7D 2C').name).toBe('Full house, kings over sevens');
  });

  it('uses the best two pair out of three pairs, with the best kicker', () => {
    const r = best('AS AD 7H 7C 3S 3D KC');
    expect(r.name).toBe('Two pair, aces and sevens');
    expect(r.values).toEqual([14, 7, 13]);
  });

  it('lets the board play, so both players split', () => {
    const board = 'AS KD QH JC 10S';
    expect(cmp(`2C 3D ${board}`, `4C 5D ${board}`)).toBe(0);
    // An ace in the hand does not improve the board's ace-high straight either.
    expect(cmp(`AH 3D ${board}`, `4C 5D ${board}`)).toBe(0);
  });

  it('uses a hole card when it beats the board', () => {
    expect(cmp('2C 3D 9S 9D 9H 5C 2S', '4C 5D 9S 9D 9H 5C 2S')).toBe(-1);
  });

  it('returns the five cards that make the hand', () => {
    const r = best('7S 7D KH 2C 9S 4D 3C');
    expect(show(r.cards)).toBe('7S 7D KH 9S 4D');
  });

  it('ranks exactly five cards the same as bestHand', () => {
    const five = cards('KS KD 9H 7C 3S');
    expect(rankFive(five).score).toBe(bestHand(five).score);
  });
});
