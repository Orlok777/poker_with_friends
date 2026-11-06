import { randomInt } from 'node:crypto';
import { RANKS, SUITS, type Card } from '../shared/types.js';

/** Returns a function giving floats in [0, 1). The same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator seeded from the operating system's randomness. */
export function randomSeed(): number {
  return randomInt(0, 2 ** 32);
}

export function buildDecks(decks: number): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push({ rank, suit });
    }
  }
  return cards;
}

/** Fisher–Yates shuffle, in place. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export const RESHUFFLE_AT = 0.75;

export class Shoe {
  private cards: Card[] = [];
  private total = 0;
  private rigged: Card[];
  /** Set to true when `draw` had to build a fresh shoe because it ran dry. The caller clears it. */
  autoReshuffled = false;

  /**
   * @param rigged cards that will be drawn first, in order. For tests only; a reshuffle discards them.
   */
  constructor(
    private readonly decks: number,
    private readonly rng: () => number,
    rigged: Card[] = [],
  ) {
    this.shuffle();
    this.rigged = [...rigged];
  }

  /** Builds a fresh shuffled shoe, optionally leaving out cards that are currently on the table. */
  shuffle(inPlay: Card[] = []): void {
    const cards = buildDecks(this.decks);
    for (const used of inPlay) {
      const i = cards.findIndex((c) => c.rank === used.rank && c.suit === used.suit);
      if (i >= 0) cards.splice(i, 1);
    }
    shuffle(cards, this.rng);
    this.cards = cards;
    this.total = cards.length;
    this.rigged = [];
  }

  /** Cards left before the shoe is empty. */
  get remaining(): number {
    return this.cards.length;
  }

  /** Fraction of the shoe that has been dealt, from 0 to 1. */
  get dealtFraction(): number {
    return this.total === 0 ? 1 : 1 - this.cards.length / this.total;
  }

  needsReshuffle(): boolean {
    return this.dealtFraction >= RESHUFFLE_AT;
  }

  /**
   * Draws one card. If the shoe is empty, builds a new shoe from the cards not in `inPlay`
   * and sets `autoReshuffled`.
   */
  draw(inPlay: Card[] = []): Card {
    const rigged = this.rigged.shift();
    if (rigged) return rigged;
    if (this.cards.length === 0) {
      this.shuffle(inPlay);
      this.autoReshuffled = true;
    }
    return this.cards.pop()!;
  }
}
