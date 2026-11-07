// Cards, chips and countdown rings, plus their animations.

import { isHiddenCard, type Card, type CardView } from '../shared/types.js';
import { PACING } from '../shared/pacing.js';
import { $, fmt, h, prefersReducedMotion } from './dom.js';

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' } as const;
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' } as const;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export const cardKey = (c: Card): string => `${c.rank}${c.suit}`;

// ------------------------------------------------------------------- cards

export function cardEl(card: CardView): HTMLElement {
  if (isHiddenCard(card)) {
    const back = h('div', 'card back');
    back.setAttribute('aria-label', 'Face-down card');
    return back;
  }
  const red = card.suit === 'H' || card.suit === 'D';
  const el = h('div', red ? 'card red' : 'card');
  el.dataset.card = cardKey(card);
  const suit = SUIT_CHAR[card.suit];
  const corner = (cls: string) => {
    const c = h('span', cls);
    c.append(h('b', undefined, card.rank), h('i', undefined, suit));
    return c;
  };
  el.append(corner('c-corner'), h('span', 'c-pip', suit), corner('c-corner c-br'));
  el.setAttribute('aria-label', `${card.rank} of ${SUIT_NAME[card.suit]}`);
  return el;
}

/** Which cards of each hand were on screen at the last render, and whether each was face down. */
const shown = new Map<string, boolean[]>();
const toDeal: HTMLElement[] = [];
const toFlip: HTMLElement[] = [];
/** Cards revealed one at a time (the board): a short flip face down to face up instead of a slide from the deck. */
const toReveal: HTMLElement[] = [];

/** Forgets what was on screen, e.g. when a new hand starts or after leaving the table. */
export function resetCardMemory(): void {
  shown.clear();
}

/**
 * Cards in a row. New cards are queued to slide in from the deck, and cards that were face down
 * and are now face up are queued to flip. Returns the row and how many cards are new and flipped.
 * With `reveal`, new cards flip over where they lie instead of sliding in from the deck.
 */
export function handEl(
  key: string,
  cards: CardView[],
  animate: boolean,
  reveal = false,
): { el: HTMLElement; added: number; flipped: number } {
  const row = h('div', 'hand');
  const before = shown.get(key) ?? [];
  let added = 0;
  let flipped = 0;
  cards.forEach((card, i) => {
    const el = cardEl(card);
    if (animate && i >= before.length) {
      (reveal ? toReveal : toDeal).push(el);
      added++;
    } else if (animate && before[i] === true && !isHiddenCard(card)) {
      toFlip.push(el);
      flipped++;
    }
    row.append(el);
  });
  shown.set(key, cards.map((c) => isHiddenCard(c)));
  return { el: row, added, flipped };
}

/** Runs the queued deal and flip animations. Call after the new cards are in the page. */
export function runCardAnimations(): void {
  const deal = toDeal.splice(0);
  const flip = toFlip.splice(0);
  const reveal = toReveal.splice(0);
  if (prefersReducedMotion()) {
    for (const el of [...deal, ...flip, ...reveal]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    return;
  }
  for (const el of reveal) flipOver(el);
  const deck = $('deck').getBoundingClientRect();
  deal.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const dx = deck.left + deck.width / 2 - (r.left + r.width / 2);
    const dy = deck.top + deck.height / 2 - (r.top + r.height / 2);
    const scale = Math.min(1, 40 / Math.max(1, r.width));
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(-12deg) scale(${scale})`, opacity: 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 340, delay: i * 70, easing: EASE, fill: 'backwards' },
    );
  });
  for (const el of flip) flipOver(el);
}

/** A card turns from its back to its face: the back turns edge-on, then the face turns up. One flip is PACING.flipMs. */
function flipOver(el: HTMLElement): void {
  const half = PACING.flipMs / 2;
  const cover = h('span', 'flip-cover');
  el.append(cover);
  const first = el.animate(
    [{ transform: 'perspective(600px) rotateY(0deg)' }, { transform: 'perspective(600px) rotateY(90deg)' }],
    { duration: half, easing: 'ease-in', fill: 'forwards' },
  );
  const done = () => {
    first.cancel();
    cover.remove();
    el.animate(
      [
        { transform: 'perspective(600px) rotateY(-90deg)', filter: 'brightness(0.7)' },
        { transform: 'none', filter: 'none' },
      ],
      { duration: half, easing: EASE },
    );
  };
  first.onfinish = done;
  // A card that is replaced while it turns must not keep its back.
  first.oncancel = () => cover.remove();
}

// ------------------------------------------------------------------- chips

export function chipColor(amount: number): string {
  if (amount >= 500) return 'c500';
  if (amount >= 100) return 'c100';
  if (amount >= 25) return 'c25';
  return 'c10';
}

/** A small stack of chip discs with the amount next to it. Bigger amounts get a taller stack. */
export function chipStack(amount: number, label?: string): HTMLElement {
  const box = h('span', 'chip-stack');
  const discs = h('span', 'discs');
  const count = amount >= 1000 ? 3 : amount >= 100 ? 2 : 1;
  for (let i = 0; i < count; i++) discs.append(h('span', `chip-disc ${chipColor(amount)}`));
  box.append(discs);
  if (label) box.append(h('span', 'stack-label', label));
  box.append(h('span', 'stack-amount num', fmt(amount)));
  return box;
}

/** Slides an element in from another element's position. */
export function slideFrom(el: HTMLElement, from: Element | null): void {
  if (prefersReducedMotion() || !from) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    return;
  }
  const a = from.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return;
  el.animate(
    [
      { transform: `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(0.8)`, opacity: 0.6 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 300, easing: EASE },
  );
}

/** A chip flies from one element to another and disappears: a pot pushed to its winner. */
export function flyChips(from: Element | DOMRect | null, to: Element | null, amount: number): void {
  if (!from || !to || prefersReducedMotion()) return;
  const a = from instanceof DOMRect ? from : from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return;
  const chip = h('span', `chip-disc flying ${chipColor(amount)}`);
  chip.style.left = `${a.left + a.width / 2 - 13}px`;
  chip.style.top = `${a.top + a.height / 2 - 13}px`;
  document.body.append(chip);
  const anim = chip.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px, ${b.top + b.height / 2 - (a.top + a.height / 2)}px)`, opacity: 0.9 },
    ],
    { duration: 520, easing: EASE },
  );
  anim.onfinish = () => chip.remove();
  anim.oncancel = () => chip.remove();
}

// ------------------------------------------------------------------- rings

/** A countdown ring. `tickRings` keeps every ring on the page up to date. */
export function ringEl(cls = ''): HTMLElement {
  const box = h('span', `ring ${cls}`.trim());
  box.dataset.ring = '';
  box.innerHTML =
    '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15.5"/>' +
    '<circle class="ring-prog" cx="18" cy="18" r="15.5" pathLength="100" stroke-dasharray="100" transform="rotate(-90 18 18)"/></svg>';
  box.append(h('span', 'ring-num num'));
  return box;
}

export function tickRings(remainingMs: number, totalMs: number): void {
  const secs = Math.ceil(remainingMs / 1000);
  const fraction = totalMs > 0 ? Math.min(1, remainingMs / totalMs) : 0;
  for (const ring of document.querySelectorAll<HTMLElement>('[data-ring]')) {
    const prog = ring.querySelector<SVGCircleElement>('.ring-prog');
    if (prog) prog.style.strokeDashoffset = String(100 - fraction * 100);
    const num = ring.querySelector('.ring-num');
    if (num && num.textContent !== String(secs)) {
      num.textContent = String(secs);
      num.classList.toggle('three', secs >= 100);
    }
    ring.classList.toggle('urgent', secs <= 5);
    ring.setAttribute('aria-label', `${secs} seconds left`);
  }
  // The thin countdown bar under the current player's seat.
  for (const bar of document.querySelectorAll<HTMLElement>('[data-timer-bar]')) {
    bar.style.transform = `scaleX(${fraction})`;
    bar.classList.toggle('urgent', secs <= 5);
  }
}
