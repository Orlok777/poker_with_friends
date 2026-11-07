// Betting panel and action buttons under the felt, plus their keyboard shortcuts.

import type { ActionName } from '../shared/types.js';
import { app, me, send } from './app.js';
import { openBorrowPrompt } from './borrow.js';
import { slideFrom, ringEl } from './cards.js';
import { $, fmt, h } from './dom.js';
import { playAllIn, playChip } from './sound.js';
import { betOf, setBetSource, updatePendingBet } from './table.js';

const CHIP_VALUES = [10, 25, 100, 500];

let pendingBet = 0;
/** The last bet this player confirmed: Repeat uses it, and each new round starts with it already in the bet box. */
let lastBet = 0;
/** The round whose bet box was already filled with the last bet, so Clear is not undone by the next update. */
let prefilledRound = -1;
let actionBusy = false;

export function getPendingBet(): number {
  return pendingBet;
}

/** A new state arrived, so any request we were waiting on has been answered. */
export function clearBusy(): void {
  actionBusy = false;
}

/** Most chips the player may bet right now. */
function betCap(): number {
  const s = app.state;
  const self = me();
  return s && self ? self.chips : 0;
}

function setPending(value: number, from?: Element): void {
  pendingBet = Math.max(0, Math.min(value, betCap()));
  renderControls();
  const s = app.state;
  const self = me();
  if (s && self && s.phase !== 'waiting') {
    updatePendingBet(s, self, pendingBet);
    const disc = document.querySelector('#my-spot .bet-chip.pending .chip-disc');
    if (from && disc) slideFrom(disc as HTMLElement, from);
  }
}

function confirmBet(): void {
  const btn = $<HTMLButtonElement>('confirm-bet');
  if (btn.disabled || actionBusy) return;
  actionBusy = true;
  lastBet = pendingBet;
  playChip();
  setBetSource($('pending-bet'));
  send({ type: 'place_bet', amount: pendingBet });
  renderControls();
}

// ------------------------------------------------------------------ all in

/** How long the "Confirm all in?" question waits for a second click. */
const ALL_IN_CONFIRM_MS = 3000;

let allInArmed = false;
let allInTimer: number | null = null;

function disarmAllIn(): void {
  if (allInTimer !== null) window.clearTimeout(allInTimer);
  allInTimer = null;
  if (!allInArmed) return;
  allInArmed = false;
  renderControls();
}

function onAllInClick(): void {
  const btn = $<HTMLButtonElement>('allin-btn');
  const self = me();
  if (btn.disabled || actionBusy || !self) return;
  if (!allInArmed) {
    allInArmed = true;
    allInTimer = window.setTimeout(disarmAllIn, ALL_IN_CONFIRM_MS);
    renderControls();
    return;
  }
  // Second click: the whole stack becomes the bet and is confirmed.
  if (allInTimer !== null) window.clearTimeout(allInTimer);
  allInTimer = null;
  allInArmed = false;
  actionBusy = true;
  pendingBet = self.chips;
  lastBet = self.chips;
  playAllIn();
  setBetSource($('pending-bet'));
  send({ type: 'place_bet', amount: self.chips });
  renderControls();
}

const ACTION_BUTTONS: Record<ActionName, string> = {
  hit: 'hit-btn',
  stand: 'stand-btn',
  double: 'double-btn',
  split: 'split-btn',
};

function act(action: ActionName): void {
  const btn = $<HTMLButtonElement>(ACTION_BUTTONS[action]);
  if (btn.disabled || actionBusy) return;
  actionBusy = true;
  send({ type: 'action', action });
  renderControls();
}

/** Brief pressed look when a shortcut key is used, so the player sees which button fired. */
function flash(id: string): void {
  const el = $(id);
  el.classList.remove('key-pressed');
  void el.offsetWidth;
  el.classList.add('key-pressed');
  window.setTimeout(() => el.classList.remove('key-pressed'), 160);
}

function onKey(ev: KeyboardEvent): void {
  const target = ev.target as HTMLElement | null;
  // Pressing any other key cancels a pending all in. Enter/Space on the button itself is its own click.
  if (allInArmed && !target?.closest('#allin-btn')) disarmAllIn();
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
  if ($('screen-table').hidden) return;
  if (target && (target.closest('input, textarea, select, [contenteditable="true"]') !== null)) return;
  // Leave Enter and Space alone on buttons outside the controls (log, rules, leave...).
  const onOtherButton = target?.closest('button') && !target.closest('.table-controls');

  const key = ev.key.toLowerCase();
  if (key === 'enter') {
    if (onOtherButton || $('bet-bar').hidden || $<HTMLButtonElement>('confirm-bet').disabled) return;
    ev.preventDefault(); // otherwise Enter on a focused chip would add another chip
    flash('confirm-bet');
    confirmBet();
    return;
  }
  const KEYS: Record<string, ActionName> = { h: 'hit', s: 'stand', d: 'double', p: 'split' };
  const action: ActionName | null = KEYS[key] ?? null;
  if (!action || $('action-bar').hidden) return;
  const id = ACTION_BUTTONS[action];
  if ($<HTMLButtonElement>(id).disabled) return;
  ev.preventDefault();
  flash(id);
  act(action);
}

export function initControls(): void {
  const box = $('chip-buttons');
  for (const v of CHIP_VALUES) {
    const b = h('button', `chip-btn c${v}`);
    b.type = 'button';
    b.dataset.value = String(v);
    b.setAttribute('aria-label', `Add ${v} to your bet`);
    b.append(h('span', 'chip-face num', String(v)));
    b.addEventListener('click', () => {
      playChip();
      setPending(pendingBet + v, b);
    });
    box.append(b);
  }
  $('bet-ring-slot').append(ringEl('bet-ring'));
  $('clear-bet').addEventListener('click', () => setPending(0));
  $('repeat-bet').addEventListener('click', (ev) => setPending(lastBet, ev.currentTarget as Element));
  $('half-bet').addEventListener('click', (ev) => setPending(Math.floor(pendingBet / 2), ev.currentTarget as Element));
  $('double-bet').addEventListener('click', (ev) => setPending(pendingBet * 2, ev.currentTarget as Element));
  $('confirm-bet').addEventListener('click', confirmBet);
  $('allin-btn').addEventListener('click', onAllInClick);
  // Clicking anything else cancels the all-in question (capture, so it runs before that click's own handler).
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (allInArmed && !(ev.target as HTMLElement | null)?.closest('#allin-btn')) disarmAllIn();
    },
    true,
  );
  $('borrow-btn').addEventListener('click', openBorrowPrompt);
  for (const action of Object.keys(ACTION_BUTTONS) as ActionName[]) {
    $(ACTION_BUTTONS[action]).addEventListener('click', () => act(action));
  }
  document.addEventListener('keydown', onKey);
}

/** Shows the bet panel or the action buttons and enables what the player can do right now. */
export function renderControls(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || s.phase === 'waiting') return;

  const seated = self.seat !== null;
  const myBet = betOf(self);
  const outOfChips = self.chips < s.settings.minBet && myBet === 0;
  const canBet = s.phase === 'betting' && seated && myBet === 0 && !outOfChips && s.deadline !== null;
  if (!canBet) pendingBet = 0;
  const cap = betCap();
  // A new betting round starts with the last bet already in the box, ready to confirm.
  if (canBet && prefilledRound !== s.round) {
    prefilledRound = s.round;
    const again = Math.min(lastBet, cap);
    if (pendingBet === 0 && again >= s.settings.minBet) pendingBet = again;
  }
  const busy = actionBusy;

  // ---- all in: the button is enabled with at least the minimum bet; armed shows the confirm question
  const allInBtn = $<HTMLButtonElement>('allin-btn');
  const allInOk = canBet && !busy && self.chips >= s.settings.minBet;
  if (!allInOk && allInArmed) {
    allInArmed = false;
    if (allInTimer !== null) window.clearTimeout(allInTimer);
    allInTimer = null;
  }
  allInBtn.disabled = !allInOk;
  allInBtn.classList.toggle('armed', allInArmed);
  $('allin-label').textContent = allInArmed ? `Confirm all in (${fmt(self.chips)})?` : 'All in';
  allInBtn.title = allInArmed ? 'Click again to bet everything' : 'Bet all your chips';

  // ---- betting
  const betBar = $('bet-bar');
  betBar.hidden = !(s.phase === 'betting' && seated && myBet === 0 && s.deadline !== null);
  betBar.classList.toggle('out-of-chips', outOfChips);
  $('pending-bet').textContent = fmt(pendingBet);
  $('bet-limits').textContent = `Min ${fmt(s.settings.minBet)}`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
    b.disabled = !canBet || busy || pendingBet >= cap;
  }
  $<HTMLButtonElement>('clear-bet').disabled = !canBet || busy || pendingBet === 0;
  const repeatTo = Math.min(lastBet, cap);
  const repeat = $<HTMLButtonElement>('repeat-bet');
  repeat.disabled = !canBet || busy || repeatTo < s.settings.minBet || repeatTo === pendingBet;
  $('repeat-amount').textContent = lastBet > 0 ? fmt(repeatTo) : '';
  $<HTMLButtonElement>('half-bet').disabled = !canBet || busy || pendingBet < 2;
  $<HTMLButtonElement>('double-bet').disabled = !canBet || busy || pendingBet === 0 || pendingBet >= cap;
  $<HTMLButtonElement>('confirm-bet').disabled = !canBet || busy || pendingBet < s.settings.minBet;
  const borrow = $<HTMLButtonElement>('borrow-btn');
  borrow.hidden = !outOfChips || s.deadline === null;
  borrow.disabled = busy;

  // ---- actions: shown for the whole round so the layout does not jump between phases
  const inRound = seated && (self.hands[0]?.cards.length ?? 0) > 0;
  $('action-bar').hidden = !(inRound && s.phase !== 'betting');
  const myTurn = s.phase === 'player_turns' && s.turn === self.id && !busy;
  $<HTMLButtonElement>('hit-btn').disabled = !myTurn;
  $<HTMLButtonElement>('stand-btn').disabled = !myTurn;
  $<HTMLButtonElement>('double-btn').disabled = !(myTurn && self.hands[self.activeHand]?.canDouble);
  // Split is always shown; it is only enabled when splitting is allowed right now.
  $<HTMLButtonElement>('split-btn').disabled = !(myTurn && self.canSplit);
  $('action-bar').classList.toggle('my-turn', s.phase === 'player_turns' && s.turn === self.id);

  // ---- note
  const note = $('watch-note');
  let text = '';
  if (seated && s.phase === 'betting' && outOfChips) text = "You're out of chips. Borrow a buy-in to keep playing.";
  else if (seated && s.phase === 'betting' && myBet > 0) text = 'Bet placed. Waiting for the others.';
  else if (seated && self.hands.length === 0 && s.phase !== 'betting') text = "You're sitting out this round.";
  note.textContent = text;
  note.hidden = text === '';
}

