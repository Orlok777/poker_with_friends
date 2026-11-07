// The felt: board and pots in the middle, the other seats round the oval, my seat at the bottom.

import { type PlayerView, type PublicSettings, type TableState } from '../shared/types.js';
import { app, confirmKick, isHost, resetChips, send, serverNow } from './app.js';
import { openBorrowPrompt } from './borrow.js';
import { cardKey, chipStack, flyChips, handEl, resetCardMemory, ringEl, runCardAnimations, tickRings } from './cards.js';
import { $, fmt, fmtSigned, h, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';
import { playAllIn, playChip, playDeal, playFlip, playKnock, playPayout, playShuffle } from './sound.js';

let firstRender = true;
let lastDeadline: number | null = null;
let timerTotal = 1;
let lastHand = -1;

export function resetTable(): void {
  firstRender = true;
  lastDeadline = null;
  lastHand = -1;
  resetCardMemory();
}

// ------------------------------------------------------------------- texts

export function rulesText(st: PublicSettings): string {
  return `No-Limit Hold'em · Blinds ${fmt(st.smallBlind)} / ${fmt(st.bigBlind)}`;
}

/** "Earnings +250" in green, or in red when negative. */
export function earningsEl(earnings: number): HTMLElement {
  const el = h('span', earnings > 0 ? 'earnings num is-up' : earnings < 0 ? 'earnings num is-down' : 'earnings num');
  el.title = 'What you have won or lost at the table. Borrowing and paying back do not change it.';
  el.append(h('span', 'earnings-label', 'Earnings'), document.createTextNode(` ${fmtSigned(earnings)}`));
  return el;
}

const BETTING = new Set(['preflop', 'flop', 'turn', 'river']);

/** In a hand that is still being played, so Reset chips, Pay back and Borrow must wait. */
export function inLiveHand(s: TableState, p: PlayerView): boolean {
  return p.inHand && s.phase !== 'hand_over' && s.phase !== 'waiting';
}

function namesOf(s: TableState, ids: string[]): string {
  const names = ids.map((id) => s.players.find((p) => p.id === id)?.name ?? 'A player');
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function inSentence(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  return /^(pair|straight|flush|full house|royal)/.test(lower) ? `a ${lower}` : lower;
}

/** The pot whose winners are shown right now: the last one pushed, or the main pot before that. */
function currentPotIndex(s: TableState): number {
  const pots = s.result?.pots ?? [];
  return Math.min(Math.max(s.potsAwarded - 1, 0), pots.length - 1);
}

/** "Alex wins 240 with a flush, ace high", or "Alex and Sam split 240 with ...". */
function bannerText(s: TableState): string {
  const r = s.result;
  if (!r || r.pots.length === 0) return '';
  const i = currentPotIndex(s);
  const pot = r.pots[i]!;
  if (!r.showdown) return `${namesOf(s, pot.winners)} wins ${fmt(r.pots.reduce((sum, p) => sum + p.amount, 0))}`;
  const which = r.pots.length === 1 ? '' : i === 0 ? ' the main pot' : ` side pot ${i}`;
  const verb = pot.winners.length === 1 ? 'wins' : 'split';
  const how = pot.handName ? ` with ${inSentence(pot.handName)}` : '';
  return `${namesOf(s, pot.winners)} ${verb}${which} ${fmt(pot.amount)}${how}`;
}

function pillText(s: TableState, self: PlayerView): { text: string; tone: '' | 'accent' } {
  if (s.phase === 'waiting') return { text: 'Waiting for players', tone: '' };
  if (s.phase === 'showdown' || s.phase === 'hand_over') return { text: '', tone: '' };
  if (s.turn === self.id) return { text: 'Your turn', tone: 'accent' };
  const p = s.players.find((x) => x.id === s.turn);
  if (p) return { text: `${p.name} to act`, tone: '' };
  if (s.phase === 'preflop' && s.board.length === 0 && s.players.some((x) => x.inHand && x.cards.length < 2)) {
    return { text: 'Dealing', tone: '' };
  }
  const live = s.players.filter((x) => x.inHand && !x.folded);
  if (live.length > 1 && live.filter((x) => !x.allIn).length <= 1) return { text: 'All in', tone: '' };
  return { text: '', tone: '' };
}

// ----------------------------------------------------------------- layout

/** Where seats sit on the oval, in % of the felt. My seat is at the bottom centre. */
function seatPosition(seat: number, mySeat: number | null, count: number): { x: number; y: number } {
  // Watching: nobody sits at the bottom, so the seats are turned half a step.
  const rel = mySeat === null ? seat + 0.5 : (seat - mySeat + count) % count;
  const angle = Math.PI / 2 + (rel * 2 * Math.PI) / count;
  return { x: 50 + 43 * Math.cos(angle), y: 47 + 36 * Math.sin(angle) };
}

const CENTER = { x: 50, y: 47 };
const lerp = (a: { x: number; y: number }, t: number) => ({ x: a.x + (CENTER.x - a.x) * t, y: a.y + (CENTER.y - a.y) * t });

// ------------------------------------------------------------------- seats

function winningKeys(s: TableState): Set<string> {
  const r = s.result;
  if (!r || !r.showdown || r.pots.length === 0) return new Set();
  return new Set(r.pots[currentPotIndex(s)]!.cards.map(cardKey));
}

/** Marks the winning five cards and dims the others once a showdown is decided. */
function markWinners(row: HTMLElement, keys: Set<string>): void {
  if (keys.size === 0) return;
  for (const el of row.querySelectorAll<HTMLElement>('.card')) {
    el.classList.toggle('win-card', el.dataset.card !== undefined && keys.has(el.dataset.card));
    el.classList.toggle('dim-card', el.dataset.card !== undefined && !keys.has(el.dataset.card));
  }
}

function blindTag(s: TableState, p: PlayerView): HTMLElement | null {
  if (!p.inHand || p.seat === null) return null;
  if (p.seat === s.smallBlindSeat) return h('span', 'blind-tag', 'SB');
  if (p.seat === s.bigBlindSeat) return h('span', 'blind-tag', 'BB');
  return null;
}

function statusText(s: TableState, p: PlayerView): string | null {
  if (!p.connected) return 'Away';
  if (p.sittingOut && !p.inHand) return 'Sitting out';
  if (p.chips === 0 && !p.inHand) return 'Out of chips';
  if (!p.inHand && s.phase !== 'waiting') return 'Next hand';
  return null;
}

function seatEl(s: TableState, p: PlayerView, counts: Counts, win: Set<string>): HTMLElement {
  const seat = h('div', 'seat');
  seat.dataset.id = p.id;
  if (s.turn === p.id) seat.classList.add('is-turn');
  if (p.folded) seat.classList.add('folded');
  if (!p.connected) seat.classList.add('away');
  if (!p.inHand) seat.classList.add('idle');
  const won = s.result && s.potsAwarded > 0 && s.result.pots.slice(0, s.potsAwarded).some((pot) => pot.winners.includes(p.id));
  if (won) seat.classList.add('winner');

  const box = h('div', 'hand-box size-sm');
  const { el, added, flipped } = handEl(`seat:${p.id}`, p.cards, !firstRender);
  counts.added += added;
  counts.flipped += flipped;
  markWinners(el, win);
  box.append(el);
  if (p.cards.length === 0) box.classList.add('empty');
  seat.append(box);

  const plate = h('div', 'seat-plate');
  const head = h('div', 'seat-head');
  if (s.turn === p.id && s.deadline !== null) head.append(ringEl('seat-ring'));
  head.append(h('span', 'seat-name', p.name));
  if (p.seat !== null && p.seat === s.buttonSeat) head.append(h('span', 'dealer-tag', 'D'));
  const blind = blindTag(s, p);
  if (blind) head.append(blind);
  if (p.id === s.hostId) head.title = `${p.name} is the host`;
  plate.append(head);

  const sub = h('div', 'seat-sub');
  sub.append(h('span', 'seat-chips num', fmt(p.chips)));
  const status = statusText(s, p);
  if (p.handName) sub.append(h('span', 'seat-action hand-label', p.handName));
  else if (p.lastAction) sub.append(h('span', `seat-action ${actionClass(p.lastAction)}`, p.lastAction));
  else if (status) sub.append(h('span', 'seat-action muted-action', status));
  if (p.debt > 0) sub.append(h('span', 'owes num', `owes ${fmt(p.debt)}`));
  plate.append(sub);
  // The bet sits inside the seat on phones; on wider screens it is drawn toward the middle instead.
  if (p.bet > 0) {
    const inline = chipStack(p.bet);
    inline.classList.add('inline-bet');
    plate.append(inline);
  }
  if (s.turn === p.id && s.deadline !== null) {
    const bar = h('span', 'timer-bar');
    bar.dataset.timerBar = '';
    plate.append(bar);
  }
  seat.append(plate);

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

function actionClass(text: string): string {
  if (text === 'Fold') return 'act-fold';
  if (text === 'All in') return 'act-allin';
  if (text === 'Check') return 'act-check';
  if (text.startsWith('Call')) return 'act-call';
  return 'act-raise';
}

interface Counts {
  added: number;
  flipped: number;
}

function renderOthers(s: TableState, self: PlayerView, counts: Counts, win: Set<string>): void {
  const box = $('others');
  const n = s.seats.length;
  const nodes: HTMLElement[] = [];
  for (let seat = 0; seat < n; seat++) {
    const id = s.seats[seat];
    const p = id && id !== self.id ? s.players.find((x) => x.id === id) : undefined;
    if (!p) continue;
    const pos = seatPosition(seat, self.seat, n);
    const el = seatEl(s, p, counts, win);
    el.style.setProperty('--x', `${pos.x}%`);
    el.style.setProperty('--y', `${pos.y}%`);
    nodes.push(el);
    // Chips in front of the player, between the seat and the middle.
    if (p.bet > 0) {
      const at = lerp(pos, 0.36);
      const bet = chipStack(p.bet);
      bet.classList.add('table-bet');
      bet.dataset.id = p.id;
      bet.style.setProperty('--x', `${at.x}%`);
      bet.style.setProperty('--y', `${at.y}%`);
      nodes.push(bet);
    }
    if (seat === s.buttonSeat && p.inHand) nodes.push(dealerButton(pos));
  }
  if (self.seat !== null && self.seat === s.buttonSeat && self.inHand) {
    nodes.push(dealerButton(seatPosition(self.seat, self.seat, n), true));
  }
  box.replaceChildren(...nodes);
}

/** The white "D" next to the button seat, a little toward the middle. */
function dealerButton(pos: { x: number; y: number }, mine = false): HTMLElement {
  const at = lerp(pos, mine ? 0.3 : 0.24);
  const btn = h('span', mine ? 'dealer-btn mine' : 'dealer-btn', 'D');
  btn.title = 'Dealer button';
  btn.style.setProperty('--x', `${at.x + (mine ? 13 : 6)}%`);
  btn.style.setProperty('--y', `${at.y}%`);
  return btn;
}

// ------------------------------------------------------------------ middle

function renderCenter(s: TableState, self: PlayerView, counts: Counts, win: Set<string>): void {
  const board = $('board');
  const { el, added } = handEl('board', s.board, !firstRender);
  counts.added += added;
  markWinners(el, win);
  // Five slots, so the board does not jump as cards arrive.
  const slots = h('div', 'board-slots');
  for (let i = s.board.length; i < 5; i++) slots.append(h('span', 'slot'));
  el.append(...slots.children);
  board.replaceChildren(el);
  board.hidden = s.phase === 'waiting';

  const pots = $('pots');
  const nodes = s.pots.map((pot, i) => {
    const label = s.pots.length === 1 ? 'Pot' : i === 0 ? 'Main' : `Side ${i}`;
    const st = chipStack(pot.amount, label);
    st.classList.add('pot');
    return st;
  });
  pots.replaceChildren(...nodes);

  const pill = $('phase-pill');
  const phase = pillText(s, self);
  pill.textContent = phase.text;
  pill.className = `phase-pill ${phase.tone}`.trim();
  pill.hidden = phase.text === '';

  const banner = $('banner');
  const text = s.phase === 'showdown' || s.phase === 'hand_over' ? bannerText(s) : '';
  if (banner.textContent !== text) {
    banner.textContent = text;
    if (text && !firstRender) banner.animate([{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 260 });
  }
  banner.hidden = text === '';
  $('felt-rules').textContent = rulesText(s.settings);
}

// ------------------------------------------------------------------ my spot

function toolButton(label: string, title: string, onClick: () => void, cls = 'link-btn'): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function renderMe(s: TableState, self: PlayerView, counts: Counts, win: Set<string>): void {
  const spot = $('my-spot');
  spot.classList.toggle('is-turn', s.turn === self.id);
  spot.classList.toggle('folded', self.folded);
  if (self.seat === null) {
    spot.replaceChildren(h('p', 'spot-note', "You're watching. You'll get a seat as soon as one frees up."));
    return;
  }
  const nodes: HTMLElement[] = [];

  const box = h('div', 'hand-box size-lg');
  box.dataset.id = self.id;
  const mine = s.you?.cards ?? [];
  const { el, added } = handEl('me', mine, !firstRender);
  counts.added += added;
  markWinners(el, win);
  box.append(el);
  if (mine.length === 0) box.classList.add('empty');
  if (s.turn === self.id && s.deadline !== null) box.append(ringEl('hand-ring'));
  // My chips in front of me sit beside my cards, toward the middle.
  if (self.bet > 0) {
    const st = chipStack(self.bet);
    st.classList.add('my-bet');
    box.append(st);
  }
  nodes.push(box);

  const won = s.result && s.potsAwarded > 0 && s.result.pots.slice(0, s.potsAwarded).some((pot) => pot.winners.includes(self.id));
  spot.classList.toggle('winner', !!won);

  const handName = h('div', 'my-hand-name');
  if (s.you?.handName) handName.textContent = self.folded ? `${s.you.handName} (folded)` : s.you.handName;
  else {
    const status = statusText(s, self);
    if (status && status !== 'Away') handName.textContent = status === 'Next hand' ? "You're in from the next hand" : status;
  }
  nodes.push(handName);

  const name = h('div', 'my-name');
  name.append(h('span', 'name', self.name));
  if (self.seat === s.buttonSeat && self.inHand) name.append(h('span', 'dealer-tag', 'D'));
  const blind = blindTag(s, self);
  if (blind) name.append(blind);
  name.append(h('span', 'dot', '·'), h('span', 'num', `${fmt(self.chips)} chips`));
  if (self.debt > 0) name.append(h('span', 'owes num', `owes ${fmt(self.debt)}`));
  name.append(earningsEl(self.earnings));
  if (self.lastAction && BETTING.has(s.phase)) name.append(h('span', `seat-action ${actionClass(self.lastAction)}`, self.lastAction));
  nodes.push(name);

  // Sit out, reset, pay back and borrow, next to my seat (on the same line as my name where there is room).
  const tools = h('span', 'my-tools');
  const sit = h('button', self.sittingOut ? 'toggle-btn on' : 'toggle-btn');
  sit.type = 'button';
  sit.setAttribute('aria-pressed', String(self.sittingOut));
  sit.title = self.sittingOut ? 'You are sitting out. Click to be dealt in again.' : 'Skip hands from the next one on';
  sit.append(h('span', 'toggle-dot'), document.createTextNode('Sit out next hand'));
  sit.addEventListener('click', () => send({ type: 'sit_out', sittingOut: !self.sittingOut }));
  tools.append(sit);
  const free = !inLiveHand(s, self);
  if (free && self.debt > 0 && self.chips > 0) {
    tools.append(
      toolButton(`Pay back ${fmt(Math.min(self.chips, self.debt))}`, 'Pay your chips towards what you owe', () => send({ type: 'pay_back' })),
    );
  }
  if (free && self.chips === 0) tools.append(toolButton('Borrow chips', 'Borrow a buy-in from the bank', openBorrowPrompt, 'link-btn strong'));
  if (free) tools.append(toolButton('Reset chips', 'Start over with the starting chips', resetChips));
  name.append(tools);

  spot.replaceChildren(...nodes);
}

// ------------------------------------------------------------------- sounds

/** Sounds for what changed since the last state: actions, new hands, flips and pots pushed. */
function playChanges(s: TableState, prev: TableState | null, counts: Counts): void {
  if (firstRender) return;
  if (counts.added > 0) playDeal();
  if (counts.flipped > 0) playFlip();
  if (!prev) return;
  if (s.hand !== prev.hand && s.hand > 0) {
    playShuffle();
    return;
  }
  if (s.potsAwarded > prev.potsAwarded && s.hand === prev.hand) playPayout();
  const before = new Map(prev.players.map((p) => [p.id, p.lastAction]));
  for (const p of s.players) {
    const was = before.get(p.id);
    if (!p.lastAction || p.lastAction === was) continue;
    if (p.lastAction === 'Fold') playFlip();
    else if (p.lastAction === 'Check') playKnock();
    else if (p.lastAction === 'All in') playAllIn();
    else playChip();
  }
}

/** Each pot slides to its winners as it is pushed. */
function animatePots(s: TableState, prev: TableState | null): void {
  if (!prev || prev.hand !== s.hand || !s.result || s.potsAwarded <= prev.potsAwarded) return;
  const pot = s.result.pots[s.potsAwarded - 1];
  if (!pot) return;
  for (const id of pot.winners) {
    const target =
      id === app.myId ? document.querySelector('#my-spot .hand-box') : document.querySelector(`#others .seat[data-id="${id}"]`);
    flyChips($('pots'), target, pot.amount);
  }
}

// -------------------------------------------------------------------- main

export function renderTable(s: TableState, self: PlayerView): void {
  const prev = app.prevState;
  if (s.hand !== lastHand) {
    // A new hand: every card on the table is new again.
    if (lastHand !== -1) resetCardMemory();
    lastHand = s.hand;
  }
  const counts: Counts = { added: 0, flipped: 0 };
  $('round-label').textContent = s.hand > 0 ? `Hand ${s.hand}` : 'Poker';
  if (s.deadline !== lastDeadline) {
    lastDeadline = s.deadline;
    timerTotal = s.deadline ? Math.max(1, s.deadline - s.serverNow) : 1;
  }
  const win = s.phase === 'showdown' || s.phase === 'hand_over' ? winningKeys(s) : new Set<string>();

  renderCenter(s, self, counts, win);
  renderOthers(s, self, counts, win);
  renderMe(s, self, counts, win);
  $('felt').classList.toggle('show-results', win.size > 0);

  runCardAnimations();
  playChanges(s, prev, counts);
  animatePots(s, prev);
  firstRender = false;
  tick();
}

// -------------------------------------------------------------------- timer

function tick(): void {
  const s = app.state;
  if (!s || !s.started || s.deadline === null) return;
  tickRings(Math.max(0, s.deadline - serverNow()), timerTotal);
}

setInterval(tick, prefersReducedMotion() ? 500 : 100);

