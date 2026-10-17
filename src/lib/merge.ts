import { COLLECTIONS, emptyDB, type DB, type ID, type Rec, type Stamps } from './types'

// Records merge field by field: every field remembers when it last changed and the newer value wins,
// so two devices editing different fields of one record both keep their change. Deletion stays per
// record: the newest write decides whether a record is deleted.
//
// Field times live in `f`, and only for fields that changed after the rest of the record:
// a record without `f` has every field at `u`. That keeps the payload small and older data valid.

type Row = Record<string, unknown>
const OWN = new Set(['id', 'u', 'd', 'f'])
/** Fields that only make sense together: when one changes, all get the new time, so a merge never mixes them. */
const TOGETHER = [['amt', 'cur', 'base']]

/** The record's field times, unless an older app version edited it (it bumps `u` but keeps a stale `f`). */
function stampsOf(r: Rec): Stamps | null {
  return r.f && r.f.$ === r.u ? r.f : null
}

/** Time of every field without a time of its own. */
function baseOf(r: Rec): number {
  return stampsOf(r)?._ ?? r.u
}

function stampOf(r: Rec, k: string): number {
  const f = stampsOf(r)
  return f ? (f[k] ?? f._ ?? r.u) : r.u
}

/** Field names, including removed fields that still carry a time. */
function fieldsOf(r: Rec, into: Set<string>) {
  for (const k in r) if (!OWN.has(k)) into.add(k)
  const f = stampsOf(r)
  if (f) for (const k in f) if (k !== '$' && k !== '_') into.add(k)
}

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameRec(a: Rec, b: Rec): boolean {
  let n = 0
  for (const k in a) {
    n++
    if (!same((a as unknown as Row)[k], (b as unknown as Row)[k])) return false
  }
  for (const _ in b) n--
  return n === 0
}

/** Tie-break for two different values written at the same time, so every device picks the same one. */
function rank(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v)
}

/** Assemble a record, storing only the field times that differ from the baseline. */
function build(id: ID, u: number, d: 1 | undefined, values: Map<string, unknown>, stamps: Map<string, number>, base: number): Rec {
  const r: Row = { id, u }
  for (const [k, v] of values) if (v !== undefined) r[k] = v
  if (d) r.d = 1
  const f: Stamps = {}
  let any = false
  if (base !== u) {
    f._ = base
    any = true
  }
  for (const [k, s] of stamps) {
    if (s === base) continue
    f[k] = s
    any = true
  }
  if (any) r.f = { $: u, ...f }
  return r as unknown as Rec
}

/**
 * Write `next` over `old` at time `u`: only the fields that differ get the new time, the rest keep theirs.
 * Returns null when nothing changed.
 */
export function edit<T extends Rec>(old: T | undefined, next: T, u: number): T | null {
  if (!old) {
    const r = { ...next, u } as unknown as Row
    delete r.f
    for (const k in r) if (r[k] === undefined || (k === 'd' && !r.d)) delete r[k]
    return r as unknown as T
  }
  const keys = new Set<string>()
  fieldsOf(old, keys)
  for (const k in next) if (!OWN.has(k)) keys.add(k)
  const values = new Map<string, unknown>()
  const stamps = new Map<string, number>()
  let changed = !old.d !== !next.d
  for (const k of keys) {
    const v = (next as unknown as Row)[k]
    values.set(k, v)
    if (same((old as unknown as Row)[k], v)) stamps.set(k, stampOf(old, k))
    else {
      stamps.set(k, u)
      changed = true
    }
  }
  for (const group of TOGETHER) {
    if (group.some((k) => stamps.get(k) === u)) for (const k of group) if (values.get(k) !== undefined) stamps.set(k, u)
  }
  return changed ? (build(next.id, u, next.d, values, stamps, baseOf(old)) as T) : null
}

/** Merge two versions of one record. Returns one of them unchanged when it already holds everything. */
export function mergeRec<T extends Rec>(a: T, b: T): T {
  if (a === b) return a
  const ba = baseOf(a)
  const bb = baseOf(b)
  // Every field on one side is newer than anything on the other.
  if (ba > b.u) return a
  if (bb > a.u) return b
  if (a.u === b.u && sameRec(a, b)) return a
  const keys = new Set<string>()
  fieldsOf(a, keys)
  fieldsOf(b, keys)
  const u = Math.max(a.u, b.u)
  const d = a.u !== b.u ? (a.u > b.u ? a.d : b.d) : a.d || b.d
  const base = Math.max(ba, bb)
  const values = new Map<string, unknown>()
  const stamps = new Map<string, number>()
  let isA = u === a.u && !d === !a.d && base === ba
  let isB = u === b.u && !d === !b.d && base === bb
  for (const k of keys) {
    const sa = stampOf(a, k)
    const sb = stampOf(b, k)
    const va = (a as unknown as Row)[k]
    const vb = (b as unknown as Row)[k]
    const takeA = sa !== sb ? sa > sb : same(va, vb) || rank(va) >= rank(vb)
    const s = takeA ? sa : sb
    const v = takeA ? va : vb
    values.set(k, v)
    stamps.set(k, s)
    if (isA && (s !== sa || !same(v, va))) isA = false
    if (isB && (s !== sb || !same(v, vb))) isB = false
  }
  if (isA) return a
  if (isB) return b
  return build(a.id, u, d, values, stamps, base) as T
}

/**
 * Merge two databases record by record and field by field. Commutative and idempotent,
 * so devices converge whatever order they sync in.
 */
export function merge(a: DB, b: DB): DB {
  const out = emptyDB() as unknown as Record<string, Record<string, Rec>>
  for (const name of COLLECTIONS) {
    const ca = (a[name] ?? {}) as Record<string, Rec>
    const cb = (b[name] ?? {}) as Record<string, Rec>
    const merged: Record<string, Rec> = { ...ca }
    for (const id in cb) {
      merged[id] = ca[id] ? mergeRec(ca[id], cb[id]) : cb[id]
    }
    out[name] = merged
  }
  return out as unknown as DB
}

/** True when `b` holds anything `a` doesn't (a newer record or field, or a missing record). */
export function hasNews(a: DB, b: DB): boolean {
  for (const name of COLLECTIONS) {
    const ca = (a[name] ?? {}) as Record<string, Rec>
    const cb = (b[name] ?? {}) as Record<string, Rec>
    for (const id in cb) {
      const ra = ca[id]
      if (!ra || mergeRec(ra, cb[id]) !== ra) return true
    }
  }
  return false
}

/**
 * Bring back what a merge left dangling: a deleted category that still has transactions or money
 * returns archived, and a deleted group returns while an active category is still in it.
 * A revived record is stamped just after its deletion, so devices repairing on their own write the same thing.
 */
export function repair(db: DB): DB {
  const used = new Set<ID>()
  for (const id in db.txns) if (!db.txns[id].d) used.add(db.txns[id].cat)
  for (const id in db.assigns) if (!db.assigns[id].d && db.assigns[id].amt) used.add(db.assigns[id].cat)
  let cats: DB['cats'] | null = null
  for (const id of used) {
    const c = db.cats[id]
    if (c?.d) (cats ??= { ...db.cats })[id] = revive(c, { archived: 1 })
  }
  const allCats = cats ?? db.cats
  let groups: DB['groups'] | null = null
  for (const id in allCats) {
    const c = allCats[id]
    const g = (groups ?? db.groups)[c.group]
    if (!c.d && !c.archived && g?.d) (groups ??= { ...db.groups })[g.id] = revive(g, {})
  }
  if (!cats && !groups) return db
  return { ...db, cats: allCats, groups: groups ?? db.groups }
}

function revive<T extends Rec>(r: T, extra: Partial<T>): T {
  const next = { ...r, ...extra }
  delete next.d
  return edit(r, next, r.u + 1)!
}
