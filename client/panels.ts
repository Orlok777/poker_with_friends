// The table log drawer and the How to play drawer, opened from the icon row.

import type { TableState } from '../shared/types.js';
import { cardEl } from './cards.js';
import { $, fmt, h } from './dom.js';
import { RANKING_NOTES, RANKINGS, rankingKey, rulesGroups, type RankingKey } from './guideContent.js';

let logOpen = false;
let guideOpen = false;
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
    setGuideOpen(false);
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

// ------------------------------------------------------------- how to play

type GuideTab = 'how' | 'rules';
let guideTab: GuideTab = 'how';
let dockWatch: ResizeObserver | null = null;
/** What the rules text was last built for, so it is not rebuilt (and scrolled back) on every update. */
let rulesKey = '';
const rankRows = new Map<RankingKey, HTMLElement>();

/**
 * The drawer stops above the dock, so the action bar and my cards stay visible and usable. The table is one
 * screen tall (the dock is its last row), so the gap under the drawer is the dock's height.
 */
function fitGuide(): void {
  const dock = document.querySelector('.dock');
  if (!dock) return;
  const gap = Math.max(0, Math.round(window.innerHeight - dock.getBoundingClientRect().top));
  $('guide-drawer').style.setProperty('--guide-bottom', `${gap}px`);
}

function setGuideTab(tab: GuideTab): void {
  guideTab = tab;
  for (const [id, name] of [
    ['guide-tab-how', 'how'],
    ['guide-tab-rules', 'rules'],
  ] as const) {
    const on = name === tab;
    const btn = $(id);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  $('guide-how').hidden = tab !== 'how';
  $('guide-rules').hidden = tab !== 'rules';
}

function setGuideOpen(open: boolean): void {
  guideOpen = open;
  $('guide-drawer').hidden = !open;
  $('rules-btn').setAttribute('aria-expanded', String(open));
  dockWatch?.disconnect();
  if (open) {
    setLogOpen(false);
    fitGuide();
    const dock = document.querySelector('.dock');
    if (dock && typeof ResizeObserver !== 'undefined') {
      dockWatch ??= new ResizeObserver(fitGuide);
      dockWatch.observe(dock);
    }
    $('guide-close').focus({ preventScroll: true });
  }
}

/** The hand rankings, built once. The rules text below them is filled in by `renderRulesText`. */
function buildGuide(): void {
  const rankings = h('section', 'guide-sec');
  rankings.append(h('h3', 'guide-h', 'Hand rankings'), h('p', 'guide-lead', 'From the best hand to the worst.'));
  const list = h('ol', 'rank-list');
  RANKINGS.forEach((row, i) => {
    const li = h('li', 'rank-row');
    li.dataset.rank = row.key;
    const head = h('div', 'rank-head');
    head.append(h('span', 'rank-n num', String(i + 1)), h('span', 'rank-name', row.name), h('span', 'rank-you', 'Your hand'));
    const cards = h('div', 'rank-cards hand');
    const labels: string[] = [];
    for (const c of row.example) {
      const el = cardEl(c);
      labels.push(el.getAttribute('aria-label') ?? '');
      el.removeAttribute('aria-label');
      cards.append(el);
    }
    cards.setAttribute('role', 'img');
    cards.setAttribute('aria-label', `Example: ${labels.join(', ')}`);
    li.append(head, h('p', 'rank-explain', row.explain), cards);
    list.append(li);
    rankRows.set(row.key, li);
  });
  const notes = h('ul', 'guide-notes');
  for (const text of RANKING_NOTES) notes.append(h('li', undefined, text));
  rankings.append(list, notes);
  $('guide-how').replaceChildren(rankings, h('div', 'guide-rules-slot'));
}

/** The rules, with this table's blinds. Rebuilt only when the blinds change. */
function renderRulesText(s: TableState): void {
  const key = `${s.settings.smallBlind}/${s.settings.bigBlind}`;
  if (key === rulesKey) return;
  rulesKey = key;
  const slot = $('guide-how').querySelector('.guide-rules-slot');
  if (!slot) return;
  const sec = h('section', 'guide-sec');
  sec.append(h('h3', 'guide-h', 'Rules'));
  for (const group of rulesGroups(s.settings)) {
    sec.append(h('h4', 'guide-sub', group.title));
    const dl = h('dl', 'guide-items');
    for (const item of group.items) {
      if (item.term) dl.append(h('dt', undefined, item.term));
      dl.append(h('dd', item.term ? undefined : 'solo', item.text));
    }
    sec.append(dl);
  }
  slot.replaceChildren(sec);
}

/** Lights the ranking row of the hand shown under my cards. */
function markMyHand(name: string | null | undefined): void {
  const key = rankingKey(name);
  for (const [k, row] of rankRows) {
    const mine = k === key;
    row.classList.toggle('mine', mine);
    if (mine) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}

/** The Table rules tab (what the (i) button showed before) and the rules text with this table's blinds. */
export function renderRules(s: TableState): void {
  const st = s.settings;
  const rows: [string, string][] = [
    ['Game', "No-Limit Texas Hold'em"],
    ['Blinds', `${fmt(st.smallBlind)} / ${fmt(st.bigBlind)}`],
    ['Minimum bet', fmt(st.bigBlind)],
    ['Antes', 'None'],
    ['Starting chips', fmt(st.startingChips)],
    ['Borrowing', st.allowBorrowing ? 'On' : 'Off'],
    ['Max players', String(st.maxPlayers)],
    ['Turn time', st.turnSeconds === null ? 'No limit' : `${st.turnSeconds} s`],
  ];
  $('rules-list').replaceChildren(
    ...rows.map(([k, v]) => {
      const row = h('div', 'rules-row');
      row.append(h('dt', undefined, k), h('dd', undefined, v));
      return row;
    }),
  );
  renderRulesText(s);
}

/** Follows the table: the hand name shown under my cards picks the highlighted ranking. */
export function renderGuide(s: TableState): void {
  markMyHand(s.you?.handName);
}

// -------------------------------------------------------------------- init

export function closePanels(): void {
  setLogOpen(false);
  setGuideOpen(false);
  setGuideTab('how');
}

/** Forgets what was read, e.g. after leaving the table. */
export function resetPanels(): void {
  closePanels();
  markMyHand(null);
  seenLogId = -1;
  latestLogId = -1;
  lastState = null;
}

export function initPanels(): void {
  buildGuide();
  $('log-btn').addEventListener('click', () => setLogOpen(!logOpen));
  $('log-close').addEventListener('click', () => {
    setLogOpen(false);
    $('log-btn').focus();
  });
  $('log-scrim').addEventListener('click', () => setLogOpen(false));
  $('rules-btn').addEventListener('click', () => setGuideOpen(!guideOpen));
  $('guide-close').addEventListener('click', () => {
    setGuideOpen(false);
    $('rules-btn').focus();
  });
  $('guide-tab-how').addEventListener('click', () => setGuideTab('how'));
  $('guide-tab-rules').addEventListener('click', () => setGuideTab('rules'));
  $('guide-drawer').addEventListener('keydown', (ev) => {
    if (!(ev.target instanceof Element) || !ev.target.closest('.guide-tabs')) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const next: GuideTab = guideTab === 'how' ? 'rules' : 'how';
    setGuideTab(next);
    $(next === 'how' ? 'guide-tab-how' : 'guide-tab-rules').focus();
  });
  window.addEventListener('resize', () => {
    if (guideOpen) fitGuide();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented) return;
    if (guideOpen) {
      setGuideOpen(false);
      $('rules-btn').focus();
    } else if (logOpen) {
      setLogOpen(false);
      $('log-btn').focus();
    }
  });
}
