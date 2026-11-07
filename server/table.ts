// The one table: players, seats, button, settings, timers and the flow of each hand.
// It talks to clients only through the small `Connection` interface. All betting rules live in
// game.ts and all hand ranking in hand.ts.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  USERNAME_PATTERN,
  cardText,
  validateSettings,
  type ActionKind,
  type Card,
  type CardView,
  type ClientMsg,
  type ErrorCode,
  type HandResult,
  type LogEntry,
  type Phase,
  type PlayerView,
  type PotView,
  type PublicSettings,
  type ServerMsg,
  type Settings,
  type TableState,
  type YouView,
} from '../shared/types.js';
import { PACING, handsRevealMs, leadMs, spotlightSequenceMs, streetRevealMs } from '../shared/pacing.js';
import { Deck, mulberry32, randomSeed } from './deck.js';
import { HoldemHand, type HandOutcome } from './game.js';
import { bestHand, inSentence } from './hand.js';
import type { PlayerStore } from './store.js';

/** One client connection. The WebSocket layer implements this; tests can use a fake. */
export interface Connection {
  send(msg: ServerMsg): void;
  close(): void;
}

/** Pause after a hand won because everyone else folded. */
export const FOLD_WIN_PAUSE_MS = 2000;
/** How long the result stays on screen once the last pot has gone to its winner. */
export const RESULT_LOOK_MS = 3000;
/** Time between pots being lit and pushed at showdown (side pots first, the main pot last). */
export const POT_STEP_MS = 2000;

/**
 * The pause after a showdown, worked out in one place. It starts when the showdown is sent to the clients.
 * They first show the board cards they have not shown yet (`boardCards`), then play the drumroll and the
 * spotlight for every hand in turn (`hands`, the viewer's own included), then light the winners of each
 * pot (`pots`, side pots first and the main pot last), and the result stays on screen for RESULT_LOOK_MS.
 * The timings are those in shared/pacing.ts, which the browser plays.
 */
export function showdownPlan(boardCards: number, hands: number, pots = 1): { firstPotMs: number; totalMs: number } {
  const reveal = streetRevealMs(boardCards) + spotlightSequenceMs(hands);
  return { firstPotMs: reveal, totalMs: reveal + Math.max(0, pots - 1) * POT_STEP_MS + RESULT_LOOK_MS };
}

export interface Timing {
  /** Gap between hole cards being dealt. */
  dealMs: number;
  /** Pause before the flop, turn and river. */
  streetMs: number;
  /** The pause people see between the last card of one street flipping and the next street's first card, in an all-in runout. */
  runoutMs: number;
  /** Gap between pots being pushed to their winners at showdown. */
  potMs: number;
  /** How long results stay on screen after the last pot of a showdown has been pushed. */
  showdownMs: number;
  /** How long results stay on screen after a hand won without a showdown. */
  foldWinMs: number;
  /** How long a disconnected player's seat is held. */
  holdMs: number;
  /** Multiplies the time the clients need to show cards (1 normally; tests use 0 to skip it). */
  revealScale: number;
  /** Test override for the turn timer; ignored when the host turned the turn timer off. */
  turnMs?: number;
}

export const DEFAULT_TIMING: Timing = {
  dealMs: 300,
  streetMs: 600,
  runoutMs: PACING.streetGapMs,
  potMs: POT_STEP_MS,
  showdownMs: RESULT_LOOK_MS,
  foldWinMs: FOLD_WIN_PAUSE_MS,
  holdMs: 20_000,
  revealScale: 1,
};

export interface TableOptions {
  store: PlayerStore;
  hostToken: string;
  timing?: Partial<Timing>;
  /** Seed for the shuffles. Each hand is seeded from the operating system's randomness when absent. */
  seed?: number;
  /** Cards dealt first in each hand: rigged[0] for hand 1, rigged[1] for hand 2... For tests only. */
  rigged?: Card[][];
  log?: (message: string) => void;
}

interface Player {
  id: string;
  name: string;
  key: string;
  token: string;
  /** The stack. During a hand it follows the engine, so it does not include chips put in. */
  chips: number;
  /** Borrowed chips not paid back. Saved with the chips. */
  debt: number;
  /** Profit or loss from the cards, saved with the chips. Reset to 0 by Reset chips. */
  earnings: number;
  ready: boolean;
  seat: number | null;
  conn: Connection | null;
  holdTimer: NodeJS.Timeout | null;
  /** Left, was kicked, or lost the seat hold while in a hand. Removed once the hand is over. */
  leaving: boolean;
  sittingOut: boolean;
}

const LOG_LIMIT = 40;
const MAX_NAME_LEN = 16;
const n = (x: number) => x.toLocaleString('en-US');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const ACTIONS: ActionKind[] = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
const BETTING_PHASES: Phase[] = ['preflop', 'flop', 'turn', 'river'];

export class Table {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private phase: Phase = 'waiting';
  private started = false;
  private handNo = 0;
  private hostId: string | null = null;
  private readonly players = new Map<string, Player>();
  private seats: (string | null)[] = Array(DEFAULT_SETTINGS.maxPlayers).fill(null);
  private readonly connections = new Set<Connection>();
  private readonly bound = new Map<Connection, string>();
  private readonly kickedKeys = new Set<string>();
  private turn: string | null = null;
  private deadline: number | null = null;
  private flow: NodeJS.Timeout | null = null;
  private logEntries: LogEntry[] = [];
  private logId = 0;
  private waitingLogged = false;
  private closed = false;
  /** False after the last player left: only the host link can open a new game. */
  private gameOpen = true;

  // ---- the current hand
  private eng: HoldemHand | null = null;
  private buttonSeat: number | null = null;
  /** Seat of each player in the hand, by engine index. */
  private handSeats: number[] = [];
  /** Hole cards dealt so far, counted one at a time round the table. */
  private holeShown = 0;
  private dealing = false;
  /** Players whose hole cards are face up for everyone. */
  private readonly revealed = new Set<string>();
  private outcome: HandOutcome | null = null;
  private result: HandResult | null = null;
  /** How many pots have been pushed to their winners, last side pot first and the main pot last. */
  private potsAwarded = 0;
  /** Board cards in the last table_state sent, so the showdown knows how many the clients have yet to show. */
  private boardSent = 0;
  /** Cards of the street dealt in the step now being handled, for the runout pacing. */
  private justDealt = 0;

  private readonly store: PlayerStore;
  private readonly hostToken: string;
  private readonly timing: Timing;
  private readonly seedRng: (() => number) | null;
  private readonly rigged: Card[][];
  private readonly logger: (message: string) => void;

  constructor(options: TableOptions) {
    this.store = options.store;
    this.hostToken = options.hostToken;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.seedRng = options.seed === undefined ? null : mulberry32(options.seed);
    this.rigged = options.rigged ?? [];
    this.logger = options.log ?? ((m) => console.error(m));
  }

  // ------------------------------------------------------------ connections

  connect(conn: Connection): void {
    if (this.closed) {
      conn.close();
      return;
    }
    this.connections.add(conn);
    conn.send(this.serverInfo());
  }

  disconnect(conn: Connection): void {
    this.connections.delete(conn);
    const id = this.bound.get(conn);
    this.bound.delete(conn);
    if (!id) return;
    const p = this.players.get(id);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    this.addLog(`${p.name} disconnected`);
    this.startHold(p);
    // With the turn timer off, a disconnected player must not freeze the table.
    if (this.turn === p.id && this.settings.turnSeconds === null && this.flow === null) {
      this.armTurnTimer(p);
    }
    this.broadcast();
  }

  /** Stops all timers. Connections are closed by the caller. */
  close(): void {
    this.closed = true;
    this.clearFlow();
    for (const p of this.players.values()) this.clearHold(p);
  }

  // --------------------------------------------------------------- messages

  handleMessage(conn: Connection, raw: string): void {
    if (this.closed) return;
    try {
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        this.sendError(conn, 'bad_message', 'Messages must be JSON');
        return;
      }
      if (msg === null || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
        this.sendError(conn, 'bad_message', 'Message needs a type');
        return;
      }
      this.dispatch(conn, msg as ClientMsg);
    } catch (err) {
      // No single message may take the server down.
      this.logger(`Error handling message: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      this.sendError(conn, 'bad_message', 'The server could not handle that message');
    }
  }

  private dispatch(conn: Connection, msg: ClientMsg): void {
    if (msg.type === 'join') return this.onJoin(conn, msg);

    const p = this.playerOf(conn);
    if (!p) return this.sendError(conn, 'not_joined', 'Join the table first');

    switch (msg.type) {
      case 'leave':
        return this.onLeave(conn, p);
      case 'set_ready':
        return this.onSetReady(conn, p, msg.ready);
      case 'update_settings':
        return this.onUpdateSettings(conn, p, msg.settings);
      case 'start_game':
        return this.onStartGame(conn, p);
      case 'action':
        return this.onAction(conn, p, msg.action, msg.amount);
      case 'sit_out':
        return this.onSitOut(conn, p, msg.sittingOut);
      case 'reset_chips':
        return this.onResetChips(conn, p);
      case 'borrow':
        return this.onBorrow(conn, p);
      case 'pay_back':
        return this.onPayBack(conn, p);
      case 'kick_player':
        return this.onKick(conn, p, msg.playerId);
      default:
        return this.sendError(conn, 'bad_message', 'Unknown message type');
    }
  }

  // ------------------------------------------------------------------- join

  private onJoin(conn: Connection, msg: Extract<ClientMsg, { type: 'join' }>): void {
    if (this.bound.has(conn)) return this.sendError(conn, 'already_joined', 'You have already joined');

    if (typeof msg.username !== 'string') return this.sendError(conn, 'bad_username', 'Enter a username');
    const username = msg.username.trim();
    if (username.length < 1 || username.length > MAX_NAME_LEN || !USERNAME_PATTERN.test(username)) {
      return this.sendError(
        conn,
        'bad_username',
        'Usernames are 1 to 16 characters: letters, numbers, spaces, - and _',
      );
    }
    const key = username.toLowerCase();

    const asHost =
      typeof msg.hostToken === 'string' && msg.hostToken.length > 0 && safeEqual(msg.hostToken, this.hostToken);

    if (!this.gameOpen) {
      if (!asHost) {
        return this.sendError(conn, 'game_closed', 'This game has ended. Ask the host to create a new game.');
      }
      this.openGame(conn);
    }

    if (this.kickedKeys.has(key)) {
      return this.sendError(conn, 'kicked', 'You were kicked from this table and can not rejoin until the server restarts');
    }

    const existing = [...this.players.values()].find((x) => x.key === key);
    if (existing) {
      const tokenOk =
        typeof msg.reconnectToken === 'string' && existing.token !== '' && safeEqual(msg.reconnectToken, existing.token);
      if (!tokenOk) return this.sendError(conn, 'name_in_use', 'That name is in use');
      return this.reconnect(conn, existing, asHost);
    }

    if (this.settings.password !== '') {
      const given = typeof msg.password === 'string' ? msg.password : '';
      if (!safeEqual(given, this.settings.password)) return this.sendError(conn, 'wrong_password', 'Wrong password');
    }

    const saved = this.store.get(username);
    const name = saved?.name ?? username;
    const chips = saved ? saved.chips : this.settings.startingChips;
    const debt = saved ? saved.debt : 0;
    const earnings = saved ? saved.earnings : 0;
    if (!saved) this.store.set(name, chips);

    const p: Player = {
      id: randomBytes(6).toString('hex'),
      name,
      key,
      token: randomBytes(16).toString('hex'),
      chips,
      debt,
      earnings,
      ready: false,
      seat: null,
      conn,
      holdTimer: null,
      leaving: false,
      sittingOut: false,
    };
    this.players.set(p.id, p);
    this.bound.set(conn, p.id);
    if (asHost) this.hostId = p.id;

    this.addLog(`${p.name} joined`);
    conn.send({ type: 'joined', playerId: p.id, reconnectToken: p.token, isHost: this.hostId === p.id });

    // A game in progress gives the newcomer a free seat; they are dealt in from the next hand.
    if (this.started) this.assignSeats();
    this.broadcast();
    this.maybeStartHand();
  }

  private reconnect(conn: Connection, p: Player, asHost: boolean): void {
    if (p.conn && p.conn !== conn) {
      this.bound.delete(p.conn);
      p.conn.send({ type: 'error', code: 'already_joined', message: 'This player was opened in another tab' });
      p.conn.close();
    }
    p.conn = conn;
    p.leaving = false;
    this.clearHold(p);
    this.bound.set(conn, p.id);
    if (asHost) this.hostId = p.id;
    this.addLog(`${p.name} reconnected`);
    conn.send({ type: 'joined', playerId: p.id, reconnectToken: p.token, isHost: this.hostId === p.id });
    // With the turn timer off, the fallback timer for an absent player is no longer needed.
    if (this.turn === p.id && this.settings.turnSeconds === null) {
      this.clearFlow();
      this.deadline = null;
    }
    this.broadcast();
    this.maybeStartHand();
  }

  // --------------------------------------------------------- leave and drop

  private onLeave(conn: Connection, p: Player): void {
    this.bound.delete(conn);
    p.conn = null;
    p.token = ''; // an explicit leave can not be undone with the old token
    this.addLog(`${p.name} left`);
    this.dropPlayer(p);
    conn.send(this.serverInfo());
  }

  private startHold(p: Player): void {
    this.clearHold(p);
    p.holdTimer = setTimeout(() => {
      p.holdTimer = null;
      if (this.closed || p.conn) return;
      this.addLog(`${p.name} did not come back`);
      this.dropPlayer(p);
    }, this.timing.holdMs);
  }

  private clearHold(p: Player): void {
    if (p.holdTimer) clearTimeout(p.holdTimer);
    p.holdTimer = null;
  }

  /** Dealt into the hand that is being played or shown right now. */
  private inHand(p: Player): boolean {
    return this.eng !== null && this.phase !== 'waiting' && this.eng.player(p.id) !== undefined;
  }

  /** In a hand that is not over yet, so reset, pay back and borrow must wait. */
  private inLiveHand(p: Player): boolean {
    return this.inHand(p) && this.phase !== 'hand_over';
  }

  /** Removes a player now, or folds their hand and removes them once the hand is over. */
  private dropPlayer(p: Player): void {
    this.clearHold(p);
    if (this.inLiveHand(p)) {
      p.leaving = true;
      this.foldOutOfTurn(p);
      return;
    }
    if (this.inHand(p)) {
      p.leaving = true; // the results are still on screen; removed when the next hand starts
      this.broadcast();
      return;
    }
    this.removePlayer(p);
  }

  /** Folds a player's hand at once, also when it is not their turn. Their chips stay in the pot. */
  private foldOutOfTurn(p: Player): void {
    const eng = this.eng!;
    const before = { status: eng.status, toAct: eng.toAct };
    const r = eng.forceFold(p.id);
    if (!r.ok) {
      this.broadcast();
      return;
    }
    this.addLog(`${p.name} folds`);
    this.logUncalled(r.uncalled);
    if (this.dealing) {
      this.syncChips();
      this.broadcast(); // the deal goes on; its last step looks at the hand again
      return;
    }
    if (eng.status !== before.status || eng.toAct !== before.toAct) this.afterChange();
    else {
      this.syncChips();
      this.broadcast();
    }
  }

  private removePlayer(p: Player): void {
    this.store.set(p.name, p.chips, p.debt, p.earnings);
    this.store.save();
    this.clearHold(p);
    if (p.seat !== null) this.seats[p.seat] = null;
    this.players.delete(p.id);
    if (p.conn) {
      this.bound.delete(p.conn);
      p.conn = null;
    }
    if (this.hostId === p.id) this.hostId = null;
    if (this.players.size === 0) {
      this.endGame();
      return;
    }
    if (this.started) this.assignSeats(); // a watcher takes the free seat
    this.broadcast();
  }

  /** The last player left: forget this game completely. A new one needs the host link. */
  private endGame(): void {
    this.clearFlow();
    this.gameOpen = false;
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'waiting';
    this.started = false;
    this.handNo = 0;
    this.hostId = null;
    this.seats = Array(DEFAULT_SETTINGS.maxPlayers).fill(null);
    this.kickedKeys.clear();
    this.turn = null;
    this.deadline = null;
    this.logEntries = [];
    this.waitingLogged = false;
    this.buttonSeat = null;
    this.clearHand();
    this.tellUnjoined();
  }

  /** The host created a new game. Everyone still on the join screen is told it is open again. */
  private openGame(except: Connection): void {
    this.gameOpen = true;
    this.tellUnjoined(except);
  }

  private tellUnjoined(except?: Connection): void {
    for (const c of this.connections) {
      if (c === except || this.bound.has(c)) continue;
      try {
        c.send(this.serverInfo());
      } catch (err) {
        this.logger(`Could not send to a client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---------------------------------------------------------- waiting room

  private onSetReady(conn: Connection, p: Player, ready: unknown): void {
    if (this.started) return this.sendError(conn, 'wrong_phase', 'Ready only applies in the waiting room');
    if (typeof ready !== 'boolean') return this.sendError(conn, 'bad_message', 'ready must be true or false');
    p.ready = ready;
    this.broadcast();
  }

  private onUpdateSettings(conn: Connection, p: Player, patch: unknown): void {
    if (this.hostId !== p.id) return this.sendError(conn, 'not_host', 'Only the host can change settings');
    if (this.started) return this.sendError(conn, 'settings_locked', 'Settings are locked once the game has started');
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return this.sendError(conn, 'invalid_settings', 'Settings must be an object');
    }
    const next: Settings = { ...this.settings };
    const input = patch as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (key in input) (next as unknown as Record<string, unknown>)[key] = input[key];
    }
    const problem = validateSettings(next);
    if (problem) return this.sendError(conn, 'invalid_settings', problem);
    if (next.maxPlayers < this.players.size) {
      return this.sendError(conn, 'invalid_settings', 'Max players can not be lower than the players already here');
    }
    this.settings = next;
    this.seats = Array(next.maxPlayers).fill(null);
    this.broadcast();
  }

  private onStartGame(conn: Connection, p: Player): void {
    if (this.hostId !== p.id) return this.sendError(conn, 'not_host', 'Only the host can start the game');
    if (this.started) return this.sendError(conn, 'wrong_phase', 'The game has already started');
    if ([...this.players.values()].filter((x) => x.ready).length < 2) {
      return this.sendError(conn, 'cannot_start', 'At least two players must be ready');
    }
    this.started = true;
    this.assignSeats();
    this.addLog('The game has started');
    this.broadcast();
    this.maybeStartHand();
  }

  // ------------------------------------------------------------ seats, chips

  private assignSeats(): void {
    for (const p of this.players.values()) {
      if (p.seat !== null || p.leaving) continue;
      const free = this.seats.findIndex((s) => s === null);
      if (free < 0) break;
      this.seats[free] = p.id;
      p.seat = free;
    }
  }

  private seatedInOrder(): Player[] {
    return this.seats
      .map((id) => (id ? this.players.get(id) : undefined))
      .filter((p): p is Player => p !== undefined);
  }

  /** Seated, here, has chips and is not sitting out. */
  private canPlay(p: Player): boolean {
    return p.seat !== null && !p.leaving && !p.sittingOut && p.conn !== null && p.chips > 0;
  }

  private onSitOut(conn: Connection, p: Player, sittingOut: unknown): void {
    if (typeof sittingOut !== 'boolean') return this.sendError(conn, 'bad_message', 'sittingOut must be true or false');
    if (p.seat === null) return this.sendError(conn, 'not_seated', 'You do not have a seat yet');
    if (p.sittingOut === sittingOut) return this.broadcast();
    p.sittingOut = sittingOut;
    this.addLog(sittingOut ? `${p.name} sits out from the next hand` : `${p.name} is back in from the next hand`);
    this.broadcast();
    this.maybeStartHand();
  }

  private saveChips(p: Player): void {
    this.store.set(p.name, p.chips, p.debt, p.earnings);
    this.store.save();
  }

  private onResetChips(conn: Connection, p: Player): void {
    if (this.inLiveHand(p)) {
      return this.sendError(conn, 'cannot_reset', 'You can reset your chips once you are not in a hand');
    }
    p.chips = this.settings.startingChips;
    p.debt = 0; // a reset is a fresh start, so any loan and the earnings are wiped too
    p.earnings = 0;
    this.saveChips(p);
    this.addLog(`${p.name} reset their chips to ${n(p.chips)}`);
    this.broadcast();
    this.maybeStartHand();
  }

  /** Pays borrowed chips back out of the player's chips, as much as the chips allow. */
  private onPayBack(conn: Connection, p: Player): void {
    if (this.inLiveHand(p)) {
      return this.sendError(conn, 'cannot_pay_back', 'You can pay back once you are not in a hand');
    }
    if (p.debt <= 0) return this.sendError(conn, 'cannot_pay_back', 'You do not owe anything');
    if (p.chips <= 0) return this.sendError(conn, 'cannot_pay_back', 'You have no chips to pay back with');
    const amount = Math.min(p.chips, p.debt);
    p.chips -= amount;
    p.debt -= amount;
    this.saveChips(p);
    this.addLog(p.debt > 0 ? `${p.name} pays back ${n(amount)} and still owes ${n(p.debt)}` : `${p.name} pays back ${n(amount)} and owes nothing`);
    this.broadcast();
  }

  /** A seated player who is out of chips borrows a buy-in (the starting chips) and owes it. */
  private onBorrow(conn: Connection, p: Player): void {
    if (p.seat === null) return this.sendError(conn, 'cannot_borrow', 'You need a seat to borrow chips');
    if (p.chips > 0) return this.sendError(conn, 'cannot_borrow', 'You can only borrow when you are out of chips');
    if (this.inLiveHand(p)) return this.sendError(conn, 'cannot_borrow', 'You can borrow once the hand is over');
    const amount = this.settings.startingChips;
    p.chips += amount;
    p.debt += amount;
    this.saveChips(p);
    this.addLog(`${p.name} borrows ${n(amount)} and now owes ${n(p.debt)}`);
    this.broadcast();
    this.maybeStartHand();
  }

  // ------------------------------------------------------------------ hands

  private clearHand(): void {
    this.eng = null;
    this.handSeats = [];
    this.holeShown = 0;
    this.dealing = false;
    this.revealed.clear();
    this.outcome = null;
    this.result = null;
    this.potsAwarded = 0;
    this.boardSent = 0;
    this.justDealt = 0;
  }

  /** Starts a hand if the table is idle and at least two players can play. */
  private maybeStartHand(): void {
    if (!this.started || this.phase !== 'waiting' || this.closed || !this.gameOpen) return;
    this.assignSeats();
    const dealt = this.seatedInOrder().filter((p) => this.canPlay(p));
    if (dealt.length < 2) {
      if (!this.waitingLogged) {
        this.waitingLogged = true;
        this.addLog('Waiting for players');
        this.broadcast();
      }
      return;
    }
    this.waitingLogged = false;
    this.startHand(dealt);
  }

  private handSeed(): number {
    return this.seedRng ? Math.floor(this.seedRng() * 2 ** 32) : randomSeed();
  }

  private startHand(dealt: Player[]): void {
    this.clearFlow();
    this.clearHand();
    this.handNo++;

    // The button moves to the next dealt-in player on the left; the first hand picks one at random.
    let button: number;
    if (this.buttonSeat === null) {
      button = Math.floor(mulberry32(this.handSeed())() * dealt.length);
    } else {
      const from = this.buttonSeat;
      const after = dealt.findIndex((p) => p.seat! > from);
      button = after >= 0 ? after : 0;
    }
    this.buttonSeat = dealt[button]!.seat;

    const deck = new Deck(mulberry32(this.handSeed()), this.rigged[this.handNo - 1] ?? []);
    const { smallBlind, bigBlind } = this.settings;
    this.eng = new HoldemHand({
      players: dealt.map((p) => ({ id: p.id, stack: p.chips })),
      button,
      smallBlind,
      bigBlind,
      draw: () => deck.draw(),
    });
    this.handSeats = dealt.map((p) => p.seat!);
    this.syncChips();

    const eng = this.eng;
    const sb = dealt[eng.sbIndex]!;
    const bb = dealt[eng.bbIndex]!;
    this.addLog(`Hand ${this.handNo}: ${dealt[button]!.name} has the button`);
    this.addLog(`${sb.name} posts the small blind ${n(eng.players[eng.sbIndex]!.totalIn)}`);
    this.addLog(`${bb.name} posts the big blind ${n(eng.players[eng.bbIndex]!.totalIn)}`);

    this.phase = 'preflop';
    this.turn = null;
    this.deadline = null;
    this.dealing = true;
    this.dealStep();
  }

  /** Deals the hole cards one at a time, then starts the betting. */
  private dealStep(): void {
    const eng = this.eng!;
    if (this.holeShown >= eng.players.length * 2) {
      this.dealing = false;
      this.afterChange();
      return;
    }
    this.holeShown++;
    this.broadcast();
    this.setFlow(() => this.dealStep(), this.timing.dealMs);
  }

  /** Copies the engine's stacks to the players in the hand. */
  private syncChips(): void {
    const eng = this.eng;
    if (!eng) return;
    for (const hp of eng.players) {
      const p = this.players.get(hp.id);
      if (p) p.chips = hp.stack;
    }
  }

  /** Looks at the engine after every change and moves the hand on. */
  private afterChange(): void {
    const eng = this.eng!;
    const dealt = this.justDealt;
    this.justDealt = 0;
    this.syncChips();
    this.turn = null;
    this.deadline = null;
    switch (eng.status) {
      case 'betting': {
        const p = this.players.get(eng.players[eng.toAct!]!.id)!;
        this.turn = p.id;
        this.armTurnTimer(p);
        this.broadcast();
        return;
      }
      case 'street_over': {
        const runout = eng.isRunout();
        const flipped = runout ? this.revealAll(false) : 0;
        this.broadcast();
        this.setFlow(() => this.dealStreet(), runout ? this.runoutWaitMs(flipped, dealt) : this.timing.streetMs);
        return;
      }
      case 'showdown':
        return this.showdown();
      case 'fold_win':
        return this.foldWin();
      default:
        return;
    }
  }

  private dealStreet(): void {
    const eng = this.eng!;
    const cards = eng.dealNext();
    this.phase = eng.street;
    this.justDealt = cards.length;
    const label = eng.street.charAt(0).toUpperCase() + eng.street.slice(1);
    this.addLog(`${label}: ${cards.map(cardText).join(' ')}`);
    this.afterChange();
  }

  /** The time the clients need to show cards, which tests can shrink with `revealScale`. */
  private reveal(ms: number): number {
    return Math.round(ms * this.timing.revealScale);
  }

  /**
   * How long to wait before dealing the next street of an all-in runout. The clients first flip the hands
   * that just turned face up (`flipped`) and the street just dealt (`dealt` cards), and then leave
   * `runoutMs` between that street and the next one; the beat before a turn or river is part of that pause.
   */
  private runoutWaitMs(flipped: number, dealt: number): number {
    const next = this.eng!.street === 'preflop' ? 3 : 1;
    const busy = this.reveal(handsRevealMs(flipped) + streetRevealMs(dealt));
    return Math.max(0, busy + this.timing.runoutMs - this.reveal(leadMs(next)));
  }

  /** Turns every hand still in face up, and returns how many were newly turned. At showdown the log names the hands, in a runout it shows the cards. */
  private revealAll(atShowdown: boolean): number {
    const eng = this.eng!;
    let flipped = 0;
    for (const hp of eng.live()) {
      const p = this.players.get(hp.id);
      const name = p?.name ?? 'A player';
      const isNew = !this.revealed.has(hp.id);
      if (atShowdown) {
        this.addLog(`${name} shows ${inSentence(bestHand([...hp.hole, ...eng.board]).name)}`);
      } else if (isNew) {
        this.addLog(`${name} shows ${hp.hole.map(cardText).join(' ')}`);
      }
      if (isNew) flipped++;
      this.revealed.add(hp.id);
    }
    return flipped;
  }

  private showdown(): void {
    const eng = this.eng!;
    // What the clients have not shown yet: a river that was dealt in this same step, and the hands.
    const boardCards = eng.board.length - this.boardSent;
    this.phase = 'showdown';
    this.revealAll(true);
    this.settle();
    this.broadcast();
    // The clients show the last board card, play the drumroll and spotlight every hand in turn, and only then
    // is the first pot lit.
    const plan = showdownPlan(boardCards, eng.live().length, this.result!.pots.length);
    this.setFlow(() => this.awardNextPot(), this.reveal(plan.firstPotMs));
  }

  private foldWin(): void {
    this.settle();
    this.potsAwarded = this.result!.pots.length;
    const winner = this.players.get(this.result!.pots[0]!.winners[0]!);
    const total = this.result!.pots.reduce((s, pot) => s + pot.amount, 0);
    if (winner) this.addLog(`${winner.name} wins ${n(total)}`);
    this.phase = 'hand_over';
    this.broadcast();
    this.setFlow(() => this.nextHand(), this.timing.foldWinMs);
  }

  /** Pays out every pot, updates the chips and earnings and saves them. The pots are shown moving one at a time. */
  private settle(): void {
    const eng = this.eng!;
    const outcome = eng.finish();
    this.outcome = outcome;
    this.syncChips();
    for (const [id, net] of Object.entries(outcome.net)) {
      const p = this.players.get(id);
      if (p) p.earnings += net;
    }
    for (const p of this.players.values()) this.store.set(p.name, p.chips, p.debt, p.earnings);
    this.store.save();
    this.result = {
      hand: this.handNo,
      showdown: outcome.showdown,
      // Every hand that reached the showdown, in seat order. Each is shown with its best five cards.
      shown: outcome.showdown
        ? eng.live().map((hp) => ({
            playerId: hp.id,
            handName: outcome.hands[hp.id]!.name,
            cards: outcome.hands[hp.id]!.cards.map((c) => ({ ...c })),
          }))
        : [],
      pots: outcome.pots.map((pot) => ({
        amount: pot.amount,
        winners: [...pot.winners],
        shares: { ...pot.shares },
        handName: pot.handName,
        cards: pot.cards.map((c) => ({ ...c })),
        // Each winner's own best five: split pots can be won with different cards.
        hands: outcome.showdown
          ? pot.winners.map((id) => ({
              playerId: id,
              handName: outcome.hands[id]!.name,
              cards: outcome.hands[id]!.cards.map((c) => ({ ...c })),
            }))
          : [],
      })),
      players: eng.players.map((hp) => ({
        playerId: hp.id,
        name: this.players.get(hp.id)?.name ?? '',
        net: outcome.net[hp.id] ?? 0,
      })),
    };
    this.send({ type: 'hand_result', ...this.result });
  }

  private awardNextPot(): void {
    const result = this.result!;
    if (this.potsAwarded >= result.pots.length) {
      this.phase = 'hand_over';
      this.broadcast();
      this.setFlow(() => this.nextHand(), this.timing.showdownMs);
      return;
    }
    // Side pots go first and the main pot last, so the biggest prize is the end of the show.
    const i = result.pots.length - 1 - this.potsAwarded;
    const pot = result.pots[i]!;
    const names = pot.winners.map((id) => this.players.get(id)?.name ?? 'A player');
    const which = result.pots.length === 1 ? '' : i === 0 ? ' the main pot' : ` side pot ${i}`;
    const how = pot.handName ? ` with ${inSentence(pot.handName)}` : '';
    const who = names.length === 1 ? `${names[0]} wins` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} split`;
    this.addLog(`${who}${which} ${n(pot.amount)}${how}`);
    this.potsAwarded++;
    if (this.potsAwarded < result.pots.length) {
      this.broadcast();
      this.setFlow(() => this.awardNextPot(), this.timing.potMs);
      return;
    }
    // The last pot (the main pot) is on its way: the result stays on screen from here, not a pot step longer.
    this.phase = 'hand_over';
    this.broadcast();
    this.setFlow(() => this.nextHand(), this.timing.showdownMs);
  }

  private nextHand(): void {
    this.clearFlow();
    for (const p of [...this.players.values()]) {
      if (p.leaving) this.removePlayer(p);
    }
    if (!this.gameOpen) return; // the last player left, so the game ended
    this.clearHand();
    this.phase = 'waiting';
    this.turn = null;
    this.deadline = null;
    this.maybeStartHand();
    if (this.phase === 'waiting') this.broadcast(); // no new hand yet: show "Waiting for players"
  }

  // -------------------------------------------------------------- actions

  /** Starts (or restarts) the timer for the current player's turn. */
  private armTurnTimer(p: Player): void {
    this.clearFlow();
    let ms: number | null = null;
    if (this.settings.turnSeconds !== null) ms = this.timing.turnMs ?? this.settings.turnSeconds * 1000;
    // With the turn timer off, an absent player still must not hold up the table.
    else if (p.conn === null) ms = this.timing.holdMs;
    if (ms === null) {
      this.deadline = null;
      return;
    }
    this.deadline = Date.now() + ms;
    this.setFlow(() => this.autoAct(p), ms);
  }

  /** Checks for a player who ran out of time, or folds when there is a bet to call. */
  private autoAct(p: Player): void {
    const eng = this.eng;
    if (!eng || this.turn !== p.id) return;
    const legal = eng.legal(p.id);
    if (!legal) return;
    const reason = p.conn === null ? 'is away' : 'ran out of time';
    const r = eng.act(p.id, { action: legal.canCheck ? 'check' : 'fold' });
    if (!r.ok) return;
    this.addLog(`${p.name} ${reason} and ${r.text}`);
    this.logUncalled(r.uncalled);
    this.afterChange();
  }

  private onAction(conn: Connection, p: Player, action: unknown, amount: unknown): void {
    if (!BETTING_PHASES.includes(this.phase) || !this.eng || this.eng.status !== 'betting') {
      return this.sendError(conn, 'wrong_phase', 'There is no betting going on right now');
    }
    if (this.turn !== p.id) return this.sendError(conn, 'not_your_turn', 'It is not your turn');
    if (typeof action !== 'string' || !ACTIONS.includes(action as ActionKind)) {
      return this.sendError(conn, 'bad_message', 'Action must be fold, check, call, bet, raise or all_in');
    }
    if (amount !== undefined && typeof amount !== 'number') {
      return this.sendError(conn, 'bad_amount', 'The amount must be a whole number');
    }
    const r = this.eng.act(p.id, { action: action as ActionKind, amount });
    if (!r.ok) return this.sendError(conn, r.error, r.message);
    this.addLog(`${p.name} ${r.text}`);
    this.logUncalled(r.uncalled);
    this.afterChange();
  }

  private logUncalled(uncalled: { id: string; amount: number } | null): void {
    if (!uncalled) return;
    const p = this.players.get(uncalled.id);
    if (p) this.addLog(`${n(uncalled.amount)} uncalled goes back to ${p.name}`);
  }

  // ------------------------------------------------------------------- kick

  private onKick(conn: Connection, p: Player, targetId: unknown): void {
    if (this.hostId !== p.id) return this.sendError(conn, 'not_host', 'Only the host can kick players');
    if (typeof targetId !== 'string') return this.sendError(conn, 'bad_message', 'playerId must be text');
    const target = this.players.get(targetId);
    if (!target) return this.sendError(conn, 'unknown_player', 'That player is not at the table');
    if (target.id === p.id) return this.sendError(conn, 'bad_message', 'You can not kick yourself');

    this.kickedKeys.add(target.key);
    target.token = '';
    this.addLog(`${target.name} was kicked`);
    const tconn = target.conn;
    if (tconn) {
      tconn.send({ type: 'kicked', reason: 'The host kicked you from the table' });
      this.bound.delete(tconn);
      target.conn = null;
      tconn.close();
    }
    this.dropPlayer(target);
  }

  // ----------------------------------------------------------------- output

  private serverInfo(): ServerMsg {
    const holders = this.started ? this.seats.filter((s) => s !== null).length : this.players.size;
    const queued = this.started ? [...this.players.values()].filter((p) => p.seat === null && !p.leaving).length : 0;
    return {
      type: 'server_info',
      passwordRequired: this.settings.password !== '',
      seatsFree: holders + queued < this.settings.maxPlayers,
      phase: this.phase,
      gameOpen: this.gameOpen,
    };
  }

  private publicSettings(): PublicSettings {
    const { password, ...rest } = this.settings;
    return { ...rest, passwordSet: password !== '' };
  }

  /** How many of a player's hole cards have been dealt so far (they are dealt one at a time). */
  private holeCount(index: number): number {
    const eng = this.eng!;
    const count = eng.players.length;
    const pos = (index - eng.button - 1 + count) % count;
    return (this.holeShown > pos ? 1 : 0) + (this.holeShown > count + pos ? 1 : 0);
  }

  /** Chips a player has won but which are still in a pot on screen. */
  private unawarded(id: string): number {
    if (!this.outcome) return 0;
    let sum = 0;
    const waiting = this.outcome.pots.length - this.potsAwarded; // the pots still in the middle are the first ones
    this.outcome.pots.forEach((pot, i) => {
      if (i < waiting) sum += pot.shares[id] ?? 0;
    });
    return sum;
  }

  private playerView(p: Player, viewerId: string | null): PlayerView {
    const eng = this.eng;
    const index = eng && this.phase !== 'waiting' ? eng.indexOf(p.id) : -1;
    const hp = index >= 0 ? eng!.players[index]! : null;
    let cards: CardView[] = [];
    let handName: string | null = null;
    if (hp) {
      const count = this.holeCount(index);
      const visible = p.id === viewerId || this.revealed.has(p.id);
      cards = hp.hole.slice(0, count).map((c) => (visible ? { ...c } : { hidden: true }));
      // Hole cards are never sent to anyone else until they are shown.
      if (this.revealed.has(p.id)) handName = bestHand([...hp.hole, ...eng!.board]).name;
    }
    return {
      id: p.id,
      name: p.name,
      chips: p.chips - this.unawarded(p.id),
      ready: p.ready,
      connected: p.conn !== null,
      debt: p.debt,
      earnings: p.earnings,
      seat: p.seat,
      sittingOut: p.sittingOut,
      inHand: hp !== null,
      folded: hp?.folded ?? false,
      allIn: hp?.allIn ?? false,
      bet: hp?.committed ?? 0,
      lastAction: hp?.lastAction ?? null,
      cards,
      handName,
    };
  }

  private youView(viewerId: string | null): YouView | null {
    const eng = this.eng;
    if (!eng || !viewerId || this.phase === 'waiting') return null;
    const index = eng.indexOf(viewerId);
    if (index < 0) return null;
    const hp = eng.players[index]!;
    const cards = hp.hole.slice(0, this.holeCount(index)).map((c) => ({ ...c }));
    const legal = this.turn === viewerId ? eng.legal(viewerId) : null;
    return {
      cards,
      handName: cards.length === 2 ? bestHand([...cards, ...eng.board]).name : null,
      legal: legal ? { ...legal, allInTo: hp.committed + hp.stack } : null,
    };
  }

  private potsView(): PotView[] {
    if (!this.eng || this.phase === 'waiting') return [];
    if (this.outcome) {
      return this.outcome.pots.slice(0, this.outcome.pots.length - this.potsAwarded).map((pot) => ({ amount: pot.amount, eligible: [...pot.winners] }));
    }
    return this.eng.pots();
  }

  /** The table as one player sees it: only their own hole cards are face up. */
  snapshot(viewerId: string | null = null): TableState {
    const eng = this.eng && this.phase !== 'waiting' ? this.eng : null;
    const seatOf = (i: number | undefined) => (eng && i !== undefined ? (this.handSeats[i] ?? null) : null);
    return {
      type: 'table_state',
      phase: this.phase,
      started: this.started,
      settings: this.publicSettings(),
      hostId: this.hostId,
      players: [...this.players.values()].map((p) => this.playerView(p, viewerId)),
      seats: [...this.seats],
      hand: this.handNo,
      buttonSeat: eng ? this.buttonSeat : null,
      smallBlindSeat: seatOf(eng?.sbIndex),
      bigBlindSeat: seatOf(eng?.bbIndex),
      board: eng ? eng.board.map((c) => ({ ...c })) : [],
      pots: this.potsView(),
      turn: this.turn,
      deadline: this.deadline,
      serverNow: Date.now(),
      log: this.logEntries.map((e) => ({ ...e })),
      you: this.youView(viewerId),
      result: this.result,
      potsAwarded: this.potsAwarded,
    };
  }

  /** Sends every joined connection its own view of the table. */
  private broadcast(): void {
    if (this.closed) return;
    this.boardSent = this.eng && this.phase !== 'waiting' ? this.eng.board.length : 0;
    for (const [conn, id] of this.bound) {
      try {
        conn.send(this.snapshot(id));
      } catch (err) {
        this.logger(`Could not send to a client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Sends the same message to every connection that has joined. */
  private send(msg: ServerMsg): void {
    for (const conn of this.bound.keys()) {
      try {
        conn.send(msg);
      } catch (err) {
        this.logger(`Could not send to a client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private sendError(conn: Connection, code: ErrorCode, message: string): void {
    try {
      conn.send({ type: 'error', code, message });
    } catch (err) {
      this.logger(`Could not send an error to a client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private addLog(text: string): void {
    this.logEntries.push({ id: ++this.logId, text });
    if (this.logEntries.length > LOG_LIMIT) this.logEntries.shift();
  }

  // ----------------------------------------------------------------- timers

  private playerOf(conn: Connection): Player | undefined {
    const id = this.bound.get(conn);
    return id ? this.players.get(id) : undefined;
  }

  /** The hand flow has at most one pending timer; setting a new one replaces the old. */
  private setFlow(fn: () => void, ms: number): void {
    this.clearFlow();
    if (this.closed) return;
    this.flow = setTimeout(() => {
      this.flow = null;
      try {
        fn();
      } catch (err) {
        this.logger(`Error in hand flow: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }, ms);
  }

  private clearFlow(): void {
    if (this.flow) clearTimeout(this.flow);
    this.flow = null;
  }
}
