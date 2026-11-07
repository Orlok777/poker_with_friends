import { describe, expect, it } from 'vitest';
import { PACING, handsRevealMs, leadMs, streetRevealMs } from '../shared/pacing.js';
import { lastPushedPot } from '../shared/types.js';
import { DEFAULT_TIMING, FOLD_WIN_PAUSE_MS, RESULT_LOOK_MS, showdownPlan } from '../server/table.js';

describe('reveal pacing', () => {
  it('flips the flop card by card, and gives the turn and river a beat first', () => {
    expect(leadMs(3)).toBe(0);
    expect(leadMs(1)).toBe(PACING.beatMs);
    // Three cards 500 ms apart, the last flip taking 350 ms.
    expect(streetRevealMs(3)).toBe(500 + 500 + 350);
    expect(streetRevealMs(1)).toBe(600 + 350);
    expect(streetRevealMs(0)).toBe(0);
  });

  it('flips the hands one player at a time, 800 ms apart', () => {
    expect(handsRevealMs(0)).toBe(0);
    expect(handsRevealMs(1)).toBe(350);
    expect(handsRevealMs(2)).toBe(800 + 350);
    expect(handsRevealMs(6)).toBe(5 * 800 + 350);
  });

  it('works out the showdown pause in one place', () => {
    // Heads-up, the board is already out: 2 hands flip, a beat, then 3 s to look.
    const two = showdownPlan(0, 2);
    expect(two.firstPotMs).toBe(1150 + PACING.afterHandsMs);
    expect(two.totalMs).toBe(1750 + RESULT_LOOK_MS);
    // Six players at showdown.
    const six = showdownPlan(0, 6);
    expect(six.totalMs).toBe(4350 + 600 + RESULT_LOOK_MS);
    // The river dealt in the same step as the showdown adds its own reveal; each extra pot adds a step.
    expect(showdownPlan(1, 2).totalMs).toBe(two.totalMs + streetRevealMs(1));
    expect(showdownPlan(0, 2, 3).totalMs).toBe(two.totalMs + 2 * DEFAULT_TIMING.potMs);
    // The pause always leaves enough time to look at the result.
    expect(six.totalMs - six.firstPotMs).toBeGreaterThanOrEqual(3000);
    expect(FOLD_WIN_PAUSE_MS).toBe(2000);
  });

  it('pushes the main pot last', () => {
    expect(lastPushedPot(3, 0)).toBe(-1);
    expect(lastPushedPot(3, 1)).toBe(2);
    expect(lastPushedPot(3, 2)).toBe(1);
    expect(lastPushedPot(3, 3)).toBe(0);
    expect(lastPushedPot(1, 1)).toBe(0);
  });
});
