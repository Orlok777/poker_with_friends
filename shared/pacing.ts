// How long the table takes to reveal cards. The browser plays these timings and the server uses the same
// numbers to know how long to wait before it moves on, so both sides stay in step.

export const PACING = {
  /** Between the three cards of the flop flipping. */
  flopGapMs: 500,
  /** One card flipping over. */
  flipMs: 350,
  /** A beat before a turn or river card flips. */
  beatMs: 600,
  /** Pause between streets when several are shown one after the other (an all-in runout). */
  streetGapMs: 1000,
  /** Between hands flipping at showdown, one player at a time. */
  handGapMs: 800,
  /** A beat once the hands are face up, before the winner is lit. */
  afterHandsMs: 600,
} as const;

/** Delay before the first card of a street flips: none for the flop, a beat for the turn and river. */
export function leadMs(cards: number): number {
  return cards >= 3 ? 0 : PACING.beatMs;
}

/** From a street's state arriving until its last card has flipped; `cards` is 3 for the flop, else 1. */
export function streetRevealMs(cards: number): number {
  if (cards <= 0) return 0;
  return leadMs(cards) + (cards - 1) * PACING.flopGapMs + PACING.flipMs;
}

/** From the first hand starting to flip until the last one is face up. */
export function handsRevealMs(hands: number): number {
  return hands <= 0 ? 0 : (hands - 1) * PACING.handGapMs + PACING.flipMs;
}

/** The board streets as [first card, card count]: the flop, the turn and the river. */
export const STREETS: readonly (readonly [number, number])[] = [
  [0, 3],
  [3, 1],
  [4, 1],
];
