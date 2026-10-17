// End-to-end encrypted sync. The server stores one opaque blob per sync code and never sees the key.

import { get, set } from 'idb-keyval'
import { hasNews, merge } from './merge'
import { clearUndo, getDB, onLocalChange, persistNow, replaceDB } from './store'
import type { DB } from './types'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L
const OFFLINE = 'Offline. Changes will sync when you’re back.'
const UNREACHABLE = 'Couldn’t reach the sync server. Trying again shortly.'
/** Unsent changes older than this make the status `stale`. */
const STALE_AFTER = 10 * 60 * 1000

export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error'

interface SyncConfig {
  code: string
  rev: string | null
  /** local edits not yet uploaded */
  dirty: boolean
  /** when the oldest edit not yet uploaded was made */
  since?: number
  last: number
}

let cfg: SyncConfig | null = null
let state: SyncState = 'off'
let errorMsg = ''
let keys: { id: string; key: CryptoKey } | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let staleTimer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let again = false
const listeners = new Set<() => void>()

class ServerError extends Error {}

export function syncStatus() {
  return {
    state,
    error: errorMsg,
    code: cfg?.code ?? null,
    last: cfg?.last ?? 0,
    dirty: cfg?.dirty ?? false,
    /** sync is on but changes made here haven't reached the server for a while */
    stale: !!cfg?.dirty && !!cfg.since && Date.now() - cfg.since > STALE_AFTER,
  }
}

export function onSyncStatus(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = null
  // Tell listeners again the moment unsent changes turn stale.
  const due = cfg?.dirty && cfg.since ? cfg.since + STALE_AFTER - Date.now() : -1
  if (due >= 0) staleTimer = setTimeout(notify, due + 50)
  for (const fn of listeners) fn()
}

function setState(s: SyncState, err = '') {
  state = s
  errorMsg = err
  notify()
}

function markDirty() {
  if (!cfg) return
  if (!cfg.dirty || !cfg.since) cfg.since = Date.now()
  cfg.dirty = true
}

function markClean() {
  if (!cfg) return
  cfg.dirty = false
  delete cfg.since
}

export function newCode(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s.match(/.{5}/g)!.join('-')
}

export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== 20 || [...s].some((c) => !ALPHABET.includes(c))) return null
  return s.match(/.{5}/g)!.join('-')
}

async function derive(code: string) {
  const enc = new TextEncoder()
  const raw = enc.encode(code.replace(/-/g, ''))
  const idHash = await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('money-in-order/id/'), ...raw]))
  const keyHash = await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('money-in-order/key/'), ...raw]))
  const id = [...new Uint8Array(idHash)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', keyHash, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id, key }
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

async function seal(db: DB, key: CryptoKey): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, db }))
  const packed = await pipe(json, new CompressionStream('gzip'))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed as BufferSource))
  return 'v1.' + b64(iv) + '.' + b64(ct)
}

async function open(blob: string, key: CryptoKey): Promise<DB> {
  const [v, iv, ct] = blob.split('.')
  if (v !== 'v1') throw new Error('Unknown data format')
  const packed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) as BufferSource }, key, unb64(ct) as BufferSource)
  const json = await pipe(new Uint8Array(packed), new DecompressionStream('gzip'))
  return JSON.parse(new TextDecoder().decode(json)).db as DB
}

async function saveCfg() {
  if (cfg) await set('sync', cfg)
}

/** Remember the code after sync is turned off, so turning it back on resumes the same budget. */
async function rememberCode(code: string) {
  await set('syncCode', code).catch(() => {})
}

async function syncOnce(): Promise<void> {
  const c = cfg
  const k = keys
  if (!c || !k) return
  if (!navigator.onLine) {
    setState('offline', OFFLINE)
    return
  }
  setState('syncing')
  try {
    let done = false
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const res = await fetch(`/api/vault/${k.id}`, {
        headers: c.rev ? { 'X-Have-Rev': c.rev } : {},
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      })
      if (cfg !== c) return // turned off meanwhile
      let remoteRev: string | null = c.rev
      if (res.status === 200) {
        remoteRev = res.headers.get('X-Rev')
        const remote = await open(await res.text(), k.key)
        if (cfg !== c) return
        const local = getDB()
        if (hasNews(local, remote)) {
          replaceDB(merge(local, remote))
          // Only remember the new revision once its data is saved on this device.
          await persistNow()
        }
        if (hasNews(remote, getDB())) markDirty()
        c.rev = remoteRev
      } else if (res.status === 404) {
        remoteRev = null
        c.rev = null
        markDirty()
      } else if (res.status !== 204) {
        throw new ServerError(String(res.status))
      }
      if (!c.dirty) {
        done = true
        break
      }
      // Remember exactly what we upload: edits made while the upload is in flight must stay dirty.
      const snapshot = getDB()
      const body = await seal(snapshot, k.key)
      const put = await fetch(`/api/vault/${k.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'X-Base-Rev': remoteRev ?? 'new' },
        body,
        signal: AbortSignal.timeout(30_000),
      })
      if (cfg !== c) return
      if (put.status === 412) continue // someone else wrote first: pull, merge, try again
      if (!put.ok) throw new ServerError(String(put.status))
      c.rev = put.headers.get('X-Rev')
      done = true
      if (getDB() === snapshot) markClean()
      else {
        c.since = Date.now()
        again = true
      }
    }
    if (done) c.last = Date.now()
    else schedule(5000) // other devices kept writing first: try again in a moment
    await saveCfg()
    setState('idle')
  } catch (e) {
    if (cfg !== c) return
    await saveCfg().catch(() => {})
    if (!navigator.onLine) return setState('offline', OFFLINE)
    const reach = e instanceof ServerError || e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError')
    setState('error', reach ? UNREACHABLE : 'Couldn’t sync. Trying again shortly.')
    schedule(15_000)
  }
}

/** Run a sync now (coalesces overlapping calls). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await syncOnce()
    } while (again)
    running = null
  })()
  return running
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void syncNow(), ms)
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  onLocalChange(() => {
    if (!cfg) return
    const was = cfg.dirty
    markDirty()
    void saveCfg()
    schedule(1200)
    if (!was) notify()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg) void syncNow()
  })
  window.addEventListener('online', () => cfg && void syncNow())
  window.addEventListener('offline', () => cfg && setState('offline', OFFLINE))
  setInterval(() => {
    if (cfg && document.visibilityState === 'visible') void syncNow()
  }, 60_000)
}

/** Resume syncing at startup. Resolves after the first sync (at once when sync is off). */
export async function initSync(opts: { dirty?: boolean } = {}) {
  const saved = (await get('sync').catch(() => undefined)) as SyncConfig | undefined
  if (!saved?.code) return
  cfg = saved
  void rememberCode(saved.code)
  // Changes recovered after an interrupted save may not have been uploaded yet.
  if (opts.dirty) markDirty()
  keys = await derive(saved.code)
  wire()
  setState('idle')
  await syncNow()
}

/** Start syncing with a code. Local data is merged with whatever is stored under the code. */
export async function enableSync(code: string) {
  cfg = { code, rev: null, dirty: true, since: Date.now(), last: 0 }
  keys = await derive(code)
  await saveCfg()
  await rememberCode(code)
  wire()
  setState('idle')
  await syncNow()
}

/** Turn sync on: with the code this device used before (so its other devices keep up), or a new one. */
export async function turnOnSync() {
  const prev = (await get('syncCode').catch(() => undefined)) as string | undefined
  await enableSync((prev && normalizeCode(prev)) || newCode())
}

/**
 * Join a budget from another device. If the code has data, this device takes that budget as it is
 * (its own data is replaced, so two budgets never get mixed into duplicates).
 */
export async function joinSync(code: string): Promise<'joined' | 'missing' | 'error'> {
  try {
    const k = await derive(code)
    const res = await fetch(`/api/vault/${k.id}`, { cache: 'no-store' })
    if (res.status === 404) return 'missing'
    if (!res.ok) return 'error'
    const remote = await open(await res.text(), k.key)
    replaceDB(remote)
    clearUndo()
    cfg = { code, rev: res.headers.get('X-Rev'), dirty: false, last: Date.now() }
    keys = k
    await persistNow()
    await saveCfg()
    await rememberCode(code)
    wire()
    setState('idle')
    return 'joined'
  } catch {
    return 'error'
  }
}

export async function disableSync() {
  cfg = null
  keys = null
  await set('sync', null)
  setState('off')
}

/** Check whether a code has data on the server (used when joining from a second device). */
export async function codeHasData(code: string): Promise<boolean> {
  const k = await derive(code)
  const res = await fetch(`/api/vault/${k.id}`, { method: 'HEAD', cache: 'no-store' })
  return res.status === 200
}
