import { settings, updateSettings } from './store'

const SOURCES = [
  (base: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.min.json`,
  (base: string) => `https://latest.currency-api.pages.dev/v1/currencies/${base}.min.json`,
]

const FRESH_FOR = 12 * 60 * 60 * 1000

/** True when amounts in this currency can be converted into the budget currency. */
export function hasRate(code: string): boolean {
  const s = settings()
  return code === s.base || (s.rates[code] ?? 0) > 0
}

/** Currencies the budget actually deals with. */
export function currenciesInUse(): string[] {
  const s = settings()
  return [...new Set([s.base, ...s.extraCurrencies])]
}

/** Fetch live rates for every currency in use. Manually pinned rates are left alone. */
export async function refreshRates(force = false): Promise<boolean> {
  const s = settings()
  const wanted = currenciesInUse().filter((c) => c !== s.base)
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
      const rates = { ...s.rates }
      for (const c of wanted) {
        if (s.pinned?.[c]) continue
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
