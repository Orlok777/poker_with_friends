import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../shared/types.js';
import { DEFAULT_SETTINGS, validateSettings } from '../shared/types.js';
import { Shoe, mulberry32 } from '../server/deck.js';
import {
  blackjackWinnings,
  canDouble,
  dealerShouldHit,
  describeHand,
  handValue,
  isBlackjack,
  settleHand,
} from '../server/game.js';

/** Builds cards from short text like "A K 7" (all spades, which does not matter for the rules). */
function hand(text: string): Card[] {
  return text.split(' ').map((rank) => ({ rank: rank as Rank, suit: 'S' as Suit }));
}

describe('handValue', () => {
  it('counts number cards and face cards', () => {
    expect(handValue(hand('7 9'))).toEqual({ total: 16, soft: false });
    expect(handValue(hand('K Q'))).toEqual({ total: 20, soft: false });
  });

  it('counts an ace as 11 when that does not bust (soft)', () => {
    expect(handValue(hand('A 6'))).toEqual({ total: 17, soft: true });
    expect(handValue(hand('A 7 3'))).toEqual({ total: 21, soft: true });
  });

  it('counts an ace as 1 when 11 would bust (hard)', () => {
    expect(handValue(hand('A 6 10'))).toEqual({ total: 17, soft: false });
    expect(handValue(hand('A 9 5'))).toEqual({ total: 15, soft: false });
  });

  it('handles several aces', () => {
    expect(handValue(hand('A A'))).toEqual({ total: 12, soft: true });
    expect(handValue(hand('A A A'))).toEqual({ total: 13, soft: true });
    expect(handValue(hand('A A 9'))).toEqual({ total: 21, soft: true });
    expect(handValue(hand('A A 10'))).toEqual({ total: 12, soft: false });
  });

  it('reports a soft hand turning hard after another card', () => {
    expect(handValue(hand('A 6'))).toEqual({ total: 17, soft: true });
    expect(handValue(hand('A 6 5'))).toEqual({ total: 12, soft: false });
  });

  it('reports the real total of a busted hand', () => {
    expect(handValue(hand('10 9 5'))).toEqual({ total: 24, soft: false });
  });

  it('describes soft hands for the UI', () => {
    expect(describeHand(hand('A 6'))).toBe('soft 17');
    expect(describeHand(hand('10 7'))).toBe('17');
    expect(describeHand(hand('A K'))).toBe('Blackjack');
    expect(describeHand(hand('10 9 5'))).toBe('24 (bust)');
  });
});

describe('isBlackjack', () => {
  it('is an ace plus a 10-value card as the first two cards', () => {
    expect(isBlackjack(hand('A K'))).toBe(true);
    expect(isBlackjack(hand('10 A'))).toBe(true);
    expect(isBlackjack(hand('A J'))).toBe(true);
  });

  it('is not 21 made with three cards', () => {
    expect(isBlackjack(hand('7 7 7'))).toBe(false);
    expect(isBlackjack(hand('A 5 5'))).toBe(false);
  });

  it('is not other two-card hands', () => {
    expect(isBlackjack(hand('A 9'))).toBe(false);
    expect(isBlackjack(hand('K Q'))).toBe(false);
    expect(isBlackjack(hand('A A'))).toBe(false);
  });
});

describe('dealerShouldHit', () => {
  it('hits 16 and below and stands on hard 17 or more', () => {
    expect(dealerShouldHit(hand('10 6'), false)).toBe(true);
    expect(dealerShouldHit(hand('10 7'), false)).toBe(false);
    expect(dealerShouldHit(hand('10 7'), true)).toBe(false);
    expect(dealerShouldHit(hand('10 9'), true)).toBe(false);
  });

  it('stands on soft 17 when the rule is stand', () => {
    expect(dealerShouldHit(hand('A 6'), false)).toBe(false);
  });

  it('hits soft 17 when the rule is hit', () => {
    expect(dealerShouldHit(hand('A 6'), true)).toBe(true);
    expect(dealerShouldHit(hand('A 2 4'), true)).toBe(true);
  });

  it('stands on soft 18 or more under either rule', () => {
    expect(dealerShouldHit(hand('A 7'), true)).toBe(false);
    expect(dealerShouldHit(hand('A 7'), false)).toBe(false);
  });

  it('hits a hand that was soft 17 but turned hard 17 never, and hits hard 16', () => {
    // A 6 10 is hard 17: stands even when the dealer hits soft 17.
    expect(dealerShouldHit(hand('A 6 10'), true)).toBe(false);
    expect(dealerShouldHit(hand('A 5 10'), true)).toBe(true);
  });
});

describe('canDouble', () => {
  it('is never allowed when the rule is off', () => {
    expect(canDouble(hand('5 6'), 'off', 1000, 10)).toBe(false);
  });

  it('allows any two cards under the "any" rule', () => {
    expect(canDouble(hand('2 3'), 'any', 1000, 10)).toBe(true);
    expect(canDouble(hand('A 5'), 'any', 1000, 10)).toBe(true);
    expect(canDouble(hand('K 9'), 'any', 1000, 10)).toBe(true);
  });

  it('allows only hard 9, 10 and 11 under the 9-11 rule', () => {
    expect(canDouble(hand('4 5'), '9-11', 1000, 10)).toBe(true);
    expect(canDouble(hand('4 6'), '9-11', 1000, 10)).toBe(true);
    expect(canDouble(hand('5 6'), '9-11', 1000, 10)).toBe(true);
    expect(canDouble(hand('4 4'), '9-11', 1000, 10)).toBe(false);
    expect(canDouble(hand('5 7'), '9-11', 1000, 10)).toBe(false);
    expect(canDouble(hand('A 8'), '9-11', 1000, 10)).toBe(false);
  });

  it('is only allowed on the first two cards', () => {
    expect(canDouble(hand('3 3 4'), 'any', 1000, 10)).toBe(false);
  });

  it('needs enough chips to match the original bet', () => {
    expect(canDouble(hand('5 6'), 'any', 9, 10)).toBe(false);
    expect(canDouble(hand('5 6'), 'any', 10, 10)).toBe(true);
  });
});

describe('payouts', () => {
  it('pays blackjack 3:2 and 6:5', () => {
    expect(blackjackWinnings(100, '3:2')).toBe(150);
    expect(blackjackWinnings(100, '6:5')).toBe(120);
  });

  it('rounds odd blackjack winnings down', () => {
    expect(blackjackWinnings(25, '3:2')).toBe(37);
    expect(blackjackWinnings(25, '6:5')).toBe(30);
  });
});

describe('settleHand', () => {
  it('pays a win 1:1', () => {
    expect(settleHand(hand('10 9'), hand('10 8'), 100, '3:2')).toEqual({ outcome: 'win', delta: 100 });
  });

  it('takes a loss', () => {
    expect(settleHand(hand('10 7'), hand('10 8'), 100, '3:2')).toEqual({ outcome: 'loss', delta: -100 });
  });

  it('returns the bet on a push', () => {
    expect(settleHand(hand('10 8'), hand('9 9'), 100, '3:2')).toEqual({ outcome: 'push', delta: 0 });
  });

  it('pays player blackjack 3:2 or 6:5', () => {
    expect(settleHand(hand('A K'), hand('10 9'), 100, '3:2')).toEqual({ outcome: 'blackjack', delta: 150 });
    expect(settleHand(hand('A K'), hand('10 9'), 100, '6:5')).toEqual({ outcome: 'blackjack', delta: 120 });
  });

  it('pushes when both have blackjack', () => {
    expect(settleHand(hand('A K'), hand('A Q'), 100, '3:2')).toEqual({ outcome: 'push', delta: 0 });
  });

  it('beats a dealer 21 made with three cards with blackjack', () => {
    expect(settleHand(hand('A K'), hand('7 7 7'), 100, '3:2').outcome).toBe('blackjack');
  });

  it('loses a non-blackjack 21 to a dealer blackjack', () => {
    expect(settleHand(hand('7 7 7'), hand('A K'), 100, '3:2')).toEqual({ outcome: 'loss', delta: -100 });
  });

  it('pushes a three-card 21 against a three-card 21', () => {
    expect(settleHand(hand('7 7 7'), hand('5 6 K'), 100, '3:2').outcome).toBe('push');
  });

  it('loses a bust even when the dealer busts too', () => {
    expect(settleHand(hand('10 9 5'), hand('10 6 8'), 100, '3:2')).toEqual({ outcome: 'loss', delta: -100 });
  });

  it('wins when the dealer busts', () => {
    expect(settleHand(hand('10 2'), hand('10 6 8'), 100, '3:2')).toEqual({ outcome: 'win', delta: 100 });
  });

  it('settles a doubled hand on the doubled bet', () => {
    // bet 100 doubled to 200 total at risk
    expect(settleHand(hand('5 6 10'), hand('10 8'), 200, '3:2')).toEqual({ outcome: 'win', delta: 200 });
    expect(settleHand(hand('5 6 2'), hand('10 8'), 200, '3:2')).toEqual({ outcome: 'loss', delta: -200 });
  });
});

describe('Shoe', () => {
  it('holds the right number of cards', () => {
    expect(new Shoe(5, mulberry32(1)).remaining).toBe(260);
    expect(new Shoe(1, mulberry32(1)).remaining).toBe(52);
    expect(new Shoe(8, mulberry32(1)).remaining).toBe(416);
  });

  it('deals the same cards for the same seed and different cards for another seed', () => {
    const draw = (seed: number) => {
      const shoe = new Shoe(2, mulberry32(seed));
      return Array.from({ length: 20 }, () => shoe.draw());
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it('contains every card exactly the right number of times', () => {
    const shoe = new Shoe(3, mulberry32(7));
    const counts = new Map<string, number>();
    while (shoe.remaining > 0) {
      const c = shoe.draw();
      const key = `${c.rank}${c.suit}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    for (const n of counts.values()) expect(n).toBe(3);
  });

  it('asks for a reshuffle once 75% of the shoe is dealt', () => {
    const shoe = new Shoe(1, mulberry32(3)); // 52 cards, 75% = 39
    for (let i = 0; i < 38; i++) shoe.draw();
    expect(shoe.needsReshuffle()).toBe(false);
    shoe.draw(); // 39th card
    expect(shoe.needsReshuffle()).toBe(true);
    shoe.shuffle();
    expect(shoe.needsReshuffle()).toBe(false);
    expect(shoe.remaining).toBe(52);
  });

  it('deals rigged cards first, in order', () => {
    const rigged = hand('A K 5');
    const shoe = new Shoe(1, mulberry32(9), rigged);
    expect([shoe.draw(), shoe.draw(), shoe.draw()]).toEqual(rigged);
  });

  it('builds a new shoe without the cards in play when it runs dry', () => {
    const shoe = new Shoe(1, mulberry32(5));
    const dealt: Card[] = [];
    while (shoe.remaining > 0) dealt.push(shoe.draw());
    const onTable = dealt.slice(0, 10);
    const next = shoe.draw(onTable);
    expect(shoe.autoReshuffled).toBe(true);
    expect(shoe.remaining).toBe(52 - 10 - 1);
    expect(onTable.some((c) => c.rank === next.rank && c.suit === next.suit)).toBe(false);
  });
});

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toBeNull();
  });

  it('rejects values outside the allowed ranges', () => {
    const bad = (patch: Partial<typeof DEFAULT_SETTINGS>) => validateSettings({ ...DEFAULT_SETTINGS, ...patch });
    expect(bad({ maxPlayers: 0 })).not.toBeNull();
    expect(bad({ maxPlayers: 8 })).not.toBeNull();
    expect(bad({ decks: 9 })).not.toBeNull();
    expect(bad({ startingChips: 50 })).not.toBeNull();
    expect(bad({ minBet: 0 })).not.toBeNull();
    expect(bad({ minBet: 600 })).not.toBeNull();
    expect(bad({ maxBet: 2000 })).not.toBeNull();
    expect(bad({ bettingSeconds: 5 })).not.toBeNull();
    expect(bad({ turnSeconds: 5 })).not.toBeNull();
    expect(bad({ turnSeconds: null })).toBeNull();
    expect(bad({ maxPlayers: 1.5 })).not.toBeNull();
  });
});
