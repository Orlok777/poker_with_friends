# Withdraw and Optional Borrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host turn borrowing off, and let players withdraw chips (paying debt first, the rest becoming profit) with Earnings redefined as withdrawn minus owed.

**Architecture:** One new boolean setting, one new `withdraw` client message that replaces `pay_back`, and a changed rule for what moves the stored `earnings` number. The split of a withdrawal into debt paid and profit lives in one shared function used by server and client. No change to the chip store file format.

**Tech Stack:** TypeScript, Node + `ws`, Vite client with no framework, Vitest (`npm test`, `npm run typecheck`).

**Spec:** `docs/superpowers/specs/2026-11-17-withdraw-and-optional-borrowing-design.md`

## Global Constraints

- Earnings = total withdrawn − total borrowed. Borrow `B`: chips +B, debt +B, earnings −B. Withdraw `X`: chips −X, debt −min(X, debt), earnings +X. Hand results and `settle()` no longer touch earnings. Reset chips zeroes chips→starting, debt 0, earnings 0.
- Withdraw allowed only for a seated-or-waiting player not in a live hand (same check as Reset chips: `inLiveHand` on the client, `this.inLiveHand(p)` on the server). The old `pay_back` message, `onPayBack`, `cannot_pay_back` and both Pay back buttons are removed.
- Amount must be a whole number from 1 to the player's chips; error code `bad_amount` (the existing code, used instead of the spec's `invalid_amount`, since it already means "bad amount").
- `allowBorrowing` defaults to `true`, is a boolean, locked after start. Off → `borrow` refused with `borrowing_off`.
- Log lines: `<name> withdraws 1,500 and pays off 1,000 of their debt`; `<name> withdraws 500` when there was no debt; `<name> withdraws 400 and still owes 600` when debt remains after. Numbers via the server's existing `n()` formatter.
- Server is the authority; client checks are conveniences. Phone layout (375px) must still work.
- Do not commit unless the user asks.

## Review Focus

- Withdrawing exactly all chips (chips 0 after): the player must fall into the normal out-of-chips flow (borrow prompt only if borrowing is on).
- Borrowing off and a player at 0 chips: no prompt, no Borrow button, they can still Reset chips.
- Amount typed as `0`, `-5`, `12.5`, `""`, `"abc"`, or more than chips: confirm disabled, server refuses with `bad_amount`.
- A withdraw message sent mid-hand or by a spectator: refused, state unchanged.
- Old saved earnings (table-result values) load and then follow the new rules without errors.

---

### Task 1: Optional borrowing (setting and server refusal)

**Files:**
- Modify: `shared/types.ts` (Settings, DEFAULT_SETTINGS, validateSettings, ErrorCode)
- Modify: `server/table.ts` (`onBorrow`)
- Test: `tests/multiplayer.test.ts`

**Interfaces:**
- Produces: `Settings.allowBorrowing: boolean` (also on `PublicSettings`), `DEFAULT_SETTINGS.allowBorrowing = true`, `ErrorCode` member `'borrowing_off'`.

- [ ] **Step 1: Write failing tests** in `tests/multiplayer.test.ts`: (a) in the existing "rejects invalid settings" list add `{ allowBorrowing: 'yes' }` and `{ allowBorrowing: null }`; (b) new test `'allowBorrowing defaults to on, can be switched off by the host, and locks at start'` asserting `alex.state!.settings.allowBorrowing === true`, then after `update_settings { allowBorrowing: false }` it is `false`, then after `start_game` an update returns `settings_locked`; (c) new test `'refuses borrowing when it is turned off'`: host sets it false, game starts, a player with 0 chips (use the all-in `rigged` setup from the existing borrowing test) sends `borrow` and `expectError` code is `borrowing_off`, chips stay 0.
- [ ] **Step 2: Run** `npx vitest run tests/multiplayer.test.ts -t "allowBorrowing|borrowing"`. Expected: FAIL.
- [ ] **Step 3: Implement** the setting in `shared/types.ts` (validation message `Allow borrowing must be on or off`) and add the first check in `onBorrow`: `if (!this.settings.allowBorrowing) return this.sendError(conn, 'borrowing_off', 'Borrowing is turned off at this table')`.
- [ ] **Step 4: Run** the same command, then `npm run typecheck`. Expected: PASS, no type errors.

### Task 2: Withdraw and the new earnings rule (server)

**Files:**
- Create: `shared/withdraw.ts`
- Modify: `shared/types.ts` (ClientMsg: remove `pay_back`, add `{ type: 'withdraw'; amount: number }`; ErrorCode: remove `cannot_pay_back`, add `cannot_withdraw`)
- Modify: `server/table.ts` (dispatch at ~line 272, `onPayBack` → `onWithdraw`, `onBorrow` earnings, `settle()` ~line 844)
- Test: `tests/withdraw.test.ts` (new), `tests/multiplayer.test.ts`

**Interfaces:**
- Produces: `splitWithdrawal(debt: number, amount: number): { debtPaid: number; profit: number }` in `shared/withdraw.ts`, with `debtPaid = min(debt, amount)` and `profit = amount - debtPaid`. Used by the server now and the client in Task 4.

- [ ] **Step 1: Write failing tests.** `tests/withdraw.test.ts`: `splitWithdrawal(1000, 1500)` → `{ debtPaid: 1000, profit: 500 }`; `(1000, 400)` → `{ 400, 0 }`; `(0, 500)` → `{ 0, 500 }`. In `tests/multiplayer.test.ts`, add a helper that boots a server, closes it, writes `players.json` into its `dataDir` and boots again on it (same pattern as the "chips and usernames" test), then a new `describe('withdrawing')` with: the spec example (seed Alex `{chips: 3000, debt: 1000, earnings: -1000}`, withdraw 1500 → chips 1500, debt 0, earnings 500, log line `Alex withdraws 1,500 and pays off 1,000 of their debt`, `players.json` matches); partial debt (withdraw 400 → debt 600, earnings −600, log `… withdraws 400 and still owes 600`); no debt (seed chips 1000, withdraw 500 → earnings 500, log `Alex withdraws 500`); withdraw all chips; `bad_amount` for `0`, `-5`, `12.5`, `'50' as never`, and `chips + 1`; refused with `cannot_withdraw` mid-hand and for a spectator. Update existing tests: `players.json` expectation at ~line 619 becomes plain chips (`[winnerName]: 1010`, `[loserName]: 990`) and `back.me().earnings` at ~637 becomes `0`; in the borrowing test earnings after losing (~676) become `0`, after borrow stay `-1000`, `pay_back` at ~694/705/709 and ~447 become `withdraw` (mid-hand → `cannot_withdraw`; after restart withdraw 1000 → chips 0, debt 0, earnings 0, log `… withdraws 1,000 and pays off 1,000 of their debt`); rename that `describe` to `'borrowing and withdrawing'`. Add one invariant check in the withdraw describe: after a borrow-then-withdraw sequence `earnings === withdrawnTotal − debt`.
- [ ] **Step 2: Run** `npx vitest run tests/withdraw.test.ts tests/multiplayer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `splitWithdrawal`; the types; `private onWithdraw(conn: Connection, p: Player, amount: unknown): void` in `server/table.ts` (checks in order: `inLiveHand` → `cannot_withdraw` "You can withdraw once the hand is over"; amount whole number 1..chips → `bad_amount`; then apply, `saveChips`, `addLog`, `broadcast`, and `maybeStartHand` is not needed). A spectator (no seat, not in a hand) in the waiting room may withdraw like Reset chips can; the spectator test therefore uses a player who `inLiveHand` is false but has `seat === null` only if the existing code refuses them. If `p.seat === null` after the game started, refuse with `cannot_withdraw` "You need a seat to withdraw". In `onBorrow` add `p.earnings -= amount`; delete the `p.earnings += net` loop in `settle()` (keep the store save).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: all PASS (the engine `net` tests are unaffected).

### Task 3: Client — the borrowing switch and hiding Borrow

**Files:**
- Modify: `client/waiting.ts` (Field type, GROUPS, `buildField`), `client/borrow.ts` (`isOut`), `client/table.ts` (Borrow chips button ~line 436, `rulesText`), `client/panels.ts` (`renderRules`)

**Interfaces:**
- Consumes: `PublicSettings.allowBorrowing` from Task 1.

- [ ] **Step 1: Implement** a `{ kind: 'switch'; key: 'allowBorrowing'; label: string }` Field, built like the turn-timer On/Off `segmented` control (`['on','On'],['off','Off']`, sends `{ allowBorrowing: v === 'on' }`, `set(s.allowBorrowing ? 'on' : 'off', editable)`); add it to the Table group after Starting chips with label `Allow borrowing`.
- [ ] **Step 2: Implement** gating: `isOut` in `client/borrow.ts` returns false when `!s.settings.allowBorrowing`; the `Borrow chips` button in `renderMe` is drawn only when `s.settings.allowBorrowing`; add the row `['Borrowing', st.allowBorrowing ? 'On' : 'Off']` after Starting chips in `renderRules`.
- [ ] **Step 3: Verify** `npm run typecheck` passes. Then run the app (`npm start`), open it in the browser, as host switch Allow borrowing Off in the waiting room, check the setting shows in the Table rules drawer. Expected: switch works and is read-only for non-hosts. (Full out-of-chips behaviour is covered in Task 4's browser check.)

### Task 4: Client — Withdraw modal and top-left Earnings

**Files:**
- Create: `client/withdraw.ts`
- Modify: `client/index.html` (new `withdraw-scrim` modal after `borrow-scrim`, new `<div class="bank">` in the table `app-bar` left of the icon row holding `<span id="bank-earnings">` and `<button id="withdraw-btn">`, replace `payback-btn-wait` with `withdraw-btn-wait`), `client/main.ts` (call `initWithdraw()` and `renderWithdraw(s, self)` next to the borrow calls), `client/table.ts` (remove `earningsEl` from `renderMe`, remove the Pay back button, update the earnings tooltip to `Money you have withdrawn minus what you owe.`, set `round-label` text beside the bank cluster if layout needs it), `client/waiting.ts` (replace the Pay back button wiring and `payback-label` with `withdraw-btn-wait` that calls `openWithdraw()`), `client/styles/panels.css` and `client/styles/table.css` (modal field, quick buttons, preview line, `.bank` cluster, phone rules)

**Interfaces:**
- Consumes: `splitWithdrawal` (Task 2), `earningsEl(earnings: number): HTMLElement` (existing in `client/table.ts`), `send`, `me` from `client/app.ts`.
- Produces: `initWithdraw(): void`, `renderWithdraw(s: TableState, self: PlayerView): void` (updates the top-left earnings/Withdraw button and the open modal's preview), `openWithdraw(): void`.

- [ ] **Step 1: Write failing test** `tests/withdraw.test.ts`: add `describe('parseWithdrawAmount')` for a pure helper `parseWithdrawAmount(text: string, chips: number): number | null` exported from `client/withdraw.ts` returning the whole number when `1 <= n <= chips` and `null` for `''`, `'0'`, `'-5'`, `'12.5'`, `'abc'`, `chips + 1`; `'1500'` with 3000 → `1500`.
- [ ] **Step 2: Run** `npx vitest run tests/withdraw.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `client/withdraw.ts`, modelled on `client/borrow.ts` (same `modal-scrim`, focus trap, Escape and outside click close, `busy` flag cleared on the next state, toast on server error via the existing error path): title `Withdraw chips`; balance line `You have 3,000 chips and owe 1,000.`; number input; buttons `Pay off debt` (fills `min(chips, debt)`, hidden when debt is 0) and `Max`; preview line from `splitWithdrawal`, e.g. `Pays off 1,000 of your debt. 500 goes to your earnings. Earnings become +500.` (new earnings = `self.earnings + amount`); confirm `Withdraw 1,500` disabled when `parseWithdrawAmount` is null; sends `{ type: 'withdraw', amount }` and plays `playChip()`.
- [ ] **Step 4: Implement the screen changes** listed under Files. The top-left cluster shows `earningsEl(self.earnings)` and the Withdraw button; the button is hidden for spectators, disabled with title `You can withdraw once the hand is over` while `inLiveHand`, disabled at 0 chips. The waiting-room button follows the same rules minus the live-hand case.
- [ ] **Step 5: Verify** `npm test` and `npm run typecheck`. Then in the browser (`npm start`, two tabs, joined and ready, game started): check the spec's example by seeding `data/players.json`-style state or playing until broke and borrowing; confirm Withdraw opens the modal, `Pay off debt` and `Max` fill the field, the preview matches, confirming updates Earnings and chips and writes the log line; confirm the top bar at a 375px-wide viewport (`resize_window` mobile) keeps the icon row visible; confirm with Allow borrowing off a 0-chip player sees no prompt and no Borrow button but still has Reset chips and Withdraw is disabled.

### Task 5: Spec docs

**Files:**
- Modify: `docs/SPEC.md` (lines ~9, 110, 111, 112, 142, 174, 179, 231, 255)

- [ ] **Step 1: Update** the Earnings bullet (new meaning, table above), the Reset chips / Pay back bullet (becomes Reset chips and Withdraw, errors `cannot_reset`, `cannot_withdraw`, `bad_amount`), the Out of chips bullet (borrowing only when `allowBorrowing`, error `borrowing_off`), the message table (`pay_back` → `withdraw`), the Dock and Controls sections (Earnings and Withdraw top-left, no Pay back), and the acceptance checklist (Withdraw works, borrowing switch works). Replace remaining "pay back" mentions.
- [ ] **Step 2: Verify** `grep -n -i "pay back\|pay_back" docs/SPEC.md` shows only intentional historical mentions, and run `npm test` once more. Expected: all PASS.
