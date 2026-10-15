import { useEffect, useState, useSyncExternalStore } from 'preact/compat'
import { getIndex, subscribe } from '../lib/store'
import { onSyncStatus, syncStatus } from '../lib/sync'
import { isoDate } from '../lib/dates'

let version = 0
subscribe(() => {
  version++
})

/** Re-render whenever the data changes. Returns the current index. */
export function useIndex() {
  useSyncExternalStore(subscribe, () => version)
  return getIndex()
}

let syncVersion = 0
let syncSnap = syncStatus()
onSyncStatus(() => {
  syncVersion++
  syncSnap = syncStatus()
})

export function useSync() {
  useSyncExternalStore(onSyncStatus, () => syncVersion)
  return syncSnap
}

/** Today's date, refreshed when the app comes back to the foreground or the day rolls over. */
export function useToday(): string {
  const [day, setDay] = useState(isoDate())
  useEffect(() => {
    const check = () => setDay(isoDate())
    const id = setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  return day
}

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}
