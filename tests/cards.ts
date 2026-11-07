// Parses card lists for tests: "AS KH 10D 2C". A bare rank is a spade.

import type { Card, Rank, Suit } from '../shared/types.js';

export function cards(text: string): Card[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const last = token.slice(-1);
      const hasSuit = 'SHDC'.includes(last) && token.length > 1;
      const suit = (hasSuit ? last : 'S') as Suit;
      const rank = (hasSuit ? token.slice(0, -1) : token) as Rank;
      return { rank, suit };
    });
}

export const show = (list: Card[]): string => list.map((c) => `${c.rank}${c.suit}`).join(' ');
