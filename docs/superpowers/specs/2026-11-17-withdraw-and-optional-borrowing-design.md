# Withdraw and optional borrowing — design

Nov 17, 2026 · approved in conversation

This spec is written so it can be applied to the poker game here and to the **Blackjack with Friends** project, which shares the same chip store, debt and earnings code. Names below (`Player`, `TableState`, `store.set`, `borrow-scrim`) are the ones both projects use. Where a game-specific word appears (hand, round), read it as "the game is not in progress for this player".

## Intent and why

Borrowing chips after a bust is fun but should not be forced on every table, so the host gets a switch. Players who borrowed and then won want a way to cash out: pay back what they owe and bank the rest as profit. "Earnings" becomes the scoreboard of that banked money.

## Goals

- The host can turn borrowing off in the table settings before the game starts.
- A player can withdraw chips from the table. The chips leave their stack, pay down their debt first, and the rest is profit. Earnings reflect it.
- Same rules and numbers in poker and blackjack.

## Non-goals and anti-goals

- No real money, no limits per day, no fees, no approval from the host.
- Withdrawing must never create or destroy chips in a way that breaks the chip-conservation tests: chips only leave the table by withdrawing, and only enter it by borrowing, a reset or a first join.
- Earnings must not quietly keep tracking table wins and losses next to the new meaning. One meaning only.

## Approaches considered

1. **Extend the existing pieces (chosen).** A new `allowBorrowing` setting; a `withdraw` message that replaces `pay_back`; the stored `earnings` number keeps its field and only changes what moves it. No store format change.
2. Track `withdrawn` as its own stored field and derive earnings as `withdrawn - debt`. Cleaner on paper but changes the JSON file format and needs a migration for no visible gain.
3. Keep earnings as table results and add a separate "banked" figure. Rejected: it shows two numbers where the player expects one, and contradicts the example the player gave.

## Rules

### Earnings (new meaning)

`earnings = total withdrawn − total borrowed` (so it also equals the profit you have banked minus the debt you still owe). It is stored as one number and changes only here:

| Event | Chips | Debt | Earnings |
|---|---|---|---|
| Borrow `B` | `+B` | `+B` | `−B` |
| Withdraw `X` | `−X` | `−min(X, debt)` | `+X` |
| Win or lose a hand | changes | same | **unchanged** |
| Reset chips | starting chips | 0 | 0 |

Example: you have 3,000 chips and owe 1,000, so earnings are −1,000. You withdraw 1,500. Debt is paid (1,000), the rest is profit. You now have 1,500 chips, owe 0, and earnings are +500.

Earnings that were saved under the old meaning (table results) are left as they are and follow the new rules from the next event on.

### Optional borrowing

- New setting `allowBorrowing: boolean`, default `true`, in the Table group of the host's settings, shown as an on/off switch labelled "Allow borrowing". Locked once the game starts, like every other setting.
- Off: the out-of-chips prompt never opens, the Borrow button is not drawn, and `borrow` is refused with `borrowing_off` ("Borrowing is turned off at this table"). A player with 0 chips sits out and can still use Reset chips.
- The setting appears in the table rules text ("Borrowing: on / off").
- Validation: it must be a boolean. Settings from older clients that leave it out keep the default.

### Withdraw

- Client message `{ type: 'withdraw', amount: number }`. It replaces `pay_back`, which is removed from the protocol, the server, the client and the tests.
- Allowed only for a seated player who is not in a live hand (same condition as Reset chips and the old Pay back). Refused otherwise with `cannot_withdraw` and a plain message ("You can withdraw once the hand is over", "You need a seat to withdraw").
- `amount` must be a whole number from 1 to the player's chips. Otherwise refused with `bad_amount` (the existing error code for a bad amount; the first draft said `invalid_amount`).
- Effects: `chips −= amount`, `debt −= min(amount, debt)`, `earnings += amount`. Then the store is saved.
- Withdrawing everything is allowed. A player at 0 chips follows the normal out-of-chips rules (borrow prompt if borrowing is on, otherwise sits out).
- Table log line: `<name> withdraws 1,500 and pays off 1,000 of their debt` / `<name> withdraws 500` when there is no debt / `… and still owes 400` when debt remains.
- With no debt the withdraw is a plain cash-out and earnings go up by the amount.

## Screen

- **Top-left of the table screen** (the app bar, where the round label is now): the player's Earnings and a **Withdraw** button next to it. Earnings is removed from the bottom dock. Green when positive, red when negative, as now. The tooltip reads "Money you have withdrawn minus what you owe."
- Debt ("owes 1,000") stays beside the chips in the dock.
- Withdraw is hidden for spectators, disabled with a tooltip while the player is in a live hand, and disabled at 0 chips.
- **Withdraw modal**, built like the borrow modal (`modal-scrim`, focus trap, Escape closes, click outside closes):
  - Title "Withdraw chips". A line with the balance: "You have 3,000 chips and owe 1,000."
  - A number input for the amount, plus two quick buttons: **Pay off debt** (fills `min(chips, debt)`, hidden when there is no debt) and **Max** (fills all chips).
  - A live preview under the input, e.g. "Pays off 1,000 of your debt. 500 goes to your earnings. Earnings become +500."
  - Confirm button "Withdraw 1,500", disabled when the amount is empty, 0, not a whole number or above the chips. A Cancel button.
  - After sending, the button is disabled until the next state arrives, then the modal closes. A server error shows as a toast and the modal stays open.
- The waiting room player list keeps showing `owes …` and `earnings …`.

## Constraints

- Server is the authority: all checks above run on the server; the client checks only for convenience.
- No change to the chip store file format.
- Phone layout: the Earnings and Withdraw pair must fit the top bar at 375px wide without covering the icon row; if it doesn't fit, Earnings wraps under the round label.

## Tests

- Settings: `allowBorrowing` defaults to true, accepts booleans, rejects other types, is locked after start. Table rules text shows it.
- Borrowing off: `borrow` is refused with `borrowing_off`; borrowing on still works as before.
- Withdraw: the example above (3,000 chips, debt 1,000, earnings −1,000, withdraw 1,500 → 1,500 chips, debt 0, earnings +500); withdraw less than the debt (debt stays, earnings rise by the amount); withdraw with no debt; withdraw everything; amount 0, negative, fractional, text and above-chips are refused; refused mid-hand; refused for a spectator.
- Earnings no longer change on hand results; they change on borrow (down) and withdraw (up).
- Persistence: chips, debt and earnings survive a restart after a withdraw.
- Chip conservation: across seeded random hands with random withdrawals and borrows, total chips only change by those two actions.
- The old `pay_back` tests are removed or rewritten as withdraw tests.

## Left to the builder

- Exact wording of the log line and toasts, exact styling of the top-left cluster and the modal, and how the existing `docs/SPEC.md` sections (Earnings, Out of chips, Controls, Acceptance) are reworded to match.
- For blackjack: the same work, with "live hand" replaced by blackjack's "round in progress" check and `startingChips` / `onBorrow` / `onPayBack` names matched to that code.
