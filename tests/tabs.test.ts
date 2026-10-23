import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyDB, type DB, type Txn } from '../src/lib/types'

// Several tabs of one device (and a second device), each with its own copy of the app's modules, sharing a
// stand-in for IndexedDB per device, localStorage, BroadcastChannel and the sync server.

type Device = { kv: Map<string, unknown>; queue: Promise<unknown> }
const devices = new Map<string, Device>()

function deviceOf(name: string): Device {
  let d = devices.get(name)
  if (!d) devices.set(name, (d = { kv: new Map(), queue: Promise.resolve() }))
  return d
}

/** idb-keyval over one device's stand-in IndexedDB. */
function idbOf(dev: Device) {
  const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v))
  // Transactions of one device run one after another, as in IndexedDB.
  const run = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = dev.queue.then(fn)
    dev.queue = p.catch(() => {})
    return p
  }
  const now = <T,>(fn: () => T) => run(() => new Promise<T>((r) => setTimeout(() => r(fn()))))
  type Req = { result?: unknown; onsuccess?: () => void }
  return {
    get: (k: string) => now(() => clone(dev.kv.get(k))),
    getMany: (ks: string[]) => now(() => ks.map((k) => clone(dev.kv.get(k)))),
    set: (k: string, v: unknown) => now(() => void dev.kv.set(k, clone(v))),
    update: (k: string, f: (v: unknown) => unknown) => now(() => void dev.kv.set(k, clone(f(clone(dev.kv.get(k)))))),
    createStore: () => (_mode: string, callback: (os: unknown) => unknown) =>
      run(() => {
        const reqs: (() => void)[] = []
        const tx: { oncomplete?: () => void } = {}
        const request = (fn: (req: Req) => void): Req => {
          const req: Req = {}
          reqs.push(() => {
            fn(req)
            req.onsuccess?.()
          })
          return req
        }
        const os = {
          transaction: tx,
          get: (k: string) => request((req) => (req.result = clone(dev.kv.get(k)))),
          put: (v: unknown, k: string) => request(() => void dev.kv.set(k, clone(v))),
        }
        const pump = () => {
          const next = reqs.shift()
          if (!next) return tx.oncomplete?.()
          next()
          setTimeout(pump)
        }
        const out = Promise.resolve(callback(os))
        setTimeout(pump)
        return out
      }),
  }
}

// The sync server: the real vault function over an in-memory Blobs store.
vi.mock('@netlify/blobs', () => import('./fake-blobs'))
const accounts = new Set<string>()
async function server(url: string, init: RequestInit = {}): Promise<Response> {
  const id = url.split('/').pop()!
  const method = init.method ?? 'GET'
  if (url.startsWith('/api/account/')) {
    if (method === 'PUT') {
      if (accounts.has(id)) return new Response(null, { status: 409 })
      accounts.add(id)
      return new Response(null, { status: 201 })
    }
    return new Response(null, { status: accounts.has(id) ? 200 : 404 })
  }
  const { default: vault } = await import('../netlify/functions/vault.mts')
  return vault(new Request('http://local' + url, { method, headers: init.headers, body: init.body }), { params: { id } } as never)
}

const local = new Map<string, string>()
beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  // Every tab listens on the one window and document; these tests never fire their events.
  const quiet = { addEventListener() {}, removeEventListener() {} }
  Object.assign(globalThis, {
    window: quiet,
    document: { ...quiet, visibilityState: 'visible' },
    fetch: server,
    localStorage: {
      get length() {
        return local.size
      },
      key: (i: number) => [...local.keys()][i] ?? null,
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    },
  })
})

beforeEach(() => {
  local.clear()
})

/** Open a tab of the app on a device. */
async function tab(device: string) {
  vi.resetModules()
  vi.doMock('idb-keyval', () => idbOf(deviceOf(device)))
  const persist = await import('../src/lib/persist')
  const S = await import('../src/lib/store')
  const sync = await import('../src/lib/sync')
  const { db, replayed } = await persist.loadDB()
  if (db) S.replaceDB(db)
  persist.startPersistence({ replayed })
  return { S, sync }
}

function txn(id: string, cat: string): Txn {
  return { id, u: 0, date: '2026-10-01', cat, amt: -100, cur: 'TWD', base: -100 }
}

/** A small budget whose ids all carry `tag`, so two budgets never share a record. */
function budget(tag: string): DB {
  const db = emptyDB()
  db.groups[`g${tag}`] = { id: `g${tag}`, u: 1, name: 'Every day', order: 0 }
  db.cats[`c${tag}`] = { id: `c${tag}`, u: 1, name: 'Living', group: `g${tag}`, order: 0 }
  db.txns[`t${tag}`] = { ...txn(`t${tag}`, `c${tag}`), u: 1 }
  return db
}

function seed(device: string, db: DB) {
  deviceOf(device).kv.set('db', structuredClone(db))
  // Every device's budget is its own (as its epoch says): here one stand-in localStorage serves them all, and a
  // tab takes in what other tabs of its budget journaled.
  deviceOf(device).kv.set('dbe', device)
}

const ids = (db: DB) => Object.keys(db.txns).sort()
const stored = (device: string) => deviceOf(device).kv.get('db') as DB

describe('a tab closed right after an edit', () => {
  it('leaves the edit in its journal, and the tab still open takes it in without waiting for a restart', async () => {
    seed('desk', budget('J'))
    const t1 = await tab('desk')
    const t2 = await tab('desk')
    // Logged, then the tab is gone before its save reaches IndexedDB: only its journal has it.
    t1.S.commit({ txns: [txn('closing', 'cJ')] })
    expect(ids(stored('desk'))).toEqual(['tJ'])
    await t2.S.pullNow()
    expect(ids(t2.S.getDB())).toEqual(['closing', 'tJ'])
  })
})

describe('a budget swapped in one tab', () => {
  it('replaces the old one in every tab; a tab still holding the old one cannot write it back', async () => {
    seed('laptop1', budget('A'))
    const t1 = await tab('laptop1')
    const t2 = await tab('laptop1')
    t1.S.swapDB(budget('B'))
    await t1.S.persistNow()
    expect(ids(stored('laptop1'))).toEqual(['tB'])
    // Tab 2 hasn't taken it in yet and logs something to the old budget: its write is refused and it follows.
    t2.S.commit({ txns: [txn('late', 'cA')] })
    await t2.S.persistNow()
    expect(ids(t2.S.getDB())).toEqual(['tB'])
    expect(t2.S.dbEpoch()).toBe(t1.S.dbEpoch())
    expect(ids(stored('laptop1'))).toEqual(['tB'])
    // A tab opened later replays only journals of the budget that is stored now.
    local.set('money-in-order/journal/dead', JSON.stringify([['txns|old', txn('old', 'cA')]]))
    local.set('money-in-order/journal/live', JSON.stringify({ epoch: t1.S.dbEpoch(), recs: [['txns|kept', txn('kept', 'cB')]] }))
    const t3 = await tab('laptop1')
    expect(ids(t3.S.getDB())).toEqual(['kept', 'tB'])
  })

  it('is taken in by a tab that hears about it, which also forgets its undo history', async () => {
    seed('laptop2', budget('A'))
    const t1 = await tab('laptop2')
    const t2 = await tab('laptop2')
    t2.S.undoable('Log', () => t2.S.commit({ txns: [txn('mine', 'cA')] }))
    await t2.S.persistNow()
    await t1.S.pullNow()
    expect(ids(t1.S.getDB())).toEqual(['mine', 'tA'])
    t1.S.swapDB(budget('C'))
    await t1.S.persistNow()
    await t2.S.pullNow()
    expect(ids(t2.S.getDB())).toEqual(['tC'])
    expect(t2.S.lastUndo()).toBe(null)
    // Edits go on merging normally within the new budget.
    t2.S.commit({ txns: [txn('next', 'cC')] })
    await t2.S.persistNow()
    await t1.S.pullNow()
    expect(ids(t1.S.getDB())).toEqual(['next', 'tC'])
  })
})

describe('sync state shared by the tabs of a device', () => {
  const X = 'ABCDE-FGHJK-MNPQR-STUVW'

  it('turning sync on or off in one tab holds in the others', async () => {
    seed('laptop3', budget('A'))
    const t1 = await tab('laptop3')
    const t2 = await tab('laptop3')
    await t1.sync.initSync()
    await t2.sync.initSync()
    await t1.sync.enableSync(X)
    await t2.sync.syncNow()
    expect(t2.sync.syncStatus().code).toBe(X)
    await t1.sync.disableSync()
    // Tab 2 logs something before it has heard: its sync state doesn't bring sync back.
    t2.S.commit({ txns: [txn('after', 'cA')] })
    await t2.sync.syncNow()
    expect(t2.sync.syncStatus().code).toBe(null)
    expect(deviceOf('laptop3').kv.get('sync')).toBe(null)
  })

  it('a tab still holding a budget replaced by a sign-in in another tab never uploads it', async () => {
    // The phone keeps budget B in an account.
    seed('phone', budget('B'))
    const phone = await tab('phone')
    await phone.sync.initSync()
    expect(await phone.sync.signUp('B@example.com ', 'password-b')).toBe('created')
    // The laptop syncs budget A under code X in two tabs.
    seed('laptop4', budget('A'))
    const t1 = await tab('laptop4')
    const t2 = await tab('laptop4')
    await t1.sync.initSync()
    await t2.sync.initSync()
    await t1.sync.enableSync(X)
    await t2.sync.syncNow()
    expect(await t1.sync.signIn('b@example.com', 'password-b')).toBe('joined')
    // Tab 2 logs to the old budget before it has heard of the sign-in, then syncs.
    t2.S.commit({ txns: [txn('late', 'cA')] })
    await t2.sync.syncNow()
    expect(t2.sync.syncStatus().email).toBe('b@example.com')
    expect(ids(t2.S.getDB())).toEqual(['tB'])
    t2.S.commit({ txns: [txn('fromLaptop', 'cB')] })
    await t2.sync.syncNow()
    await phone.sync.syncNow()
    expect(ids(phone.S.getDB())).toEqual(['fromLaptop', 'tB'])
    await t2.S.persistNow()
    expect(ids(stored('laptop4'))).toEqual(['fromLaptop', 'tB'])
  })
})

describe('accounts', () => {
  it('one account per email; a wrong password or an unknown email is told apart', async () => {
    seed('acct1', budget('C'))
    const a = await tab('acct1')
    await a.sync.initSync()
    expect(await a.sync.signUp('c@example.com', 'correct horse')).toBe('created')
    expect(a.sync.syncStatus()).toMatchObject({ email: 'c@example.com', state: 'idle', dirty: false })
    seed('acct2', budget('D'))
    const b = await tab('acct2')
    await b.sync.initSync()
    expect(await b.sync.signUp('C@example.com', 'another one')).toBe('exists')
    expect(await b.sync.signIn('c@example.com', 'wrong horse')).toBe('wrong')
    expect(await b.sync.signIn('nobody@example.com', 'correct horse')).toBe('none')
    expect(await b.sync.signIn('c@example.com', 'correct horse', () => false)).toBe('cancelled')
    expect(ids(b.S.getDB())).toEqual(['tD'])
    expect(await b.sync.signIn('c@example.com', 'correct horse')).toBe('joined')
    expect(ids(b.S.getDB())).toEqual(['tC'])
    await b.sync.disableSync()
    expect(b.sync.syncStatus().email).toBe(null)
    expect(ids(b.S.getDB())).toEqual(['tC'])
  })
})
