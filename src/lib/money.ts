// All amounts are integers in minor units (1/100 of a currency unit).

export interface CurrencyInfo {
  code: string
  symbol: string
  /** symbol after the number ("120 zł") instead of before ("NT$120") */
  suffix?: boolean
  /** decimals to show; TWD is effectively used without cents */
  decimals: number
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  TWD: { code: 'TWD', symbol: 'NT$', decimals: 0 },
  EUR: { code: 'EUR', symbol: '€', decimals: 2 },
  PLN: { code: 'PLN', symbol: 'zł', suffix: true, decimals: 2 },
  USD: { code: 'USD', symbol: '$', decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', decimals: 2 },
  CHF: { code: 'CHF', symbol: 'CHF', suffix: true, decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥', decimals: 0 },
  CZK: { code: 'CZK', symbol: 'Kč', suffix: true, decimals: 2 },
  HUF: { code: 'HUF', symbol: 'Ft', suffix: true, decimals: 0 },
  SEK: { code: 'SEK', symbol: 'kr', suffix: true, decimals: 2 },
  NOK: { code: 'NOK', symbol: 'kr', suffix: true, decimals: 2 },
  DKK: { code: 'DKK', symbol: 'kr', suffix: true, decimals: 2 },
  CAD: { code: 'CAD', symbol: 'C$', decimals: 2 },
  AUD: { code: 'AUD', symbol: 'A$', decimals: 2 },
  HKD: { code: 'HKD', symbol: 'HK$', decimals: 2 },
  SGD: { code: 'SGD', symbol: 'S$', decimals: 2 },
  CNY: { code: 'CNY', symbol: '¥', decimals: 2 },
  KRW: { code: 'KRW', symbol: '₩', decimals: 0 },
  THB: { code: 'THB', symbol: '฿', decimals: 2 },
  RON: { code: 'RON', symbol: 'lei', suffix: true, decimals: 2 },
  MDL: { code: 'MDL', symbol: 'L', suffix: true, decimals: 2 },
  UAH: { code: 'UAH', symbol: '₴', decimals: 2 },
}

export function cur(code: string): CurrencyInfo {
  return CURRENCIES[code] ?? { code, symbol: code, suffix: true, decimals: 2 }
}

const groupFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export interface FormatOpts {
  /** always show + for positive numbers */
  sign?: boolean
  /** drop the currency symbol */
  bare?: boolean
  /** force showing decimals even for whole amounts */
  exact?: boolean
}

/** 12345 (minor) in EUR -> "€123.45"; in TWD -> "NT$123" */
export function fmt(minor: number, code: string, opts: FormatOpts = {}): string {
  const c = cur(code)
  const neg = minor < 0
  const abs = Math.abs(minor)
  const whole = Math.floor(abs / 100)
  const cents = abs % 100
  let num = groupFmt.format(whole)
  const showCents = c.decimals > 0 && (cents !== 0 || opts.exact)
  if (showCents) num += '.' + String(cents).padStart(2, '0')
  else if (c.decimals === 0 && cents >= 50 && !opts.exact) num = groupFmt.format(whole + 1)
  const signStr = neg ? '−' : opts.sign && minor > 0 ? '+' : ''
  if (opts.bare) return signStr + num
  return c.suffix ? `${signStr}${num} ${c.symbol}` : `${signStr}${c.symbol}${num}`
}

/** Parse a user-typed amount ("1,250.5", "1250,50") into minor units. */
export function parseAmount(s: string): number | null {
  const t = s.replace(/[\s ]/g, '').replace(/[^\d.,\-−]/g, '')
  if (!t) return null
  const neg = /^[-−]/.test(t)
  let body = t.replace(/[-−]/g, '')
  // Treat the last separator as decimal if it is followed by 1-2 digits.
  const m = body.match(/^(.*)[.,](\d{1,2})$/)
  let whole: string, frac: string
  if (m) {
    whole = m[1].replace(/[.,]/g, '')
    frac = m[2].padEnd(2, '0')
  } else {
    whole = body.replace(/[.,]/g, '')
    frac = '00'
  }
  if (!/^\d*$/.test(whole)) return null
  const v = Number(whole || '0') * 100 + Number(frac)
  if (!Number.isFinite(v)) return null
  return neg ? -v : v
}

/** Rates map: value of 1 unit of currency in base currency. base itself = 1. */
export type Rates = Record<string, number>

export function convert(minor: number, from: string, to: string, rates: Rates, base: string): number {
  if (from === to) return minor
  const rf = from === base ? 1 : rates[from]
  const rt = to === base ? 1 : rates[to]
  if (!rf || !rt) return minor
  return Math.round((minor * rf) / rt)
}

/** Turn keypad digits into minor units. "125" -> 12500, "12.5" -> 1250 */
export function keypadToMinor(s: string): number {
  if (!s) return 0
  const [w, f = ''] = s.split('.')
  return Number(w || '0') * 100 + Number((f + '00').slice(0, 2))
}
