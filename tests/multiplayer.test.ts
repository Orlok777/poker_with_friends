import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionName, PlayerView, ServerMsg, TableState } from '../shared/types.js';
import { isHiddenCard } from '../shared/types.js';
import type { ServerOptions } from '../server/index.js';
import { cards, createHarness, sleep, waitUntil, type TestClient } from './helpers.js';

const h = createHarness();
let expectedLogs = 0;

afterEach(async () => {
  const logs = h.logs.splice(0);
  await h.cleanup();
  // Nothing may be logged as an error or warning during a normal test.
  expect(logs.length).toBe(expectedLogs);
  expectedLogs = 0;
});

/** Boots a server with a host (Alex) and a guest (Bob), both joined and ready, game not started. */
async function twoPlayers(options: Partial<ServerOptions> = {}) {
  const { srv, dataDir } = await h.boot(options);
  const alex = await h.client(srv);
  const bob = await h.client(srv);
  expect((await alex.join('Alex', { hostToken: srv.hostToken })).type).toBe('joined');
  expect((await bob.join('Bob')).type).toBe('joined');
  alex.send({ type: 'set_ready', ready: true });
  bob.send({ type: 'set_ready', ready: true });
  await alex.waitForState((s) => s.players.every((p) => p.ready));
  return { srv, dataDir, alex, bob };
}

const standAlways = (): ActionName => 'stand';

function allMessages(...clients: TestClient[]): ServerMsg[] {
  return clients.flatMap((c) => c.all);
}

describe('playing rounds', () => {
  it('2 clients join, bet and play 3 rounds without errors', async () => {
    const { alex, bob } = await twoPlayers();
    const hitBelow17 = (p: PlayerView): ActionName => (p.total < 17 ? 'hit' : 'stand');
    alex.autoPlay(10, hitBelow17);
    bob.autoPlay(10, hitBelow17);
    const settles = alex.collectSettles();
    const bobSettles = bob.collectSettles();
    alex.send({ type: 'start_game' });

    await waitUntil(() => settles.has(3) && bobSettles.has(3), 8000, 'round 3');
    expect(alex.errors).toEqual([]);
    expect(bob.errors).toEqual([]);

    // Chips follow the round results exactly.
    for (const [c, seen] of [[alex, settles], [bob, bobSettles]] as const) {
      let chips = 1000;
      const roundResults = c.all.filter((m): m is Extract<ServerMsg, { type: 'round_result' }> => m.type === 'round_result');
      expect(roundResults.length).toBeGreaterThanOrEqual(3);
      for (const r of roundResults.filter((x) => x.round <= 3)) {
        const mine = r.results.find((x) => x.playerId === c.id);
        if (mine) chips += mine.delta;
        expect(c.me(seen.get(r.round)!).chips, `${c.me().name} after round ${r.round}`).toBe(chips);
      }
    }
  });

  it('two players play 5 full rounds and the chip counts are exact after each', async () => {
    // Deal order per round: Alex, Bob, dealer up, Alex, Bob, dealer hole, then any draws.
    const rigged = cards(
      [
        '10 10 10 9 6 7D', // 1: Alex 19 beats dealer 17, Bob 16 loses
        'A 8 6 K 7 10 9', // 2: Alex blackjack, dealer busts (Bob 15 wins)
        '10 10 9 2 8 9 10', // 3: Alex 12 hits and busts, Bob 18 pushes dealer 18
        '5 9 10 6 9 8 10', // 4: Alex 11 doubles to 21 and wins, Bob 18 pushes
        '10 A A 9 K K', // 5: dealer blackjack, Alex 19 loses, Bob blackjack pushes
      ].join(' '),
    );
    const { alex, bob } = await twoPlayers({ rigged });
    alex.autoPlay(100, (p) => (p.cards.length === 2 && p.total === 11 ? 'double' : p.total <= 12 ? 'hit' : 'stand'));
    bob.autoPlay(50, standAlways);
    const settles = alex.collectSettles();
    alex.send({ type: 'start_game' });

    const expected: [number, number][] = [
      [1100, 950],
      [1250, 1000],
      [1150, 1000],
      [1350, 1000],
      [1250, 1000],
    ];
    for (let round = 1; round <= 5; round++) {
      await waitUntil(() => settles.has(round), 6000, `round ${round}`);
      const s = settles.get(round)!;
      const [a, b] = expected[round - 1]!;
      expect(alex.me(s).chips, `Alex after round ${round}`).toBe(a);
      expect(bob.me(s).chips, `Bob after round ${round}`).toBe(b);
    }
    const last = settles.get(5)!;
    expect(alex.me(last).outcome).toBe('loss');
    expect(bob.me(last).outcome).toBe('push');
    expect(alex.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it('hides the hole card until it is revealed and never sends the host token', async () => {
    const rigged = cards('10 10 10 9 6 7D');
    const { srv, alex, bob } = await twoPlayers({ rigged });
    alex.autoPlay(100, standAlways);
    bob.autoPlay(50, standAlways);
    const settles = alex.collectSettles();
    alex.send({ type: 'start_game' });
    await waitUntil(() => settles.has(1), 6000, 'round 1');

    const holeCard = { rank: '7', suit: 'D' };
    for (const c of [alex, bob]) {
      const states = c.all.filter((m): m is TableState => m.type === 'table_state' && m.round === 1);
      let sawHidden = false;
      for (const s of states) {
        const covered = s.phase === 'dealing' || s.phase === 'player_turns';
        if (!covered) continue;
        const dealt = s.dealer.cards;
        if (dealt.length > 1) {
          expect(isHiddenCard(dealt[1]!)).toBe(true);
          sawHidden = true;
        }
        // The hole card must not appear anywhere in the message, not only in the dealer's cards.
        const text = JSON.stringify(s);
        expect(text.includes(JSON.stringify(holeCard))).toBe(false);
        expect(text.includes('"rank":"7","suit":"D"')).toBe(false);
      }
      expect(sawHidden).toBe(true);
    }
    // After the reveal the real card is there.
    const revealed = settles.get(1)!;
    expect(revealed.dealer.cards[1]).toEqual(holeCard);

    const everything = JSON.stringify(allMessages(alex, bob));
    expect(everything.includes(srv.hostToken)).toBe(false);
  });
});

describe('host and settings', () => {
  it("shows the host's setting changes to the other player and locks them after Start", async () => {
    const { srv, alex, bob } = await twoPlayers();
    alex.send({
      type: 'update_settings',
      settings: { minBet: 25, decks: 2, dealerHitsSoft17: true, blackjackPayout: '6:5', doubleRule: '9-11', password: 'secret', turnSeconds: null },
    });
    const s = await bob.waitForState((st) => st.settings.minBet === 25);
    expect(s.settings).toMatchObject({
      decks: 2,
      dealerHitsSoft17: true,
      blackjackPayout: '6:5',
      doubleRule: '9-11',
      passwordSet: true,
      turnSeconds: null,
    });
    // The password itself is never sent.
    expect(JSON.stringify(allMessages(alex, bob)).includes('secret')).toBe(false);
    expect(alex.me(s).id).toBe(s.hostId);

    alex.autoPlay(25, standAlways);
    bob.autoPlay(25, standAlways);
    alex.send({ type: 'start_game' });
    await bob.waitForState((st) => st.started);

    const err = await alex.expectError({ type: 'update_settings', settings: { minBet: 50 } });
    expect(err.code).toBe('settings_locked');
    expect(bob.state!.settings.minBet).toBe(25);
    void srv;
  });

  it('rejects invalid settings and settings changes from a non-host', async () => {
    const { alex, bob } = await twoPlayers();
    expect((await bob.expectError({ type: 'update_settings', settings: { minBet: 50 } })).code).toBe('not_host');
    expect((await alex.expectError({ type: 'update_settings', settings: { maxBet: 5000 } })).code).toBe('invalid_settings');
    expect((await alex.expectError({ type: 'update_settings', settings: { decks: 9 } })).code).toBe('invalid_settings');
    expect((await alex.expectError({ type: 'update_settings', settings: { minBet: 'ten' as unknown as number } })).code).toBe('invalid_settings');
    expect((await alex.expectError({ type: 'update_settings', settings: { maxPlayers: 1 } })).code).toBe('invalid_settings');
    expect((await bob.expectError({ type: 'start_game' })).code).toBe('not_host');
    expect(alex.state!.settings.minBet).toBe(10);
    expect(alex.state!.settings.maxBet).toBe(500);
    expect(alex.state!.started).toBe(false);
  });

  it('needs a ready player before the host can start', async () => {
    const { srv } = await h.boot();
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    expect((await alex.expectError({ type: 'start_game' })).code).toBe('cannot_start');
    alex.send({ type: 'set_ready', ready: true });
    await alex.waitForState((s) => s.players[0]!.ready);
    alex.send({ type: 'start_game' });
    const s = await alex.waitForState((st) => st.started);
    expect(s.phase).toBe('betting');
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
    again.send({ type: 'update_settings', settings: { minBet: 20 } });
    await guest.waitForState((s) => s.settings.minBet === 20);
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

  it('keeps the connection usable after garbage input', async () => {
    const { srv } = await h.boot();
    const c = await h.client(srv);
    c.sendRaw('this is not json');
    c.sendRaw('{"no":"type"}');
    c.sendRaw('[1,2,3]');
    c.sendRaw('null');
    c.sendRaw(JSON.stringify({ type: 'place_bet', amount: 5 })); // before joining
    c.sendRaw(JSON.stringify({ type: 'join', username: 42 }));
    await waitUntil(() => c.errors.length >= 6, 3000, 'six errors');
    expect(c.errors.map((e) => e.code)).toEqual(['bad_message', 'bad_message', 'bad_message', 'bad_message', 'not_joined', 'bad_username']);
    expect((await c.join('Cy')).type).toBe('joined');
    expect((await c.expectError({ type: 'bogus' } as never)).code).toBe('bad_message');
  });

  it('lets a watcher take a seat when one frees up', async () => {
    const { srv } = await h.boot({ timing: { bettingMs: 250 } });
    const alex = await h.client(srv);
    const bob = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    alex.send({ type: 'update_settings', settings: { maxPlayers: 1 } });
    await alex.waitForState((s) => s.settings.maxPlayers === 1);
    const info = bob.all.find((m) => m.type === 'server_info');
    expect(info).toMatchObject({ seatsFree: true });
    await bob.join('Bob');
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    const s = await bob.waitForState((st) => st.phase === 'betting');
    expect(bob.me(s).seat).toBeNull();
    expect(alex.me(s).seat).toBe(0);
    expect((await bob.expectError({ type: 'place_bet', amount: 10 })).code).toBe('not_seated');

    alex.send({ type: 'leave' });
    const later = await bob.waitForState((st) => bob.me(st).seat === 0, 3000);
    expect(later.seats).toEqual([bob.id]);
  });
});

describe('rejected messages', () => {
  it('rejects out-of-turn actions, out-of-phase messages and bets outside the limits without changing anything', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { turnMs: 5000, bettingMs: 5000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);

    // Betting phase
    expect((await bob.expectError({ type: 'action', action: 'hit' })).code).toBe('wrong_phase');
    expect((await bob.expectError({ type: 'place_bet', amount: 5 })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: 501 })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: 1_000_000 })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: 12.5 })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: '50' as unknown as number })).code).toBe('bet_invalid');
    expect((await bob.expectError({ type: 'place_bet', amount: -50 })).code).toBe('bet_invalid');
    expect(bob.me().chips).toBe(1000);
    expect(bob.me().bet).toBe(0);

    alex.send({ type: 'place_bet', amount: 100 });
    await alex.waitForState((s) => alex.me(s).bet === 100);
    expect((await alex.expectError({ type: 'place_bet', amount: 100 })).code).toBe('already_bet');
    expect(alex.me().chips).toBe(900);
    expect((await bob.expectError({ type: 'set_ready', ready: true })).code).toBe('wrong_phase');

    bob.send({ type: 'place_bet', amount: 50 });
    const turn = await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);

    // Player turns: Bob acts out of turn.
    const before = JSON.stringify(turn.players.map((p) => [p.id, p.cards, p.chips, p.bet]));
    expect((await bob.expectError({ type: 'action', action: 'hit' })).code).toBe('not_your_turn');
    expect((await bob.expectError({ type: 'action', action: 'stand' })).code).toBe('not_your_turn');
    expect((await alex.expectError({ type: 'action', action: 'fly' as never })).code).toBe('bad_message');
    expect((await alex.expectError({ type: 'place_bet', amount: 10 })).code).toBe('wrong_phase');
    expect((await alex.expectError({ type: 'reset_chips' })).code).toBe('cannot_reset');
    expect((await bob.expectError({ type: 'update_settings', settings: { minBet: 1 } })).code).toBe('not_host');
    const after = JSON.stringify(bob.state!.players.map((p) => [p.id, p.cards, p.chips, p.bet]));
    expect(after).toBe(before);
    expect(bob.state!.turn).toBe(alex.id);

    // Doubling is only valid when the rules allow it: Alex has 19, which is allowed under "any two cards".
    alex.send({ type: 'action', action: 'stand' });
    await bob.waitForState((s) => s.turn === bob.id);
    bob.send({ type: 'action', action: 'stand' });
    await bob.waitForState((s) => s.phase === 'settle');
  });

  it('rejects doubling when the rule is off or the chips are short', async () => {
    const rigged = cards('5 6 10 6 5 7'); // Alex 11 (6+5), dealer 17
    const { srv } = await h.boot({ rigged });
    const alex = await h.client(srv);
    await alex.join('Alex', { hostToken: srv.hostToken });
    alex.send({ type: 'update_settings', settings: { doubleRule: 'off', startingChips: 100, maxBet: 100 } });
    await alex.waitForState((s) => s.settings.doubleRule === 'off');
    alex.send({ type: 'reset_chips' });
    await alex.waitForState((s) => alex.me(s).chips === 100);
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    await alex.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    expect(alex.me().canDouble).toBe(false);
    expect((await alex.expectError({ type: 'action', action: 'double' })).code).toBe('action_not_allowed');
    alex.send({ type: 'action', action: 'stand' });
    await alex.waitForState((s) => s.phase === 'settle');
  });
});

describe('timers and disconnects', () => {
  it('stands an idle player when the turn timer runs out, and sits out a player who does not bet', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { bettingMs: 300, turnMs: 250 } });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 }); // Bob never bets

    const dealt = await alex.waitForState((s) => s.phase === 'player_turns');
    expect(bob.me(dealt).bet).toBe(0);
    expect(bob.me(dealt).status).toBe('none');
    expect(bob.me(dealt).cards).toEqual([]);
    expect(bob.me(dealt).chips).toBe(1000);
    expect(dealt.turn).toBe(alex.id);

    // Alex does nothing, so the timer stands for him.
    const settled = await alex.waitForState((s) => s.phase === 'settle', 4000);
    expect(alex.me(settled).status).toBe('stood');
    expect(settled.log.some((l) => l.text.includes('Alex ran out of time'))).toBe(true);
    expect(alex.me(settled).chips).toBe(1100); // 19 against 17
    expect(bob.me(settled).chips).toBe(1000);
  });

  it("does not freeze the table when a player's tab closes during their turn", async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { turnMs: 250, holdMs: 3000 } });
    bob.autoPlay(50, standAlways);
    alex.send({ type: 'start_game' });
    alex.autoPlay(100, () => 'stand');
    // Alex bets, but closes the tab as soon as it is Alex's turn.
    let closed = false;
    alex.onState((s) => {
      if (!closed && s.phase === 'player_turns' && s.turn === alex.id) {
        closed = true;
        alex.close();
      }
    });
    const settled = await bob.waitForState((s) => s.phase === 'settle', 5000);
    expect(closed).toBe(true);
    expect(settled.players.find((p) => p.name === 'Alex')!.status).toBe('stood');
    // The seat is held, not given away.
    expect(settled.players.find((p) => p.name === 'Alex')!.seat).toBe(0);
  });

  it('does not freeze either when the turn timer is off', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { alex, bob } = await twoPlayers({ rigged, timing: { holdMs: 250 } });
    alex.send({ type: 'update_settings', settings: { turnSeconds: null } });
    await bob.waitForState((s) => s.settings.turnSeconds === null);
    bob.autoPlay(50, standAlways);
    alex.send({ type: 'start_game' });
    let closed = false;
    alex.autoPlay(100, standAlways);
    alex.onState((s) => {
      if (!closed && s.phase === 'player_turns' && s.turn === alex.id) {
        closed = true;
        alex.close();
      }
    });
    const settled = await bob.waitForState((s) => s.phase === 'settle', 5000);
    expect(settled.players.find((p) => p.name === 'Alex')!.status).toBe('stood');
  });

  it('returns a refreshed player to the same seat mid-round', async () => {
    const rigged = cards('10 10 10 9 6 7');
    const { srv, alex, bob } = await twoPlayers({ rigged, timing: { turnMs: 6000, bettingMs: 6000, holdMs: 3000 } });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    bob.send({ type: 'place_bet', amount: 50 });
    const mid = await bob.waitForState((s) => s.phase === 'player_turns' && s.turn === alex.id);
    const before = bob.me(mid);
    const token = bob.token;
    const id = bob.id;

    bob.close(); // the page is refreshed
    await alex.waitForState((s) => s.players.find((p) => p.id === id)?.connected === false);
    const fresh = await h.client(srv);
    const reply = await fresh.join('Bob', { reconnectToken: token });
    expect(reply).toMatchObject({ type: 'joined', playerId: id });
    const after = await fresh.waitForState((s) => s.players.find((p) => p.id === id)?.connected === true);
    const bobAfter = after.players.find((p) => p.id === id)!;
    expect(bobAfter.seat).toBe(before.seat);
    expect(bobAfter.cards).toEqual(before.cards);
    expect(bobAfter.bet).toBe(50);

    // The refreshed client can carry on: Alex stands, then Bob stands.
    alex.send({ type: 'action', action: 'stand' });
    await fresh.waitForState((s) => s.turn === id);
    fresh.send({ type: 'action', action: 'stand' });
    await fresh.waitForState((s) => s.phase === 'settle');
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

describe('chips and usernames', () => {
  it('keeps chips across a server restart, gives a new username the starting chips, and resets chips', async () => {
    const rigged = cards('10 10 9 7'); // single player: 19 against 17
    const first = await h.boot({ rigged });
    const alex = await h.client(first.srv);
    await alex.join('Alex', { hostToken: first.srv.hostToken });
    alex.send({ type: 'set_ready', ready: true });
    alex.send({ type: 'start_game' });
    await alex.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    alex.send({ type: 'place_bet', amount: 100 });
    alex.autoPlay(100, standAlways);
    const won = await alex.waitForState((s) => s.phase === 'settle');
    expect(alex.me(won).chips).toBe(1100);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8'))).toEqual({ Alex: 1100 });
    expect(existsSync(join(first.dataDir, 'players.json.tmp'))).toBe(false);

    // Restart the server on the same folder, with different starting chips.
    await first.srv.close();
    const second = await h.boot({}, first.dataDir);
    const host = await h.client(second.srv);
    await host.join('Host', { hostToken: second.srv.hostToken });
    host.send({ type: 'update_settings', settings: { startingChips: 5000, maxBet: 500 } });
    await host.waitForState((s) => s.settings.startingChips === 5000);

    const back = await h.client(second.srv);
    await back.join('ALEX'); // same name, other case
    expect(back.me().name).toBe('Alex');
    expect(back.me().chips).toBe(1100);

    const newcomer = await h.client(second.srv);
    await newcomer.join('Newbie');
    expect(newcomer.me().chips).toBe(5000);

    // Reset chips works in the waiting room and is saved.
    back.send({ type: 'reset_chips' });
    await back.waitForState((s) => back.me(s).chips === 5000);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'players.json'), 'utf8')).Alex).toBe(5000);
  });

  it('resets chips in the betting phase only before the player has bet', async () => {
    const { alex, bob } = await twoPlayers({ timing: { bettingMs: 3000 } });
    alex.send({ type: 'start_game' });
    await bob.waitForState((s) => s.phase === 'betting' && s.deadline !== null);
    bob.send({ type: 'reset_chips' });
    await sleep(50);
    expect(bob.errors).toEqual([]);
    bob.send({ type: 'place_bet', amount: 100 });
    await bob.waitForState((s) => bob.me(s).bet === 100);
    expect((await bob.expectError({ type: 'reset_chips' })).code).toBe('cannot_reset');
    expect(bob.me().chips).toBe(900);
  });
});
