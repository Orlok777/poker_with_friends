// The showdown spotlight, as seen on screen: a drumroll, then each player's two cards fly from their seat to
// a spot at the middle of the felt just above the board, turn face up, are held there with the player's name
// and hand name, and fly back. When the player's cards start flying back the next player's start flying in.
//
// The flights are FLIP animations: the cards sit at their final place in a layer above the page, and only a
// transform carries them from (or back to) the rectangle measured on their seat, so any layout and screen
// size works. The timings come from reveal.ts (shared/pacing.ts); this file only draws.

import { DRUMROLL_MS, FLIGHT_MS, PACING } from '../shared/pacing.js';
import { cardEl, flipOver } from './cards.js';
import { $, h, prefersReducedMotion } from './dom.js';
import { onSpot, type SpotEvent, type SpotHand } from './reveal.js';
import { playDeal, playDrumroll } from './sound.js';

const FLY_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** The two cards overlap a little at the spot, as they do on the seats. */
const OVERLAP = 0.14;
const MAX_CW = 104;
const MIN_CW = 44;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Flier {
  hand: SpotHand;
  stage: 'in' | 'hold' | 'back';
  movers: HTMLElement[];
  cards: HTMLElement[];
  label: HTMLElement;
}

const fliers = new Map<string, Flier>();
let layer: HTMLElement | null = null;
let stack = 0;

function getLayer(): HTMLElement {
  if (!layer || !layer.isConnected) {
    layer = h('div', 'spotlight-layer');
    layer.id = 'spotlight';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
  }
  return layer;
}

const box = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// ------------------------------------------------------------------ measuring

interface Spot {
  cw: number;
  cards: [Box, Box];
  label: { left: number; top: number; width: number };
}

/** Where the cards and the name go: centred over the board, as large as the room above the board allows. */
function spotLayout(): Spot | null {
  const board = $('board').getBoundingClientRect();
  const felt = $('felt').getBoundingClientRect();
  if (board.width === 0 || felt.width === 0) return null;
  const wide = window.innerWidth >= 600;
  const labelH = wide ? 32 : 56;
  const gap = 6;
  // The room reaches up to just above the felt: the cards may cover the tops of the seats' own cards.
  const room = board.top - 8 - Math.max(felt.top - 30, 8);
  const widthCap = Math.floor((felt.width - 24) / (2 - OVERLAP));
  const cw = Math.max(MIN_CW, Math.min(Math.floor((room - labelH - gap) / 1.4), widthCap, MAX_CW));
  const cx = board.left + board.width / 2;
  const total = cw * (2 - OVERLAP);
  const labelTop = board.top - 8 - labelH;
  const top = labelTop - gap - cw * 1.4;
  const left = cx - total / 2;
  const labelW = Math.min(felt.width - 16, 380);
  return {
    cw,
    cards: [
      { x: left, y: top, w: cw, h: cw * 1.4 },
      { x: left + cw * (1 - OVERLAP), y: top, w: cw, h: cw * 1.4 },
    ],
    label: { left: cx - labelW / 2, top: labelTop, width: labelW },
  };
}

/** The two cards of a seat as rectangles. On a small phone the seat has no cards to measure, so the nameplate stands in. */
function seatCards(id: string): [Box, Box] | null {
  const mine = id === (document.getElementById('my-spot')?.querySelector<HTMLElement>('.hand-box')?.dataset.id ?? '');
  const seat = mine
    ? document.querySelector<HTMLElement>('#my-spot .hand-box')
    : document.querySelector<HTMLElement>(`#opponents .plate[data-id="${CSS.escape(id)}"] .hand-box`);
  const rects = seat ? [...seat.querySelectorAll<HTMLElement>('.card')].map((c) => box(c.getBoundingClientRect())) : [];
  if (rects.length >= 2 && rects[0]!.w > 0) return [rects[0]!, rects[1]!];
  const plate = document.querySelector<HTMLElement>(`#opponents .plate[data-id="${CSS.escape(id)}"] .plate-box`);
  if (!plate) return null;
  const r = plate.getBoundingClientRect();
  const w = 26;
  const y = r.top + r.height / 2 - w * 0.7;
  const x = r.left + r.width / 2;
  return [
    { x: x - w + 4, y, w, h: w * 1.4 },
    { x: x - 4, y, w, h: w * 1.4 },
  ];
}

function place(el: HTMLElement, b: Box): void {
  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.style.width = `${b.w}px`;
  el.style.height = `${b.h}px`;
}

/** The transform that puts an element from its place at `to` over the rectangle `from`. */
function carry(from: Box, to: Box): string {
  const a = centre(from);
  const b = centre(to);
  return `translate(${a.x - b.x}px, ${a.y - b.y}px) scale(${from.w / to.w})`;
}

// ------------------------------------------------------------------- the show

function placeLabel(f: Flier, spot: Spot): void {
  f.label.style.left = `${spot.label.left}px`;
  f.label.style.top = `${spot.label.top}px`;
  f.label.style.width = `${spot.label.width}px`;
}

function fadeLabel(label: HTMLElement, from: number, to: number, ms: number): void {
  label.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
}

function flyIn(hand: SpotHand): void {
  const spot = spotLayout();
  if (!spot) return;
  remove(hand.id);
  const calm = prefersReducedMotion();
  const from = seatCards(hand.id);
  const f: Flier = { hand, stage: 'in', movers: [], cards: [], label: h('div', 'spot-label') };
  f.label.append(h('span', 'spot-name', hand.name), h('span', 'spot-hand', hand.handName));
  f.label.style.opacity = '0';
  placeLabel(f, spot);
  const z = String(++stack);
  hand.cards.slice(0, 2).forEach((card, i) => {
    const mover = h('div', 'spot-mover');
    mover.style.setProperty('--cw', `${spot.cw}px`);
    mover.style.zIndex = z;
    place(mover, spot.cards[i]!);
    const el = cardEl(card);
    mover.append(el);
    getLayer().append(mover);
    f.movers.push(mover);
    f.cards.push(el);
    if (calm || !from) {
      mover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIGHT_MS, easing: 'ease-out' });
      return;
    }
    mover.animate([{ transform: carry(from[i]!, spot.cards[i]!) }, { transform: 'none' }], { duration: FLIGHT_MS, easing: FLY_EASE });
    // Face-down cards turn over as they arrive.
    if (!hand.faceUp) flipOver(el, FLIGHT_MS - PACING.flipMs);
  });
  getLayer().append(f.label);
  fliers.set(hand.id, f);
  playDeal();
}

function hold(hand: SpotHand): void {
  const f = fliers.get(hand.id);
  if (!f) return;
  f.stage = 'hold';
  const five = new Set(hand.five.map((c) => `${c.rank}${c.suit}`));
  for (const el of f.cards) {
    const lit = el.dataset.card !== undefined && five.has(el.dataset.card);
    el.classList.toggle('win-card', lit);
    el.classList.toggle('dim-card', !lit);
  }
  fadeLabel(f.label, 0, 1, 350);
}

function flyBack(hand: SpotHand): void {
  const f = fliers.get(hand.id);
  if (!f) return;
  f.stage = 'back';
  for (const el of f.cards) el.classList.remove('win-card', 'dim-card');
  fadeLabel(f.label, 1, 0, 220);
  const spot = spotLayout();
  const to = seatCards(hand.id);
  const calm = prefersReducedMotion();
  f.movers.forEach((mover, i) => {
    if (calm || !to || !spot) {
      mover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_MS, easing: 'ease-in', fill: 'forwards' });
      return;
    }
    mover.animate([{ transform: 'none' }, { transform: carry(to[i]!, spot.cards[i]!) }], {
      duration: FLIGHT_MS,
      easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
      fill: 'forwards',
    });
  });
  playDeal();
}

function remove(id: string): void {
  const f = fliers.get(id);
  if (!f) return;
  f.movers.forEach((m) => m.remove());
  f.label.remove();
  fliers.delete(id);
  if (fliers.size === 0) $('felt').classList.remove('spotlit');
}

function reset(): void {
  for (const id of [...fliers.keys()]) remove(id);
  $('felt').classList.remove('drumming', 'spotlit');
}

/** The window changed size: put everything where it belongs now rather than where it was measured. */
function relayout(): void {
  const spot = spotLayout();
  if (!spot) return;
  for (const f of fliers.values()) {
    placeLabel(f, spot);
    f.movers.forEach((m, i) => {
      for (const a of m.getAnimations()) a.cancel();
      m.style.setProperty('--cw', `${spot.cw}px`);
      place(m, spot.cards[i]!);
      const seat = f.stage === 'back' ? seatCards(f.hand.id) : null;
      if (seat && !prefersReducedMotion()) m.style.transform = carry(seat[i]!, spot.cards[i]!);
      else if (f.stage === 'back') m.style.opacity = '0';
    });
  }
}

onSpot((ev: SpotEvent) => {
  switch (ev.kind) {
    case 'drum':
      $('felt').classList.add('drumming', 'spotlit');
      playDrumroll(DRUMROLL_MS / 1000);
      return;
    case 'in':
      $('felt').classList.remove('drumming');
      return flyIn(ev.hand);
    case 'hold':
      return hold(ev.hand);
    case 'back':
      return flyBack(ev.hand);
    case 'done':
      return remove(ev.hand.id);
    case 'reset':
      return reset();
  }
});

window.addEventListener('resize', relayout);
