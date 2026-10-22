import { useEffect, useMemo, useState } from 'preact/hooks'
import { agePoints, budgetAges } from '../lib/age'
import { goalLine, goals, groupSpending, incomeBySource, roundPlan, same, spending, standouts, usualSpending, type CatSpend, type MonthSpend } from '../lib/compare'
import { monthDiff, monthName, monthOf } from '../lib/dates'
import { claudeSummary } from '../lib/export'
import { savedLine, wealth } from '../lib/insights'
import { fmt } from '../lib/money'
import { setNote } from '../lib/store'
import type { ID } from '../lib/types'
import { NetWorthChart, REST, REST_ID, share, slicesOf, Spark, SpendDonut } from '../ui/charts'
import { useIndex } from '../ui/hooks'
import { IconChevron, toast } from '../ui/kit'
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

/** A choice remembered on this device only. */
function useKept<T extends string>(key: string, initial: T, valid: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`money-in-order/review/${key}`) as T | null
      return saved && valid.includes(saved) ? saved : initial
    } catch {
      return initial
    }
  })
  const set = (next: T) => {
    setV(next)
    try {
      localStorage.setItem(`money-in-order/review/${key}`, next)
    } catch {
      // storage blocked: remembered until the page closes
    }
  }
  return [v, set]
}

const VIEWS = ['cats', 'groups'] as const
const RANGES = ['1Y', '2Y', 'All'] as const
type Range = (typeof RANGES)[number]

export function Review(props: { today: string; month: string; setMonth: (m: string | ((prev: string) => string)) => void; onCount?: () => void }) {
  const ix = useIndex()
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const first = ix.months[0] ?? current
  const isCurrent = month === current

  const s = useMemo(() => spending(ix, month, today), [ix, month, today])
  const lines = useMemo(() => standouts(ix, s), [ix, s])
  const usual = useMemo(() => usualSpending(ix, month, today), [ix, month, today])
  const groups = useMemo(() => groupSpending(ix, s), [ix, s])
  const saved = useMemo(() => savedLine(ix, month, today), [ix, month, today])
  const income = useMemo(() => incomeBySource(ix, month), [ix, month])
  const goalList = useMemo(() => goals(ix, month, today), [ix, month, today])
  const spends = useMemo(() => budgetAges(ix), [ix])
  const [spentCat, setSpentCat] = useState<ID | null>(null)
  const [all, setAll] = useState(false)
  const [view, setView] = useKept('by', 'cats', VIEWS)
  const [openGroup, setOpenGroup] = useState<ID | null>(null)
  const [hot, setHot] = useState<string | null>(null)
  const [range, setRange] = useKept<Range>('range', 'All', RANGES)
  const hasData = ix.months.includes(month)

  // net worth and the age of money over the chosen stretch, ending with the month shown
  const span = month >= first ? monthDiff(first, month) + 1 : 1
  const ranges = RANGES.filter((r) => (r === '1Y' ? span > 12 : r === '2Y' ? span > 24 : span > 12))
  const n = range === '1Y' ? 12 : range === '2Y' && span > 24 ? 24 : span
  const w = useMemo(() => wealth(ix, month, today, n), [ix, month, today, n])
  const ages = useMemo(() => (w ? agePoints(spends, w.points.map((p) => p.month), today) : []), [spends, w, today])

  const groupView = view === 'groups' && groups.length > 1
  const { slices, colors, total } = useMemo(
    () => slicesOf(groupView ? groups.map((g) => ({ id: g.id, name: g.name, amount: g.spent })) : s.cats.map((c) => ({ id: c.id, name: c.name, amount: c.spent }))),
    [groupView, groups, s],
  )
  const rows = groupView ? groups : s.cats
  const cut = rows.length > FEW + 1 && !all
  const shown = cut ? rows.slice(0, FEW) : rows
  const top = Math.max(1, ...rows.map((r) => r.spent))
  const sliceOf = (id: ID) => (colors.get(id) === REST && slices.some((x) => x.id === REST_ID) ? REST_ID : id)
  const by = isCurrent ? ` by the ${ordinal(s.day)}` : ''
  const openSlice = (id: string) => {
    if (id === REST_ID) setAll(true)
    else if (groupView) setOpenGroup(openGroup === id ? null : id)
    else setSpentCat(id)
  }

  const end = w?.points[w.points.length - 1]
  const period = !!w && w.points.length > 1
  const invested = !!w && w.points.some((p) => p.invest > 0)
  const incomeMax = Math.max(1, ...income.map((r) => Math.max(r.amount, r.usual ?? 0)))
  const since = (m: string) => monthName(m, { short: true, year: m.slice(0, 4) !== month.slice(0, 4) })

  return (
    <div>
      <div class="pagehead">
        <MonthStrip month={month} current={current} setMonth={props.setMonth} min={first < current ? first : current} max={current} at={5} />
      </div>

      {s.spent > 0 ? <Headline s={s} base={base} /> : isCurrent && <p class="empty">Log a few days of spending and this fills in.</p>}

      {usual && usual.month > 0 && (
        <div class="rv-facts rv-usual">
          <span>
            <small>Usual day</small>
            <b class="num">{fmt(roundPlan(usual.day, 'near'), base)}</b>
          </span>
          <span>
            <small>Usual month</small>
            <b class="num">{fmt(roundPlan(usual.month, 'near'), base)}</b>
          </span>
        </div>
      )}

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
        <section class="card rv-where">
          <div class="card-head">
            <h2>Where it went</h2>
            {groups.length > 1 && (
              <div class="pills rv-pick" role="group" aria-label="Show by">
                <button class="pill sm" aria-pressed={!groupView} onClick={() => setView('cats')}>
                  Categories
                </button>
                <button class="pill sm" aria-pressed={groupView} onClick={() => setView('groups')}>
                  Groups
                </button>
              </div>
            )}
          </div>
          <div class={`rv-split${total > 0 ? '' : ' flat'}`}>
            {total > 0 && <SpendDonut slices={slices} total={total} base={base} hot={hot} onHot={setHot} onOpen={openSlice} />}
            <div class="rv-rows" onPointerLeave={() => setHot(null)}>
              {shown.map((r) => {
                const color = colors.get(r.id) ?? REST
                const row = { name: r.name, amount: r.spent, share: total > 0 && r.spent > 0 ? r.spent / total : null, color, top, base, hot: !!hot && sliceOf(r.id) === hot }
                const onHot = () => setHot(sliceOf(r.id))
                if (!groupView) {
                  const c = r as CatSpend
                  return <SpendRow key={r.id} {...row} diff={catDiff(c, base, by)} onHot={onHot} onOpen={() => setSpentCat(r.id)} />
                }
                const g = groups.find((x) => x.id === r.id)!
                const open = openGroup === g.id
                return (
                  <div key={g.id} class={open ? 'rv-group open' : 'rv-group'}>
                    <SpendRow {...row} diff={diff(g.spent, g.usual, base, by, () => 'muted')} onHot={onHot} expanded={open} onOpen={() => setOpenGroup(open ? null : g.id)} />
                    {open &&
                      g.cats.map((c) => (
                        <SpendRow
                          key={c.id}
                          child
                          name={c.name}
                          amount={c.spent}
                          share={total > 0 && c.spent > 0 ? c.spent / total : null}
                          color={color}
                          top={top}
                          base={base}
                          hot={false}
                          diff={catDiff(c, base, by)}
                          onHot={onHot}
                          onOpen={() => setSpentCat(c.id)}
                        />
                      ))}
                  </div>
                )
              })}
              {rows.length > FEW + 1 && (
                <button class="pill sm rv-more" onClick={() => setAll(!all)}>
                  {all ? 'Fewer' : `All ${rows.length}`}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {w && end && (
        <section class="card">
          <div class="card-head">
            <h2>Net worth</h2>
            {ranges.length > 1 && (
              <div class="pills rv-pick" role="group" aria-label="Over">
                {ranges.map((r) => (
                  <button key={r} class="pill sm" aria-pressed={r === range || (r === 'All' && !ranges.includes(range))} onClick={() => setRange(r)}>
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p class="rv-big">
            <span class="num marked">{fmt(end.total, base)}</span>
            {period && !same(w.change, end.total) && (
              <small class={`num ${w.change > 0 ? 'pos' : 'neg'}`}>
                {fmt(w.change, base, { sign: true })}
                {w.points[0].total > 0 && ` · ${w.change > 0 ? '+' : '−'}${Math.round((Math.abs(w.change) / w.points[0].total) * 100)}%`}
                <span class="rv-since"> since {since(w.points[0].month)}</span>
              </small>
            )}
          </p>
          {period && <NetWorthChart points={w.points} base={base} />}
          {invested && (
            <div class="rv-facts">
              <span>
                <small>
                  <i class="rv-sw cash" aria-hidden="true" />
                  Cash
                </small>
                <b class="num">{fmt(end.cash, base)}</b>
              </span>
              <span>
                <small>
                  <i class="rv-sw invest" aria-hidden="true" />
                  Investments
                </small>
                <b class="num">{fmt(end.invest, base)}</b>
              </span>
              {period && (
                <span>
                  <small>Put in</small>
                  <b class="num">{fmt(w.added, base)}</b>
                </span>
              )}
              {period && w.growth !== null && (
                <span>
                  <small>Growth</small>
                  <b class={`num${same(w.growth, end.invest) ? '' : w.growth > 0 ? ' pos' : ' neg'}`}>{fmt(w.growth, base, { sign: true })}</b>
                </span>
              )}
            </div>
          )}
          {(saved || props.onCount) && (
            <div class="rv-foot">
              {saved && (
                <ul class="insights rv-saved">
                  <li class={saved.good ? 'good' : ''}>{saved.text}</li>
                </ul>
              )}
              {props.onCount && (
                <button class="pill sm" onClick={props.onCount}>
                  Update balances
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <AgeCard points={ages} month={month} isCurrent={isCurrent} since={since} />

      {income.length > 0 && (
        <section class="card">
          <div class="card-head">
            <h2>Income</h2>
            {s.months.length > 0 && <UsualKey text="usual" />}
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
  /** the same in words, for screen readers */
  said?: string
}

/** The change against the usual under an amount: "+NT$1,200", "usual", or nothing with no usual to go on. */
function tone(amount: number, usual: number | null, base: string, cls: (diff: number) => string): Diff | null {
  if (usual === null) return null
  const diff = amount - usual
  if (same(diff, Math.max(amount, usual))) return { word: 'usual', cls: 'faint' }
  return { word: fmt(Math.round(diff / 100) * 100, base, { bare: true, sign: true }), cls: cls(diff) }
}

/** A change against the usual worth a glance (a tenth of the amount or more), or nothing. */
function diff(amount: number, usual: number | null, base: string, by: string, cls: (diff: number) => string): Diff | null {
  if (usual === null) return null
  const d = amount - usual
  if (same(d, Math.max(amount, usual)) || Math.abs(d) < Math.max(amount, usual) * 0.1) return null
  const word = `${fmt(Math.round(d / 100) * 100, base, { bare: true, sign: true })} vs usual`
  return { word, cls: cls(d), said: `${fmt(Math.abs(Math.round(d / 100) * 100), base)} ${d < 0 ? 'less' : 'more'} than usual${by}` }
}

const catDiff = (c: CatSpend, base: string, by: string) => diff(c.spent, c.usual, base, by, (d) => (d < 0 ? 'pos' : c.spent > c.planned ? 'neg' : 'muted'))

/**
 * A row of the breakdown: name, amount and share, with a bar in the slice's colour under the name.
 * A group's row opens its categories; a category's opens what the money went on.
 */
function SpendRow(props: {
  name: string
  amount: number
  share: number | null
  color: string
  top: number
  base: string
  diff: Diff | null
  hot: boolean
  child?: boolean
  expanded?: boolean
  onHot: () => void
  onOpen: () => void
}) {
  const { amount, base, diff } = props
  const width = `${Math.min(100, (Math.max(0, amount) / props.top) * 100).toFixed(1)}%`
  const label = `${props.name}: ${fmt(amount, base)}${props.share !== null ? `, ${share(props.share)}` : ''}${diff?.said ? `, ${diff.said}` : ''}`
  return (
    <button
      class={`rv-row rv-spend${props.child ? ' child' : ''}${props.hot ? ' hot' : ''}`}
      style={{ '--c': props.color }}
      aria-label={label}
      aria-expanded={props.expanded}
      onClick={props.onOpen}
      onPointerEnter={(e) => e.pointerType === 'mouse' && props.onHot()}
    >
      <span class="rv-name">
        {props.name}
        {props.expanded !== undefined && <IconChevron dir="down" />}
      </span>
      <span class="rv-amt num">{fmt(amount, base)}</span>
      <span class="rv-pct num">{props.share !== null ? share(props.share) : ''}</span>
      <span class="rv-bar" aria-hidden="true">
        <i style={{ width }} />
      </span>
      {diff && <small class={`rv-diff num ${diff.cls}`}>{diff.word}</small>}
    </button>
  )
}

/**
 * How long money sits between coming in and going out, at the end of the month shown (or today),
 * with its trend over the same stretch as net worth and one line on what it means.
 */
function AgeCard(props: { points: { month: string; days: number | null }[]; month: string; isCurrent: boolean; since: (m: string) => string }) {
  const { points } = props
  const now = points[points.length - 1]?.days
  if (now === null || now === undefined) return null
  const known = points.filter((p) => p.days !== null)
  const from = known[0]
  const change = known.length > 1 ? now - from.days! : 0
  const days = (d: number) => `${d} ${d === 1 ? 'day' : 'days'}`
  // (No "months ahead" here: Plan's "Covered N months ahead" is that figure, and two would disagree.)
  const line = props.isCurrent
    ? `Money you spend today came in ${days(now)} ago.`
    : `Money spent at the end of ${monthName(props.month)} had come in ${days(now)} before.`
  return (
    <section class="card rv-age">
      <h2>Age of money</h2>
      <div class="rv-age-body">
        <p class="rv-big">
          <span>
            <span class="num">{now}</span>
            <span class="rv-unit"> {now === 1 ? 'day' : 'days'}</span>
          </span>
          {change !== 0 && (
            <small class={`num ${change > 0 ? 'pos' : 'muted'}`}>
              {change > 0 ? '+' : '−'}
              {Math.abs(change)} since {props.since(from.month)}
            </small>
          )}
        </p>
        {known.length > 1 && <Spark values={points.map((p) => p.days)} label={`Age of money from ${days(from.days!)} to ${days(now)}`} />}
      </div>
      <p class="rv-age-line">{line}</p>
    </section>
  )
}

function UsualKey(props: { text: string }) {
  return (
    <span class="card-sub rv-key">
      <i aria-hidden="true" />
      {props.text}
    </span>
  )
}

/** A ranked row: name and amount over a bar, with a tick where the usual is. */
function BarRow(props: { name: string; amount: number; usual: number | null; max: number; base: string; diff: Diff | null }) {
  const { amount, usual, max, base, diff } = props
  const pct = (v: number) => `${Math.min(100, (Math.max(0, v) / max) * 100).toFixed(1)}%`
  const label = `${props.name}: ${fmt(amount, base)}${usual !== null ? `, usual ${fmt(usual, base)}` : ''}`
  return (
    <div class="rv-row" aria-label={label} role="group">
      <span class="rv-name">{props.name}</span>
      <span class="rv-amt num">
        {fmt(amount, base)}
        {diff && <small class={diff.cls}>{diff.word}</small>}
      </span>
      <span class="rv-track" aria-hidden="true">
        <i class="rv-fill" style={{ width: pct(amount) }} />
        {usual !== null && usual > 0 && <i class="rv-tick" style={{ left: pct(usual) }} />}
      </span>
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
