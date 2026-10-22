// End-to-end encrypted sync. The server stores one opaque blob per account and never sees the key.
//
// An account is an email and a password. The password, stretched with PBKDF2 (the email is the salt),
// becomes the account's secret; the vault id and the encryption key are derived from that secret, so
// the server never sees the password, the secret or the data. Budgets synced before accounts existed
// used a random 20-character code in place of the secret, and keep working until the device signs in.

import { get, set, update } from 'idb-keyval'
import { hasNews, merge } from './merge'
import { dbEpoch, getDB, onLocalChange, persistNow, pullNow, replaceDB, swapDB } from './store'
import type { DB } from './types'

/** PBKDF2 rounds: about half a second on a phone, once per sign-in. */
const ROUNDS = 310_000
export const MIN_PASSWORD = 8
const OFFLINE = 'Offline. Changes will sync when you’re back.'
const UNREACHABLE = 'Couldn’t reach the sync server. Trying again shortly.'
/** Unsent changes older than this make the status `stale`. */
const STALE_AFTER = 10 * 60 * 1000

export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error'

interface SyncConfig {
  /** the account's secret (or, from before accounts, a sync code) */
  code: string
  /** the account's email; missing for a sync code */
  email?: string
  rev: string | null
  /** local edits not yet uploaded */
  dirty: boolean
  /** when the oldest edit not yet uploaded was made */
  since?: number
  last: number
  /** the budget (see dbEpoch) this code syncs; missing when saved before budgets had one */
  epoch?: string
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
/** Tabs share one sync state: a tab that turns sync on or off or joins a budget tells the others. */
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('money-in-order/sync') : null
let ready!: () => void
/** Resolves once this tab knows whether sync is on, and with which code. */
export const syncReady = new Promise<void>((r) => (ready = r))

class ServerError extends Error {}

export function syncStatus() {
  return {
    state,
    error: errorMsg,
    code: cfg?.code ?? null,
    email: cfg?.email ?? null,
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

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase()
}

export function validEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(s))
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The account's secret, from its password. Slow on purpose, so a password can't be guessed quickly. */
async function accountSecret(email: string, password: string): Promise<string> {
  const enc = new TextEncoder()
  const pw = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  const salt = enc.encode('money-in-order/account/' + normalizeEmail(email))
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ROUNDS }, pw, 256))
}

/** Where the server notes that an email has an account (a hash: the server never sees the email). */
async function emailUrl(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('money-in-order/email/' + normalizeEmail(email)))
  return `/api/account/${hex(digest)}`
}

async function derive(code: string) {
  const enc = new TextEncoder()
  const raw = enc.encode(code.replace(/-/g, ''))
  const idHash = await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('money-in-order/id/'), ...raw]))
  const keyHash = await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('money-in-order/key/'), ...raw]))
  const key = await crypto.subtle.importKey('raw', keyHash, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id: hex(idHash), key }
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

function epochOf(c: SyncConfig | null | undefined): string {
  return c?.epoch ?? ''
}

/** Save this tab's sync state, unless another tab has turned sync off or joined another budget meanwhile: then follow that. */
async function saveCfg() {
  const c = cfg
  if (!c) return
  let mine = true
  await update<SyncConfig | null>('sync', (saved) => {
    mine = saved?.code === c.code && epochOf(saved) === epochOf(c)
    return mine ? c : (saved ?? null)
  })
  if (!mine) await follow()
}

/** Save a sync state chosen here (turned on or off, budget joined) and tell the other tabs. */
async function storeCfg() {
  await set('sync', cfg)
  channel?.postMessage(1)
}

/** Take the sync state as another tab may have stored it: turned off, turned on, or another budget joined. */
async function follow() {
  const was = cfg
  const saved = (await get('sync').catch(() => undefined)) as SyncConfig | null | undefined
  if (cfg !== was || (saved?.code === was?.code && epochOf(saved) === epochOf(was))) return
  if (!saved?.code) {
    cfg = null
    keys = null
    return setState('off')
  }
  // A joined budget comes with its code: take it in too (until this tab holds it, nothing syncs).
  if (epochOf(saved) !== dbEpoch()) await pullNow()
  const k = await derive(saved.code)
  if (cfg !== was) return
  cfg = saved
  keys = k
  setState('idle')
}

async function syncOnce(): Promise<void> {
  await follow()
  const c = cfg
  const k = keys
  // Sync only the budget this code belongs to: a tab still holding a replaced one waits until it has taken the new one.
  const gone = () => cfg !== c || epochOf(c) !== dbEpoch()
  if (!c || !k || gone()) return
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
      if (gone()) return // turned off or budget swapped meanwhile
      let remoteRev: string | null = c.rev
      if (res.status === 200) {
        remoteRev = res.headers.get('X-Rev')
        const remote = await open(await res.text(), k.key)
        if (gone()) return
        const local = getDB()
        if (hasNews(local, remote)) {
          replaceDB(merge(local, remote))
          // Only remember the new revision once its data is saved on this device.
          await persistNow()
          if (gone()) return
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
      if (gone()) return
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
    if (cfg === c) setState('idle')
  } catch (e) {
    if (gone()) return
    await saveCfg().catch(() => {})
    if (cfg !== c) return
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
  // Each sync first takes the sync state other tabs stored, so these also pick up Turn on in another tab.
  if (channel) channel.onmessage = () => void syncNow()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  window.addEventListener('online', () => cfg && void syncNow())
  window.addEventListener('offline', () => cfg && setState('offline', OFFLINE))
  setInterval(() => {
    if (cfg && document.visibilityState === 'visible') void syncNow()
  }, 60_000)
}

/** Resume syncing at startup. Resolves after the first sync (at once when sync is off). */
export async function initSync(opts: { dirty?: boolean } = {}) {
  wire()
  try {
    await follow()
  } finally {
    ready()
  }
  if (!cfg) return
  // Changes recovered after an interrupted save may not have been uploaded yet.
  if (opts.dirty) markDirty()
  await syncNow()
}

/** Resolves once the sync running now (if any) is done. */
export function syncIdle(): Promise<void> {
  return running ?? Promise.resolve()
}

/** Start syncing under a secret. Local data is merged with whatever is stored under it. */
export async function enableSync(code: string, email?: string) {
  const k = await derive(code)
  cfg = { code, email, rev: null, dirty: true, since: Date.now(), last: 0, epoch: dbEpoch() }
  keys = k
  await storeCfg()
  wire()
  setState('idle')
  await syncNow()
}

/** Take the budget stored under a secret as it is: this device's own data is replaced, so two budgets never get mixed. */
async function adopt(code: string, email: string | undefined, res: Response, k: Awaited<ReturnType<typeof derive>>) {
  const remote = await open(await res.text(), k.key)
  // A different budget, not a merge: other tabs drop the old one instead of merging it back in.
  swapDB(remote)
  cfg = { code, email, rev: res.headers.get('X-Rev'), dirty: false, last: Date.now(), epoch: dbEpoch() }
  keys = k
  await storeCfg()
  await persistNow()
  wire()
  setState('idle')
}

/**
 * Create an account with this device's budget. An email that already has an account is refused, so
 * nobody ends up with two budgets under one email.
 */
export async function signUp(email: string, password: string): Promise<'created' | 'exists' | 'error'> {
  try {
    const secret = await accountSecret(email, password)
    const k = await derive(secret)
    const url = await emailUrl(email)
    const [vault, known] = await Promise.all([
      fetch(`/api/vault/${k.id}`, { method: 'HEAD', cache: 'no-store' }),
      fetch(url, { method: 'HEAD', cache: 'no-store' }),
    ])
    if (vault.status === 200 || known.status === 200) return 'exists'
    if (vault.status !== 404 || known.status !== 404) return 'error'
    const put = await fetch(url, { method: 'PUT' })
    if (put.status === 409) return 'exists'
    if (!put.ok) return 'error'
    await enableSync(secret, normalizeEmail(email))
    return 'created'
  } catch {
    return 'error'
  }
}

/**
 * Sign in on this device: the account's budget replaces what is here, once `replace` agrees (it is
 * asked only when the email and password are right).
 */
export async function signIn(
  email: string,
  password: string,
  replace: () => boolean = () => true,
): Promise<'joined' | 'cancelled' | 'wrong' | 'none' | 'error'> {
  try {
    const secret = await accountSecret(email, password)
    if (cfg?.code === secret) return 'joined'
    const k = await derive(secret)
    const res = await fetch(`/api/vault/${k.id}`, { cache: 'no-store' })
    if (res.status === 404) {
      const known = await fetch(await emailUrl(email), { method: 'HEAD', cache: 'no-store' })
      return known.status === 200 ? 'wrong' : known.status === 404 ? 'none' : 'error'
    }
    if (!res.ok) return 'error'
    if (!replace()) return 'cancelled'
    await adopt(secret, normalizeEmail(email), res, k)
    return 'joined'
  } catch {
    return 'error'
  }
}

/** Stop syncing on this device. Its data stays here. */
export async function disableSync() {
  cfg = null
  keys = null
  await storeCfg()
  setState('off')
}
