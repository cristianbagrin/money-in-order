// Dates are local calendar dates as "YYYY-MM-DD"; months as "YYYY-MM".

export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function isoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) + n
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`
}

export function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number)
  const [yb, mb] = b.split('-').map(Number)
  return (yb - ya) * 12 + (mb - ma)
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10))
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return isoDate(new Date(y, m - 1, d + n))
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function monthName(month: string, opts: { short?: boolean; year?: boolean } = {}): string {
  const [y, m] = month.split('-').map(Number)
  const name = opts.short ? MONTHS[m - 1].slice(0, 3) : MONTHS[m - 1]
  return opts.year ? `${name} ${y}` : name
}

export function dateLabel(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, -1)) return 'Yesterday'
  if (date === addDays(today, 1)) return 'Tomorrow'
  const [y, m, d] = date.split('-').map(Number)
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()]
  const sameYear = date.slice(0, 4) === today.slice(0, 4)
  return `${wd.slice(0, 3)} ${d} ${MONTHS[m - 1].slice(0, 3)}${sameYear ? '' : ' ' + y}`
}

export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${d} ${MONTHS[m - 1]}`
}
