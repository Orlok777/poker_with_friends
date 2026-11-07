// The browser's reveal pacing (client/reveal.ts), played against fake timers: how the board and the hands
// are shown one at a time, and that the first state after a page load is shown as it is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, PlayerView, TableState } from '../shared/types.js';
import { ingest, onReveal, resetReveal, syncNextState, view } from '../client/reveal.js';

let reduced = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  reduced = false;
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    matchMedia: () => ({ matches: reduced }),
  });
  resetReveal();
  onReveal(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const BOARD: Card[] = [card('K', 'S'), card('7', 'D'), card('2', 'C'), card('9', 'H'), card('4', 'S')];

function player(id: string, seat: number, extra: Partial<PlayerView> = {}): PlayerView {
  return {
    id, name: id, chips: 1000, ready: true, connected: true, debt: 0, earnings: 0, seat, sittingOut: false,
    inHand: true, folded: false, allIn: false, bet: 0, lastAction: null, cards: [{ hidden: true }, { hidden: true }],
    handName: null, ...extra,
  };
}

const UP = [card('A', 'S'), card('A', 'H')];

/** Me (seat 0) and two opponents (seats 1 and 2), the button on seat 0, so seat 1 is first to show. */
function table(board: number, shown: boolean, mineName: string | null): TableState {
  const names = ['Pair of kings', 'Two pair, kings and sevens'];
  return {
    type: 'table_state', phase: shown ? 'showdown' : 'river', started: true, hand: 1, buttonSeat: 0,
    seats: ['me', 'bob', 'cy'], board: BOARD.slice(0, board),
    players: [
      player('me', 0, { cards: UP }),
      player('bob', 1, shown ? { cards: UP, handName: names[0]! } : {}),
      player('cy', 2, shown ? { cards: UP, handName: names[1]! } : {}),
    ],
    you: { cards: UP, handName: mineName, legal: null },
  } as unknown as TableState;
}

const boardOn = (s: TableState) => view(s, 'me').board.length;
const faceUp = (s: TableState, id: string) => !('hidden' in view(s, 'me').players.find((p) => p.id === id)!.cards[0]!);
const nameOf = (s: TableState, id: string) => view(s, 'me').players.find((p) => p.id === id)!.handName;

describe('first load', () => {
  it('shows the state as it is, without replaying the reveal', () => {
    const s = table(5, true, 'Two pair, aces and kings');
    ingest(s, 'me');
    expect(view(s, 'me')).toBe(s);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does the same on a reconnect', () => {
    ingest(table(3, false, 'Pair of aces'), 'me');
    syncNextState();
    const s = table(5, true, 'Two pair, aces and kings');
    ingest(s, 'me');
    expect(view(s, 'me')).toBe(s);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the board', () => {
  it('flips the flop one card at a time, 500 ms apart', () => {
    ingest(table(0, false, 'Pair of aces'), 'me');
    const flop = table(3, false, 'Three aces');
    ingest(flop, 'me');
    expect(boardOn(flop)).toBe(0);
    vi.advanceTimersByTime(0);
    expect(boardOn(flop)).toBe(1);
    vi.advanceTimersByTime(499);
    expect(boardOn(flop)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(boardOn(flop)).toBe(2);
    vi.advanceTimersByTime(500);
    expect(boardOn(flop)).toBe(3);
  });

  it('waits a beat of 600 ms before a turn or river card', () => {
    ingest(table(3, false, 'Pair of aces'), 'me'); // the first state is shown as it is
    const turn = table(4, false, 'Pair of aces');
    ingest(turn, 'me');
    vi.advanceTimersByTime(599);
    expect(boardOn(turn)).toBe(3);
    vi.advanceTimersByTime(1);
    expect(boardOn(turn)).toBe(4);
  });

  it('shows several streets that arrive together street by street, a second apart', () => {
    ingest(table(0, false, 'Pair of aces'), 'me');
    const all = table(5, false, 'Two pair, aces and kings');
    ingest(all, 'me');
    const at = (ms: number) => {
      vi.advanceTimersByTime(ms - Date.now() + start);
      return boardOn(all);
    };
    const start = Date.now();
    expect(at(0)).toBe(1);
    expect(at(1000)).toBe(3); // the flop: 0, 500, 1000
    expect(at(1000 + 349 + 1000)).toBe(3); // the flop's last flip takes 350 ms, then a second
    expect(at(1000 + 350 + 1000)).toBe(4); // the turn
    expect(at(1000 + 350 + 1000 + 350 + 999)).toBe(4);
    expect(at(1000 + 350 + 1000 + 350 + 1000)).toBe(5); // the river
  });

  it('holds my hand name back until the card it needs is on screen', () => {
    ingest(table(3, false, 'Pair of aces'), 'me');
    vi.advanceTimersByTime(5000);
    const turn = table(4, false, 'Two pair, aces and nines');
    ingest(turn, 'me');
    expect(view(turn, 'me').you?.handName).toBe('Pair of aces');
    vi.advanceTimersByTime(600);
    expect(view(turn, 'me').you?.handName).toBe('Two pair, aces and nines');
  });
});

describe('the showdown', () => {
  it('flips the hands one player at a time, in seat order from the left of the button, each with its name', () => {
    const before = table(5, false, 'Two pair, aces and kings');
    ingest(before, 'me');
    const s = table(5, true, 'Two pair, aces and kings');
    ingest(s, 'me');
    expect(faceUp(s, 'bob')).toBe(false);
    expect(nameOf(s, 'bob')).toBeNull();
    vi.advanceTimersByTime(0);
    expect(faceUp(s, 'bob')).toBe(true);
    expect(nameOf(s, 'bob')).toBe('Pair of kings');
    expect(faceUp(s, 'cy')).toBe(false);
    expect(nameOf(s, 'cy')).toBeNull();
    vi.advanceTimersByTime(799);
    expect(faceUp(s, 'cy')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(faceUp(s, 'cy')).toBe(true);
    expect(nameOf(s, 'cy')).toBe('Two pair, kings and sevens');
  });

  it('flips the hands first and then runs out the board when everyone is all in', () => {
    ingest(table(0, false, null), 'me');
    const early = table(0, true, 'High card, ace');
    ingest(early, 'me');
    vi.advanceTimersByTime(800);
    expect(faceUp(early, 'cy')).toBe(true);
    // A flop that arrives while the last hand is still turning waits for it, and then a second.
    const flop = table(3, true, 'Three aces');
    ingest(flop, 'me');
    vi.advanceTimersByTime(350 + 999);
    expect(boardOn(flop)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(boardOn(flop)).toBe(1);
  });
});

describe('reduced motion', () => {
  it('keeps the order with short waits', () => {
    reduced = true;
    ingest(table(3, false, 'Pair of aces'), 'me');
    const s = table(5, true, 'Two pair, aces and kings');
    ingest(s, 'me');
    // Hands first, then the turn and river, every wait at most 150 ms.
    vi.advanceTimersByTime(0);
    expect(faceUp(s, 'bob')).toBe(true);
    expect(faceUp(s, 'cy')).toBe(false);
    vi.advanceTimersByTime(150);
    expect(faceUp(s, 'cy')).toBe(true);
    expect(boardOn(s)).toBe(3);
    vi.advanceTimersByTime(150 + 150);
    expect(boardOn(s)).toBe(4);
    vi.advanceTimersByTime(150 + 150 + 150);
    expect(boardOn(s)).toBe(5);
  });
});
