// Withdraw: takes chips off the table. They pay the player's debt first and the rest goes to the earnings.
// The button lives in the top bar of the table (and in the waiting room); the amount is typed into an in-page dialog.

import type { PlayerView, TableState } from '../shared/types.js';
import { parseWithdrawAmount, splitWithdrawal } from '../shared/withdraw.js';
import { app, me, send } from './app.js';
import { $, fmt, fmtSigned } from './dom.js';
import { playChip } from './sound.js';
import { earningsEl, inLiveHand } from './table.js';

let busy = false;
let returnFocus: Element | null = null;

const amountInput = (): HTMLInputElement => $<HTMLInputElement>('withdraw-amount');
const isOpen = (): boolean => !$('withdraw-scrim').hidden;

/** Why the player can not withdraw right now, or null when they can. */
function blockedReason(s: TableState, self: PlayerView): string | null {
  if (s.started && self.seat === null) return 'You need a seat to withdraw';
  if (self.chips <= 0) return 'You have no chips to withdraw';
  if (inLiveHand(s, self)) return 'You can withdraw once the hand is over';
  return null;
}

function close(): void {
  const scrim = $('withdraw-scrim');
  if (scrim.hidden) return;
  scrim.hidden = true;
  busy = false;
  if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}

/** Fills in the dialog's texts for the current chips, debt and typed amount. */
function renderDialog(self: PlayerView): void {
  $('withdraw-text').textContent =
    self.debt > 0 ? `You have ${fmt(self.chips)} chips and owe ${fmt(self.debt)}.` : `You have ${fmt(self.chips)} chips and owe nothing.`;
  $('withdraw-debt').hidden = self.debt <= 0;
  const amount = parseWithdrawAmount(amountInput().value, self.chips);
  const yes = $<HTMLButtonElement>('withdraw-yes');
  yes.disabled = busy || amount === null;
  yes.textContent = amount === null ? 'Withdraw' : `Withdraw ${fmt(amount)}`;
  const preview = $('withdraw-preview');
  if (amount === null) {
    preview.textContent = `Type a whole number from 1 to ${fmt(self.chips)}.`;
    return;
  }
  const { debtPaid, profit } = splitWithdrawal(self.debt, amount);
  const parts: string[] = [];
  if (debtPaid > 0) parts.push(`Pays off ${fmt(debtPaid)} of your debt.`);
  if (profit > 0) parts.push(`${fmt(profit)} goes to your earnings.`);
  if (self.debt - debtPaid > 0) parts.push(`You still owe ${fmt(self.debt - debtPaid)}.`);
  parts.push(`Earnings become ${fmtSigned(self.earnings + amount)}.`);
  preview.textContent = parts.join(' ');
}

/** Opens the dialog from the Withdraw button. */
export function openWithdraw(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || blockedReason(s, self) !== null) return;
  const scrim = $('withdraw-scrim');
  if (scrim.hidden) {
    returnFocus = document.activeElement;
    amountInput().value = '';
    scrim.hidden = false;
    amountInput().focus();
  }
  renderDialog(self);
}

/** The server turned the request down: let the player fix the amount and try again. */
export function withdrawFailed(): void {
  busy = false;
  const self = me();
  if (isOpen() && self) renderDialog(self);
}

/** Draws the Withdraw buttons and keeps an open dialog in step. Call after every state update. */
export function renderWithdraw(s: TableState, self: PlayerView): void {
  const answered = busy; // a new state answers the request we were waiting on
  const reason = blockedReason(s, self);

  const bank = $('bank');
  bank.hidden = !s.started || self.seat === null;
  $('bank-earnings').replaceChildren(earningsEl(self.earnings));
  const btn = $<HTMLButtonElement>('withdraw-btn');
  btn.disabled = reason !== null;
  btn.title = reason ?? 'Take chips off the table: pays your debt first, the rest goes to your earnings';

  const wait = $<HTMLButtonElement>('withdraw-btn-wait');
  wait.hidden = self.chips <= 0;
  wait.title = 'Take chips off the table: pays your debt first, the rest goes to your earnings';

  if (!isOpen()) return;
  if (answered || reason !== null) close();
  else renderDialog(self);
}

function confirm(): void {
  const self = me();
  if (busy || !self) return;
  const amount = parseWithdrawAmount(amountInput().value, self.chips);
  if (amount === null) return;
  busy = true;
  $<HTMLButtonElement>('withdraw-yes').disabled = true;
  playChip();
  send({ type: 'withdraw', amount });
}

export function initWithdraw(): void {
  $('withdraw-btn').addEventListener('click', openWithdraw);
  $('withdraw-btn-wait').addEventListener('click', openWithdraw);
  $('withdraw-yes').addEventListener('click', confirm);
  $('withdraw-no').addEventListener('click', close);
  amountInput().addEventListener('input', () => {
    const self = me();
    if (self) renderDialog(self);
  });
  amountInput().addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      confirm();
    }
  });
  $('withdraw-debt').addEventListener('click', () => {
    const self = me();
    if (!self) return;
    amountInput().value = String(Math.min(self.chips, self.debt));
    renderDialog(self);
  });
  $('withdraw-max').addEventListener('click', () => {
    const self = me();
    if (!self) return;
    amountInput().value = String(self.chips);
    renderDialog(self);
  });
  $('withdraw-scrim').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'Tab') {
      // Keep keyboard focus inside the dialog.
      const items = ['withdraw-amount', 'withdraw-debt', 'withdraw-max', 'withdraw-no', 'withdraw-yes']
        .map((id) => $<HTMLButtonElement>(id))
        .filter((el) => !el.disabled && !el.hidden);
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      ev.preventDefault();
      items[next]!.focus();
    }
  });
}

/** True while the dialog is showing, so other keyboard shortcuts can stay out of its way. */
export function withdrawDialogOpen(): boolean {
  return isOpen();
}
