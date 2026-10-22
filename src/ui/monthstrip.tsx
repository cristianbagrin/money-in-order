import { useEffect, useRef, useState } from 'preact/hooks'
import { addMonths, monthDiff, monthName } from '../lib/dates'
import type { Month } from '../lib/types'
import { IconChevron } from './kit'
import './monthstrip.css'

/** How a month stands in the plan: a mark under its name. */
export type MonthMark = 'planned' | 'covered' | 'short'

/**
 * The months in a row, the chosen one pressed. ‹ › page the row a whole stretch of months (the chosen one stays
 * chosen); ← → on a keyboard step one month and the row slides along.
 * Plan shows last month, now and what's coming; Review shows the months behind.
 */
export function MonthStrip(props: {
  month: Month
  current: Month
  setMonth: (m: Month | ((prev: Month) => Month)) => void
  /** months shown at once */
  count?: number
  /** where `current` sits in the row at first (0 = first chip) */
  at?: number
  min?: Month
  max?: Month
  mark?: (m: Month) => MonthMark | undefined
  /** what a mark means, for screen readers */
  markLabel?: (m: Month) => string | undefined
  /** a tiny dot by the name: money is already planned in that month */
  dot?: (m: Month) => boolean
}) {
  const { month, current, min, max } = props
  const count = props.count ?? 6
  const clamp = (m: Month) => (min && m < min ? min : max && m > max ? max : m)
  /** A row start that keeps the whole row inside min…max. */
  const fitStart = (s: Month) => {
    if (max && addMonths(s, count - 1) > max) s = addMonths(max, -(count - 1))
    if (min && s < min) s = min
    return s
  }
  const firstStart = () => fitStart(addMonths(current, -(props.at ?? 1)))
  const [start, setStart] = useState(firstStart)
  // The row follows the chosen month: one step past either end slides it, a jump (Now, a link) re-centres it.
  useEffect(() => {
    setStart((s) => {
      const end = addMonths(s, count - 1)
      if (month >= s && month <= end) return s
      if (month === addMonths(s, -1)) return month
      if (month === addMonths(end, 1)) return addMonths(s, 1)
      if (month === current) return firstStart()
      return addMonths(month, -Math.floor((count - 1) / 2))
    })
  }, [month])

  // ← → step a month on a keyboard. Functional updates, so quick or held presses each move one month.
  const bounds = useRef({ min, max })
  bounds.current = { min, max }
  const step = (n: number) =>
    props.setMonth((m) => {
      const b = bounds.current
      const next = addMonths(m, n)
      return (b.min && next < b.min) || (b.max && next > b.max) ? m : next
    })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const months: Month[] = []
  for (let i = 0; i < count; i++) {
    const m = addMonths(start, i)
    if ((!min || m >= min) && (!max || m <= max)) months.push(m)
  }
  const atMin = !!min && start <= min
  const atMax = !!max && addMonths(start, count - 1) >= max
  const page = (n: number) => setStart((s) => fitStart(addMonths(s, n * count)))
  const thisYear = current.slice(0, 4)
  return (
    <div class="mstrip" role="group" aria-label="Months">
      <button class="iconbtn mstrip-arrow" aria-label="Earlier months" disabled={atMin} onClick={() => page(-1)}>
        <IconChevron dir="left" />
      </button>
      <div class="mstrip-row" style={{ '--n': count }}>
        {months.map((m) => {
          const mark = props.mark?.(m)
          const extra = props.markLabel?.(m)
          const dot = props.dot?.(m)
          const past = monthDiff(m, current) > 0
          return (
            <button
              key={m}
              class={`mstrip-m${mark ? ` ${mark}` : ''}${past ? ' past' : ''}${m === current ? ' now' : ''}`}
              aria-pressed={m === month}
              aria-label={`${monthName(m, { year: true })}${m === current ? ', this month' : ''}${dot ? ', money planned' : ''}${extra ? `, ${extra}` : ''}`}
              onClick={() => props.setMonth(clamp(m))}
            >
              {monthName(m, { short: true })}
              {/* the year, small in the corner, where it changes (or starts the row) and isn't this one */}
              {m.slice(0, 4) !== thisYear && (m.endsWith('-01') || m === months[0]) && <small>’{m.slice(2, 4)}</small>}
              {dot && <i class="mstrip-dot" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <button class="iconbtn mstrip-arrow" aria-label="Later months" disabled={atMax} onClick={() => page(1)}>
        <IconChevron dir="right" />
      </button>
    </div>
  )
}
