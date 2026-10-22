import { useMemo, useState } from 'preact/hooks'
import { balances, netWorth } from '../lib/accounts'
import { monthView, type Index } from '../lib/budget'
import { goalLine, goals, groupSpending, incomeBySource, roundPlan, same, spending, standouts, usualSpending, type CatSpend, type MonthSpend } from '../lib/compare'
import { dayOfMonth, daysInMonth, monthDiff, monthName, monthOf } from '../lib/dates'
import { savedLine, savingsRate, wealth } from '../lib/insights'
import { fmt } from '../lib/money'
import { expectedIncome, forecast, MAX_AHEAD } from '../lib/plan'
import type { ID, Target } from '../lib/types'
import { NetWorthChart, REST, REST_ID, share, slicesOf, SpendDonut } from '../ui/charts'
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
  const [spentCat, setSpentCat] = useState<ID | null>(null)
  const [all, setAll] = useState(false)
  const [view, setView] = useKept('by', 'cats', VIEWS)
  const [openGroup, setOpenGroup] = useState<ID | null>(null)
  const [hot, setHot] = useState<string | null>(null)
  const [range, setRange] = useKept<Range>('range', 'All', RANGES)
  const hasData = ix.months.includes(month)

  // net worth over the chosen stretch, ending with the month shown
  const span = month >= first ? monthDiff(first, month) + 1 : 1
  const ranges = RANGES.filter((r) => (r === '1Y' ? span > 12 : r === '2Y' ? span > 24 : span > 12))
  const n = range === '1Y' ? 12 : range === '2Y' && span > 24 ? 24 : span
  const w = useMemo(() => wealth(ix, month, today, n), [ix, month, today, n])

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

      {s.spent > 0 ? <Headline s={s} base={base} /> : isCurrent && <p class="empty">Log a few days of spending and this fills in</p>}

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
        <section class="card rv-wide rv-where">
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
        <section class="card rv-wide">
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

      {hasData && <CopyForClaude today={today} />}

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

/** A target in a few words: "10,000 a month", "50,000 by 2027-06". */
function targetWords(t: Target, base: string): string {
  const amt = fmt(t.amount, base)
  if (t.kind === 'goal') return `${amt}${t.by ? ` by ${t.by}` : ''}`
  return `${amt} a month`
}

/**
 * Where things stand, as plain text: no question, no instructions. Just the figures that matter,
 * short enough to read at a glance and to paste into any chat.
 */
export function situationText(ix: Index, today: string): string {
  const base = ix.settings.base
  const f = (n: number) => fmt(n, base)
  const current = monthOf(today)
  const v = monthView(ix, current, current)
  const out: string[] = []

  out.push(`My budget as of ${today} (day ${dayOfMonth(today)} of ${daysInMonth(current)}). Amounts in ${base}.`)
  out.push('')
  out.push(`Ready to assign: ${f(v.readyToAssign)}`)
  const invest = balances(ix).reduce((sum, b) => sum + (b.acct.invest ? b.base : 0), 0)
  const worth = netWorth(ix)
  out.push(invest > 0 ? `Net worth: ${f(worth)} (cash ${f(worth - invest)}, investments ${f(invest)})` : `Net worth: ${f(worth)}`)
  const income = expectedIncome(ix, current)
  if (income > 0) out.push(`Typical income: ${f(income)} a month`)
  const ahead = forecast(ix, current).ahead
  if (ahead > 0) out.push(ahead >= MAX_AHEAD ? 'Covered over 2 years ahead' : `Covered ${ahead} ${ahead === 1 ? 'month' : 'months'} ahead`)
  out.push('')

  const rate = savingsRate(v)
  out.push(
    `${monthName(current, { year: true })} so far: income ${f(v.income)}, assigned ${f(v.assigned)}, spent ${f(v.spent)}, ` +
      `saved ${f(v.saved)}${rate !== null ? ` (${Math.round(rate * 100)}% of income)` : ''}`,
  )
  for (const g of v.groups) {
    const lines: string[] = []
    for (const c of g.cats) {
      const t = c.cat.target
      const spent = -c.activity
      if (!c.assigned && !spent && !t && !(c.cat.saving && c.available)) continue
      const parts = c.cat.saving
        ? [`${f(c.available)} saved`, ...(c.assigned ? [`${f(c.assigned)} added`] : [])]
        : [`assigned ${f(c.assigned)}`, `spent ${f(spent)}`]
      if (t) parts.push(`target ${targetWords(t, base)}`)
      lines.push(`- ${c.cat.name}: ${parts.join(', ')}`)
    }
    if (lines.length) out.push('', g.group.name, ...lines)
  }
  if (v.overspent.length) out.push('', `Overspent: ${v.overspent.map((c) => `${c.cat.name} ${f(c.available)}`).join(', ')}`)
  return out.join('\n')
}

/** Copies text with the clipboard API, or the old way where that's missing or refused (insecure page, older Safari). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(box)
    box.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      box.remove()
    }
  }
}

/** Puts the situation on the clipboard, ready to paste into Claude (or anywhere). Goes nowhere itself. */
function CopyForClaude(props: { today: string }) {
  const ix = useIndex()
  async function copy() {
    const ok = await copyText(situationText(ix, props.today))
    play(ok ? 'success' : 'error')
    toast(ok ? 'Copied' : 'Couldn’t copy')
  }
  return (
    <div class="claude">
      <button class="pill sm" onClick={copy}>
        Copy for Claude
      </button>
    </div>
  )
}
