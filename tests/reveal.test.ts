// The browser's reveal pacing (client/reveal.ts), played against fake timers: how the board is shown one card
// at a time, how the showdown spotlight takes every hand in turn (the viewer's own included), what the log and
// the pots show meanwhile, and that the first state after a page load is shown as it is.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spotlightSequenceMs } from '../shared/pacing.js';
import type { Card, PlayerView, TableState } from '../shared/types.js';
import { awayIds, holdNow, ingest, onReveal, onSpot, resetReveal, spotlightActive, syncNextState, view, type SpotEvent } from '../client/reveal.js';

let reduced = false;
let events: { t: number; kind: SpotEvent['kind']; id?: string; faceUp?: boolean }[] = [];
let t0 = 0;

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
  events = [];
  t0 = Date.now();
  onSpot((ev) => events.push({ t: Date.now() - t0, kind: ev.kind, ...('hand' in ev ? { id: ev.hand.id, faceUp: ev.hand.faceUp } : {}) }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
const BOARD: Card[] = [card('K', 'S'), card('7', 'D'), card('2', 'C'), card('9', 'H'), card('4', 'S')];
const UP = [card('A', 'S'), card('A', 'H')];
const OTHERS = ['bob', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal', 'ivy'];

function player(id: string, seat: number, extra: Partial<PlayerView> = {}): PlayerView {
  return {
    id, name: id, chips: 1000, ready: true, connected: true, debt: 0, earnings: 0, seat, sittingOut: false,
    inHand: true, folded: false, allIn: false, bet: 0, lastAction: null, cards: [{ hidden: true }, { hidden: true }],
    handName: null, ...extra,
  };
}

interface Opts {
  /** Opponents (the button is on my seat 0, so they take their turn in this order and I come last). */
  others?: number;
  board?: number;
  phase?: string;
  /** Cards of the opponents as the server sends them: face up from showdown on, and in an all-in runout. */
  faceUp?: boolean;
  potsAwarded?: number;
  log?: string[];
}

function table(o: Opts = {}): TableState {
  const others = OTHERS.slice(0, o.others ?? 2);
  const phase = o.phase ?? 'river';
  const showdown = phase === 'showdown';
  const faceUp = o.faceUp ?? showdown;
  const five = [...UP, BOARD[0]!, BOARD[1]!, BOARD[2]!];
  return {
    type: 'table_state', phase, started: true, hand: 1, buttonSeat: 0,
    seats: ['me', ...others], board: BOARD.slice(0, o.board ?? 5), potsAwarded: o.potsAwarded ?? 0, pots: [],
    players: [
      player('me', 0, { cards: UP }),
      ...others.map((id, i) => player(id, i + 1, faceUp ? { cards: UP, handName: `Hand of ${id}` } : {})),
    ],
    you: { cards: UP, handName: 'Hand of me', legal: null },
    log: (o.log ?? []).map((text, id) => ({ id, text })),
    result: showdown
      ? {
          showdown: true,
          players: [],
          shown: ['me', ...others].map((playerId) => ({ playerId, handName: `Hand of ${playerId}`, cards: five })),
          pots: [{ amount: 300, winners: ['me'], handName: 'Hand of me', hands: [], shares: { me: 300 } }],
        }
      : null,
  } as unknown as TableState;
}

const boardOn = (s: TableState) => view(s, 'me').board.length;
const faceUp = (s: TableState, id: string) => !('hidden' in view(s, 'me').players.find((p) => p.id === id)!.cards[0]!);
const nameOf = (s: TableState, id: string) => view(s, 'me').players.find((p) => p.id === id)!.handName;
const advanceTo = (ms: number) => vi.advanceTimersByTime(t0 + ms - Date.now());
const when = (kind: SpotEvent['kind'], id?: string) => events.find((e) => e.kind === kind && e.id === id)?.t;

describe('first load', () => {
  it('shows the state as it is, without replaying the reveal', () => {
    const s = table({ board: 5, phase: 'showdown', potsAwarded: 1 });
    ingest(s, 'me');
    expect(view(s, 'me')).toBe(s);
    expect(vi.getTimerCount()).toBe(0);
    expect(events).toEqual([]);
  });

  it('does the same on a reconnect', () => {
    ingest(table({ board: 3 }), 'me');
    syncNextState();
    const s = table({ board: 5, phase: 'showdown', potsAwarded: 1 });
    ingest(s, 'me');
    expect(view(s, 'me')).toBe(s);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the final result at once when the page is refreshed in the middle of a showdown', () => {
    const s = table({ board: 5, phase: 'showdown', potsAwarded: 0, log: ['Hand 1: x', 'bob shows a pair', 'me shows a pair', 'me wins 300 with a pair'] });
    ingest(s, 'me');
    const v = view(s, 'me');
    expect(v.potsAwarded).toBe(1);
    expect(v.log).toHaveLength(4);
    expect(faceUp(s, 'bob')).toBe(true);
    expect(nameOf(s, 'bob')).toBe('Hand of bob');
    expect(spotlightActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
  });
});

describe('the board', () => {
  it('flips the flop one card at a time, 500 ms apart', () => {
    ingest(table({ board: 0 }), 'me');
    const flop = table({ board: 3 });
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
    ingest(table({ board: 3 }), 'me'); // the first state is shown as it is
    const turn = table({ board: 4 });
    ingest(turn, 'me');
    vi.advanceTimersByTime(599);
    expect(boardOn(turn)).toBe(3);
    vi.advanceTimersByTime(1);
    expect(boardOn(turn)).toBe(4);
  });

  it('shows several streets that arrive together street by street, a second apart', () => {
    ingest(table({ board: 0 }), 'me');
    const all = table({ board: 5 });
    ingest(all, 'me');
    advanceTo(0);
    expect(boardOn(all)).toBe(1);
    advanceTo(1000);
    expect(boardOn(all)).toBe(3); // the flop: 0, 500, 1000
    advanceTo(1000 + 349 + 1000);
    expect(boardOn(all)).toBe(3); // the flop's last flip takes 350 ms, then a second
    advanceTo(1000 + 350 + 1000);
    expect(boardOn(all)).toBe(4); // the turn
    advanceTo(1000 + 350 + 1000 + 350 + 999);
    expect(boardOn(all)).toBe(4);
    advanceTo(1000 + 350 + 1000 + 350 + 1000);
    expect(boardOn(all)).toBe(5); // the river
  });

  it('holds my hand name back until the card it needs is on screen', () => {
    ingest(table({ board: 3 }), 'me');
    vi.advanceTimersByTime(5000);
    const turn = table({ board: 4 });
    turn.you!.handName = 'Two pair, aces and nines';
    ingest(turn, 'me');
    expect(view(turn, 'me').you?.handName).toBe('Hand of me');
    vi.advanceTimersByTime(600);
    expect(view(turn, 'me').you?.handName).toBe('Two pair, aces and nines');
  });
});

describe('the showdown spotlight', () => {
  /** The river is on screen; then the showdown state arrives. */
  function startShowdown(others: number, extra: Partial<Opts> = {}): TableState {
    ingest(table({ others, ...extra }), 'me');
    const s = table({ others, phase: 'showdown', ...extra });
    ingest(s, 'me');
    return s;
  }

  it('starts with a drumroll, then takes every hand in turn from the left of the button, my own last here', () => {
    startShowdown(2);
    advanceTo(spotlightSequenceMs(3));
    expect(events.filter((e) => e.kind === 'drum')).toEqual([{ t: 0, kind: 'drum' }]);
    const order = events.filter((e) => e.kind === 'in').map((e) => e.id);
    expect(order).toEqual(['bob', 'cy', 'me']);
    for (const id of order) {
      const own = events.filter((e) => e.id === id).map((e) => e.kind);
      expect(own).toEqual(['in', 'hold', 'back', 'done']);
    }
  });

  it('times a turn as a 450 ms flight in, a 2 s hold and a 450 ms flight back', () => {
    startShowdown(2);
    advanceTo(spotlightSequenceMs(3));
    expect(when('in', 'bob')).toBe(1000);
    expect(when('hold', 'bob')).toBe(1450);
    expect(when('back', 'bob')).toBe(3450);
    expect(when('done', 'bob')).toBe(3900);
  });

  it('starts the next flight half a flight before the previous cards are back', () => {
    startShowdown(2);
    advanceTo(spotlightSequenceMs(3));
    // cy's cards start flying in 225 ms after bob's start flying back, and 225 ms before they land.
    expect(when('in', 'cy')).toBe(when('back', 'bob')! + 225);
    expect(when('in', 'cy')).toBe(when('done', 'bob')! - 225);
    expect(when('in', 'me')).toBe(when('back', 'cy')! + 225);
  });

  it('takes 6.6 s with two players, 11.9 s with four and 25.3 s with nine', () => {
    for (const [others, total] of [[1, 6575], [3, 11925], [8, 25300]] as const) {
      resetReveal();
      events = [];
      t0 = Date.now();
      startShowdown(others);
      advanceTo(total - 1);
      expect(spotlightActive()).toBe(true);
      advanceTo(total);
      expect(spotlightActive()).toBe(false);
      expect(spotlightSequenceMs(others + 1)).toBe(total);
      expect(events.at(-1)).toMatchObject({ kind: 'done', t: total });
    }
  });

  it('includes my own seat, whose cards are already face up', () => {
    startShowdown(1);
    advanceTo(spotlightSequenceMs(2));
    expect(events.find((e) => e.kind === 'in' && e.id === 'me')?.faceUp).toBe(true);
    expect(events.find((e) => e.kind === 'in' && e.id === 'bob')?.faceUp).toBe(false);
  });

  it('keeps the other hands face down until their turn, and shows each hand name only after its turn', () => {
    const s = startShowdown(2);
    advanceTo(999);
    expect(faceUp(s, 'bob')).toBe(false);
    expect(awayIds().size).toBe(0);
    advanceTo(1000);
    expect([...awayIds()]).toEqual(['bob']);
    expect(nameOf(s, 'bob')).toBeNull();
    advanceTo(1450);
    expect(holdNow()?.id).toBe('bob');
    expect(holdNow()?.five.has('AS')).toBe(true);
    advanceTo(3675); // cy flies in while bob's cards are still flying back
    expect([...awayIds()].sort()).toEqual(['bob', 'cy']);
    advanceTo(3900);
    expect(faceUp(s, 'bob')).toBe(true);
    expect(nameOf(s, 'bob')).toBe('Hand of bob');
    // cy's cards are away in the spotlight by now (the seat hides them), and not named yet.
    expect([...awayIds()]).toEqual(['cy']);
    expect(nameOf(s, 'cy')).toBeNull();
  });

  it('shows the pots as won only after the last spotlight', () => {
    startShowdown(1);
    const later = table({ others: 1, phase: 'showdown', potsAwarded: 1 });
    ingest(later, 'me');
    advanceTo(spotlightSequenceMs(2) - 1);
    expect(view(later, 'me').potsAwarded).toBe(0);
    advanceTo(spotlightSequenceMs(2));
    expect(view(later, 'me')).toBe(later);
  });

  it('holds the log back with the table, line by line', () => {
    const log = ['Hand 1: dealt', 'Flop: a', 'bob shows a pair', 'cy shows a pair', 'me shows a pair', 'me wins 300 with a pair'];
    const s = startShowdown(2, { log, potsAwarded: 1 });
    const lines = () => view(s, 'me').log.map((e) => e.text);
    advanceTo(1000);
    expect(lines()).toEqual(log.slice(0, 2));
    advanceTo(1450); // bob is held
    expect(lines()).toEqual(log.slice(0, 3));
    advanceTo(1000 + 2675 + 450); // cy is held
    expect(lines()).toEqual(log.slice(0, 4));
    advanceTo(1000 + 2 * 2675 + 450); // me
    expect(lines()).toEqual(log.slice(0, 5));
    advanceTo(spotlightSequenceMs(3));
    expect(lines()).toEqual(log);
  });

  it('keeps the same order and timing with reduced motion', () => {
    reduced = true;
    startShowdown(2);
    advanceTo(spotlightSequenceMs(3));
    expect(when('drum')).toBe(0);
    expect(when('in', 'bob')).toBe(1000);
    expect(when('hold', 'cy')).toBe(1000 + 2675 + 450);
    expect(when('done', 'me')).toBe(spotlightSequenceMs(3));
  });

  it('does not run when the hand is won by everyone else folding', () => {
    ingest(table(), 'me');
    const s = table({ phase: 'hand_over' });
    ingest(s, 'me');
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([]);
  });
});

describe('an all-in runout', () => {
  it('flips the hands on their seats, runs out the board, and only then starts the spotlight', () => {
    ingest(table({ board: 0, faceUp: false }), 'me');
    // The server turns the hands over at once and deals the streets; both arrive together here.
    const runout = table({ board: 5, faceUp: true });
    ingest(runout, 'me');
    const showdown = table({ board: 5, phase: 'showdown' });
    ingest(showdown, 'me');
    expect(faceUp(runout, 'bob')).toBe(false);
    advanceTo(0);
    expect(faceUp(runout, 'bob')).toBe(true);
    expect(faceUp(runout, 'cy')).toBe(false);
    advanceTo(800);
    expect(faceUp(runout, 'cy')).toBe(true);
    // Hands (ending at 1150), then the flop, the turn and the river a second apart: the last flip ends at 6200.
    advanceTo(6199);
    expect(events).toEqual([]);
    advanceTo(6200);
    expect(when('drum')).toBe(6200);
    advanceTo(6200 + spotlightSequenceMs(3));
    expect(when('in', 'bob')).toBe(7200);
    // Their cards were already turned over on the seat, so they do not turn again.
    expect(events.find((e) => e.kind === 'in' && e.id === 'bob')?.faceUp).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', id: 'me', t: 6200 + spotlightSequenceMs(3) });
  });
});
