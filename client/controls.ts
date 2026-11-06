// Betting panel and action buttons under the felt, plus their keyboard shortcuts.

import type { ActionName } from '../shared/types.js';
import { app, me, resetChips, send } from './app.js';
import { slideFrom, ringEl } from './cards.js';
import { $, fmt, h } from './dom.js';
import { playChip } from './sound.js';
import { setBetSource, updatePendingBet } from './table.js';

const CHIP_VALUES = [10, 25, 100, 500];

let pendingBet = 0;
/** The last bet this player confirmed, for Repeat. */
let lastBet = 0;
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
  return s && self ? Math.min(s.settings.maxBet, self.chips) : 0;
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

const ACTION_BUTTONS: Record<ActionName, string> = { hit: 'hit-btn', stand: 'stand-btn', double: 'double-btn' };

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
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
  if ($('screen-table').hidden) return;
  const target = ev.target as HTMLElement | null;
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
  const action: ActionName | null = key === 'h' ? 'hit' : key === 's' ? 'stand' : key === 'd' ? 'double' : null;
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
  $('double-bet').addEventListener('click', (ev) => setPending(pendingBet * 2, ev.currentTarget as Element));
  $('confirm-bet').addEventListener('click', confirmBet);
  $('reset-btn-table').addEventListener('click', resetChips);
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
  const outOfChips = self.chips < s.settings.minBet && self.bet === 0;
  const canBet = s.phase === 'betting' && seated && self.bet === 0 && !outOfChips && s.deadline !== null;
  if (!canBet) pendingBet = 0;
  const cap = betCap();
  const busy = actionBusy;

  // ---- betting
  const betBar = $('bet-bar');
  betBar.hidden = !(s.phase === 'betting' && seated && self.bet === 0 && s.deadline !== null);
  betBar.classList.toggle('out-of-chips', outOfChips);
  $('pending-bet').textContent = fmt(pendingBet);
  $('bet-limits').textContent = `${fmt(s.settings.minBet)}–${fmt(s.settings.maxBet)}`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
    b.disabled = !canBet || busy || pendingBet >= cap;
  }
  $<HTMLButtonElement>('clear-bet').disabled = !canBet || busy || pendingBet === 0;
  const repeatTo = Math.min(lastBet, cap);
  const repeat = $<HTMLButtonElement>('repeat-bet');
  repeat.disabled = !canBet || busy || repeatTo < s.settings.minBet || repeatTo === pendingBet;
  $('repeat-amount').textContent = lastBet > 0 ? fmt(repeatTo) : '';
  $<HTMLButtonElement>('double-bet').disabled = !canBet || busy || pendingBet === 0 || pendingBet >= cap;
  $<HTMLButtonElement>('confirm-bet').disabled = !canBet || busy || pendingBet < s.settings.minBet;
  const reset = $<HTMLButtonElement>('reset-btn-table');
  reset.hidden = !outOfChips;
  reset.disabled = busy;

  // ---- actions: shown for the whole round so the layout does not jump between phases
  const inRound = seated && self.status !== 'none' && self.cards.length > 0;
  $('action-bar').hidden = !(inRound && s.phase !== 'betting');
  const myTurn = s.phase === 'player_turns' && s.turn === self.id && !busy;
  $<HTMLButtonElement>('hit-btn').disabled = !myTurn;
  $<HTMLButtonElement>('stand-btn').disabled = !myTurn;
  $<HTMLButtonElement>('double-btn').disabled = !(myTurn && self.canDouble);
  $('action-bar').classList.toggle('my-turn', s.phase === 'player_turns' && s.turn === self.id);

  // ---- note
  const note = $('watch-note');
  let text = '';
  if (seated && s.phase === 'betting' && outOfChips) text = "You're out of chips. Reset them to keep playing.";
  else if (seated && s.phase === 'betting' && self.bet > 0) text = 'Bet placed. Waiting for the others.';
  else if (seated && self.status === 'none' && s.phase !== 'betting') text = "You're sitting out this round.";
  note.textContent = text;
  note.hidden = text === '';
}

