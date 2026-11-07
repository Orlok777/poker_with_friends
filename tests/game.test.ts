import { describe, expect, it } from 'vitest';
import { Deck, fullDeck, mulberry32 } from '../server/deck.js';
import { HoldemHand, buildPots, type PlayerAction } from '../server/game.js';
import { cards, show } from './cards.js';

/**
 * A hand with the given stacks (players are named A, B, C... in seat order). `rigged` is dealt
 * first: hole cards one at a time starting left of the button, then the board.
 */
function hand(stacks: number[], opts: { button?: number; sb?: number; bb?: number; rigged?: string; seed?: number } = {}) {
  const deck = new Deck(mulberry32(opts.seed ?? 1), cards(opts.rigged ?? ''));
  return new HoldemHand({
    players: stacks.map((stack, i) => ({ id: String.fromCharCode(65 + i), stack })),
    button: opts.button ?? 0,
    smallBlind: opts.sb ?? 5,
    bigBlind: opts.bb ?? 10,
    draw: () => deck.draw(),
  });
}

const turnOf = (h: HoldemHand) => (h.toAct === null ? null : h.players[h.toAct]!.id);
const stack = (h: HoldemHand, id: string) => h.player(id)!.stack;

function act(h: HoldemHand, id: string, action: PlayerAction['action'], amount?: number) {
  const r = h.act(id, { action, amount });
  if (!r.ok) throw new Error(`${id} ${action} ${amount ?? ''}: ${r.message}`);
  return r;
}

/** Deals streets until the betting needs someone or the hand is over. */
function dealOn(h: HoldemHand) {
  while (h.status === 'street_over') h.dealNext();
}

describe('deck', () => {
  it('holds 52 different cards and deals rigged cards first', () => {
    const d = new Deck(mulberry32(3), cards('AS KH'));
    const all = Array.from({ length: 52 }, () => d.draw());
    expect(show(all.slice(0, 2))).toBe('AS KH');
    expect(new Set(all.map((c) => `${c.rank}${c.suit}`)).size).toBe(52);
    expect(() => d.draw()).toThrow();
    expect(fullDeck()).toHaveLength(52);
  });

  it('shuffles the same way for the same seed', () => {
    const a = new Deck(mulberry32(9));
    const b = new Deck(mulberry32(9));
    expect(show([a.draw(), a.draw(), a.draw()])).toBe(show([b.draw(), b.draw(), b.draw()]));
  });
});

describe('blinds and turn order', () => {
  it('posts the blinds left of the button and starts preflop left of the big blind', () => {
    const h = hand([1000, 1000, 1000, 1000], { button: 1 });
    expect(h.sbIndex).toBe(2);
    expect(h.bbIndex).toBe(3);
    expect(stack(h, 'C')).toBe(995);
    expect(stack(h, 'D')).toBe(990);
    expect(turnOf(h)).toBe('A');
    expect(h.players.every((p) => p.hole.length === 2)).toBe(true);
  });

  it('deals hole cards one at a time starting left of the button', () => {
    const h = hand([1000, 1000, 1000], { button: 0, rigged: '2S 3S 4S 5S 6S 7S' });
    expect(show(h.player('B')!.hole)).toBe('2S 5S');
    expect(show(h.player('C')!.hole)).toBe('3S 6S');
    expect(show(h.player('A')!.hole)).toBe('4S 7S');
  });

  it('heads-up: the button posts the small blind, acts first preflop and last after the flop', () => {
    const h = hand([1000, 1000], { button: 1 });
    expect(h.sbIndex).toBe(1);
    expect(h.bbIndex).toBe(0);
    expect(stack(h, 'B')).toBe(995);
    expect(stack(h, 'A')).toBe(990);
    expect(turnOf(h)).toBe('B');
    act(h, 'B', 'call');
    act(h, 'A', 'check');
    expect(h.status).toBe('street_over');
    h.dealNext();
    expect(h.board).toHaveLength(3);
    expect(turnOf(h)).toBe('A');
    act(h, 'A', 'check');
    expect(turnOf(h)).toBe('B');
  });

  it('starts each street after the flop with the first player still in left of the button', () => {
    const h = hand([1000, 1000, 1000, 1000], { button: 0 });
    act(h, 'D', 'call');
    act(h, 'A', 'call');
    act(h, 'B', 'fold');
    act(h, 'C', 'check');
    h.dealNext();
    expect(turnOf(h)).toBe('C'); // B, left of the button, folded
  });

  it('a short blind posts what it has and is all in', () => {
    const h = hand([1000, 3, 1000], { button: 0 });
    expect(h.player('B')!.allIn).toBe(true);
    expect(h.player('B')!.totalIn).toBe(3);
  });
});

describe('bets and raises', () => {
  it('needs a bet of at least the big blind', () => {
    const h = hand([1000, 1000], { button: 0 });
    act(h, 'A', 'call');
    act(h, 'B', 'check');
    h.dealNext();
    expect(h.act('B', { action: 'bet', amount: 9 })).toMatchObject({ ok: false, error: 'bad_amount' });
    expect(h.act('B', { action: 'bet', amount: 10.5 })).toMatchObject({ ok: false, error: 'bad_amount' });
    expect(h.act('B', { action: 'bet', amount: 1001 })).toMatchObject({ ok: false, error: 'bad_amount' });
    expect(h.act('B', { action: 'raise', amount: 20 })).toMatchObject({ ok: false, error: 'action_not_allowed' });
    expect(h.legal('B')).toMatchObject({ canCheck: true, canBet: true, canRaise: false, minTo: 10, maxTo: 990 });
    act(h, 'B', 'bet', 10);
    expect(h.player('B')!.lastAction).toBe('Bet 10');
  });

  it('needs a raise of at least the last full bet or raise', () => {
    const h = hand([1000, 1000, 1000], { button: 0 });
    // Preflop the big blind is the first bet: a raise goes to at least 20.
    expect(h.legal('A')).toMatchObject({ callAmount: 10, canRaise: true, minTo: 20 });
    expect(h.act('A', { action: 'raise', amount: 19 })).toMatchObject({ ok: false, error: 'bad_amount' });
    act(h, 'A', 'raise', 40); // a raise of 30
    expect(h.player('A')!.lastAction).toBe('Raise to 40');
    expect(h.legal('B')).toMatchObject({ callAmount: 35, minTo: 70 });
    expect(h.act('B', { action: 'raise', amount: 69 })).toMatchObject({ ok: false, error: 'bad_amount' });
    act(h, 'B', 'raise', 70);
    expect(h.legal('C')!.minTo).toBe(100);
  });

  it('rejects a check when there is a bet, and a call when there is none', () => {
    const h = hand([1000, 1000], { button: 0 });
    expect(h.act('A', { action: 'check' })).toMatchObject({ ok: false, error: 'action_not_allowed' });
    expect(h.act('B', { action: 'call' })).toMatchObject({ ok: false, error: 'not_your_turn' });
    act(h, 'A', 'call');
    expect(h.act('B', { action: 'call' })).toMatchObject({ ok: false, error: 'action_not_allowed' });
  });

  it('lets a player with fewer chips than a call go all in for less', () => {
    const h = hand([1000, 1000, 30], { button: 2 });
    act(h, 'C', 'call'); // C is first to act preflop
    act(h, 'A', 'raise', 100);
    act(h, 'B', 'call');
    expect(h.legal('C')).toMatchObject({ callAmount: 20, canRaise: false, canAllIn: true });
    act(h, 'C', 'call');
    expect(h.player('C')!.allIn).toBe(true);
    expect(h.player('C')!.lastAction).toBe('All in');
  });

  it('a short all-in raise does not reopen the betting for players who already acted', () => {
    const h = hand([1000, 1000, 1000, 150], { button: 0 });
    act(h, 'D', 'call');
    act(h, 'A', 'call');
    act(h, 'B', 'call');
    act(h, 'C', 'check');
    h.dealNext();
    act(h, 'B', 'bet', 100);
    act(h, 'C', 'call');
    act(h, 'D', 'all_in'); // 140: a raise of 40, less than the 100 bet
    expect(h.currentBet).toBe(140);
    // A has not acted since the bet, so A may raise; the minimum is 140 + 100.
    expect(h.legal('A')).toMatchObject({ canRaise: true, minTo: 240 });
    act(h, 'A', 'call');
    // B and C already acted and face only the short all in: call or fold.
    expect(h.legal('B')).toMatchObject({ canRaise: false, canAllIn: false, callAmount: 40 });
    expect(h.act('B', { action: 'raise', amount: 300 })).toMatchObject({ ok: false, error: 'action_not_allowed' });
    expect(h.act('B', { action: 'all_in' })).toMatchObject({ ok: false, error: 'action_not_allowed' });
    act(h, 'B', 'call');
    act(h, 'C', 'fold');
    expect(h.status).toBe('street_over');
  });

  it('a full all-in raise reopens the betting', () => {
    const h = hand([1000, 1000, 1000, 300], { button: 0 });
    act(h, 'D', 'call');
    act(h, 'A', 'call');
    act(h, 'B', 'call');
    act(h, 'C', 'check');
    h.dealNext();
    act(h, 'B', 'bet', 100);
    act(h, 'C', 'call');
    act(h, 'D', 'all_in'); // 290: a full raise of 190
    act(h, 'A', 'fold');
    expect(h.legal('B')).toMatchObject({ canRaise: true, minTo: 480 });
  });

  it('gives the big blind the option when everyone just called', () => {
    const h = hand([1000, 1000, 1000], { button: 0 });
    act(h, 'A', 'call');
    act(h, 'B', 'call');
    expect(turnOf(h)).toBe('C');
    expect(h.legal('C')).toMatchObject({ canCheck: true, canRaise: true, minTo: 20 });
    act(h, 'C', 'raise', 30);
    expect(turnOf(h)).toBe('A');
    act(h, 'A', 'call');
    act(h, 'B', 'call');
    expect(h.status).toBe('street_over');
  });

  it('accepts all in as a bet, a raise or a call', () => {
    const h = hand([500, 1000, 1000], { button: 0 });
    act(h, 'A', 'all_in');
    expect(h.player('A')!.lastAction).toBe('All in');
    expect(h.currentBet).toBe(500);
    act(h, 'B', 'fold');
    act(h, 'C', 'call');
    expect(h.status).toBe('street_over');
    expect(h.isRunout()).toBe(true);
  });
});

describe('uncalled bets and fold wins', () => {
  it('returns an uncalled bet and gives the pot to the last player in, without a showdown', () => {
    const h = hand([1000, 1000], { button: 0 });
    act(h, 'A', 'raise', 100);
    const r = act(h, 'B', 'fold');
    expect(r.uncalled).toEqual({ id: 'A', amount: 90 });
    expect(h.status).toBe('fold_win');
    const out = h.finish();
    expect(out.showdown).toBe(false);
    expect(out.pots).toEqual([{ amount: 20, winners: ['A'], shares: { A: 20 }, handName: null, cards: [] }]);
    expect(out.net).toEqual({ A: 10, B: -10 });
    expect(stack(h, 'A')).toBe(1010);
    expect(stack(h, 'B')).toBe(990);
  });

  it('returns the part of an all in that nobody could call', () => {
    const h = hand([1000, 300], { button: 0 });
    act(h, 'A', 'all_in');
    const r = act(h, 'B', 'call');
    expect(r.uncalled).toEqual({ id: 'A', amount: 700 });
    expect(stack(h, 'A')).toBe(700);
    expect(h.player('A')!.allIn).toBe(false);
    expect(h.pots()).toEqual([{ amount: 600, eligible: ['A', 'B'] }]);
  });

  it('folds a player who leaves out of turn, and ends the hand if one player is left', () => {
    const h = hand([1000, 1000, 1000], { button: 0 });
    expect(h.forceFold('C').ok).toBe(true);
    expect(turnOf(h)).toBe('A');
    act(h, 'A', 'raise', 50);
    const r = h.forceFold('B');
    expect(r.ok).toBe(true);
    expect(h.status).toBe('fold_win');
    expect(r.uncalled).toEqual({ id: 'A', amount: 40 });
    const out = h.finish();
    expect(out.net).toEqual({ A: 15, B: -5, C: -10 });
  });
});

describe('showdown and pots', () => {
  it('splits a pot with an odd chip, which goes to the winner closest to the left of the button', () => {
    // Button A, small blind B, big blind C. Holes: B C A B C A, then the board.
    const h = hand([1000, 1000, 1000], { button: 0, rigged: '2H 3H 4H 2D 3D 4D AS KS QS JS 10S' });
    act(h, 'A', 'call');
    act(h, 'B', 'fold'); // leaves 5 in the pot
    act(h, 'C', 'check');
    dealOn(h);
    while (h.status === 'betting') {
      act(h, turnOf(h)!, 'check');
      dealOn(h);
    }
    expect(h.status).toBe('showdown');
    const out = h.finish();
    expect(out.pots).toHaveLength(1);
    const pot = out.pots[0]!;
    expect(pot.amount).toBe(25);
    expect(pot.winners).toEqual(['C', 'A']); // C is closer to the left of the button
    expect(pot.shares).toEqual({ C: 13, A: 12 });
    expect(pot.handName).toBe('Royal flush');
    expect(show(pot.cards)).toBe('AS KS QS JS 10S');
    expect(stack(h, 'A') + stack(h, 'B') + stack(h, 'C')).toBe(3000);
  });

  it('makes side pots when three players are all in for different amounts', () => {
    // Button A. Holes go B C D A, B C D A: B has kings, C queens, D jacks and A only ten high.
    const h = hand([1000, 100, 200, 300], {
      button: 0,
      rigged: 'KD QD JD 9H KC QC JC 10S 2S 7H 8D 3C 4C',
    });
    act(h, 'D', 'all_in'); // 300
    act(h, 'A', 'call'); // 300, and A still has chips behind
    act(h, 'B', 'all_in'); // 100
    act(h, 'C', 'all_in'); // 200
    expect(h.status).toBe('street_over');
    expect(h.isRunout()).toBe(true);
    expect(h.pots()).toEqual([
      { amount: 400, eligible: ['A', 'B', 'C', 'D'] },
      { amount: 300, eligible: ['A', 'C', 'D'] },
      { amount: 200, eligible: ['A', 'D'] },
    ]);
    dealOn(h);
    expect(h.status).toBe('showdown');
    expect(h.board).toHaveLength(5);
    const out = h.finish();
    expect(out.pots.map((p) => [p.amount, p.winners.join()])).toEqual([
      [400, 'B'],
      [300, 'C'],
      [200, 'D'],
    ]);
    expect(out.net).toEqual({ A: -300, B: 300, C: 100, D: -100 });
    expect(h.players.reduce((s, p) => s + p.stack, 0)).toBe(1600);
  });

  it('keeps folded chips in the pots without letting the folded player win', () => {
    const pots = buildPots([
      { id: 'A', amount: 50, folded: true },
      { id: 'B', amount: 100, folded: false },
      { id: 'C', amount: 300, folded: false },
      { id: 'D', amount: 300, folded: false },
    ]);
    expect(pots).toEqual([
      { amount: 350, eligible: ['B', 'C', 'D'] },
      { amount: 400, eligible: ['C', 'D'] },
    ]);
  });

  it('runs out the board without betting when everyone is all in', () => {
    const h = hand([500, 500], { button: 0 });
    act(h, 'A', 'all_in');
    act(h, 'B', 'call');
    expect(h.status).toBe('street_over');
    expect(h.isRunout()).toBe(true);
    h.dealNext();
    expect(h.street).toBe('flop');
    expect(h.status).toBe('street_over');
    expect(h.toAct).toBeNull();
    h.dealNext();
    h.dealNext();
    expect(h.street).toBe('river');
    expect(h.status).toBe('showdown');
    const out = h.finish();
    expect(out.showdown).toBe(true);
    expect(Object.keys(out.hands).sort()).toEqual(['A', 'B']);
    expect(stack(h, 'A') + stack(h, 'B')).toBe(1000);
  });

  it('runs out the board when one player with chips covers an all in', () => {
    const h = hand([1000, 1000, 200], { button: 0 });
    act(h, 'A', 'fold');
    act(h, 'B', 'call');
    act(h, 'C', 'check');
    h.dealNext();
    act(h, 'B', 'bet', 50);
    act(h, 'C', 'all_in'); // 190
    act(h, 'B', 'call');
    expect(h.isRunout()).toBe(true);
    dealOn(h);
    expect(h.status).toBe('showdown');
  });
});

describe('chip conservation', () => {
  it('keeps the total of the chips the same across many random hands', () => {
    const rng = mulberry32(12345);
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const stacks = new Map(ids.map((id) => [id, 1000]));
    let borrowed = 0;
    let button = 0;
    let showdowns = 0;
    let sidePots = 0;
    for (let n = 0; n < 2000; n++) {
      // A player who is out of chips borrows a buy-in now and then, the way the table allows.
      for (const id of ids) {
        if (stacks.get(id) === 0 && rng() < 0.5) {
          stacks.set(id, 1000);
          borrowed += 1000;
        }
      }
      const seated = ids.filter((id) => stacks.get(id)! > 0);
      if (seated.length < 2) continue;
      button = (button + 1) % seated.length;
      const deck = new Deck(mulberry32(Math.floor(rng() * 2 ** 32)));
      const h = new HoldemHand({
        players: seated.map((id) => ({ id, stack: stacks.get(id)! })),
        button,
        smallBlind: 5,
        bigBlind: 10,
        draw: () => deck.draw(),
      });
      const before = seated.reduce((s, id) => s + stacks.get(id)!, 0);
      while (h.status === 'betting' || h.status === 'street_over') {
        if (h.status === 'street_over') {
          h.dealNext();
          continue;
        }
        const id = h.players[h.toAct!]!.id;
        const l = h.legal(id)!;
        const r = rng();
        let a: PlayerAction;
        if (r < 0.1) a = { action: 'fold' };
        else if (r < 0.15 && l.canAllIn) a = { action: 'all_in' };
        else if (r < 0.35 && (l.canBet || l.canRaise)) {
          a = { action: l.canBet ? 'bet' : 'raise', amount: l.minTo + Math.floor(rng() * (l.maxTo - l.minTo + 1) * 0.3) };
        } else a = { action: l.canCheck ? 'check' : 'call' };
        const res = h.act(id, a);
        expect(res.ok).toBe(true);
        // Chips in the stacks plus chips put in never change during the hand.
        expect(h.players.reduce((s, p) => s + p.stack + p.totalIn, 0)).toBe(before);
      }
      if (h.pots().length > 1) sidePots++;
      const out = h.finish();
      if (out.showdown) showdowns++;
      expect(Object.values(out.net).reduce((s, x) => s + x, 0)).toBe(0);
      for (const p of h.players) {
        expect(p.stack).toBeGreaterThanOrEqual(0);
        stacks.set(p.id, p.stack);
      }
      const total = [...stacks.values()].reduce((s, x) => s + x, 0);
      expect(total).toBe(ids.length * 1000 + borrowed);
    }
    // The random play covers the interesting cases.
    expect(showdowns).toBeGreaterThan(100);
    expect(sidePots).toBeGreaterThan(10);
  });
});
