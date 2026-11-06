import {
  SETTINGS_LIMITS,
  isHiddenCard,
  type CardView,
  type ClientMsg,
  type PlayerView,
  type PublicSettings,
  type ServerMsg,
  type Settings,
  type TableState,
} from '../shared/types.js';
import { app, confirmKick, isHost, me, resetChips, send, toast } from './app.js';
import { $, fmt, h, storageGet, storageSet } from './dom.js';
import { hydrateIcons, icon } from './icons.js';
import { initWaiting, renderWaiting, resyncSettings } from './waiting.js';
import { isMuted, playChip, playDeal, playLose, playWin, setMuted, unlockAudio } from './sound.js';

// ------------------------------------------------------------------ session

interface Session {
  username: string;
  token: string;
  password: string;
}

const SESSION_KEY = 'bj.session';

function loadSession(): Session | null {
  try {
    const raw = storageGet(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (typeof s.username !== 'string') return null;
    return { username: s.username, token: typeof s.token === 'string' ? s.token : '', password: typeof s.password === 'string' ? s.password : '' };
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  storageSet(SESSION_KEY, s ? JSON.stringify(s) : null);
}

/** The host link carries ?host=TOKEN. It is kept for this tab so a refresh stays host. */
const hostToken: string | null = (() => {
  const fromUrl = new URLSearchParams(location.search).get('host');
  if (fromUrl) storageSet('bj.host', fromUrl, sessionStorage);
  return fromUrl ?? storageGet('bj.host', sessionStorage);
})();

// -------------------------------------------------------------------- state

let serverInfo: Extract<ServerMsg, { type: 'server_info' }> | null = null;
let joinAttempt: { username: string; password: string; auto: boolean } | null = null;
let kicked = false;
let lostNote: string | null = null;
let pendingBet = 0;
let actionBusy = false;
let lastDeadline: number | null = null;
let timerTotal = 1;
let phaseText = '';
let firstTableRender = true;

type ScreenName = 'join' | 'waiting' | 'table' | 'lost' | 'kicked';
const SCREENS: ScreenName[] = ['join', 'waiting', 'table', 'lost', 'kicked'];

function showScreen(name: ScreenName | null): void {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
}

// --------------------------------------------------------------- connection

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}`);
  app.ws = sock;
  sock.onmessage = (ev) => {
    if (sock !== app.ws) return;
    try {
      handle(JSON.parse(String(ev.data)) as ServerMsg);
    } catch (err) {
      console.error('Bad message from server', err);
    }
  };
  sock.onclose = () => {
    if (sock !== app.ws) return;
    app.joined = false;
    if (kicked) return; // the kicked screen is already showing
    $('lost-note').textContent =
      lostNote ?? 'The server stopped or your connection dropped. Your chips are saved up to the last finished round.';
    showScreen('lost');
  };
  sock.onerror = () => {
    // onclose follows and shows the Connection lost screen.
  };
}

function doJoin(username: string, password: string, auto: boolean): void {
  joinAttempt = { username, password, auto };
  const session = loadSession();
  const token = session && session.username.toLowerCase() === username.toLowerCase() ? session.token : '';
  const msg: ClientMsg = { type: 'join', username, password };
  if (token) msg.reconnectToken = token;
  if (hostToken) msg.hostToken = hostToken;
  send(msg);
}

function handle(msg: ServerMsg): void {
  switch (msg.type) {
    case 'server_info': {
      serverInfo = msg;
      $('join-password-row').hidden = !msg.passwordRequired;
      if (app.joined) return;
      const session = loadSession();
      if (session && session.token && !joinAttempt) {
        doJoin(session.username, session.password, true); // refresh or reconnect
      } else if (!joinAttempt) {
        $<HTMLInputElement>('join-name').value ||= session?.username ?? '';
        showScreen('join');
      }
      return;
    }
    case 'joined': {
      app.joined = true;
      app.myId = msg.playerId;
      lostNote = null;
      if (joinAttempt) {
        saveSession({ username: joinAttempt.username, token: msg.reconnectToken, password: joinAttempt.password });
      }
      joinAttempt = null;
      $('join-error').textContent = '';
      return;
    }
    case 'table_state': {
      app.prevState = app.state;
      app.state = msg;
      app.clockOffset = msg.serverNow - Date.now();
      render();
      return;
    }
    case 'round_result': {
      const mine = msg.results.find((r) => r.playerId === app.myId);
      if (mine?.outcome === 'win' || mine?.outcome === 'blackjack') playWin();
      else if (mine?.outcome === 'loss') playLose();
      return;
    }
    case 'kicked': {
      kicked = true;
      app.joined = false;
      const s = loadSession();
      if (s) saveSession({ ...s, token: '' });
      $('kicked-note').textContent = msg.reason;
      showScreen('kicked');
      return;
    }
    case 'error':
      return handleError(msg.code, msg.message);
  }
}

const JOIN_ERRORS = new Set(['bad_username', 'name_in_use', 'wrong_password', 'kicked', 'bad_message']);

function handleError(code: string, message: string): void {
  if (!app.joined && joinAttempt) {
    const s = loadSession();
    if (s && (code === 'wrong_password' || code === 'name_in_use' || code === 'kicked')) {
      saveSession({ ...s, token: '', password: code === 'wrong_password' ? '' : s.password });
    }
    if (JOIN_ERRORS.has(code)) {
      joinAttempt = null;
      $('join-error').textContent = message;
      $<HTMLButtonElement>('join-btn').disabled = false;
      showScreen('join');
      return;
    }
  }
  if (code === 'already_joined' && app.joined) {
    // Another tab took over this player. The server closes this connection next.
    lostNote = message;
    return;
  }
  if (code === 'invalid_settings' || code === 'settings_locked') {
    resyncSettings();
  }
  actionBusy = false;
  if (app.state) renderBars();
  toast(message);
}

// --------------------------------------------------------------------- join

$('join-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const username = $<HTMLInputElement>('join-name').value.trim();
  const password = $<HTMLInputElement>('join-password').value;
  $('join-error').textContent = '';
  if (!username) return;
  unlockAudio();
  doJoin(username, password, false);
});

function goToJoinScreen(): void {
  app.joined = false;
  app.myId = null;
  app.state = null;
  app.prevState = null;
  joinAttempt = null;
  firstTableRender = true;
  shown.clear();
  holeHidden.clear();
  const s = loadSession();
  if (s) saveSession({ ...s, token: '' });
  $<HTMLInputElement>('join-name').value = s?.username ?? '';
  showScreen('join');
}

function leave(): void {
  send({ type: 'leave' });
  goToJoinScreen();
}

$('leave-btn-wait').addEventListener('click', leave);
$('leave-btn-table').addEventListener('click', leave);

$('retry-btn').addEventListener('click', () => {
  lostNote = null;
  joinAttempt = null;
  connect();
});

$('kicked-back').addEventListener('click', () => {
  kicked = false;
  goToJoinScreen();
  showScreen(null);
  connect();
});

// -------------------------------------------------------------------- sound

function updateMuteButton(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.mute-btn')) {
    btn.replaceChildren(icon(isMuted() ? 'soundOff' : 'soundOn'));
    btn.setAttribute('aria-label', isMuted() ? 'Unmute sound' : 'Mute sound');
    btn.title = isMuted() ? 'Unmute sound' : 'Mute sound';
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('.mute-btn')) {
  btn.addEventListener('click', () => {
    setMuted(!isMuted());
    updateMuteButton();
    unlockAudio();
  });
}
document.addEventListener('pointerdown', () => unlockAudio(), { once: true });
updateMuteButton();

// ------------------------------------------------------------------- render

function render(): void {
  if (!app.state || !app.myId) return;
  actionBusy = false;
  const self = me();
  if (!self) return;
  if (app.state.phase === 'waiting') {
    showScreen('waiting');
    renderWaiting(app.state, self);
  } else {
    showScreen('table');
    renderTable(app.state, self);
  }
}

// -------------------------------------------------------------------- cards

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' } as const;

function cardEl(card: CardView): HTMLElement {
  if (isHiddenCard(card)) return h('div', 'card back');
  const red = card.suit === 'H' || card.suit === 'D';
  const el = h('div', red ? 'card red' : 'card');
  const suit = SUIT_CHAR[card.suit];
  for (const pos of ['tl', 'br']) {
    const corner = h('span', `corner ${pos}`);
    corner.append(h('span', undefined, card.rank), h('span', undefined, suit));
    el.append(corner);
  }
  el.append(h('span', 'pip', suit));
  el.setAttribute('aria-label', `${card.rank} of ${card.suit}`);
  return el;
}

/** How many cards of each hand were already on screen, so only new cards slide in. */
const shown = new Map<string, number>();
const toAnimate: HTMLElement[] = [];
const toFlip: HTMLElement[] = [];
let newCardsThisRender = 0;

function handEl(key: string, cards: CardView[], animate: boolean): HTMLElement {
  const hand = h('div', 'hand');
  const prev = shown.get(key) ?? 0;
  const prevHole = holeHidden.get(key);
  cards.forEach((card, i) => {
    const el = cardEl(card);
    if (animate && i >= prev) {
      toAnimate.push(el);
      newCardsThisRender++;
    } else if (animate && i === 1 && prevHole === true && !isHiddenCard(card)) {
      toFlip.push(el); // the dealer's hole card was just revealed
    }
    hand.append(el);
  });
  shown.set(key, cards.length);
  if (key === 'dealer') holeHidden.set(key, cards.length > 1 && isHiddenCard(cards[1]!));
  return hand;
}

const holeHidden = new Map<string, boolean>();

function runCardAnimations(): void {
  const shoe = $('shoe').getBoundingClientRect();
  for (const el of toAnimate.splice(0)) {
    const r = el.getBoundingClientRect();
    const dx = shoe.left + shoe.width / 2 - (r.left + r.width / 2);
    const dy = shoe.top + shoe.height / 2 - (r.top + r.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) rotate(-25deg) scale(0.6)`, opacity: 0.2 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 320, easing: 'ease-out' },
    );
  }
  for (const el of toFlip.splice(0)) {
    el.animate([{ transform: 'rotateY(90deg)' }, { transform: 'none' }], { duration: 300, easing: 'ease-out' });
  }
}

function totalText(total: number, soft: boolean, cardCount: number, blackjack: boolean): string {
  if (cardCount === 0) return '';
  if (blackjack) return 'Blackjack';
  return soft && total <= 21 ? `soft ${total}` : String(total);
}

// -------------------------------------------------------------------- table

const PHASE_NAMES: Record<string, string> = {
  waiting: 'Waiting room',
  betting: 'Betting',
  dealing: 'Dealing',
  player_turns: 'Player turns',
  dealer_turn: "Dealer's turn",
  settle: 'Results',
};

function seatSlots(s: TableState, self: PlayerView): number[] {
  const n = s.seats.length;
  if (self.seat === null) return Array.from({ length: n }, (_, i) => i);
  const center = Math.floor((n - 1) / 2);
  return Array.from({ length: n }, (_, k) => (((self.seat! + k - center) % n) + n) % n);
}

function statusFor(s: TableState, p: PlayerView): { text: string; cls: string } {
  if (p.outcome) {
    const d = p.delta ?? 0;
    switch (p.outcome) {
      case 'win':
        return { text: `WIN +${fmt(d)}`, cls: 'good' };
      case 'blackjack':
        return { text: `BLACKJACK +${fmt(d)}`, cls: 'good' };
      case 'push':
        return { text: 'PUSH', cls: 'neutral' };
      case 'loss':
        return { text: p.status === 'bust' ? `BUST −${fmt(Math.abs(d))}` : `LOSE −${fmt(Math.abs(d))}`, cls: 'bad' };
    }
  }
  if (p.status === 'bust') return { text: 'BUST', cls: 'bad' };
  if (p.status === 'blackjack') return { text: 'BLACKJACK', cls: 'good' };
  if (!p.connected) return { text: 'Away', cls: 'neutral' };
  if (s.phase === 'betting') {
    if (p.bet > 0) return { text: 'Bet placed', cls: 'neutral' };
    if (p.chips < s.settings.minBet) return { text: 'Out of chips', cls: 'bad' };
    return { text: 'Betting…', cls: '' };
  }
  if (p.status === 'none') return { text: 'Sitting out', cls: '' };
  if (p.status === 'stood') return { text: 'STAND', cls: 'neutral' };
  if (s.turn === p.id) return { text: 'Playing…', cls: 'neutral' };
  return { text: 'Waiting', cls: '' };
}

function seatEl(s: TableState, p: PlayerView | undefined, index: number, slot: number, n: number, self: PlayerView): HTMLElement {
  const seat = h('div', 'seat');
  const t = n === 1 ? 0.5 : slot / (n - 1);
  const angle = ((-62 + 124 * t) * Math.PI) / 180;
  seat.style.setProperty('--x', `${50 + 41 * Math.sin(angle)}%`);
  seat.style.setProperty('--y', `${78 - 34 * (1 - Math.cos(angle))}%`);
  if (!p) {
    seat.classList.add('empty');
    seat.textContent = 'Open seat';
    seat.dataset.seat = String(index);
    return seat;
  }
  if (p.id === app.myId) seat.classList.add('me');
  if (s.turn === p.id) seat.classList.add('turn');
  if (!p.connected) seat.classList.add('away');

  if (isHost() && p.id !== app.myId) {
    const kick = h('button', 'kick', '✕');
    kick.type = 'button';
    kick.title = `Kick ${p.name}`;
    kick.setAttribute('aria-label', `Kick ${p.name}`);
    kick.addEventListener('click', () => confirmKick(p));
    seat.append(kick);
  }

  seat.append(h('div', 'name', p.id === s.hostId ? `★ ${p.name}` : p.name));
  const stats = h('div', 'stats');
  stats.append('Chips ', h('b', undefined, fmt(p.chips)));
  if (p.bet > 0) stats.append(' · Bet ', h('b', undefined, fmt(p.bet) + (p.doubled ? ' ×2' : '')));
  seat.append(stats);

  seat.append(handEl(p.id, p.cards, !firstTableRender));
  if (p.cards.length > 0) {
    seat.append(h('span', 'total', totalText(p.total, p.soft, p.cards.length, p.status === 'blackjack')));
  }
  const st = statusFor(s, p);
  seat.append(h('div', `status ${st.cls}`, st.text));
  if (s.turn === p.id) {
    const bar = h('div', 'turn-bar');
    bar.append(h('span'));
    seat.append(bar);
  }
  void self;
  return seat;
}

function bannerFor(s: TableState, self: PlayerView): HTMLElement {
  const box = h('div');
  const turnPlayer = s.players.find((p) => p.id === s.turn);
  switch (s.phase) {
    case 'betting':
      box.textContent = s.deadline ? 'Place your bets' : 'Waiting for players…';
      break;
    case 'dealing':
      box.textContent = 'Dealing…';
      break;
    case 'player_turns':
      box.textContent = turnPlayer ? (turnPlayer.id === self.id ? 'Your turn' : `${turnPlayer.name}'s turn`) : '';
      break;
    case 'dealer_turn':
      box.textContent = s.dealer.blackjack ? 'Dealer has blackjack' : "Dealer's turn";
      break;
    case 'settle': {
      box.textContent = 'Round results';
      const results = h('div', 'results');
      for (const p of s.players) {
        if (!p.outcome) continue;
        const st = statusFor(s, p);
        const chip = h('span', `result-chip ${p.outcome === 'loss' ? 'loss' : p.outcome === 'push' ? '' : 'win'}`);
        chip.textContent = `${p.name}: ${st.text}`;
        results.append(chip);
      }
      box.append(results);
      break;
    }
  }
  return box;
}

function renderTable(s: TableState, self: PlayerView): void {
  const animate = !firstTableRender;
  toAnimate.length = 0;
  toFlip.length = 0;
  newCardsThisRender = 0;

  // Top bar
  $('round-label').textContent = s.round > 0 ? `Round ${s.round}` : '';
  phaseText = PHASE_NAMES[s.phase] ?? s.phase;
  if (s.deadline !== lastDeadline) {
    lastDeadline = s.deadline;
    timerTotal = s.deadline ? Math.max(1, s.deadline - s.serverNow) : 1;
  }

  // Dealer
  const dealer = $('dealer');
  dealer.replaceChildren(h('div', 'dealer-label', 'Dealer'));
  dealer.append(handEl('dealer', s.dealer.cards, animate));
  const visibleCards = s.dealer.cards.filter((c) => !isHiddenCard(c)).length;
  if (visibleCards > 0) {
    dealer.append(h('span', 'total', totalText(s.dealer.total, s.dealer.soft, visibleCards, s.dealer.blackjack)));
  }

  // Banner
  $('banner').replaceChildren(bannerFor(s, self));

  // Seats
  const seatsBox = $('seats');
  seatsBox.replaceChildren();
  const n = s.seats.length;
  seatSlots(s, self).forEach((seatIndex, slot) => {
    const id = s.seats[seatIndex];
    const p = id ? s.players.find((x) => x.id === id) : undefined;
    seatsBox.append(seatEl(s, p, seatIndex, slot, n, self));
  });

  // Log
  const log = $('log');
  log.replaceChildren(...s.log.slice(-14).map((e) => h('li', undefined, e.text)));
  log.scrollTop = log.scrollHeight;

  renderBars();
  runCardAnimations();

  // Sounds
  if (animate && newCardsThisRender > 0) playDeal();
  if (app.prevState && s.phase === 'betting') {
    const before = new Map(app.prevState.players.map((p) => [p.id, p.bet]));
    if (s.players.some((p) => p.bet > 0 && (before.get(p.id) ?? 0) === 0 && p.id !== app.myId)) playChip();
  }
  firstTableRender = false;
  tick();
}

const CHIP_VALUES = [10, 25, 100, 500];

function buildBetBar(): void {
  const box = $('chip-buttons');
  for (const v of CHIP_VALUES) {
    const b = h('button', 'chip-btn', String(v));
    b.type = 'button';
    b.dataset.value = String(v);
    b.setAttribute('aria-label', `Add ${v} to your bet`);
    b.addEventListener('click', () => {
      const self = me();
      if (!app.state || !self) return;
      const cap = Math.min(app.state.settings.maxBet, self.chips);
      pendingBet = Math.min(pendingBet + v, cap);
      playChip();
      renderBars();
    });
    box.append(b);
  }
}

$('clear-bet').addEventListener('click', () => {
  pendingBet = 0;
  renderBars();
});

$('confirm-bet').addEventListener('click', () => {
  if (pendingBet <= 0 || actionBusy) return;
  actionBusy = true;
  playChip();
  send({ type: 'place_bet', amount: pendingBet });
  renderBars();
});

for (const [id, action] of [
  ['hit-btn', 'hit'],
  ['stand-btn', 'stand'],
  ['double-btn', 'double'],
] as const) {
  $(id).addEventListener('click', () => {
    if (actionBusy) return;
    actionBusy = true;
    send({ type: 'action', action });
    renderBars();
  });
}

/** Betting bar, action bar and the note under the table. */
function renderBars(): void {
  const s = app.state;
  const self = me();
  if (!s || !self || s.phase === 'waiting') return;

  const seated = self.seat !== null;
  const canBet = s.phase === 'betting' && seated && self.bet === 0 && self.chips >= s.settings.minBet && s.deadline !== null;
  if (!canBet || self.bet > 0) pendingBet = 0;
  const cap = Math.min(s.settings.maxBet, self.chips);

  $('bet-bar').hidden = !(s.phase === 'betting' && seated);
  $('pending-bet').textContent = fmt(self.bet > 0 ? self.bet : pendingBet);
  for (const b of document.querySelectorAll<HTMLButtonElement>('.chip-btn')) {
    b.disabled = !canBet || actionBusy || pendingBet >= cap;
  }
  $<HTMLButtonElement>('clear-bet').disabled = !canBet || actionBusy || pendingBet === 0;
  $<HTMLButtonElement>('confirm-bet').disabled = !canBet || actionBusy || pendingBet < s.settings.minBet;
  const canReset = s.phase === 'betting' && self.bet === 0 && !actionBusy;
  const resetBtn = $<HTMLButtonElement>('reset-btn-table');
  resetBtn.disabled = !canReset;
  resetBtn.classList.toggle('primary', self.chips < s.settings.minBet);

  const myTurn = s.phase === 'player_turns' && s.turn === self.id && !actionBusy;
  $('action-bar').hidden = !(seated && (s.phase === 'player_turns' || s.phase === 'dealer_turn') && self.status !== 'none');
  $<HTMLButtonElement>('hit-btn').disabled = !myTurn;
  $<HTMLButtonElement>('stand-btn').disabled = !myTurn;
  $<HTMLButtonElement>('double-btn').disabled = !(myTurn && self.canDouble);

  const note = $('watch-note');
  let text = '';
  if (!seated) text = "You're watching. You'll take a free seat at the start of the next round.";
  else if (s.phase === 'betting' && self.chips < s.settings.minBet) text = "You're out of chips. Use Reset chips to keep playing.";
  else if (self.status === 'none' && s.phase !== 'betting' && s.phase !== 'settle') text = "You're sitting out this round.";
  note.textContent = text;
  note.hidden = text === '';
}

// -------------------------------------------------------------------- timer

function tick(): void {
  if (!app.state || app.state.phase === 'waiting') return;
  let secs = '';
  let fraction = 0;
  if (app.state.deadline !== null) {
    const remaining = Math.max(0, app.state.deadline - (Date.now() + app.clockOffset));
    secs = ` · ${Math.ceil(remaining / 1000)}s`;
    fraction = Math.min(1, remaining / timerTotal);
  }
  $('phase-label').textContent = phaseText + secs;
  $('phase-timer-bar').style.width = `${fraction * 100}%`;
  const turnBar = document.querySelector<HTMLElement>('.turn-bar span');
  if (turnBar) turnBar.style.width = `${fraction * 100}%`;
}

setInterval(tick, 100);

// --------------------------------------------------------------------- init

hydrateIcons();
$('reset-btn-table').addEventListener('click', resetChips);
initWaiting();
buildBetBar();
showScreen(null);
connect();
