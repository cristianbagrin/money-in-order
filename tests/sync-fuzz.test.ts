/// <reference types="node" />
import { AsyncLocalStorage } from 'node:async_hooks'
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assignedAhead, buildIndex, monthView } from '../src/lib/budget'
import { addMonths, monthOf, pad } from '../src/lib/dates'
import { edit, hasNews, merge, repair } from '../src/lib/merge'
import { COLLECTIONS, emptyDB, live, RTA, type Category, type DB, type Rec, type Target } from '../src/lib/types'

// A seeded fuzz of the sync and persistence layer: two or three devices, one or two tabs each, all signed in to one
// account, editing, syncing, flushing, pulling, reloading and crashing in random order. Afterwards everything must
// converge, no write may be lost, and the budget must still add up.
//
// Every run is deterministic for its seed: crypto, compression, timers, ids and the broadcast channel are stand-ins
// that only ever resolve in microtasks or setImmediate turns, and every await point (IndexedDB, the network) gets a
// seeded number of turns of latency, so concurrent work interleaves differently per seed but the same way every time.
//
//   FUZZ_SEEDS=200 FUZZ_STEPS=400 npx vitest run tests/sync-fuzz.test.ts     hunt harder
//   FUZZ_SEED=17 FUZZ_LOG=1 npx vitest run tests/sync-fuzz.test.ts           replay one seed, printing every step
//   FUZZ_SEED=17 FUZZ_TRACE=<record id> npx vitest run tests/sync-fuzz.test.ts  where that record is after every step

type Store = typeof import('../src/lib/store')
type Sync = typeof import('../src/lib/sync')
type Persist = typeof import('../src/lib/persist')
type Row = Record<string, unknown>

const env = process.env
const SEED0 = Number(env.FUZZ_SEED0 ?? 1)
const SEEDS = env.FUZZ_SEED ? [Number(env.FUZZ_SEED)] : Array.from({ length: Number(env.FUZZ_SEEDS ?? 5) }, (_, i) => SEED0 + i)
const STEPS = Number(env.FUZZ_STEPS ?? 160)
const LOG = !!env.FUZZ_LOG
const MERGE_SEEDS = Number(env.FUZZ_MERGE_SEEDS ?? 300)

// ---------------------------------------------------------------- randomness

/** mulberry32 (as in tests/fixtures/big.ts) */
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rand {
  constructor(readonly next: () => number) {}
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]
  }
  weighted<T>(items: readonly (readonly [number, T])[]): T {
    let x = this.next() * items.reduce((s, [w]) => s + w, 0)
    for (const [w, v] of items) if ((x -= w) < 0) return v
    return items[items.length - 1][1]
  }
}

/** What happens. */
let R = new Rand(mulberry(1))
/** How long each await takes (in event-loop turns). */
let L = new Rand(mulberry(2))
/** Random bytes: record ids, IVs, tab ids. */
let B = new Rand(mulberry(3))

// ---------------------------------------------------------------- the world: devices, tabs, async bookkeeping

interface Dev {
  name: string
  /** this device's IndexedDB */
  kv: Map<string, unknown>
  /** IndexedDB runs one transaction after another */
  queue: Promise<unknown>
  /** this device's localStorage */
  ls: Map<string, string>
  tabs: Tab[]
  /** how far this device's clock is off */
  skew: number
}

interface Tab {
  id: string
  dev: Dev
  S: Store
  sync: Sync
  persist: Persist
  dead: boolean
  channels: FakeChannel[]
  backup?: DB
}

/** Which tab the running code belongs to (follows awaits, timers and messages). */
const ctx = new AsyncLocalStorage<Tab>()
const devices: Dev[] = []
let tabNo = 0
/** Awaitable work in flight (IndexedDB requests, fetches, scheduled jobs). */
let inflight = 0
/** Misuse of the stand-ins, reported as a failure. */
const harness: string[] = []
let log: string[] = []
let stepNo = 0

function note(s: string) {
  const line = `${String(stepNo).padStart(3)} ${s}`
  log.push(line)
  if (LOG) console.log(line)
}

const realImmediate = globalThis.setImmediate
const turn = () => new Promise<void>((r) => realImmediate(r))
async function lag(n: number) {
  for (let i = 0; i < n; i++) await turn()
}
/** What a dead tab waits for. */
const hang = <T,>(): Promise<T> => new Promise<T>(() => {})

/** Wait until nothing is in flight anywhere. */
async function settle() {
  for (let i = 0, quiet = 0; quiet < 2; i++) {
    await turn()
    quiet = inflight === 0 ? quiet + 1 : 0
    if (i > 500_000) throw new Error('harness: never settles')
  }
}

function alive(): Tab[] {
  return devices.flatMap((d) => d.tabs)
}

// ---------------------------------------------------------------- time: one clock, timers fired one at a time

interface Timer {
  at: number
  seq: number
  fn: () => void
  every: number
  owner: Tab | undefined
}
const START = new Date(2026, 9, 22, 9, 0, 0).getTime()
const timers = new Map<number, Timer>()
let clock = START
let timerSeq = 0
let timerIds = 0
/** module loading runs on real timers */
let realTimers = false
const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}

function addTimer(fn: (...a: unknown[]) => void, ms: unknown, args: unknown[], every: number): number {
  const id = ++timerIds
  const owner = ctx.getStore()
  if (owner?.dead) return id
  timers.set(id, { at: clock + Math.max(0, Number(ms) || 0), seq: ++timerSeq, fn: () => fn(...args), every, owner })
  return id
}

const fakeTimers = {
  setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realTimers ? real.setTimeout(fn, ms, ...args) : addTimer(fn, ms, args, 0),
  setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    realTimers ? real.setInterval(fn, ms, ...args) : addTimer(fn, ms, args, Math.max(1, Number(ms) || 0)),
  clearTimeout: (id: unknown) => (typeof id === 'number' ? void timers.delete(id) : real.clearTimeout(id as never)),
  clearInterval: (id: unknown) => (typeof id === 'number' ? void timers.delete(id) : real.clearInterval(id as never)),
}

function setClock(t: number) {
  clock = t
  vi.setSystemTime(t)
}

/** Let `ms` pass, firing every timer that falls due on the way, one at a time. */
async function advance(ms: number) {
  const until = clock + ms
  for (;;) {
    let next: [number, Timer] | null = null
    for (const e of timers) if (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[1].seq < next[1].seq)) next = e
    if (!next || next[1].at > until) break
    const [id, t] = next
    if (t.at > clock) setClock(t.at)
    if (t.every) {
      t.at += t.every
      t.seq = ++timerSeq
    } else timers.delete(id)
    if (t.owner?.dead) continue
    if (t.owner) ctx.run(t.owner, t.fn)
    else t.fn()
    await settle()
  }
  setClock(until)
}

// ---------------------------------------------------------------- crypto and compression (deterministic stand-ins)

const toBuf = (d: unknown): Buffer => {
  if (d instanceof ArrayBuffer) return Buffer.from(d)
  const v = d as ArrayBufferView
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}
const toAB = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer
type FakeKey = { raw: Buffer }

const fakeCrypto = {
  getRandomValues<T extends ArrayBufferView | null>(a: T): T {
    if (a) {
      const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
      for (let i = 0; i < u.length; i++) u[i] = B.int(256)
    }
    return a
  },
  randomUUID: () => randomUUID(),
  subtle: {
    async digest(_alg: unknown, data: unknown) {
      return toAB(createHash('sha256').update(toBuf(data)).digest())
    },
    async importKey(_format: string, data: unknown): Promise<FakeKey> {
      return { raw: Buffer.from(toBuf(data)) }
    },
    // the account's PBKDF2, with fewer rounds
    async deriveBits(alg: { salt: unknown }, key: FakeKey, bits: number) {
      return toAB(pbkdf2Sync(key.raw, toBuf(alg.salt), 1000, bits / 8, 'sha256'))
    },
    async encrypt(alg: { iv: unknown }, key: FakeKey, data: unknown) {
      const c = createCipheriv('aes-256-gcm', key.raw, toBuf(alg.iv))
      return toAB(Buffer.concat([c.update(toBuf(data)), c.final(), c.getAuthTag()]))
    },
    async decrypt(alg: { iv: unknown }, key: FakeKey, data: unknown) {
      const b = toBuf(data)
      const d = createDecipheriv('aes-256-gcm', key.raw, toBuf(alg.iv))
      d.setAuthTag(b.subarray(b.length - 16))
      return toAB(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]))
    },
  },
}

/** gzip stand-in: passes the bytes through, so a sync never waits on the thread pool. */
class Identity extends TransformStream<Uint8Array, Uint8Array> {
  constructor(_format?: string) {
    super()
  }
}

// ---------------------------------------------------------------- IndexedDB (per device), localStorage (per device)

function idbOf(t: Tab) {
  const dev = t.dev
  const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v))
  // One transaction after another, each after a few turns; a dead tab's requests never run (nor answer).
  function run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (t.dead) return hang()
    inflight++
    return new Promise<T>((resolve, reject) => {
      dev.queue = dev.queue.then(async () => {
        await lag(L.int(3))
        if (t.dead) return void inflight--
        try {
          const v = await fn()
          inflight--
          resolve(v)
        } catch (e) {
          inflight--
          reject(e)
        }
      })
    })
  }
  type Req = { result?: unknown; onsuccess?: () => void }
  return {
    get: (k: string) => run(() => clone(dev.kv.get(k))),
    getMany: (ks: string[]) => run(() => ks.map((k) => clone(dev.kv.get(k)))),
    set: (k: string, v: unknown) => {
      const c = clone(v)
      return run(() => void dev.kv.set(k, c))
    },
    update: (k: string, f: (v: unknown) => unknown) => run(() => void dev.kv.set(k, clone(f(clone(dev.kv.get(k)))))),
    createStore: () => (_mode: string, callback: (os: unknown) => unknown) =>
      run(
        () =>
          new Promise((resolve, reject) => {
            const reqs: (() => void)[] = []
            const writes = new Map<string, unknown>()
            const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error?: unknown } = {}
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
              get: (k: string) => request((req) => (req.result = clone(writes.has(k) ? writes.get(k) : dev.kv.get(k)))),
              put: (v: unknown, k: string) => {
                const c = clone(v)
                return request(() => void writes.set(k, c))
              },
            }
            let out: unknown
            try {
              out = callback(os)
            } catch (e) {
              return reject(e)
            }
            // requests run one per turn; the transaction commits (atomically) once none is left
            const pump = () => {
              const next = reqs.shift()
              if (!next) {
                for (const [k, v] of writes) dev.kv.set(k, v)
                tx.oncomplete?.()
                return
              }
              next()
              realImmediate(pump)
            }
            realImmediate(pump)
            Promise.resolve(out).then(resolve, reject)
          }),
      ),
  }
}

function lsHere(): Map<string, string> | null {
  const t = ctx.getStore()
  if (!t) {
    harness.push('localStorage used outside a tab')
    return null
  }
  return t.dev.ls
}

const fakeLocalStorage = {
  get length() {
    return lsHere()?.size ?? 0
  },
  key: (i: number) => [...(lsHere()?.keys() ?? [])][i] ?? null,
  getItem: (k: string) => lsHere()?.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (!ctx.getStore()?.dead) lsHere()?.set(k, v)
  },
  removeItem: (k: string) => {
    if (!ctx.getStore()?.dead) lsHere()?.delete(k)
  },
}

// ---------------------------------------------------------------- BroadcastChannel: per device, delivered when the fuzz says

let loading: Tab | null = null
const mail: { to: FakeChannel; from: string }[] = []

class FakeChannel {
  onmessage: ((e: { data: unknown }) => void) | null = null
  readonly tab: Tab
  constructor(readonly name: string) {
    if (!loading) throw new Error('harness: BroadcastChannel opened outside a tab')
    this.tab = loading
    loading.channels.push(this)
  }
  postMessage(_data: unknown) {
    if (this.tab.dead) return
    for (const t of this.tab.dev.tabs) if (t !== this.tab) for (const c of t.channels) if (c.name === this.name) mail.push({ to: c, from: this.tab.id })
  }
  close() {}
}

function deliverOne(i: number) {
  const [m] = mail.splice(i, 1)
  if (m && !m.to.tab.dead && m.to.onmessage) {
    const fn = m.to.onmessage
    ctx.run(m.to.tab, () => fn({ data: 1 }))
  }
}

async function deliverAll() {
  while (mail.length) {
    deliverOne(0)
    await settle()
  }
}

// ---------------------------------------------------------------- the sync server

const vault = new Map<string, { rev: string; body: string }>()
/** Each vault's log of changes on top of its snapshot (see netlify/functions/vault.mts). */
const changes = new Map<string, Map<string, string>>()
let changeNo = 0
const emails = new Set<string>()
let revs = 0
type Hook = { method: string; when: 'before' | 'after'; fn: () => Promise<void> | void }
let hooks: Hook[] = []
let fault: 'lost' | 'fail' | null = null
const stats = { puts: 0, changes: 0, conflicts: 0, lost: 0, failed: 0, reloads: 0, crashes: 0, undos: 0 }

function handle(url: string, method: string, init: RequestInit): Response {
  const id = url.split('/').pop()!
  if (url.startsWith('/api/account/')) {
    if (method === 'PUT') {
      if (emails.has(id)) return new Response(null, { status: 409 })
      emails.add(id)
      return new Response(null, { status: 201 })
    }
    return new Response(null, { status: emails.has(id) ? 200 : 404 })
  }
  const headers = new Headers(init.headers)
  const cur = vault.get(id)
  const log = changes.get(id) ?? new Map<string, string>()
  const ids = (h: string | null) => (h ?? '').split(',').filter(Boolean)
  if (method === 'POST') {
    if (!cur) return new Response(null, { status: 404 })
    stats.changes++
    const c = String(++changeNo)
    changes.set(id, log.set(c, init.body as string))
    return new Response(null, { status: 201, headers: { 'X-Change': c } })
  }
  if (method !== 'PUT') {
    if (!cur) return new Response(null, { status: 404 })
    if (headers.get('X-Sync') === '2') {
      const have = new Set(ids(headers.get('X-Have')))
      const snap = headers.get('X-Have-Rev') === cur.rev ? undefined : cur.body
      const add = [...log].filter(([c]) => !have.has(c))
      return new Response(JSON.stringify({ rev: cur.rev, changes: [...log.keys()], snap, add }), { status: 200 })
    }
    if (headers.get('X-Have-Rev') === cur.rev) return new Response(null, { status: 204, headers: { 'X-Rev': cur.rev } })
    return new Response(method === 'HEAD' ? null : cur.body, { status: 200, headers: { 'X-Rev': cur.rev } })
  }
  if ((cur?.rev ?? 'new') !== headers.get('X-Base-Rev')) {
    stats.conflicts++
    return new Response(null, { status: 412 })
  }
  stats.puts++
  const rev = String(++revs)
  vault.set(id, { rev, body: init.body as string })
  for (const c of ids(headers.get('X-Covers'))) log.delete(c)
  return new Response(null, { status: 201, headers: { 'X-Rev': rev } })
}

async function runHooks(method: string, when: Hook['when']) {
  const due = hooks.filter((h) => h.method === method && h.when === when)
  if (!due.length) return
  hooks = hooks.filter((h) => !due.includes(h))
  for (const h of due) await h.fn()
}

async function server(input: unknown, init: RequestInit = {}): Promise<Response> {
  const url = String(input)
  const t = ctx.getStore()
  if (!t) harness.push(`fetch outside a tab: ${url}`)
  if (t?.dead) return hang()
  inflight++
  try {
    await lag(L.int(3))
    if (t?.dead) return hang()
    const method = init.method ?? 'GET'
    // an upload is a PUT (the whole budget) or a POST (a change): hooks and faults treat both alike
    const upload = (method === 'PUT' || method === 'POST') && url.startsWith('/api/vault/')
    const hook = method === 'POST' ? 'PUT' : method
    await runHooks(hook, 'before')
    if (upload && fault === 'fail') {
      fault = null
      stats.failed++
      return new Response(null, { status: 503 })
    }
    const res = handle(url, method, init)
    await runHooks(hook, 'after')
    if (upload && fault === 'lost') {
      // the server took it, the answer never arrived
      fault = null
      stats.lost++
      throw new TypeError('Failed to fetch')
    }
    await lag(L.int(3))
    if (t?.dead) return hang()
    return res
  } finally {
    inflight--
  }
}

/** What the server holds (the test knows the account's secret). */
function serverDB(code: string): DB | null {
  const raw = Buffer.from(code.replace(/-/g, ''))
  const id = createHash('sha256').update(Buffer.concat([Buffer.from('money-in-order/id/'), raw])).digest('hex')
  const key = createHash('sha256').update(Buffer.concat([Buffer.from('money-in-order/key/'), raw])).digest()
  const v = vault.get(id)
  if (!v) return null
  const open = (body: string) => {
    const [, iv, ct] = body.split('.')
    const b = Buffer.from(ct, 'base64')
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    d.setAuthTag(b.subarray(b.length - 16))
    return JSON.parse(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString()).db as DB
  }
  // the snapshot with every change in the log merged in
  return [...(changes.get(id)?.values() ?? [])].reduce((db, c) => merge(db, open(c)), merge(emptyDB(), open(v.body)))
}

/** Changes whenever the server's data does (a new snapshot or a change appended or folded in). */
function serverVersion(): string {
  const [id, v] = [...vault.entries()][0] ?? []
  return v ? `${v.rev}/${[...(changes.get(id!)?.keys() ?? [])].join(',')}` : ''
}

// ---------------------------------------------------------------- tabs

/** Open a tab of the app on a device, the way main.tsx boots it. */
async function openTab(dev: Dev): Promise<Tab> {
  const t = { id: `${dev.name}#${++tabNo}`, dev, dead: false, channels: [] } as unknown as Tab
  vi.resetModules()
  vi.doMock('idb-keyval', () => idbOf(t))
  const random = Math.random
  Math.random = () => B.next()
  loading = t
  realTimers = true
  try {
    t.persist = await import('../src/lib/persist')
    t.S = await import('../src/lib/store')
    t.sync = await import('../src/lib/sync')
  } finally {
    Math.random = random
    loading = null
    realTimers = false
  }
  dev.tabs.push(t)
  await ctx.run(t, async () => {
    const { db, replayed } = await t.persist.loadDB()
    if (db) t.S.replaceDB(db)
    t.persist.startPersistence({ replayed })
    void t.sync.initSync({ dirty: replayed })
  })
  await settle()
  note(`open ${t.id}`)
  return t
}

/** The tab is gone: nothing it does from now on reaches storage, the network or other tabs. */
function kill(t: Tab) {
  t.dead = true
  t.dev.tabs.splice(t.dev.tabs.indexOf(t), 1)
  for (const [id, x] of timers) if (x.owner === t) timers.delete(id)
}

async function act<T>(t: Tab, fn: () => Promise<T> | T): Promise<T> {
  const out = await ctx.run(t, async () => fn())
  await settle()
  return out
}

// ---------------------------------------------------------------- the model: every durable write, and what ops did

/** Same rules as merge.ts. */
function stampsOf(r: Rec) {
  return r.f && r.f.$ === r.u ? r.f : null
}
function baseOf(r: Rec): number {
  return stampsOf(r)?._ ?? r.u
}
function stampOf(r: Rec, k: string): number {
  const f = stampsOf(r)
  return f ? (f[k] ?? f._ ?? r.u) : r.u
}
const OWN = new Set(['id', 'u', 'd', 'f'])
function fieldsOf(r: Rec): string[] {
  const out = new Set<string>()
  for (const k in r) if (!OWN.has(k)) out.add(k)
  const f = stampsOf(r)
  if (f) for (const k in f) if (k !== '$' && k !== '_') out.add(k)
  return [...out]
}
function rank(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v)
}
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  )
}
/** A record as merge sees it: its time, tombstone, base time, and every field's time and value. */
function norm(r: Rec): string {
  const base = baseOf(r)
  const fields: [string, number, string][] = []
  for (const k of fieldsOf(r)) {
    const v = (r as unknown as Row)[k]
    const s = stampOf(r, k)
    if (v === undefined && s === base) continue
    fields.push([k, s, v === undefined ? '-' : canon(v)])
  }
  fields.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return JSON.stringify([r.u, r.d ? 1 : 0, base, fields])
}
function normDB(db: DB): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of COLLECTIONS) {
    const coll = (db[name] ?? {}) as Record<string, Rec>
    for (const id of Object.keys(coll).sort()) out.set(`${name}|${id}`, norm(coll[id]))
  }
  return out
}
function diffDB(a: DB, b: DB, max = 6): string[] {
  const na = normDB(a)
  const nb = normDB(b)
  const out: string[] = []
  for (const k of new Set([...na.keys(), ...nb.keys()])) {
    if (na.get(k) === nb.get(k)) continue
    out.push(`${k}\n      ${na.get(k) ?? '(missing)'}\n      ${nb.get(k) ?? '(missing)'}`)
    if (out.length >= max) break
  }
  return out
}
function sameDB(a: DB, b: DB): boolean {
  const na = normDB(a)
  const nb = normDB(b)
  if (na.size !== nb.size) return false
  for (const [k, v] of na) if (nb.get(k) !== v) return false
  return true
}

/** The newest durable write seen of every record and every field. */
class Oracle {
  fields = new Map<string, { s: number; r: string; who: string }>()
  recs = new Map<string, { u: number; d: boolean; who: string }>()
  private seen = new WeakSet<object>()

  observe(name: string, r: Rec, who: string) {
    if (this.seen.has(r)) return
    this.seen.add(r)
    const key = `${name}|${r.id}`
    const br = this.recs.get(key)
    if (!br || r.u > br.u || (r.u === br.u && r.d && !br.d)) this.recs.set(key, { u: r.u, d: !!r.d, who })
    for (const k of fieldsOf(r)) {
      const s = stampOf(r, k)
      const rk = rank((r as unknown as Row)[k])
      const fk = `${key}|${k}`
      const b = this.fields.get(fk)
      if (!b || s > b.s || (s === b.s && rk > b.r)) this.fields.set(fk, { s, r: rk, who })
    }
  }

  observeDB(db: DB, who: string) {
    for (const name of COLLECTIONS) {
      const coll = (db[name] ?? {}) as Record<string, Rec>
      for (const id in coll) this.observe(name, coll[id], who)
    }
  }

  /** Writes the final database doesn't hold (something newer than what it has). */
  lost(db: DB, max = 8): string[] {
    const out: string[] = []
    const recOf = (key: string): Rec | undefined => {
      const i = key.indexOf('|')
      return ((db as unknown as Record<string, Record<string, Rec>>)[key.slice(0, i)] ?? {})[key.slice(i + 1)]
    }
    for (const [key, b] of this.recs) {
      const r = recOf(key)
      if (!r) out.push(`${key}: missing (last written by ${b.who})`)
      else if (b.u > r.u || (b.u === r.u && b.d && !r.d)) out.push(`${key}: has u=${r.u} d=${!!r.d}, ${b.who} wrote u=${b.u} d=${b.d}`)
      if (out.length >= max) return out
    }
    for (const [fk, b] of this.fields) {
      const j = fk.lastIndexOf('|')
      const r = recOf(fk.slice(0, j))
      if (!r) continue
      const k = fk.slice(j + 1)
      const s = stampOf(r, k)
      const rk = rank((r as unknown as Row)[k])
      if (b.s > s || (b.s === s && b.r > rk)) out.push(`${fk}: has ${rk || 'nothing'} @${s}, ${b.who} wrote ${b.r || 'nothing'} @${b.s}`)
      if (out.length >= max) return out
    }
    return out
  }
}

let oracle = new Oracle()
/** Records the fuzz's own operations created and deleted. */
const created = new Set<string>()
const deletedByOp = new Set<string>()
const findings: string[] = []
const lastJournal = new Map<string, string>()
let lastServerRev = ''
let lastStored = new Map<Dev, unknown>()

/** Take note of everything now stored durably: each device's IndexedDB and journals, and the server. */
function observeDurable(code: string) {
  for (const d of devices) {
    const db = d.kv.get('db')
    if (db && lastStored.get(d) !== db) {
      lastStored.set(d, db)
      oracle.observeDB(db as DB, `${d.name}/idb`)
    }
    const epoch = (d.kv.get('dbe') as string | undefined) ?? ''
    for (const [k, raw] of d.ls) {
      if (!k.startsWith('money-in-order/journal/') || lastJournal.get(k) === raw) continue
      lastJournal.set(k, raw)
      const data = JSON.parse(raw) as { epoch: string; recs: [string, Rec][] }
      if (data.epoch !== epoch) continue
      for (const [key, rec] of data.recs) oracle.observe(key.slice(0, key.indexOf('|')), rec, `${d.name}/journal`)
    }
  }
  const version = serverVersion()
  if (version && version !== lastServerRev) {
    lastServerRev = version
    const db = serverDB(code)
    if (db) oracle.observeDB(db, `server@${version}`)
  }
}

// ---------------------------------------------------------------- what the user does

const NAMES = ['Food', 'Rent', 'Travel', 'Gifts', 'Books', 'Bills', 'Fun', 'Kids', 'Car', 'Pets']
const NOTES = ['lunch', 'groceries', 'bus', 'gift for mom', 'pharmacy', 'coffee']
const TARGETS: (() => Target)[] = [
  () => ({ kind: 'monthly', amount: (1 + R.int(50)) * 1000 }),
  () => ({ kind: 'topup', amount: (1 + R.int(50)) * 1000 }),
  () => ({ kind: 'goal', amount: (1 + R.int(500)) * 1000, by: addMonths('2026-10', R.int(12)) }),
]

/** One user action on a tab, as the UI does it. Returns what it was, or null when it doesn't apply here. */
function userAction(t: Tab): string {
  const S = t.S
  for (let tries = 0; tries < 8; tries++) {
    const db = S.getDB()
    const C = monthOf(S.today())
    const cats = live(db.cats)
    const active = cats.filter((c) => !c.archived)
    const archived = cats.filter((c) => c.archived)
    const groups = live(db.groups)
    const txns = live(db.txns)
    const accts = live(db.accounts)
    const m = addMonths(C, R.int(4) - 2)
    const day = () => `${m}-${pad(1 + R.int(28))}`
    const amount = () => (1 + R.int(2000)) * 100
    const catOrRta = () => (R.chance(0.2) || !active.length ? RTA : R.pick(active).id)
    const name = () => `${R.pick(NAMES)} ${R.int(100)}`
    const u = (label: string, fn: () => unknown) => {
      S.undoable(label, fn)
      return label
    }
    const actions: [number, () => string | null][] = [
      [
        12,
        () => {
          const cat = catOrRta()
          const cur = R.chance(0.15) ? 'EUR' : 'TWD'
          const a = cat === RTA ? amount() * 10 : -amount()
          return u('addTxn', () =>
            S.addTxn({ date: day(), cat, amt: a, cur, note: R.chance(0.3) ? R.pick(NOTES) : undefined, acct: accts.length && R.chance(0.3) ? R.pick(accts).id : undefined }),
          )
        },
      ],
      [
        7,
        () => {
          if (!txns.length) return null
          const x = R.pick(txns)
          const patch: Parameters<Store['updateTxn']>[1] = {}
          for (let n = 1 + R.int(2); n > 0; n--) {
            const k = R.int(5)
            if (k === 0) patch.amt = x.amt < 0 ? -amount() : amount()
            else if (k === 1) patch.cur = x.cur === 'EUR' ? 'TWD' : 'EUR'
            else if (k === 2) patch.note = R.chance(0.4) ? '' : R.pick(NOTES)
            else if (k === 3 && x.kind !== 'move') patch.cat = catOrRta()
            else patch.date = day()
          }
          return u(`updateTxn ${Object.keys(patch).join(',')}`, () => S.updateTxn(x.id, patch))
        },
      ],
      [3, () => (txns.length ? u('deleteTxn', () => S.deleteTxn(R.pick(txns).id)) : null)],
      [1, () => (txns.length > 2 ? u('deleteTxns', () => S.deleteTxns([R.pick(txns).id, R.pick(txns).id, R.pick(txns).id])) : null)],
      [6, () => (active.length ? u('setAssigned', () => S.setAssigned(m, R.pick(active).id, R.int(100) * 1000)) : null)],
      [
        4,
        () => {
          const ends = [RTA, ...active.map((c) => c.id)]
          return ends.length > 1 ? u('moveMoney', () => S.moveMoney(m, R.pick(ends), R.pick(ends), (1 + R.int(50)) * 1000)) : null
        },
      ],
      [2, () => (groups.length ? u('addCategory', () => S.addCategory(R.pick(groups).id, name(), R.chance(0.3) ? { target: R.pick(TARGETS)() } : {})) : null)],
      [
        4,
        () => {
          if (!cats.length) return null
          const c = R.pick(cats)
          const v = R.int(6)
          const next: Category =
            v === 0
              ? { ...c, name: name() }
              : v === 1
                ? { ...c, target: R.pick(TARGETS)() }
                : v === 2
                  ? { ...c, target: undefined }
                  : v === 3
                    ? { ...c, daily: c.daily ? undefined : true }
                    : v === 4
                      ? { ...c, note: c.note ? undefined : R.pick(NOTES) }
                      : { ...c, saving: c.saving ? undefined : true }
          return u(`saveCategory ${['name', 'target', 'no target', 'daily', 'note', 'saving'][v]}`, () => S.saveCategory(next))
        },
      ],
      [1, () => (active.length ? u('archiveCategory', () => S.archiveCategory(R.pick(active).id, C, C)) : null)],
      [1, () => (archived.length ? u('unarchiveCategory', () => S.unarchiveCategory(R.pick(archived).id)) : null)],
      [
        2,
        () => {
          if (!cats.length) return null
          const c = R.pick(cats)
          const others = active.filter((x) => x.id !== c.id)
          const used = S.categoryHasHistory(c.id)
          const how = !used && R.chance(0.7) ? 'plain' : R.weighted([[3, 'into'], [3, 'drop'], [1, 'plain']] as const)
          if (how === 'into' && others.length) {
            const into = R.pick(others).id
            return u('deleteCategory into', () => S.deleteCategory(c.id, { into }))
          }
          if (how === 'drop') return u('deleteCategory dropTxns', () => S.deleteCategory(c.id, { dropTxns: true }))
          return u(`deleteCategory${used ? ' (used)' : ''}`, () => S.deleteCategory(c.id))
        },
      ],
      [2, () => (cats.length && groups.length ? u('placeCategory', () => S.placeCategory(R.pick(cats).id, R.pick(groups).id, R.int(6))) : null)],
      [1, () => u('addGroup', () => S.addGroup(name()))],
      [1, () => (groups.length ? u('deleteGroup', () => S.deleteGroup(R.pick(groups).id)) : null)],
      [1, () => u('addAccount', () => S.addAccount(name(), R.chance(0.7) ? 'TWD' : 'EUR', { invest: R.chance(0.2) }))],
      [
        1,
        () => {
          if (!accts.length) return null
          const bal: Record<string, number> = {}
          for (const a of accts) if (R.chance(0.7)) bal[a.id] = R.int(100_000) * 100
          const diffTo = R.chance(0.7) || !active.length ? RTA : R.pick(active).id
          return u('recordCount', () => S.recordCount({ date: S.today(), bal, rates: S.settings().rates, diffTo }))
        },
      ],
      [
        1,
        () => {
          const cash = accts.filter((a) => !a.invest)
          if (cash.length < 2) return null
          const [from, to] = [R.pick(cash), R.pick(cash)]
          return from.id === to.id ? null : u('addMove', () => S.addMove({ date: day(), from: from.id, to: to.id, amt: amount() }))
        },
      ],
      [
        4,
        () => {
          const e = S.undo()
          stats.undos++
          return e ? `undo ${e.label}` : null
        },
      ],
      [
        2,
        () => {
          const e = S.redo()
          return e ? `redo ${e.label}` : null
        },
      ],
      [1, () => u('setNote', () => S.setNote(m, R.chance(0.2) ? '' : `${R.pick(NOTES)} ${R.int(100)}`))],
      [
        3,
        () => {
          const tx = txns.filter((x) => !x.kind)
          if (!tx.length) return null
          const every = R.chance(0.2) ? null : R.pick(['month', 'year'] as const)
          return u(`setRepeat ${every}`, () => S.setRepeat(R.pick(tx).id, every))
        },
      ],
      [
        2,
        () => {
          // Time passes: a repeat set up a while ago logs what came due, as the app does on every change.
          const reps = live(db.repeats)
          if (!reps.length) return null
          const r = R.pick(reps)
          S.commit({ repeats: [{ ...r, after: `${addMonths(C, -1 - R.int(4))}-01` }] })
          noteWrites(t, db, S.getDB(), 'repeat set up earlier')
          const before = S.getDB()
          const made = S.logRepeats(S.today()).length
          noteWrites(t, before, S.getDB(), 'logRepeats')
          return `logRepeats ${made}`
        },
      ],
      [
        1,
        () => {
          const v = R.int(4)
          if (v === 0) return u('settings savingsTarget', () => S.updateSettings({ savingsTarget: R.int(50) / 100 }))
          if (v === 1) return u('settings currencies', () => S.updateSettings({ extraCurrencies: R.chance(0.5) ? ['EUR'] : ['EUR', 'USD'] }))
          if (v === 2) return u('settings rates', () => S.updateSettings({ rates: { ...S.settings().rates, EUR: 30 + R.int(10) }, ratesAt: Date.now() }))
          return u('settings trackAccounts', () => S.setTrackAccounts(R.chance(0.5)))
        },
      ],
      [
        0.6,
        () => {
          if (!t.backup || R.chance(0.5)) {
            t.backup = structuredClone(db)
            return 'backup taken'
          }
          const backup = structuredClone(t.backup)
          return u('restoreBackup', () => S.restoreBackup(backup))
        },
      ],
    ]
    const before = S.getDB()
    const label = R.weighted(actions)()
    if (label === null) continue
    noteWrites(t, before, S.getDB(), label)
    return label
  }
  return 'nothing applied'
}

/** What one action wrote: new records, tombstones, and that every new time is newer than anything the tab held. */
function noteWrites(t: Tab, before: DB, after: DB, label: string) {
  if (before === after) return
  let maxBefore = 0
  for (const name of COLLECTIONS) for (const r of Object.values(before[name] as Record<string, Rec>)) if (r.u > maxBefore) maxBefore = r.u
  for (const name of COLLECTIONS) {
    const a = after[name] as Record<string, Rec>
    const b = before[name] as Record<string, Rec>
    if (a === b) continue
    for (const id in a) {
      const r = a[id]
      if (r === b[id]) continue
      const key = `${name}|${id}`
      if (!b[id]) created.add(key)
      if (r.d && !b[id]?.d) deletedByOp.add(key)
      // repair revives a record at its deletion time + 1, which may be a time this tab's next stamp() repeats
      const revived = (!!b[id]?.d && !r.d && r.u === b[id].u + 1) || (label.startsWith('logRepeats') && !b[id])
      if (r.u <= maxBefore && !revived) findings.push(`stamp not newer than the tab's data: ${t.id} ${label} wrote ${key} at u=${r.u}, tab already held u=${maxBefore}`)
      oracle.observe(name, r, `${t.id} ${label}`)
    }
  }
}

// ---------------------------------------------------------------- checks

/** NaN anywhere, and the plan's books: money in = ready to assign + available + given to later months. */
function budgetProblems(db: DB, current: string): string[] {
  const out: string[] = []
  for (const t of Object.values(db.txns)) if (!t.d && (!Number.isFinite(t.amt) || !Number.isFinite(t.base))) out.push(`txn ${t.id} amount ${t.amt}/${t.base}`)
  for (const a of Object.values(db.assigns)) if (!a.d && !Number.isFinite(a.amt)) out.push(`assign ${a.id} amount ${a.amt}`)
  const ix = buildIndex(db)
  for (const m of new Set([...ix.months, current])) {
    const v = monthView(ix, m, current)
    const nums = [v.readyToAssign, v.available, v.assigned, v.need, v.spent, v.saved, ...v.cats.flatMap((c) => [c.available, c.assigned, c.activity, c.carry, c.need, c.goal])]
    if (nums.some((x) => !Number.isFinite(x))) out.push(`NaN in ${m}`)
  }
  const v = monthView(ix, current, current)
  let money = 0
  for (const t of Object.values(db.txns)) if (!t.d && monthOf(t.date) <= current) money += t.base
  const rhs = v.readyToAssign + v.cats.reduce((s, c) => s + c.available, 0) + assignedAhead(ix, current)
  if (money !== rhs) {
    const live = new Set(ix.cats.map((c) => c.id))
    const orphans = [
      ...Object.values(db.txns).filter((t) => !t.d && t.cat !== RTA && !live.has(t.cat)).map((t) => `txn ${t.id} in ${t.cat}`),
      ...Object.values(db.assigns).filter((a) => !a.d && a.amt && !live.has(a.cat)).map((a) => `assign ${a.id}`),
    ]
    out.push(`books don't add up: money ${money} != ${rhs} (orphans: ${orphans.slice(0, 4).join(', ') || 'none'})`)
  }
  return out
}

/** merge is commutative, associative and idempotent over these databases. */
function algebraProblems(dbs: DB[], r: Rand): string[] {
  const out: string[] = []
  const eq = (a: DB, b: DB, what: string) => {
    if (!sameDB(a, b)) out.push(`${what}: ${diffDB(a, b, 2).join('; ')}`)
  }
  for (const a of dbs) eq(merge(a, structuredClone(a)), a, 'merge(a, a) != a')
  for (let i = 0; i < 6 && dbs.length > 1; i++) {
    const [a, b, c] = [r.pick(dbs), r.pick(dbs), r.pick(dbs)]
    const ab = merge(a, b)
    eq(ab, merge(b, a), 'merge(a, b) != merge(b, a)')
    eq(merge(ab, c), merge(a, merge(b, c)), 'merge(merge(a, b), c) != merge(a, merge(b, c))')
    eq(merge(ab, b), ab, 'merge(merge(a, b), b) != merge(a, b)')
    if (hasNews(ab, a) || hasNews(ab, b)) out.push('hasNews(merge(a, b), a or b)')
  }
  let all = dbs[0]
  for (const d of dbs.slice(1)) all = merge(all, d)
  let back = dbs[dbs.length - 1]
  for (const d of dbs.slice(0, -1).reverse()) back = merge(d, back)
  eq(all, back, 'folding in another order')
  return out
}

// ---------------------------------------------------------------- one run

const EMAIL = 'fuzz@example.com'
const PASSWORD = 'correct horse battery'

function reset(seed: number) {
  R = new Rand(mulberry(seed))
  L = new Rand(mulberry(seed * 7919 + 17))
  B = new Rand(mulberry(seed * 104_729 + 31))
  devices.length = 0
  timers.clear()
  mail.length = 0
  vault.clear()
  changes.clear()
  changeNo = 0
  emails.clear()
  hooks = []
  fault = null
  revs = 0
  tabNo = 0
  inflight = 0
  harness.length = 0
  log = []
  stepNo = 0
  oracle = new Oracle()
  created.clear()
  deletedByOp.clear()
  findings.length = 0
  lastJournal.clear()
  lastServerRev = ''
  lastStored = new Map()
  for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0
  setClock(START)
}

function newDev(name: string, skew: number): Dev {
  const d: Dev = { name, kv: new Map(), queue: Promise.resolve(), ls: new Map(), tabs: [], skew }
  devices.push(d)
  return d
}

async function setup(): Promise<string> {
  const names = ['phone', 'laptop', 'tablet'].slice(0, 2 + R.int(2))
  const [first, ...rest] = names.map((n, i) => newDev(n, i === 0 ? 0 : R.int(4001) - 2000))
  const a = await openTab(first)
  await act(a, async () => {
    a.S.updateSettings({ base: 'TWD', rates: { EUR: 35, USD: 32 }, extraCurrencies: ['EUR'], ready: 1 })
    a.S.seedCategories()
    a.S.addTxn({ date: `${monthOf(a.S.today())}-01`, cat: RTA, amt: 10_000_000, cur: 'TWD', kind: 'start', note: 'Starting balance' })
    a.S.addAccount('Bank', 'TWD')
    a.S.addAccount('Cash', 'TWD')
    a.S.clearUndo()
    expect(await a.sync.signUp(EMAIL, PASSWORD)).toBe('created')
  })
  const code = a.sync.syncStatus().code!
  if (R.chance(0.5)) await openTab(first)
  for (const d of rest) {
    const t1 = await openTab(d)
    if (R.chance(0.5)) await openTab(d)
    const join = R.chance(0.7) ? 'signIn' : 'enableSync'
    await act(t1, async () => {
      // a budget of its own: replaced by a sign-in, merged in by a sync code
      if (R.chance(0.5)) {
        t1.S.seedCategories()
        t1.S.addTxn({ date: `${monthOf(t1.S.today())}-02`, cat: RTA, amt: 500_000, cur: 'TWD' })
      }
      if (join === 'signIn') expect(await t1.sync.signIn(EMAIL, PASSWORD)).toBe('joined')
      else await t1.sync.enableSync(code, EMAIL)
    })
    note(`${d.name} joined by ${join}`)
    await deliverAll()
  }
  for (const t of alive()) expect(t.sync.syncStatus().code, `${t.id} is signed in`).toBe(code)
  return code
}

function someTab(): Tab {
  return R.pick(alive())
}

/** One random thing happening. */
async function step(code: string) {
  const kind = R.weighted([
    [40, 'edit'],
    [10, 'sync'],
    [5, 'flush'],
    [5, 'pull'],
    [8, 'deliver'],
    [8, 'time'],
    [9, 'concurrent'],
    [3, 'conflict'],
    [3, 'midsync'],
    [1.5, 'reload'],
    [1.5, 'crash'],
    [1, 'tabs'],
    [1.5, 'fault'],
  ] as const)
  switch (kind) {
    case 'edit': {
      const t = someTab()
      note(`${t.id} ${await act(t, () => userAction(t))}`)
      break
    }
    case 'sync': {
      const t = someTab()
      note(`${t.id} sync`)
      await act(t, () => t.sync.syncNow())
      break
    }
    case 'flush': {
      const t = someTab()
      note(`${t.id} flush`)
      await act(t, () => t.S.persistNow())
      break
    }
    case 'pull': {
      const t = someTab()
      note(`${t.id} pull`)
      await act(t, () => t.S.pullNow())
      break
    }
    case 'deliver': {
      if (!mail.length) break
      if (R.chance(0.5)) {
        note(`deliver all (${mail.length})`)
        await deliverAll()
      } else {
        note('deliver one')
        deliverOne(R.int(mail.length))
        await settle()
      }
      break
    }
    case 'time': {
      const ms = R.pick([100, 260, 300, 1000, 1300, 5100, 16_000, 61_000])
      note(`time +${ms}ms`)
      await advance(ms)
      break
    }
    case 'concurrent': {
      // several things at once, each starting after a few turns: edits land in the middle of saves, pulls and syncs
      const n = 2 + R.int(4)
      const crashed: Dev[] = []
      const what: string[] = []
      for (let k = 0; k < n; k++) {
        const t = someTab()
        const delay = R.int(10)
        const job = R.weighted([
          [5, 'edit'],
          [2, 'flush'],
          [2, 'pull'],
          [3, 'sync'],
          [1, 'deliver'],
          [0.5, 'crash'],
        ] as const)
        what.push(`${t.id}:${job}+${delay}`)
        inflight++
        void ctx.run(t, async () => {
          try {
            await lag(delay)
            if (t.dead) return
            if (job === 'edit') note(`  ${t.id} ${userAction(t)}`)
            else if (job === 'flush') void t.S.persistNow()
            else if (job === 'pull') void t.S.pullNow()
            else if (job === 'sync') void t.sync.syncNow()
            else if (job === 'deliver') {
              if (mail.length) deliverOne(R.int(mail.length))
            } else if (alive().length > 1) {
              note(`  crash ${t.id}`)
              stats.crashes++
              kill(t)
              crashed.push(t.dev)
            }
          } finally {
            inflight--
          }
        })
      }
      note(`concurrent ${what.join(' ')}`)
      await settle()
      for (const d of crashed) if (!d.tabs.length || R.chance(0.5)) await openTab(d)
      break
    }
    case 'conflict': {
      // two devices upload from the same revision: the second gets 412, pulls, merges and tries again
      const t = someTab()
      const others = alive().filter((o) => o !== t)
      if (!others.length) break
      const o = R.pick(others)
      note(`conflict: ${t.id} uploads while ${o.id} gets in first`)
      await act(t, () => userAction(t))
      hooks.push({
        method: 'PUT',
        when: 'before',
        fn: async () => {
          await ctx.run(o, async () => {
            note(`  ${o.id} ${userAction(o)}`)
            await o.sync.syncNow()
          })
        },
      })
      await act(t, () => t.sync.syncNow())
      break
    }
    case 'midsync': {
      // edits while a sync is talking to the server
      const t = someTab()
      const method = R.pick(['GET', 'PUT'])
      const when = R.pick(['before', 'after'] as const)
      note(`${t.id} sync, edits ${when} its ${method}`)
      if (method === 'PUT') await act(t, () => userAction(t))
      hooks.push({
        method,
        when,
        fn: () => {
          for (let k = 1 + R.int(2); k > 0; k--) {
            const e = R.chance(0.6) ? t : someTab()
            ctx.run(e, () => note(`  ${e.id} ${userAction(e)}`))
          }
        },
      })
      await act(t, () => t.sync.syncNow())
      break
    }
    case 'reload': {
      const t = someTab()
      note(`reload ${t.id}`)
      stats.reloads++
      if (R.chance(0.6)) await act(t, () => t.S.persistNow()) // pagehide got to save
      kill(t)
      await openTab(t.dev)
      break
    }
    case 'crash': {
      const t = someTab()
      note(`crash ${t.id}, then reopen`)
      stats.crashes++
      kill(t)
      await openTab(t.dev)
      break
    }
    case 'tabs': {
      const d = R.pick(devices)
      if (d.tabs.length < 2) await openTab(d)
      else {
        const t = R.pick(d.tabs)
        note(`close ${t.id}`)
        await act(t, () => t.S.persistNow())
        kill(t)
      }
      break
    }
    case 'fault': {
      const t = someTab()
      fault = R.pick(['lost', 'fail'] as const)
      note(`${t.id} sync, its upload ${fault === 'lost' ? 'lands but the answer is lost' : 'fails'}`)
      await act(t, () => userAction(t))
      await act(t, () => t.sync.syncNow())
      fault = null
      break
    }
  }
  hooks = []
  // a moment passes between user actions
  await advance(1 + R.int(40))
  observeDurable(code)
}

/** Sync everything until nothing is left to send. Returns the rounds it took, or 0 if it never got there. */
async function quiesce(code: string): Promise<number> {
  hooks = []
  fault = null
  for (let round = 1; round <= 12; round++) {
    await deliverAll()
    for (const t of alive()) await act(t, () => t.S.persistNow())
    for (const t of alive()) await act(t, () => t.S.pullNow())
    for (const t of alive()) await act(t, () => t.sync.syncNow())
    await deliverAll()
    for (const t of alive()) await act(t, () => t.S.persistNow())
    observeDurable(code)
    const server = serverDB(code)
    const dbs = alive().map((t) => t.S.getDB())
    if (!mail.length && alive().every((t) => !t.sync.syncStatus().dirty) && server && dbs.every((d) => sameDB(d, server))) return round
  }
  return 0
}

/** Where one record stands after a step: in each device's IndexedDB and journals, and in each tab. */
function trace(id: string) {
  const find = (db: DB | undefined) => {
    for (const name of COLLECTIONS) {
      const r = (db?.[name] as Record<string, Rec> | undefined)?.[id]
      if (r) return `u=${r.u}${r.d ? ' deleted' : ''}`
    }
    return '-'
  }
  const parts: string[] = []
  for (const d of devices) {
    parts.push(`${d.name}.idb=${find(d.kv.get('db') as DB | undefined)}`)
    for (const [k, raw] of d.ls) {
      if (!k.includes('journal')) continue
      const j = JSON.parse(raw) as [string, Rec][] | { recs: [string, Rec][] }
      const hit = (Array.isArray(j) ? j : j.recs).find(([key]) => key.endsWith(`|${id}`))
      if (hit) parts.push(`${d.name}.journal=u=${hit[1].u}${hit[1].d ? ' deleted' : ''}`)
    }
    for (const t of d.tabs) parts.push(`${t.id}=${find(t.S.getDB())}`)
  }
  console.log(`trace ${stepNo} ${parts.join(' ')}`)
}

async function runSeed(seed: number): Promise<{ fails: string[]; fingerprint: string }> {
  reset(seed)
  const fails: string[] = []
  const code = await setup()
  await settle()
  for (const t of alive()) oracle.observeDB(t.S.getDB(), `${t.id} at start`)
  observeDurable(code)
  for (stepNo = 1; stepNo <= STEPS; stepNo++) {
    await step(code)
    if (env.FUZZ_TRACE) trace(env.FUZZ_TRACE)
    if (stepNo % 25 === 0) for (const t of alive()) for (const p of budgetProblems(t.S.getDB(), monthOf(t.S.today()))) fails.push(`step ${stepNo} ${t.id}: ${p}`)
  }
  // the diverged state: merge must not care about order or grouping
  const server0 = serverDB(code)
  const snaps = [...alive().map((t) => t.S.getDB()), ...devices.map((d) => d.kv.get('db') as DB).filter(Boolean), ...(server0 ? [server0] : [])]
  for (const p of algebraProblems(snaps, new Rand(mulberry(seed)))) fails.push(`merge algebra: ${p}`)

  stepNo = STEPS + 1
  note('quiesce')
  const rounds = await quiesce(code)
  const tabs = alive()
  const server = serverDB(code)!
  const ref = tabs[0].S.getDB()
  if (!rounds) {
    const dirty = tabs.filter((t) => t.sync.syncStatus().dirty).map((t) => t.id)
    fails.push(`never converged (dirty: ${dirty.join(', ') || 'none'}, mail: ${mail.length})`)
  }
  // 1. convergence: every tab, every device's storage and the server hold the same
  for (const t of tabs.slice(1)) for (const d of diffDB(ref, t.S.getDB())) fails.push(`${tabs[0].id} vs ${t.id}: ${d}`)
  for (const d of diffDB(ref, server)) fails.push(`${tabs[0].id} vs server: ${d}`)
  for (const dev of devices) {
    const stored = dev.kv.get('db') as DB
    for (const d of diffDB(ref, repair(stored), 3)) fails.push(`${tabs[0].id} vs ${dev.name}'s IndexedDB: ${d}`)
  }
  // 2. no lost writes: nothing durable is newer than the end state; every record an action made is still there
  observeDurable(code)
  for (const t of tabs) oracle.observeDB(t.S.getDB(), `${t.id} at end`)
  for (const l of oracle.lost(ref)) fails.push(`lost write: ${l}`)
  for (const key of created) {
    const [name, id] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
    const r = (ref as unknown as Record<string, Record<string, Rec>>)[name][id]
    if (!r) fails.push(`created ${key} is gone`)
  }
  for (const name of COLLECTIONS)
    for (const r of Object.values(ref[name] as Record<string, Rec>))
      if (r.d && !deletedByOp.has(`${name}|${r.id}`)) fails.push(`${name}|${r.id} is deleted, but no action deleted it`)
  // 3. the books
  for (const p of budgetProblems(ref, monthOf(tabs[0].S.today()))) fails.push(`end: ${p}`)
  // 4. merging the converged copies changes nothing
  for (const p of algebraProblems([ref, server, ...tabs.map((t) => t.S.getDB())], new Rand(mulberry(seed + 1)))) fails.push(`merge algebra (end): ${p}`)
  // 5. a fresh tab on each device starts from the same
  for (const dev of devices) {
    const t = await openTab(dev)
    for (const d of diffDB(ref, t.S.getDB(), 3)) fails.push(`fresh tab on ${dev.name}: ${d}`)
  }
  for (const h of new Set(harness)) fails.push(`harness: ${h}`)
  for (const f of new Set(findings)) fails.push(f)
  const fingerprint = createHash('sha256')
    .update(canon(normDB(ref).size) + [...normDB(ref).values()].join('\n') + log.join('\n'))
    .digest('hex')
    .slice(0, 16)
  for (const t of alive()) kill(t)
  return { fails, fingerprint }
}

// ---------------------------------------------------------------- tests

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: START })
  // each device's clock is off by its own amount
  const fakeNow = Date.now.bind(Date)
  Date.now = () => fakeNow() + (ctx.getStore()?.dev.skew ?? 0)
  const quiet = { addEventListener() {}, removeEventListener() {} }
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('window', quiet)
  vi.stubGlobal('document', { ...quiet, visibilityState: 'visible' })
  vi.stubGlobal('fetch', server)
  vi.stubGlobal('localStorage', fakeLocalStorage)
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('CompressionStream', Identity)
  vi.stubGlobal('DecompressionStream', Identity)
  vi.stubGlobal('crypto', fakeCrypto)
  vi.stubGlobal('setTimeout', fakeTimers.setTimeout)
  vi.stubGlobal('clearTimeout', fakeTimers.clearTimeout)
  vi.stubGlobal('setInterval', fakeTimers.setInterval)
  vi.stubGlobal('clearInterval', fakeTimers.clearInterval)
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('sync fuzz: devices and tabs editing, syncing, reloading and crashing', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const { fails } = await runSeed(seed)
      if (fails.length || LOG) console.log(`seed ${seed}: ${JSON.stringify(stats)}`)
      if (fails.length) console.log(`seed ${seed}, last steps:\n${log.slice(-60).join('\n')}`)
      expect(fails).toEqual([])
    }, 120_000)
  }

  it('replays a seed exactly', async () => {
    const a = await runSeed(SEEDS[0])
    const b = await runSeed(SEEDS[0])
    expect(b.fingerprint).toBe(a.fingerprint)
  }, 120_000)
})

// ---------------------------------------------------------------- merge alone

describe('merge algebra over random edits on three replicas', () => {
  const FIELDS = ['amt', 'cur', 'base', 'note', 'cat', 'date', 'target', 'archived']
  const VALUES: unknown[] = [undefined, undefined, 0, 1, -100, 'x', 'y', 'TWD', { kind: 'goal', amount: 5 }, { kind: 'goal', amount: 6 }, [1, 2]]
  const IDS = ['a', 'b', 'c', 'd']

  it('commutative, associative and idempotent; every field ends at its newest write', () => {
    const fails: string[] = []
    for (let seed = 1; seed <= MERGE_SEEDS; seed++) {
      const r = new Rand(mulberry(seed))
      const reps: DB[] = [emptyDB(), emptyDB(), emptyDB()]
      const maxU = [0, 0, 0]
      const o = new Oracle()
      let now = 1000
      for (let k = 0; k < 40; k++) {
        const i = r.int(3)
        if (r.chance(0.2)) {
          const j = r.int(3)
          reps[i] = merge(reps[i], reps[j])
          maxU[i] = Math.max(maxU[i], maxU[j])
          continue
        }
        now += r.int(3) // two replicas may write in the same millisecond
        const u = Math.max(now, maxU[i] + 1)
        maxU[i] = u
        const id = r.pick(IDS)
        const old = reps[i].txns[id]
        const next = { ...(old ?? { id, u: 0 }) } as unknown as Row
        for (let n = 1 + r.int(3); n > 0; n--) next[r.pick(FIELDS)] = r.pick(VALUES)
        if (r.chance(0.15)) next.d = old?.d ? undefined : 1
        let w: Rec | null
        if (old && r.chance(0.04)) {
          // an older app version: bumps the time, keeps the stale field times
          w = { ...(next as unknown as Rec), u, f: old.f }
          for (const key of Object.keys(w)) if ((w as unknown as Row)[key] === undefined) delete (w as unknown as Row)[key]
        } else w = edit(old, next as unknown as Rec, u)
        if (!w) continue
        reps[i] = { ...reps[i], txns: { ...reps[i].txns, [id]: w as never } }
        o.observe('txns', w, `replica ${i} @${u}`)
      }
      const orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ]
      const results: [string, DB][] = []
      for (const [a, b, c] of orders) {
        results.push([`((${a}${b})${c})`, merge(merge(reps[a], reps[b]), reps[c])])
        results.push([`(${a}(${b}${c}))`, merge(reps[a], merge(reps[b], reps[c]))])
      }
      const [name0, ref] = results[0]
      for (const [name, db] of results.slice(1)) {
        const d = diffDB(ref, db, 1)
        if (d.length) fails.push(`seed ${seed}: ${name0} != ${name}: ${d[0]}`)
      }
      for (const rep of reps) {
        if (!sameDB(merge(rep, structuredClone(rep)), rep)) fails.push(`seed ${seed}: merge(x, x) != x`)
        if (!sameDB(merge(ref, rep), ref)) fails.push(`seed ${seed}: merging a replica into the result changes it`)
        if (hasNews(ref, rep)) fails.push(`seed ${seed}: a replica has news for the merged result`)
      }
      for (const l of o.lost(ref)) fails.push(`seed ${seed}: ${l}`)
      if (fails.length > 10) break
    }
    expect(fails).toEqual([])
  })
})
