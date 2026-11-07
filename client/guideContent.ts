// What the "How to play" drawer says: the hand rankings with an example each, and the short rules.
// No DOM in here, so tests can check it. Hand names come from the evaluator the server uses
// (server/hand.ts, which has no networking code), so the drawer can never print a name the game doesn't.

import { bestHand } from '../server/hand.js';
import type { Card, Rank, Settings, Suit } from '../shared/types.js';

export type RankingKey =
  | 'royalFlush'
  | 'straightFlush'
  | 'four'
  | 'fullHouse'
  | 'flush'
  | 'straight'
  | 'three'
  | 'twoPair'
  | 'pair'
  | 'highCard';

export interface RankingRow {
  key: RankingKey;
  /** The name exactly as the game prints it for the example hand. */
  name: string;
  /** One plain sentence. */
  explain: string;
  /** Five cards that make exactly this hand. */
  example: Card[];
}

/** "AS KH 10D": rank then suit letter (S, H, D, C). */
function parse(text: string): Card[] {
  return text.split(/\s+/).map((token) => ({ rank: token.slice(0, -1) as Rank, suit: token.slice(-1) as Suit }));
}

const DEFS: { key: RankingKey; explain: string; cards: string }[] = [
  { key: 'royalFlush', explain: '10, J, Q, K, A, all of one suit. The best hand there is.', cards: '10H JH QH KH AH' },
  { key: 'straightFlush', explain: 'Five cards in a row, all of one suit.', cards: '5S 6S 7S 8S 9S' },
  { key: 'four', explain: 'Four cards of the same rank.', cards: '9S 9H 9D 9C KS' },
  { key: 'fullHouse', explain: 'Three cards of one rank and two cards of another.', cards: 'KS KH KD 7C 7H' },
  { key: 'flush', explain: 'Any five cards of the same suit.', cards: 'AH JH 8H 5H 2H' },
  { key: 'straight', explain: 'Five cards in a row, in any suits.', cards: '6C 7D 8H 9S 10C' },
  { key: 'three', explain: 'Three cards of the same rank.', cards: '7S 7H 7D KC 2S' },
  { key: 'twoPair', explain: 'Two different pairs.', cards: 'AS AD 7C 7H 3S' },
  { key: 'pair', explain: 'Two cards of the same rank.', cards: 'KS KD 9C 5H 2S' },
  { key: 'highCard', explain: 'None of the above: your highest card plays.', cards: 'AS JD 8C 5H 3S' },
];

/** Best to worst. */
export const RANKINGS: RankingRow[] = DEFS.map((d) => {
  const example = parse(d.cards);
  return { key: d.key, name: bestHand(example).name, explain: d.explain, example };
});

/** Short notes under the list. */
export const RANKING_NOTES: string[] = [
  'You make the best 5 cards from your 2 cards and the 5 on the board. You can use both of yours, one or none.',
  'The ace counts high or low: A-2-3-4-5 is a straight, but Q-K-A-2-3 is not.',
  'When two hands are the same type, the higher cards win, then the kickers (the cards left over).',
  'Suits never break a tie. Equal hands split the pot.',
];

/** Which ranking row a hand name from the game belongs to, or null for a name this list doesn't know. */
export function rankingKey(handName: string | null | undefined): RankingKey | null {
  if (!handName) return null;
  if (handName === 'Royal flush') return 'royalFlush';
  if (handName.startsWith('Straight flush')) return 'straightFlush';
  if (handName.startsWith('Four ')) return 'four';
  if (handName.startsWith('Full house')) return 'fullHouse';
  if (handName.startsWith('Flush')) return 'flush';
  if (handName.startsWith('Straight')) return 'straight';
  if (handName.startsWith('Three ')) return 'three';
  if (handName.startsWith('Two pair')) return 'twoPair';
  if (handName.startsWith('Pair of')) return 'pair';
  if (handName.startsWith('High card')) return 'highCard';
  return null;
}

// ------------------------------------------------------------------- rules

export interface RulesItem {
  /** A short lead-in in bold, or empty. */
  term: string;
  text: string;
}

export interface RulesGroup {
  title: string;
  items: RulesItem[];
}

const n = (value: number): string => value.toLocaleString('en-US');

/** The rules in plain language, with this table's amounts. Based on docs/SPEC.md. */
export function rulesGroups(settings: Pick<Settings, 'smallBlind' | 'bigBlind'>): RulesGroup[] {
  const sb = n(settings.smallBlind);
  const bb = n(settings.bigBlind);
  return [
    {
      title: 'Blinds',
      items: [
        {
          term: '',
          text: `Before the cards are dealt, two players put in forced bets: the small blind (${sb}) and the big blind (${bb}). The blinds move one seat to the left every hand. There are no antes.`,
        },
      ],
    },
    {
      title: 'The four betting rounds',
      items: [
        { term: 'Preflop', text: 'Everyone gets 2 private cards, then the first round of betting.' },
        { term: 'Flop', text: '3 cards are turned up in the middle, then betting.' },
        { term: 'Turn', text: '1 more card, then betting.' },
        { term: 'River', text: 'The last card, then the final betting.' },
      ],
    },
    {
      title: 'Your choices',
      items: [
        { term: 'Fold', text: 'Give up the hand. The chips you already put in stay in the pot.' },
        { term: 'Check', text: 'Pass without betting. Only possible when there is nothing to call.' },
        { term: 'Call', text: 'Put in enough chips to match the highest bet.' },
        { term: 'Bet', text: 'Be the first to put chips in this round.' },
        {
          term: 'Raise',
          text: 'Make the bet bigger. "Raise to 60" means 60 in total in front of you this round, not 60 extra chips.',
        },
      ],
    },
    {
      title: 'How much',
      items: [
        { term: 'Minimum bet', text: `${bb}, the big blind.` },
        {
          term: 'Minimum raise',
          text: 'At least as big as the last bet or raise in this round. Before the flop, the big blind counts as the first bet.',
        },
        { term: 'Most you can bet', text: 'All your chips.' },
      ],
    },
    {
      title: 'All in and side pots',
      items: [
        {
          term: 'All in',
          text: 'Put in all your chips. If you can’t cover a bet, you can still go all in for less.',
        },
        {
          term: 'Side pots',
          text: 'When players are all in for different amounts, the chips are split into a main pot and side pots. You can only win the pots you put chips into.',
        },
      ],
    },
    {
      title: 'Showdown',
      items: [
        {
          term: '',
          text: 'After the last betting round, every hand still in is turned face up automatically and the best hand wins the pot. If everyone else folds, the last player wins at once and their cards stay hidden.',
        },
      ],
    },
    {
      title: 'Controls',
      items: [
        {
          term: '',
          text: `Use the buttons under the table: Fold, Check or Call, and Bet or Raise to. Set the amount with the slider or the − and + buttons (they move by the small blind, ${sb}). There are no keyboard shortcuts.`,
        },
      ],
    },
  ];
}
