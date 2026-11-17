import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Card, ServerMsg, TableState } from '../shared/types.js';
import { isHiddenCard } from '../shared/types.js';
import { mulberry32 } from '../server/deck.js';
import type { ServerOptions } from '../server/index.js';
import { cards, createHarness, netOf, passive, sleep, waitUntil, type Policy, type TestClient } from './helpers.js';

const h = createHarness();

afterEach(async () => {
  const logs = h.logs.splice(0);
  await h.cleanup();
  // Nothing may be logged as an error or warning during a normal test.
  expect(logs).toEqual([]);
});

/** Boots a server with a host (Alex) and guests, all joined and ready, game not started. */
async function players(names: string[], options: Partial<ServerOptions> = {}) {
  const { srv, dataDir } = await h.boot(options);
  const clients: TestClient[] = [];
  for (const [i, name] of names.entries()) {
    const c = await h.client(srv);
    expect((await c.join(name, i === 0 ? { hostToken: srv.hostToken } : {})).type).toBe('joined');
    c.send({ type: 'set_ready', ready: true });
    clients.push(c);
  }
  await clients[0]!.waitForState((s) => s.players.length === names.length && s.players.every((p) => p.ready));
  return { srv, dataDir, clients };
}

async function twoPlayers(options: Partial<ServerOptions> = {}) {
  const { srv, dataDir, clients } = await players(['Alex', 'Bob'], options);
  return { srv, dataDir, alex: clients[0]!, bob: clients[1]! };
}

/**
 * A heads-up deal: the player left of the button (the big blind) gets the first and third card,
 * the button the second and fourth, then the board.
 */
function headsUp(bigBlind: string, button: string, board: string): Card[] {
  const [b1, b2] = cards(bigBlind);
  const [d1, d2] = cards(button);
  return [b1!, d1!, b2!, d2!, ...cards(board)];
}

/** The client sitting in a seat. */
function inSeat(clients: TestClient[], s: TableState, seat: number | null): TestClient {
  const id = seat === null ? null : s.seats[seat];
  const c = clients.find((x) => x.id === id);
  if (!c) throw new Error(`Nobody in seat ${seat}`);
  return c;
}

const allMessages = (...clients: TestClient[]): ServerMsg[] => clients.flatMap((c) => c.all);
const json = (card: Card) => JSON.stringify({ rank: card.rank, suit: card.suit });
const states = (c: TestClient) => c.all.filter((m): m is TableState => m.type === 'table_state');

/**
 * No state ever holds another player's hole cards before they are shown, or a board card before it is dealt.
 * Every player is a test client, so their real cards are known from their own `you` block.
 */
function checkPrivacy(clients: TestClient[]): void {
  const holes = new Map<string, Card[]>(); // "hand:playerId" -> cards
  const boards = new Map<number, Card[]>();
  for (const c of clients) {
    for (const s of states(c)) {
      if (s.you && s.you.cards.length === 2) holes.set(`${s.hand}:${c.id}`, s.you.cards);
      if (s.board.length > (boards.get(s.hand)?.length ?? 0)) boards.set(s.hand, s.board);
    }
  }
  expect(holes.size).toBeGreaterThan(0);
  for (const c of clients) {
    for (const s of states(c)) {
      if (s.phase === 'waiting') continue;
      const text = JSON.stringify(s);
      for (const p of s.players) {
        if (p.id === c.id || p.handName !== null) continue; // own cards, or shown
        expect(p.cards.every((x) => isHiddenCard(x))).toBe(true);
        for (const card of holes.get(`${s.hand}:${p.id}`) ?? []) {
          expect(text.includes(json(card)), `${c.me(s).name} saw a hole card of ${p.name}`).toBe(false);
        }
      }
      for (const card of (boards.get(s.hand) ?? []).slice(s.board.length)) {
        expect(text.includes(json(card)), 'a board card was sent before it was dealt').toBe(false);
      }
    }
  }
}

describe('playing hands', () => {
  it('3 clients play 5 hands without errors, keeping hole cards and the deck private', async () => {
    const { srv, clients } = await players(['Alex', 'Bob', 'Cy']);
    const rng = mulberry32(5);
    // Mostly calls and checks, with some folds and minimum raises.
    const mixed: Policy = (l) => {
      const r = rng();
      if (r < 0.1 && !l.canCheck) return { action: 'fold' };
      if (r < 0.3 && (l.canBet || l.canRaise)) return { action: l.canBet ? 'bet' : 'raise', amount: l.minTo };
      return passive(l, null as never);
    };
    for (const c of clients) c.autoPlay(mixed);
    const overs = clients[0]!.collectHandOvers();
    clients[0]!.send({ type: 'start_game' });

    await waitUntil(() => overs.has(5), 15000, 'hand 5');
    for (const c of clients) expect(c.errors).toEqual([]);

    // Chips are only moved around, never made or lost.
    for (let hand = 1; hand <= 5; hand++) {
      const s = overs.get(hand)!;
      expect(s.players.reduce((sum, p) => sum + p.chips, 0), `chips after hand ${hand}`).toBe(3000);
      expect(s.pots).toEqual([]);
    }
    // The button moves one seat to the left every hand, with the blinds after it.
    const starts = new Map<number, TableState>();
    for (const s of states(clients[0]!)) if (s.phase === 'preflop' && !starts.has(s.hand)) starts.set(s.hand, s);
    for (let hand = 1; hand <= 5; hand++) {
      const s = starts.get(hand)!;
      expect(s.smallBlindSeat).toBe((s.buttonSeat! + 1) % 3);
      expect(s.bigBlindSeat).toBe((s.buttonSeat! + 2) % 3);
      if (hand > 1) expect(s.buttonSeat).toBe((starts.get(hand - 1)!.buttonSeat! + 1) % 3);
    }

    checkPrivacy(clients);
    expect(JSON.stringify(allMessages(...clients)).includes(srv.hostToken)).toBe(false);
  });

  it('two players play 10 full hands with exact chips after each, and the button and blinds alternate', async () => {
    const { alex, bob } = await twoPlayers();
    alex.autoPlay(passive);
    bob.autoPlay(passive);
    const overs = alex.collectHandOvers();
    alex.send({ type: 'start_game' });
    await waitUntil(() => overs.has(10), 20000, 'hand 10');

    const chips = new Map([[alex.id, 1000], [bob.id, 1000]]);
    const results = alex.results();
    let lastButton: number | null = null;
    for (let hand = 1; hand <= 10; hand++) {
      const r = results.find((x) => x.hand === hand)!;
      expect(r.showdown).toBe(true); // nobody ever folds
      expect(r.players.reduce((sum, p) => sum + p.net, 0)).toBe(0);
      const s = overs.get(hand)!;
      for (const c of [alex, bob]) {
        chips.set(c.id, chips.get(c.id)! + netOf(r, c.id));
        expect(c.me(s).chips, `${c.me(s).name} after hand ${hand}`).toBe(chips.get(c.id));
      }
      // Heads-up: the button posts the small blind.
      expect(s.smallBlindSeat).toBe(s.buttonSeat);
      expect(s.bigBlindSeat).toBe(1 - s.buttonSeat!);
      if (lastButton !== null) expect(s.buttonSeat).toBe(1 - lastButton);
      lastButton = s.buttonSeat;
    }
    expect(alex.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it('shows the hands at showdown, names them and pays the better hand', async () => {
    const rigged = [headsUp('AS AH', '2D 7C', '9H 9S KD 4C 3H')];
    const { alex, bob } = await twoPlayers({ rigged });
    alex.autoPlay(passive);
    bob.autoPlay(passive);
    alex.send({ type: 'start_game' });
    const over = await alex.waitForState((s) => s.phase === 'hand_over', 6000);
    const clients = [alex, bob];
    const winner = inSeat(clients, over, over.bigBlindSeat);
    const loser = inSeat(clients, over, over.buttonSeat);

    const r = alex.results()[0]!;
    expect(r.pots).toEqual([
      {
        amount: 20,
        winners: [winner.id],
        handName: 'Two pair, aces and nines',
        cards: cards('AS AH 9H 9S KD'),
        // Each winner's own best five, so the table can light them in the winner's seat.
        hands: [{ playerId: winner.id, handName: 'Two pair, aces and nines', cards: cards('AS AH 9H 9S KD') }],
        // What each winner gets, for the winner panel of a split pot.
        shares: { [winner.id]: 20 },
      },
    ]);
    // Every hand that reached showdown, for the spotlight: the winner's and the loser's.
    expect(r.shown.map((h) => h.playerId).sort()).toEqual([winner.id, loser.id].sort());
    expect(r.shown.find((h) => h.playerId === loser.id)?.handName).toBe('Pair of nines');
    expect(netOf(r, winner.id)).toBe(10);
    expect(netOf(r, loser.id)).toBe(-10);
    expect(winner.me(over).chips).toBe(1010);
    // Both hands are face up for everyone, with their names.
    for (const c of clients) {
      const seen = c.state!;
      expect(winner.me(seen).cards).toEqual(cards('AS AH'));
      expect(loser.me(seen).handName).toBe('Pair of nines');
    }
    const log = over.log.map((e) => e.text);
    expect(log).toContain(`${winner.me(over).name} shows two pair, aces and nines`);
    expect(log).toContain(`${winner.me(over).name} wins 20 with two pair, aces and nines`);
    expect(log).toContain('Flop: 9♥ 9♠ K♦');
    checkPrivacy(clients);
  });

  it('gives the pot at once when everyone else folds, returns the uncalled bet and keeps the cards hidden', async () => {
    const { alex, bob } = await twoPlayers();
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    const clients = [alex, bob];
    const button = inSeat(clients, s, s.buttonSeat); // the small blind acts first heads-up
    const other = clients.find((c) => c !== button)!;
    await button.waitForTurn();
    button.send({ type: 'action', action: 'raise', amount: 100 });
    await other.waitForTurn();
    other.send({ type: 'action', action: 'fold' });
    const over = await alex.waitForState((st) => st.phase === 'hand_over');
    expect(over.result).toMatchObject({ showdown: false, pots: [{ amount: 20, winners: [button.id], handName: null, cards: [], hands: [] }] });
    expect(button.me(over).chips).toBe(1010);
    expect(other.me(over).chips).toBe(990);
    const log = over.log.map((e) => e.text);
    expect(log).toContain(`90 uncalled goes back to ${button.me(over).name}`);
    expect(log).toContain(`${button.me(over).name} wins 20`);
    // Nobody's cards were shown.
    expect(over.players.every((p) => p.handName === null)).toBe(true);
    checkPrivacy(clients);
  });

  it('turns the hands face up and runs out the board when everyone is all in', async () => {
    const rigged = [headsUp('KS KH', 'QS QH', '2C 7D 9C JD 3S')];
    const { alex, bob } = await twoPlayers({ rigged, timing: { runoutMs: 40 } });
    alex.autoPlay((l) => (l.canAllIn ? { action: 'all_in' } : passive(l, null as never)));
    bob.autoPlay((l) => (l.canAllIn ? { action: 'all_in' } : passive(l, null as never)));
    alex.send({ type: 'start_game' });
    const over = await alex.waitForState((s) => s.phase === 'hand_over', 6000);
    // Before the river, both hands were already face up for the other player.
    const early = states(alex).find((s) => s.hand === 1 && s.board.length < 5 && s.players.every((p) => p.handName !== null));
    expect(early).toBeDefined();
    const winner = inSeat([alex, bob], over, over.bigBlindSeat);
    expect(winner.me(over).chips).toBe(2000);
    expect(over.players.reduce((sum, p) => sum + p.chips, 0)).toBe(2000);
  });
});

describe('host and settings', () => {
  it("shows the host's setting changes to the other player and locks them after Start", async () => {
    const { alex, bob } = await twoPlayers();
    alex.send({
      type: 'update_settings',
      settings: { smallBlind: 10, bigBlind: 20, maxPlayers: 9, password: 'secret', turnSeconds: null },
    });
    const s = await bob.waitForState((st) => st.settings.bigBlind === 20);
    expect(s.settings).toMatchObject({ smallBlind: 10, bigBlind: 20, maxPlayers: 9, passwordSet: true, turnSeconds: null });
    // The password itself is never sent.
    expect(JSON.stringify(allMessages(alex, bob)).includes('secret')).toBe(false);
    expect(alex.me(s).id).toBe(s.hostId);

    alex.send({ type: 'start_game' });
    const started = await bob.waitForState((st) => st.started && st.phase === 'preflop');
    expect(started.players.reduce((sum, p) => sum + p.bet, 0)).toBe(30); // blinds 10 and 20
    const err = await alex.expectError({ type: 'update_settings', settings: { bigBlind: 50 } });
    expect(err.code).toBe('settings_locked');
    expect(bob.state!.settings.bigBlind).toBe(20);
  });

  it('rejects invalid settings and settings changes from a non-host', async () => {
    const { alex, bob } = await twoPlayers();
    expect((await bob.expectError({ type: 'update_settings', settings: { bigBlind: 20 } })).code).toBe('not_host');
    const bad: Record<string, unknown>[] = [
      { bigBlind: 101 }, // more than a tenth of 1,000
      { smallBlind: 20 }, // more than the big blind
      { smallBlind: 0 },
      { bigBlind: 'ten' },
      { maxPlayers: 1 },
      { maxPlayers: 10 },
      { startingChips: 99 },
      { turnSeconds: 5 },
      { allowBorrowing: 'yes' },
      { allowBorrowing: null },
    ];
    for (const settings of bad) {
      expect((await alex.expectError({ type: 'update_settings', settings: settings as never })).code).toBe('invalid_settings');
    }
    expect((await bob.expectError({ type: 'start_game' })).code).toBe('not_host');
    expect(alex.state!.settings).toMatchObject({ smallBlind: 5, bigBlind: 10, maxPlayers: 6, startingChips: 1000 });
    expect(alex.state!.started).toBe(false);
  });

  it('allows borrowing by default, lets the host switch it off, and locks it at the start', async () => {
    const { alex } = await twoPlayers();
    expect(alex.state!.settings.allowBorrowing).toBe(true);
    alex.send({ type: 'update_settings', settings: { allowBorrowing: false } });
    await alex.waitForState((s) => s.settings.allowBorrowing === false);
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.started);
    expect((await alex.expectError({ type: 'update_settings', settings: { allowBorrowing: true } })).code).toBe('settings_locked');
    expect(alex.state!.settings.allowBorrowing).toBe(false);
  });

  it('refuses borrowing when it is switched off', async () => {
    const { alex } = await twoPlayers();
    alex.send({ type: 'update_settings', settings: { allowBorrowing: false } });
    await alex.waitForState((s) => s.settings.allowBorrowing === false);
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.started);
    expect((await alex.expectError({ type: 'borrow' })).code).toBe('borrowing_off');
  });

  it('needs two ready players before the host can start', async () => {
    const { srv } = await h.boot();
    const alex = await h.client(srv);
    const bob = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    await bob.join('Bob');
    expect((await alex.expectError({ type: 'start_game' })).code).toBe('cannot_start');
    alex.send({ type: 'set_ready', ready: true });
    await alex.waitForState((s) => alex.me(s).ready);
    expect((await alex.expectError({ type: 'start_game' })).code).toBe('cannot_start');
    bob.send({ type: 'set_ready', ready: true });
    await alex.waitForState((s) => bob.me(s).ready);
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.started);
    expect(['waiting', 'preflop']).toContain(s.phase);
    await alex.waitForState((st) => st.phase === 'preflop');
  });

  it('gives host controls only to a client with the host token, and restores them when it comes back', async () => {
    const { srv } = await h.boot({ timing: { holdMs: 150 } });
    const host = await h.client(srv);
    const guest = await h.client(srv);
    const fake = await h.client(srv);
    expect(((await host.join('Alex', { hostToken: srv.hostToken })) as { isHost: boolean }).isHost).toBe(true);
    expect(((await guest.join('Bob')) as { isHost: boolean }).isHost).toBe(false);
    expect(((await fake.join('Cy', { hostToken: 'not-the-token' })) as { isHost: boolean }).isHost).toBe(false);

    // The host's tab closes. The table keeps going and the host link brings the controls back.
    host.close();
    await guest.waitForState((s) => !s.players.some((p) => p.name === 'Alex'), 3000);
    const again = await h.client(srv);
    const reply = await again.join('Alex', { hostToken: srv.hostToken });
    expect((reply as { isHost: boolean }).isHost).toBe(true);
    again.send({ type: 'update_settings', settings: { bigBlind: 20 } });
    await guest.waitForState((s) => s.settings.bigBlind === 20);
  });
});

describe('joining and kicking', () => {
  it('rejects bad usernames, a wrong password and a name already at the table', async () => {
    const { srv, alex } = await twoPlayers();
    alex.send({ type: 'update_settings', settings: { password: 'pw' } });
    await alex.waitForState((s) => s.settings.passwordSet);

    const c = await h.client(srv);
    for (const bad of ['', '   ', 'x'.repeat(17), 'bad!name', 'semi;colon']) {
      const reply = await c.join(bad, { password: 'pw' });
      expect(reply).toMatchObject({ type: 'error', code: 'bad_username' });
    }
    expect(await c.join('Cy')).toMatchObject({ type: 'error', code: 'wrong_password' });
    expect(await c.join('Cy', { password: 'nope' })).toMatchObject({ type: 'error', code: 'wrong_password' });
    // Names match ignoring case.
    expect(await c.join('BOB', { password: 'pw' })).toMatchObject({ type: 'error', code: 'name_in_use', message: 'That name is in use' });
    expect(await c.join('alex', { password: 'pw', reconnectToken: 'guess' })).toMatchObject({ type: 'error', code: 'name_in_use' });
    expect((await c.join('Cy', { password: 'pw' })).type).toBe('joined');
    const s = await alex.waitForState((st) => st.players.length === 3);
    expect(s.players.map((p) => p.name)).toEqual(['Alex', 'Bob', 'Cy']);
  });

  it('lets a player come back to the same name only with their reconnect token', async () => {
    const { srv, bob } = await twoPlayers();
    const old = { id: bob.id, token: bob.token };
    bob.close();
    const again = await h.client(srv);
    const reply = await again.join('bob', { reconnectToken: old.token });
    expect(reply).toMatchObject({ type: 'joined', playerId: old.id });
  });

  it('kicks a player, who then can not rejoin with that username', async () => {
    const { srv, alex, bob } = await twoPlayers();
    expect((await bob.expectError({ type: 'kick_player', playerId: alex.id })).code).toBe('not_host');
    expect((await alex.expectError({ type: 'kick_player', playerId: alex.id })).code).toBe('bad_message');
    expect((await alex.expectError({ type: 'kick_player', playerId: 'nobody' })).code).toBe('unknown_player');

    alex.send({ type: 'kick_player', playerId: bob.id });
    await waitUntil(() => bob.kickedReason !== null, 3000, 'kicked message');
    await alex.waitForState((s) => s.players.length === 1);
    await waitUntil(() => bob.closed, 3000, 'kicked socket to close');

    const retry = await h.client(srv);
    expect(await retry.join('Bob')).toMatchObject({ type: 'error', code: 'kicked' });
    expect(await retry.join('BOB')).toMatchObject({ type: 'error', code: 'kicked' });
    expect((await retry.join('Someone Else')).type).toBe('joined');
  });

  it('folds a kicked player in the middle of a hand', async () => {
    const { clients } = await players(['Alex', 'Bob', 'Cy'], { timing: { turnMs: 5000 } });
    const [alex, , cy] = clients as [TestClient, TestClient, TestClient];
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.turn !== null);
    alex.send({ type: 'kick_player', playerId: cy.id });
    const s = await alex.waitForState((st) => st.players.find((p) => p.id === cy.id)?.folded === true);
    expect(s.players.find((p) => p.id === cy.id)!.lastAction).toBe('Fold');
    expect(s.log.some((e) => e.text === 'Cy folds')).toBe(true);
  });

  it('keeps the connection usable after garbage input', async () => {
    const { srv } = await h.boot();
    const c = await h.client(srv);
    c.sendRaw('this is not json');
    c.sendRaw('{"no":"type"}');
    c.sendRaw('[1,2,3]');
    c.sendRaw('null');
    c.sendRaw(JSON.stringify({ type: 'action', action: 'fold' })); // before joining
    c.sendRaw(JSON.stringify({ type: 'join', username: 42 }));
    await waitUntil(() => c.errors.length >= 6, 3000, 'six errors');
    expect(c.errors.map((e) => e.code)).toEqual(['bad_message', 'bad_message', 'bad_message', 'bad_message', 'not_joined', 'bad_username']);
    expect((await c.join('Cy')).type).toBe('joined');
    expect((await c.expectError({ type: 'bogus' } as never)).code).toBe('bad_message');
  });

  it('lets a player who joins mid-game watch until a seat frees up, then deals them in', async () => {
    const { srv, alex, bob } = await twoPlayers({ timing: { turnMs: 5000 } });
    alex.send({ type: 'update_settings', settings: { maxPlayers: 2 } });
    await alex.waitForState((s) => s.settings.maxPlayers === 2);
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'preflop');

    const cy = await h.client(srv);
    expect(cy.all.find((m) => m.type === 'server_info')).toMatchObject({ seatsFree: false });
    await cy.join('Cy');
    const s = cy.state!;
    expect(cy.me(s).seat).toBeNull();
    expect(cy.me(s).inHand).toBe(false);
    expect(s.you).toBeNull();
    expect((await cy.expectError({ type: 'sit_out', sittingOut: true })).code).toBe('not_seated');
    expect((await cy.expectError({ type: 'action', action: 'fold' })).code).toBe('not_your_turn');

    bob.send({ type: 'leave' });
    const later = await cy.waitForState((st) => cy.me(st).seat !== null, 3000);
    expect(later.seats).toContain(cy.id);
    alex.autoPlay(passive);
    cy.autoPlay(passive);
    const dealt = await cy.waitForState((st) => cy.me(st).inHand && st.you?.cards.length === 2, 4000);
    expect(dealt.you?.cards.length).toBeGreaterThan(0);
  });
});

describe('rejected messages', () => {
  it('rejects out-of-turn actions, illegal amounts and out-of-phase messages without changing anything', async () => {
    const { alex, bob } = await twoPlayers({ timing: { turnMs: 5000 } });
    expect((await bob.expectError({ type: 'action', action: 'check' })).code).toBe('wrong_phase');
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    const clients = [alex, bob];
    const first = inSeat(clients, s, s.buttonSeat); // heads-up the button acts first preflop
    const second = clients.find((c) => c !== first)!;
    await first.waitForTurn();

    const snapshot = () => JSON.stringify(first.state!.players.map((p) => [p.id, p.chips, p.bet, p.folded]));
    const before = snapshot();
    expect((await second.expectError({ type: 'action', action: 'call' })).code).toBe('not_your_turn');
    expect((await second.expectError({ type: 'action', action: 'raise', amount: 40 })).code).toBe('not_your_turn');
    expect((await first.expectError({ type: 'action', action: 'fly' as never })).code).toBe('bad_message');
    expect((await first.expectError({ type: 'action', action: 'check' })).code).toBe('action_not_allowed');
    expect((await first.expectError({ type: 'action', action: 'bet', amount: 20 })).code).toBe('action_not_allowed');
    expect((await first.expectError({ type: 'action', action: 'raise', amount: 19 })).code).toBe('bad_amount');
    expect((await first.expectError({ type: 'action', action: 'raise', amount: 1001 })).code).toBe('bad_amount');
    expect((await first.expectError({ type: 'action', action: 'raise', amount: 25.5 })).code).toBe('bad_amount');
    expect((await first.expectError({ type: 'action', action: 'raise', amount: '50' as never })).code).toBe('bad_amount');
    expect((await first.expectError({ type: 'action', action: 'raise', amount: -50 })).code).toBe('bad_amount');
    expect((await first.expectError({ type: 'action', action: 'raise' })).code).toBe('bad_amount');
    expect((await first.expectError({ type: 'reset_chips' })).code).toBe('cannot_reset');
    expect((await first.expectError({ type: 'withdraw', amount: 10 })).code).toBe('cannot_withdraw');
    expect((await first.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');
    expect((await bob.expectError({ type: 'update_settings', settings: { bigBlind: 20 } })).code).toBe('not_host');
    expect((await alex.expectError({ type: 'update_settings', settings: { bigBlind: 20 } })).code).toBe('settings_locked');
    expect((await second.expectError({ type: 'set_ready', ready: true })).code).toBe('wrong_phase');
    expect(snapshot()).toBe(before);
    expect(first.state!.turn).toBe(first.id);

    // The legal range is offered to the player whose turn it is, and only to them.
    expect(first.state!.you!.legal).toMatchObject({ canCheck: false, callAmount: 5, canRaise: true, minTo: 20, maxTo: 1000, allInTo: 1000 });
    expect(second.state!.you!.legal).toBeNull();

    first.send({ type: 'action', action: 'raise', amount: 20 });
    await second.waitForTurn();
    second.send({ type: 'action', action: 'fold' });
    await alex.waitForState((st) => st.phase === 'hand_over');
    expect((await first.expectError({ type: 'action', action: 'check' })).code).toBe('wrong_phase');
  });
});

describe('timers and disconnects', () => {
  it('checks or folds a player when the turn timer runs out', async () => {
    const { alex, bob } = await twoPlayers({ timing: { turnMs: 200 } });
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    const clients = [alex, bob];
    const button = inSeat(clients, s, s.buttonSeat);
    const bb = clients.find((c) => c !== button)!;
    await button.waitForTurn();
    button.send({ type: 'action', action: 'call' });
    // The big blind does nothing: it can check, so the timer checks for it.
    await alex.waitForState((st) => st.log.some((e) => e.text === `${bb.me(st).name} ran out of time and checks`), 3000);
    // On the flop the big blind acts first; with nobody acting the hand checks down to a showdown.
    await alex.waitForState((st) => st.phase === 'hand_over' && st.hand === 1, 5000);
    // Next hand: the new button faces the big blind, so the timer folds.
    await alex.waitForState((st) => st.log.some((e) => / ran out of time and folds$/.test(e.text)), 3000);
    expect(alex.errors).toEqual([]);
  });

  it("does not freeze the table when a player's tab closes during their turn", async () => {
    const { alex, bob } = await twoPlayers({ timing: { turnMs: 250, holdMs: 3000 } });
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    const clients = [alex, bob];
    const button = inSeat(clients, s, s.buttonSeat);
    const other = clients.find((c) => c !== button)!;
    await button.waitForTurn();
    button.close();
    const over = await other.waitForState((st) => st.phase === 'hand_over', 3000);
    expect(over.log.some((e) => e.text === `${button.me(over).name} is away and folds`)).toBe(true);
    // The seat is held, but an absent player is not dealt into the next hand.
    expect(button.me(over).seat).not.toBeNull();
    const waiting = await other.waitForState((st) => st.phase === 'waiting', 3000);
    expect(waiting.log.some((e) => e.text === 'Waiting for players')).toBe(true);
  });

  it('does not freeze either when the turn timer is off', async () => {
    const { alex, bob } = await twoPlayers({ timing: { holdMs: 250 } });
    alex.send({ type: 'update_settings', settings: { turnSeconds: null } });
    await bob.waitForState((s) => s.settings.turnSeconds === null);
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    expect(s.deadline).toBeNull();
    const clients = [alex, bob];
    const button = inSeat(clients, s, s.buttonSeat);
    const other = clients.find((c) => c !== button)!;
    await button.waitForTurn();
    button.close();
    await other.waitForState((st) => st.phase === 'hand_over', 3000);
  });

  it('returns a refreshed player to the same seat with the same cards mid-hand', async () => {
    const { srv, alex, bob } = await twoPlayers({ timing: { turnMs: 6000, holdMs: 3000 } });
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    const before = bob.state!;
    const seat = bob.me(before).seat;
    const holeCards = before.you!.cards;
    expect(holeCards).toHaveLength(2);
    const { token, id } = bob;

    bob.close(); // the page is refreshed
    await alex.waitForState((st) => st.players.find((p) => p.id === id)?.connected === false);
    const fresh = await h.client(srv);
    const reply = await fresh.join('Bob', { reconnectToken: token });
    expect(reply).toMatchObject({ type: 'joined', playerId: id });
    const after = await fresh.waitForState((st) => st.players.find((p) => p.id === id)?.connected === true);
    expect(fresh.me(after).seat).toBe(seat);
    expect(fresh.me(after).inHand).toBe(true);
    expect(after.you!.cards).toEqual(holeCards);
    expect(after.hand).toBe(s.hand);

    // The refreshed client can carry on playing.
    alex.autoPlay(passive);
    fresh.autoPlay(passive);
    await fresh.waitForState((st) => st.phase === 'hand_over', 5000);
    expect(fresh.errors).toEqual([]);
  });

  it('frees the seat after the hold, and a later rejoin keeps the saved chips', async () => {
    const { srv, alex, bob } = await twoPlayers({ timing: { holdMs: 150 } });
    bob.close();
    await alex.waitForState((s) => s.players.length === 1, 3000);
    const again = await h.client(srv);
    expect((await again.join('Bob')).type).toBe('joined');
    expect(again.me().chips).toBe(1000);
  });
});

describe('sitting out and leaving', () => {
  it('does not deal in or charge blinds to a player who sits out, until they come back', async () => {
    const { clients } = await players(['Alex', 'Bob', 'Cy']);
    const [alex, bob, cy] = clients as [TestClient, TestClient, TestClient];
    for (const c of clients) c.autoPlay(passive);
    const overs = alex.collectHandOvers();
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'preflop');
    cy.send({ type: 'sit_out', sittingOut: true });
    await cy.waitForState((s) => cy.me(s).sittingOut);
    await waitUntil(() => overs.has(4), 10000, 'hand 4');

    const chipsAfterOne = cy.me(overs.get(1)!).chips;
    for (const hand of [2, 3, 4]) {
      const s = overs.get(hand)!;
      const me = cy.me(s);
      expect(me.inHand).toBe(false);
      expect(me.chips).toBe(chipsAfterOne);
      expect([s.smallBlindSeat, s.bigBlindSeat]).not.toContain(me.seat);
      expect(s.players.filter((p) => p.inHand).map((p) => p.id).sort()).toEqual([alex.id, bob.id].sort());
    }
    // A sitting-out player can reset chips during a hand, since they are not in it.
    await alex.waitForState((s) => s.phase === 'preflop' && s.hand >= 5);
    cy.send({ type: 'reset_chips' });
    await cy.waitForState((s) => cy.me(s).chips === 1000);

    cy.send({ type: 'sit_out', sittingOut: false });
    const back = await cy.waitForState((s) => cy.me(s).inHand && s.you?.cards.length === 2, 6000);
    expect(back.you!.cards.length).toBeGreaterThan(0);
    expect(cy.errors).toEqual([]);
  });

  it('folds a player who leaves during a hand at once, keeping their chips in the pot', async () => {
    const { clients } = await players(['Alex', 'Bob', 'Cy'], { timing: { turnMs: 5000 } });
    const [alex] = clients as [TestClient];
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.turn !== null);
    // The big blind leaves while someone else is to act.
    const bb = inSeat(clients, s, s.bigBlindSeat);
    const name = bb.me(s).name;
    bb.send({ type: 'leave' });
    const after = await alex.waitForState((st) => st.players.find((p) => p.name === name)?.folded === true);
    expect(after.players.find((p) => p.name === name)!.bet).toBe(10); // the blind stays in
    expect(after.turn).toBe(s.turn);
    for (const c of clients) if (c !== bb) c.autoPlay(passive);
    const over = await alex.waitForState((st) => st.phase === 'hand_over', 5000);
    expect(over.result!.pots.reduce((sum, p) => sum + p.amount, 0)).toBeGreaterThanOrEqual(30);
    // Gone once the hand is over.
    await alex.waitForState((st) => !st.players.some((p) => p.name === name), 3000);
  });
});

describe('chips and usernames', () => {
  it('keeps chips across a server restart, gives a new username the starting chips, and resets chips', async () => {
    const rigged = [headsUp('AS AH', '2D 7C', '9H 9S KD 4C 3H')];
    const first = await twoPlayers({ rigged });
    first.alex.autoPlay(passive);
    first.bob.autoPlay(passive);
    first.alex.send({ type: 'start_game' });
    const over = await first.alex.waitForState((s) => s.phase === 'hand_over', 5000);
    const winner = inSeat([first.alex, first.bob], over, over.bigBlindSeat);
    const winnerName = winner.me(over).name;
    const loserName = winnerName === 'Alex' ? 'Bob' : 'Alex';
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))).toEqual({
      [winnerName]: 1010,
      [loserName]: 990,
    });
    expect(existsSync(join(first.dataDir, 'players.json.tmp'))).toBe(false);

    // Restart the server on the same folder, with different starting chips.
    await first.srv.close();
    const second = await h.boot({}, first.dataDir);
    const host = await h.client(second.srv);
    await host.join('Host', { hostToken: second.srv.hostToken });
    host.send({ type: 'update_settings', settings: { startingChips: 5000 } });
    await host.waitForState((s) => s.settings.startingChips === 5000);

    const back = await h.client(second.srv);
    await back.join(winnerName.toUpperCase()); // same name, other case
    expect(back.me().name).toBe(winnerName);
    expect(back.me().chips).toBe(1010);
    expect(back.me().earnings).toBe(0); // winning a hand is not earnings

    const newcomer = await h.client(second.srv);
    await newcomer.join('Newbie');
    expect(newcomer.me().chips).toBe(5000);

    // Reset chips works in the waiting room and is saved.
    back.send({ type: 'reset_chips' });
    await back.waitForState((s) => back.me(s).chips === 5000);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))[winnerName]).toBe(5000);
  });
});

describe('borrowing and withdrawing', () => {
  it('lets a player who lost everything borrow a buy-in, keeps the debt across a restart and pays it back', async () => {
    // The big blind gets aces and wins; the button goes all in and loses everything.
    const rigged = [headsUp('AS AH', '2D 7C', '9H 9S KD 4C 3H')];
    // This test looks at the showdown and the result while they are on screen. Each stays up for several
    // hundred ms, far longer than the few ms a message takes, so the checks below can not miss them
    // (with the fast test timing the showdown lasted ~0 ms and "borrow" was sometimes accepted by mistake).
    const first = await twoPlayers({ rigged, timing: { revealScale: 0.4, potMs: 300, showdownMs: 600, turnMs: 5000 } });
    const clients = [first.alex, first.bob];
    first.alex.send({ type: 'start_game' });
    const s = await first.alex.waitForState((st) => st.turn !== null);
    const loser = inSeat(clients, s, s.buttonSeat);
    const winner = clients.find((c) => c !== loser)!;
    const name = loser.me(s).name;

    // With chips left there is nothing to borrow.
    expect((await loser.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');
    await loser.waitForTurn();
    loser.send({ type: 'action', action: 'all_in' });
    await winner.waitForTurn();
    winner.send({ type: 'action', action: 'call' });

    // Not while the hand is still being shown down.
    await loser.waitForState((st) => st.phase === 'showdown');
    expect((await loser.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');
    const lost = await loser.waitForState((st) => st.phase === 'hand_over');
    expect(loser.me(lost)).toMatchObject({ chips: 0, debt: 0, earnings: 0 });
    // Only one player has chips, so the table waits.
    const waiting = await loser.waitForState((st) => st.phase === 'waiting');
    expect(loser.me(waiting).chips).toBe(0);

    loser.send({ type: 'borrow' });
    const borrowed = await loser.waitForState((st) => loser.me(st).debt === 1000);
    expect(loser.me(borrowed).chips + loser.me(borrowed).bet).toBe(1000);
    expect(loser.me(borrowed).earnings).toBe(-1000); // the loan counts against the earnings
    expect(borrowed.log.some((e) => e.text === `${name} borrows 1,000 and now owes 1,000`)).toBe(true);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))[name]).toEqual({
      chips: 1000,
      debt: 1000,
      earnings: -1000,
    });

    // Borrowing let a new hand start, and withdrawing must wait until the player is out of it.
    await loser.waitForState((st) => st.phase === 'preflop' && st.hand === 2);
    expect((await loser.expectError({ type: 'withdraw', amount: 10 })).code).toBe('cannot_withdraw');
    expect((await loser.expectError({ type: 'borrow' })).code).toBe('cannot_borrow');

    // The tab survives a restart.
    await first.srv.close();
    const second = await h.boot({}, first.dataDir);
    const back = await h.client(second.srv);
    await back.join(name);
    expect(back.me()).toMatchObject({ chips: 1000, debt: 1000, earnings: -1000 });

    // Withdrawing the chips pays the loan off; nothing was won, so the earnings end at zero.
    back.send({ type: 'withdraw', amount: 1000 });
    const paid = await back.waitForState((st) => back.me(st).debt === 0);
    expect(back.me(paid)).toMatchObject({ chips: 0, debt: 0, earnings: 0 });
    expect(paid.log.some((e) => e.text === `${name} withdraws 1,000 and pays off 1,000 of their debt`)).toBe(true);
    expect((await back.expectError({ type: 'withdraw', amount: 1 })).code).toBe('bad_amount');

    // Resetting chips wipes the earnings too.
    back.send({ type: 'reset_chips' });
    await back.waitForState((st) => back.me(st).chips === 1000);
    expect(back.me().earnings).toBe(0);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))[name]).toBe(1000);
  });
});

/** Boots a server whose saved players are `saved`, with Alex (the host) joined and not ready. */
async function withSavedPlayers(saved: Record<string, unknown>) {
  const first = await h.boot();
  await first.srv.close();
  writeFileSync(join(first.dataDir, 'players.json'), JSON.stringify(saved));
  const { srv, dataDir } = await h.boot({}, first.dataDir);
  const alex = await h.client(srv);
  await alex.join('Alex', { hostToken: srv.hostToken });
  return { srv, dataDir, alex };
}

const saved = (dataDir: string, name: string) => JSON.parse(readFileSync(join(dataDir, 'players.json'), 'utf8'))[name];

describe('withdrawing', () => {
  it('pays the debt first and keeps the rest as earnings', async () => {
    const { dataDir, alex } = await withSavedPlayers({ Alex: { chips: 3000, debt: 1000, earnings: -1000 } });
    expect(alex.me()).toMatchObject({ chips: 3000, debt: 1000, earnings: -1000 });
    alex.send({ type: 'withdraw', amount: 1500 });
    const after = await alex.waitForState((s) => alex.me(s).chips === 1500);
    expect(alex.me(after)).toMatchObject({ chips: 1500, debt: 0, earnings: 500 });
    expect(after.log.some((e) => e.text === 'Alex withdraws 1,500 and pays off 1,000 of their debt')).toBe(true);
    expect(saved(dataDir, 'Alex')).toEqual({ chips: 1500, earnings: 500 });
  });

  it('leaves a smaller debt standing when the amount does not cover it', async () => {
    const { alex } = await withSavedPlayers({ Alex: { chips: 3000, debt: 1000, earnings: -1000 } });
    alex.send({ type: 'withdraw', amount: 400 });
    const after = await alex.waitForState((s) => alex.me(s).chips === 2600);
    expect(alex.me(after)).toMatchObject({ debt: 600, earnings: -600 });
    expect(after.log.some((e) => e.text === 'Alex withdraws 400 and still owes 600')).toBe(true);
  });

  it('is a plain cash-out when there is no debt, and can take every chip', async () => {
    const { alex } = await withSavedPlayers({ Alex: 1000 });
    alex.send({ type: 'withdraw', amount: 500 });
    const half = await alex.waitForState((s) => alex.me(s).chips === 500);
    expect(alex.me(half)).toMatchObject({ debt: 0, earnings: 500 });
    expect(half.log.some((e) => e.text === 'Alex withdraws 500')).toBe(true);
    alex.send({ type: 'withdraw', amount: 500 });
    const none = await alex.waitForState((s) => alex.me(s).chips === 0);
    expect(alex.me(none)).toMatchObject({ debt: 0, earnings: 1000 });
  });

  it('refuses amounts that are not a whole number from 1 to the chips', async () => {
    const { alex } = await withSavedPlayers({ Alex: 1000 });
    for (const amount of [0, -5, 12.5, '50' as never, 1001, undefined as never]) {
      expect((await alex.expectError({ type: 'withdraw', amount })).code).toBe('bad_amount');
    }
    expect(alex.me()).toMatchObject({ chips: 1000, earnings: 0 });
  });

  it('is refused in the middle of a hand and for a spectator', async () => {
    const { srv, clients } = await players(['Alex', 'Bob']);
    const [alex] = clients as [TestClient, TestClient];
    alex.send({ type: 'update_settings', settings: { maxPlayers: 2 } });
    await alex.waitForState((s) => s.settings.maxPlayers === 2);
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.turn !== null);
    expect((await alex.expectError({ type: 'withdraw', amount: 10 })).code).toBe('cannot_withdraw');
    const watcher = await h.client(srv);
    await watcher.join('Watcher');
    expect(watcher.me().seat).toBeNull();
    expect((await watcher.expectError({ type: 'withdraw', amount: 10 })).code).toBe('cannot_withdraw');
    expect(watcher.me()).toMatchObject({ chips: 1000, earnings: 0 });
  });

  it('keeps earnings at minus the debt plus everything withdrawn, whatever the amounts', async () => {
    const { alex } = await withSavedPlayers({ Alex: { chips: 3000, debt: 1000, earnings: -1000 } });
    let withdrawn = 0;
    for (const amount of [300, 900, 1, 1799]) {
      alex.send({ type: 'withdraw', amount });
      withdrawn += amount;
      const s = await alex.waitForState((st) => alex.me(st).chips === 3000 - withdrawn);
      expect(alex.me(s).earnings).toBe(-1000 + withdrawn);
    }
    expect(alex.me()).toMatchObject({ chips: 0, debt: 0, earnings: 2000 });
  });
});


describe('closing the game', () => {
  it('ends the game when the last player leaves, and only the host link can create a new one', async () => {
    const { srv } = await h.boot();
    const alex = await h.client(srv);
    const bob = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    await bob.join('Bob');
    alex.send({ type: 'update_settings', settings: { startingChips: 2000, bigBlind: 50 } });
    await alex.waitForState((s) => s.settings.bigBlind === 50);

    // The game stays open while someone is still at the table.
    alex.send({ type: 'leave' });
    await bob.waitForState((s) => s.players.length === 1);
    const stillOpen = await h.client(srv);
    expect(stillOpen.all.find((m) => m.type === 'server_info')).toMatchObject({ gameOpen: true });
    stillOpen.close();

    // A newcomer waiting on the join screen is told when the game ends.
    const waiting = await h.client(srv);
    bob.send({ type: 'leave' });
    await waitUntil(() => waiting.all.some((m) => m.type === 'server_info' && !m.gameOpen), 3000, 'game closed info');
    expect(bob.all.filter((m) => m.type === 'server_info').pop()).toMatchObject({ gameOpen: false });

    // Players without the host token can't join any more.
    const carol = await h.client(srv);
    expect(carol.all.find((m) => m.type === 'server_info')).toMatchObject({ gameOpen: false });
    expect(await carol.join('Carol')).toMatchObject({ type: 'error', code: 'game_closed' });

    // The host link creates a fresh game: default settings, empty log, hand 0.
    const host = await h.client(srv);
    expect(await host.join('Alex', { hostToken: srv.hostToken })).toMatchObject({ type: 'joined', isHost: true });
    const fresh = host.state!;
    expect(fresh.phase).toBe('waiting');
    expect(fresh.hand).toBe(0);
    expect(fresh.settings.bigBlind).toBe(10);
    expect(fresh.settings.startingChips).toBe(1000);
    expect(fresh.log.map((l) => l.text)).toEqual(['Alex joined']);
    await waitUntil(() => {
      const last = waiting.all.filter((m) => m.type === 'server_info').pop();
      return last?.type === 'server_info' && last.gameOpen;
    }, 3000, 'game open info');

    // Now everyone may join again.
    expect(await carol.join('Carol')).toMatchObject({ type: 'joined' });
  });

  it('ends the game after the hand when the last players leave in the middle of it', async () => {
    const { srv, alex, bob } = await twoPlayers({ timing: { turnMs: 5000, foldWinMs: 200 } });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.turn !== null);
    const late = await h.client(srv);
    alex.send({ type: 'leave' });
    await bob.waitForState((s) => s.phase === 'hand_over');
    bob.send({ type: 'leave' });
    // The hand finishes first, then the empty table closes and the waiting client is told.
    await waitUntil(() => late.all.some((m) => m.type === 'server_info' && !m.gameOpen), 5000, 'game closed info');
    expect(await late.join('Late')).toMatchObject({ type: 'error', code: 'game_closed' });
    await sleep(20);
  });
});
