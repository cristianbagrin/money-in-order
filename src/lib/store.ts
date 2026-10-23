import { balances, investmentsInPlan } from './accounts'
import { buildIndex, DEFAULT_SETTINGS, monthView, settingsOf, type Index } from './budget'
import { isoDate } from './dates'
import { edit, repair, same } from './merge'
import { convert, type Rates } from './money'
import { active, occurrences, repeatsOf } from './repeat'
import {
  COLLECTIONS,
  emptyDB,
  RTA,
  type Account,
  type Assign,
  type Category,
  type CollectionName,
  type Count,
  type DB,
  type Group,
  type ID,
  type Month,
  type RateTable,
  type Rec,
  type Repeat,
  type Settings,
  type Source,
  type Txn,
} from './types'

type Listener = () => void

export interface Persistence {
  save(db: DB): void
  /** a record was just written here (called synchronously, before save) */
  wrote?(name: CollectionName, rec: Rec): void
  /** write what's pending now */
  flush?(): Promise<void>
  /** take in what other tabs saved */
  pull?(): Promise<void>
  /** the next save is a different budget (see swapDB): store it as is, under a new epoch */
  replace?(): void
  /** the epoch of the budget held here */
  epoch?(): string
}

let db: DB = emptyDB()
let ix: Index | null = null
let lastStamp = 0
let persistence: Persistence | null = null
const listeners = new Set<Listener>()
const changeListeners = new Set<Listener>()

export function uid(): ID {
  const a = new Uint8Array(9)
  crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''))
}

/** Monotonic timestamp so two edits in the same millisecond still order correctly. */
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

export function getDB(): DB {
  return db
}

export function getIndex(): Index {
  if (!ix) ix = buildIndex(db)
  return ix
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Called only for local edits (not for data arriving from sync). */
export function onLocalChange(fn: Listener): () => void {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

function emit() {
  ix = null
  persistence?.save(db)
  for (const fn of listeners) fn()
}

export function setPersistence(p: Persistence | null) {
  persistence = p
}

/** Resolves once everything so far is saved on this device. */
export function persistNow(): Promise<void> {
  return persistence?.flush?.() ?? Promise.resolve()
}

/** Replace the whole database (startup load, sync merge, restore from backup). */
export function replaceDB(next: DB, opts: { local?: boolean } = {}) {
  const fixed = emptyDB()
  for (const name of COLLECTIONS) (fixed as unknown as Record<string, unknown>)[name] = next[name] ?? {}
  db = repair(fixed)
  for (const name of COLLECTIONS) {
    for (const r of Object.values(db[name]) as Rec[]) if (r.u > lastStamp) lastStamp = r.u
  }
  emit()
  if (opts.local) for (const fn of changeListeners) fn()
}

/**
 * Swap in a different budget (joined from another device). Nothing of the current one is kept or merged:
 * undo history goes, and it is stored under a new epoch, so a tab still holding the old budget drops it.
 */
export function swapDB(next: DB) {
  persistence?.replace?.()
  clearUndo()
  replaceDB(next)
}

/** Which budget this is: changes only when a different one is swapped in, here or in another tab. */
export function dbEpoch(): string {
  return persistence?.epoch?.() ?? ''
}

/** Take in what other tabs saved (or the different budget one of them swapped in). */
export function pullNow(): Promise<void> {
  return persistence?.pull?.() ?? Promise.resolve()
}

type Patch = { [K in CollectionName]?: NonNullable<DB[K][keyof DB[K]]>[] }

// ---------------------------------------------------------------- undo
//
// Wrap a user action in undoable(): every record it touches is remembered as it was before and after,
// and undo() writes back only the fields the action changed (as fresh edits, so undo syncs like anything
// else, and edits made since to other fields, here or on another device, stay).

interface Recording {
  label: string
  /** "collection|id" -> the record before the action (null = it didn't exist) */
  prev: Map<string, Rec | null>
  restore?: () => void
}

export interface UndoEntry {
  label: string
  at: number
  /** "collection|id" -> the record before the action (null = it didn't exist) */
  prev: Map<string, Rec | null>
  /** the same records right after the action */
  next: Map<string, Rec | null>
  restore?: () => void
}

let recording: Recording | null = null
const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
/** Run fn as one undoable step. restore() runs after an undo (e.g. to put the typed amount back). */
export function undoable<T>(label: string, fn: () => T, restore?: () => void): T {
  if (recording) return fn()
  const rec: Recording = { label, prev: new Map(), restore }
  recording = rec
  try {
    return fn()
  } finally {
    recording = null
    if (rec.prev.size) {
      const next = new Map<string, Rec | null>()
      for (const key of rec.prev.keys()) next.set(key, lookup(key))
      undoStack.push({ label, at: Date.now(), prev: rec.prev, next, restore })
      if (undoStack.length > 50) undoStack.shift()
      redoStack.length = 0
    }
  }
}

export function lastUndo(): UndoEntry | null {
  return undoStack[undoStack.length - 1] ?? null
}

type Row = Record<string, unknown>

/**
 * Go from `from` back to `to`: the fields that differ between them get `to`'s values on the current
 * record, every other field keeps whatever it holds now.
 */
function revert(to: Map<string, Rec | null>, from: Map<string, Rec | null>) {
  const patch: Record<string, Rec[]> = {}
  for (const [key, want] of to) {
    const [name, id] = splitKey(key)
    const had = from.get(key) ?? null
    const cur = (db[name as CollectionName] as Record<ID, Rec>)[id]
    let next: Row | null = null
    if (!want) {
      if (cur && !cur.d) next = { ...cur, d: 1 }
    } else if (!cur || !had) {
      next = { ...cur, ...want }
      if (!want.d) delete next.d
    } else {
      next = { ...cur }
      const w = want as unknown as Row
      const h = had as unknown as Row
      for (const k of new Set([...Object.keys(w), ...Object.keys(h)])) {
        if (k === 'id' || k === 'u' || k === 'd' || k === 'f' || same(w[k], h[k])) continue
        if (w[k] === undefined) delete next[k]
        else next[k] = w[k]
      }
      if (!want.d !== !had.d) {
        if (want.d) next.d = 1
        else delete next.d
      }
    }
    if (next) (patch[name] ??= []).push(next as unknown as Rec)
  }
  commit(patch as Patch)
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('|')
  return [key.slice(0, i), key.slice(i + 1)]
}

function lookup(key: string): Rec | null {
  const [name, id] = splitKey(key)
  return (db[name as CollectionName] as Record<ID, Rec>)[id] ?? null
}

export function undo(): UndoEntry | null {
  const e = undoStack.pop()
  if (!e) return null
  revert(e.prev, e.next)
  redoStack.push({ label: e.label, at: Date.now(), prev: e.next, next: e.prev })
  e.restore?.()
  return e
}

export function redo(): UndoEntry | null {
  const e = redoStack.pop()
  if (!e) return null
  revert(e.prev, e.next)
  undoStack.push({ label: e.label, at: Date.now(), prev: e.next, next: e.prev })
  return e
}

/**
 * Write records. The fields that changed get a fresh timestamp; unchanged records aren't rewritten.
 * `asStamped`: new records keep the time they carry (see logRepeats).
 */
export function commit(patch: Patch, asStamped = false) {
  const next = { ...db } as unknown as Record<string, Record<ID, Rec>>
  const written: [CollectionName, Rec][] = []
  for (const name of Object.keys(patch) as CollectionName[]) {
    const recs = patch[name] as Rec[] | undefined
    if (!recs?.length) continue
    const coll = { ...next[name] }
    for (const r of recs) {
      if (recording) {
        const key = `${name}|${r.id}`
        if (!recording.prev.has(key)) recording.prev.set(key, coll[r.id] ?? null)
      }
      const w = edit(coll[r.id], r, asStamped && !coll[r.id] ? r.u : stamp())
      if (!w) continue
      coll[r.id] = w
      written.push([name, w])
    }
    next[name] = coll
  }
  // Only edits to categories or groups, or money put on a deleted category, can leave something dangling.
  const cats = next.cats as DB['cats']
  const risky = written.some(([name, r]) => name === 'cats' || name === 'groups' || cats[(r as Txn).cat]?.d)
  db = risky ? repair(next as unknown as DB) : (next as unknown as DB)
  // What the repair brought back is stamped just after its deletion: the next edit must come later still,
  // or an edit to it would tie with the same repair made on another device and could lose.
  if (risky) for (const r of [...Object.values(db.cats), ...Object.values(db.groups)] as Rec[]) if (r.u > lastStamp) lastStamp = r.u
  for (const [name, r] of written) persistence?.wrote?.(name, r)
  emit()
  if (written.length) for (const fn of changeListeners) fn()
}

function tomb<T extends Rec>(r: T): T {
  return { ...r, d: 1 }
}

// ---------------------------------------------------------------- settings

export function settings(): Settings {
  return settingsOf(db)
}

function settingsRec(): Settings {
  return { ...DEFAULT_SETTINGS, ...db.meta.settings, id: 'settings', u: 0 }
}

/** Change settings. Rates go to their own record and leave the user's settings alone. */
export function updateSettings(patch: Partial<Settings>) {
  const { rates, ratesAt, ...rest } = patch
  const meta: (Settings | RateTable)[] = []
  if (Object.keys(rest).length) meta.push({ ...settingsRec(), ...rest, id: 'settings' })
  if (rates || ratesAt !== undefined) {
    const s = { ...settings(), ...rest }
    meta.push({ id: 'rates', u: 0, table: { base: s.base, rates: rates ?? s.rates, at: ratesAt ?? s.ratesAt } })
  }
  if (meta.length) commit({ meta })
}

/**
 * Re-express the whole budget in another currency (e.g. after moving countries).
 * Every stored base amount is converted at today's rate; amounts as entered stay untouched.
 */
export function changeBase(next: string): boolean {
  const s = settings()
  if (next === s.base) return true
  const r = s.rates[next]
  if (!r) return false
  const f = (v: number) => Math.round(v / r)
  // Convert every stored amount at the same rate, so the plan's balances don't shift.
  const txns = Object.values(db.txns).map((t) => ({ ...t, base: f(t.base) }))
  const assigns = Object.values(db.assigns).map((a) => ({ ...a, amt: f(a.amt) }))
  // A count's rates are restated too, or the next count would price old balances at the wrong scale.
  const restate = (old: Rates): Rates => {
    const out: Rates = { [s.base]: Number((1 / r).toPrecision(10)) }
    for (const [c, v] of Object.entries(old)) if (c !== next && c !== s.base) out[c] = Number((v / r).toPrecision(10))
    return out
  }
  const counts = Object.values(db.counts).map((c) => ({ ...c, total: f(c.total), expected: f(c.expected), rates: restate(c.rates) }))
  const cats = Object.values(db.cats)
    .filter((c) => c.target)
    .map((c) => ({ ...c, target: { ...c.target!, amount: f(c.target!.amount) } }))
  const rates: Rates = { [s.base]: Number((1 / r).toPrecision(10)) }
  for (const [c, v] of Object.entries(s.rates)) if (c !== next) rates[c] = Number((v / r).toPrecision(10))
  const extraCurrencies = [...new Set([s.base, ...s.extraCurrencies.filter((c) => c !== next)])]
  commit({
    txns,
    assigns,
    counts,
    cats,
    meta: [
      // The rates in the settings record keep older app versions consistent.
      { ...settingsRec(), base: next, rates, ratesAt: s.ratesAt, extraCurrencies, pinned: {} },
      { id: 'rates', u: 0, table: { base: next, rates, at: s.ratesAt } },
    ],
  })
  return true
}

export function toBase(amt: number, from: string, rates: Rates = settings().rates): number {
  const s = settings()
  return convert(amt, from, s.base, rates, s.base)
}

/** Each transaction says which account it came from (Today asks), or not (the default). */
export function setTrackAccounts(on: boolean) {
  updateSettings({ trackAccounts: on ? 1 : undefined })
}

// ---------------------------------------------------------------- income sources

export function sources(): Source[] {
  return settings().sources ?? []
}

export function addSource(name: string): Source {
  const src: Source = { id: uid(), name }
  updateSettings({ sources: [...sources(), src] })
  return src
}

export function renameSource(id: ID, name: string) {
  updateSettings({ sources: sources().map((x) => (x.id === id ? { ...x, name } : x)) })
}

/** Income logged from it stays, as plain income. */
export function deleteSource(id: ID) {
  updateSettings({ sources: sources().filter((x) => x.id !== id) })
}

export function placeSource(id: ID, index: number) {
  const list = sources().filter((x) => x.id !== id)
  const it = sources().find((x) => x.id === id)
  if (!it) return
  list.splice(Math.max(0, Math.min(index, list.length)), 0, it)
  updateSettings({ sources: list })
}

// ---------------------------------------------------------------- transactions

export interface NewTxn {
  date: string
  cat: ID
  amt: number
  cur: string
  note?: string
  kind?: Txn['kind']
  base?: number
  acct?: ID
  src?: ID
  to?: ID
  toAmt?: number
}

export function addTxn(t: NewTxn): Txn {
  const rec: Txn = {
    id: uid(),
    u: 0,
    date: t.date,
    cat: t.cat,
    amt: t.amt,
    cur: t.cur,
    base: t.base ?? toBase(t.amt, t.cur),
    ...(t.note ? { note: t.note } : {}),
    ...(t.kind ? { kind: t.kind } : {}),
    ...(t.acct ? { acct: t.acct } : {}),
    ...(t.src ? { src: t.src } : {}),
    ...(t.to ? { to: t.to } : {}),
    ...(t.toAmt !== undefined ? { toAmt: t.toAmt } : {}),
  }
  if (rec.kind === 'move') rec.base = 0
  commit({ txns: [rec] })
  return rec
}

/**
 * Move money between two accounts: `amt` (positive) leaves `from` in its currency, `toAmt` arrives in
 * `to` when that account uses another currency. The plan doesn't change.
 */
export function addMove(m: { date: string; from: ID; to: ID; amt: number; toAmt?: number; note?: string }): Txn {
  const from = db.accounts[m.from]
  const to = db.accounts[m.to]
  const toAmt = to && from && to.cur !== from.cur ? m.toAmt ?? convert(m.amt, from.cur, to.cur, settings().rates, settings().base) : undefined
  return addTxn({ date: m.date, cat: RTA, kind: 'move', amt: -Math.abs(m.amt), cur: from?.cur ?? settings().base, acct: m.from, to: m.to, toAmt, note: m.note })
}

export function updateTxn(id: ID, patch: Partial<NewTxn>) {
  const old = db.txns[id]
  if (!old) return
  const next: Txn = { ...old, ...patch } as Txn
  // The base amount is fixed at the rate of the day the entry was made. Only the amount or the currency
  // changing can touch it: a note, category, date or account edit leaves it exactly as it was.
  if (patch.base === undefined && (patch.amt !== undefined || patch.cur !== undefined)) {
    if (next.cur !== old.cur) {
      // Another currency is a new conversion, at today's rate.
      next.base = toBase(next.amt, next.cur)
    } else if (next.amt === old.amt) {
      next.base = old.base
    } else if (old.amt !== 0) {
      // Same currency, other amount: keep the rate the entry was recorded with.
      next.base = Math.round((old.base / old.amt) * next.amt)
    } else {
      next.base = toBase(next.amt, next.cur)
    }
  }
  for (const k of ['note', 'acct', 'src', 'to', 'toAmt'] as const) if (next[k] === undefined || next[k] === '') delete next[k]
  if (next.kind === 'move') next.base = 0
  commit({ txns: [next], repeats: followLatest(next) })
}

// ---------------------------------------------------------------- repeating payments

/** What a repeat logs, copied from an entry. */
function copyOf(t: Txn): Pick<Repeat, 'cat' | 'amt' | 'cur' | 'note' | 'acct' | 'src'> {
  return { cat: t.cat, amt: t.amt, cur: t.cur, note: t.note, acct: t.acct, src: t.src }
}

/** An edit to the latest entry of a repeat is what it logs from now on (a new price, another account). */
function followLatest(t: Txn): Repeat[] {
  const r = t.rep ? db.repeats[t.rep] : undefined
  if (!r || r.d) return []
  const later = Object.values(db.txns).some((o) => !o.d && o.rep === r.id && o.id !== t.id && o.date > t.date)
  if (later) return []
  const next: Repeat = { ...r, ...copyOf(t) }
  for (const k of ['note', 'acct', 'src'] as const) if (next[k] === undefined) delete next[k]
  return [next]
}

/** The repeat an entry belongs to, while it still repeats. */
export function repeatOf(t: Txn): Repeat | null {
  const r = t.rep ? db.repeats[t.rep] : undefined
  return r && !r.d ? r : null
}

/**
 * Make an entry come back every month or year (or stop it, with null). It starts after today:
 * what is already past was logged by hand.
 */
export function setRepeat(txnId: ID, every: Repeat['every'] | null) {
  const t = db.txns[txnId]
  if (!t || t.d || t.kind) return
  const r = repeatOf(t)
  if (!every) {
    if (r) commit({ repeats: [tomb(r)] })
    return
  }
  if (r) {
    if (r.every !== every) commit({ repeats: [{ ...r, every }] })
    return
  }
  const now = isoDate()
  const rep: Repeat = { id: uid(), u: 0, every, from: t.date, after: t.date > now ? t.date : now, ...copyOf(t) }
  for (const k of ['note', 'acct', 'src'] as const) if (rep[k] === undefined) delete rep[k]
  commit({ repeats: [rep], txns: [{ ...t, rep: rep.id }] })
}

/**
 * Log every repeating payment that has come due by `today` and isn't logged yet. Returns what it logged.
 * Each is stamped with the start of its day, so the same entry logged on two devices is one record,
 * and deleting it (always later) wins over a device that logs it again before it hears of that.
 */
export function logRepeats(today: string): Txn[] {
  const txns: Txn[] = []
  for (const r of repeatsOf(db)) {
    if (!active(db, r)) continue
    for (const o of occurrences(r, today)) {
      if (db.txns[o.id]) continue
      const [y, m, d] = o.date.split('-').map(Number)
      const t: Txn = { id: o.id, u: new Date(y, m - 1, d).getTime(), date: o.date, cat: r.cat, amt: r.amt, cur: r.cur, base: toBase(r.amt, r.cur), rep: r.id }
      if (r.note) t.note = r.note
      if (r.acct && db.accounts[r.acct] && !db.accounts[r.acct].d) t.acct = r.acct
      if (r.src) t.src = r.src
      txns.push(t)
    }
  }
  if (txns.length) commit({ txns }, true)
  return txns
}

export function deleteTxn(id: ID) {
  const t = db.txns[id]
  if (t) commit({ txns: [tomb(t)] })
}

/** Delete several transactions in one commit (so inside undoable they undo together). */
export function deleteTxns(ids: ID[]) {
  const txns = ids.map((id) => db.txns[id]).filter((t) => t && !t.d).map(tomb)
  if (txns.length) commit({ txns })
}

// ---------------------------------------------------------------- assigning

function assignRec(month: Month, cat: ID, amt: number): Assign {
  return { id: `${month}|${cat}`, u: 0, m: month, cat, amt }
}

export function assignedOf(month: Month, cat: ID): number {
  const a = db.assigns[`${month}|${cat}`]
  return a && !a.d ? a.amt : 0
}

export function setAssigned(month: Month, cat: ID, amt: number) {
  commit({ assigns: [assignRec(month, cat, amt)] })
}

/** Move money between categories (or to/from Ready to Assign) within a month. */
export function moveMoney(month: Month, from: ID, to: ID, amt: number) {
  if (!amt || from === to) return
  const recs: Assign[] = []
  if (from !== RTA) recs.push(assignRec(month, from, assignedOf(month, from) - amt))
  if (to !== RTA) recs.push(assignRec(month, to, assignedOf(month, to) + amt))
  commit({ assigns: recs })
}

// ---------------------------------------------------------------- categories & groups

export function saveCategory(c: Category) {
  commit({ cats: [c] })
}

export function addCategory(group: ID, name: string, extra: Partial<Category> = {}): Category {
  const order = Math.max(0, ...Object.values(db.cats).filter((c) => c.group === group && !c.d).map((c) => c.order + 1))
  const c: Category = { id: uid(), u: 0, name, group, order, ...extra }
  commit({ cats: [c] })
  return c
}

/** Archive keeps history. Whatever is left in it goes back to Ready to Assign this month. */
export function archiveCategory(id: ID, month: Month, current: Month) {
  const c = db.cats[id]
  if (!c) return
  const view = monthView(getIndex(), month, current)
  const left = view.byId.get(id)?.available ?? 0
  const patch: Patch = { cats: [{ ...c, archived: 1 }] }
  if (left) patch.assigns = [assignRec(month, id, assignedOf(month, id) - left)]
  commit(patch)
}

export function unarchiveCategory(id: ID) {
  const c = db.cats[id]
  if (!c) return
  const copy = { ...c }
  delete copy.archived
  commit({ cats: [copy] })
}

export function categoryHasHistory(id: ID): boolean {
  return (
    Object.values(db.txns).some((t) => !t.d && t.cat === id) ||
    Object.values(db.assigns).some((a) => !a.d && a.cat === id && a.amt !== 0)
  )
}

/**
 * Delete a category for good. With `into`, its transactions and the money given to it move to that
 * category first (nothing about your money changes); with `dropTxns`, its transactions are deleted too
 * (the money they spent comes back to Ready to assign). Without either, use it only for an unused category.
 */
export function deleteCategory(id: ID, opts: { into?: ID; dropTxns?: boolean } = {}) {
  const c = db.cats[id]
  if (!c) return
  const patch: Patch = { cats: [tomb(c)] }
  const { into, dropTxns } = opts
  if (into && into !== id && db.cats[into]) {
    patch.txns = Object.values(db.txns)
      .filter((t) => !t.d && t.cat === id)
      .map((t) => ({ ...t, cat: into }))
    const sums = new Map<Month, number>()
    const assigns: Assign[] = []
    for (const a of Object.values(db.assigns)) {
      if (a.d || a.cat !== id || !a.amt) continue
      sums.set(a.m, (sums.get(a.m) ?? 0) + a.amt)
      assigns.push(tomb(a))
    }
    for (const [m, amt] of sums) assigns.push(assignRec(m, into, assignedOf(m, into) + amt))
    patch.assigns = assigns
  } else if (dropTxns) {
    patch.txns = Object.values(db.txns)
      .filter((t) => !t.d && t.cat === id)
      .map(tomb)
    patch.assigns = Object.values(db.assigns)
      .filter((a) => !a.d && a.cat === id)
      .map(tomb)
  }
  // An investment link or anything else pointing here is harmless; nothing else references a category.
  commit(patch)
}

/** Put a category into a group at a position (drag and drop). */
export function placeCategory(id: ID, group: ID, index: number) {
  const c = db.cats[id]
  if (!c) return
  const siblings = Object.values(db.cats)
    .filter((x) => !x.d && x.group === group && x.id !== id)
    .sort((a, b) => a.order - b.order)
  siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, { ...c, group })
  const changed = siblings.map((s, k) => ({ ...s, order: k })).filter((s) => {
    const o = db.cats[s.id]
    return o.order !== s.order || o.group !== s.group
  })
  if (changed.length) commit({ cats: changed })
}

function placeIn<T extends Rec & { order: number }>(coll: Record<ID, T>, id: ID, index: number): T[] {
  const list = Object.values(coll)
    .filter((x) => !x.d && x.id !== id)
    .sort((a, b) => a.order - b.order)
  const item = coll[id]
  if (!item) return []
  list.splice(Math.max(0, Math.min(index, list.length)), 0, item)
  return list.map((x, k) => ({ ...x, order: k })).filter((x) => coll[x.id].order !== x.order)
}

export function placeGroup(id: ID, index: number) {
  const changed = placeIn(db.groups, id, index)
  if (changed.length) commit({ groups: changed })
}

export function placeAccount(id: ID, index: number) {
  const changed = placeIn(db.accounts, id, index)
  if (changed.length) commit({ accounts: changed })
}

/**
 * Move an account within its own kind (cash or investment), as the Accounts sheet lists them apart.
 * `index` counts among that kind without the account itself. The other kind keeps its places.
 */
export function placeAccountOfKind(id: ID, index: number) {
  const a = db.accounts[id]
  if (!a || a.d) return
  const all = Object.values(db.accounts)
    .filter((x) => !x.d)
    .sort((x, y) => x.order - y.order || x.name.localeCompare(y.name))
  const kind = all.filter((x) => !x.invest === !a.invest && x.id !== id)
  kind.splice(Math.max(0, Math.min(index, kind.length)), 0, a)
  // The kind's accounts fill the same places they held, so the other kind never moves.
  let k = 0
  const next = all.map((x) => (!x.invest === !a.invest ? kind[k++] : x))
  const changed = next.map((x, i) => ({ ...x, order: i })).filter((x) => db.accounts[x.id].order !== x.order)
  if (changed.length) commit({ accounts: changed })
}

/** Put a chosen currency at a position among the chosen ones (the base always comes first). */
export function placeCurrency(code: string, index: number) {
  const list = settings().extraCurrencies.filter((c) => c !== code)
  if (list.length === settings().extraCurrencies.length) return
  list.splice(Math.max(0, Math.min(index, list.length)), 0, code)
  updateSettings({ extraCurrencies: list })
}

export function saveGroup(g: Group) {
  commit({ groups: [g] })
}

export function addGroup(name: string): Group {
  const order = Math.max(0, ...Object.values(db.groups).filter((g) => !g.d).map((g) => g.order + 1))
  const g: Group = { id: uid(), u: 0, name, order }
  commit({ groups: [g] })
  return g
}

export function deleteGroup(id: ID) {
  const g = db.groups[id]
  if (g) commit({ groups: [tomb(g)] })
}

// ---------------------------------------------------------------- accounts & counting

export function saveAccount(a: Account) {
  commit({ accounts: [a] })
}

export function addAccount(name: string, currency: string, opts: { invest?: boolean } = {}): Account {
  const order = Math.max(0, ...Object.values(db.accounts).filter((a) => !a.d).map((a) => a.order + 1))
  const a: Account = { id: uid(), u: 0, name, cur: currency, order, ...(opts.invest ? { invest: 1 as const } : {}) }
  commit({ accounts: [a] })
  return a
}

export function deleteAccount(id: ID) {
  const a = db.accounts[id]
  if (a) commit({ accounts: [tomb(a)] })
}

/** A correction on Ready to assign that names the account: its money leaves the plan's total (negative) or returns to it. */
function planShift(a: Account, base: number, date: string, note: string): Txn {
  return { id: uid(), u: 0, date, cat: RTA, amt: base, cur: settings().base, base, kind: 'adj', acct: a.id, note }
}

/**
 * Mark an account as an investment (or back as cash). The plan's total is the money in cash accounts, so an
 * account's balance moves out of it (or back in) in the same step: one correction, undone with the rest.
 * An investment whose money never left the plan (see investmentsInPlan) brings nothing back.
 * Returns what moved in the base currency (negative: out of the plan).
 */
export function setInvestment(id: ID, invest: boolean, date: string): number {
  const a = db.accounts[id]
  if (!a || a.d || !!a.invest === invest) return 0
  const { invest: _, ...rest } = a
  const next: Account = invest ? { ...rest, invest: 1 } : rest
  const ix = getIndex()
  const bal = balances(ix).find((b) => b.acct.id === id)?.base ?? 0
  const txns: Txn[] = []
  if (bal && invest) txns.push(planShift(a, -bal, date, `${a.name} moved to investments`))
  else if (bal && !investmentsInPlan(ix).some((x) => x.acct.id === id)) txns.push(planShift(a, bal, date, `${a.name} moved back to your money`))
  commit({ accounts: [next], txns })
  return txns[0]?.base ?? 0
}

/** Take an investment's money out of the plan's total, when counting it as cash left it there. Returns the amount. */
export function takeOutOfPlan(id: ID, date: string): number {
  const found = investmentsInPlan(getIndex()).find((x) => x.acct.id === id)
  if (!found) return 0
  commit({ txns: [planShift(found.acct, -found.base, date, `${found.acct.name} moved to investments`)] })
  return found.base
}

export interface CountInput {
  date: string
  /** the balances typed in, in each account's currency. Accounts left out keep the balance known so far. */
  bal: Record<ID, number>
  rates: Rates
  /** where the unexplained difference goes: RTA or a category (e.g. forgotten spending) */
  diffTo: ID
}

export interface CountResult {
  /** the cash counted, in base (every cash account: typed, or as known) */
  total: number
  expected: number
  fx: number
  diff: number
  first: boolean
  /** a cash account was typed in, so the plan is checked against it (investments alone never change the plan) */
  cash: boolean
  /** every account's balance after this count, in its own currency */
  full: Record<ID, number>
  /** the accounts that were not typed in */
  carried: ID[]
}

/** Work out what a count would change, without saving anything. */
export function previewCount(input: Omit<CountInput, 'diffTo'>): CountResult {
  const s = settings()
  const known = new Map(balances(getIndex()).map((b) => [b.acct.id, b.bal]))
  const accounts = Object.values(db.accounts).filter((a) => !a.d)
  const full: Record<ID, number> = {}
  const carried: ID[] = []
  for (const a of accounts) {
    if (input.bal[a.id] !== undefined) full[a.id] = input.bal[a.id]
    else {
      full[a.id] = known.get(a.id) ?? 0
      carried.push(a.id)
    }
  }
  const cashAccts = accounts.filter((a) => !a.invest)
  const cash = cashAccts.some((a) => input.bal[a.id] !== undefined)
  let total = 0
  for (const a of cashAccts) total += convert(full[a.id], a.cur, s.base, input.rates, s.base)
  let expected = 0
  for (const t of Object.values(db.txns)) if (!t.d) expected += t.base
  const counts = Object.values(db.counts)
    .filter((c) => !c.d)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
  const prev = counts[0]
  const first = !prev && !Object.values(db.txns).some((t) => !t.d && t.kind === 'start')
  if (!cash) return { total: expected, expected, fx: 0, diff: 0, first: false, cash, full, carried }
  // Exchange-rate drift: how much the foreign balances from the last count changed in value.
  let fx = 0
  if (prev) {
    for (const a of cashAccts) {
      if (a.cur === s.base) continue
      const b = prev.bal[a.id]
      // Only the same money in the same currency can drift with rates; a changed currency is just a difference.
      if (!b || (prev.curs?.[a.id] ?? a.cur) !== a.cur) continue
      fx += convert(b, a.cur, s.base, input.rates, s.base) - convert(b, a.cur, s.base, prev.rates, s.base)
    }
  }
  return { total, expected, fx: first ? 0 : fx, diff: total - expected - (first ? 0 : fx), first, cash, full, carried }
}

export function recordCount(input: CountInput): CountResult {
  const s = settings()
  const r = previewCount(input)
  const txns: Txn[] = []
  const mk = (base: number, cat: ID, kind: Txn['kind'], note: string): Txn => ({
    id: uid(),
    u: 0,
    date: input.date,
    cat,
    amt: base,
    cur: s.base,
    base,
    kind,
    note,
  })
  if (r.first) {
    if (r.diff) txns.push(mk(r.diff, RTA, 'start', 'Starting balance'))
  } else if (r.cash) {
    if (r.fx) txns.push(mk(r.fx, RTA, 'fx', 'Exchange rates'))
    if (r.diff) txns.push(mk(r.diff, input.diffTo, 'adj', r.diff < 0 ? 'Unlogged spending' : 'Found money'))
  }
  const curs: Record<ID, string> = {}
  for (const a of Object.values(db.accounts)) if (!a.d) curs[a.id] = a.cur
  const count: Count = { id: uid(), u: 0, date: input.date, bal: r.full, curs, rates: input.rates, total: r.total, expected: r.expected }
  if (r.carried.length) count.carried = r.carried
  commit({ counts: [count], txns })
  return r
}

/**
 * Put the data back exactly as it was in a backup: its records win over anything newer here,
 * and records that weren't in the backup are removed. Synced devices follow.
 */
export function restoreBackup(backup: DB) {
  const patch: Record<string, Rec[]> = {}
  for (const name of COLLECTIONS) {
    const from = (backup[name] ?? {}) as Record<ID, Rec>
    const here = db[name] as Record<ID, Rec>
    const recs: Rec[] = Object.values(from).map((r) => ({ ...r }))
    for (const r of Object.values(here)) if (!from[r.id] && !r.d) recs.push({ ...r, d: 1 })
    if (recs.length) patch[name] = recs
  }
  commit(patch as Patch)
}

/** Forget undo history (after the whole budget was replaced from elsewhere). */
export function clearUndo() {
  undoStack.length = 0
  redoStack.length = 0
}

export function lastCount() {
  return Object.values(db.counts)
    .filter((c) => !c.d)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.u - a.u))[0]
}

// ---------------------------------------------------------------- notes

export function setNote(month: Month, text: string) {
  commit({ notes: [{ id: month, u: 0, text }] })
}

// ---------------------------------------------------------------- first run

export const STARTER: { group: string; cats: (Partial<Category> & { name: string })[] }[] = [
  { group: 'Every day', cats: [{ name: 'Living', daily: true, note: 'groceries, eating out, transport' }] },
  { group: 'Fixed', cats: [{ name: 'Phone' }, { name: 'BJJ / gym' }, { name: 'Business', note: 'Google Workspace' }] },
  { group: 'Flexible', cats: [{ name: 'Purchases' }, { name: 'Trips' }, { name: 'Other' }] },
  {
    group: 'Future',
    cats: [
      { name: 'Future me', saving: true, note: 'investing' },
      { name: 'Emergency', saving: true },
      { name: 'NAWA (hold)', saving: true },
    ],
  },
]

export function seedCategories() {
  const groups: Group[] = []
  const cats: Category[] = []
  STARTER.forEach((g, gi) => {
    const group: Group = { id: uid(), u: 0, name: g.group, order: gi }
    groups.push(group)
    g.cats.forEach((c, ci) => cats.push({ id: uid(), u: 0, group: group.id, order: ci, ...c }))
  })
  commit({ groups, cats })
}

export function today(): string {
  return isoDate()
}
