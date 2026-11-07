// The pace of the table. The server sends the real state as soon as something happens. This file decides how
// much of it is on screen right now: `view()` hides the board cards, hands, hand names, pots won and log lines
// that have not been revealed yet, and timers reveal them in order and ask the table to draw again.
//
// What is revealed, in order:
//   - board cards flip one at a time, street by street;
//   - in an all-in runout the hands flip on their seats first, one player at a time;
//   - at showdown there is a drumroll and then every hand in turn, the viewer's own included, flies to the
//     spotlight, is held with its hand name, and flies back (the visuals are in spotlight.ts);
//   - then the server lights the pots one by one.
//
// Nothing here is a replay: the first state after a page load or a reconnect is shown as it is, at once,
// with the final result and the full log.

import {
  DRUMROLL_MS,
  FLIGHT_MS,
  PACING,
  SPOTLIGHT_MS,
  SPOTLIGHT_STRIDE_MS,
  STREETS,
  leadMs,
} from '../shared/pacing.js';
import { isHiddenCard, type Card, type LogEntry, type PlayerView, type TableState } from '../shared/types.js';
import { prefersReducedMotion } from './dom.js';

/** With reduced motion the board and runout waits stay in order but are this short. */
const REDUCED_MS = 150;

/** One hand in the spotlight. */
export interface SpotHand {
  id: string;
  name: string;
  handName: string;
  /** The two hole cards, face up here whether or not they are face up on the seat. */
  cards: Card[];
  /** The best five cards, hole and board. */
  five: Card[];
  /** Already face up on the seat (my own hand, or after an all-in runout). */
  faceUp: boolean;
}

export type SpotEvent =
  | { kind: 'drum' }
  | { kind: 'reset' }
  | { kind: 'in' | 'hold' | 'back' | 'done'; hand: SpotHand };

type Stage = 'in' | 'hold' | 'back' | 'done';

let hand = -1;
/** True until the next state has been taken in as it is: first load, reconnect and refresh. */
let syncNext = true;
/** Board cards on screen now, and how many have been shown or are scheduled. */
let boardShown = 0;
let boardPlanned = 0;
/** Opponents whose hands are face up on their seat now, and everyone whose flip has been scheduled. */
const flipped = new Set<string>();
const flipPlanned = new Set<string>();
/** Seat flips of an all-in runout that are scheduled but have not happened yet. */
let pendingFlips = 0;
/** The spotlight of this hand: planned once, who is in it in order, and where each player is in their turn. */
let spotPlanned = false;
let spotQueue: SpotHand[] = [];
const stage = new Map<string, Stage>();
/** Players whose hand has been held in the spotlight (or was shown before this page loaded). */
const heard = new Set<string>();
/** After a refresh in the middle of a showdown: show the final result at once. */
let finalForced = false;
/** When the last scheduled reveal is done (performance.now()). */
let cursor = 0;
let timers: number[] = [];
let redraw: () => void = () => {};
let spotListener: (ev: SpotEvent) => void = () => {};
/** What each hand name was for each board size, so a name only shows once the cards it depends on are visible. */
const names = new Map<string, Map<number, string>>();
const MINE = 'you';

/** The table registers how to draw itself again after a reveal. */
export function onReveal(fn: () => void): void {
  redraw = fn;
}

/** The spotlight registers how to show the drumroll and the flights. */
export function onSpot(fn: (ev: SpotEvent) => void): void {
  spotListener = fn;
}

function clearTimers(): void {
  for (const t of timers) window.clearTimeout(t);
  timers = [];
}

function forget(): void {
  const wasSpot = spotPlanned;
  clearTimers();
  boardShown = 0;
  boardPlanned = 0;
  flipped.clear();
  flipPlanned.clear();
  pendingFlips = 0;
  spotPlanned = false;
  spotQueue = [];
  stage.clear();
  heard.clear();
  finalForced = false;
  names.clear();
  cursor = 0;
  if (wasSpot) spotListener({ kind: 'reset' });
}

/** Forgets everything, e.g. after leaving the table. The next state is shown as it is. */
export function resetReveal(): void {
  forget();
  hand = -1;
  syncNext = true;
}

/** After a reconnect the next state is shown as it is, so nothing is replayed. */
export function syncNextState(): void {
  syncNext = true;
}

function remember(key: string, boardSize: number, name: string | null): void {
  if (!name) return;
  let byBoard = names.get(key);
  if (!byBoard) names.set(key, (byBoard = new Map()));
  byBoard.set(boardSize, name);
}

/** The name for the cards on screen: the newest one that does not need a card that is not shown yet. */
function nameAt(key: string, boardSize: number): string | null {
  const byBoard = names.get(key);
  if (!byBoard) return null;
  for (let k = boardSize; k >= 0; k--) {
    const name = byBoard.get(k);
    if (name) return name;
  }
  return null;
}

const showsFace = (p: PlayerView): boolean => p.cards.length > 0 && !isHiddenCard(p.cards[0]!);
const cardId = (c: Card): string => `${c.rank}${c.suit}`;

/** Players still in the hand, in seat order starting left of the button. */
function showdownOrder(s: TableState): PlayerView[] {
  const n = Math.max(1, s.seats.length);
  const from = s.buttonSeat ?? 0;
  return s.players
    .filter((p) => p.inHand && !p.folded && p.seat !== null)
    .sort((a, b) => ((a.seat! - from - 1 + n) % n) - ((b.seat! - from - 1 + n) % n));
}

function at(ms: number, fn: () => void): void {
  timers.push(window.setTimeout(fn, Math.max(0, ms)));
}

/** The spotlight has been planned and some player has not finished their turn yet. */
function spotBusy(): boolean {
  return spotPlanned && spotQueue.some((p) => stage.get(p.id) !== 'done');
}

/** Hand data for the spotlight, taken from the state (at showdown every hand is public). */
function spotHandsOf(s: TableState, myId: string | null): SpotHand[] {
  const result = s.result;
  if (!result?.showdown) return [];
  const shown = new Map(result.shown.map((w) => [w.playerId, w]));
  const out: SpotHand[] = [];
  for (const p of showdownOrder(s)) {
    const w = shown.get(p.id);
    const cards = p.id === myId ? (s.you?.cards ?? []) : p.cards.filter((c): c is Card => !isHiddenCard(c));
    if (!w || cards.length < 2) continue;
    out.push({ id: p.id, name: p.name, handName: w.handName, cards, five: w.cards, faceUp: p.id === myId || flipPlanned.has(p.id) });
  }
  return out;
}

/** Takes in a new state: shows it as it is the first time, otherwise schedules the reveals it brings. */
export function ingest(s: TableState, myId: string | null): void {
  if (s.hand !== hand || s.phase === 'waiting') {
    forget();
    hand = s.hand;
  }
  const size = s.board.length;
  for (const p of s.players) remember(p.id === myId ? MINE : p.id, size, p.id === myId ? (s.you?.handName ?? null) : p.handName);

  if (syncNext) {
    syncNext = false;
    boardShown = boardPlanned = size;
    // Hands that are already face up stay face up; hands still hidden will flip in turn when they are shown.
    for (const p of s.players) {
      if (showsFace(p) && p.id !== myId) {
        flipped.add(p.id);
        flipPlanned.add(p.id);
      }
    }
    if (s.result?.showdown) {
      // A refresh in the middle of a showdown shows every hand, the names and the final result at once.
      spotPlanned = true;
      for (const w of s.result.shown) heard.add(w.playerId);
      finalForced = s.potsAwarded < s.result.pots.length;
    }
    return;
  }

  const calm = prefersReducedMotion();
  const wait = (ms: number) => (calm ? Math.min(ms, REDUCED_MS) : ms);
  const now = performance.now();

  // In an all-in runout the hands turn face up on their seats, one player at a time, in seat order. My own
  // cards are always face up, so I take no turn there; the server counts every hand, so it waits long enough.
  // At showdown itself the hands stay hidden until their spotlight.
  if (s.phase !== 'showdown') {
    const fresh = showdownOrder(s).filter((p) => !flipPlanned.has(p.id));
    const turns = fresh.filter((p) => p.id !== myId && showsFace(p));
    if (turns.length > 0) {
      for (const p of fresh) flipPlanned.add(p.id);
      const busy = cursor > now;
      const begin = busy ? cursor + wait(PACING.handGapMs) : now;
      pendingFlips += turns.length;
      turns.forEach((p, i) => {
        at(begin + i * wait(PACING.handGapMs) - now, () => {
          flipped.add(p.id);
          pendingFlips--;
          redraw();
        });
      });
      cursor = begin + (turns.length - 1) * wait(PACING.handGapMs) + wait(PACING.flipMs);
    }
  }

  // New board cards, street by street. A street after another reveal waits a full second.
  for (const [first, count] of STREETS) {
    const end = first + count;
    if (end <= boardPlanned || end > size) continue;
    const busy = cursor > now;
    const begin = busy ? cursor + wait(PACING.streetGapMs) : now + wait(leadMs(count));
    for (let j = 0; j < count; j++) {
      at(begin + j * wait(PACING.flopGapMs) - now, () => {
        boardShown = Math.max(boardShown, first + j + 1);
        redraw();
      });
    }
    cursor = begin + (count - 1) * wait(PACING.flopGapMs) + wait(PACING.flipMs);
    boardPlanned = end;
  }

  // The showdown: once the board is out, a drumroll and every hand in turn. The timings are the same with
  // reduced motion (only the movement goes), so they always match what the server waits for.
  if (s.phase === 'showdown' && !spotPlanned && s.result?.showdown) {
    spotPlanned = true;
    const queue = spotHandsOf(s, myId);
    if (queue.length < 2) {
      for (const p of queue) {
        flipped.add(p.id);
        heard.add(p.id);
      }
    } else {
      spotQueue = queue;
      const begin = Math.max(now, cursor);
      at(begin - now, () => spotListener({ kind: 'drum' }));
      queue.forEach((h, i) => {
        const t0 = begin + DRUMROLL_MS + i * SPOTLIGHT_STRIDE_MS;
        const go = (when: number, next: Stage, after: () => void) =>
          at(when - now, () => {
            stage.set(h.id, next);
            after();
          });
        // The seat is drawn again first (its cards are hidden while the player is away), then the flight starts.
        go(t0, 'in', () => {
          redraw();
          spotListener({ kind: 'in', hand: h });
        });
        go(t0 + FLIGHT_MS, 'hold', () => {
          heard.add(h.id);
          redraw();
          spotListener({ kind: 'hold', hand: h });
        });
        go(t0 + FLIGHT_MS + SPOTLIGHT_MS, 'back', () => {
          redraw();
          spotListener({ kind: 'back', hand: h });
        });
        go(t0 + 2 * FLIGHT_MS + SPOTLIGHT_MS, 'done', () => {
          flipped.add(h.id);
          redraw(); // the cards are on their seat again, face up, before the flying copies go
          spotListener({ kind: 'done', hand: h });
        });
      });
    }
  }
}

// ------------------------------------------------------------------ what is on screen

/** Players whose cards are away from their seat, in the spotlight or flying to or from it. */
export function awayIds(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [id, st] of stage) if (st !== 'done') out.add(id);
  return out;
}

/** The player held in the spotlight right now, with the keys ("K♠" style ids) of their best five cards. */
export function holdNow(): { id: string; five: Set<string> } | null {
  for (const h of spotQueue) {
    if (stage.get(h.id) === 'hold') return { id: h.id, five: new Set(h.five.map(cardId)) };
  }
  return null;
}

/** The drumroll or the spotlight is still going on. */
export function spotlightActive(): boolean {
  return spotBusy();
}

/** How many pots have been pushed as far as the table is concerned: none until the spotlight is over. */
function potsShown(s: TableState): number {
  if (!s.result) return s.potsAwarded;
  if (finalForced) return s.result.pots.length;
  if (spotBusy()) return 0;
  return s.potsAwarded;
}

const STREET_CARDS: Record<string, number> = { Flop: 3, Turn: 4, River: 5 };
const POT_LINE = / (wins|split) (the main pot |side pot \d+ )?[\d,]+/;

/**
 * The log up to the first line the table has not revealed yet. Lines about board cards, shown hands and
 * pots won wait for their reveal; everything after such a line waits too, so the order is never broken.
 */
function visibleLog(s: TableState, size: number, myId: string | null, pots: number): LogEntry[] {
  let header = -1;
  for (let i = s.log.length - 1; i >= 0; i--) {
    if (s.log[i]!.text.startsWith(`Hand ${s.hand}:`)) {
      header = i;
      break;
    }
  }
  if (header < 0) return s.log;
  let potLines = 0;
  let end = s.log.length;
  for (let i = header + 1; i < s.log.length; i++) {
    const text = s.log[i]!.text;
    let ok = true;
    const street = /^(Flop|Turn|River): /.exec(text);
    if (street) ok = size >= STREET_CARDS[street[1]!]!;
    else {
      const who = s.players.find((p) => text.startsWith(`${p.name} shows `));
      if (who) {
        if (/[♠♥♦♣]/.test(text)) ok = who.id === myId ? pendingFlips === 0 : flipped.has(who.id);
        else ok = heard.has(who.id);
      } else if (POT_LINE.test(text)) {
        ok = potLines < pots;
        potLines++;
      }
    }
    if (!ok) {
      end = i;
      break;
    }
  }
  return end === s.log.length ? s.log : s.log.slice(0, end);
}

/** The state with `k` pots pushed to their winners, from a state where the server has pushed `s.potsAwarded`. */
function withPots(s: TableState, players: PlayerView[], k: number): { players: PlayerView[]; pots: TableState['pots'] } {
  const r = s.result!;
  const len = r.pots.length;
  const shareOf = (id: string, from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += r.pots[i]!.shares[id] ?? 0;
    return sum;
  };
  return {
    // The server's chips leave out what is still in a pot; put every share back, then take out what is still in ours.
    players: players.map((p) => ({ ...p, chips: p.chips + shareOf(p.id, 0, len - s.potsAwarded) - shareOf(p.id, 0, len - k) })),
    pots: r.pots.slice(0, len - k).map((pot) => ({ amount: pot.amount, eligible: [...pot.winners] })),
  };
}

/** The state as far as it has been revealed. Returns `s` itself once everything is on screen. */
export function view(s: TableState, myId: string | null): TableState {
  const size = Math.min(boardShown, s.board.length);
  const k = potsShown(s);
  const log = visibleLog(s, size, myId, k);
  const myName = s.you ? nameAt(MINE, size) : null;

  const mask = (p: PlayerView): PlayerView => {
    if (p.id === myId || !showsFace(p)) return p;
    if (flipped.has(p.id)) {
      const name = nameAt(p.id, size);
      return p.handName === name ? p : { ...p, handName: name };
    }
    // In the spotlight: the cards are there (the table hides them on the seat while they are away) but not named yet.
    if (stage.has(p.id)) return p.handName === null ? p : { ...p, handName: null };
    return { ...p, cards: p.cards.map(() => ({ hidden: true as const })), handName: null };
  };
  const masked = s.players.map(mask);
  const changed = masked.some((p, i) => p !== s.players[i]);
  const potsDiffer = k !== s.potsAwarded;
  const behind = changed || potsDiffer || size < s.board.length || log !== s.log || (s.you !== null && s.you.handName !== myName);
  if (!behind) return s;

  let players = masked;
  let pots = s.pots;
  if (potsDiffer && s.result) ({ players, pots } = withPots(s, masked, k));
  return {
    ...s,
    board: s.board.slice(0, size),
    players,
    pots,
    potsAwarded: k,
    log,
    you: s.you ? { ...s.you, handName: myName } : null,
  };
}
