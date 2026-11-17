// The "out of chips" prompt: offers to borrow a buy-in (the starting chips) and keep playing.
// It is an in-page dialog, not a browser confirm box.

import type { PlayerView, TableState } from '../shared/types.js';
import { app, me, send } from './app.js';
import { $, fmt } from './dom.js';
import { playChip } from './sound.js';

/** The hand whose prompt the player closed with "Not now", so it does not pop up again for that hand. */
let dismissedHand: number | null = null;
/** Set when the player opens the prompt from the Borrow button, even after dismissing it. */
let forced = false;
let busy = false;
let returnFocus: Element | null = null;

/** Seated with no chips, and not in a hand that is still being played. */
function isOut(s: TableState, self: PlayerView): boolean {
  const live = self.inHand && s.phase !== 'hand_over' && s.phase !== 'waiting';
  return s.settings.allowBorrowing && s.started && self.seat !== null && self.chips === 0 && !live;
}

function isOpen(): boolean {
  return !$('borrow-scrim').hidden;
}

function close(): void {
  const scrim = $('borrow-scrim');
  if (scrim.hidden) return;
  scrim.hidden = true;
  if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}

function open(s: TableState, self: PlayerView): void {
  const amount = s.settings.startingChips;
  const owed = self.debt + amount;
  $('borrow-text').textContent = `Borrow a buy-in of ${fmt(amount)} chips from the bank and keep playing? It goes on your tab.`;
  $('borrow-tab').textContent =
    self.debt > 0
      ? `You already owe ${fmt(self.debt)}. This takes your tab to ${fmt(owed)}.`
      : `You'll owe ${fmt(amount)}. Your tab is kept with your name.`;
  $('borrow-yes').textContent = `Borrow ${fmt(amount)}`;
  $<HTMLButtonElement>('borrow-yes').disabled = busy;
  const scrim = $('borrow-scrim');
  if (scrim.hidden) {
    returnFocus = document.activeElement;
    scrim.hidden = false;
    $('borrow-yes').focus();
  }
}

/** Shows or hides the prompt for the current table state. Call after every state update. */
export function renderBorrow(s: TableState, self: PlayerView): void {
  busy = false; // a new state answers any request we were waiting on
  const out = isOut(s, self);
  if (!out) forced = false;
  if (out && (forced || dismissedHand !== s.hand)) open(s, self);
  else close();
}

/** Opens the prompt again from the Borrow chips button next to the seat. */
export function openBorrowPrompt(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || !isOut(s, self)) return;
  forced = true;
  open(s, self);
}

function dismiss(): void {
  const s = app.state;
  dismissedHand = s ? s.hand : null;
  forced = false;
  close();
}

function borrow(): void {
  const s = app.state;
  const self = me();
  if (busy || !s || !self || !isOut(s, self)) return;
  busy = true;
  $<HTMLButtonElement>('borrow-yes').disabled = true;
  playChip();
  send({ type: 'borrow' });
}

export function initBorrow(): void {
  $('borrow-yes').addEventListener('click', borrow);
  $('borrow-no').addEventListener('click', dismiss);
  // Clicking the dimmed area outside the dialog closes it too.
  $('borrow-scrim').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) dismiss();
  });
  document.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      dismiss();
    } else if (ev.key === 'Tab') {
      // Keep keyboard focus inside the dialog.
      const buttons = [$('borrow-yes'), $('borrow-no')].filter((b) => !(b as HTMLButtonElement).disabled);
      if (buttons.length === 0) return;
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      const next = ev.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : i === buttons.length - 1 ? 0 : i + 1;
      ev.preventDefault();
      buttons[next]!.focus();
    }
  });
}

/** True while the prompt is showing, so other keyboard shortcuts can stay out of its way. */
export function borrowPromptOpen(): boolean {
  return isOpen();
}
