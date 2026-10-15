import { useEffect, useMemo, useState } from 'preact/hooks'
import { monthView } from '../lib/budget'
import { addMonths, monthName, monthOf } from '../lib/dates'
import { claudeSummary, transactionsCSV } from '../lib/export'
import { fmt } from '../lib/money'
import { setNote } from '../lib/store'
import { useIndex } from '../ui/hooks'
import { IconChevron, toast } from '../ui/kit'

export function Review(props: { today: string; month: string; setMonth: (m: string) => void; header: preact.ComponentChildren; onSettings: () => void }) {
  const ix = useIndex()
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const target = ix.settings.savingsTarget

  const spending = view.cats
    .filter((c) => !c.cat.saving && (c.activity !== 0 || c.assigned !== 0 || c.carry !== 0))
    .map((c) => ({ c, spent: -c.activity, plan: c.carry + c.assigned }))
    .sort((a, b) => b.spent - a.spent)
  const scale = Math.max(1, ...spending.map((s) => Math.max(s.spent, s.plan)))

  const trend = useMemo(() => {
    const out = []
    const first = ix.months[0] ?? month
    for (let i = 5; i >= 0; i--) {
      const m = addMonths(month, -i)
      if (m < first) continue
      const v = monthView(ix, m, current)
      out.push({ m, spent: v.spent, rate: v.savingsRate })
    }
    return out
  }, [ix, month, current])
  const trendMax = Math.max(1, ...trend.map((t) => t.spent))
  const hasTrend = trend.filter((t) => t.spent > 0).length > 1

  return (
    <div>
      {props.header}
      <div class="topline" style={{ minHeight: '40px', paddingTop: 0 }}>
        <div class="monthnav">
          <button class="iconbtn" aria-label="Previous month" onClick={() => props.setMonth(addMonths(month, -1))}>
            <IconChevron dir="left" />
          </button>
          <h1>{monthName(month, { year: month.slice(0, 4) !== today.slice(0, 4) })}</h1>
          <button class="iconbtn" aria-label="Next month" onClick={() => props.setMonth(addMonths(month, 1))} disabled={month >= current}>
            <IconChevron dir="right" />
          </button>
        </div>
        <button class="link" onClick={props.onSettings}>
          Settings
        </button>
      </div>

      <div class="figures">
        <div>
          <span class="label">Income</span>
          <span class="hand">{fmt(view.income, base)}</span>
        </div>
        <div>
          <span class="label">Spent</span>
          <span class="hand">{fmt(view.spent, base)}</span>
          {view.income > 0 && <small>{Math.round((view.spent / view.income) * 100)}% of income</small>}
        </div>
        <div>
          <span class="label">Saved</span>
          <span class={`hand ${view.savingsRate !== null && view.savingsRate >= target ? 'pos' : ''}`}>
            {view.savingsRate === null ? fmt(view.saved, base) : `${Math.round(view.savingsRate * 100)}%`}
          </span>
          <small>
            {view.savingsRate === null ? 'no income logged' : `${fmt(view.saved, base)} · target ${Math.round(target * 100)}%`}
          </small>
        </div>
      </div>

      <div class="section bars">
        <span class="label">Plan vs spent{month === current ? ' so far' : ''}</span>
        {spending.length ? (
          spending.map(({ c, spent, plan }) => (
            <div class="barline" key={c.cat.id} title={`${c.cat.name}: spent ${fmt(spent, base)} of ${fmt(plan, base)}`}>
              <span class="barline-name">{c.cat.name}</span>
              <span class={`num ${spent > plan ? 'neg' : ''}`} style={{ fontSize: '13.5px' }}>
                {fmt(spent, base)}
                <span class="faint"> of {fmt(plan, base, { bare: true })}</span>
              </span>
              <div class="bar">
                {plan > 0 && <div class="bar-plan" style={{ width: `${(plan / scale) * 100}%` }} />}
                <div class={`bar-spent${spent > plan ? ' over' : ''}`} style={{ width: `${(Math.max(0, spent) / scale) * 100}%` }} />
              </div>
            </div>
          ))
        ) : (
          <p class="empty">No spending in {monthName(month)}.</p>
        )}
      </div>

      {hasTrend && (
        <div class="section">
          <span class="label">Spending, last 6 months · savings rate on top</span>
          <div class="trend">
            {trend.map((t) => (
              <div class={`trend-col${t.m === current ? ' now' : ''}`} key={t.m} title={`${t.m}: spent ${fmt(t.spent, base)}`}>
                <em class={t.rate !== null && t.rate >= target ? 'ok' : ''}>{t.rate === null ? '' : `${Math.round(t.rate * 100)}%`}</em>
                <div class="trend-bar" style={{ height: `${Math.max(2, (Math.max(0, t.spent) / trendMax) * 80)}%` }} />
                <span>{monthName(t.m, { short: true })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Reflection month={month} />

      <ClaudeBox today={today} />

      <DataBox />
    </div>
  )
}

function Reflection(props: { month: string }) {
  const ix = useIndex()
  const saved = ix.db.notes[props.month]?.text ?? ''
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [props.month, saved])
  return (
    <div class="section">
      <span class="label">Notes on {monthName(props.month)}</span>
      <textarea
        style={{ marginTop: '10px' }}
        placeholder={'What went wrong? (travel ate everything…)\nWhat went right?'}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={() => text !== saved && setNote(props.month, text)}
      />
    </div>
  )
}

function ClaudeBox(props: { today: string }) {
  const ix = useIndex()
  const [months, setMonths] = useState(6)
  const [withTxns, setWithTxns] = useState(false)
  const summary = () => claudeSummary(ix, props.today, { months, transactions: withTxns })

  async function copy() {
    try {
      await navigator.clipboard.writeText(summary())
      toast('Copied. Paste it into Claude.')
    } catch {
      toast('Couldn’t copy. Your browser blocked it.')
    }
  }

  function openClaude() {
    const text = summary()
    const q = encodeURIComponent(text)
    if (q.length < 7000) {
      window.open(`https://claude.ai/new?q=${q}`, '_blank', 'noopener')
    } else {
      void navigator.clipboard?.writeText(text).catch(() => {})
      window.open('https://claude.ai/new', '_blank', 'noopener')
      toast('Summary copied. Paste it into the new chat.')
    }
  }

  return (
    <section class="claude">
      <h3>Talk it through with Claude</h3>
      <p>A clear summary of your plan, spending, savings, counts and notes, written so Claude can analyze it straight away.</p>
      <div class="seg" style={{ marginBottom: '6px' }}>
        {[3, 6, 12].map((n) => (
          <button key={n} aria-pressed={months === n} onClick={() => setMonths(n)}>
            {n} months
          </button>
        ))}
      </div>
      <label class="check">
        <input type="checkbox" checked={withTxns} onChange={(e) => setWithTxns(e.currentTarget.checked)} />
        <span>
          Include every transaction
          <small>Longer, but lets Claude dig into individual purchases.</small>
        </span>
      </label>
      <div class="row" style={{ marginTop: '6px' }}>
        <button class="btn grow" onClick={copy}>
          Copy for Claude
        </button>
        <button class="btn ghost grow" onClick={openClaude}>
          Open Claude
        </button>
      </div>
    </section>
  )
}

async function share(name: string, text: string, type: string) {
  const file = new File([text], name, { type })
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean }
  if (nav.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch {
      /* fall through to download */
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function DataBox() {
  const ix = useIndex()
  const stamp = new Date().toISOString().slice(0, 10)
  return (
    <div class="section">
      <span class="label">Your data</span>
      <ul class="lines">
        <li>
          <span class="grow">
            Backup
            <small class="faint" style={{ display: 'block', fontSize: '12.5px' }}>
              Everything, as one file. Restore it in Settings.
            </small>
          </span>
          <button class="link" onClick={() => share(`money-in-order-${stamp}.json`, JSON.stringify(ix.db), 'application/json')}>
            Save
          </button>
        </li>
        <li>
          <span class="grow">
            Transactions
            <small class="faint" style={{ display: 'block', fontSize: '12.5px' }}>
              CSV for spreadsheets
            </small>
          </span>
          <button class="link" onClick={() => share(`money-in-order-${stamp}.csv`, transactionsCSV(ix), 'text/csv')}>
            Save
          </button>
        </li>
      </ul>
    </div>
  )
}
