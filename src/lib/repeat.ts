import type { Index } from './budget'
import { addMonths, daysInMonth, monthOf, pad } from './dates'
import { convert } from './money'
import { live, RTA, type DB, type Day, type ID, type Month, type Repeat } from './types'

/*
  Repeating payments: set on an entry, a Repeat logs a copy of it on the same day every month (or year).
  Each time it comes back has a fixed id, so two devices logging it write the same entry, and one deleted
  stays deleted.
*/

/** How many missed ones are logged at most, when the app wasn't opened for a long time. */
const CATCH_UP = 24

export function repeatsOf(db: DB): Repeat[] {
  return live(db.repeats ?? {})
}

/** When it comes back in `month`: its day (the month's last, for a shorter month), or null in a year's other months. */
export function dueDate(r: Repeat, month: Month): Day | null {
  if (r.every === 'year' && month.slice(5) !== r.from.slice(5, 7)) return null
  const day = Math.min(Number(r.from.slice(8, 10)), daysInMonth(month))
  return `${month}-${pad(day)}`
}

/** The id of the entry it logs in `month`. */
export const occurrenceId = (r: Repeat, month: Month) => `${r.id}~${r.every === 'year' ? month.slice(0, 4) : month}`

/** The times it comes back after `r.after`, up to and including `through`: oldest first. */
export function occurrences(r: Repeat, through: Day): { id: ID; date: Day }[] {
  const out: { id: ID; date: Day }[] = []
  for (let m = monthOf(r.after); m <= monthOf(through); m = addMonths(m, 1)) {
    const date = dueDate(r, m)
    if (date && date > r.after && date <= through) out.push({ id: occurrenceId(r, m), date })
  }
  return out.slice(-CATCH_UP)
}

/** A repeat that may still log: its category is there and in use (income always is). */
export function active(db: DB, r: Repeat): boolean {
  if (r.cat === RTA) return true
  const c = db.cats[r.cat]
  return !!c && !c.d && !c.archived
}

/** Spending that comes back in `month`, per category, in the base currency (at today's rates). */
export function dueIn(ix: Index, month: Month): Map<ID, number> {
  const out = new Map<ID, number>()
  const { base, rates } = ix.settings
  for (const r of repeatsOf(ix.db)) {
    if (r.cat === RTA || r.amt >= 0 || !active(ix.db, r)) continue
    const date = dueDate(r, month)
    if (!date || date < r.from) continue
    out.set(r.cat, (out.get(r.cat) ?? 0) - convert(r.amt, r.cur, base, rates, base))
  }
  return out
}
