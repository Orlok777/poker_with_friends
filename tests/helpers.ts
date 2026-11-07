// Test helpers: a small WebSocket client and a server boot function.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ActionKind, ClientMsg, HandResult, LegalView, PlayerView, ServerMsg, TableState } from '../shared/types.js';
import { startServer, type RunningServer, type ServerOptions } from '../server/index.js';
import type { Timing } from '../server/table.js';

export { cards, show } from './cards.js';

export type ErrorMsg = Extract<ServerMsg, { type: 'error' }>;
export type HandResultMsg = Extract<ServerMsg, { type: 'hand_result' }>;

export const FAST: Partial<Timing> = {
  dealMs: 5,
  streetMs: 5,
  runoutMs: 5,
  potMs: 5,
  showdownMs: 60,
  revealScale: 0,
  foldWinMs: 60,
  holdMs: 400,
  turnMs: 1500,
};

export async function waitUntil(check: () => boolean, timeout = 4000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Policy = (legal: LegalView, s: TableState) => { action: ActionKind; amount?: number };

/** Checks when it can, otherwise calls. */
export const passive: Policy = (l) => ({ action: l.canCheck ? 'check' : 'call' });

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
        reject(new Error(`Timed out waiting for a table state (last: phase ${this.state?.phase}, hand ${this.state?.hand})`));
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

  /** Waits until it is this player's turn and returns that state. */
  waitForTurn(timeout = 4000): Promise<TableState> {
    return this.waitForState((s) => s.turn === this.id && s.you?.legal !== null && s.you?.legal !== undefined, timeout);
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

  /** Plays by itself: whenever it is this player's turn, `policy` picks the action. */
  autoPlay(policy: Policy): () => void {
    const done = new Set<string>();
    const handle = (s: TableState) => {
      if (this.closed || s.turn !== this.id || !s.you?.legal) return;
      // A player never gets the turn twice with the betting exactly the same, so this sends one action per turn.
      const chipsIn = s.pots.reduce((sum, p) => sum + p.amount, 0) + s.players.reduce((sum, p) => sum + p.bet, 0);
      const key = `${s.hand}:${s.phase}:${chipsIn}:${s.players.filter((p) => p.folded).length}`;
      if (done.has(key)) return;
      done.add(key);
      this.send({ type: 'action', ...policy(s.you.legal, s) });
    };
    const off = this.onState(handle);
    if (this.state) handle(this.state); // it may already be this player's turn
    return off;
  }

  /** Every hand_result message received so far. */
  results(): HandResultMsg[] {
    return this.all.filter((m): m is HandResultMsg => m.type === 'hand_result');
  }

  /** Remembers the first `hand_over` table state of every hand. */
  collectHandOvers(): Map<number, TableState> {
    const seen = new Map<number, TableState>();
    this.onState((s) => {
      if (s.phase === 'hand_over' && !seen.has(s.hand)) seen.set(s.hand, s);
    });
    return seen;
  }

  close(): void {
    this.ws.terminate();
  }
}

/** Net chips for a player in a hand result (0 when not in the hand). */
export function netOf(r: HandResult, id: string): number {
  return r.players.find((p) => p.playerId === id)?.net ?? 0;
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
      const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'poker-test-'));
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
