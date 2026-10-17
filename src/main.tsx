import './styles.css'
import { render } from 'preact'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { loadDB, startPersistence } from './lib/persist'
import { refreshRates } from './lib/rates'
import { replaceDB } from './lib/store'
import { initSync } from './lib/sync'

async function boot() {
  const { db, replayed } = await loadDB()
  if (db) replaceDB(db)
  startPersistence({ replayed })

  void navigator.storage?.persist?.()
  render(<App />, document.getElementById('app')!)
  // Refresh rates once the first sync has merged, so the refresh starts from the newest settings.
  const synced = initSync({ dirty: replayed })
  void Promise.race([synced, new Promise((r) => setTimeout(r, 10_000))]).then(() => refreshRates())
  registerSW({ immediate: true })
}

void boot()
