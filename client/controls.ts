// Betting and action controls under the felt.

import type { ActionName } from '../shared/types.js';
import { app, me, resetChips, send } from './app.js';
import { $, fmt, h } from './dom.js';
import { playChip } from './sound.js';
import { setBetSource, updatePendingBet } from './table.js';

const CHIP_VALUES = [10, 25, 100, 500];

let pendingBet = 0;
let actionBusy = false;

export function getPendingBet(): number {
  return pendingBet;
}

/** A new state arrived, so any request we were waiting on has been answered. */
export function clearBusy(): void {
  actionBusy = false;
}

function setPending(value: number): void {
  pendingBet = value;
  renderControls();
  const s = app.state;
  const self = me();
  if (s && self && s.phase !== 'waiting') updatePendingBet(s, self, pendingBet);
}

function confirmBet(): void {
  if (pendingBet <= 0 || actionBusy) return;
  actionBusy = true;
  playChip();
  setBetSource($('pending-bet'));
  send({ type: 'place_bet', amount: pendingBet });
  renderControls();
}

function act(action: ActionName): void {
  if (actionBusy) return;
  actionBusy = true;
  send({ type: 'action', action });
  renderControls();
}

export function initControls(): void {
  const box = $('chip-buttons');
  for (const v of CHIP_VALUES) {
    const b = h('button', 'chip-btn', String(v));
    b.type = 'button';
    b.dataset.value = String(v);
    b.setAttribute('aria-label', `Add ${v} to your bet`);
    b.addEventListener('click', () => {
      const self = me();
      if (!app.state || !self) return;
      const cap = Math.min(app.state.settings.maxBet, self.chips);
      playChip();
      setPending(Math.min(pendingBet + v, cap));
    });
    box.append(b);
  }
  $('clear-bet').addEventListener('click', () => setPending(0));
  $('confirm-bet').addEventListener('click', confirmBet);
  $('hit-btn').addEventListener('click', () => act('hit'));
  $('stand-btn').addEventListener('click', () => act('stand'));
  $('double-btn').addEventListener('click', () => act('double'));
  $('reset-btn-table').addEventListener('click', resetChips);
}

/** Shows the bet bar or the action bar and enables what the player can do right now. */
export function renderControls(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || s.phase === 'waiting') return;

  const seated = self.seat !== null;
  const canBet = s.phase === 'betting' && seated && self.bet === 0 && self.chips >= s.settings.minBet && s.deadline !== null;
  if (!canBet || self.bet > 0) pendingBet = 0;
  const cap = Math.min(s.settings.maxBet, self.chips);

  $('bet-bar').hidden = !(s.phase === 'betting' && seated);
  $('pending-bet').textContent = fmt(self.bet > 0 ? self.bet : pendingBet);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
    b.disabled = !canBet || actionBusy || pendingBet >= cap;
  }
  $<HTMLButtonElement>('clear-bet').disabled = !canBet || actionBusy || pendingBet === 0;
  $<HTMLButtonElement>('confirm-bet').disabled = !canBet || actionBusy || pendingBet < s.settings.minBet;
  const canReset = s.phase === 'betting' && self.bet === 0 && !actionBusy;
  const resetBtn = $<HTMLButtonElement>('reset-btn-table');
  resetBtn.disabled = !canReset;
  resetBtn.classList.toggle('primary', self.chips < s.settings.minBet);

  const myTurn = s.phase === 'player_turns' && s.turn === self.id && !actionBusy;
  $('action-bar').hidden = !(seated && (s.phase === 'player_turns' || s.phase === 'dealer_turn') && self.status !== 'none');
  $<HTMLButtonElement>('hit-btn').disabled = !myTurn;
  $<HTMLButtonElement>('stand-btn').disabled = !myTurn;
  $<HTMLButtonElement>('double-btn').disabled = !(myTurn && self.canDouble);

  const note = $('watch-note');
  let text = '';
  if (seated && s.phase === 'betting' && self.chips < s.settings.minBet) text = "You're out of chips. Use Reset chips to keep playing.";
  else if (seated && self.status === 'none' && s.phase !== 'betting' && s.phase !== 'settle') text = "You're sitting out this round.";
  note.textContent = text;
  note.hidden = text === '';
}
