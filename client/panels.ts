// The table log drawer and the rules popover, opened from the icon row.

import type { TableState } from '../shared/types.js';
import { $, fmt, h } from './dom.js';

let logOpen = false;
let rulesOpen = false;
/** Id of the newest log entry the player has seen. */
let seenLogId = -1;
let latestLogId = -1;

// --------------------------------------------------------------------- log

function setLogOpen(open: boolean): void {
  logOpen = open;
  $('log-drawer').hidden = !open;
  $('log-scrim').hidden = !open;
  $('log-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    setRulesOpen(false);
    seenLogId = latestLogId;
    updateUnread();
    const list = $('log');
    list.scrollTop = list.scrollHeight;
    $('log-close').focus();
  }
}

function updateUnread(): void {
  const badge = $('log-unread');
  const s = lastState;
  const unread = s ? s.log.filter((e) => e.id > seenLogId).length : 0;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.hidden = logOpen || unread === 0;
}

let lastState: TableState | null = null;

export function renderLog(s: TableState): void {
  lastState = s;
  const entries = s.log.slice(-40);
  latestLogId = entries.length ? entries[entries.length - 1]!.id : -1;
  // The first time we see the table, older entries do not count as unread.
  if (seenLogId === -1) seenLogId = latestLogId;
  const list = $('log');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  list.replaceChildren(...entries.map((e) => h('li', e.id > seenLogId && !logOpen ? 'fresh' : undefined, e.text)));
  if (logOpen) {
    seenLogId = latestLogId;
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  updateUnread();
}

// ------------------------------------------------------------------- rules

function setRulesOpen(open: boolean): void {
  rulesOpen = open;
  $('rules-pop').hidden = !open;
  $('rules-btn').setAttribute('aria-expanded', String(open));
  if (open) setLogOpen(false);
}

export function renderRules(s: TableState): void {
  const st = s.settings;
  const rows: [string, string][] = [
    ['Blackjack pays', st.blackjackPayout === '3:2' ? '3 to 2' : '6 to 5'],
    ['Dealer on soft 17', st.dealerHitsSoft17 ? 'Hits' : 'Stands'],
    ['Double down', st.doubleRule === 'any' ? 'Any two cards' : st.doubleRule === '9-11' ? 'On 9, 10 or 11' : 'Not allowed'],
    ['Bets', `${fmt(st.minBet)} to ${fmt(st.maxBet)}`],
    ['Decks in the shoe', String(st.decks)],
    ['Betting time', `${st.bettingSeconds} s`],
    ['Turn time', st.turnSeconds === null ? 'No limit' : `${st.turnSeconds} s`],
  ];
  $('rules-list').replaceChildren(
    ...rows.map(([k, v]) => {
      const row = h('div', 'rules-row');
      row.append(h('dt', undefined, k), h('dd', undefined, v));
      return row;
    }),
  );
}

// -------------------------------------------------------------------- init

export function closePanels(): void {
  setLogOpen(false);
  setRulesOpen(false);
}

/** Forgets what was read, e.g. after leaving the table. */
export function resetPanels(): void {
  closePanels();
  seenLogId = -1;
  latestLogId = -1;
  lastState = null;
}

export function initPanels(): void {
  $('log-btn').addEventListener('click', () => setLogOpen(!logOpen));
  $('log-close').addEventListener('click', () => {
    setLogOpen(false);
    $('log-btn').focus();
  });
  $('log-scrim').addEventListener('click', () => setLogOpen(false));
  $('rules-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    setRulesOpen(!rulesOpen);
  });
  document.addEventListener('click', (ev) => {
    if (rulesOpen && !(ev.target as Element).closest('#rules-pop, #rules-btn')) setRulesOpen(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (rulesOpen) {
      setRulesOpen(false);
      $('rules-btn').focus();
    } else if (logOpen) {
      setLogOpen(false);
      $('log-btn').focus();
    }
  });
}
