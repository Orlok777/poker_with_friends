// The table screen: the other players' nameplates along the top, the felt with the board and pots in the
// middle, and my seat in the dock at the bottom.

import { isHiddenCard, lastPushedPot, type PlayerView, type PublicSettings, type TableState } from '../shared/types.js';
import { app, confirmKick, isHost, me, resetChips, send, serverNow } from './app.js';
import { openBorrowPrompt } from './borrow.js';
import { cardKey, chipStack, flyChips, handEl, resetCardMemory, ringEl, runCardAnimations, tickRings } from './cards.js';
import { $, fmt, fmtSigned, h, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';
import { ingest, onReveal, resetReveal, view } from './reveal.js';
import { playAllIn, playChip, playDeal, playFlip, playKnock, playLose, playPayout, playShuffle, playWin } from './sound.js';

let firstRender = true;
let lastDeadline: number | null = null;
let timerTotal = 1;
let lastHand = -1;
/** The state as it was last drawn (with hidden reveals left out), for working out what changed. */
let drawn: TableState | null = null;

/** After a pot is lit, the banner and the chips follow this much later. */
const CELEBRATE_MS = 350;

export function resetTable(): void {
  firstRender = true;
  lastDeadline = null;
  lastHand = -1;
  drawn = null;
  resetCardMemory();
  resetReveal();
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

/** "Alex wins 240 with a flush, ace high", or "Alex and Sam split 240 with ...". Empty until the first pot is lit. */
function bannerText(s: TableState): string {
  const r = s.result;
  if (!r || r.pots.length === 0) return '';
  const i = lastPushedPot(r.pots.length, s.potsAwarded);
  if (i < 0) return '';
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

// ------------------------------------------------------------------- plates

/** The pot being lit right now: who won it and which five cards each of them wins with. */
interface Spotlight {
  winners: Set<string>;
  /** Each winner's own five cards. A winner's other cards, and every loser's cards, step back. */
  fives: Map<string, Set<string>>;
  /** The board cards that are part of any winner's five. */
  board: Set<string>;
  /** Hands that went to showdown; false after a fold win, where nothing is shown. */
  showdown: boolean;
}

function spotlight(s: TableState): Spotlight | null {
  const r = s.result;
  if (!r) return null;
  const pot = r.pots[lastPushedPot(r.pots.length, s.potsAwarded)];
  if (!pot) return null;
  const fives = new Map(pot.hands.map((hand) => [hand.playerId, new Set(hand.cards.map(cardKey))]));
  const board = new Set<string>();
  for (const five of fives.values()) for (const key of five) board.add(key);
  return { winners: new Set(pot.winners), fives, board, showdown: r.showdown };
}

/** Lifts and lights the cards in `lit` and dims the rest of the row. Nothing changes without a spotlight. */
function markCards(row: HTMLElement, spot: Spotlight | null, lit: Set<string> | undefined): void {
  if (!spot?.showdown) return;
  for (const el of row.querySelectorAll<HTMLElement>('.card')) {
    const key = el.dataset.card;
    if (key === undefined) continue; // a face-down card
    const on = lit?.has(key) ?? false;
    el.classList.toggle('win-card', on);
    el.classList.toggle('dim-card', !on);
  }
}

/** The white "D" on the button seat and the "SB" / "BB" tags on the blinds. */
function seatTags(s: TableState, p: PlayerView): HTMLElement[] {
  if (!p.inHand || p.seat === null) return [];
  const tags: HTMLElement[] = [];
  if (p.seat === s.buttonSeat) {
    const d = h('span', 'dealer-tag', 'D');
    d.title = 'Dealer button';
    tags.push(d);
  }
  if (p.seat === s.smallBlindSeat) tags.push(h('span', 'blind-tag', 'SB'));
  else if (p.seat === s.bigBlindSeat) tags.push(h('span', 'blind-tag', 'BB'));
  return tags;
}

function statusText(s: TableState, p: PlayerView): string | null {
  if (!p.connected) return 'Disconnected';
  if (p.sittingOut && !p.inHand) return 'Sitting out';
  if (p.chips === 0 && !p.inHand) return 'Out of chips';
  if (!p.inHand && s.phase !== 'waiting') return 'Next hand';
  return null;
}

/** "Fold" -> "Folded", "Call 20" -> "Called 20", "Raise to 60" -> "Raised to 60". */
function pastTense(action: string): string {
  if (action === 'Fold') return 'Folded';
  if (action === 'Check') return 'Checked';
  if (action.startsWith('Call ')) return `Called ${action.slice(5)}`;
  if (action.startsWith('Raise to ')) return `Raised to ${action.slice(9)}`;
  return action;
}

/** The pill under a name: the hand at showdown, else the last action, else why they are not playing. */
function actionPill(s: TableState, p: PlayerView): HTMLElement {
  const status = statusText(s, p);
  if (p.handName) return h('span', 'act-pill hand', p.handName);
  if (!p.connected) return h('span', 'act-pill muted', 'Disconnected');
  if (p.lastAction) {
    const tone = p.lastAction === 'Fold' ? 'muted' : p.lastAction === 'All in' ? 'strong' : 'amber';
    return h('span', `act-pill ${tone}`, pastTense(p.lastAction));
  }
  if (status) return h('span', 'act-pill muted', status);
  // An empty pill keeps every plate the same height.
  const blank = h('span', 'act-pill blank', ' ');
  blank.setAttribute('aria-hidden', 'true');
  return blank;
}

/** Won the pot that is lit now. */
function hasWon(spot: Spotlight | null, id: string): boolean {
  return !!spot && spot.winners.has(id);
}

/** Still in at a showdown but not a winner of the pot that is lit now. */
function hasLost(s: TableState, spot: Spotlight | null, p: PlayerView): boolean {
  return !!spot?.showdown && p.inHand && !p.folded && !spot.winners.has(p.id) && s.phase !== 'waiting';
}

/** One nameplate in the top strip: name, tags and timer, the action pill, chips, and the cards under it. */
function plateEl(s: TableState, p: PlayerView, counts: Counts, spot: Spotlight | null): HTMLElement {
  const plate = h('div', 'plate');
  plate.dataset.id = p.id;
  const turn = s.turn === p.id;
  if (turn) plate.classList.add('is-turn');
  if (p.folded) plate.classList.add('folded');
  if (!p.connected) plate.classList.add('away');
  if (!p.inHand) plate.classList.add('idle');
  if (hasWon(spot, p.id)) plate.classList.add('winner');
  else if (hasLost(s, spot, p)) plate.classList.add('lost');

  const box = h('div', 'plate-box');
  const head = h('div', 'plate-head');
  if (turn && s.deadline !== null) head.append(ringEl('plate-ring'));
  head.append(h('span', 'plate-name', p.name), ...seatTags(s, p));
  if (p.id === s.hostId) head.title = `${p.name} is the host`;
  box.append(head, actionPill(s, p));

  const chips = h('div', 'plate-chips');
  chips.append(h('span', 'num', fmt(p.chips)));
  if (p.debt > 0) chips.append(h('span', 'owes num', `owes ${fmt(p.debt)}`));
  // Phones have no bets row, so the chips in front sit on the plate there.
  if (p.bet > 0) {
    const inline = chipStack(p.bet);
    inline.classList.add('inline-bet');
    chips.append(inline);
  }
  box.append(chips);

  if (turn && s.deadline !== null) {
    const bar = h('span', 'timer-bar');
    bar.dataset.timerBar = '';
    box.append(bar);
  }
  if (isHost()) {
    const kick = h('button', 'icon-btn plate-kick');
    kick.type = 'button';
    kick.title = `Kick ${p.name}`;
    kick.setAttribute('aria-label', `Kick ${p.name}`);
    kick.append(icon('close'));
    kick.addEventListener('click', () => confirmKick(p));
    box.append(kick);
  }
  plate.append(box);

  const hand = h('div', 'hand-box size-sm');
  const { el, added, flipped } = handEl(`seat:${p.id}`, p.cards, !firstRender);
  counts.added += added;
  counts.flipped += flipped;
  markCards(el, spot, spot?.fives.get(p.id));
  hand.append(el);
  if (p.cards.length === 0) hand.classList.add('empty');
  else if (p.cards.some((c) => !isHiddenCard(c))) hand.classList.add('face-up');
  plate.append(hand);
  return plate;
}

function actionClass(text: string): string {
  if (text === 'Fold') return 'muted';
  if (text === 'All in') return 'strong';
  return 'amber';
}

interface Counts {
  added: number;
  flipped: number;
}

/** Everyone but me, in seat order starting from my left (from seat 0 while watching). */
function opponents(s: TableState, self: PlayerView): PlayerView[] {
  const n = s.seats.length;
  const start = self.seat === null ? 0 : self.seat + 1;
  const out: PlayerView[] = [];
  for (let k = 0; k < n; k++) {
    const id = s.seats[(start + k) % n];
    if (!id || id === self.id) continue;
    const p = s.players.find((x) => x.id === id);
    if (p) out.push(p);
  }
  return out;
}

/** The nameplates along the top, and under each, in the felt, the chips that player has in front. */
function renderOpponents(s: TableState, self: PlayerView, counts: Counts, spot: Spotlight | null): void {
  const list = opponents(s, self);
  $('screen-table').style.setProperty('--n', String(Math.max(1, list.length)));
  $('opponents').replaceChildren(...list.map((p) => plateEl(s, p, counts, spot)));
  $('bets').replaceChildren(
    ...list.map((p) => {
      const cell = h('div', 'bet-cell');
      if (p.bet > 0) {
        const st = chipStack(p.bet);
        st.classList.add('table-bet');
        st.dataset.id = p.id;
        cell.append(st);
      }
      return cell;
    }),
  );
}

// ------------------------------------------------------------------ middle

function renderCenter(s: TableState, self: PlayerView, counts: Counts, spot: Spotlight | null): void {
  const board = $('board');
  // Board cards flip over one at a time as the table reveals them.
  const { el, added } = handEl('board', s.board, !firstRender, true);
  counts.added += added;
  markCards(el, spot, spot?.board);
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

  // The total in the dock: every pot plus everything in front of the players.
  const total = s.pots.reduce((sum, p) => sum + p.amount, 0) + s.players.reduce((sum, p) => sum + p.bet, 0);
  $('pot-total').textContent = fmt(total);

  const pill = $('phase-pill');
  const phase = pillText(s, self);
  pill.textContent = phase.text;
  pill.className = `phase-pill ${phase.tone}`.trim();
  pill.hidden = phase.text === '';

  const banner = $('banner');
  const text = s.phase === 'showdown' || s.phase === 'hand_over' ? bannerText(s) : '';
  if (banner.textContent !== text) {
    banner.textContent = text;
    if (text && !firstRender) {
      // At showdown the banner follows the glow a moment later; after a fold win it comes at once.
      const frames = prefersReducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }];
      banner.animate(frames, { duration: 260, delay: s.result?.showdown ? CELEBRATE_MS : 0, fill: 'backwards' });
    }
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

/** My seat in the dock: name, chips, earnings, hand strength and Sit out beside my two large cards. */
function renderMe(s: TableState, self: PlayerView, counts: Counts, lit: Spotlight | null): void {
  const spot = $('my-spot');
  const turn = s.turn === self.id;
  spot.classList.toggle('is-turn', turn);
  spot.classList.toggle('folded', self.folded);
  spot.classList.toggle('winner', hasWon(lit, self.id));
  spot.classList.toggle('lost', !hasWon(lit, self.id) && hasLost(s, lit, self));

  // My chips in front of me sit on the felt, above my cards.
  const myBet = $('my-bet');
  if (self.bet > 0) {
    const st = chipStack(self.bet);
    st.classList.add('table-bet', 'my-bet');
    myBet.replaceChildren(st);
  } else myBet.replaceChildren();

  if (self.seat === null) {
    // The note in the controls says I am watching.
    spot.replaceChildren();
    return;
  }

  const info = h('div', 'me-info');
  const head = h('div', 'me-head');
  if (turn && s.deadline !== null) head.append(ringEl('hand-ring'));
  head.append(h('span', 'name', self.name), ...seatTags(s, self));
  info.append(head);

  const chips = h('div', 'me-chips');
  chips.append(h('span', 'num', `${fmt(self.chips)} chips`));
  if (self.debt > 0) chips.append(h('span', 'owes num', `owes ${fmt(self.debt)}`));
  chips.append(earningsEl(self.earnings));
  info.append(chips);

  const handName = h('div', 'my-hand-name');
  if (s.you?.handName) handName.textContent = self.folded ? `${s.you.handName} (folded)` : s.you.handName;
  else {
    const status = statusText(s, self);
    if (status && status !== 'Disconnected') handName.textContent = status === 'Next hand' ? "You're in from the next hand" : status;
  }
  const status = h('div', 'me-status');
  if (self.lastAction && BETTING.has(s.phase)) status.append(h('span', `act-pill ${actionClass(self.lastAction)}`, pastTense(self.lastAction)));
  status.append(handName);
  info.append(status);

  // Sit out, reset, pay back and borrow.
  const tools = h('div', 'my-tools');
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
  info.append(tools);

  const box = h('div', 'hand-box size-lg');
  box.dataset.id = self.id;
  const mine = s.you?.cards ?? [];
  const { el, added } = handEl('me', mine, !firstRender);
  counts.added += added;
  markCards(el, lit, lit?.fives.get(self.id));
  box.append(el);
  if (mine.length === 0) box.classList.add('empty');

  spot.replaceChildren(info, box);
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

/**
 * A pot has just been lit: the pot slides to its winners, with the chips sound, a moment after the glow.
 * The first pot of a hand also plays my win or lose jingle (only for hands I played, as before).
 */
function pushPot(s: TableState, prev: TableState, from: DOMRect | null): void {
  const r = s.result;
  const pot = r?.pots[lastPushedPot(r?.pots.length ?? 0, s.potsAwarded)];
  if (!r || !pot) return;
  if (prev.potsAwarded === 0) {
    const mine = r.players.find((x) => x.playerId === app.myId);
    if (mine && mine.net > 0) playWin();
    else if (mine && mine.net < 0) playLose();
  }
  window.setTimeout(
    () => {
      playPayout();
      for (const id of pot.winners) {
        const target =
          id === app.myId ? document.querySelector('#my-spot .hand-box') : document.querySelector(`#opponents .plate[data-id="${id}"]`);
        flyChips(from, target, pot.amount);
      }
    },
    r.showdown ? CELEBRATE_MS : 0,
  );
}

// -------------------------------------------------------------------- main

/** Draws the table. Board cards, hands and hand names that are still to be revealed are left out. */
export function renderTable(real: TableState, self: PlayerView): void {
  ingest(real, app.myId);
  const s = view(real, app.myId);
  const prev = drawn;
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
  const spot = spotlight(s);
  const pushed = !!prev && prev.hand === s.hand && s.potsAwarded > prev.potsAwarded;
  // Where the pot that is about to leave sits now; it is gone from the felt once the table is drawn again.
  const from = pushed ? ($('pots').lastElementChild ?? $('pots')).getBoundingClientRect() : null;

  renderCenter(s, self, counts, spot);
  renderOpponents(s, self, counts, spot);
  renderMe(s, self, counts, spot);
  $('felt').classList.toggle('show-results', !!spot?.showdown);

  runCardAnimations();
  playChanges(s, prev, counts);
  if (pushed && prev) pushPot(s, prev, from);
  drawn = s;
  firstRender = false;
  tick();
}

// A reveal timer fired: draw the same state again with one more card or hand on show.
onReveal(() => {
  const s = app.state;
  const self = me();
  if (s && self && s.started) renderTable(s, self);
});

// -------------------------------------------------------------------- timer

function tick(): void {
  const s = app.state;
  if (!s || !s.started || s.deadline === null) return;
  tickRings(Math.max(0, s.deadline - serverNow()), timerTotal);
}

setInterval(tick, prefersReducedMotion() ? 500 : 100);

