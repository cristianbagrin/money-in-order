// End-to-end encrypted sync. The server stores one opaque blob per sync code and never sees the key.

import { get, set } from 'idb-keyval'
import { hasNews, merge } from './merge'
import { clearUndo, getDB, onLocalChange, replaceDB } from './store'
import type { DB } from './types'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L

export type SyncState = 'off' | 'idle' | 'syncing' | 'offline' | 'error'

interface SyncConfig {
  code: string
  rev: string | null
  /** local edits not yet uploaded */
  dirty: boolean
  last: number
}

let cfg: SyncConfig | null = null
let state: SyncState = 'off'
let errorMsg = ''
let keys: { id: string; key: CryptoKey } | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let again = false
const listeners = new Set<() => void>()

export function syncStatus() {
  return { state, error: errorMsg, code: cfg?.code ?? null, last: cfg?.last ?? 0, dirty: cfg?.dirty ?? false }
}

export function onSyncStatus(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setState(s: SyncState, err = '') {
  state = s
  errorMsg = err
  for (const fn of listeners) fn()
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

async function syncOnce(): Promise<void> {
  if (!cfg || !keys) return
  if (!navigator.onLine) {
    setState('offline')
    return
  }
  setState('syncing')
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`/api/vault/${keys.id}`, {
        headers: cfg.rev ? { 'X-Have-Rev': cfg.rev } : {},
        cache: 'no-store',
      })
      let remoteRev: string | null = cfg.rev
      if (res.status === 200) {
        remoteRev = res.headers.get('X-Rev')
        const remote = await open(await res.text(), keys.key)
        const local = getDB()
        if (hasNews(local, remote)) replaceDB(merge(local, remote))
        if (hasNews(remote, getDB())) cfg.dirty = true
        cfg.rev = remoteRev
      } else if (res.status === 404) {
        remoteRev = null
        cfg.rev = null
        cfg.dirty = true
      } else if (res.status !== 204) {
        throw new Error(`Server said ${res.status}`)
      }
      if (!cfg.dirty) break
      // Remember exactly what we upload: edits made while the upload is in flight must stay dirty.
      const snapshot = getDB()
      const body = await seal(snapshot, keys.key)
      const put = await fetch(`/api/vault/${keys.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'X-Base-Rev': remoteRev ?? 'new' },
        body,
      })
      if (put.status === 412) continue // someone else wrote first: pull, merge, try again
      if (!put.ok) throw new Error(`Upload failed (${put.status})`)
      cfg.rev = put.headers.get('X-Rev')
      cfg.dirty = getDB() !== snapshot
      if (cfg.dirty) again = true
      break
    }
    cfg.last = Date.now()
    await saveCfg()
    setState('idle')
  } catch (e) {
    setState(navigator.onLine ? 'error' : 'offline', e instanceof Error ? e.message : String(e))
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
    cfg.dirty = true
    void saveCfg()
    schedule(1200)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg) void syncNow()
  })
  window.addEventListener('online', () => cfg && void syncNow())
  window.addEventListener('offline', () => cfg && setState('offline'))
  setInterval(() => {
    if (cfg && document.visibilityState === 'visible') void syncNow()
  }, 60_000)
}

export async function initSync() {
  const saved = (await get('sync')) as SyncConfig | undefined
  if (!saved?.code) return
  cfg = saved
  keys = await derive(saved.code)
  wire()
  setState('idle')
  void syncNow()
}

/** Start syncing with a code. Local data is merged with whatever is stored under the code. */
export async function enableSync(code: string) {
  cfg = { code, rev: null, dirty: true, last: 0 }
  keys = await derive(code)
  await saveCfg()
  wire()
  setState('idle')
  await syncNow()
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
    await saveCfg()
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
