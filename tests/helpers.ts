// Test helpers: a small WebSocket client and a server boot function.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ActionName, Card, ClientMsg, HandView, PlayerView, Rank, ServerMsg, Suit, TableState } from '../shared/types.js';
import { startServer, type RunningServer, type ServerOptions } from '../server/index.js';
import type { Timing } from '../server/table.js';

export type ErrorMsg = Extract<ServerMsg, { type: 'error' }>;

export const FAST: Partial<Timing> = {
  dealMs: 5,
  dealerStepMs: 5,
  settleMs: 60,
  holdMs: 400,
  bettingMs: 1500,
  turnMs: 1500,
};

/** Parses "10 7D AS" into cards. A bare rank is a spade. */
export function cards(text: string): Card[] {
  return text.split(/\s+/).filter(Boolean).map((token) => {
    const last = token.slice(-1);
    const hasSuit = 'SHDC'.includes(last) && token.length > 1;
    const suit = (hasSuit ? last : 'S') as Suit;
    const rank = (hasSuit ? token.slice(0, -1) : token) as Rank;
    return { rank, suit };
  });
}

export async function waitUntil(check: () => boolean, timeout = 4000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The bet a player has placed for the coming round (0 when none). */
export const betOf = (p: PlayerView): number => p.hands[0]?.bet ?? 0;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TestClient {
  ws!: WebSocket;
  all: ServerMsg[] = [];
  errors: ErrorMsg[] = [];
  state: TableState | null = null;
  id = '';
  token = '';
  isHost = false;
  kickedReason: string | null = null;
  closed = false;
  private stateListeners = new Set<(s: TableState) => void>();
  private msgListeners = new Set<(m: ServerMsg) => void>();

  static async open(port: number): Promise<TestClient> {
    const c = new TestClient();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    c.ws.on('message', (data) => c.receive(data.toString()));
    c.ws.on('close', () => {
      c.closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', () => resolve());
      c.ws.once('error', reject);
    });
    await waitUntil(() => c.all.some((m) => m.type === 'server_info'), 3000, 'server_info');
    return c;
  }

  private receive(raw: string): void {
    const msg = JSON.parse(raw) as ServerMsg;
    this.all.push(msg);
    if (msg.type === 'error') this.errors.push(msg);
    if (msg.type === 'kicked') this.kickedReason = msg.reason;
    if (msg.type === 'table_state') {
      this.state = msg;
      for (const fn of [...this.stateListeners]) fn(msg);
    }
    for (const fn of [...this.msgListeners]) fn(msg);
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  onState(fn: (s: TableState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  waitForState(pred: (s: TableState) => boolean, timeout = 4000): Promise<TableState> {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for a table state (last: phase ${this.state?.phase}, round ${this.state?.round})`));
      }, timeout);
      const off = this.onState((s) => {
        if (pred(s)) {
          clearTimeout(timer);
          off();
          resolve(s);
        }
      });
    });
  }

  private waitMsgSince(index: number, pred: (m: ServerMsg) => boolean, timeout = 3000): Promise<ServerMsg> {
    const found = this.all.slice(index).find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.msgListeners.delete(listener);
        reject(new Error('Timed out waiting for a message'));
      }, timeout);
      const listener = (m: ServerMsg) => {
        if (pred(m)) {
          clearTimeout(timer);
          this.msgListeners.delete(listener);
          resolve(m);
        }
      };
      this.msgListeners.add(listener);
    });
  }

  /** Sends a join and returns the `joined` reply, or the `error` / `kicked` reply. */
  async join(username: string, extra: { password?: string; reconnectToken?: string; hostToken?: string } = {}): Promise<ServerMsg> {
    const index = this.all.length;
    this.send({ type: 'join', username, ...extra });
    const reply = await this.waitMsgSince(index, (m) => m.type === 'joined' || m.type === 'error' || m.type === 'kicked');
    if (reply.type === 'joined') {
      this.id = reply.playerId;
      this.token = reply.reconnectToken;
      this.isHost = reply.isHost;
      await this.waitForState((s) => s.players.some((p) => p.id === this.id));
    }
    return reply;
  }

  /** Sends a message that must be rejected and returns the error. */
  async expectError(msg: ClientMsg): Promise<ErrorMsg> {
    const index = this.all.length;
    this.send(msg);
    const reply = await this.waitMsgSince(index, (m) => m.type === 'error');
    return reply as ErrorMsg;
  }

  me(s: TableState | null = this.state): PlayerView {
    const p = s?.players.find((x) => x.id === this.id);
    if (!p) throw new Error('Player is not in the table state');
    return p;
  }

  /** Plays by itself: bets when asked and picks an action with `policy` for the hand being played. */
  autoPlay(bet: number, policy: (hand: HandView, p: PlayerView, s: TableState) => ActionName): () => void {
    const done = new Set<string>();
    return this.onState((s) => {
      const p = s.players.find((x) => x.id === this.id);
      if (!p || this.closed) return;
      if (s.phase === 'betting' && s.deadline !== null && p.seat !== null && betOf(p) === 0 && p.chips >= s.settings.minBet) {
        const key = `bet:${s.round}`;
        if (!done.has(key)) {
          done.add(key);
          this.send({ type: 'place_bet', amount: Math.min(bet, p.chips) });
        }
      }
      if (s.phase === 'player_turns' && s.turn === this.id) {
        const hand = p.hands[p.activeHand];
        if (!hand) return;
        const key = `act:${s.round}:${p.activeHand}:${hand.cards.length}`;
        if (!done.has(key)) {
          done.add(key);
          this.send({ type: 'action', action: policy(hand, p, s) });
        }
      }
    });
  }

  /** Remembers the settle-phase table state of every round. */
  collectSettles(): Map<number, TableState> {
    const settles = new Map<number, TableState>();
    this.onState((s) => {
      if (s.phase === 'settle') settles.set(s.round, s);
    });
    return settles;
  }

  close(): void {
    this.ws.terminate();
  }
}

// ------------------------------------------------------------------- server

export interface Harness {
  servers: RunningServer[];
  clients: TestClient[];
  dirs: string[];
  logs: string[];
  boot(options?: Partial<ServerOptions>, dataDir?: string): Promise<{ srv: RunningServer; dataDir: string }>;
  client(srv: RunningServer): Promise<TestClient>;
  cleanup(): Promise<void>;
}

export function createHarness(): Harness {
  const h: Harness = {
    servers: [],
    clients: [],
    dirs: [],
    logs: [],
    async boot(options = {}, dataDir) {
      const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'bj-test-'));
      if (!dataDir) h.dirs.push(dir);
      const srv = await startServer({
        port: 0,
        dataDir: dir,
        clientDir: dir,
        seed: 1,
        ...options,
        timing: { ...FAST, ...options.timing },
        log: (m) => h.logs.push(m),
      });
      h.servers.push(srv);
      return { srv, dataDir: dir };
    },
    async client(srv) {
      const c = await TestClient.open(srv.port);
      h.clients.push(c);
      return c;
    },
    async cleanup() {
      for (const c of h.clients) c.close();
      for (const s of h.servers) await s.close();
      for (const d of h.dirs) rmSync(d, { recursive: true, force: true });
      h.clients = [];
      h.servers = [];
      h.dirs = [];
    },
  };
  return h;
}
