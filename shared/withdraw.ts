// How a withdrawal is split: the debt is paid first and whatever is left over is profit.

/** `debtPaid` goes against what the player owes, `profit` is the rest. They always add up to `amount`. */
export function splitWithdrawal(debt: number, amount: number): { debtPaid: number; profit: number } {
  const debtPaid = Math.min(Math.max(debt, 0), amount);
  return { debtPaid, profit: amount - debtPaid };
}

/** The whole number the player typed when it is a legal amount (1 up to all their chips), otherwise null. */
export function parseWithdrawAmount(text: string, chips: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= chips ? n : null;
}
