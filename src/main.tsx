import './styles.css'
import { render } from 'preact'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { loadDB, startPersistence } from './lib/persist'
import { refreshRates } from './lib/rates'
import { replaceDB } from './lib/store'
import { initSync, syncIdle } from './lib/sync'

let refreshing: Promise<unknown> | null = null

/** Refresh rates once the sync has merged, so the refresh starts from the newest settings (it only fetches when they're old). */
function refreshAfter(synced: Promise<unknown>) {
  refreshing ??= Promise.race([synced, new Promise((r) => setTimeout(r, 10_000))])
    .then(() => refreshRates())
    .catch(() => {})
    .finally(() => (refreshing = null))
}

async function boot() {
  const { db, replayed } = await loadDB()
  if (db) replaceDB(db)
  startPersistence({ replayed })

  void navigator.storage?.persist?.()
  render(<App />, document.getElementById('app')!)
  refreshAfter(initSync({ dirty: replayed }))
  // A PWA resumed after a day in the background keeps running: check the rates again when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAfter(syncIdle())
  })
  registerSW({ immediate: true })
}

void boot()
