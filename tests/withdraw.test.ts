import { describe, expect, it } from 'vitest';
import { parseWithdrawAmount, splitWithdrawal } from '../shared/withdraw.js';

describe('splitWithdrawal', () => {
  it('pays the debt first and the rest is profit', () => {
    expect(splitWithdrawal(1000, 1500)).toEqual({ debtPaid: 1000, profit: 500 });
  });

  it('puts everything on the debt when the amount is smaller', () => {
    expect(splitWithdrawal(1000, 400)).toEqual({ debtPaid: 400, profit: 0 });
  });

  it('counts it all as profit when there is no debt', () => {
    expect(splitWithdrawal(0, 500)).toEqual({ debtPaid: 0, profit: 500 });
  });
});

describe('parseWithdrawAmount', () => {
  it('accepts a whole number from 1 up to the chips', () => {
    expect(parseWithdrawAmount('1500', 3000)).toBe(1500);
    expect(parseWithdrawAmount(' 1 ', 3000)).toBe(1);
    expect(parseWithdrawAmount('3000', 3000)).toBe(3000);
  });

  it('rejects empty, zero, negative, fractional, text and too-large amounts', () => {
    for (const text of ['', '0', '-5', '12.5', 'abc', '1e3', '3001']) {
      expect(parseWithdrawAmount(text, 3000)).toBeNull();
    }
  });
});
