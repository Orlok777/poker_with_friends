import { describe, expect, it } from 'vitest';
import {
  DRUMROLL_MS,
  FLIGHT_MS,
  FLIGHT_OVERLAP_MS,
  PACING,
  SPOTLIGHT_MS,
  SPOTLIGHT_STRIDE_MS,
  SPOTLIGHT_TURN_MS,
  handsRevealMs,
  leadMs,
  spotlightSequenceMs,
  streetRevealMs,
} from '../shared/pacing.js';
import { lastPushedPot } from '../shared/types.js';
import { DEFAULT_TIMING, FOLD_WIN_PAUSE_MS, POT_STEP_MS, RESULT_LOOK_MS, showdownPlan } from '../server/table.js';

describe('reveal pacing', () => {
  it('flips the flop card by card, and gives the turn and river a beat first', () => {
    expect(leadMs(3)).toBe(0);
    expect(leadMs(1)).toBe(PACING.beatMs);
    // Three cards 500 ms apart, the last flip taking 350 ms.
    expect(streetRevealMs(3)).toBe(500 + 500 + 350);
    expect(streetRevealMs(1)).toBe(600 + 350);
    expect(streetRevealMs(0)).toBe(0);
  });

  it('flips the hands of an all-in runout one player at a time, 800 ms apart', () => {
    expect(handsRevealMs(0)).toBe(0);
    expect(handsRevealMs(1)).toBe(350);
    expect(handsRevealMs(2)).toBe(800 + 350);
    expect(handsRevealMs(6)).toBe(5 * 800 + 350);
  });
});

describe('showdown spotlight pacing', () => {
  it('has the agreed constants', () => {
    expect(DRUMROLL_MS).toBe(1000);
    expect(FLIGHT_MS).toBe(450);
    expect(SPOTLIGHT_MS).toBe(2000);
    // The next player's cards start flying in half a flight before the last ones are back.
    expect(FLIGHT_OVERLAP_MS).toBe(FLIGHT_MS / 2);
    expect(SPOTLIGHT_TURN_MS).toBe(450 + 2000 + 450);
    expect(SPOTLIGHT_STRIDE_MS).toBe(SPOTLIGHT_TURN_MS - FLIGHT_OVERLAP_MS);
  });

  it('adds up the drumroll and every player\'s turn', () => {
    expect(spotlightSequenceMs(0)).toBe(0);
    expect(spotlightSequenceMs(1)).toBe(0);
    expect(spotlightSequenceMs(2)).toBe(1000 + 2675 + 2900);
    expect(spotlightSequenceMs(4)).toBe(1000 + 3 * 2675 + 2900);
    expect(spotlightSequenceMs(9)).toBe(1000 + 8 * 2675 + 2900);
  });

  it('works out the showdown pause in one place', () => {
    // The board is already out. Heads-up: drumroll, two turns, then 3 s to look at the result.
    const two = showdownPlan(0, 2);
    expect(two.firstPotMs).toBe(6575);
    expect(two.totalMs).toBe(6575 + RESULT_LOOK_MS);
    expect(two.totalMs).toBe(9575);
    expect(showdownPlan(0, 4).totalMs).toBe(14925);
    expect(showdownPlan(0, 9).totalMs).toBe(28300);
    // The river dealt in the same step as the showdown adds its own reveal; each extra pot adds a step.
    expect(showdownPlan(1, 2).totalMs).toBe(two.totalMs + streetRevealMs(1));
    expect(showdownPlan(0, 2, 3).totalMs).toBe(two.totalMs + 2 * DEFAULT_TIMING.potMs);
    expect(POT_STEP_MS).toBe(DEFAULT_TIMING.potMs);
    // Every player gets a turn, so more players take longer, and there is always time to look at the result.
    expect(showdownPlan(0, 4).totalMs).toBeGreaterThan(two.totalMs);
    expect(showdownPlan(0, 9).totalMs - showdownPlan(0, 9).firstPotMs).toBeGreaterThanOrEqual(3000);
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
