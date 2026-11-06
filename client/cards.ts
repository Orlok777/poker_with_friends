// Cards, hands, chips, result pills and countdown rings, plus their animations.

import { isHiddenCard, type CardView, type HandView } from '../shared/types.js';
import { $, fmt, h, prefersReducedMotion } from './dom.js';
import { playFlip } from './sound.js';

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' } as const;
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' } as const;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// ------------------------------------------------------------------- cards

export function cardEl(card: CardView): HTMLElement {
  if (isHiddenCard(card)) {
    const back = h('div', 'card back');
    back.setAttribute('aria-label', 'Face-down card');
    return back;
  }
  const red = card.suit === 'H' || card.suit === 'D';
  const el = h('div', red ? 'card red' : 'card');
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

/** How many cards of each hand were already on screen, so only new cards slide in. */
const shownCount = new Map<string, number>();
/** Whether the dealer's hole card was face down at the last render, to flip it when revealed. */
let holeWasHidden = false;
const toDeal: HTMLElement[] = [];
const toFlip: HTMLElement[] = [];

/** Tells the animations that `n` cards of this hand are already on screen, e.g. the first card of a split hand. */
export function setShownCards(key: string, n: number): void {
  shownCount.set(key, n);
}

/** Forgets what was on screen, e.g. after leaving the table. */
export function resetCardMemory(): void {
  shownCount.clear();
  holeWasHidden = false;
}

/** Cards in a row, overlapping. New cards are queued to slide in from the shoe. Returns the hand and how many cards are new. */
export function handEl(key: string, cards: CardView[], animate: boolean): { el: HTMLElement; added: number } {
  const hand = h('div', 'hand');
  const prev = shownCount.get(key) ?? 0;
  let added = 0;
  cards.forEach((card, i) => {
    const el = cardEl(card);
    if (animate && i >= prev) {
      toDeal.push(el);
      added++;
    } else if (animate && key === 'dealer' && i === 1 && holeWasHidden && !isHiddenCard(card)) {
      toFlip.push(el);
    }
    hand.append(el);
  });
  shownCount.set(key, cards.length);
  if (key === 'dealer') holeWasHidden = cards.length > 1 && isHiddenCard(cards[1]!);
  return { el: hand, added };
}

/** Runs the queued deal and flip animations. Call after the new hands are in the page. */
export function runCardAnimations(): void {
  const deal = toDeal.splice(0);
  const flip = toFlip.splice(0);
  if (flip.length > 0) playFlip();
  if (prefersReducedMotion()) {
    for (const el of [...deal, ...flip]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    return;
  }
  const shoe = $('shoe').getBoundingClientRect();
  deal.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dx = shoe.left + shoe.width / 2 - (r.left + r.width / 2);
    const dy = shoe.top + shoe.height / 2 - (r.top + r.height / 2);
    const scale = Math.min(1, 46 / Math.max(1, r.width));
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(-12deg) scale(${scale})`, opacity: 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 340, delay: i * 70, easing: EASE, fill: 'backwards' },
    );
  });
  for (const el of flip) {
    el.animate(
      [
        { transform: 'perspective(600px) rotateY(-90deg)', filter: 'brightness(0.7)' },
        { transform: 'none', filter: 'none' },
      ],
      { duration: 300, easing: EASE },
    );
  }
}

// ------------------------------------------------------------------ totals

/** "7/17" for a soft hand still in play, otherwise the best total. */
export function totalLabel(total: number, soft: boolean, final: boolean): string {
  if (soft && total < 21 && !final) return `${total - 10}/${total}`;
  return String(total);
}

export function totalBadge(text: string, kind: '' | 'bust' | 'bj' = ''): HTMLElement {
  return h('span', kind ? `total-badge ${kind}` : 'total-badge', text);
}

// ------------------------------------------------------------------- chips

export function chipColor(amount: number): string {
  if (amount >= 500) return 'c500';
  if (amount >= 100) return 'c100';
  if (amount >= 25) return 'c25';
  return 'c10';
}

/** A chip disc with the amount next to it. */
export function betChip(amount: number, opts: { doubled?: boolean; pending?: boolean; allIn?: boolean } = {}): HTMLElement {
  const box = h('span', opts.pending ? 'bet-chip pending' : 'bet-chip');
  box.append(h('span', `chip-disc ${chipColor(amount)}`), h('span', 'bet-amount num', fmt(amount)));
  if (opts.doubled) box.append(h('span', 'bet-x', '×2'));
  if (opts.allIn) box.append(h('span', 'bet-allin', 'ALL IN'));
  return box;
}

/** WIN +100, BLACKJACK +150, PUSH, BUST −100 or LOSE −100. Null when the round is not settled. */
export function resultPill(p: HandView): HTMLElement | null {
  if (!p.outcome) return null;
  const d = p.delta ?? 0;
  const amount = fmt(Math.abs(d));
  switch (p.outcome) {
    case 'win':
      return h('span', 'result win', `WIN +${amount}`);
    case 'blackjack':
      return h('span', 'result bj', `BLACKJACK +${amount}`);
    case 'push':
      return h('span', 'result push', 'PUSH');
    case 'loss':
      return h('span', 'result loss', p.status === 'bust' ? `BUST −${amount}` : `LOSE −${amount}`);
  }
}

/** Slides an element in from another element's position, e.g. a chip from the bet panel to the felt. */
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
}
