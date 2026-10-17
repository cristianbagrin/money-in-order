// Keeps the database in IndexedDB, safely when several tabs are open and when the page reloads mid-save.
//
// - Every write merges with what another tab stored since our own last write, so tabs never erase each other.
// - Other tabs hear about each write and take it in.
// - Records are also journaled synchronously in localStorage until their IndexedDB write completes,
//   so a reload right after logging can't lose them.

import { createStore, get, getMany } from 'idb-keyval'
import { hasNews, merge } from './merge'
import { getDB, replaceDB, setPersistence } from './store'
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
    if (journal.size && journal.size <= 500) localStorage.setItem(JOURNAL + TAB, JSON.stringify([...journal]))
    else localStorage.removeItem(JOURNAL + TAB)
  } catch {
    // storage blocked or full
  }
}

/** The saved database, plus anything a reload interrupted before it reached IndexedDB. */
export async function loadDB(): Promise<{ db: DB | null; replayed: boolean }> {
  let saved: DB | undefined
  try {
    const [db, mark] = await getMany(['db', 'dbw'], store)
    saved = db as DB | undefined
    seen = mark
  } catch {
    // IndexedDB unavailable (private mode): run in memory.
  }
  let extra: DB | null = null
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(JOURNAL)) continue
      const raw = localStorage.getItem(k) ?? '[]'
      replayed.set(k, raw)
      const part = emptyDB() as unknown as Record<string, Record<string, Rec>>
      for (const [key, rec] of JSON.parse(raw) as [string, Rec][]) {
        const [name, id] = split(key)
        if ((COLLECTIONS as readonly string[]).includes(name)) part[name][id] = rec
      }
      extra = merge(extra ?? emptyDB(), part as unknown as DB)
    }
  } catch {
    // unreadable journal: nothing to replay
  }
  const news = !!extra && hasNews(saved ?? emptyDB(), extra)
  return { db: news ? merge(saved ?? emptyDB(), extra!) : (saved ?? null), replayed: news }
}

/** Write a snapshot; returns the merged database when another tab had stored something this one lacks. */
function write(db: DB): Promise<DB | null> {
  return store('readwrite', (os) => {
    return new Promise<DB | null>((resolve, reject) => {
      let news: DB | null = null
      const put = (data: DB) => {
        seen = `${TAB}:${++seq}`
        os.put(data, 'db')
        os.put(seen, 'dbw')
      }
      const t = os.get('dbw')
      t.onsuccess = () => {
        if (t.result === seen) return put(db)
        // Someone else wrote last (another tab, or an earlier session): keep their records too.
        const g = os.get('db')
        g.onsuccess = () => {
          const stored = g.result as DB | undefined
          if (stored && hasNews(db, stored)) put((news = merge(db, stored)))
          else put(db)
        }
      }
      os.transaction.oncomplete = () => resolve(news)
      os.transaction.onerror = os.transaction.onabort = () => reject(os.transaction.error)
    })
  })
}

/** Take in what another tab saved. */
async function pull() {
  try {
    if ((await get('dbw', store)) === seen) return
    const [stored, mark] = await getMany(['db', 'dbw'], store)
    if (stored && hasNews(getDB(), stored)) replaceDB(merge(getDB(), stored))
    seen = mark
  } catch {
    // IndexedDB unavailable
  }
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
    pending = null
    last = write(snap).then(
      (news) => {
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
