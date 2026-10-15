import { useEffect, useMemo, useState } from 'preact/hooks'
import { addMonths, monthName, monthOf } from '../lib/dates'
import { claudeSummary } from '../lib/export'
import { burn, categoryTrends, insights, monthSeries, weeks } from '../lib/insights'
import { fmt } from '../lib/money'
import { setNote } from '../lib/store'
import { BurnChart, MonthBars, Sparkline, WeekBars } from '../ui/charts'
import { useIndex } from '../ui/hooks'
import { IconChevron, toast } from '../ui/kit'
import { play } from '../ui/sound'

export function Review(props: { today: string; month: string; setMonth: (m: string) => void }) {
  const ix = useIndex()
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const first = ix.months[0] ?? current

  const notes = useMemo(() => insights(ix, month, today), [ix, month, today])
  const b = useMemo(() => burn(ix, month, today), [ix, month, today])
  const months = useMemo(() => {
    const list: string[] = []
    for (let i = 5; i >= 0; i--) {
      const m = addMonths(month, -i)
      if (m >= first) list.push(m)
    }
    return monthSeries(ix, list, current)
  }, [ix, month, current, first])
  const wk = useMemo(() => weeks(ix, today, 8), [ix, today])
  const trends = useMemo(() => categoryTrends(ix, month, current, 6), [ix, month, current])
  const hasSpending = b.actual.some((v) => (v ?? 0) > 0) || b.plan > 0

  // ← → switch months on a keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowLeft') props.setMonth(addMonths(month, -1))
      else if (e.key === 'ArrowRight' && month < current) props.setMonth(addMonths(month, 1))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [month, current])

  return (
    <div>
      <div class="pagehead">
        <div class="monthnav">
          <button class="iconbtn" aria-label="Previous month" onClick={() => props.setMonth(addMonths(month, -1))}>
            <IconChevron dir="left" />
          </button>
          <h1>{monthName(month, { year: month.slice(0, 4) !== today.slice(0, 4) })}</h1>
          <button class="iconbtn" aria-label="Next month" disabled={month >= current} style={{ opacity: month >= current ? 0.3 : 1 }} onClick={() => props.setMonth(addMonths(month, 1))}>
            <IconChevron dir="right" />
          </button>
        </div>
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
        <p class="empty">Log a few days of spending and this fills in.</p>
      )}

      {hasSpending && (
        <section class="card">
          <h2>{month === current ? 'This month so far' : monthName(month)}</h2>
          <BurnChart burn={b} base={base} />
        </section>
      )}

      {months.length > 1 && (
        <section class="card">
          <h2>Months</h2>
          <MonthBars points={months} base={base} current={current} onSelect={(m) => props.setMonth(m)} />
        </section>
      )}

      {month === current && wk.some((w) => w.spent > 0) && (
        <section class="card">
          <h2>Weeks</h2>
          <WeekBars weeks={wk} base={base} />
        </section>
      )}

      {trends.length > 0 && (
        <section class="card">
          <h2>Categories</h2>
          {trends.map((t) => (
            <div class="trend-row" key={t.id}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.name}
                {t.overMonths >= 2 && <small class="neg">over {t.overMonths} months</small>}
              </span>
              <Sparkline values={t.series} highlightLast />
              <span class="num">
                {fmt(t.thisMonth, base)}
                {t.average > 0 && <small>avg {fmt(t.average, base, { bare: true })}</small>}
              </span>
            </div>
          ))}
        </section>
      )}

      <Reflection month={month} />

      <ClaudeButtons today={today} />
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

function ClaudeButtons(props: { today: string }) {
  const ix = useIndex()
  const [withTxns, setWithTxns] = useState(false)
  const summary = () => claudeSummary(ix, props.today, { months: 6, transactions: withTxns })

  async function copy() {
    try {
      await navigator.clipboard.writeText(summary())
      play('success')
      toast('Copied. Paste it into Claude.')
    } catch {
      play('error')
      toast('Couldn’t copy')
    }
  }

  function open() {
    const text = summary()
    const q = encodeURIComponent(text)
    if (q.length < 7000) {
      window.open(`https://claude.ai/new?q=${q}`, '_blank', 'noopener')
    } else {
      void navigator.clipboard?.writeText(text).catch(() => {})
      window.open('https://claude.ai/new', '_blank', 'noopener')
      toast('Copied. Paste it into the new chat.')
    }
  }

  return (
    <div class="claude">
      <button class="btn" onClick={copy}>
        Copy for Claude
      </button>
      <button class="btn soft" onClick={open}>
        Open Claude
      </button>
      <button class="pill soft sm" aria-pressed={withTxns} onClick={() => setWithTxns(!withTxns)}>
        With every transaction
      </button>
    </div>
  )
}
