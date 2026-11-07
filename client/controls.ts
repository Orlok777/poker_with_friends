// The action bar under the felt: Fold, Check or Call, Bet or Raise to, with the amount box,
// slider and presets, plus their keyboard shortcuts.

import type { ActionKind, ClientMsg, LegalView, TableState } from '../shared/types.js';
import { app, me, send } from './app.js';
import { $, fmt } from './dom.js';
import { playAllIn } from './sound.js';

/** How long the "Confirm all in?" question waits for a second click. */
const ALL_IN_CONFIRM_MS = 3000;

let actionBusy = false;
let allInArmed = false;
let allInTimer: number | null = null;
/** The turn the amount box was last filled for, so typing is not overwritten by the next update. */
let amountTurn = '';
let amount = 0;

/** A new state arrived, so any request we were waiting on has been answered. */
export function clearBusy(): void {
  actionBusy = false;
}

function legal(): LegalView | null {
  return app.state?.you?.legal ?? null;
}

/** Chips in the pots plus everything in front of the players. */
function potTotal(s: TableState): number {
  return s.pots.reduce((sum, p) => sum + p.amount, 0) + s.players.reduce((sum, p) => sum + p.bet, 0);
}

function clamp(value: number, l: LegalView): number {
  return Math.max(l.minTo, Math.min(l.maxTo, Math.round(value)));
}

/** A pot-sized bet or raise, or a fraction of one: call first, then add that part of the pot. */
function potTo(s: TableState, l: LegalView, fraction: number): number {
  const self = me();
  const myBet = self?.bet ?? 0;
  const current = myBet + l.callAmount;
  const afterCall = potTotal(s) + l.callAmount;
  return clamp(current + afterCall * fraction, l);
}

function setAmount(value: number): void {
  const l = legal();
  if (!l || !(l.canBet || l.canRaise)) return;
  amount = clamp(value, l);
  renderControls();
}

function sendAction(msg: ClientMsg): void {
  if (actionBusy) return;
  actionBusy = true;
  send(msg);
  renderControls();
}

function act(kind: 'fold' | 'call' | 'raise'): void {
  const l = legal();
  if (!l || actionBusy) return;
  disarmAllIn();
  if (kind === 'fold') return sendAction({ type: 'action', action: 'fold' });
  if (kind === 'call') return sendAction({ type: 'action', action: l.canCheck ? 'check' : 'call' });
  if (!(l.canBet || l.canRaise)) return;
  const to = clamp(amount, l);
  if (to === l.allInTo) playAllIn();
  sendAction({ type: 'action', action: (l.canBet ? 'bet' : 'raise') as ActionKind, amount: to });
}

// ------------------------------------------------------------------ all in

function disarmAllIn(): void {
  if (allInTimer !== null) window.clearTimeout(allInTimer);
  allInTimer = null;
  if (!allInArmed) return;
  allInArmed = false;
  renderControls();
}

function onAllInClick(): void {
  const l = legal();
  if (!l || !l.canAllIn || actionBusy) return;
  if (!allInArmed) {
    allInArmed = true;
    allInTimer = window.setTimeout(disarmAllIn, ALL_IN_CONFIRM_MS);
    if (l.canBet || l.canRaise) amount = l.maxTo;
    renderControls();
    return;
  }
  // Second click: the whole stack goes in.
  if (allInTimer !== null) window.clearTimeout(allInTimer);
  allInTimer = null;
  allInArmed = false;
  playAllIn();
  sendAction({ type: 'action', action: 'all_in' });
}

// ---------------------------------------------------------------- keyboard

/** Brief pressed look when a shortcut key is used, so the player sees which button fired. */
function flash(id: string): void {
  const el = $(id);
  el.classList.remove('key-pressed');
  void el.offsetWidth;
  el.classList.add('key-pressed');
  window.setTimeout(() => el.classList.remove('key-pressed'), 160);
}

const KEYS: Record<string, ['fold' | 'call' | 'raise', string]> = {
  f: ['fold', 'fold-btn'],
  c: ['call', 'call-btn'],
  r: ['raise', 'raise-btn'],
};

function onKey(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement | null;
  // Pressing any other key cancels a pending all in.
  if (allInArmed && !target?.closest('#allin-btn')) disarmAllIn();
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
  if ($('screen-table').hidden || $('action-bar').hidden) return;
  // Enter in the amount box bets or raises that amount.
  if (target?.id === 'amount-input' && ev.key === 'Enter') {
    ev.preventDefault();
    readAmountInput();
    flash('raise-btn');
    act('raise');
    return;
  }
  if (target && target.closest('input, textarea, select, [contenteditable="true"]') !== null) return;
  const hit = KEYS[ev.key.toLowerCase()];
  if (!hit) return;
  const [kind, id] = hit;
  if ($<HTMLButtonElement>(id).disabled) return;
  ev.preventDefault();
  flash(id);
  act(kind);
}

function readAmountInput(): void {
  const input = $<HTMLInputElement>('amount-input');
  const value = Number(input.value);
  if (input.value !== '' && Number.isFinite(value)) setAmount(value);
  else renderControls();
}

// -------------------------------------------------------------------- init

export function initControls(): void {
  $('fold-btn').addEventListener('click', () => act('fold'));
  $('call-btn').addEventListener('click', () => act('call'));
  $('raise-btn').addEventListener('click', () => {
    readAmountInput();
    act('raise');
  });
  $('allin-btn').addEventListener('click', onAllInClick);
  const input = $<HTMLInputElement>('amount-input');
  input.addEventListener('change', readAmountInput);
  input.addEventListener('focus', () => input.select());
  const slider = $<HTMLInputElement>('amount-slider');
  slider.addEventListener('input', () => setAmount(Number(slider.value)));
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    btn.addEventListener('click', () => {
      const s = app.state;
      const l = legal();
      if (!s || !l) return;
      const preset = btn.dataset.preset!;
      setAmount(preset === 'min' ? l.minTo : potTo(s, l, Number(preset)));
    });
  }
  // Clicking anything else cancels the all-in question (capture, so it runs before that click's own handler).
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (allInArmed && !(ev.target as HTMLElement | null)?.closest('#allin-btn')) disarmAllIn();
    },
    true,
  );
  document.addEventListener('keydown', onKey);
}

// ------------------------------------------------------------------ render

/** Shows the action bar while I am in the hand and enables what I can do right now. */
export function renderControls(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || !s.started) return;

  const betting = s.phase === 'preflop' || s.phase === 'flop' || s.phase === 'turn' || s.phase === 'river';
  const inPlay = betting && self.inHand && !self.folded && !self.allIn;
  $('action-bar').hidden = !inPlay;

  const l = legal();
  const myTurn = !!l && !actionBusy;
  const turnKey = l ? `${s.hand}:${s.phase}:${l.minTo}:${l.callAmount}` : '';
  if (l && turnKey !== amountTurn) {
    // A new decision: the amount box starts at the minimum bet or raise.
    amountTurn = turnKey;
    amount = l.minTo;
  }
  if (!l && allInArmed) {
    allInArmed = false;
    if (allInTimer !== null) window.clearTimeout(allInTimer);
    allInTimer = null;
  }

  // Fold
  $<HTMLButtonElement>('fold-btn').disabled = !myTurn;

  // Check or Call: Check is never shown when there is something to call.
  const highest = Math.max(0, ...s.players.map((p) => p.bet));
  const toCall = l ? l.callAmount : Math.min(self.chips, Math.max(0, highest - self.bet));
  const canCheck = l ? l.canCheck : toCall === 0;
  $('call-label').textContent = canCheck ? 'Check' : `Call ${fmt(toCall)}`;
  $<HTMLButtonElement>('call-btn').disabled = !myTurn;

  // Bet or Raise to
  const canSize = !!l && (l.canBet || l.canRaise);
  const noBet = l ? l.canBet || (!l.canRaise && highest === 0) : highest === 0;
  const verb = noBet ? 'Bet' : 'Raise to';
  $('raise-label').textContent = canSize ? `${verb} ${fmt(amount)}` : verb;
  $<HTMLButtonElement>('raise-btn').disabled = !myTurn || !canSize;

  const input = $<HTMLInputElement>('amount-input');
  const slider = $<HTMLInputElement>('amount-slider');
  input.disabled = !myTurn || !canSize;
  slider.disabled = !myTurn || !canSize;
  if (canSize) {
    input.min = String(l!.minTo);
    input.max = String(l!.maxTo);
    slider.min = String(l!.minTo);
    slider.max = String(l!.maxTo);
    slider.step = '1';
    slider.value = String(amount);
    if (document.activeElement !== input) input.value = String(amount);
  } else {
    input.value = '';
    slider.value = slider.min;
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) btn.disabled = !myTurn || !canSize;

  // All in, with a confirm step
  const allIn = $<HTMLButtonElement>('allin-btn');
  allIn.disabled = !myTurn || !l?.canAllIn;
  allIn.classList.toggle('armed', allInArmed);
  $('allin-label').textContent = allInArmed && l ? `Confirm all in (${fmt(l.allInTo)})?` : 'All in';
  allIn.title = allInArmed ? 'Click again to put in all your chips' : 'Put in all your chips';

  $('action-bar').classList.toggle('my-turn', !!l);

  // ---- note
  const note = $('watch-note');
  let text = '';
  if (self.seat === null) text = "You're watching. You'll get a seat as soon as one frees up.";
  else if (betting && self.inHand && self.folded) text = 'You folded. Waiting for the next hand.';
  else if (betting && self.inHand && self.allIn) text = "You're all in.";
  else if (betting && !self.inHand) text = self.sittingOut ? "You're sitting out." : "You're dealt in from the next hand.";
  note.textContent = text;
  note.hidden = text === '';
}
