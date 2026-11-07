import { randomBytes } from 'node:crypto';
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

/** A fresh seed from the operating system's randomness. */
export function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}

/** The 52 cards in a fixed order. */
export function fullDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) cards.push({ rank, suit });
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

const same = (a: Card, b: Card) => a.rank === b.rank && a.suit === b.suit;

/** One 52-card deck, shuffled once, for one hand. */
export class Deck {
  private readonly cards: Card[];

  /**
   * @param rigged cards dealt first, in this order. For tests only. They are taken out of the
   * shuffled rest, so the deck never holds a card twice.
   */
  constructor(rng: () => number, rigged: Card[] = []) {
    const rest = shuffle(
      fullDeck().filter((c) => !rigged.some((r) => same(r, c))),
      rng,
    );
    // draw() pops from the end, so the rigged cards go last, reversed.
    this.cards = [...rest, ...[...rigged].reverse()];
  }

  get remaining(): number {
    return this.cards.length;
  }

  draw(): Card {
    const card = this.cards.pop();
    if (!card) throw new Error('The deck is empty');
    return card;
  }
}
