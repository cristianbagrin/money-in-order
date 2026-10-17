import { buildIndex, DEFAULT_SETTINGS, fundingPlan, monthView, settingsOf, type Index } from './budget'
import { addMonths, isoDate, monthOf } from './dates'
import { edit, repair, same } from './merge'
import { convert, type Rates } from './money'
import {
  COLLECTIONS,
  emptyDB,
  RTA,
  type Account,
  type Assign,
  type Category,
  type CollectionName,
  type DB,
  type Group,
  type ID,
  type Month,
  type RateTable,
  type Rec,
  type Settings,
  type Txn,
} from './types'

type Listener = () => void

export interface Persistence {
  save(db: DB): void
  /** a record was just written here (called synchronously, before save) */
  wrote?(name: CollectionName, rec: Rec): void
  /** write what's pending now */
  flush?(): Promise<void>
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
const undoListeners = new Set<Listener>()

export function onUndoChange(fn: Listener): () => void {
  undoListeners.add(fn)
  return () => undoListeners.delete(fn)
}

function undoChanged() {
  for (const fn of undoListeners) fn()
}

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
      undoChanged()
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
  undoChanged()
  return e
}

export function redo(): UndoEntry | null {
  const e = redoStack.pop()
  if (!e) return null
  revert(e.prev, e.next)
  undoStack.push({ label: e.label, at: Date.now(), prev: e.next, next: e.prev })
  undoChanged()
  return e
}

/** Write records. The fields that changed get a fresh timestamp; unchanged records aren't rewritten. */
export function commit(patch: Patch) {
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
      const w = edit(coll[r.id], r, stamp())
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
  const counts = Object.values(db.counts).map((c) => ({ ...c, total: f(c.total), expected: f(c.expected) }))
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

// ---------------------------------------------------------------- transactions

export interface NewTxn {
  date: string
  cat: ID
  amt: number
  cur: string
  note?: string
  kind?: Txn['kind']
  base?: number
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
  }
  commit({ txns: [rec] })
  return rec
}

export function updateTxn(id: ID, patch: Partial<NewTxn>) {
  const old = db.txns[id]
  if (!old) return
  const next: Txn = { ...old, ...patch } as Txn
  if (patch.amt !== undefined || patch.cur !== undefined) {
    if (patch.base === undefined) {
      // Keep the rate the transaction was recorded with if only the amount changed.
      next.base =
        next.cur === old.cur && old.amt !== 0 ? Math.round((old.base / old.amt) * next.amt) : toBase(next.amt, next.cur)
    }
  }
  if (!next.note) delete next.note
  commit({ txns: [next] })
}

export function deleteTxn(id: ID) {
  const t = db.txns[id]
  if (t) commit({ txns: [tomb(t)] })
}

export function restoreTxn(t: Txn) {
  const copy = { ...t }
  delete copy.d
  commit({ txns: [copy] })
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

/** Give every category with a target what it still needs, as far as Ready to Assign allows. */
export function fundTargets(month: Month, current: Month): number {
  const view = monthView(getIndex(), month, current)
  const plan = fundingPlan(view)
  if (!plan.length) return 0
  commit({ assigns: plan.map((p) => assignRec(month, p.cat, assignedOf(month, p.cat) + p.amount)) })
  return plan.reduce((s, p) => s + p.amount, 0)
}

/** Copy last month's assigned amounts into a month where nothing is assigned yet. */
export function repeatLastMonth(month: Month) {
  const prev = addMonths(month, -1)
  const ix = getIndex()
  const recs: Assign[] = []
  for (const [cat, amt] of ix.asg.get(prev) ?? []) {
    const c = ix.catById.get(cat)
    if (!c || c.archived || amt <= 0) continue
    recs.push(assignRec(month, cat, assignedOf(month, cat) + amt))
  }
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

export function deleteCategory(id: ID) {
  const c = db.cats[id]
  if (c) commit({ cats: [tomb(c)] })
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

export function reorderCategory(id: ID, dir: -1 | 1) {
  const c = db.cats[id]
  if (!c) return
  const siblings = Object.values(db.cats)
    .filter((x) => !x.d && x.group === c.group)
    .sort((a, b) => a.order - b.order)
  const i = siblings.findIndex((x) => x.id === id)
  const j = i + dir
  if (j < 0 || j >= siblings.length) return
  ;[siblings[i], siblings[j]] = [siblings[j], siblings[i]]
  commit({ cats: siblings.map((s, k) => ({ ...s, order: k })) })
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

export function addAccount(name: string, currency: string): Account {
  const order = Math.max(0, ...Object.values(db.accounts).filter((a) => !a.d).map((a) => a.order + 1))
  const a: Account = { id: uid(), u: 0, name, cur: currency, order }
  commit({ accounts: [a] })
  return a
}

export function deleteAccount(id: ID) {
  const a = db.accounts[id]
  if (a) commit({ accounts: [tomb(a)] })
}

export interface CountInput {
  date: string
  bal: Record<ID, number>
  rates: Rates
  /** where the unexplained difference goes: RTA or a category (e.g. forgotten spending) */
  diffTo: ID
}

export interface CountResult {
  total: number
  expected: number
  fx: number
  diff: number
  first: boolean
}

/** Work out what a count would change, without saving anything. */
export function previewCount(input: Omit<CountInput, 'diffTo'>): CountResult {
  const s = settings()
  const accounts = Object.values(db.accounts).filter((a) => !a.d)
  let total = 0
  for (const a of accounts) total += convert(input.bal[a.id] ?? 0, a.cur, s.base, input.rates, s.base)
  let expected = 0
  for (const t of Object.values(db.txns)) if (!t.d) expected += t.base
  const counts = Object.values(db.counts)
    .filter((c) => !c.d)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
  const prev = counts[0]
  const first = !prev && !Object.values(db.txns).some((t) => !t.d && t.kind === 'start')
  // Exchange-rate drift: how much the foreign balances from the last count changed in value.
  let fx = 0
  if (prev) {
    for (const a of accounts) {
      if (a.cur === s.base) continue
      const b = prev.bal[a.id]
      // Only the same money in the same currency can drift with rates; a changed currency is just a difference.
      if (!b || (prev.curs?.[a.id] ?? a.cur) !== a.cur) continue
      fx += convert(b, a.cur, s.base, input.rates, s.base) - convert(b, a.cur, s.base, prev.rates, s.base)
    }
  }
  return { total, expected, fx: first ? 0 : fx, diff: total - expected - (first ? 0 : fx), first }
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
  } else {
    if (r.fx) txns.push(mk(r.fx, RTA, 'fx', 'Exchange rates'))
    if (r.diff) txns.push(mk(r.diff, input.diffTo, 'adj', r.diff < 0 ? 'Unlogged spending' : 'Found money'))
  }
  const curs: Record<ID, string> = {}
  for (const a of Object.values(db.accounts)) if (!a.d) curs[a.id] = a.cur
  commit({
    counts: [{ id: uid(), u: 0, date: input.date, bal: input.bal, curs, rates: input.rates, total: r.total, expected: r.expected }],
    txns,
  })
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
  undoChanged()
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
  { group: 'Every day', cats: [{ name: 'Living', daily: true, note: 'groceries · eating out · transport' }] },
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

export function currentMonth(): Month {
  return monthOf(today())
}
