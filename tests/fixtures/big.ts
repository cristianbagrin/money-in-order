// A big, realistic budget for stress tests: years of daily spending in several currencies, monthly
// income from two sources, a plan every month, cash and investment accounts counted now and then.
// Deterministic (seeded), so a failure reproduces.

import { addMonths, daysInMonth, pad } from '../../src/lib/dates'
import { emptyDB, RTA, type Account, type Assign, type Category, type Count, type DB, type Group, type Txn } from '../../src/lib/types'

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BigOpts {
  /** first month, "YYYY-MM" */
  from: string
  months: number
  /** spending entries per day, on average */
  perDay?: number
  seed?: number
}

export function bigDB(opts: BigOpts): DB {
  const r = rng(opts.seed ?? 1)
  const perDay = opts.perDay ?? 4
  const db = emptyDB()
  let u = 1_700_000_000_000
  const id = (p: string, n: number | string) => `${p}${n}`
  const groups: Group[] = ['Every day', 'Fixed', 'Flexible', 'Future'].map((name, i) => ({ id: id('g', i), u: ++u, name, order: i }))
  for (const g of groups) db.groups[g.id] = g
  const cats: Category[] = []
  const addCat = (c: Omit<Category, 'id' | 'u' | 'order'>) => {
    const cat: Category = { id: id('c', cats.length), u: ++u, order: cats.filter((x) => x.group === c.group).length, ...c }
    cats.push(cat)
    db.cats[cat.id] = cat
    return cat
  }
  const living = addCat({ name: 'Living', group: 'g0', daily: true })
  const fixed = ['Rent', 'Phone', 'Gym', 'Internet', 'Insurance', 'Streaming'].map((name, i) =>
    addCat({ name, group: 'g1', target: { kind: 'monthly', amount: (i + 1) * 150000 } }),
  )
  const flexible = ['Purchases', 'Trips', 'Gifts', 'Health', 'Books', 'Clothes', 'Home', 'Other', 'Eating out', 'Taxi', 'Coffee', 'Games', 'Hobbies', 'Kids', 'Pets'].map(
    (name, i) => addCat({ name, group: 'g2', ...(i % 4 === 0 ? { target: { kind: 'topup' as const, amount: 200000 } } : {}) }),
  )
  const brokerage: Account = { id: 'a-broker', u: ++u, name: 'Brokerage', cur: 'USD', order: 3, invest: 1 }
  const future = addCat({ name: 'Future me', group: 'g3', saving: true, acct: brokerage.id })
  const emergency = addCat({ name: 'Emergency', group: 'g3', saving: true, target: { kind: 'goal', amount: 50000000 } })
  const trip = addCat({ name: 'Japan trip', group: 'g3', saving: true, target: { kind: 'goal', amount: 8000000, by: addMonths(opts.from, opts.months + 6) } })
  addCat({ name: 'Old thing', group: 'g2', archived: 1 })

  const accounts: Account[] = [
    { id: 'a-bank', u: ++u, name: 'Bank', cur: 'TWD', order: 0 },
    { id: 'a-cash', u: ++u, name: 'Cash', cur: 'TWD', order: 1 },
    { id: 'a-eur', u: ++u, name: 'Revolut EUR', cur: 'EUR', order: 2 },
    brokerage,
  ]
  for (const a of accounts) db.accounts[a.id] = a

  const rates = { EUR: 35, USD: 32, PLN: 8, JPY: 0.21 }
  db.meta.settings = {
    id: 'settings',
    u: ++u,
    base: 'TWD',
    rates,
    ratesAt: 0,
    savingsTarget: 0.2,
    extraCurrencies: ['EUR', 'USD'],
    ready: 1,
    sources: [
      { id: 's-job', name: 'Job' },
      { id: 's-free', name: 'Freelance' },
    ],
  }
  db.meta.rates = { id: 'rates', u: ++u, table: { base: 'TWD', rates, at: 0 } }

  let n = 0
  const txn = (t: Omit<Txn, 'id' | 'u'>) => {
    const rec: Txn = { id: id('t', n++), u: ++u, ...t }
    db.txns[rec.id] = rec
  }
  const assign = (m: string, cat: string, amt: number) => {
    const a: Assign = { id: `${m}|${cat}`, u: ++u, m, cat, amt }
    db.assigns[a.id] = a
  }
  const spendCats = [living, living, living, ...flexible]
  let count = 0
  for (let k = 0; k < opts.months; k++) {
    const m = addMonths(opts.from, k)
    if (k === 0) txn({ date: `${m}-01`, cat: RTA, amt: 30000000, cur: 'TWD', base: 30000000, kind: 'start', note: 'Starting balance' })
    txn({ date: `${m}-05`, cat: RTA, amt: 9000000, cur: 'TWD', base: 9000000, src: 's-job', acct: 'a-bank' })
    if (r() < 0.5) txn({ date: `${m}-20`, cat: RTA, amt: 50000, cur: 'EUR', base: 50000 * 35, src: 's-free', acct: 'a-eur' })
    assign(m, living.id, 1800000)
    for (const c of fixed) assign(m, c.id, (c.target as { amount: number }).amount)
    for (const c of flexible) if (r() < 0.6) assign(m, c.id, Math.round(r() * 30) * 10000)
    assign(m, future.id, 1000000)
    assign(m, emergency.id, 500000)
    assign(m, trip.id, 300000)
    const days = daysInMonth(m)
    for (let d = 1; d <= days; d++) {
      const date = `${m}-${pad(d)}`
      const times = Math.floor(r() * perDay * 2)
      for (let i = 0; i < times; i++) {
        const cat = spendCats[Math.floor(r() * spendCats.length)]
        const foreign = r() < 0.08
        const amt = -Math.round((50 + r() * (cat === living ? 600 : 3000)) * (foreign ? 3 : 100))
        txn({
          date,
          cat: cat.id,
          amt,
          cur: foreign ? 'EUR' : 'TWD',
          base: foreign ? Math.round(amt * 35) : amt,
          ...(r() < 0.3 ? { note: ['lunch', 'groceries', 'bus', 'gift for mom', 'pharmacy', 'coffee'][Math.floor(r() * 6)] } : {}),
          acct: foreign ? 'a-eur' : r() < 0.7 ? 'a-bank' : 'a-cash',
        })
      }
    }
    for (const c of fixed) txn({ date: `${m}-0${1 + Math.floor(r() * 8)}`, cat: c.id, amt: -(c.target as { amount: number }).amount, cur: 'TWD', base: -(c.target as { amount: number }).amount, acct: 'a-bank' })
    txn({ date: `${m}-10`, cat: future.id, amt: -1000000, cur: 'TWD', base: -1000000, acct: 'a-bank' })
    // now and then money moves between accounts: cash to cash, or straight into the brokerage
    if (k % 3 === 0) txn({ date: `${m}-12`, cat: RTA, amt: -500000, cur: 'TWD', base: 0, kind: 'move', acct: 'a-bank', to: 'a-cash' })
    if (k % 3 === 1) txn({ date: `${m}-15`, cat: RTA, amt: -3200000, cur: 'TWD', base: 0, kind: 'move', acct: 'a-bank', to: brokerage.id, toAmt: 100000 })
    if (k % 2 === 1) {
      const c: Count = {
        id: id('n', count++),
        u: ++u,
        date: `${m}-${pad(days)}`,
        bal: { 'a-bank': 20000000 + Math.round(r() * 1e6), 'a-cash': 500000, 'a-eur': 100000, 'a-broker': 1000000 * (k + 1) },
        curs: { 'a-bank': 'TWD', 'a-cash': 'TWD', 'a-eur': 'EUR', 'a-broker': 'USD' },
        rates,
        total: 0,
        expected: 0,
      }
      db.counts[c.id] = c
      txn({ date: c.date, cat: RTA, amt: -50000, cur: 'TWD', base: -50000, kind: 'adj', note: 'Unlogged spending' })
    }
    db.notes[m] = { id: m, u: ++u, text: `Month ${k}: fine.` }
  }
  return db
}
