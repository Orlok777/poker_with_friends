# Multiplayer Poker — Build Spec v1

Nov 7, 2026 · @cocobanana67

## Goal and scope

A multiplayer No-Limit Texas Hold'em game for a group of friends, played for fake chips. One friend hosts the server on their Windows PC, and the others join from a browser at the host's IP and port.

This project starts as a copy of **Blackjack with Friends**, which already works. Keep everything that isn't blackjack: the stack, file layout, host token, join screen, waiting room, settings panel, reconnect, kicking, chip store, borrowing, debt, earnings, pay back, reset chips, Share button, sounds, theme, card drawing, phone layout, `HOSTING.md` and the screenshot script. Replace only the game: the rules engine, the round flow, the table screen and the action controls.

- The server runs exactly one table: 2 to 9 players and no computer opponent. The server deals the cards; a dealer button moves around the table. There are no lobbies and no lobby codes.
- The host picks the table settings before the first hand. They are locked once the game starts.
- Players join from a desktop or phone browser. The layout is built for desktop and must stay usable on a phone.
- No accounts and no per-player passwords. Chips are saved per username in a JSON file on the host's PC.
- No real money.
- The project has two phases. **Phase 1** is the browser version and is the one to build now. **Phase 2** wraps it in an Electron desktop app, the same way as the blackjack project, and gets its own prompt later.

## Tech stack and project layout

Same stack as the blackjack project: Node.js 20+, TypeScript everywhere, Express plus `ws`, Vite for the client, no frontend framework, Vitest for tests. `npm install && npm start` builds the client and starts the server on **port 3000**. The `PORT` environment variable still overrides it.

```
/shared   types.ts      message and table-state types used by both sides
/server   index.ts      HTTP + WebSocket entry point, host token, startup URLs (unchanged apart from names)
          table.ts      the one table: players, seats, button, settings, timers, betting rounds
          game.ts       pure betting engine: blinds, actions, min raise, side pots, no networking
          hand.ts       pure hand evaluator: best 5 of 7, ranking, hand names
          deck.ts       one 52-card deck per hand, shuffle, seedable random generator
          store.ts      chips saved per username in data/players.json (unchanged)
/client   index.html, main.ts, table.ts, controls.ts, cards.ts, sound.ts, styles/*, public/sounds/*.mp3
/tests    hand.test.ts, game.test.ts, multiplayer.test.ts, store.test.ts
/data     players.json  created on first run, ignored by git
```

- Keep `game.ts` and `hand.ts` free of networking code so they can be tested on their own. Use a seedable random generator so tests can deal known cards. In normal play, seed it from `crypto.randomBytes` for every hand.
- Keep `startServer({ port, dataDir })` exported for Phase 2.
- No new dependencies. Write the hand evaluator yourself; scoring all 21 five-card combinations of 7 cards is fast enough.
- Rename the project everywhere it says blackjack: `package.json` name and description, page title, join screen, `HOSTING.md`, `CREDITS.md` and the startup log.

## Game rules

V1 is No-Limit Texas Hold'em cash game play with blinds and no antes.

| Rule | Value | Host can change |
| --- | --- | --- |
| Variant | No-Limit Texas Hold'em | No |
| Deck | One 52-card deck, freshly shuffled every hand | No |
| Small blind / big blind | 5 / 10 | Yes |
| Antes, straddles | Not in v1 | No |
| Showdown | Every hand still in at showdown is shown automatically | No |
| Odd chip in a split pot | Goes to the winner closest to the left of the button | No |

**A hand:**

1. The button moves one seat to the left, to the next player who is dealt in. On the first hand it goes to a random dealt-in player.
2. The player left of the button posts the small blind, the next one the big blind. **Heads-up (2 players):** the button posts the small blind and acts first before the flop, and last after it.
3. Each player gets two hole cards, one at a time, starting left of the button. Only the owner sees them.
4. **Preflop** betting starts left of the big blind. Then the **flop** (3 board cards), **turn** (1) and **river** (1), each followed by a betting round that starts with the first player still in left of the button.
5. If everyone but one player folds, that player wins the pot at once and their cards stay hidden.
6. Otherwise, after the river betting round, the **showdown**: every remaining hand is revealed and each pot goes to the best hand among the players eligible for it.

**Betting (no limit):**

- Actions: fold, check (only when there is nothing to call), call, bet (when nobody has bet this round), raise, and all in.
- The minimum bet is the big blind. The minimum raise is a raise **by** at least the size of the last full bet or raise in this round (preflop, the big blind counts as the first bet). The maximum is the player's whole stack.
- A player with fewer chips than a call or minimum raise can still go all in for less.
- An all-in raise that is smaller than a full raise does **not** reopen the betting for players who have already acted: they may only call or fold.
- A betting round ends when every player still in has either matched the highest bet or is all in, and everyone has had a chance to act. The big blind gets the option to raise preflop when everyone just called.
- **Uncalled bet:** if a bet or raise is not fully called, the uncalled part goes straight back to the player who made it before the pot is awarded.
- **All in with no more betting possible:** when at most one player still in has chips behind, all remaining hands are turned face up and the rest of the board is dealt with a pause of about 1 s per street.
- Amounts sent by clients for bet and raise are **"to" amounts**: the total the player will have in front of them this betting round, not the extra chips added.

**Side pots:**

- When players are all in for different amounts, the chips are split into a main pot and side pots. Each pot lists the players who can win it.
- Folded players' chips stay in the pots they put them in, but folded players can't win anything.
- Each pot is awarded on its own, smallest (main) pot first. A tie splits that pot evenly; the odd chip rule above handles leftovers.

**Hand ranking, highest first:** straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, one pair, high card.

- The best five cards out of the seven (two hole cards plus five board cards) count, in any combination. The board can play.
- Ace is high, and also low in the A-2-3-4-5 straight ("five high"). No wraparound straights such as Q-K-A-2-3.
- Suits never break ties. Kickers do, up to five cards in total.
- Hand names, used at the table and in the log: "High card, ace", "Pair of kings", "Two pair, aces and sevens", "Three sevens", "Straight, ten high", "Flush, ace high", "Full house, kings over sevens", "Four nines", "Straight flush, nine high", "Royal flush".

## Host, joining and settings

Exactly as in the blackjack project: host token and host link, join screen, waiting room with ready markers, settings locked on Start, joining a game in progress, kicking, the game ending when the last player leaves (with the "Create new game" button on the host link), and the host playing in their own seat.

Differences:

- **Start** needs at least **2** ready players.
- **Joining a game in progress:** the player takes a free seat and is dealt in from the next hand. If every seat is full, they watch until one frees up.
- **Next hand:** a new hand starts by itself after the pause at the end of the previous one, as long as at least 2 seated players have chips and aren't sitting out. Otherwise the table shows "Waiting for players" and starts as soon as there are 2.

| Setting | Default | Allowed range |
| --- | --- | --- |
| Max players | 6 | 2 to 9 |
| Table password | None | Optional, any text |
| Starting chips | 1,000 | 100 to 100,000 |
| Small blind | 5 | 1 up to the big blind |
| Big blind | 10 | The small blind up to starting chips ÷ 10 |
| Turn timer | 30 s; when it runs out the player checks if they can, otherwise folds | 10 to 120 s, or off |

## Chips and usernames

The same as the blackjack project, with poker in place of blackjack. Chips are the player's whole stack: everything they have is on the table, and there is no separate buy-in.

- **File, saving, new usernames, allowed usernames, same username twice:** unchanged. Save after each hand is settled and when a player leaves.
- **Earnings:** go up and down with every settled hand, by what the player won from pots minus what they put in. Borrowing and paying back don't change them.
- **Reset chips** and **Pay back:** allowed in the waiting room, or at the table while the player is not in the current hand (sitting out, waiting for a seat, or between hands). Refused with `cannot_reset` / `cannot_pay_back` otherwise.
- **Out of chips:** a player with 0 chips sits out. When a hand ends with them at 0, they get the same in-page borrow prompt as in blackjack. "Borrow" adds the starting-chips amount to their chips and their debt and logs `<name> borrows 1,000 and now owes 1,000`. "Not now" closes it; a Borrow chips button next to their seat opens it again. Borrowing is refused unless the player is seated, has 0 chips and isn't in the current hand (`cannot_borrow`).
- **Sit out:** a "Sit out next hand" toggle. A player sitting out isn't dealt in and pays no blinds until they turn it off. There are no missed-blind rules in v1. A player whose connection is lost sits out automatically until they come back.

## Phases and turn order

The server owns the current phase, and clients only display it.

| Phase | What happens |
| --- | --- |
| `waiting` | Waiting room before Start, or at the table while fewer than 2 players can play |
| `preflop` | Button moves, blinds posted, hole cards dealt about 300 ms apart, then the first betting round |
| `flop`, `turn`, `river` | Board cards dealt (about 600 ms pause first), then a betting round |
| `showdown` | Remaining hands revealed, pots awarded one at a time, winning five cards highlighted |
| `hand_over` | Results stay on screen, then the next hand starts |

- Pause after a showdown: 4 s. Pause after a hand won without a showdown: 2 s. Both are named constants in `server/table.ts` (`SHOWDOWN_PAUSE_MS`, `FOLD_WIN_PAUSE_MS`).
- Only one player acts at a time, in seat order, and the turn timer restarts for every action.

## Client/server message protocol

The server is the only source of truth. Clients send what the player wants to do, and the server replies with the full table state after every change. Types are defined once in `/shared/types.ts`.

**The big change from blackjack:** `table_state` is no longer the same for everyone. It is built separately for each connection, so that each player gets only their own hole cards.

**Client to server**

| Type | Payload | Allowed when |
| --- | --- | --- |
| `join`, `leave`, `set_ready`, `update_settings`, `start_game`, `reset_chips`, `borrow`, `pay_back`, `kick_player` | As in blackjack | As in blackjack, with the poker timing rules above |
| `action` | `fold`, `check`, `call`, `bet` + amount, `raise` + amount, or `all_in` | That player's turn |
| `sit_out` | sittingOut (true or false) | Seated, any time; takes effect from the next hand |

**Server to client**

| Type | Payload | Sent when |
| --- | --- | --- |
| `server_info`, `joined`, `kicked`, `error` | As in blackjack | As in blackjack |
| `table_state` | phase, settings, hostId, hand number, button / small blind / big blind seats, board cards, pots (amount and eligible player ids), whose turn, timer deadline, server time, log; players (name, chips, debt, earnings, ready, connected, seat, sitting out, in hand, folded, all in, chips in front this round, last action, hole cards or hidden cards, hand name at showdown); and for the receiving player only a `you` block with their hole cards, current hand name and their legal actions right now (can check, call amount, min and max bet or raise "to" amounts) | After every change, one per connection |
| `hand_result` | per pot: amount, winner ids, winning hand name and the five winning cards; per player: net chip change | End of each hand |

Server rules:

- Check every message for the right phase, the right player's turn, host rights, and whether the action and amount are legal right now. A bet or raise must be a whole number between the minimum and the player's stack. A rejected message gets an `error` reply (`action_not_allowed`, `bad_amount`, `not_your_turn`, ...) and changes nothing.
- **Never send another player's hole cards** before that hand is shown at showdown or in an all-in runout. Send them as two hidden cards.
- **Never send the deck or any board card** before it is dealt.
- Never send the host token to anyone. Clients only learn `isHost`.
- Send the full `table_state` after every change rather than partial updates.
- Timers run on the server. Clients get the deadline as a timestamp and count down locally.

## UI screens

The join and waiting-room screens stay as they are, with the poker settings in the panel. The table screen is rebuilt for poker in the same look.

**Table:**

- The same oval green felt and wooden rail. The center holds the five board-card slots and the pot. With side pots, each pot shows as its own chip stack with its amount ("Main 240", "Side 1 · 80").
- Seats all the way around the oval (up to 9), with your own seat at bottom center. Each seat shows the name, chips, the last action ("Check", "Call 20", "Raise to 60", "All in"), two cards (face down for other players, face up for you) and the chips in front of them this round as a stack toward the center.
- A white "D" dealer button next to the button seat, and small "SB" / "BB" tags on the blinds.
- The current player's seat is highlighted with the countdown bar for the turn timer, as in blackjack. Folded players are dimmed and their cards are pulled away. Sitting-out players show "Sitting out".
- Under your own cards, your current hand name ("Pair of sevens"), updated on every street.
- **Action bar:** Fold (F), Check or Call 20 (C), and Bet or Raise to (R) with an amount box, a slider, and preset buttons Min, ½ pot, ¾ pot, Pot and All in. All in keeps the blackjack confirm step ("Confirm all in (1,050)?"). The amount box starts at the minimum raise and is limited to the legal range. Buttons are greyed out when it's not your turn or the action isn't allowed. Check is never shown when there is something to call.
- **Showdown:** remaining hands flip face up, the winning five cards on the board and in the winner's hand are highlighted, and a banner says "Alex wins 240 with a flush, ace high" (or "Alex and Sam split 240 with a straight, ten high"). Pots slide to their winners one at a time.
- The event log keeps its drawer, with entries such as "Alex raises to 60", "Flop: K♠ 7♦ 2♣", "Sam shows two pair, kings and sevens", "Alex wins 240".
- Sit out toggle, Reset chips, Pay back and Borrow chips near your seat; for the host, a kick button on each other player's seat.
- **Phones:** the table must still work on a 390 px-wide phone held upright. Other seats can shrink to name, chips and action; your cards and the action bar stay large.

**Sounds:** the same Kenney Casino Audio files. Card dealt and board card: `card-slide-*`. Showdown flip and fold: `card-place-1`. New hand: `card-shuffle`. Bet, call, raise: `chip-lay-*`. Pot pushed to the winner: `chips-handle-5`. All in: the layered all-in sound. Check: a short soft knock generated with Web Audio. Win and lose jingles as before, for your own hands only. Mute button unchanged.

## Hosting and connecting

The same as the blackjack project, (port 3000).

## Edge cases and disconnects

| Situation | Behavior |
| --- | --- |
| Player disconnects on their own turn | The turn timer runs out and they check or fold. If the turn timer is off, they check or fold after 20 s |
| Player disconnects at any other time | Seat held for 20 s; they stay in the current hand (and get auto-checked or folded on their turns) and sit out later hands until they return |
| Page refresh or reconnect within 20 s | Same seat and same hole cards back, through the saved reconnect token |
| Player leaves or is kicked during a hand | Their hand is folded at once; chips they already put in stay in the pot |
| The button seat or a blind seat is empty after players leave | The button simply moves to the next dealt-in player; no dead-button rules in v1 |
| Only one player left in a hand because the others left | That player wins the pot |
| Fewer than 2 players can play | The table waits in `waiting` and shows "Waiting for players" |
| Bet or raise outside the legal range | Rejected with `bad_amount` |
| Everyone left / server stops / name in use / wrong password / kicked player rejoins / all seats full / broken `players.json` | As in blackjack |

## Phase 2: desktop app (build later)

The same as the blackjack project's Phase 2 (one Windows Electron app with Host game and Join game, the chips file in the user-data folder, a portable `.exe` made with electron-builder), with port 3000 as the default.

## Out of scope for v1

Don't build any of these.

- Other variants (Omaha, Stud, pot limit, fixed limit) and tournaments, including rising blinds
- Antes, straddles, missed-blind or dead-button rules
- Choosing to muck or show at showdown, showing cards after a fold win, rabbit hunting, running it twice
- Pre-action buttons (check/fold in advance), time banks
- Hand history export, stats, odds or equity displays
- More than one table, lobbies, chat, accounts, real money
- Computer-controlled players
- The Electron app, until Phase 2

## Done-when checklist

Phase 1 is finished when every item below passes. Claude Code should check each one and report any it could not verify itself.

- [ ] `npm install && npm start` works in a fresh copy on Windows, starts on port 3000, and prints the host link and LAN URLs
- [ ] Hand evaluator tests pass for every hand category, kickers, exact ties, the wheel (A-2-3-4-5) and steel wheel, no wraparound straights, best 5 of 7, and the board playing for a split
- [ ] Betting engine tests pass for blinds (including heads-up order), min bet, min raise, a short all in that does not reopen betting, the big blind option, uncalled bets returned, a fold win, side pots with three players all in for different amounts, a split pot with an odd chip, and an all-in runout
- [ ] A chip-conservation test: across many random seeded hands, total chips at the table only change by borrowing
- [ ] An automated test with 3 simulated WebSocket clients plays 5 hands without errors
- [ ] No message ever contains another player's hole cards before they are shown, or a board card before it is dealt, and the host token never appears in any message
- [ ] In two browser tabs, the host's setting changes show up for the other player, and settings lock after Start
- [ ] Two players can play 10 full hands with the correct chip counts after each, and the button and blinds move correctly
- [ ] Chips, debt and earnings survive a server restart; a new username gets the starting chips; Reset chips, Borrow and Pay back work
- [ ] Sit out works, and a sitting-out player isn't dealt in or charged blinds
- [ ] A username already at the table and a wrong password are rejected; the host can kick a player, who then can't rejoin with that name
- [ ] The turn timer checks or folds an idle player
- [ ] Refreshing mid-hand returns the player to the same seat with the same cards
- [ ] Closing a tab during that player's turn doesn't freeze the game
- [ ] Out-of-turn actions, non-host settings changes and illegal amounts are rejected without a crash
- [ ] A phone on the same Wi-Fi joins through the LAN URL and can play
- [ ] Sounds play (including on iPhone Safari), and the mute button works
- [ ] No errors appear in the browser console or server log during the steps above

## Instructions for Claude Code

Copy the blackjack project into a new folder, save this doc there as `docs/SPEC.md` (replacing the blackjack spec), start Claude Code in that folder, and paste the Phase 1 prompt.

**Phase 1 prompt**

```
This folder is a copy of a finished, working multiplayer blackjack game.
Read docs/SPEC.md in full: it specifies turning it into a No-Limit Texas
Hold'em game. Then read the existing code before planning.

Keep everything that isn't blackjack: architecture, file layout, coding
style, visual design, host token, join screen, waiting room, reconnect,
kicking, chip store, borrow/debt/earnings/pay back, sounds and HOSTING.md.
Reuse that code; don't rewrite what already works. Replace the rules
engine, round flow, table screen and action controls with poker.
Do not build Phase 2 or anything listed under "Out of scope".

Work in this order:
1. Write a short plan: which files you keep, change, add and delete, how
   per-player table_state will work, and any part of the spec you find
   unclear. Wait for my OK, then do the rest without stopping.
2. hand.ts (hand evaluator) with Vitest tests. Run them and fix until
   they pass.
3. game.ts (betting engine: blinds, actions, min raise, side pots,
   uncalled bets, showdown) and deck.ts, with tests including the
   chip-conservation test. Run and fix until they pass.
4. Shared types and server: table.ts state machine, per-player
   table_state, hole-card privacy, timers, sit out, reconnect.
   Update the multiplayer test to 3 clients playing 5 hands.
5. Client: the poker table, action bar, showdown and sounds, in the
   existing style. Use the screenshot script to check desktop and a
   390 px phone width.
6. Rename blackjack to poker everywhere and update HOSTING.md for
   port 3000.
7. Go through the Done-when checklist. Run everything you can, then list
   what you could not verify and how I can check it by hand.

Rules:
- Use only the existing dependencies. Ask before adding any.
- Keep game logic out of the networking code.
- Commit after each step with a short message.
- Where the spec is unclear, pick the simplest option and list your
  assumptions at the end.
```

After the run, test it yourself with two or three browser tabs and then with your phone. Send fixes as short follow-up prompts, one problem each.
