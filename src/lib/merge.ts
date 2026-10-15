import { COLLECTIONS, emptyDB, type DB, type Rec } from './types'

function newer(a: Rec, b: Rec): Rec {
  if (a.u !== b.u) return a.u > b.u ? a : b
  // Same timestamp: pick deterministically so both devices agree.
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  return ja >= jb ? a : b
}

/**
 * Merge two databases record by record: the most recently updated version of each record wins,
 * deletions included. Commutative and idempotent, so devices converge whatever order they sync in.
 */
export function merge(a: DB, b: DB): DB {
  const out = emptyDB() as unknown as Record<string, Record<string, Rec>>
  for (const name of COLLECTIONS) {
    const ca = (a[name] ?? {}) as Record<string, Rec>
    const cb = (b[name] ?? {}) as Record<string, Rec>
    const merged: Record<string, Rec> = { ...ca }
    for (const id in cb) {
      merged[id] = ca[id] ? newer(ca[id], cb[id]) : cb[id]
    }
    out[name] = merged
  }
  return out as unknown as DB
}

/** True when `b` holds anything `a` doesn't (a newer or missing record). */
export function hasNews(a: DB, b: DB): boolean {
  for (const name of COLLECTIONS) {
    const ca = (a[name] ?? {}) as Record<string, Rec>
    const cb = (b[name] ?? {}) as Record<string, Rec>
    for (const id in cb) {
      const ra = ca[id]
      if (!ra || newer(ra, cb[id]) !== ra) return true
    }
  }
  return false
}
