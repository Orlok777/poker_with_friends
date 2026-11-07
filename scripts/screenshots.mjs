// Takes screenshots of every screen and phase at desktop and phone size.
// Run with `npm run screenshots` (it builds first). Output goes to ./screenshots (not committed).
//
// One real browser player ("Maya", the host) plays a hand against three scripted bots over WebSocket.
// The first hand is rigged so each run looks the same and ends in a showdown.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { startServer } from '../dist/server/server/index.js';

const OUT = join(process.cwd(), 'screenshots');
const VIEWPORTS = {
  desktop: { width: 1280, height: 800, isMobile: false },
  phone: { width: 390, height: 844, isMobile: true },
  // Only when asked for by name: npm run screenshots -- laptop
  laptop: { width: 1024, height: 700, isMobile: false, optional: true },
};
const only = process.argv.slice(2);

/** "AH 6S 10" -> cards. A bare rank is a spade. */
function cards(text) {
  return text.split(/\s+/).filter(Boolean).map((t) => {
    const last = t.slice(-1);
    const hasSuit = 'SHDC'.includes(last) && t.length > 1;
    return { rank: hasSuit ? t.slice(0, -1) : t, suit: hasSuit ? last : 'S' };
  });
}

// Hole cards go out one at a time from the left of the button, then the board.
const RIGGED = [cards('AH KD 9S QC AD 7C 9C JC  KH 2H 9H 5D 4S')];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.id = '';
    this.waiters = new Set();
    /** When true, the bot checks or calls on its own as soon as it is its turn. */
    this.auto = false;
    this.acted = new Set();
  }
  async open(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'joined') this.id = msg.playerId;
      if (msg.type === 'table_state') {
        this.state = msg;
        this.play();
        for (const w of [...this.waiters]) w();
      }
    });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
  }
  play() {
    const s = this.state;
    const legal = s?.you?.legal;
    if (!this.auto || !legal || s.turn !== this.id) return;
    const key = `${s.hand}:${s.phase}:${s.log.at(-1)?.id}`;
    if (this.acted.has(key)) return;
    this.acted.add(key);
    setTimeout(() => this.send({ type: 'action', action: legal.canCheck ? 'check' : 'call' }), 250);
  }
  setAuto(on) {
    this.auto = on;
    this.play();
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  waitFor(pred, what, timeout = 15000) {
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.name}: timed out waiting for ${what} (phase ${this.state?.phase})`));
      }, timeout);
      const check = () => {
        if (this.state && pred(this.state)) {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolve(this.state);
        }
      };
      this.waiters.add(check);
    });
  }
  close() {
    this.ws.terminate();
  }
}

async function run(browser, label, vp) {
  const dataDir = mkdtempSync(join(tmpdir(), 'poker-shots-'));
  const server = await startServer({
    port: 0,
    dataDir,
    hostToken: 'shots',
    rigged: RIGGED,
    seed: 7,
    log: () => {},
    timing: { dealMs: 300, streetMs: 600, potMs: 1500, showdownMs: 60_000, foldWinMs: 60_000, holdMs: 60_000, turnMs: 30_000 },
  });
  const base = `http://localhost:${server.port}`;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  const shot = async (name) => {
    await sleep(750); // let animations finish
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.warn(`  ! ${label}/${name}: page is ${overflow}px wider than the viewport`);
    await page.screenshot({ path: join(OUT, `${label}-${name}.png`) });
    console.log(`  ${label}-${name}.png`);
  };

  const bots = [];
  let serverClosed = false;
  try {
    await page.goto(`${base}/?host=shots`);
    await page.waitForSelector('#join-name', { state: 'visible' });
    await shot('1-join');

    await page.fill('#join-name', 'Maya');
    await page.click('#join-btn');
    await page.waitForSelector('#screen-waiting:not([hidden])');

    for (const name of ['Alex', 'Sam', 'Riley']) {
      const b = new Bot(name);
      await b.open(server.port);
      b.send({ type: 'join', username: name });
      await b.waitFor((s) => s.players.some((p) => p.name === name), 'join');
      bots.push(b);
    }
    const [alex, sam, riley] = bots;
    alex.send({ type: 'set_ready', ready: true });
    sam.send({ type: 'set_ready', ready: true });
    await alex.waitFor((s) => s.players.filter((p) => p.ready).length === 2, 'ready');
    await shot('2-waiting');

    // The same room as a player who is not the host: settings are read only.
    const guestContext = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
    });
    const guest = await guestContext.newPage();
    await guest.goto(base);
    await guest.fill('#join-name', 'Jordan');
    await guest.click('#join-btn');
    await guest.waitForSelector('#screen-waiting:not([hidden])');
    await sleep(500);
    await guest.screenshot({ path: join(OUT, `${label}-2b-waiting-guest.png`) });
    console.log(`  ${label}-2b-waiting-guest.png`);
    await guest.click('#leave-btn-wait');
    await guestContext.close();
    await alex.waitFor((s) => s.players.length === 4, 'guest left');

    await page.click('#ready-btn');
    riley.send({ type: 'set_ready', ready: true });
    await alex.waitFor((s) => s.players.filter((p) => p.ready).length === 4, 'all ready');
    await page.click('#start-btn');

    const mayaId = () => alex.state.players.find((p) => p.name === 'Maya').id;
    const mayasTurn = (s) => s.turn === mayaId();

    // Everyone before Maya calls; then it is her turn.
    for (const b of bots) b.setAuto(true);
    await alex.waitFor(mayasTurn, "Maya's turn");
    for (const b of bots) b.setAuto(false);
    await shot('3-preflop-my-turn');

    // Maya raises half the pot with the keyboard, then a bot thinks about it.
    await page.click('[data-preset="0.5"]');
    await page.keyboard.press('r');
    await alex.waitFor((s) => !mayasTurn(s) && s.turn !== null, 'next player');
    await sleep(1500); // the countdown visibly runs
    await shot('4-other-turn');

    // The bots call, and the flop comes.
    for (const b of bots) b.setAuto(true);
    await alex.waitFor((s) => s.phase === 'flop' && mayasTurn(s), 'flop, Maya to act');
    await shot('5-flop-my-turn');

    // Maya checks down to the showdown.
    while (true) {
      const s = await alex.waitFor((st) => mayasTurn(st) || st.phase === 'showdown' || st.phase === 'hand_over', 'Maya or showdown');
      if (!mayasTurn(s)) break;
      await page.keyboard.press('c');
      await alex.waitFor((st) => !mayasTurn(st), 'Maya checked');
    }
    await alex.waitFor((s) => s.phase === 'showdown' && s.potsAwarded === 0, 'showdown');
    await shot('6-showdown');
    await alex.waitFor((s) => s.phase === 'hand_over', 'results', 20000);
    await shot('7-results');

    const logBtn = await page.$('#log-btn');
    if (logBtn) {
      await logBtn.click();
      await shot('8-log-open');
      await logBtn.click().catch(() => page.keyboard.press('Escape'));
      await sleep(300);
    }
    const rulesBtn = await page.$('#rules-btn');
    if (rulesBtn) {
      await rulesBtn.click();
      await shot('9-rules');
      await page.keyboard.press('Escape');
    }

    await server.close();
    serverClosed = true;
    await page.waitForSelector('#screen-lost:not([hidden])');
    await shot('10-connection-lost');
  } finally {
    if (errors.length) console.warn(`  ! ${label}: console errors:\n    ${errors.join('\n    ')}`);
    for (const b of bots) b.close();
    await context.close();
    if (!serverClosed) await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
try {
  for (const [label, vp] of Object.entries(VIEWPORTS)) {
    if (only.length ? !only.includes(label) : vp.optional) continue;
    console.log(`${label} ${vp.width}x${vp.height}`);
    await run(browser, label, vp);
  }
} finally {
  await browser.close();
}
