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
  /** Between hands flipping on their seats in an all-in runout, one player at a time. */
  handGapMs: 800,
} as const;

// ---------------------------------------------------------------- showdown spotlight

/** The drumroll before the first player's cards fly to the middle. */
export const DRUMROLL_MS = 1000;
/** One flight: a player's cards from their seat to the spotlight spot, or back. */
export const FLIGHT_MS = 450;
/** How long the next player's cards fly in while the previous ones are still flying back (half a flight). */
export const FLIGHT_OVERLAP_MS = FLIGHT_MS / 2;
/** How long each player's hand is held in the spotlight with its name. */
export const SPOTLIGHT_MS = 2000;

/** From one player's cards starting to fly in until the next player's start: in, hold, out, less the overlap. */
export const SPOTLIGHT_STRIDE_MS = FLIGHT_MS + SPOTLIGHT_MS + FLIGHT_MS - FLIGHT_OVERLAP_MS;

/** One player's whole turn: fly in, hold, fly back. */
export const SPOTLIGHT_TURN_MS = FLIGHT_MS + SPOTLIGHT_MS + FLIGHT_MS;

/**
 * The drumroll and the spotlight for every hand at a showdown, from the drumroll starting until the last
 * player's cards are back on their seat. Every hand takes a turn, the viewer's own included, so everyone
 * sees the same sequence. Nothing happens with fewer than two hands.
 */
export function spotlightSequenceMs(hands: number): number {
  if (hands < 2) return 0;
  return DRUMROLL_MS + (hands - 1) * SPOTLIGHT_STRIDE_MS + SPOTLIGHT_TURN_MS;
}

// ------------------------------------------------------------------------ board

/** Delay before the first card of a street flips: none for the flop, a beat for the turn and river. */
export function leadMs(cards: number): number {
  return cards >= 3 ? 0 : PACING.beatMs;
}

/** From a street's state arriving until its last card has flipped; `cards` is 3 for the flop, else 1. */
export function streetRevealMs(cards: number): number {
  if (cards <= 0) return 0;
  return leadMs(cards) + (cards - 1) * PACING.flopGapMs + PACING.flipMs;
}

/** From the first hand starting to flip on its seat until the last one is face up (all-in runout). */
export function handsRevealMs(hands: number): number {
  return hands <= 0 ? 0 : (hands - 1) * PACING.handGapMs + PACING.flipMs;
}

/** The board streets as [first card, card count]: the flop, the turn and the river. */
export const STREETS: readonly (readonly [number, number])[] = [
  [0, 3],
  [3, 1],
  [4, 1],
];
