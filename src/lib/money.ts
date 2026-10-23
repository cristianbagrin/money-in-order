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
  NZD: { code: 'NZD', symbol: 'NZ$', decimals: 2 },
  MXN: { code: 'MXN', symbol: 'MX$', decimals: 2 },
  BRL: { code: 'BRL', symbol: 'R$', decimals: 2 },
  ARS: { code: 'ARS', symbol: 'AR$', decimals: 2 },
  CLP: { code: 'CLP', symbol: 'CLP$', decimals: 0 },
  COP: { code: 'COP', symbol: 'COL$', decimals: 0 },
  PEN: { code: 'PEN', symbol: 'S/', decimals: 2 },
  INR: { code: 'INR', symbol: '₹', decimals: 2 },
  IDR: { code: 'IDR', symbol: 'Rp', decimals: 0 },
  MYR: { code: 'MYR', symbol: 'RM', decimals: 2 },
  PHP: { code: 'PHP', symbol: '₱', decimals: 2 },
  VND: { code: 'VND', symbol: '₫', suffix: true, decimals: 0 },
  AED: { code: 'AED', symbol: 'AED', suffix: true, decimals: 2 },
  SAR: { code: 'SAR', symbol: 'SAR', suffix: true, decimals: 2 },
  ILS: { code: 'ILS', symbol: '₪', decimals: 2 },
  TRY: { code: 'TRY', symbol: '₺', decimals: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', decimals: 2 },
  EGP: { code: 'EGP', symbol: 'E£', decimals: 2 },
  BGN: { code: 'BGN', symbol: 'лв', suffix: true, decimals: 2 },
  RSD: { code: 'RSD', symbol: 'дин', suffix: true, decimals: 0 },
  GEL: { code: 'GEL', symbol: '₾', suffix: true, decimals: 2 },
  ISK: { code: 'ISK', symbol: 'kr', suffix: true, decimals: 0 },
  KZT: { code: 'KZT', symbol: '₸', suffix: true, decimals: 2 },
}

/** Shown first when picking currencies; the rest sit behind "More". */
export const COMMON_CURRENCIES = ['TWD', 'EUR', 'PLN', 'USD', 'GBP', 'CHF', 'MDL', 'RON', 'UAH', 'JPY']

/** Every currency a traveller might meet, by name (for finding "baht" or "dong" by typing). */
export const CURRENCY_NAMES: Record<string, string> = {
  AED: 'UAE dirham', AFN: 'Afghan afghani', ALL: 'Albanian lek', AMD: 'Armenian dram', ANG: 'Netherlands Antillean guilder',
  AOA: 'Angolan kwanza', ARS: 'Argentine peso', AUD: 'Australian dollar', AWG: 'Aruban florin', AZN: 'Azerbaijani manat',
  BAM: 'Bosnian mark', BBD: 'Barbadian dollar', BDT: 'Bangladeshi taka', BGN: 'Bulgarian lev', BHD: 'Bahraini dinar',
  BIF: 'Burundian franc', BMD: 'Bermudian dollar', BND: 'Brunei dollar', BOB: 'Bolivian boliviano', BRL: 'Brazilian real',
  BSD: 'Bahamian dollar', BTN: 'Bhutanese ngultrum', BWP: 'Botswana pula', BYN: 'Belarusian ruble', BZD: 'Belize dollar',
  CAD: 'Canadian dollar', CDF: 'Congolese franc', CHF: 'Swiss franc', CLP: 'Chilean peso', CNY: 'Chinese yuan',
  COP: 'Colombian peso', CRC: 'Costa Rican colon', CUP: 'Cuban peso', CVE: 'Cape Verdean escudo', CZK: 'Czech koruna',
  DJF: 'Djiboutian franc', DKK: 'Danish krone', DOP: 'Dominican peso', DZD: 'Algerian dinar', EGP: 'Egyptian pound',
  ERN: 'Eritrean nakfa', ETB: 'Ethiopian birr', EUR: 'Euro', FJD: 'Fijian dollar', FKP: 'Falkland pound',
  GBP: 'British pound', GEL: 'Georgian lari', GHS: 'Ghanaian cedi', GIP: 'Gibraltar pound', GMD: 'Gambian dalasi',
  GNF: 'Guinean franc', GTQ: 'Guatemalan quetzal', GYD: 'Guyanese dollar', HKD: 'Hong Kong dollar', HNL: 'Honduran lempira',
  HTG: 'Haitian gourde', HUF: 'Hungarian forint', IDR: 'Indonesian rupiah', ILS: 'Israeli shekel', INR: 'Indian rupee',
  IQD: 'Iraqi dinar', IRR: 'Iranian rial', ISK: 'Icelandic krona', JMD: 'Jamaican dollar', JOD: 'Jordanian dinar',
  JPY: 'Japanese yen', KES: 'Kenyan shilling', KGS: 'Kyrgyzstani som', KHR: 'Cambodian riel', KMF: 'Comorian franc',
  KRW: 'South Korean won', KWD: 'Kuwaiti dinar', KYD: 'Cayman dollar', KZT: 'Kazakhstani tenge', LAK: 'Lao kip',
  LBP: 'Lebanese pound', LKR: 'Sri Lankan rupee', LRD: 'Liberian dollar', LSL: 'Lesotho loti', LYD: 'Libyan dinar',
  MAD: 'Moroccan dirham', MDL: 'Moldovan leu', MGA: 'Malagasy ariary', MKD: 'Macedonian denar', MMK: 'Myanmar kyat',
  MNT: 'Mongolian tugrik', MOP: 'Macanese pataca', MRU: 'Mauritanian ouguiya', MUR: 'Mauritian rupee', MVR: 'Maldivian rufiyaa',
  MWK: 'Malawian kwacha', MXN: 'Mexican peso', MYR: 'Malaysian ringgit', MZN: 'Mozambican metical', NAD: 'Namibian dollar',
  NGN: 'Nigerian naira', NIO: 'Nicaraguan cordoba', NOK: 'Norwegian krone', NPR: 'Nepalese rupee', NZD: 'New Zealand dollar',
  OMR: 'Omani rial', PAB: 'Panamanian balboa', PEN: 'Peruvian sol', PGK: 'Papua New Guinean kina', PHP: 'Philippine peso',
  PKR: 'Pakistani rupee', PLN: 'Polish zloty', PYG: 'Paraguayan guarani', QAR: 'Qatari riyal', RON: 'Romanian leu',
  RSD: 'Serbian dinar', RUB: 'Russian ruble', RWF: 'Rwandan franc', SAR: 'Saudi riyal', SBD: 'Solomon Islands dollar',
  SCR: 'Seychellois rupee', SDG: 'Sudanese pound', SEK: 'Swedish krona', SGD: 'Singapore dollar', SHP: 'Saint Helena pound',
  SLE: 'Sierra Leonean leone', SOS: 'Somali shilling', SRD: 'Surinamese dollar', SZL: 'Swazi lilangeni', THB: 'Thai baht',
  TJS: 'Tajikistani somoni', TMT: 'Turkmenistani manat', TND: 'Tunisian dinar', TOP: 'Tongan paanga', TRY: 'Turkish lira',
  TTD: 'Trinidad and Tobago dollar', TWD: 'New Taiwan dollar', TZS: 'Tanzanian shilling', UAH: 'Ukrainian hryvnia',
  UGX: 'Ugandan shilling', USD: 'US dollar', UYU: 'Uruguayan peso', UZS: 'Uzbekistani som', VES: 'Venezuelan bolivar',
  VND: 'Vietnamese dong', VUV: 'Vanuatu vatu', WST: 'Samoan tala', XAF: 'Central African CFA franc', XCD: 'East Caribbean dollar',
  XOF: 'West African CFA franc', XPF: 'CFP franc', YER: 'Yemeni rial', ZAR: 'South African rand', ZMW: 'Zambian kwacha',
}

/** Currencies that have no minor unit in everyday use (beyond the ones listed in CURRENCIES). */
const WHOLE_ONLY = new Set(['BIF', 'DJF', 'GNF', 'KMF', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF', 'IRR', 'LAK', 'MGA', 'MMK', 'IQD', 'LBP', 'SOS', 'UZS'])

export function cur(code: string): CurrencyInfo {
  return CURRENCIES[code] ?? { code, symbol: code, suffix: true, decimals: WHOLE_ONLY.has(code) ? 0 : 2 }
}

/** Every currency we know, the common ones first, then the ones in the lists, then the rest A to Z. */
export function allCurrencyCodes(): string[] {
  const rest = [...new Set([...Object.keys(CURRENCIES), ...Object.keys(CURRENCY_NAMES)])].filter((c) => !COMMON_CURRENCIES.includes(c)).sort()
  return [...COMMON_CURRENCIES, ...rest]
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

/** What sets two facts on one line apart: a little more room, no dot. */
export const SEP = '\u2003'

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
  // A sliver that rounds away (−NT$0.3) is zero: no sign in front of it.
  const zero = !/[1-9]/.test(num)
  const signStr = zero ? '' : neg ? '−' : opts.sign && minor > 0 ? '+' : ''
  if (opts.bare) return signStr + num
  return c.suffix ? `${signStr}${num} ${c.symbol}` : `${signStr}${c.symbol}${num}`
}

/** How a sign reads once the amount is rounded for display: 1, −1, or 0 when it shows as zero. */
export function shownSign(minor: number, code: string): -1 | 0 | 1 {
  if (!/[1-9]/.test(fmt(minor, code, { bare: true }))) return 0
  return minor < 0 ? -1 : 1
}

/** Biggest amount anyone means to type: 9,999,999,999.99 */
export const MAX_MINOR = 999_999_999_999

/** Parse a user-typed amount ("1,250.5", "1250,50") into minor units. */
export function parseAmount(s: string): number | null {
  // Letters mean a typo, not a number ("1e5" must not quietly become 15).
  if (/[a-z]/i.test(s.replace(/^\s*[A-Z]{3}\s*|\s*[A-Z]{3}\s*$/g, ''))) return null
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
  if (!Number.isFinite(v) || v > MAX_MINOR) return null
  return neg ? -v : v
}

/**
 * Thousands separators for what someone is typing: "1234567.5" -> "1,234,567.5", "6000+500" ->
 * "6,000+500". Commas are always grouping (they are put back where they belong), the dot is the
 * decimal point, and anything else is left as typed.
 */
export function groupTyped(s: string): string {
  return s.replace(/\d[\d,]*(\.\d*)?/g, (run) => {
    const [whole, frac] = run.split('.')
    const digits = whole.replace(/,/g, '')
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? '.' + frac : '')
  })
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

/** Round to what the currency can hold: TWD, JPY and friends have no cents. */
export function roundFor(code: string | undefined, minor: number): number {
  if (!code || cur(code).decimals > 0) return minor
  return Math.round(minor / 100) * 100
}

// What people paste around a number: currency symbols and codes ("NT$1,000", "€ 12,50", "300 PLN").
const MONEY_MARKS = /NT\$|[A-Z]{1,3}\$|[$€£¥₩₹₪₺₴₱₫฿]|zł|Kč|Ft|kr|lei|\b[A-Z]{3}\b/g

/**
 * A typed amount, sums allowed ("6000+500", "1200*3"), in minor units. With a currency code the
 * result is rounded to what that currency can hold.
 */
export function evalAmount(input: string, code?: string): number | null {
  // A sum still being typed ("200 + 15 +") counts up to its last number.
  const v = evalRaw(input.replace(MONEY_MARKS, '').replace(/[\s+\-−*/×÷]+$/, ''))
  return v === null ? null : roundFor(code, v)
}

function evalRaw(input: string): number | null {
  const s = input.replace(/[\s ]/g, '').replace(/[×x]/gi, '*').replace(/[÷]/g, '/').replace(/−/g, '-')
  if (!s || /[^\d.,+\-*/]/.test(s)) return null
  if (!/[+*/]|.-/.test(s)) return parseAmount(s)
  const parts = s.match(/(\d[\d.,]*|[+\-*/])/g)
  if (!parts || parts.join('') !== s.replace(/[^\d.,+\-*/]/g, '')) return null
  // numbers in minor units, then apply * and / before + and -
  const nums: number[] = []
  const ops: string[] = []
  let sign = 1
  let expectNum = true
  for (const p of parts) {
    if (expectNum) {
      if (p === '-') {
        sign = -sign
        continue
      }
      if (p === '+') continue
      const v = parseAmount(p)
      if (v === null) return null
      nums.push(sign * v)
      sign = 1
      expectNum = false
    } else {
      if (!'+-*/'.includes(p)) return null
      ops.push(p)
      expectNum = true
    }
  }
  if (expectNum) return null
  const terms: number[] = [nums[0]]
  const addOps: string[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const n = nums[i + 1]
    if (op === '*') terms[terms.length - 1] = Math.round((terms[terms.length - 1] * n) / 100)
    else if (op === '/') {
      if (n === 0) return null
      terms[terms.length - 1] = Math.round((terms[terms.length - 1] / n) * 100)
    } else {
      terms.push(n)
      addOps.push(op)
    }
  }
  let total = terms[0]
  for (let i = 0; i < addOps.length; i++) total += addOps[i] === '+' ? terms[i + 1] : -terms[i + 1]
  return Number.isFinite(total) && Math.abs(total) <= MAX_MINOR ? total : null
}
