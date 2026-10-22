import { addDays, isoDate } from './dates'
import { getIndex, settings, updateSettings } from './store'

const SOURCES = [
  (base: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.min.json`,
  (base: string) => `https://latest.currency-api.pages.dev/v1/currencies/${base}.min.json`,
]

const FRESH_FOR = 12 * 60 * 60 * 1000

/** A foreign currency you spent in during the last this many days counts as in use (a trip), then drops off on its own. */
export const RECENT_DAYS = 30

/** True when amounts in this currency can be converted into the budget currency. */
export function hasRate(code: string): boolean {
  const s = settings()
  return code === s.base || (s.rates[code] ?? 0) > 0
}

/** Currencies in the transactions of the last RECENT_DAYS days, most recently used first. */
export function recentCurrencies(): string[] {
  const s = settings()
  const since = addDays(isoDate(), -RECENT_DAYS)
  const seen = new Set<string>()
  // Newest first, so it stops at the first one that is too old.
  for (const t of getIndex().txns) {
    if (t.date < since) break
    if (!t.kind && t.cur !== s.base) seen.add(t.cur)
  }
  // In a fixed order, so pills never move under a finger.
  return [...seen].sort()
}

/** Currencies the budget actually deals with: the base, the ones you chose, and any you used lately. */
export function currenciesInUse(): string[] {
  const s = settings()
  return [...new Set([s.base, ...s.extraCurrencies, ...recentCurrencies()])]
}

/**
 * Fetch live rates for every currency in use, plus `extra` codes (one just picked, no rate yet).
 * Manually pinned rates are left alone.
 */
export async function refreshRates(force = false, extra: string[] = []): Promise<boolean> {
  const s = settings()
  const wanted = [...new Set([...currenciesInUse(), ...extra])].filter((c) => c !== s.base)
  if (!wanted.length) return false
  if (!force && Date.now() - s.ratesAt < FRESH_FOR && wanted.every((c) => s.rates[c])) return false
  const base = s.base.toLowerCase()
  for (const src of SOURCES) {
    try {
      const res = await fetch(src(base), { cache: 'no-store', signal: AbortSignal.timeout(6000) })
      if (!res.ok) continue
      const json = (await res.json()) as Record<string, Record<string, number>>
      const table = json[base]
      if (!table) continue
      // Build on what's here now (a sync may have landed meanwhile); the rates only go to the rate table.
      const now = settings()
      if (now.base !== s.base) return false
      const rates = { ...now.rates }
      for (const c of wanted) {
        if (c === now.base || now.pinned?.[c]) continue
        const perBase = table[c.toLowerCase()]
        // table says: 1 base = perBase units of c. We store: 1 unit of c = x base.
        // Full precision: rounding would turn weak currencies (VND, IDR, KRW) into 0.
        if (perBase > 0) rates[c] = Number((1 / perBase).toPrecision(10))
      }
      updateSettings({ rates, ratesAt: Date.now() })
      return true
    } catch {
      // try the next source
    }
  }
  return false
}
