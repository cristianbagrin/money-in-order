// Keeps the database in IndexedDB, safely when several tabs are open and when the page reloads mid-save.
//
// - Every write merges with what another tab stored since our own last write, so tabs never erase each other.
// - Other tabs hear about each write and take it in.
// - Records are also journaled synchronously in localStorage until their IndexedDB write completes,
//   so a reload right after logging can't lose them.
// - A different budget swapped in (joined from another device) is stored under a new epoch ('dbe'). A tab still
//   holding the old budget can't write, journal or merge it back: it drops it and takes the new one.

import { createStore, get, getMany } from 'idb-keyval'
import { hasNews, merge } from './merge'
import { clearUndo, getDB, replaceDB, setPersistence, uid } from './store'
import { COLLECTIONS, emptyDB, type CollectionName, type DB, type Rec } from './types'

/** The store idb-keyval uses by default (where the app has always kept 'db' and 'sync'). */
const store = createStore('keyval-store', 'keyval')
const TAB = Math.random().toString(36).slice(2, 10)
const JOURNAL = 'money-in-order/journal/'
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('money-in-order/db') : null

/** Records written here and not yet in IndexedDB: "collection|id" -> record. */
const journal = new Map<string, Rec>()
/** Journals of earlier sessions, replayed at startup; removed once that data is written. */
const replayed = new Map<string, string>()
/** The write mark of the data this tab holds ('dbw' changes with every write), to tell whether another tab wrote since. */
const UNKNOWN = {}
let seen: unknown = UNKNOWN
let seq = 0
/** The epoch of the budget this tab holds ('' for data stored before budgets had one). */
let epoch = ''
/** A budget swapped in here isn't stored yet: it replaces whatever is, and nothing stored is taken in meanwhile. */
let fresh = false

/** What another tab stored after swapping in a different budget. */
interface Swapped {
  db: DB | undefined
  mark: unknown
  epoch: string
}

function split(key: string): [CollectionName, string] {
  const i = key.indexOf('|')
  return [key.slice(0, i) as CollectionName, key.slice(i + 1)]
}

function recIn(db: DB, key: string): Rec | undefined {
  const [name, id] = split(key)
  return (db[name] as Record<string, Rec> | undefined)?.[id]
}

function saveJournal() {
  try {
    // A huge batch (restoring a backup) isn't worth the main-thread time; IndexedDB has it shortly.
    if (journal.size && journal.size <= 500) localStorage.setItem(JOURNAL + TAB, JSON.stringify({ epoch, recs: [...journal] }))
    else localStorage.removeItem(JOURNAL + TAB)
  } catch {
    // storage blocked or full
  }
}

/** The saved database, plus anything a reload interrupted before it reached IndexedDB. */
export async function loadDB(): Promise<{ db: DB | null; replayed: boolean }> {
  let saved: DB | undefined
  try {
    const [db, mark, e] = await getMany(['db', 'dbw', 'dbe'], store)
    saved = db as DB | undefined
    seen = mark
    epoch = (e as string | undefined) ?? ''
  } catch {
    // IndexedDB unavailable (private mode): run in memory.
  }
  const extra = journaled((k, raw) => replayed.set(k, raw))
  const news = !!extra && hasNews(saved ?? emptyDB(), extra)
  return { db: news ? merge(saved ?? emptyDB(), extra!) : (saved ?? null), replayed: news }
}

/** The records other tabs journaled for the budget held here (`each` hears of every journal read). */
function journaled(each?: (key: string, raw: string) => void): DB | null {
  let extra: DB | null = null
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(JOURNAL) || k === JOURNAL + TAB) continue
      const raw = localStorage.getItem(k) ?? '[]'
      each?.(k, raw)
      // Older journals are plain lists (of the budget stored then); one of a budget swapped out since is dropped.
      const data = JSON.parse(raw) as [string, Rec][] | { epoch: string; recs: [string, Rec][] }
      const [from, recs] = Array.isArray(data) ? ['', data] : [data.epoch, data.recs]
      if (from !== epoch) continue
      const part = emptyDB() as unknown as Record<string, Record<string, Rec>>
      for (const [key, rec] of recs) {
        const [name, id] = split(key)
        if ((COLLECTIONS as readonly string[]).includes(name)) part[name][id] = rec
      }
      extra = merge(extra ?? emptyDB(), part as unknown as DB)
    }
  } catch {
    // unreadable journal: nothing to take in
  }
  return extra
}

/**
 * Write a snapshot of the budget of epoch `e` (`fresh`: swapped in here, written as is). Returns the merged
 * database when another tab had stored something this one lacks, or, when another tab has swapped in a
 * different budget, what it stored (and writes nothing).
 */
function write(db: DB, e: string, fresh: boolean): Promise<{ news?: DB; swapped?: Swapped }> {
  return store('readwrite', (os) => {
    return new Promise<{ news?: DB; swapped?: Swapped }>((resolve, reject) => {
      const out: { news?: DB; swapped?: Swapped } = {}
      const put = (data: DB) => {
        seen = `${TAB}:${++seq}`
        os.put(data, 'db')
        os.put(seen, 'dbw')
        if (fresh) os.put(e, 'dbe')
      }
      if (fresh) put(db)
      else {
        const t = os.get('dbw')
        const v = os.get('dbe')
        v.onsuccess = () => {
          const era = (v.result as string | undefined) ?? ''
          if (era === e && t.result === seen) return put(db)
          // Someone else wrote last (another tab, or an earlier session): keep their records too.
          const g = os.get('db')
          g.onsuccess = () => {
            const stored = g.result as DB | undefined
            if (era !== e) out.swapped = { db: stored, mark: t.result, epoch: era }
            else if (stored && hasNews(db, stored)) put((out.news = merge(db, stored)))
            else put(db)
          }
        }
      }
      os.transaction.oncomplete = () => resolve(out)
      os.transaction.onerror = os.transaction.onabort = () => reject(os.transaction.error)
    })
  })
}

/** Another tab swapped in a different budget: drop this one, with anything of it not yet stored, and take that. */
function adopt(other: Swapped) {
  epoch = other.epoch
  seen = other.mark
  journal.clear()
  saveJournal()
  clearUndo()
  replaceDB(other.db ?? emptyDB())
}

/** Take in what another tab saved. */
async function pull() {
  const e = epoch
  try {
    if ((await get('dbw', store)) !== seen) {
      const [stored, mark, era] = await getMany(['db', 'dbw', 'dbe'], store)
      // A budget swapped in here (meanwhile, or not stored yet) replaces whatever is stored.
      if (fresh || epoch !== e) return
      if ((era ?? '') !== epoch) return adopt({ db: stored as DB | undefined, mark, epoch: era ?? '' })
      if (stored && hasNews(getDB(), stored)) replaceDB(merge(getDB(), stored))
      seen = mark
    }
  } catch {
    // IndexedDB unavailable
  }
  if (fresh || epoch !== e) return
  // A tab closed right after an edit, before storing it, left it in its journal: take it in now rather than
  // at the next start (a tab still saving its own is taken in early, which changes nothing). Nobody else will
  // send it to other devices, so it counts as an edit made here.
  const left = journaled()
  if (left && hasNews(getDB(), left)) replaceDB(merge(getDB(), left), { local: true })
}

export function startPersistence(opts: { replayed: boolean }) {
  let pending: DB | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let last: Promise<void> = Promise.resolve()
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pending) return last
    const snap = pending
    const e = epoch
    const f = fresh
    pending = null
    last = write(snap, e, f).then(
      ({ news, swapped }) => {
        // Swapped meanwhile: this snapshot's budget is gone.
        if (epoch !== e) return
        if (swapped) return adopt(swapped)
        if (f) fresh = false
        for (const [key, rec] of journal) if (recIn(snap, key)?.u === rec.u) journal.delete(key)
        saveJournal()
        try {
          for (const [k, raw] of replayed) if (localStorage.getItem(k) === raw) localStorage.removeItem(k)
        } catch {
          // storage blocked
        }
        replayed.clear()
        if (news) replaceDB(merge(getDB(), news))
        channel?.postMessage(1)
      },
      () => {
        // Not saved (storage full or unavailable): the journal keeps the latest records.
      },
    )
    return last
  }
  setPersistence({
    save(db) {
      pending = db
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 250)
    },
    wrote(name, rec) {
      journal.set(`${name}|${rec.id}`, rec)
      saveJournal()
    },
    flush,
    pull,
    replace() {
      epoch = uid()
      fresh = true
      journal.clear()
      saveJournal()
    },
    epoch: () => epoch,
  })
  if (channel) channel.onmessage = () => void pull()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
    else void pull()
  })
  window.addEventListener('pagehide', () => void flush())
  if (opts.replayed) {
    pending = getDB()
    void flush()
  }
}
