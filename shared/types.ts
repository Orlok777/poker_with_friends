// Message and table-state types used by both the server and the browser client.
// This file is the single place where the wire protocol is defined.

// ---------------------------------------------------------------- cards

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export interface Card {
  rank: Rank;
  suit: Suit;
}

/** A card as sent to clients. Another player's hole card is `{ hidden: true }` until it is shown. */
export type CardView = Card | { hidden: true };

export function isHiddenCard(card: CardView): card is { hidden: true } {
  return 'hidden' in card;
}

export const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/** "K♠", as used in the log. */
export function cardText(card: Card): string {
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

// ------------------------------------------------------------- settings

export interface Settings {
  maxPlayers: number;
  /** Empty string means no password. Never sent to clients. */
  password: string;
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  /** null turns the turn timer off. */
  turnSeconds: number | null;
}

/** Settings as sent to clients: the password itself is replaced by a flag. */
export type PublicSettings = Omit<Settings, 'password'> & { passwordSet: boolean };

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 6,
  password: '',
  startingChips: 1000,
  smallBlind: 5,
  bigBlind: 10,
  turnSeconds: 30,
};

export const SETTINGS_LIMITS = {
  maxPlayers: { min: 2, max: 9 },
  startingChips: { min: 100, max: 100_000 },
  turnSeconds: { min: 10, max: 120 },
} as const;

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

/** The biggest big blind the starting chips allow. */
export function maxBigBlind(startingChips: number): number {
  return Math.floor(startingChips / 10);
}

/** Returns an error message, or null when the whole settings object is valid. */
export function validateSettings(s: Settings): string | null {
  const L = SETTINGS_LIMITS;
  if (!isInt(s.maxPlayers) || s.maxPlayers < L.maxPlayers.min || s.maxPlayers > L.maxPlayers.max) {
    return `Max players must be ${L.maxPlayers.min} to ${L.maxPlayers.max}`;
  }
  if (typeof s.password !== 'string' || s.password.length > 100) return 'Password must be text of at most 100 characters';
  if (!isInt(s.startingChips) || s.startingChips < L.startingChips.min || s.startingChips > L.startingChips.max) {
    return `Starting chips must be ${L.startingChips.min} to ${L.startingChips.max}`;
  }
  if (!isInt(s.smallBlind) || s.smallBlind < 1) return 'The small blind must be at least 1';
  if (!isInt(s.bigBlind) || s.bigBlind < s.smallBlind) return 'The big blind can not be smaller than the small blind';
  if (s.bigBlind > maxBigBlind(s.startingChips)) {
    return `The big blind can be at most a tenth of the starting chips (${maxBigBlind(s.startingChips)})`;
  }
  if (s.turnSeconds !== null) {
    if (!isInt(s.turnSeconds) || s.turnSeconds < L.turnSeconds.min || s.turnSeconds > L.turnSeconds.max) {
      return `Turn timer must be ${L.turnSeconds.min} to ${L.turnSeconds.max} seconds, or off`;
    }
  }
  return null;
}

// -------------------------------------------------------------- usernames

export const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,16}$/;

// ------------------------------------------------------------ table state

export type Phase = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'hand_over';

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';

export interface PlayerView {
  id: string;
  name: string;
  /** Chips behind, not counting chips in front of the player this round. */
  chips: number;
  ready: boolean;
  connected: boolean;
  /** Chips borrowed to buy back in and not paid back. Net worth is `chips - debt`. */
  debt: number;
  /** Running profit or loss from the cards since the last reset. Positive or negative. */
  earnings: number;
  /** Seat index, or null when watching or waiting for a seat. */
  seat: number | null;
  /** Chose to sit out. Takes effect from the next hand. */
  sittingOut: boolean;
  /** Dealt into the current hand (also after folding). */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Chips in front of the player in this betting round. */
  bet: number;
  /** "Check", "Call 20", "Raise to 60", "All in", "Fold", or null. */
  lastAction: string | null;
  /** Face up for yourself and for hands that were shown, `{ hidden: true }` otherwise. Empty when not in the hand. */
  cards: CardView[];
  /** The hand's name, only once the cards are shown. */
  handName: string | null;
}

export interface LegalView {
  canCheck: boolean;
  /** Chips needed to call (capped at the stack); 0 when checking is possible. */
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  /** Smallest and largest "to" amount for a bet or raise. */
  minTo: number;
  maxTo: number;
  canAllIn: boolean;
  /** The "to" amount of going all in: chips in front plus chips behind. */
  allInTo: number;
}

/** Only for the player receiving the state. */
export interface YouView {
  cards: Card[];
  /** Your best hand with the board so far, e.g. "Pair of sevens". */
  handName: string | null;
  /** What you may do right now; null when it is not your turn. */
  legal: LegalView | null;
}

export interface PotView {
  amount: number;
  eligible: string[];
}

/** One winner's best five cards. Hands are public at showdown, so this leaks nothing. */
export interface WinningHand {
  playerId: string;
  handName: string;
  /** The best five of the player's two hole cards and the board. */
  cards: Card[];
}

export interface PotResultView {
  amount: number;
  winners: string[];
  /** Null when everyone else folded. */
  handName: string | null;
  /** The five cards of the (first) winning hand; empty after a fold win. */
  cards: Card[];
  /** Each winner's own best five cards, in the same order as `winners`; empty after a fold win. */
  hands: WinningHand[];
  /** What each winner gets from this pot (they differ by the odd chip in a split pot). */
  shares: Record<string, number>;
}

/**
 * Pots go to their winners one at a time, last side pot first and the main pot last. `potsAwarded` counts
 * how many have gone; this is the index in `result.pots` of the one pushed most recently, or -1 for none.
 */
export function lastPushedPot(total: number, potsAwarded: number): number {
  return potsAwarded <= 0 ? -1 : Math.max(total - potsAwarded, 0);
}

export interface NetResult {
  playerId: string;
  name: string;
  net: number;
}

export interface HandResult {
  hand: number;
  showdown: boolean;
  /** Every hand that reached the showdown with its best five cards, in seat order; empty after a fold win. */
  shown: WinningHand[];
  pots: PotResultView[];
  players: NetResult[];
}

export interface LogEntry {
  id: number;
  text: string;
}

export interface TableState {
  type: 'table_state';
  phase: Phase;
  /** True once the host has clicked Start. Settings are locked from then on. */
  started: boolean;
  settings: PublicSettings;
  hostId: string | null;
  players: PlayerView[];
  /** seats[i] is the player id sitting in seat i, or null. */
  seats: (string | null)[];
  /** Hand number, counting from 1. 0 before the first hand. */
  hand: number;
  buttonSeat: number | null;
  smallBlindSeat: number | null;
  bigBlindSeat: number | null;
  board: Card[];
  /** Main pot first. Chips in front of the players this round are not in here yet. */
  pots: PotView[];
  /** Id of the player whose turn it is, or null. */
  turn: string | null;
  /** Epoch ms when the current timer ends, or null when no timer runs. */
  deadline: number | null;
  /** Server clock when this state was sent, so clients can correct for clock differences. */
  serverNow: number;
  log: LogEntry[];
  /** For the receiving player only. Null when they are not in the hand. */
  you: YouView | null;
  /** The result of the hand once it has been decided, until the next hand starts. */
  result: HandResult | null;
  /** How many of `result.pots` have been pushed to their winners so far. */
  potsAwarded: number;
}

// ---------------------------------------------------------------- messages

export type ClientMsg =
  | { type: 'join'; username: string; password?: string; reconnectToken?: string; hostToken?: string }
  | { type: 'leave' }
  | { type: 'set_ready'; ready: boolean }
  | { type: 'update_settings'; settings: Partial<Settings> }
  | { type: 'start_game' }
  | { type: 'action'; action: ActionKind; amount?: number }
  | { type: 'sit_out'; sittingOut: boolean }
  | { type: 'reset_chips' }
  | { type: 'borrow' }
  | { type: 'pay_back' }
  | { type: 'kick_player'; playerId: string };

export type ErrorCode =
  | 'bad_message'
  | 'not_joined'
  | 'already_joined'
  | 'bad_username'
  | 'name_in_use'
  | 'wrong_password'
  | 'game_closed'
  | 'kicked'
  | 'wrong_phase'
  | 'not_your_turn'
  | 'not_host'
  | 'settings_locked'
  | 'invalid_settings'
  | 'cannot_start'
  | 'not_seated'
  | 'action_not_allowed'
  | 'bad_amount'
  | 'unknown_player'
  | 'cannot_reset'
  | 'cannot_borrow'
  | 'cannot_pay_back';

export type ServerMsg =
  | { type: 'server_info'; passwordRequired: boolean; seatsFree: boolean; phase: Phase; gameOpen: boolean }
  | { type: 'joined'; playerId: string; reconnectToken: string; isHost: boolean }
  | TableState
  | ({ type: 'hand_result' } & HandResult)
  | { type: 'kicked'; reason: string }
  | { type: 'error'; code: ErrorCode; message: string };
