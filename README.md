# Money in Order

A zero-based budget (YNAB-style) for one person, built around two habits:

- **Every day:** type the amount, tap where it went. The app tells you what's left for today.
- **Every month:** count your money, log income, fund your targets, write two lines about last month.

It runs on the iPhone (Add to Home Screen) and on a laptop in the browser, works offline, and keeps
devices in sync with end-to-end encryption.

## How it works

| Screen | What it's for |
| --- | --- |
| **Today** | What's left for today, and the register: type the amount, tap where it went (every category, plus Income). Each bubble shows what the category will have *after* this purchase. Phones get a keypad; on a laptop you just type, arrow to a category and press Enter. |
| **Plan** | Ready to assign, and every category with an Assigned field (type sums like `6000+500`, ↑/↓ to move), Spent and Available. Click a name or note to edit it, hold and drag to reorder, tap Available for details (Cover overspending, assign suggestions, target). |
| **History** | Every transaction by day, searchable, filterable by category and period; edit with the same pills as everywhere else. |
| **Review** | A month in plain words against its usual: your usual day and month, what stands out, where it went (categories or groups), net worth over time, income by source, goals, and **Copy for Claude**. |

Everything important can be undone for a few seconds (and with ⌘Z on a laptop). Sounds are kept for moments that mean something (logging, a finished plan, mistakes, deletes); they can be switched off in Settings.

### The rules the math follows

- Money is one pool, kept in your **budget currency** (e.g. TWD). Anything entered in another currency
  is converted at the day's rate (fetched automatically, at most twice a day). You can switch the budget currency any time; everything converts.
- `Ready to assign = everything that came in − everything assigned` (money assigned to future months is held aside).
- A category's `available = last month's available + assigned + activity`. Leftovers roll over; overspending rolls over as a negative until you cover it.
- **Targets:** *Monthly* (set aside X every month), *Top up* (bring the category up to X), *Goal* (reach X, optionally by a month, spread evenly).
- **Daily allowance:** for categories marked *daily*, `available at the start of today ÷ days left (incl. today)`.
- **Savings rate:** money assigned to *savings* categories in a month ÷ that month's income.
- **Counting money:** you type each account's real balance. The difference from what the budget expected is split into
  exchange-rate drift (from the previous count's foreign balances) and the rest (usually unlogged spending), and booked so the plan matches reality.
  Accounts only exist for counting; you don't pick an account when you log spending.

## Sync and privacy

Sync works with an account: an email and a password (Settings → Sync). The password never leaves your devices. From it they derive

- the account's **secret**: `PBKDF2-SHA256(password, salt = "money-in-order/account/" + email, 310,000 rounds)`,
- a **vault id** (`SHA-256("money-in-order/id/" + secret)`) that names the blob on the server, and
- an **AES-GCM key** (`SHA-256("money-in-order/key/" + secret)`) that encrypts it.

The server (`netlify/functions/vault.mts`, Netlify Blobs) stores a gzip-then-encrypted snapshot per vault plus a short log of encrypted changes, and only ever sees ciphertext.
An edit uploads only the records written since the device's last upload (a change of a few hundred bytes), and a device that syncs downloads only the changes it lacks.
Merging is commutative and idempotent, so changes are appended without any locking; once 30 have piled up, the next device to upload folds them into a new snapshot.
`netlify/functions/account.mts` only notes that a hash of an email has an account, so one email can't get two budgets and a sign-in can say "wrong password".
Every snapshot write must name the revision it was based on, so two devices can't silently overwrite each other: the loser gets `412`, pulls, merges and retries.
Records carry an update timestamp and tombstones, and merging keeps the newest version of each record, so devices converge whatever order they sync in.

There is no password reset: the server can't decrypt anything, so a forgotten password means losing the synced copy (each device still has its full local data, and **Settings → Your data → Save backup** saves a file).
Devices that synced with a 20-character code before accounts existed keep syncing until they sign in.

## Development

```sh
npm install
npm run dev          # UI only, no sync endpoint
npm test             # budget math, targets, counting, merge, tabs and sync, and a randomized stress test
STRESS_SEEDS=80 STRESS_STEPS=400 npm test   # the stress test, much harder
npm run serve        # build + local server with a real Blobs emulator: sync works between tabs on http://localhost:4174
```

Code map:

- `src/lib/budget.ts`: all budget math (pure functions over an index of the data)
- `src/lib/plan.ts`: the planner (suggestions, Fill in, how far ahead the money goes)
- `src/lib/accounts.ts`: balances, investments and net worth
- `src/lib/compare.ts`, `src/lib/insights.ts`: Review's figures (a month against its usual, savings, goals)
- `src/lib/store.ts`: data, undo and every mutation; `src/lib/persist.ts`: IndexedDB, safe across tabs and reloads
- `src/lib/sync.ts`: encryption and the pull/merge/push loop; `src/lib/merge.ts`: the record merge
- `src/lib/export.ts`: the Claude summary and CSV
- `src/views/*`: screens; `src/styles.css`: the whole design system

## Deploying

Netlify: connect the repo (build command and publish dir come from `netlify.toml`), or `netlify deploy --prod`.
The sync function needs no configuration; Blobs is provisioned automatically.
