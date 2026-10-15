import { useMemo, useState } from 'preact/hooks'
import { monthView, type CatMonth } from '../lib/budget'
import { addMonths, dayOfMonth, monthName, monthOf } from '../lib/dates'
import { fmt, parseAmount } from '../lib/money'
import { addTxn, fundTargets, lastCount, repeatLastMonth, setAssigned } from '../lib/store'
import { live, RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { Gauge, IconChevron, toast } from '../ui/kit'

export function Plan(props: {
  today: string
  month: string
  setMonth: (m: string) => void
  wide: boolean
  header: preact.ComponentChildren
  onCategory: (id: ID | 'new') => void
  onCount: () => void
  onReflect: (month: string) => void
}) {
  const ix = useIndex()
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const rta = view.readyToAssign
  const nothingAssigned = view.assigned === 0
  const prevHasPlan = (ix.asg.get(addMonths(month, -1))?.size ?? 0) > 0
  const ritual = useRitual(today, view.need, rta)
  const showRitual = month === current && ritual.visible

  function fund() {
    const amt = fundTargets(month, current)
    if (amt) toast(`Assigned ${fmt(amt, base)} to targets`)
  }

  return (
    <div>
      {props.header}
      <div class="topline" style={{ minHeight: '40px', paddingTop: 0 }}>
        <div class="monthnav">
          <button class="iconbtn" aria-label="Previous month" onClick={() => props.setMonth(addMonths(month, -1))}>
            <IconChevron dir="left" />
          </button>
          <h1>{monthName(month, { year: month.slice(0, 4) !== today.slice(0, 4) })}</h1>
          <button class="iconbtn" aria-label="Next month" onClick={() => props.setMonth(addMonths(month, 1))}>
            <IconChevron dir="right" />
          </button>
        </div>
        {month !== current && (
          <button class="link" onClick={() => props.setMonth(current)}>
            This month
          </button>
        )}
      </div>

      <section class="rta">
        <div class={`rta-num ${rta < 0 ? 'neg' : rta > 0 ? 'pos' : ''}`} style={rta === 0 ? { color: 'var(--pen)' } : undefined}>
          <span class={`marked${rta < 0 ? ' neg' : ''}`}>{fmt(rta, base)}</span>
        </div>
        <div class="rta-cap">
          {rta > 0
            ? 'ready to assign. Give it a job.'
            : rta < 0
              ? 'more assigned than you have. Take some back.'
              : 'Every bit of money has a job.'}
        </div>
        <div class="rta-actions">
          {view.need > 0 && rta > 0 && !showRitual && (
            <button class="btn" onClick={fund}>
              Fund targets · {fmt(Math.min(view.need, rta), base)}
            </button>
          )}
          {nothingAssigned && prevHasPlan && rta > 0 && (
            <button
              class="btn ghost"
              onClick={() => {
                repeatLastMonth(month)
                toast('Copied last month’s plan')
              }}
            >
              Repeat last month
            </button>
          )}
        </div>
      </section>

      {showRitual && <Ritual r={ritual} today={today} onCount={props.onCount} onReflect={props.onReflect} onFund={fund} needs={view.need} />}

      {view.groups.map((g) => (
        <div key={g.group.id}>
          <div class="budget-head">
            <span class="label">{g.group.name}</span>
            <span class="cols">
              <span class="label">Assigned</span>
              <span class="label">Spent</span>
            </span>
            <span class="label" style={{ textAlign: 'right' }}>
              {fmt(g.available, base)}
            </span>
          </div>
          {g.cats.map((c) => (
            <CatRow key={c.cat.id} c={c} base={base} month={month} wide={props.wide} onOpen={() => props.onCategory(c.cat.id)} />
          ))}
        </div>
      ))}

      <div class="addcat">
        <button class="link" onClick={() => props.onCategory('new')}>
          + New category
        </button>
      </div>
    </div>
  )
}

function CatRow(props: { c: CatMonth; base: string; month: string; wide: boolean; onOpen: () => void }) {
  const { c, base } = props
  const budget = c.carry + c.assigned
  const spent = -c.activity
  const short = c.need > 0 && c.available >= 0
  const tone = c.available < 0 ? 'neg' : short ? 'short' : c.available > 0 ? 'pos' : 'zero'
  let sub = c.cat.note ?? ''
  let subClass = ''
  if (c.need > 0) {
    sub = `needs ${fmt(c.need, base)} more`
    subClass = 'needs'
  } else if (c.available < 0) {
    sub = `overspent by ${fmt(-c.available, base)}`
  }
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div class="cat" role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => e.key === 'Enter' && props.onOpen()}>
      <div class="cat-name">
        <b>{c.cat.name}</b>
        {sub && <small class={subClass}>{sub}</small>}
      </div>
      <div class="cat-assigned" onClick={(e) => e.stopPropagation()}>
        {props.wide && (
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Assigned to ${c.cat.name}`}
            value={editing ?? fmt(c.assigned, base, { bare: true })}
            onFocus={(e) => {
              setEditing(c.assigned ? String(c.assigned / 100) : '')
              requestAnimationFrame(() => e.currentTarget?.select())
            }}
            onInput={(e) => setEditing(e.currentTarget.value)}
            onBlur={(e) => {
              const raw = e.currentTarget.value.trim()
              const v = raw === '' ? 0 : parseAmount(raw)
              if (v !== null && v !== c.assigned) setAssigned(props.month, c.cat.id, v)
              setEditing(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setEditing(null)
                e.currentTarget.blur()
              }
            }}
          />
        )}
      </div>
      <span class="cat-spent num">{fmt(spent, base, { bare: true })}</span>
      <span class="cat-avail">
        <span class={`avail ${tone}`}>{fmt(c.available, base)}</span>
      </span>
      <div class="cat-gauge">
        <Gauge used={spent} total={budget} />
      </div>
    </div>
  )
}

/**
 * The start-of-month routine from the spreadsheet, made into four checkable steps:
 * count the money, log income, fund targets, look back at last month.
 */
function useRitual(today: string, needs: number, rta: number) {
  const ix = useIndex()
  const month = monthOf(today)
  const prev = addMonths(month, -1)
  const key = `mio-ritual-${month}`
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const base = ix.settings.base
  const count = lastCount()
  const counted = !!count && monthOf(count.date) === month
  const incomeNow = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === month)
  const incomeBefore = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === prev)
  // Suggest last month's income that hasn't shown up yet this month (same note).
  const seen = new Set(incomeNow.map((t) => (t.note ?? '').toLowerCase()))
  const suggestions = incomeBefore.filter((t) => !seen.has((t.note ?? '').toLowerCase())).slice(0, 3)
  const hasData = ix.months.some((m) => m < month)
  const reflected = !!ix.db.notes[prev]?.text?.trim()
  const funded = needs === 0 || rta <= 0
  const doneAll = counted && incomeNow.length > 0 && funded && (reflected || !hasData)
  const visible = !(hidden || dayOfMonth(today) > 12 || doneAll || !live(ix.db.accounts).length)
  const hide = () => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* private mode */
    }
    setHidden(true)
  }
  return { visible, hide, base, count, counted, incomeNow, suggestions, hasData, reflected, funded, prev }
}

function Ritual(props: {
  r: ReturnType<typeof useRitual>
  today: string
  onCount: () => void
  onReflect: (m: string) => void
  onFund: () => void
  needs: number
}) {
  const { today } = props
  const { base, count, counted, incomeNow, suggestions, hasData, reflected, funded, prev } = props.r
  return (
    <section class="ritual">
      <div class="ritual-head">
        <span class="label">New month</span>
        <button class="link" style={{ fontSize: '13px' }} onClick={props.r.hide}>
          Hide
        </button>
      </div>
      <ol>
        <li class={counted ? 'done' : ''}>
          <span class="ritual-text">
            Count your money
            <small>{counted ? `Counted ${fmt(count!.total, base)}` : 'Type the real balance of each account'}</small>
          </span>
          {!counted && (
            <button class="btn mini" onClick={props.onCount}>
              Count
            </button>
          )}
        </li>
        <li class={incomeNow.length ? 'done' : ''}>
          <span class="ritual-text">
            Log this month's income
            <small>
              {incomeNow.length
                ? `${fmt(incomeNow.reduce((s, t) => s + t.base, 0), base)} so far`
                : suggestions.length
                  ? 'Same as last month?'
                  : 'Use “+ Income” on Today'}
            </small>
          </span>
        </li>
        {suggestions.map((t) => (
          <li key={t.id} class="sub">
            <span class="ritual-text">
              {t.note || 'Income'} <span class="num faint">{fmt(t.amt, t.cur)}</span>
            </span>
            <button
              class="btn ghost mini"
              onClick={() => {
                addTxn({ date: today, cat: RTA, amt: t.amt, cur: t.cur, note: t.note })
                toast(`${fmt(t.amt, t.cur)} logged`)
              }}
            >
              Log
            </button>
          </li>
        ))}
        <li class={funded ? 'done' : ''}>
          <span class="ritual-text">
            Fund your targets
            <small>{funded ? 'Done' : `${fmt(props.needs, base)} still needed`}</small>
          </span>
          {!funded && (
            <button class="btn mini" onClick={props.onFund}>
              Fund
            </button>
          )}
        </li>
        {hasData && (
          <li class={reflected ? 'done' : ''}>
            <span class="ritual-text">
              Look back at {monthName(prev)}
              <small>{reflected ? 'Noted' : 'What went wrong, what went right'}</small>
            </span>
            {!reflected && (
              <button class="btn ghost mini" onClick={() => props.onReflect(prev)}>
                Write
              </button>
            )}
          </li>
        )}
      </ol>
    </section>
  )
}
