// The rules for the bet/raise amount in the action bar. Pure functions, no DOM, so they can be tested.
// Every amount is a "to" amount: the total I will have in front of me this betting round.
//
// The legal amounts are the call amount (a check when nothing is to call), then everything from the
// minimum raise-to up to all in. Amounts strictly between the call amount and the minimum raise-to are
// illegal. The server still validates every action; this only keeps the controls on legal values.

import type { LegalView } from '../shared/types.js';

export interface AmountLimits {
  /** My bet this round plus what is to call; my current bet when nothing is to call. */
  callTo: number;
  /** The smallest legal raise-to (the big blind when nothing is to call), never above all in. */
  minRaiseTo: number;
  /** My bet this round plus my whole stack. */
  allInTo: number;
  /** The amount can not change: calling is already all in, or the betting was not reopened for me. */
  fixed: boolean;
}

export function amountLimits(myBet: number, legal: LegalView): AmountLimits {
  const callTo = myBet + legal.callAmount;
  const canSize = legal.canBet || legal.canRaise;
  const allInTo = canSize ? legal.maxTo : Math.max(legal.allInTo, callTo);
  return {
    callTo,
    // `minTo` is 0 when I can not bet or raise.
    minRaiseTo: canSize ? Math.min(Math.max(legal.minTo, callTo), allInTo) : callTo,
    allInTo,
    fixed: !canSize || callTo >= allInTo,
  };
}

/** The legal amount nearest to `value`; halfway between the call amount and the minimum raise goes to the raise. */
export function snapAmount(value: number, lim: AmountLimits): number {
  if (lim.fixed) return lim.callTo;
  const v = Math.round(value);
  if (v <= lim.callTo) return lim.callTo;
  if (v >= lim.allInTo) return lim.allInTo;
  if (v >= lim.minRaiseTo) return v;
  return v - lim.callTo < lim.minRaiseTo - v ? lim.callTo : lim.minRaiseTo;
}

/** One press of + (dir 1) or − (dir -1): `step` chips, jumping over the illegal amounts. */
export function stepAmount(current: number, dir: 1 | -1, step: number, lim: AmountLimits): number {
  if (lim.fixed) return lim.callTo;
  const now = snapAmount(current, lim);
  if (dir === 1) return now < lim.minRaiseTo ? lim.minRaiseTo : Math.min(lim.allInTo, now + step);
  return now > lim.minRaiseTo ? Math.max(lim.minRaiseTo, now - step) : lim.callTo;
}
