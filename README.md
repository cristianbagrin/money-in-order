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
| **History** | Every transaction, searchable, filterable by category; edit with the same pills as everywhere else. |
| **Review** | What this month means in plain words, this month vs. your plan, the last six months, weeks, category trends, your notes, and **Copy for Claude**. |

Everything important can be undone for a few seconds (and with ⌘Z on a laptop). Sounds can be switched off in Settings.

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

Turning on sync creates a 20-character code (about 100 bits). The code never leaves your devices; from it they derive

- a **vault id** (`SHA-256("money-in-order/id/" + code)`) that names the blob on the server, and
- an **AES-GCM key** (`SHA-256("money-in-order/key/" + code)`) that encrypts it.

The server (`netlify/functions/vault.mts`, Netlify Blobs) stores one gzip-then-encrypted blob per vault and only ever sees ciphertext.
Every write must name the revision it was based on, so two devices can't silently overwrite each other: the loser gets `412`, pulls, merges and retries.
Records carry an update timestamp and tombstones, and merging keeps the newest version of each record, so devices converge whatever order they sync in.

Lose the code and you lose access to the synced copy (each device still has its full local data, and **Review → Your data → Backup** saves a file).

## Development

```sh
npm install
npm run dev          # UI only, no sync endpoint
npm test             # budget math, targets, daily allowance, counting, merge
npm run serve        # build + local server with a real Blobs emulator: sync works between tabs on http://localhost:4174
```

Code map:

- `src/lib/budget.ts`: all budget math (pure functions over an index of the data)
- `src/lib/store.ts`: data, persistence hooks and every mutation
- `src/lib/sync.ts`: encryption and the pull/merge/push loop; `src/lib/merge.ts`: the record merge
- `src/lib/export.ts`: the Claude summary and CSV
- `src/views/*`: screens; `src/styles.css`: the whole design system

## Deploying

Netlify: connect the repo (build command and publish dir come from `netlify.toml`), or `netlify deploy --prod`.
The sync function needs no configuration; Blobs is provisioned automatically.
