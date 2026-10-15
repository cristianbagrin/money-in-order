import './styles.css'
import { render } from 'preact'
import { get, set } from 'idb-keyval'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { refreshRates } from './lib/rates'
import { replaceDB, setPersistence } from './lib/store'
import { initSync } from './lib/sync'
import type { DB } from './lib/types'

async function boot() {
  try {
    const saved = (await get('db')) as DB | undefined
    if (saved) replaceDB(saved)
  } catch {
    // IndexedDB unavailable (private mode): run in memory.
  }

  let pending: DB | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (!pending) return
    const db = pending
    pending = null
    void set('db', db).catch(() => {})
  }
  setPersistence({
    save(db) {
      pending = db
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 250)
    },
  })
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())
  window.addEventListener('pagehide', flush)

  void navigator.storage?.persist?.()
  render(<App />, document.getElementById('app')!)
  void initSync()
  void refreshRates()
  registerSW({ immediate: true })
}

void boot()
