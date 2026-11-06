// The felt: dealer at the top, my hand large at the bottom, other players on an arc between.

import { isHiddenCard, type PlayerView, type PublicSettings, type TableState } from '../shared/types.js';
import { app, confirmKick, isHost, serverNow } from './app.js';
import {
  betChip,
  handEl,
  resetCardMemory,
  resultPill,
  ringEl,
  runCardAnimations,
  slideFrom,
  tickRings,
  totalBadge,
  totalLabel,
} from './cards.js';
import { $, fmt, h, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';
import { playChip, playDeal } from './sound.js';

let firstRender = true;
let lastDeadline: number | null = null;
let timerTotal = 1;
/** Results and bets already shown, so their entrance animation runs only once. */
const seenResults = new Set<string>();
const seenBets = new Set<string>();
/** Set by the controls just before the player's own bet is sent, so the chip slides from there. */
let betSource: Element | null = null;

export function setBetSource(el: Element | null): void {
  betSource = el;
}

export function resetTable(): void {
  firstRender = true;
  lastDeadline = null;
  seenResults.clear();
  seenBets.clear();
  resetCardMemory();
}

// ------------------------------------------------------------------- texts

export function rulesText(st: PublicSettings): string {
  const pays = st.blackjackPayout === '3:2' ? '3 to 2' : '6 to 5';
  const soft = st.dealerHitsSoft17 ? 'Dealer hits soft 17' : 'Dealer stands on soft 17';
  return `Blackjack pays ${pays} · ${soft}`;
}

function phaseText(s: TableState, self: PlayerView): { text: string; tone: '' | 'accent'; ring: boolean } {
  switch (s.phase) {
    case 'betting':
      if (s.deadline === null) return { text: 'Waiting for players', tone: '', ring: false };
      if (self.seat !== null && self.bet === 0 && self.chips >= s.settings.minBet) {
        return { text: 'Place your bet', tone: 'accent', ring: true };
      }
      return { text: 'Waiting for bets', tone: '', ring: true };
    case 'dealing':
      return { text: 'Dealing', tone: '', ring: false };
    case 'player_turns': {
      const p = s.players.find((x) => x.id === s.turn);
      if (!p) return { text: '', tone: '', ring: false };
      return p.id === self.id ? { text: 'Your turn', tone: 'accent', ring: false } : { text: `${p.name}'s turn`, tone: '', ring: false };
    }
    case 'dealer_turn':
      return { text: s.dealer.blackjack ? 'Dealer has blackjack' : "Dealer's turn", tone: '', ring: false };
    case 'settle':
      return { text: 'Round over', tone: '', ring: false };
    default:
      return { text: '', tone: '', ring: false };
  }
}

// ------------------------------------------------------------------- hands

function playerTotal(s: TableState, p: PlayerView): HTMLElement | null {
  if (p.cards.length === 0) return null;
  if (p.status === 'bust') return totalBadge(String(p.total), 'bust');
  if (p.status === 'blackjack') return totalBadge('21', 'bj');
  const final = p.status !== 'playing' || s.phase === 'settle';
  return totalBadge(totalLabel(p.total, p.soft, final));
}

/** Cards plus the total badge (top right) and, on that player's turn, the countdown ring (top left). */
function handBox(s: TableState, key: string, p: PlayerView, size: 'lg' | 'sm', counts: { added: number }): HTMLElement {
  const box = h('div', `hand-box size-${size}`);
  const { el, added } = handEl(key, p.cards, !firstRender);
  counts.added += added;
  box.append(el);
  const badge = playerTotal(s, p);
  if (badge) box.append(badge);
  if (size === 'lg' && s.turn === p.id && s.deadline !== null) box.append(ringEl('hand-ring'));
  return box;
}

/** The spot under a hand: the result once settled, else the bet chip. */
function betSpot(s: TableState, p: PlayerView, pending: number): HTMLElement {
  const spot = h('div', 'bet-spot');
  const result = resultPill(p);
  if (result) {
    spot.append(result);
    const key = `${s.round}:${p.id}`;
    if (!seenResults.has(key)) {
      seenResults.add(key);
      if (!firstRender) result.classList.add('enter');
    }
    return spot;
  }
  if (p.bet > 0) {
    const chip = betChip(p.bet, { doubled: p.doubled });
    spot.append(chip);
    const key = `${s.round}:${p.id}:${p.bet}`;
    if (!seenBets.has(key)) {
      seenBets.add(key);
      if (!firstRender) {
        if (p.id === app.myId && betSource) {
          const from = betSource;
          requestAnimationFrame(() => slideFrom(chip, from));
          betSource = null;
        } else {
          chip.classList.add('enter');
        }
      }
    }
    return spot;
  }
  if (pending > 0) spot.append(betChip(pending, { pending: true }));
  return spot;
}

// ------------------------------------------------------------------ dealer

function renderDealer(s: TableState, counts: { added: number }): void {
  const box = $('dealer');
  const hand = h('div', 'hand-box size-dealer');
  const { el, added } = handEl('dealer', s.dealer.cards, !firstRender);
  counts.added += added;
  hand.append(el);
  if (s.dealer.cards.length === 0) hand.classList.add('empty');
  const visible = s.dealer.cards.filter((c) => !isHiddenCard(c)).length;
  if (visible > 0) {
    if (s.dealer.blackjack) hand.append(totalBadge('21', 'bj'));
    else if (s.dealer.total > 21) hand.append(totalBadge(String(s.dealer.total), 'bust'));
    else hand.append(totalBadge(totalLabel(s.dealer.total, s.dealer.soft, s.phase === 'settle')));
  }
  box.classList.toggle('is-turn', s.phase === 'dealer_turn');
  box.replaceChildren(h('span', 'spot-label', 'Dealer'), hand);
}

// ------------------------------------------------------------------- seats

/**
 * The other seated players in seat order, starting with the one after me. Going round the table:
 * me, then my left side from near to far, over the dealer, then my right side from far to near.
 */
function othersInOrder(s: TableState, self: PlayerView): PlayerView[] {
  const n = s.seats.length;
  const start = self.seat === null ? 0 : self.seat + 1;
  const out: PlayerView[] = [];
  for (let k = 0; k < n; k++) {
    const id = s.seats[(start + k) % n];
    const p = id && id !== self.id ? s.players.find((x) => x.id === id) : undefined;
    if (p) out.push(p);
  }
  return out;
}

/**
 * Positions (in % of the felt) on an elliptical arc around my hand. Seats are spaced evenly
 * across the width rather than by angle, so boxes near the sides do not pile up.
 */
function arcPositions(count: number): { x: number; y: number }[] {
  const leftCount = Math.ceil(count / 2);
  const rightCount = count - leftCount;
  const onArc = (dx: number) => {
    const rx = 46;
    const t = Math.min(1, Math.abs(dx) / rx);
    return { x: 50 + dx, y: 28 + 36 * Math.sqrt(1 - t * t) };
  };
  /** Offsets from the centre, near my hand first. */
  const side = (k: number): number[] => {
    if (k === 0) return [];
    if (k === 1) return [29];
    return Array.from({ length: k }, (_, i) => 21 + (21 * i) / (k - 1));
  };
  const left = side(leftCount).map((d) => onArc(-d));
  const right = side(rightCount).map((d) => onArc(d)).reverse();
  return [...left, ...right];
}

function seatEl(s: TableState, p: PlayerView, counts: { added: number }): HTMLElement {
  const seat = h('div', 'seat');
  if (s.turn === p.id) seat.classList.add('is-turn');
  if (!p.connected) seat.classList.add('away');
  if (p.outcome) seat.classList.add(`outcome-${p.outcome === 'loss' ? 'loss' : 'other'}`);

  const head = h('div', 'seat-head');
  if (s.turn === p.id && s.deadline !== null) head.append(ringEl('seat-ring'));
  head.append(h('span', 'seat-name', p.name));
  if (p.id === s.hostId) head.title = `${p.name} is the host`;
  if (!p.connected) head.append(h('span', 'tag', 'Away'));
  seat.append(head);

  seat.append(handBox(s, p.id, p, 'sm', counts));

  const foot = h('div', 'seat-foot');
  foot.append(betSpot(s, p, 0), h('span', 'seat-chips num', fmt(p.chips)));
  seat.append(foot);

  if (isHost()) {
    const kick = h('button', 'icon-btn seat-kick');
    kick.type = 'button';
    kick.title = `Kick ${p.name}`;
    kick.setAttribute('aria-label', `Kick ${p.name}`);
    kick.append(icon('close'));
    kick.addEventListener('click', () => confirmKick(p));
    seat.append(kick);
  }
  return seat;
}

function renderOthers(s: TableState, self: PlayerView, counts: { added: number }): void {
  const box = $('others');
  // Only occupied seats are drawn. Players who are watching (no seat yet) are not on the felt.
  const others = othersInOrder(s, self);
  const positions = arcPositions(others.length);
  const nodes = others.map((p, i) => {
    const el = seatEl(s, p, counts);
    el.style.setProperty('--x', `${positions[i]!.x}%`);
    el.style.setProperty('--y', `${positions[i]!.y}%`);
    return el;
  });
  box.replaceChildren(...nodes);
  box.classList.toggle('has-turn', nodes.some((n) => n.classList.contains('is-turn')));
}

// ------------------------------------------------------------------ my spot

function renderMe(s: TableState, self: PlayerView, pendingBet: number, counts: { added: number }): void {
  const spot = $('my-spot');
  spot.classList.toggle('is-turn', s.turn === self.id);
  if (self.seat === null) {
    spot.replaceChildren(h('p', 'spot-note', "You're watching. You'll take a free seat when the next round starts."));
    return;
  }
  const nodes: HTMLElement[] = [];
  nodes.push(handBox(s, self.id, self, 'lg', counts));
  const pending = s.phase === 'betting' && self.bet === 0 ? pendingBet : 0;
  nodes.push(betSpot(s, self, pending));
  const name = h('div', 'my-name');
  name.append(h('span', 'name', self.name), h('span', 'dot', '·'), h('span', 'num', `${fmt(self.chips)} chips`));
  nodes.push(name);
  spot.replaceChildren(...nodes);
  spot.classList.toggle('no-cards', self.cards.length === 0);
}

// -------------------------------------------------------------------- main

/** Draws the felt for this state. `pendingBet` is the bet being built in the controls. */
export function renderTable(s: TableState, self: PlayerView, pendingBet: number): void {
  const counts = { added: 0 };

  // The round number goes up when the cards are dealt, so betting is for the next round.
  $('round-label').textContent = `Round ${s.round + (s.phase === 'betting' ? 1 : 0)}`;
  if (s.deadline !== lastDeadline) {
    lastDeadline = s.deadline;
    timerTotal = s.deadline ? Math.max(1, s.deadline - s.serverNow) : 1;
  }

  renderDealer(s, counts);

  const pill = $('phase-pill');
  const phase = phaseText(s, self);
  pill.replaceChildren();
  if (phase.ring && s.deadline !== null) pill.append(ringEl('pill-ring'));
  pill.append(h('span', undefined, phase.text));
  pill.className = `phase-pill ${phase.tone}`.trim();
  pill.hidden = phase.text === '';

  $('felt-rules').textContent = rulesText(s.settings);
  renderOthers(s, self, counts);
  renderMe(s, self, pendingBet, counts);

  runCardAnimations();
  if (!firstRender && counts.added > 0) playDeal();
  const prev = app.prevState;
  if (prev && s.phase === 'betting') {
    const before = new Map(prev.players.map((p) => [p.id, p.bet]));
    if (s.players.some((p) => p.bet > 0 && (before.get(p.id) ?? 0) === 0 && p.id !== app.myId)) playChip();
  }
  firstRender = false;
  tick();
}

/** Only the pending chip under my hand changes while I build a bet; no need to redraw everything. */
export function updatePendingBet(s: TableState, self: PlayerView, pendingBet: number): void {
  renderMe(s, self, pendingBet, { added: 0 });
  tick();
}

// -------------------------------------------------------------------- timer

function tick(): void {
  const s = app.state;
  if (!s || s.phase === 'waiting' || s.deadline === null) return;
  tickRings(Math.max(0, s.deadline - serverNow()), timerTotal);
}

setInterval(tick, prefersReducedMotion() ? 500 : 100);
