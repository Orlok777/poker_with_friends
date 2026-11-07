// The action row in the dock: Fold, Check or Call, and Bet or Raise to, with the amount shown as text
// and set with the slider, the − and + buttons, or All in. There are no keyboard shortcuts: every action
// is a button press.

import type { ActionKind, ClientMsg, LegalView } from '../shared/types.js';
import { amountLimits, snapAmount, stepAmount, type AmountLimits } from './amount.js';
import { app, me, send } from './app.js';
import { $, fmt } from './dom.js';
import { playAllIn } from './sound.js';

/** How long the "Confirm all in?" question waits for a second click. */
const ALL_IN_CONFIRM_MS = 3000;

let actionBusy = false;
let allInArmed = false;
let allInTimer: number | null = null;
/** The decision the amount was last reset for, so moving the slider is not undone by the next update. */
let amountTurn = '';
let amount = 0;

/** A new state arrived, so any request we were waiting on has been answered. */
export function clearBusy(): void {
  actionBusy = false;
}

function legal(): LegalView | null {
  return app.state?.you?.legal ?? null;
}

/** The legal range of the amount for my current decision, or null when it is not my turn. */
function limits(): AmountLimits | null {
  const l = legal();
  return l ? amountLimits(me()?.bet ?? 0, l) : null;
}

function setAmount(value: number): void {
  const lim = limits();
  if (!lim || lim.fixed) return;
  amount = snapAmount(value, lim);
  renderControls();
}

function stepBy(dir: 1 | -1): void {
  const s = app.state;
  const lim = limits();
  if (!s || !lim || lim.fixed) return;
  amount = stepAmount(amount, dir, s.settings.smallBlind, lim);
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
  const lim = limits()!;
  const to = snapAmount(amount, lim);
  // Raising to the call amount is just a call, which has its own button.
  if (lim.fixed || to === lim.callTo) return;
  if (to === lim.allInTo) playAllIn();
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
    amount = limits()!.allInTo;
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

// -------------------------------------------------------------------- init

export function initControls(): void {
  $('fold-btn').addEventListener('click', () => act('fold'));
  $('call-btn').addEventListener('click', () => act('call'));
  $('raise-btn').addEventListener('click', () => act('raise'));
  $('allin-btn').addEventListener('click', onAllInClick);
  // The slider only moves by dragging its handle: styles/controls.css makes the track ignore the pointer.
  const slider = $<HTMLInputElement>('amount-slider');
  slider.addEventListener('input', () => setAmount(Number(slider.value)));
  $('amount-down').addEventListener('click', () => stepBy(-1));
  $('amount-up').addEventListener('click', () => stepBy(1));
  // Clicking anything else cancels the all-in question (capture, so it runs before that click's own handler).
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (allInArmed && !(ev.target as HTMLElement | null)?.closest('#allin-btn')) disarmAllIn();
    },
    true,
  );
  // So does any key other than Enter or Space on the All in button itself.
  document.addEventListener('keydown', (ev) => {
    if (allInArmed && !(ev.target instanceof Element && ev.target.closest('#allin-btn'))) disarmAllIn();
  });
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
  const lim = l ? amountLimits(self.bet, l) : null;
  const turnKey = l ? `${s.hand}:${s.phase}:${self.bet}:${l.callAmount}:${l.minTo}:${l.allInTo}` : '';
  if (lim && turnKey !== amountTurn) {
    // A new decision: the amount starts at the call amount (my current bet when I can check).
    amountTurn = turnKey;
    amount = lim.callTo;
  }
  if (!l) amountTurn = '';
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

  // Bet or Raise to: the label follows the amount, and the button waits until it differs from the call.
  const adjustable = !!lim && !lim.fixed;
  const noBet = l ? l.canBet || (!l.canRaise && highest === 0) : highest === 0;
  const verb = noBet ? 'Bet' : 'Raise to';
  const sizing = !!lim && adjustable && amount !== lim.callTo;
  $('raise-label').textContent = !sizing ? verb : amount === lim.allInTo ? `All in ${fmt(amount)}` : `${verb} ${fmt(amount)}`;
  $<HTMLButtonElement>('raise-btn').disabled = !myTurn || !sizing;

  const value = $('amount-value');
  const slider = $<HTMLInputElement>('amount-slider');
  const canAdjust = myTurn && adjustable;
  value.classList.toggle('off', !canAdjust);
  slider.disabled = !canAdjust;
  $<HTMLButtonElement>('amount-down').disabled = !canAdjust || amount <= lim!.callTo;
  $<HTMLButtonElement>('amount-up').disabled = !canAdjust || amount >= lim!.allInTo;
  if (lim) {
    slider.min = String(lim.callTo);
    slider.max = String(lim.allInTo);
    slider.step = '1';
    slider.value = String(amount);
    value.textContent = fmt(amount);
  } else {
    value.textContent = '–';
    slider.value = slider.min;
  }

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
