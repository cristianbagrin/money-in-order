import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { daily, monthView } from '../lib/budget'
import { addMonths, monthName, monthOf } from '../lib/dates'
import { claudeSummary } from '../lib/export'
import { burn, categoryTrends, insights, lastDays, monthSeries, weeks } from '../lib/insights'
import { fmt } from '../lib/money'
import { setNote } from '../lib/store'
import { BurnChart, DayBars, MonthBars, Sparkline, WeekBars } from '../ui/charts'
import { useIndex, useMedia } from '../ui/hooks'
import { IconChevron, toast } from '../ui/kit'
import { play } from '../ui/sound'

export function Review(props: { today: string; month: string; setMonth: (m: string) => void }) {
  const ix = useIndex()
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const first = ix.months[0] ?? current
  const isCurrent = month === current
  const wide = useMedia('(min-width: 960px)')
  const narrow = useMedia('(max-width: 359px)')

  const notes = useMemo(() => insights(ix, month, today), [ix, month, today])
  const b = useMemo(() => burn(ix, month, today), [ix, month, today])
  // six months up to now, or up to five months after the month shown when that is older
  const months = useMemo(() => {
    const end = month < addMonths(current, -5) ? addMonths(month, 5) : current
    const list: string[] = []
    for (let i = 5; i >= 0; i--) {
      const m = addMonths(end, -i)
      if (m >= first) list.push(m)
    }
    return monthSeries(ix, list, current)
  }, [ix, month, current, first])
  const days = useMemo(() => (isCurrent ? lastDays(ix, today, 14) : []), [ix, today, isCurrent])
  const allowance = useMemo(() => {
    const d = daily(ix, monthView(ix, current, current), today)
    return d && d.available > 0 ? d.allowance : null
  }, [ix, current, today])
  const wk = useMemo(() => weeks(ix, today, 8), [ix, today])
  const trends = useMemo(() => categoryTrends(ix, month, today, 6), [ix, month, today])
  const hasSpending = b.actual.some((v) => (v ?? 0) > 0) || b.plan > 0
  const hasData = ix.months.includes(month)
  const sparks = (trends[0]?.series.length ?? 0) > 1

  // Every press moves one month, however fast they come: read and write the month through a ref,
  // not the value this render closed over.
  const nav = useRef({ month, first, current, setMonth: props.setMonth })
  nav.current = { month, first, current, setMonth: props.setMonth }
  const go = (m: string) => {
    const n = nav.current
    const next = m < n.first ? n.first : m > n.current ? n.current : m
    if (next === n.month) return
    n.month = next
    n.setMonth(next)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') go(addMonths(nav.current.month, -1))
      else if (e.key === 'ArrowRight') go(addMonths(nav.current.month, 1))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A month picked in the chart opens at the top, so its name is in view.
  const open = (m: string) => {
    go(m)
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  const atFirst = month <= first
  return (
    <div>
      <div class="pagehead">
        <div class="monthnav">
          <button class="iconbtn" aria-label="Previous month" disabled={atFirst} style={{ opacity: atFirst ? 0.3 : 1 }} onClick={() => go(addMonths(month, -1))}>
            <IconChevron dir="left" />
          </button>
          <h1>{monthName(month, { year: month.slice(0, 4) !== today.slice(0, 4) })}</h1>
          <button class="iconbtn" aria-label="Next month" disabled={month >= current} style={{ opacity: month >= current ? 0.3 : 1 }} onClick={() => go(addMonths(month, 1))}>
            <IconChevron dir="right" />
          </button>
        </div>
        {!isCurrent && (
          <button class="pill sm" onClick={() => go(current)}>
            Now
          </button>
        )}
      </div>

      {notes.length > 0 ? (
        <ul class="insights">
          {notes.map((n, i) => (
            <li key={i} class={n.tone}>
              {n.text}
            </li>
          ))}
        </ul>
      ) : (
        !hasSpending && <p class="empty">Log a few days of spending and this fills in.</p>
      )}

      {hasSpending && (
        <section class="card">
          <h2>{isCurrent ? 'This month so far' : monthName(month)}</h2>
          <BurnChart burn={b} base={base} />
        </section>
      )}

      {isCurrent && days.some((d) => d.spent > 0) && (
        <section class="card">
          <h2>Day to day</h2>
          <DayBars days={days} allowance={allowance} base={base} today={today} />
        </section>
      )}

      {isCurrent && wk.some((w) => w.spent > 0) && (
        <section class="card">
          <h2>Week to week</h2>
          <WeekBars weeks={wk} base={base} />
        </section>
      )}

      {months.length > 1 && (
        <section class="card">
          <h2>Month to month</h2>
          <MonthBars points={months} base={base} current={current} selected={month} onSelect={open} />
        </section>
      )}

      {trends.length > 0 && (
        <section class="card">
          <h2>Categories</h2>
          <div class={`trends${sparks ? '' : ' flat'}`}>
            {trends.map((t) => (
              <div class="trend-row" key={t.id}>
                <span class="trend-name">
                  {t.name}
                  {t.overMonths >= 2 && <small class="neg">over {t.overMonths} months</small>}
                </span>
                {sparks && <Sparkline values={t.series} highlightLast width={wide ? 112 : narrow ? 44 : 72} />}
                <span class="num">
                  {fmt(t.thisMonth, base)}
                  {t.average > 0 && (
                    <small>
                      avg{isCurrent ? ' by now' : ''} {fmt(t.average, base, { bare: true })}
                    </small>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(hasData || !!ix.db.notes[month]?.text) && <Reflection month={month} />}

      {hasData && <AskClaude today={today} />}
    </div>
  )
}

function Reflection(props: { month: string }) {
  const ix = useIndex()
  const saved = ix.db.notes[props.month]?.text ?? ''
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [props.month, saved])
  return (
    <section class="section">
      <h2>Notes on {monthName(props.month)}</h2>
      <textarea
        aria-label={`Notes on ${monthName(props.month)}`}
        placeholder="What went wrong? What went right?"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={() => text !== saved && setNote(props.month, text)}
      />
    </section>
  )
}

/** One action: copy the summary and open Claude with it. Transactions are left out unless asked for. */
function AskClaude(props: { today: string }) {
  const ix = useIndex()
  const [withTxns, setWithTxns] = useState(false)

  function ask() {
    const text = claudeSummary(ix, props.today, { months: 6, transactions: withTxns })
    const q = encodeURIComponent(text)
    const prefill = q.length < 7000
    // start the copy and open the tab in the same tap, before anything is awaited (Safari allows neither later)
    let copied: Promise<void>
    try {
      copied = navigator.clipboard.writeText(text)
    } catch (err) {
      copied = Promise.reject(err)
    }
    window.open(prefill ? `https://claude.ai/new?q=${q}` : 'https://claude.ai/new', '_blank', 'noopener')
    copied.then(
      () => {
        play('success')
        toast(prefill ? 'Copied for Claude' : 'Copied. Paste it into the new chat.')
      },
      () => {
        if (prefill) return
        play('error')
        toast('Couldn’t copy')
      },
    )
  }

  return (
    <div class="claude">
      <button class="pill" onClick={ask}>
        Ask Claude
      </button>
      <button class="pill toggle sm" aria-pressed={withTxns} onClick={() => setWithTxns(!withTxns)}>
        With transactions
      </button>
    </div>
  )
}
