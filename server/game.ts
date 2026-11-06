// Pure blackjack rules. No networking, no timers, no randomness.

import type { BlackjackPayout, Card, DoubleRule, Outcome, Rank } from '../shared/types.js';

export interface HandValue {
  /** Best total that does not bust, or the lowest total if every count busts. */
  total: number;
  /** True when an ace is currently counted as 11. */
  soft: boolean;
}

export function rankValue(rank: Rank): number {
  if (rank === 'A') return 11;
  if (rank === 'K' || rank === 'Q' || rank === 'J' || rank === '10') return 10;
  return Number(rank);
}

export function handValue(cards: readonly Card[]): HandValue {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += rankValue(card.rank);
    if (card.rank === 'A') aces++;
  }
  // An ace counts 11 unless that would bust the hand, in which case it counts 1.
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export function isTenValue(card: Card): boolean {
  return rankValue(card.rank) === 10;
}

/** Blackjack is an ace plus a 10-value card as the first two cards. */
export function isBlackjack(cards: readonly Card[]): boolean {
  if (cards.length !== 2) return false;
  const [a, b] = cards as [Card, Card];
  return (a.rank === 'A' && isTenValue(b)) || (b.rank === 'A' && isTenValue(a));
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).total > 21;
}

/** Text shown by the UI, for example "17", "soft 17" or "BUST". */
export function describeHand(cards: readonly Card[]): string {
  if (cards.length === 0) return '';
  if (isBlackjack(cards)) return 'Blackjack';
  const { total, soft } = handValue(cards);
  if (total > 21) return `${total} (bust)`;
  return soft ? `soft ${total}` : `${total}`;
}

/**
 * Whether a player may double: first two cards only, rule allows it, and the chips cover the extra bet.
 * `fromSplit` hands can be doubled too (double after split); an ace and a ten there is a plain 21, not a blackjack.
 */
export function canDouble(
  cards: readonly Card[],
  rule: DoubleRule,
  chips: number,
  bet: number,
  fromSplit = false,
): boolean {
  if (rule === 'off') return false;
  if (cards.length !== 2) return false;
  if (chips < bet) return false;
  if (!fromSplit && isBlackjack(cards)) return false;
  if (rule === 'any') return true;
  // "9 to 11 only" means a hard total of 9, 10 or 11.
  const { total, soft } = handValue(cards);
  return !soft && total >= 9 && total <= 11;
}

/**
 * Whether a player may split: the setting is on, they have exactly two cards of the same value
 * (any two 10-value cards count), they have not split yet, and the chips cover a second bet.
 */
export function canSplit(
  cards: readonly Card[],
  allowed: boolean,
  chips: number,
  bet: number,
  alreadySplit: boolean,
): boolean {
  if (!allowed || alreadySplit) return false;
  if (cards.length !== 2) return false;
  if (chips < bet) return false;
  const [a, b] = cards as [Card, Card];
  return rankValue(a.rank) === rankValue(b.rank);
}

/** Dealer draws on 16 or less, and on soft 17 only when the table rule says so. */
export function dealerShouldHit(cards: readonly Card[], hitsSoft17: boolean): boolean {
  const { total, soft } = handValue(cards);
  if (total < 17) return true;
  if (total === 17 && soft && hitsSoft17) return true;
  return false;
}

/** A hand that needs no further decisions: 21 (including blackjack) or bust. */
export function isHandFinished(cards: readonly Card[]): boolean {
  return handValue(cards).total >= 21;
}

export function blackjackWinnings(bet: number, payout: BlackjackPayout): number {
  // Chips are whole numbers, so odd bets round the winnings down.
  return payout === '3:2' ? Math.floor((bet * 3) / 2) : Math.floor((bet * 6) / 5);
}

export interface Settlement {
  outcome: Outcome;
  /** Net chip change for the player: positive for a win, negative for a loss, 0 for a push. */
  delta: number;
}

/**
 * Settles one finished player hand against the finished dealer hand.
 * `bet` is the total at risk, so it is already doubled for a doubled hand.
 * A hand made by a split (`fromSplit`) can never be a blackjack: its 21 is a normal 21 and pays 1:1.
 */
export function settleHand(
  player: readonly Card[],
  dealer: readonly Card[],
  bet: number,
  payout: BlackjackPayout,
  fromSplit = false,
): Settlement {
  // A player who busts loses at once, even if the dealer busts later.
  if (isBust(player)) return { outcome: 'loss', delta: -bet };

  const playerBj = !fromSplit && isBlackjack(player);
  const dealerBj = isBlackjack(dealer);

  if (playerBj && dealerBj) return { outcome: 'push', delta: 0 };
  if (playerBj) return { outcome: 'blackjack', delta: blackjackWinnings(bet, payout) };
  if (dealerBj) return { outcome: 'loss', delta: -bet };

  const p = handValue(player).total;
  const d = handValue(dealer).total;
  if (d > 21) return { outcome: 'win', delta: bet };
  if (p > d) return { outcome: 'win', delta: bet };
  if (p < d) return { outcome: 'loss', delta: -bet };
  return { outcome: 'push', delta: 0 };
}
