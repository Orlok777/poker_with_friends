// Pure No-Limit Texas Hold'em betting engine for one hand: blinds, actions, minimum raise,
// uncalled bets, side pots and the showdown. No networking, no timers, no randomness
// (the cards come from the `draw` function it is given).

import type { Card } from '../shared/types.js';
import { bestHand, type HandRank } from './hand.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';

export interface PlayerAction {
  action: ActionKind;
  /** For bet and raise: the total the player will have in front of them this round ("to" amount). */
  amount?: number;
}

/**
 * Where a hand stands.
 * - `betting`: waiting for the player in `toAct`.
 * - `street_over`: the betting round is over; call `dealNext()` for the next street.
 * - `showdown`: all five board cards are out and betting is over; call `finish()`.
 * - `fold_win`: everyone but one player folded; call `finish()`.
 * - `finished`: `finish()` has run.
 */
export type HandStatus = 'betting' | 'street_over' | 'showdown' | 'fold_win' | 'finished';

export interface HandPlayer {
  id: string;
  stack: number;
  hole: Card[];
  /** Chips put in during the current betting round. */
  committed: number;
  /** Chips put in during the whole hand. */
  totalIn: number;
  folded: boolean;
  allIn: boolean;
  /** Has acted since the last full bet or raise. Blinds do not count as acting. */
  acted: boolean;
  /** "Check", "Call 20", "Raise to 60", "All in", "Fold". Cleared at each new street. */
  lastAction: string | null;
}

export interface LegalActions {
  canCheck: boolean;
  /** Chips needed to call, capped at the stack. 0 when the player can check. */
  callAmount: number;
  /** True when nobody has bet this round and the player may bet. */
  canBet: boolean;
  /** True when there is a bet to raise and the player may raise. */
  canRaise: boolean;
  /** Smallest and largest "to" amount for a bet or raise. Equal when only all in is possible. */
  minTo: number;
  maxTo: number;
  /** Whether the all in button means anything right now (an all-in call, bet or raise). */
  canAllIn: boolean;
}

export interface Pot {
  amount: number;
  /** Players who can win this pot: still in the hand and put in enough. */
  eligible: string[];
}

export interface PotResult {
  amount: number;
  winners: string[];
  /** What each winner gets from this pot. */
  shares: Record<string, number>;
  /** Null when the pot was won because everyone else folded. */
  handName: string | null;
  /** The five cards of the (first) winning hand; empty after a fold win. */
  cards: Card[];
}

export interface HandOutcome {
  showdown: boolean;
  pots: PotResult[];
  /** Per player: what they won minus what they put in. */
  net: Record<string, number>;
  /** Best hands of everyone who reached the showdown. */
  hands: Record<string, HandRank>;
}

export type ActResult =
  | { ok: true; text: string; uncalled: { id: string; amount: number } | null }
  | { ok: false; error: 'not_your_turn' | 'action_not_allowed' | 'bad_amount'; message: string };

export interface HandOptions {
  /** The players dealt in, in seat order. */
  players: { id: string; stack: number }[];
  /** Index into `players` of the button. */
  button: number;
  smallBlind: number;
  bigBlind: number;
  draw: () => Card;
}

const BOARD_COUNT: Record<Street, number> = { preflop: 0, flop: 3, turn: 1, river: 1 };
const NEXT_STREET: Record<Street, Street | null> = { preflop: 'flop', flop: 'turn', turn: 'river', river: null };

export class HoldemHand {
  readonly players: HandPlayer[];
  readonly button: number;
  readonly sbIndex: number;
  readonly bbIndex: number;
  readonly bigBlind: number;
  board: Card[] = [];
  street: Street = 'preflop';
  status: HandStatus = 'betting';
  /** Index of the player to act, or null when nobody is. */
  toAct: number | null = null;
  /** The amount everyone still in must match this round. */
  currentBet = 0;
  /** Size of the last full bet or raise this round: the smallest raise allowed. */
  minRaise: number;
  private readonly draw: () => Card;

  constructor(opts: HandOptions) {
    const n = opts.players.length;
    if (n < 2) throw new Error('A hand needs at least 2 players');
    if (opts.players.some((p) => p.stack <= 0)) throw new Error('Every player dealt in needs chips');
    this.players = opts.players.map((p) => ({
      id: p.id,
      stack: p.stack,
      hole: [],
      committed: 0,
      totalIn: 0,
      folded: false,
      allIn: false,
      acted: false,
      lastAction: null,
    }));
    this.button = opts.button;
    this.bigBlind = opts.bigBlind;
    this.minRaise = opts.bigBlind;
    this.draw = opts.draw;

    // Heads-up, the button posts the small blind.
    this.sbIndex = n === 2 ? this.button : this.next(this.button);
    this.bbIndex = this.next(this.sbIndex);
    this.post(this.sbIndex, opts.smallBlind);
    this.post(this.bbIndex, opts.bigBlind);
    this.currentBet = opts.bigBlind;

    // Two hole cards each, one at a time, starting left of the button.
    for (let round = 0; round < 2; round++) {
      for (let k = 1; k <= n; k++) this.players[(this.button + k) % n]!.hole.push(this.draw());
    }

    // Preflop betting starts left of the big blind.
    this.startBetting(this.bbIndex);
  }

  // ----------------------------------------------------------------- helpers

  private next(i: number): number {
    return (i + 1) % this.players.length;
  }

  private post(i: number, amount: number): void {
    const p = this.players[i]!;
    const put = Math.min(p.stack, amount);
    p.stack -= put;
    p.committed += put;
    p.totalIn += put;
    if (p.stack === 0) p.allIn = true;
  }

  indexOf(id: string): number {
    return this.players.findIndex((p) => p.id === id);
  }

  player(id: string): HandPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  /** Players who have not folded. */
  live(): HandPlayer[] {
    return this.players.filter((p) => !p.folded);
  }

  /** At most one player still in has chips behind, so no more betting is possible. */
  isRunout(): boolean {
    return this.live().length >= 2 && this.live().filter((p) => !p.allIn).length <= 1;
  }

  private needsAction(p: HandPlayer): boolean {
    if (p.folded || p.allIn) return false;
    const withChips = this.live().filter((x) => !x.allIn);
    if (withChips.length <= 1) {
      // Nobody left to bet against: only a call of an all in is still open.
      const top = Math.max(0, ...this.live().filter((x) => x !== p).map((x) => x.committed));
      return p.committed < top;
    }
    return !p.acted || p.committed < this.currentBet;
  }

  /** First player after index `after` (going left) who needs to act, or null. */
  private findNext(after: number): number | null {
    for (let k = 1; k <= this.players.length; k++) {
      const i = (after + k) % this.players.length;
      if (this.needsAction(this.players[i]!)) return i;
    }
    return null;
  }

  private startBetting(after: number): void {
    this.status = 'betting';
    this.toAct = this.findNext(after);
    if (this.toAct === null) this.endRound();
  }

  /** Called after every change: moves the turn on, or ends the betting round. Returns any uncalled bet. */
  private advance(from: number): { id: string; amount: number } | null {
    if (this.live().length === 1) {
      const uncalled = this.returnUncalled();
      this.toAct = null;
      this.status = 'fold_win';
      return uncalled;
    }
    this.toAct = this.findNext(from);
    if (this.toAct === null) return this.endRound();
    return null;
  }

  private endRound(): { id: string; amount: number } | null {
    const uncalled = this.returnUncalled();
    for (const p of this.players) p.committed = 0;
    this.currentBet = 0;
    this.toAct = null;
    if (this.live().length === 1) this.status = 'fold_win';
    else this.status = this.street === 'river' ? 'showdown' : 'street_over';
    return uncalled;
  }

  /** The part of the biggest bet this round that nobody matched goes back to its owner. */
  private returnUncalled(): { id: string; amount: number } | null {
    const sorted = [...this.players].sort((a, b) => b.committed - a.committed);
    const top = sorted[0]!;
    const second = sorted[1]?.committed ?? 0;
    const extra = top.committed - second;
    if (extra <= 0) return null;
    top.committed -= extra;
    top.totalIn -= extra;
    top.stack += extra;
    top.allIn = false;
    return { id: top.id, amount: extra };
  }

  // ------------------------------------------------------------------ betting

  legal(id: string): LegalActions | null {
    if (this.status !== 'betting' || this.toAct === null) return null;
    const p = this.players[this.toAct]!;
    if (p.id !== id) return null;
    const toCall = Math.max(0, this.currentBet - p.committed);
    const maxTo = p.committed + p.stack;
    const others = this.live().filter((x) => x !== p && !x.allIn).length;
    // A player who already acted and faces only a short all in may call or fold, not raise.
    const mayRaise = !p.acted && others > 0 && p.stack > toCall;
    const canBet = mayRaise && this.currentBet === 0;
    const canRaise = mayRaise && this.currentBet > 0;
    const minTo = Math.min(maxTo, this.currentBet + this.minRaise);
    return {
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, p.stack),
      canBet,
      canRaise,
      minTo: canBet || canRaise ? minTo : 0,
      maxTo: canBet || canRaise ? maxTo : 0,
      canAllIn: mayRaise || toCall >= p.stack,
    };
  }

  act(id: string, a: PlayerAction): ActResult {
    if (this.status !== 'betting' || this.toAct === null) {
      return { ok: false, error: 'action_not_allowed', message: 'Nobody can act right now' };
    }
    const i = this.toAct;
    const p = this.players[i]!;
    if (p.id !== id) return { ok: false, error: 'not_your_turn', message: 'It is not your turn' };
    const legal = this.legal(id)!;
    const n = (x: number) => x.toLocaleString('en-US');
    let text: string;

    switch (a.action) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        text = 'folds';
        break;
      case 'check':
        if (!legal.canCheck) return { ok: false, error: 'action_not_allowed', message: 'You can not check: there is a bet to call' };
        p.acted = true;
        p.lastAction = 'Check';
        text = 'checks';
        break;
      case 'call': {
        if (legal.canCheck) return { ok: false, error: 'action_not_allowed', message: 'There is nothing to call' };
        const add = legal.callAmount;
        this.put(p, add);
        p.acted = true;
        p.lastAction = p.allIn ? 'All in' : `Call ${n(add)}`;
        text = p.allIn ? `calls ${n(add)} and is all in` : `calls ${n(add)}`;
        break;
      }
      case 'bet':
      case 'raise': {
        const allowed = a.action === 'bet' ? legal.canBet : legal.canRaise;
        if (!allowed) {
          const message = a.action === 'bet' ? 'You can not bet right now' : 'You can not raise right now';
          return { ok: false, error: 'action_not_allowed', message };
        }
        const to = a.amount;
        if (typeof to !== 'number' || !Number.isInteger(to) || to < legal.minTo || to > legal.maxTo) {
          return { ok: false, error: 'bad_amount', message: `The amount must be a whole number from ${n(legal.minTo)} to ${n(legal.maxTo)}` };
        }
        text = this.raiseTo(p, to);
        break;
      }
      case 'all_in': {
        if (!legal.canAllIn) return { ok: false, error: 'action_not_allowed', message: 'You can only call or fold' };
        const to = p.committed + p.stack;
        if (to <= this.currentBet) {
          const add = p.stack;
          this.put(p, add);
          p.acted = true;
          p.lastAction = 'All in';
          text = `calls ${n(add)} and is all in`;
        } else {
          text = this.raiseTo(p, to);
        }
        break;
      }
      default:
        return { ok: false, error: 'action_not_allowed', message: 'Unknown action' };
    }
    const uncalled = this.advance(i);
    return { ok: true, text, uncalled };
  }

  private put(p: HandPlayer, amount: number): void {
    p.stack -= amount;
    p.committed += amount;
    p.totalIn += amount;
    if (p.stack === 0) p.allIn = true;
  }

  /** A bet or raise to `to`. A raise smaller than a full raise (only possible all in) does not reopen the betting. */
  private raiseTo(p: HandPlayer, to: number): string {
    const n = (x: number) => x.toLocaleString('en-US');
    const wasBet = this.currentBet === 0;
    const size = to - this.currentBet;
    const full = size >= this.minRaise;
    this.put(p, to - p.committed);
    if (full) {
      this.minRaise = size;
      for (const x of this.players) if (x !== p) x.acted = false;
    }
    this.currentBet = to;
    p.acted = true;
    if (p.allIn) {
      p.lastAction = 'All in';
      return wasBet ? `bets ${n(to)} and is all in` : `raises to ${n(to)} and is all in`;
    }
    p.lastAction = wasBet ? `Bet ${n(to)}` : `Raise to ${n(to)}`;
    return wasBet ? `bets ${n(to)}` : `raises to ${n(to)}`;
  }

  /**
   * Folds a player at once, also out of turn (they left the table or were kicked).
   * Returns false when the player can not fold (not in the hand, already folded, or betting is over).
   */
  forceFold(id: string): { ok: boolean; uncalled: { id: string; amount: number } | null } {
    const i = this.indexOf(id);
    const p = this.players[i];
    if (!p || p.folded) return { ok: false, uncalled: null };
    if (this.status !== 'betting' && this.status !== 'street_over') return { ok: false, uncalled: null };
    if (this.status === 'betting' && this.toAct === i) {
      const r = this.act(id, { action: 'fold' });
      return { ok: r.ok, uncalled: r.ok ? r.uncalled : null };
    }
    p.folded = true;
    p.lastAction = 'Fold';
    if (this.live().length === 1) {
      const uncalled = this.status === 'betting' ? this.returnUncalled() : null;
      this.toAct = null;
      this.status = 'fold_win';
      return { ok: true, uncalled };
    }
    if (this.status === 'betting' && this.toAct !== null && !this.needsAction(this.players[this.toAct]!)) {
      return { ok: true, uncalled: this.advance(this.toAct) };
    }
    return { ok: true, uncalled: null };
  }

  // ------------------------------------------------------------------- streets

  /** Deals the next street's board cards and starts its betting round (skipped when nobody can bet). */
  dealNext(): Card[] {
    if (this.status !== 'street_over') throw new Error('The betting round is not over');
    const street = NEXT_STREET[this.street]!;
    this.street = street;
    const cards: Card[] = [];
    for (let k = 0; k < BOARD_COUNT[street]; k++) cards.push(this.draw());
    this.board.push(...cards);
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    for (const p of this.players) {
      p.committed = 0;
      p.acted = false;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    // Every street after the flop starts with the first player still in left of the button.
    this.startBetting(this.button);
    return cards;
  }

  // ---------------------------------------------------------------------- pots

  /** Pots from the chips already collected (not counting the current round's bets in front of the players). */
  pots(): Pot[] {
    return buildPots(
      this.players.map((p) => ({ id: p.id, amount: p.totalIn - p.committed, folded: p.folded })),
    );
  }

  /** Total chips in the middle and in front of the players. */
  totalPot(): number {
    return this.players.reduce((sum, p) => sum + p.totalIn, 0);
  }

  /** Seats away from the button, going left: the player just left of it is 0. */
  private distanceFromButton(id: string): number {
    const n = this.players.length;
    return (this.indexOf(id) - this.button - 1 + n) % n;
  }

  /** Awards every pot and updates the stacks. Call once, when the status is `showdown` or `fold_win`. */
  finish(): HandOutcome {
    if (this.status !== 'showdown' && this.status !== 'fold_win') throw new Error('The hand is not over');
    const showdown = this.status === 'showdown';
    this.status = 'finished';
    const pots = buildPots(this.players.map((p) => ({ id: p.id, amount: p.totalIn, folded: p.folded })));
    const hands: Record<string, HandRank> = {};
    if (showdown) {
      for (const p of this.live()) hands[p.id] = bestHand([...p.hole, ...this.board]);
    }
    const won: Record<string, number> = {};
    const results: PotResult[] = pots.map((pot) => {
      let winners: string[];
      if (showdown) {
        const best = Math.max(...pot.eligible.map((id) => hands[id]!.score));
        winners = pot.eligible.filter((id) => hands[id]!.score === best);
      } else {
        winners = [this.live()[0]!.id];
      }
      winners.sort((a, b) => this.distanceFromButton(a) - this.distanceFromButton(b));
      const each = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - each * winners.length;
      const shares: Record<string, number> = {};
      for (const id of winners) {
        // Odd chips go one at a time to the winners closest to the left of the button.
        shares[id] = each + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        won[id] = (won[id] ?? 0) + shares[id]!;
        this.player(id)!.stack += shares[id]!;
      }
      const first = showdown ? hands[winners[0]!]! : null;
      return {
        amount: pot.amount,
        winners,
        shares,
        handName: first ? first.name : null,
        cards: first ? first.cards : [],
      };
    });
    const net: Record<string, number> = {};
    for (const p of this.players) net[p.id] = (won[p.id] ?? 0) - p.totalIn;
    return { showdown, pots: results, net, hands };
  }
}

/**
 * Splits contributions into a main pot and side pots. Folded players' chips stay in the pots,
 * but only players still in can win them.
 */
export function buildPots(contribs: { id: string; amount: number; folded: boolean }[]): Pot[] {
  const levels = [...new Set(contribs.filter((c) => !c.folded && c.amount > 0).map((c) => c.amount))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contribs) amount += Math.min(c.amount, level) - Math.min(c.amount, prev);
    const eligible = contribs.filter((c) => !c.folded && c.amount >= level).map((c) => c.id);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  // Chips from folded players above every live player's total (should not happen once uncalled bets are returned).
  const leftover = contribs.reduce((sum, c) => sum + Math.max(0, c.amount - prev), 0);
  if (leftover > 0) {
    if (pots.length > 0) pots[pots.length - 1]!.amount += leftover;
    else pots.push({ amount: leftover, eligible: contribs.filter((c) => !c.folded).map((c) => c.id) });
  }
  return pots;
}
