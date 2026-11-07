// HTTP + WebSocket entry point. `startServer` has no side effects beyond listening on a port,
// so the Phase 2 desktop app can call it too. Printing the links and opening the browser
// happen only when this file is run directly (npm start).

import express from 'express';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { Card, ServerMsg } from '../shared/types.js';
import { PlayerStore } from './store.js';
import { Table, type Connection, type Timing } from './table.js';

export interface ServerOptions {
  /** Port to listen on. 0 picks a free port. Default 3000. */
  port?: number;
  /** Folder for players.json. Default `./data`. */
  dataDir?: string;
  /** Folder with the built client. Found automatically when absent. */
  clientDir?: string;
  /** Host token. A random one is made when absent. */
  hostToken?: string;
  /** Seed for the shuffle. For tests. */
  seed?: number;
  /** Cards dealt first in each hand, one list per hand. For tests. */
  rigged?: Card[][];
  /** Shorter timers. For tests. */
  timing?: Partial<Timing>;
  /** Where warnings and errors go. Default console. */
  log?: (message: string) => void;
  /** Finds this machine's public IP. Default asks api.ipify.org. For tests. */
  publicIpLookup?: () => Promise<string>;
}

export interface RunningServer {
  port: number;
  hostToken: string;
  /** Link that gives host controls, using localhost. */
  hostUrl: string;
  /** Join links for other machines on the same network. */
  lanUrls: string[];
  table: Table;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MS = 15_000;
const MAX_MESSAGE_BYTES = 16 * 1024;

export function findClientDir(): string | undefined {
  // Compiled: dist/server/server/index.js -> dist/client. From source: server/index.ts -> dist/client.
  return [join(here, '..', '..', 'client'), join(here, '..', 'dist', 'client')].find((dir) =>
    existsSync(join(dir, 'index.html')),
  );
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // 169.254.x.x is a self-assigned address that no other machine can use.
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

const IP_SERVICE = 'https://api.ipify.org';
const IP_LOOKUP_TIMEOUT_MS = 4000;
const IP_CACHE_MS = 5 * 60_000;

/** Asks an outside service which address our traffic comes from. Throws when it can't tell. */
export async function lookupPublicIp(): Promise<string> {
  const res = await fetch(IP_SERVICE, { signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ip = (await res.text()).trim();
  if (!isIP(ip)) throw new Error('unexpected reply');
  return ip;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((m: string) => console.error(m));
  const hostToken = options.hostToken ?? randomBytes(18).toString('base64url');
  const dataDir = resolve(options.dataDir ?? join(process.cwd(), 'data'));
  const store = new PlayerStore(dataDir, (m) => log(`Warning: ${m}`));
  const table = new Table({
    store,
    hostToken,
    timing: options.timing,
    seed: options.seed,
    rigged: options.rigged,
    log,
  });

  const app = express();
  app.disable('x-powered-by');

  // The public address players can use, once the router forwards our port. Cached so a few
  // clicks on the Share button make one outside request.
  const lookupIp = options.publicIpLookup ?? lookupPublicIp;
  let listenPort = options.port ?? 3000;
  let cachedIp: { ip: string; at: number } | null = null;
  app.get('/api/public-ip', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!cachedIp || Date.now() - cachedIp.at > IP_CACHE_MS) cachedIp = { ip: await lookupIp(), at: Date.now() };
      res.json({ ip: cachedIp.ip, port: listenPort });
    } catch (err) {
      log(`Warning: could not look up the public IP: ${err instanceof Error ? err.message : String(err)}`);
      res.status(502).json({ error: 'Could not find your public IP. Check your internet connection.' });
    }
  });

  const clientDir = options.clientDir ?? findClientDir();
  if (clientDir) app.use(express.static(clientDir));
  else log('Warning: the client has not been built yet, so no web page will be served');

  const httpServer: Server = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const conn: Connection = {
      send(msg: ServerMsg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close();
      },
    };
    ws.on('message', (data) => {
      table.handleMessage(conn, data.toString());
    });
    ws.on('close', () => table.disconnect(conn));
    ws.on('error', (err) => log(`WebSocket error: ${err.message}`));
    table.connect(conn);
  });

  // Dead connections (a phone that went to sleep) are noticed by ping, so the seat hold can start.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(options.port ?? 3000, '0.0.0.0', () => {
      httpServer.off('error', rejectListen);
      resolveListen();
    });
  });
  httpServer.on('error', (err) => log(`HTTP server error: ${err.message}`));

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 3000);
  listenPort = port;

  return {
    port,
    hostToken,
    hostUrl: `http://localhost:${port}/?host=${hostToken}`,
    lanUrls: lanAddresses().map((ip) => `http://${ip}:${port}`),
    table,
    async close() {
      clearInterval(heartbeat);
      table.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

// ---------------------------------------------------------------- run directly

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The host can still copy the link from the console.
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const a = resolve(entry);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT) || 3000;
  let server: RunningServer;
  try {
    server = await startServer({ port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Close the other program or start with a different PORT, for example: set PORT=3002 && npm start`);
    } else {
      console.error(`Could not start the server: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  console.log('');
  console.log('Poker with friends is running.');
  console.log('');
  console.log('  Host link (opens host controls, keep it to yourself):');
  console.log(`    ${server.hostUrl}`);
  console.log('');
  if (server.lanUrls.length > 0) {
    console.log('  Share one of these with players on your network:');
    for (const url of server.lanUrls) console.log(`    ${url}`);
  } else {
    console.log('  No network address found. Players on other machines can not reach this server yet.');
  }
  console.log('');
  console.log('  Press Ctrl+C to stop the server. That ends the game for everyone.');
  console.log('');

  if (!process.env.NO_OPEN) openBrowser(server.hostUrl);

  const stop = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (isMainModule()) {
  void main();
}
