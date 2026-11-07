import { describe, expect, it } from 'vitest';
import type { LegalView } from '../shared/types.js';
import { amountLimits, snapAmount, stepAmount } from '../client/amount.js';

const SB = 5;

/** What the server sends in `you.legal` when the player may bet or raise. */
function canRaise(o: { call: number; minTo: number; maxTo: number; bet?: boolean }): LegalView {
  return {
    canCheck: o.call === 0,
    callAmount: o.call,
    canBet: o.bet ?? o.call === 0,
    canRaise: !(o.bet ?? o.call === 0),
    minTo: o.minTo,
    maxTo: o.maxTo,
    canAllIn: true,
    allInTo: o.maxTo,
  };
}

/** The server's answer when the player can only fold, check or call. */
function callOnly(o: { call: number; allInTo: number }): LegalView {
  return {
    canCheck: o.call === 0,
    callAmount: o.call,
    canBet: false,
    canRaise: false,
    minTo: 0,
    maxTo: 0,
    canAllIn: o.call >= o.allInTo, // calling is all in
    allInTo: o.allInTo,
  };
}

/** Presses + or − repeatedly and returns every amount shown, starting with `from`. */
function walk(from: number, dir: 1 | -1, times: number, lim: ReturnType<typeof amountLimits>): number[] {
  const seen = [from];
  for (let i = 0; i < times; i++) seen.push(stepAmount(seen[i]!, dir, SB, lim));
  return seen;
}

describe('amountLimits', () => {
  it('uses the call amount as a "to" amount: my bet this round plus what is to call', () => {
    // Big blind with 10 in front facing a raise to 40.
    const lim = amountLimits(10, canRaise({ call: 30, minTo: 70, maxTo: 990 }));
    expect(lim.callTo).toBe(40);
    expect(lim.minRaiseTo).toBe(70);
    expect(lim.allInTo).toBe(990);
    expect(lim.fixed).toBe(false);
  });

  it('defaults to my current bet (a check) when nothing is to call', () => {
    expect(amountLimits(0, canRaise({ call: 0, minTo: 10, maxTo: 1000 })).callTo).toBe(0);
    // Big blind with the option: 10 already in front, nothing more to call.
    expect(amountLimits(10, canRaise({ call: 0, minTo: 20, maxTo: 1000, bet: false })).callTo).toBe(10);
  });

  it('is fixed at all in when calling already puts me all in', () => {
    const lim = amountLimits(0, callOnly({ call: 60, allInTo: 60 }));
    expect(lim.fixed).toBe(true);
    expect(lim.callTo).toBe(60);
    expect(lim.allInTo).toBe(60);
  });

  it('is fixed at the call amount when the betting was not reopened', () => {
    const lim = amountLimits(40, callOnly({ call: 15, allInTo: 500 }));
    expect(lim.fixed).toBe(true);
    expect(lim.callTo).toBe(55);
  });
});

describe('stepAmount', () => {
  it('heads-up preflop, small blind facing 5 more: + goes 10 → 20 → 25 → 30', () => {
    const lim = amountLimits(5, canRaise({ call: 5, minTo: 20, maxTo: 1000 }));
    expect(lim.callTo).toBe(10);
    expect(walk(lim.callTo, 1, 3, lim)).toEqual([10, 20, 25, 30]);
  });

  it('heads-up preflop: − goes back 30 → 25 → 20 → 10', () => {
    const lim = amountLimits(5, canRaise({ call: 5, minTo: 20, maxTo: 1000 }));
    expect(walk(30, -1, 3, lim)).toEqual([30, 25, 20, 10]);
  });

  it('+ from the call amount jumps to the minimum raise-to, skipping the illegal amounts', () => {
    const lim = amountLimits(0, canRaise({ call: 40, minTo: 80, maxTo: 1000 }));
    expect(stepAmount(40, 1, SB, lim)).toBe(80);
  });

  it('− from the minimum raise-to drops back to the call amount', () => {
    const lim = amountLimits(0, canRaise({ call: 40, minTo: 80, maxTo: 1000 }));
    expect(stepAmount(80, -1, SB, lim)).toBe(40);
  });

  it('− never goes below the call amount, and + never goes above all in', () => {
    const lim = amountLimits(0, canRaise({ call: 40, minTo: 80, maxTo: 90 }));
    expect(stepAmount(40, -1, SB, lim)).toBe(40);
    expect(walk(80, 1, 3, lim)).toEqual([80, 85, 90, 90]);
  });

  it('a step that would pass all in lands on all in', () => {
    const lim = amountLimits(0, canRaise({ call: 40, minTo: 80, maxTo: 83 }));
    expect(stepAmount(80, 1, SB, lim)).toBe(83);
    // And from there − goes to the minimum raise, not past it.
    expect(stepAmount(83, -1, SB, lim)).toBe(80);
  });

  it('short stack: all in below the minimum raise is reachable, and nothing else in between', () => {
    // Call 10, a full raise would be to 20, but I only have 15 in total.
    const lim = amountLimits(0, canRaise({ call: 10, minTo: 15, maxTo: 15 }));
    expect(lim.minRaiseTo).toBe(15);
    expect(walk(10, 1, 2, lim)).toEqual([10, 15, 15]);
    expect(walk(15, -1, 2, lim)).toEqual([15, 10, 10]);
  });

  it('short stack: a minimum raise above all in is capped at all in', () => {
    const lim = amountLimits(0, canRaise({ call: 10, minTo: 20, maxTo: 17 }));
    expect(lim.minRaiseTo).toBe(17);
    expect(stepAmount(10, 1, SB, lim)).toBe(17);
  });

  it('nothing to call: the minimum bet is the big blind', () => {
    const lim = amountLimits(0, canRaise({ call: 0, minTo: 10, maxTo: 1000 }));
    expect(walk(0, 1, 3, lim)).toEqual([0, 10, 15, 20]);
    expect(walk(15, -1, 3, lim)).toEqual([15, 10, 0, 0]);
  });

  it('does nothing when the amount is fixed', () => {
    const allIn = amountLimits(0, callOnly({ call: 60, allInTo: 60 }));
    expect(stepAmount(60, 1, SB, allIn)).toBe(60);
    expect(stepAmount(60, -1, SB, allIn)).toBe(60);
    const noReopen = amountLimits(40, callOnly({ call: 15, allInTo: 500 }));
    expect(stepAmount(55, 1, SB, noReopen)).toBe(55);
    expect(stepAmount(55, -1, SB, noReopen)).toBe(55);
  });
});

describe('snapAmount', () => {
  const lim = amountLimits(5, canRaise({ call: 5, minTo: 20, maxTo: 1000 }));

  it('keeps legal amounts', () => {
    expect([10, 20, 21, 500, 1000].map((v) => snapAmount(v, lim))).toEqual([10, 20, 21, 500, 1000]);
  });

  it('clamps to [call amount, all in]', () => {
    expect(snapAmount(0, lim)).toBe(10);
    expect(snapAmount(-50, lim)).toBe(10);
    expect(snapAmount(5000, lim)).toBe(1000);
  });

  it('snaps an illegal amount between the call amount and the minimum raise to the nearer end', () => {
    expect(snapAmount(13, lim)).toBe(10);
    expect(snapAmount(17, lim)).toBe(20);
    expect(snapAmount(15, lim)).toBe(20); // halfway: toward the raise
  });

  it('rounds to a whole number', () => {
    expect(snapAmount(42.6, lim)).toBe(43);
  });

  it('keeps all in even when it is below the minimum raise', () => {
    const short = amountLimits(0, canRaise({ call: 10, minTo: 15, maxTo: 15 }));
    expect(snapAmount(15, short)).toBe(15);
    expect(snapAmount(14, short)).toBe(15);
    expect(snapAmount(12, short)).toBe(10);
  });

  it('is always the call amount when the amount is fixed', () => {
    const fixed = amountLimits(40, callOnly({ call: 15, allInTo: 500 }));
    expect(snapAmount(300, fixed)).toBe(55);
    expect(snapAmount(0, fixed)).toBe(55);
  });
});
