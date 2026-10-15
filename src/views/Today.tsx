import { useMemo, useState } from 'preact/hooks'
import { daily, monthView } from '../lib/budget'
import { dayOfMonth, daysInMonth, longDate, monthOf } from '../lib/dates'
import { fmt } from '../lib/money'
import { RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { Sheet } from '../ui/kit'
import { Register } from './Register'
import { TxnRow } from './TxnSheet'
import type { Txn } from '../lib/types'

export function Today(props: {
  today: string
  wide: boolean
  header: preact.ComponentChildren
  onCover: (cat: ID) => void
  onEdit: (t: Txn) => void
  onPlan: () => void
}) {
  const ix = useIndex()
  const { today } = props
  const base = ix.settings.base
  const month = monthOf(today)
  const view = useMemo(() => monthView(ix, month, month), [ix, month])
  const d = useMemo(() => daily(ix, view, today), [ix, view, today])
  const todays = ix.txns.filter((t) => t.date === today && !t.kind)
  const spentToday = -todays.filter((t) => t.cat !== RTA).reduce((s, t) => s + t.base, 0)
  const [listOpen, setListOpen] = useState(false)

  const dim = daysInMonth(month)
  const dom = dayOfMonth(today)

  const hero = (
    <section class="hero">
      {d && d.monthBudget <= 0 && d.available <= 0 && d.monthSpent === 0 ? (
        <>
          <div class="hero-num" style={{ fontSize: 'clamp(38px, 11vw, 56px)' }}>
            Plan first
          </div>
          <div class="hero-cap">
            Give {d.cats.map((c) => c.name).join(' + ')} money for the month and your daily allowance shows up here.
            {view.readyToAssign > 0 && (
              <>
                {' '}
                <b class="num">{fmt(view.readyToAssign, base)}</b> is waiting.
              </>
            )}
          </div>
          <button class="btn" style={{ marginTop: '14px' }} onClick={props.onPlan}>
            Open the plan
          </button>
        </>
      ) : d ? (
        <>
          <div class={`hero-num${d.leftToday < 0 ? ' neg' : ''}`}>
            <span class={`marked${d.leftToday < 0 ? ' neg' : ''}`}>{fmt(Math.abs(d.leftToday), base)}</span>
          </div>
          <div class="hero-cap">
            {d.leftToday < 0 ? (
              <>
                <b>over</b> today's share
              </>
            ) : d.spentToday > 0 ? (
              <>
                left for today, of <b class="num">{fmt(d.allowance, base)}</b>
              </>
            ) : (
              <>left to spend today</>
            )}
          </div>
          <div class="days" aria-hidden="true">
            <div class="days-ticks">
              {Array.from({ length: dim }, (_, i) => (
                <i key={i} class={i + 1 < dom ? 'past' : i + 1 === dom ? 'now' : (i + 1) % 7 === 0 ? 'week' : ''} />
              ))}
            </div>
          </div>
          <div class="hero-meta">
            <span>
              <b class="num">{fmt(d.available, base)}</b> in {d.cats.map((c) => c.name).join(' + ')} · {d.daysLeft} {d.daysLeft === 1 ? 'day' : 'days'}
            </span>
            {d.tomorrow !== null && (
              <span>
                tomorrow <b class="num">{fmt(d.tomorrow, base)}</b>
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div class="hero-num">
            <span class="marked">{fmt(spentToday, base)}</span>
          </div>
          <div class="hero-cap">spent today · turn on “daily allowance” for a category to see what's left per day</div>
        </>
      )}
    </section>
  )

  const list = (
    <div>
      {todays.length ? (
        todays.map((t) => <TxnRow key={t.id} t={t} onClick={() => props.onEdit(t)} />)
      ) : (
        <p class="empty">Nothing logged today.</p>
      )}
    </div>
  )

  if (props.wide) {
    return (
      <div class="split">
        <div>
          {props.header}
          {hero}
          {view.overspent.length > 0 && <Overspent view={view} base={base} onCover={props.onCover} />}
          <div class="section">
            <span class="label">
              Today · {longDate(today)}
              {spentToday > 0 && ` · ${fmt(spentToday, base)}`}
            </span>
            {list}
          </div>
        </div>
        <aside>
          <Register today={today} onCover={props.onCover} />
        </aside>
      </div>
    )
  }

  return (
    <div class="today">
      {props.header}
      {hero}
      <div class="today-list">
        {todays.length > 0 && (
          <button class="dayhead line-btn" onClick={() => setListOpen(true)}>
            <span class="label">Logged today</span>
            <span class="label num">{fmt(-spentToday, base)}</span>
          </button>
        )}
        {todays.map((t) => (
          <TxnRow key={t.id} t={t} compact onClick={() => props.onEdit(t)} />
        ))}
      </div>
      <Register today={today} onCover={props.onCover} />
      <Sheet open={listOpen} onClose={() => setListOpen(false)} title={`Today · ${longDate(today)}`}>
        {list}
      </Sheet>
    </div>
  )
}

function Overspent(props: { view: ReturnType<typeof monthView>; base: string; onCover: (cat: ID) => void }) {
  const first = props.view.overspent[0]
  const more = props.view.overspent.length - 1
  return (
    <button class="todaylist-toggle" style={{ color: 'var(--red)', borderTop: 0 }} onClick={() => props.onCover(first.cat.id)}>
      <span>
        <b>{first.cat.name}</b> is {fmt(-first.available, props.base)} over{more > 0 ? ` (+${more} more)` : ''}
      </span>
      <span class="link" style={{ color: 'var(--red)' }}>
        Cover
      </span>
    </button>
  )
}
