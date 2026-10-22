import { useEffect, useMemo, useState } from 'preact/hooks'
import { goalLine, goals, incomeBySource, roundPlan, same, spending, standouts, type MonthSpend } from '../lib/compare'
import { monthName, monthOf } from '../lib/dates'
import { claudeSummary } from '../lib/export'
import { savedLine, wealth } from '../lib/insights'
import { fmt } from '../lib/money'
import { setNote } from '../lib/store'
import type { ID } from '../lib/types'
import { WealthChart } from '../ui/charts'
import { useIndex } from '../ui/hooks'
import { toast } from '../ui/kit'
import { MonthStrip } from '../ui/monthstrip'
import { play } from '../ui/sound'
import '../ui/review.css'
import { SpentSheet } from './SpentSheet'

/** Rows shown before "Show all": enough for the big ones, short enough to take in at once. */
const FEW = 7

/** 1st, 2nd, 3rd, 4th … 22nd */
function ordinal(n: number): string {
  const k = n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10
  return `${n}${k === 1 ? 'st' : k === 2 ? 'nd' : k === 3 ? 'rd' : 'th'}`
}

export function Review(props: { today: string; month: string; setMonth: (m: string | ((prev: string) => string)) => void; onCount?: () => void }) {
  const ix = useIndex()
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const first = ix.months[0] ?? current
  const isCurrent = month === current

  const s = useMemo(() => spending(ix, month, today), [ix, month, today])
  const lines = useMemo(() => standouts(ix, s), [ix, s])
  const w = useMemo(() => wealth(ix, month, today), [ix, month, today])
  const saved = useMemo(() => savedLine(ix, month, today), [ix, month, today])
  const income = useMemo(() => incomeBySource(ix, month), [ix, month])
  const goalList = useMemo(() => goals(ix, month, today), [ix, month, today])
  const [spentCat, setSpentCat] = useState<ID | null>(null)
  const [all, setAll] = useState(false)
  const hasData = ix.months.includes(month)

  const compared = s.months.length > 0
  const by = isCurrent ? ` by the ${ordinal(s.day)}` : ''
  const max = Math.max(1, ...s.cats.map((c) => Math.max(c.spent, c.usual ?? 0)))
  const cut = s.cats.length > FEW + 1 && !all
  const cats = cut ? s.cats.slice(0, FEW) : s.cats
  const end = w?.points[w.points.length - 1]
  const period = !!w && w.points.length > 1
  const incomeMax = Math.max(1, ...income.map((r) => Math.max(r.amount, r.usual ?? 0)))

  return (
    <div>
      <div class="pagehead">
        <MonthStrip month={month} current={current} setMonth={props.setMonth} min={first < current ? first : current} max={current} at={5} />
      </div>

      {s.spent > 0 ? <Headline s={s} base={base} /> : isCurrent && <p class="empty">Log a few days of spending and this fills in.</p>}

      {lines.length > 0 && (
        <ul class="insights rv-lines">
          {lines.map((n) => (
            <li key={n.cat} class={n.tone}>
              {n.text}
            </li>
          ))}
        </ul>
      )}

      {s.cats.length > 0 && (
        <section class="card">
          <div class="card-head">
            <h2>Where it went</h2>
            {compared && <UsualKey text={`usual${by}`} />}
          </div>
          <div class="rv-rows">
            {cats.map((c) => {
              const t = tone(c.spent, c.usual, base, (diff) => (diff < 0 ? 'pos' : c.spent > c.planned ? 'neg' : 'muted'))
              return (
                <BarRow
                  key={c.id}
                  name={c.name}
                  amount={c.spent}
                  usual={c.usual}
                  max={max}
                  base={base}
                  diff={t}
                  onOpen={() => setSpentCat(c.id)}
                />
              )
            })}
          </div>
          {s.cats.length > FEW + 1 && (
            <button class="pill sm rv-more" onClick={() => setAll(!all)}>
              {all ? 'Fewer' : `All ${s.cats.length}`}
            </button>
          )}
        </section>
      )}

      {w && end && (
        <section class="card">
          <div class="card-head">
            <h2>Net worth</h2>
            {props.onCount && (
              <button class="pill sm" onClick={props.onCount}>
                Update balances
              </button>
            )}
          </div>
          <p class="rv-big">
            <span class="num marked">{fmt(end.total, base)}</span>
            {period && !same(w.change, end.total) && (
              <small class={`num ${w.change > 0 ? 'pos' : 'neg'}`}>
                {fmt(w.change, base, { sign: true })} since {monthName(w.points[0].month, { short: true, year: w.points[0].month.slice(0, 4) !== month.slice(0, 4) })}
              </small>
            )}
          </p>
          {period && <WealthChart points={w.points} base={base} />}
          {w.growth !== null && (
            <div class="rv-facts">
              <span>
                <small>Investments</small>
                <b class="num">{fmt(end.invest, base)}</b>
              </span>
              {period && (
                <span>
                  <small>Put in</small>
                  <b class="num">{fmt(w.added, base)}</b>
                </span>
              )}
              {period && (
                <span>
                  <small>Growth</small>
                  <b class={`num${same(w.growth, end.invest) ? '' : w.growth > 0 ? ' pos' : ' neg'}`}>{fmt(w.growth, base, { sign: true })}</b>
                </span>
              )}
            </div>
          )}
          {saved && (
            <ul class="insights rv-saved">
              <li class={saved.good ? 'good' : ''}>{saved.text}</li>
            </ul>
          )}
        </section>
      )}

      {income.length > 0 && (
        <section class="card">
          <div class="card-head">
            <h2>Income</h2>
            {compared && <UsualKey text="usual" />}
          </div>
          <div class="rv-rows">
            {income.map((r) => (
              <BarRow
                key={r.id ?? ''}
                name={r.name}
                amount={r.amount}
                usual={r.usual}
                max={incomeMax}
                base={base}
                diff={tone(r.amount, r.usual, base, (diff) => (diff > 0 ? 'pos' : 'muted'))}
              />
            ))}
          </div>
        </section>
      )}

      {goalList.length > 0 && (
        <section class="card">
          <h2>Goals</h2>
          <div class="goals">
            {goalList.map((g) => (
              <div class="goal" key={g.id}>
                <div class="goal-top">
                  <span class="goal-name">{g.name}</span>
                  <span class="num">
                    <span class={g.status === 'done' ? 'marked' : ''}>{fmt(g.saved, base)}</span>
                    <small> of {fmt(g.amount, base, { bare: true })}</small>
                  </span>
                </div>
                <div class="goal-bar" role="progressbar" aria-label={g.name} aria-valuemin={0} aria-valuemax={g.amount} aria-valuenow={g.saved}>
                  <i class={g.status} style={{ width: `${Math.min(100, (g.saved / g.amount) * 100).toFixed(1)}%` }} />
                </div>
                <small class={`goal-line${g.status === 'done' || g.status === 'on' ? ' pos' : ''}`}>{goalLine(g, base, month)}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {(hasData || !!ix.db.notes[month]?.text) && <Reflection month={month} />}

      {hasData && <AskClaude today={today} />}

      <SpentSheet cat={spentCat} month={month} today={today} onClose={() => setSpentCat(null)} />
    </div>
  )
}

/** The month in one sentence: what went out, and how that compares with the usual (or the plan, with no past yet). */
function Headline(props: { s: MonthSpend; base: string }) {
  const { s, base } = props
  const so = s.running ? ' so far' : ''
  let tail = null
  if (s.usual !== null) {
    const diff = s.spent - s.usual
    const by = s.running ? ` by the ${ordinal(s.day)}` : ''
    tail = same(diff, Math.max(s.spent, s.usual)) ? (
      <>, about usual{by}</>
    ) : (
      <>
        ,{' '}
        <span class={`num ${diff < 0 ? 'pos' : s.spent > s.planned ? 'neg' : ''}`}>{fmt(roundPlan(Math.abs(diff), 'near'), base)}</span>{' '}
        {diff < 0 ? 'less' : 'more'} than usual{by}
      </>
    )
  } else if (s.planned > 0) {
    tail = (
      <>
        {' '}
        of <span class="num">{fmt(s.planned, base)}</span> planned
      </>
    )
  }
  return (
    <p class="rv-head">
      <span class="num marked">{fmt(s.spent, base)}</span> spent{so}
      {tail}
    </p>
  )
}

interface Diff {
  word: string
  cls: string
}

/** The change against the usual under an amount: "+NT$1,200", "usual", or nothing with no usual to go on. */
function tone(amount: number, usual: number | null, base: string, cls: (diff: number) => string): Diff | null {
  if (usual === null) return null
  const diff = amount - usual
  if (same(diff, Math.max(amount, usual))) return { word: 'usual', cls: 'faint' }
  return { word: fmt(Math.round(diff / 100) * 100, base, { bare: true, sign: true }), cls: cls(diff) }
}

function UsualKey(props: { text: string }) {
  return (
    <span class="card-sub rv-key">
      <i aria-hidden="true" />
      {props.text}
    </span>
  )
}

/** A ranked row: name and amount over a bar, with a tick where the usual is. Tappable rows open what's behind them. */
function BarRow(props: {
  name: string
  amount: number
  usual: number | null
  max: number
  base: string
  diff: Diff | null
  onOpen?: () => void
}) {
  const { amount, usual, max, base, diff } = props
  const pct = (v: number) => `${Math.min(100, (Math.max(0, v) / max) * 100).toFixed(1)}%`
  const label = `${props.name}: ${fmt(amount, base)}${usual !== null ? `, usual ${fmt(usual, base)}` : ''}`
  const body = (
    <>
      <span class="rv-name">{props.name}</span>
      <span class="rv-amt num">
        {fmt(amount, base)}
        {diff && <small class={diff.cls}>{diff.word}</small>}
      </span>
      <span class="rv-track" aria-hidden="true">
        <i class="rv-fill" style={{ width: pct(amount) }} />
        {usual !== null && usual > 0 && <i class="rv-tick" style={{ left: pct(usual) }} />}
      </span>
    </>
  )
  return props.onOpen ? (
    <button class="rv-row" aria-label={label} onClick={props.onOpen}>
      {body}
    </button>
  ) : (
    <div class="rv-row" aria-label={label} role="group">
      {body}
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
