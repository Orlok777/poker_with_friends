// The pace of the table: board cards flip one at a time and, at showdown, the hands flip one player at a time.
//
// The server sends the real state as soon as something happens. This file decides how much of it is on
// screen right now: `view()` hides the board cards, the hands and the hand names that have not been revealed
// yet, and timers reveal them in order and ask the table to draw again. Nothing here is a replay: the first
// state after a page load or a reconnect is shown as it is, at once.

import { PACING, STREETS, leadMs } from '../shared/pacing.js';
import { isHiddenCard, type PlayerView, type TableState } from '../shared/types.js';
import { prefersReducedMotion } from './dom.js';

/** With reduced motion the order stays but every wait is this short. */
const REDUCED_MS = 150;

let hand = -1;
/** True until the next state has been taken in as it is: first load, reconnect and refresh. */
let syncNext = true;
/** Board cards on screen now, and how many have been shown or are scheduled. */
let boardShown = 0;
let boardPlanned = 0;
/** Opponents whose hands are face up on screen now, and everyone whose flip has been scheduled. */
const flipped = new Set<string>();
const flipPlanned = new Set<string>();
/** When the last scheduled reveal is done (performance.now()). */
let cursor = 0;
let timers: number[] = [];
let redraw: () => void = () => {};
/** What each hand name was for each board size, so a name only shows once the cards it depends on are visible. */
const names = new Map<string, Map<number, string>>();
const MINE = 'you';

/** The table registers how to draw itself again after a reveal. */
export function onReveal(fn: () => void): void {
  redraw = fn;
}

function clearTimers(): void {
  for (const t of timers) window.clearTimeout(t);
  timers = [];
}

function forget(): void {
  clearTimers();
  boardShown = 0;
  boardPlanned = 0;
  flipped.clear();
  flipPlanned.clear();
  names.clear();
  cursor = 0;
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
    return;
  }

  const calm = prefersReducedMotion();
  const wait = (ms: number) => (calm ? Math.min(ms, REDUCED_MS) : ms);
  const now = performance.now();

  // Hands that just turned face up flip one player at a time, in seat order. My own cards are always face up,
  // so I take no turn; the server counts every hand, so it always waits long enough.
  const fresh = showdownOrder(s).filter((p) => !flipPlanned.has(p.id));
  const turns = fresh.filter((p) => p.id !== myId && showsFace(p));
  if (turns.length > 0) {
    for (const p of fresh) flipPlanned.add(p.id);
    const busy = cursor > now;
    const begin = busy ? cursor + wait(PACING.handGapMs) : now;
    turns.forEach((p, i) => {
      at(begin + i * wait(PACING.handGapMs) - now, () => {
        flipped.add(p.id);
        redraw();
      });
    });
    cursor = begin + (turns.length - 1) * wait(PACING.handGapMs) + wait(PACING.flipMs);
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
}

/** The state as far as it has been revealed. Returns `s` itself once everything is on screen. */
export function view(s: TableState, myId: string | null): TableState {
  const size = Math.min(boardShown, s.board.length);
  const hidden = (p: PlayerView) => p.id !== myId && showsFace(p) && !flipped.has(p.id);
  const named = (p: PlayerView) => p.id !== myId && showsFace(p) && flipped.has(p.id) && p.handName !== nameAt(p.id, size);
  const myName = s.you ? nameAt(MINE, size) : null;
  const behind = size < s.board.length || s.players.some((p) => hidden(p) || named(p)) || (s.you !== null && s.you.handName !== myName);
  if (!behind) return s;
  return {
    ...s,
    board: s.board.slice(0, size),
    players: s.players.map((p) => {
      if (hidden(p)) return { ...p, cards: p.cards.map(() => ({ hidden: true as const })), handName: null };
      if (named(p)) return { ...p, handName: nameAt(p.id, size) };
      return p;
    }),
    you: s.you ? { ...s.you, handName: myName } : null,
  };
}
