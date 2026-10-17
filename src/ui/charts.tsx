// Small, quiet SVG charts for Review. Thin marks, hairline grid, one axis, ink-colored text.
// Pointer over a chart (or tap-and-drag on touch, or arrow keys when focused) shows a readout.

import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { addDays, addMonths, dateLabel, dayOfMonth, monthName } from '../lib/dates'
import type { Burn, DayPoint, MonthPoint, WeekPoint } from '../lib/insights'
import { fmt } from '../lib/money'
import './charts.css'

// ---------------------------------------------------------------- shared

let seq = 0
function useUid(prefix: string): string {
  return useMemo(() => `${prefix}${++seq}`, [])
}

/** 1234500 (minor) -> "12k". Bare amounts for axis labels. */
function compact(minor: number): string {
  const v = Math.abs(minor) / 100
  const sign = minor < 0 ? '−' : ''
  const short = (x: number, unit: string) => sign + (x >= 100 || Number.isInteger(x) ? Math.round(x) : Math.round(x * 10) / 10) + unit
  if (v >= 1e6) return short(v / 1e6, 'M')
  if (v >= 1e3) return short(v / 1e3, 'k')
  return sign + Math.round(v)
}

/** A y-axis with 2–3 round gridlines above zero and a little headroom over `max`. */
function axis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 100, ticks: [] }
  const top = max * 1.12
  const raw = top / 3
  const mag = 10 ** Math.floor(Math.log10(raw))
  // three round gridlines when a round step allows it, otherwise the fewest (two)
  let three = 0
  let two = 0
  for (const k of [mag / 10, mag, mag * 10]) {
    for (const f of [1, 2, 2.5, 5]) {
      const s = Math.max(100, f * k)
      const count = Math.floor(top / s)
      if (count === 3 && s > three) three = s
      if (count >= 2 && s > two) two = s
    }
  }
  const step = three || two || Math.max(100, raw)
  const ticks: number[] = []
  for (let v = step; v <= top + 1e-9; v += step) ticks.push(v)
  return { top, ticks }
}

/** Room on the right for y labels: 11px column voice, Recursive mono ≈ 0.6em per character. */
const gutterFor = (ticks: number[]) => 10 + Math.max(2, ...ticks.map((t) => compact(t).length)) * 6.7

function useWidth(ref: { current: HTMLElement | null }): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(Math.round(el.clientWidth))
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width)
      setW((prev) => (prev === next ? prev : next))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return w
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Pointer, touch and keyboard scrubbing over a chart.
 * Mouse: hover shows, leaving hides. Touch: press or drag scrubs, and the readout stays until you tap elsewhere.
 * Keyboard: focus shows the readout, ← → move it, Escape hides it.
 */
function useScrub(n: number, indexAt: (px: number) => number, start: () => number) {
  const ref = useRef<HTMLDivElement>(null)
  const [i, setI] = useState<number | null>(null)
  const pinned = useRef(false)
  const showing = i !== null

  useEffect(() => {
    if (!showing || !pinned.current) return
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        pinned.current = false
        setI(null)
      }
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [showing])

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return clamp(indexAt(e.clientX - r.left), 0, n - 1)
  }

  const handlers = {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType !== 'mouse') {
        pinned.current = true
        try {
          ref.current?.setPointerCapture(e.pointerId)
        } catch {
          /* not capturable: fine */
        }
      }
      setI(at(e))
    },
    onPointerMove(e: PointerEvent) {
      if (e.pointerType === 'mouse' || e.buttons || pinned.current) setI(at(e))
    },
    onPointerLeave(e: PointerEvent) {
      if (e.pointerType === 'mouse') setI(null)
    },
    onPointerCancel() {
      pinned.current = false
      setI(null)
    },
    onKeyDown(e: KeyboardEvent) {
      const cur = i ?? start()
      let next: number | null
      if (e.key === 'ArrowLeft') next = cur - 1
      else if (e.key === 'ArrowRight') next = cur + 1
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = n - 1
      else if (e.key === 'Escape' && i !== null) next = null
      else return
      e.preventDefault()
      e.stopPropagation()
      setI(next === null ? null : clamp(next, 0, n - 1))
    },
    onFocus(e: FocusEvent) {
      const el = e.currentTarget as HTMLElement
      if (el.matches(':focus-visible')) setI(start())
    },
    onBlur() {
      pinned.current = false
      setI(null)
    },
  }
  return { ref, i, setI, handlers }
}

interface Row {
  key: 'line' | 'dash' | 'bar' | 'ghost' | 'tick' | 'none'
  tone?: 'pen' | 'green' | 'red' | 'ink'
  value: string
  label: string
}

/** The readout card: values lead, labels follow, short strokes key the series. Stays inside the chart. */
function Tip(props: { x: number; w: number; title: string; rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const tw = el.offsetWidth
    const gap = 10
    let left: number
    if (props.x + gap + tw <= props.w) left = props.x + gap
    else if (props.x - gap - tw >= 0) left = props.x - gap - tw
    else left = clamp(props.x - tw / 2, 0, Math.max(0, props.w - tw))
    el.style.transform = `translateX(${Math.round(left)}px)`
    el.style.visibility = 'visible'
  })
  return (
    <div ref={ref} class="ch-tip" style={{ left: 0, visibility: 'hidden' }}>
      <div class="ch-tip-title">{props.title}</div>
      {props.rows.map((r) => (
        <div class="ch-tip-row" key={r.label}>
          <i class={`ch-key ${r.key} ${r.tone ?? ''}`} aria-hidden="true" />
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

/** "M x y L ..." through the points. */
function linePath(pts: [number, number][]): string {
  return pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

/** A bar with a 4px rounded top and a square foot on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0 || w <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`
}

/** Right-hand y labels and hairline gridlines. */
function Grid(props: { ticks: number[]; y: (v: number) => number; x0: number; x1: number; base: number; avoid?: number | null }) {
  const avoid = props.avoid
  return (
    <g>
      {props.ticks.map((t) => {
        const yy = Math.round(props.y(t)) + 0.5
        // a reference line (plan, average) close by takes this gridline's place
        if (avoid != null && Math.abs(yy - avoid) < 14) return null
        return (
          <g key={t}>
            <line class="ch-grid" x1={props.x0} x2={props.x1} y1={yy} y2={yy} />
            <text class="ch-t ch-num" x={props.x1 + 8} y={yy} dy="0.35em">
              {compact(t)}
            </text>
          </g>
        )
      })}
      <line class="ch-base" x1={props.x0} x2={props.x1} y1={props.base + 0.5} y2={props.base + 0.5} />
    </g>
  )
}

function SrTable(props: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <div class="ch-sr">
    <table>
      <caption>{props.caption}</caption>
      <thead>
        <tr>
          {props.head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, k) => (
          <tr key={k}>
            {r.map((c, j) => (j ? <td key={j}>{c}</td> : <th key={j} scope="row">{c}</th>))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}


/** Rough text widths at 11px, for keeping labels apart: the column voice is monospaced at 0.6em, print is a little narrower. */
const numW = (s: string) => s.length * 6.6
const wordW = (s: string) => s.length * 6.2

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/** The box of an 11px label whose baseline starts at (x, y). */
const textBox = (x: number, y: number, w: number): Box => ({ x, y: y - 9, w, h: 12 })
/** Does a polyline (points left to right) pass through a box, give or take `pad` pixels? */
function crosses(pts: [number, number][], r: Box, pad: number): boolean {
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1]
    const [bx, by] = pts[k]
    if (bx < r.x || ax > r.x + r.w) continue
    const at = (x: number) => (bx === ax ? ay : ay + ((by - ay) * (clamp(x, ax, bx) - ax)) / (bx - ax))
    const y1 = at(Math.max(ax, r.x))
    const y2 = at(Math.min(bx, r.x + r.w))
    if (Math.min(y1, y2) <= r.y + r.h + pad && Math.max(y1, y2) >= r.y - pad) return true
  }
  return false
}

// ---------------------------------------------------------------- burn: this month vs plan

const BURN_H = 170
const BURN_TOP = 18
const BURN_BOTTOM = 24

export function BurnChart(props: { burn: Burn; base: string }): JSX.Element {
  const b = props.burn
  const base = props.base
  const uid = useUid('burn')
  const days = Math.max(1, b.days)
  let last = -1
  b.actual.forEach((v, k) => v !== null && (last = k))
  const end = last >= 0 ? (b.actual[last] as number) : 0
  const proj = b.projected !== null && last >= 0 && last < days - 1 ? b.projected : null
  let max = Math.max(0, b.plan, proj ?? 0)
  for (const v of b.actual) if (v !== null && v > max) max = v
  for (const v of b.previous) if (v > max) max = v
  const ax = axis(max)
  const hasPlan = b.plan > 0
  const gutter = gutterFor(hasPlan ? [...ax.ticks, b.plan] : ax.ticks)

  const x0 = 1
  // indexAt runs on pointer events, after the geometry below exists
  const scrub = useScrub(
    days,
    (px) => Math.round((px - x0) / (Math.max(1, plotW) / Math.max(1, days - 1))),
    () => (last >= 0 ? last : days - 1),
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const plotW = x1 - x0
  const step = days > 1 ? plotW / (days - 1) : 0
  const X = (k: number) => x0 + k * step
  const baseY = BURN_H - BURN_BOTTOM
  const Y = (v: number) => BURN_TOP + (1 - v / ax.top) * (baseY - BURN_TOP)

  // The plan as a pace: the daily categories' share builds up evenly over the month,
  // the rest of the plan (bills, planned purchases) may go on any day.
  const lump = Math.max(0, b.plan - b.dailyPlan)
  const paceAt = (k: number) => lump + (Math.min(b.dailyPlan, b.plan) * (k + 1)) / days
  const flat = Math.abs(Y(paceAt(0)) - Y(b.plan)) < 1
  const planY = Math.round(Y(b.plan)) + 0.5
  const paceY0 = flat ? planY : Y(paceAt(0))
  const paceY1 = flat ? planY : Y(b.plan)
  const projAt = (k: number) => (proj === null ? 0 : end + ((proj - end) * (k - last)) / Math.max(1, days - 1 - last))

  const pts: [number, number][] = []
  for (let k = 0; k <= last; k++) pts.push([X(k), Y(b.actual[k] as number)])
  const prevPts: [number, number][] = b.previous.map((v, k) => [X(k), Y(v)])
  // red only past the whole month's plan: being ahead of the pace for a while is not overspending
  const over = hasPlan && b.actual.some((v) => v !== null && v > b.plan)
  const endOver = hasPlan && last >= 0 && end > b.plan
  const projOver = hasPlan && proj !== null && proj > b.plan
  const line = linePath(pts)
  const area = pts.length > 1 ? `${line}L${pts[pts.length - 1][0].toFixed(1)},${baseY}L${x0},${baseY}Z` : ''

  const ticks = [1, 8, 15, 22, days].filter((d, k, a) => d <= days && a.indexOf(d) === k && (d === days || days - d >= 4))
  const thisName = b.month ? monthName(b.month) : 'This month'
  const prevName = b.month ? monthName(addMonths(b.month, -1)) : 'last month'
  const shortMonth = b.month ? monthName(b.month, { short: true }) : ''

  // "plan" goes beside its own line where no other line runs through it: above the start, else at the end;
  // with no room anywhere it moves to the legend
  const pacePts: [number, number][] = [
    [x0, paceY0],
    [x1, paceY1],
  ]
  const lines: [number, number][][] = [pts, prevPts, ...(proj !== null && last >= 0 ? [[pts[last], [X(days - 1), Y(proj)]] as [number, number][]] : [])]
  let planWord: { x: number; y: number; anchor: 'start' | 'end'; box: Box } | null = null
  if (hasPlan && w > 0) {
    const pw = wordW('plan')
    const spots = [
      { x: x0 + 2, y: paceY0 - 5, anchor: 'start' as const, box: textBox(x0 + 2, paceY0 - 5, pw) },
      { x: x1 - 6, y: paceY1 - 6, anchor: 'end' as const, box: textBox(x1 - 6 - pw, paceY1 - 6, pw) },
      { x: x1 - 6, y: paceY1 + 14, anchor: 'end' as const, box: textBox(x1 - 6 - pw, paceY1 + 14, pw) },
      { x: x0 + 2, y: paceY0 + 14, anchor: 'start' as const, box: textBox(x0 + 2, paceY0 + 14, pw) },
    ]
    planWord =
      spots.find(
        (s) => s.box.y >= 0 && s.box.y + s.box.h <= baseY - 2 && !crosses(pacePts, s.box, 0) && !lines.some((l) => crosses(l, s.box, 2)),
      ) ?? null
  }

  const i = scrub.i
  let tip: JSX.Element | null = null
  if (i !== null && w > 0) {
    const a = b.actual[i]
    const rows: Row[] = []
    const has = a !== null && a !== undefined
    if (has) rows.push({ key: 'line', tone: hasPlan && a > b.plan ? 'red' : 'pen', value: fmt(a, base), label: 'spent' })
    else if (proj !== null && i > last) rows.push({ key: 'dash', tone: projOver ? 'red' : 'pen', value: fmt(Math.round(projAt(i)), base), label: 'at this pace' })
    if (b.previous.length) rows.push({ key: 'dash', value: fmt(b.previous[i], base), label: `same point in ${prevName}` })
    if (hasPlan && has)
      rows.push(a <= b.plan ? { key: 'none', value: fmt(b.plan - a, base), label: 'left of plan' } : { key: 'none', value: fmt(a - b.plan, base), label: 'over plan' })
    else if (hasPlan) rows.push({ key: 'none', value: fmt(b.plan, base), label: 'plan' })
    const title = b.today !== null && b.today === i + 1 ? 'Today' : shortMonth ? `${shortMonth} ${i + 1}` : `Day ${i + 1}`
    tip = <Tip x={X(i)} w={w} title={title} rows={rows} />
  }

  // direct label for where the line ends: beside the dot, clear of the plan labels and inside the chart
  let endLabel: JSX.Element | null = null
  let showPlanWord = !!planWord
  if (last >= 0 && end > 0 && i === null && w > 0) {
    const text = fmt(end, base)
    const tw = numW(text)
    const [ex, ey] = pts[last]
    const avoid: Box[] = []
    if (planWord) avoid.push(planWord.box)
    if (hasPlan) avoid.push({ x: x1 + 4, y: planY - 8, w: w - x1, h: 16 })
    const spots = [
      { x: ex - 8 - tw, y: ey - 9 },
      { x: ex - 8 - tw, y: ey + 17 },
      { x: ex + 8, y: ey - 9 },
      { x: ex + 8, y: ey + 17 },
    ]
    const inside = (s: { x: number; y: number }) => ({ x: clamp(s.x, 0, Math.max(0, w - tw)), y: clamp(s.y, 11, baseY - 4) })
    // nor across the plan line
    const clear = (s: { x: number; y: number }) => {
      const r = textBox(s.x, s.y, tw)
      return !avoid.some((o) => overlaps(r, o)) && !(hasPlan && crosses(pacePts, r, 3))
    }
    const spot =
      spots.find((s) => s.x >= 0 && s.x + tw <= w && s.y - 9 >= 0 && s.y + 3 <= baseY - 2 && clear(s)) ??
      spots.map(inside).find(clear) ??
      inside(spots[0])
    // when nothing is clear the amount wins over the word "plan" (its value stays in the margin)
    if (planWord && overlaps(textBox(spot.x, spot.y, tw), planWord.box)) showPlanWord = false
    endLabel = (
      <text class="ch-t ch-num ch-end ch-halo ch-late" x={spot.x} y={spot.y}>
        {text}
      </text>
    )
  }

  const summary =
    last >= 0
      ? `${thisName}: ${fmt(end, base)} spent${hasPlan ? ` of a ${fmt(b.plan, base)} plan` : ''}${b.today ? ` by day ${b.today}` : ''}` +
        `${proj !== null ? `; at this pace about ${fmt(Math.round(proj / 10000) * 10000, base)} by the end` : ''}.`
      : `${thisName}: nothing spent yet.`

  return (
    <div class="ch">
      <div
        ref={scrub.ref}
        class="ch-plot"
        style={{ height: `${BURN_H}px` }}
        tabIndex={0}
        role="group"
        aria-label={summary}
        {...scrub.handlers}
      >
        {w > 0 && (
          <svg width={w} height={BURN_H} viewBox={`0 0 ${w} ${BURN_H}`} aria-hidden="true">
            <defs>
              <clipPath id={`${uid}-lo`}>
                <rect x="0" y={planY} width={w} height={BURN_H} />
              </clipPath>
              <clipPath id={`${uid}-hi`}>
                <rect x="0" y="-10" width={w} height={planY + 10} />
              </clipPath>
            </defs>
            <Grid ticks={ax.ticks} y={Y} x0={x0} x1={x1} base={baseY} avoid={hasPlan ? planY : null} />
            {ticks.map((d) => (
              <text
                key={d}
                class={`ch-t ch-num${b.today === d ? ' ch-strong' : ''}`}
                x={X(d - 1)}
                y={BURN_H - 6}
                text-anchor={d === 1 ? 'start' : d === days ? 'end' : 'middle'}
              >
                {d}
              </text>
            ))}
            {hasPlan && (
              <g>
                <line class={flat ? 'ch-plan' : 'ch-pace'} x1={x0} x2={x1} y1={paceY0} y2={paceY1} />
                {planWord && showPlanWord && (
                  <text class="ch-t ch-word ch-plan-label ch-halo" x={planWord.x} y={planWord.y} text-anchor={planWord.anchor}>
                    plan
                  </text>
                )}
                <text class="ch-t ch-num ch-strong" x={x1 + 8} y={planY} dy="0.35em">
                  {compact(b.plan)}
                </text>
              </g>
            )}
            <g key={`${b.month}|${days}`}>
              {prevPts.length > 1 && <path class="ch-prev ch-fade" d={linePath(prevPts)} />}
              {area && (
                <>
                  <path class="ch-area ch-fade" d={area} clip-path={over ? `url(#${uid}-lo)` : undefined} />
                  {over && <path class="ch-area over ch-fade" d={area} clip-path={`url(#${uid}-hi)`} />}
                </>
              )}
              {proj !== null && (
                <path class={`ch-proj ch-late${projOver ? ' over' : ''}`} d={linePath([pts[last], [X(days - 1), Y(proj)]])} />
              )}
              {pts.length > 1 && (
                <>
                  <path class="ch-line ch-draw" d={line} pathLength={1} clip-path={over ? `url(#${uid}-lo)` : undefined} />
                  {over && <path class="ch-line over ch-draw" d={line} pathLength={1} clip-path={`url(#${uid}-hi)`} />}
                </>
              )}
              {last >= 0 && <circle class={`ch-dot ch-pop${endOver ? ' over' : ''}`} cx={pts[last][0]} cy={pts[last][1]} r={4} />}
            </g>
            {endLabel}
            {i !== null && (
              <g class="ch-hover">
                <line class="ch-guide" x1={Math.round(X(i)) + 0.5} x2={Math.round(X(i)) + 0.5} y1={BURN_TOP - 8} y2={baseY} />
                {b.previous.length > 0 && <circle class="ch-dot prev" cx={X(i)} cy={Y(b.previous[i])} r={3} />}
                {b.actual[i] !== null && b.actual[i] !== undefined ? (
                  <circle class={`ch-dot${hasPlan && (b.actual[i] as number) > b.plan ? ' over' : ''}`} cx={X(i)} cy={Y(b.actual[i] as number)} r={4} />
                ) : (
                  proj !== null && i > last && <circle class={`ch-dot proj${projOver ? ' over' : ''}`} cx={X(i)} cy={Y(projAt(i))} r={3} />
                )}
              </g>
            )}
          </svg>
        )}
        {tip}
      </div>
      {(b.previous.length > 0 || proj !== null || (hasPlan && !showPlanWord)) && (
        <div class="ch-legend" aria-hidden="true">
          <span>
            <i class={`ch-key line ${endOver ? 'red' : 'pen'}`} />
            {thisName}
          </span>
          {proj !== null && (
            <span>
              <i class={`ch-key dash ${projOver ? 'red' : 'pen'}`} />
              at this pace
            </span>
          )}
          {b.previous.length > 0 && (
            <span>
              <i class="ch-key dash" />
              {prevName}
            </span>
          )}
          {hasPlan && !showPlanWord && (
            <span>
              <i class="ch-key" />
              plan
            </span>
          )}
        </div>
      )}
      <SrTable
        caption={summary}
        head={['Day', 'Spent', ...(b.previous.length ? [`Same point in ${prevName}`] : [])]}
        rows={b.actual.map((v, k) => [String(k + 1), v === null ? '' : fmt(v, base), ...(b.previous.length ? [fmt(b.previous[k], base)] : [])])}
      />
    </div>
  )
}

// ---------------------------------------------------------------- months

const BARS_TOP = 16

function monthLabel(month: string, current?: string) {
  const sameYear = !current || month.slice(0, 4) === current.slice(0, 4)
  return monthName(month, { year: !sameYear })
}

const ratePct = (r: number) => `${Math.round(r * 100)}%`

/**
 * Spending per month as bars inside an outline of the plan, income as a green tick and the share
 * of income saved under each month. A click or tap on a month opens it.
 */
export function MonthBars(props: {
  points: MonthPoint[]
  base: string
  current?: string
  /** the month shown on the page */
  selected?: string
  onSelect?: (month: string) => void
}): JSX.Element {
  const { points, base, current, selected, onSelect } = props
  const hasRates = points.some((p) => p.savingsRate !== null)
  const bottom = hasRates ? 38 : 24
  const H = 126 + bottom
  const uid = useUid('mb')
  const n = Math.max(1, points.length)
  let max = 0
  for (const p of points) max = Math.max(max, p.spent, p.income, p.planned)
  const ax = axis(max)
  const gutter = gutterFor(ax.ticks)
  const x0 = 0
  const scrub = useScrub(
    n,
    (px) => Math.floor((px - x0) / band),
    () => Math.max(0, points.findIndex((p) => p.month === selected)),
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const band = (x1 - x0) / n
  const bw = Math.min(24, Math.max(6, band * 0.42))
  const tw = Math.min(band * 0.8, bw + 14)
  const baseY = H - bottom
  const Y = (v: number) => BARS_TOP + (1 - v / ax.top) * (baseY - BARS_TOP)
  const hasIncome = points.some((p) => p.income > 0)
  const hasPlan = points.some((p) => p.planned > 0)
  const i = scrub.i
  // when month names would touch, label every other month (always the latest)
  const every = band < 30 ? 2 : 1

  let tip: JSX.Element | null = null
  if (i !== null && points[i] && w > 0) {
    const p = points[i]
    const rows: Row[] = [{ key: 'bar', tone: 'pen', value: fmt(p.spent, base), label: p.month === current ? 'spent so far' : 'spent' }]
    if (p.planned > 0) rows.push({ key: 'ghost', value: fmt(p.planned, base), label: 'plan' })
    if (p.income > 0) rows.push({ key: 'tick', tone: 'green', value: fmt(p.income, base), label: 'income' })
    if (p.savingsRate !== null) rows.push({ key: 'none', value: ratePct(p.savingsRate), label: 'of income saved' })
    else if (p.saved > 0) rows.push({ key: 'none', value: fmt(p.saved, base), label: 'set aside for savings' })
    tip = <Tip x={x0 + band * (i + 0.5)} w={w} title={monthLabel(p.month, current)} rows={rows} />
  }

  const pick = (e: MouseEvent) => {
    if (!onSelect || !scrub.ref.current) return
    const r = scrub.ref.current.getBoundingClientRect()
    const k = clamp(Math.floor((e.clientX - r.left - x0) / band), 0, n - 1)
    if (points[k] && e.clientX - r.left <= x1) onSelect(points[k].month)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && i !== null && onSelect && points[i]) {
      e.preventDefault()
      onSelect(points[i].month)
      return
    }
    scrub.handlers.onKeyDown(e)
  }

  const summary = points.length
    ? `Spending by month: ${points.map((p) => `${monthName(p.month, { short: true })} ${fmt(p.spent, base)}${p.planned > 0 ? ` of ${fmt(p.planned, base)} planned` : ''}`).join(', ')}.`
    : 'No months yet.'

  return (
    <div class="ch">
      <div
        ref={scrub.ref}
        class={`ch-plot${onSelect ? ' ch-click' : ''}`}
        style={{ height: `${H}px` }}
        tabIndex={0}
        role="group"
        aria-label={summary}
        {...scrub.handlers}
        onKeyDown={onKeyDown}
        onClick={pick}
      >
        {w > 0 && (
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
            <defs>
              <pattern id={`${uid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect class="ch-hatch-bg" width="4" height="4" />
                <rect class="ch-hatch-line" width="1.6" height="4" />
              </pattern>
            </defs>
            <Grid ticks={ax.ticks} y={Y} x0={x0} x1={x1} base={baseY} />
            {points.map((p, k) => {
              const cx = x0 + band * (k + 0.5)
              const h = Math.max(0, baseY - Y(Math.max(0, p.spent)))
              const ph = Math.max(0, baseY - Y(p.planned))
              const soFar = p.month === current
              const hot = i === k
              const sel = p.month === selected
              const labelled = hot || sel || (points.length - 1 - k) % every === 0
              return (
                <g key={p.month} class="ch-slot" style={{ transform: `translateX(${cx.toFixed(1)}px)` }}>
                  {ph > 0 && <path class="ch-ghost ch-fade" d={barPath(-bw / 2 - 3, baseY - ph, bw + 6, ph)} />}
                  {h > 0 && (
                    <path
                      class={`ch-bar ch-grow${hot ? ' hot' : ''}`}
                      style={{ animationDelay: `${k * 35}ms`, ...(soFar ? { fill: `url(#${uid}-hatch)` } : {}) }}
                      d={barPath(-bw / 2, baseY - Math.max(h, 2), bw, Math.max(h, 2))}
                    />
                  )}
                  {p.income > 0 && (
                    <line class="ch-income ch-fade" x1={-tw / 2} x2={tw / 2} y1={Y(p.income)} y2={Y(p.income)} />
                  )}
                  {labelled && (
                    <text class={`ch-t ch-word${sel ? ' ch-sel' : hot ? ' ch-strong' : ''}`} x={0} y={baseY + 18} text-anchor="middle">
                      {monthName(p.month, { short: true })}
                    </text>
                  )}
                  {labelled && p.savingsRate !== null && (
                    <text class="ch-t ch-num ch-saved" x={0} y={baseY + 32} text-anchor="middle">
                      {ratePct(p.savingsRate)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {tip}
      </div>
      {(hasIncome || hasPlan) && (
        <div class="ch-legend" aria-hidden="true">
          <span>
            <i class="ch-key bar pen" />
            Spent
          </span>
          {hasPlan && (
            <span>
              <i class="ch-key ghost" />
              Plan
            </span>
          )}
          {hasIncome && (
            <span>
              <i class="ch-key tick green" />
              Income
            </span>
          )}
          {hasRates && (
            <span>
              <i class="ch-key pct">%</i>
              Saved
            </span>
          )}
        </div>
      )}
      <SrTable
        caption="Spending, plan, income and savings by month"
        head={['Month', 'Spent', 'Plan', 'Income', 'Saved']}
        rows={points.map((p) => [
          monthLabel(p.month, current),
          fmt(p.spent, base),
          fmt(p.planned, base),
          fmt(p.income, base),
          p.savingsRate !== null ? ratePct(p.savingsRate) : p.saved > 0 ? fmt(p.saved, base) : '',
        ])}
      />
    </div>
  )
}

// ---------------------------------------------------------------- weeks and days

/**
 * Small bars with one reference line (an average, an allowance). The last bar may still be filling up:
 * it is hatched and never thinner than a few pixels. Labels go under the first bar, the one before last
 * and the last, in their long form when they fit.
 */
function RefBars(props: {
  values: number[]
  keys: string[]
  base: string
  line: { value: number; word: string } | null
  live: boolean
  first: string
  prev?: [string, string]
  last: [string, string]
  title: (k: number) => string
  rows: (k: number) => Row[]
  summary: string
  caption: string
  head: string[]
}): JSX.Element {
  const { values, base, line } = props
  const H = 116
  const top = 16
  const bottom = 24
  const uid = useUid('rb')
  const n = Math.max(1, values.length)
  let max = line ? line.value : 0
  for (const v of values) max = Math.max(max, v)
  const ax = { top: Math.max(1, max) * 1.08 }
  const gutter = line ? gutterFor([line.value]) : 0
  const x0 = 0
  const scrub = useScrub(
    n,
    (px) => Math.floor((px - x0) / band),
    () => n - 1,
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const band = (x1 - x0) / n
  const bw = Math.min(20, Math.max(5, band * 0.46))
  const baseY = H - bottom
  const Y = (v: number) => top + (1 - v / ax.top) * (baseY - top)
  const i = scrub.i
  const lineY = line ? Math.round(Y(line.value)) + 0.5 : null
  const cx = (k: number) => x0 + band * (k + 0.5)
  // the line's word sits on whichever end no bar reaches into (left by default)
  let word = { x: x0 + 2, anchor: 'start' as 'start' | 'end' }
  if (line && lineY !== null && w > 0) {
    const ww = wordW(line.word) + 4
    const clear = (from: number, to: number) =>
      values.every((v, k) => cx(k) + bw / 2 < from || cx(k) - bw / 2 > to || Y(Math.max(0, v)) > lineY - 3)
    if (!clear(x0, x0 + ww) && clear(x1 - 4 - ww, x1)) word = { x: x1 - 4, anchor: 'end' }
  }

  let tip: JSX.Element | null = null
  if (i !== null && i < values.length && w > 0) tip = <Tip x={cx(i)} w={w} title={props.title(i)} rows={props.rows(i)} />

  // labels: the last one centred under its bar (kept inside the chart), the one before it if there's room
  const labels: { x: number; text: string; anchor: 'start' | 'middle'; strong?: boolean }[] = []
  if (w > 0) {
    const pair = (k: 0 | 1) => {
      const lastText = props.last[k]
      const prevText = props.prev && n >= 2 ? props.prev[k] : ''
      const room = band - (wordW(lastText) + wordW(prevText)) / 2 - 8
      return { lastText, prevText, room }
    }
    let p = pair(1)
    if (p.room < 0) p = pair(0)
    const lastX = Math.min(cx(n - 1), w - wordW(p.lastText) / 2 - 1)
    labels.push({ x: lastX, text: p.lastText, anchor: 'middle', strong: true })
    let leftEdge = lastX - wordW(p.lastText) / 2
    if (p.prevText && p.room >= 0) {
      labels.push({ x: cx(n - 2), text: p.prevText, anchor: 'middle' })
      leftEdge = cx(n - 2) - wordW(p.prevText) / 2
    }
    const firstX = Math.max(0, cx(0) - bw / 2)
    if (n >= 3 && props.first && firstX + wordW(props.first) + 8 <= leftEdge) labels.push({ x: firstX, text: props.first, anchor: 'start' })
  }

  return (
    <div class="ch">
      <div ref={scrub.ref} class="ch-plot" style={{ height: `${H}px` }} tabIndex={0} role="group" aria-label={props.summary} {...scrub.handlers}>
        {w > 0 && (
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
            <defs>
              <pattern id={`${uid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect class="ch-hatch-bg" width="4" height="4" />
                <rect class="ch-hatch-line" width="1.6" height="4" />
              </pattern>
            </defs>
            <line class="ch-base" x1={x0} x2={x1} y1={baseY + 0.5} y2={baseY + 0.5} />
            {values.map((v, k) => {
              const live = props.live && k === n - 1
              let h = Math.max(0, baseY - Y(Math.max(0, v)))
              if (v > 0) h = Math.max(h, live ? 4 : 2)
              return (
                <g key={props.keys[k]} class="ch-slot" style={{ transform: `translateX(${cx(k).toFixed(1)}px)` }}>
                  {h > 0 && (
                    <path
                      class={`ch-bar ch-grow${i === k ? ' hot' : ''}`}
                      style={{ animationDelay: `${k * 30}ms`, ...(live ? { fill: `url(#${uid}-hatch)` } : {}) }}
                      d={barPath(-bw / 2, baseY - h, bw, h)}
                    />
                  )}
                </g>
              )
            })}
            {line && lineY !== null && (
              <g>
                <line class="ch-plan" x1={x0} x2={x1} y1={lineY} y2={lineY} />
                <text class="ch-t ch-word ch-plan-label ch-halo" x={word.x} y={lineY - 5} text-anchor={word.anchor}>
                  {line.word}
                </text>
                <text class="ch-t ch-num ch-strong" x={x1 + 8} y={lineY} dy="0.35em">
                  {compact(line.value)}
                </text>
              </g>
            )}
            {labels.map((l) => (
              <text key={l.text} class={`ch-t ch-word${l.strong ? ' ch-strong' : ''}`} x={l.x} y={H - 6} text-anchor={l.anchor}>
                {l.text}
              </text>
            ))}
          </svg>
        )}
        {tip}
      </div>
      <SrTable caption={props.caption} head={props.head} rows={values.map((v, k) => [props.title(k), fmt(v, base)])} />
    </div>
  )
}

function weekTitle(start: string, isLast: boolean): string {
  if (isLast) return 'This week'
  const end = addDays(start, 6)
  const m1 = monthName(start.slice(0, 7), { short: true })
  const m2 = monthName(end.slice(0, 7), { short: true })
  return m1 === m2 ? `${m1} ${dayOfMonth(start)}–${dayOfMonth(end)}` : `${m1} ${dayOfMonth(start)} – ${m2} ${dayOfMonth(end)}`
}

const dayShort = (date: string) => `${monthName(date.slice(0, 7), { short: true })} ${dayOfMonth(date)}`

/** Everyday spending per week, with the average of the finished weeks. */
export function WeekBars(props: { weeks: WeekPoint[]; base: string }): JSX.Element {
  const { weeks, base } = props
  const n = weeks.length
  const done = weeks.slice(0, -1)
  const avg = done.length >= 2 ? Math.round(done.reduce((s, w) => s + w.spent, 0) / done.length) : 0
  const title = (k: number) => weekTitle(weeks[k].start, k === n - 1)
  return (
    <RefBars
      values={weeks.map((w) => w.spent)}
      keys={weeks.map((w) => w.start)}
      base={base}
      line={avg > 0 ? { value: avg, word: 'average' } : null}
      live
      first={n > 1 ? dayShort(weeks[0].start) : ''}
      prev={['Last', 'Last week']}
      last={['Now', 'This week']}
      title={title}
      rows={(k) => {
        const rows: Row[] = [{ key: 'bar', tone: 'pen', value: fmt(weeks[k].spent, base), label: k === n - 1 ? 'so far' : 'spent' }]
        if (avg > 0) rows.push({ key: 'none', value: fmt(avg, base), label: 'average' })
        return rows
      }}
      summary={`Everyday spending by week: ${weeks.map((wk, k) => `${title(k)} ${fmt(wk.spent, base)}`).join(', ')}.`}
      caption="Everyday spending by week"
      head={['Week', 'Spent']}
    />
  )
}

/** Spending in the daily categories per day, against what a day can take now (Today's figure). */
export function DayBars(props: { days: DayPoint[]; allowance: number | null; base: string; today: string }): JSX.Element {
  const { days, allowance, base, today } = props
  const title = (k: number) => (days[k].date === today ? 'Today' : dateLabel(days[k].date, today))
  const line = allowance !== null && allowance > 0 ? { value: allowance, word: 'allowance' } : null
  return (
    <RefBars
      values={days.map((d) => d.spent)}
      keys={days.map((d) => d.date)}
      base={base}
      line={line}
      live={days[days.length - 1]?.date === today}
      first={days.length > 1 ? dayShort(days[0].date) : ''}
      last={['Today', 'Today']}
      title={title}
      rows={(k) => {
        const rows: Row[] = [{ key: 'bar', tone: 'pen', value: fmt(days[k].spent, base), label: days[k].date === today ? 'so far' : 'spent' }]
        if (line) rows.push({ key: 'none', value: fmt(line.value, base), label: 'allowance' })
        return rows
      }}
      summary={`Daily spending: ${days.map((d, k) => `${title(k)} ${fmt(d.spent, base)}`).join(', ')}${line ? `. ${fmt(line.value, base)} a day keeps to the plan` : ''}.`}
      caption="Daily spending"
      head={['Day', 'Spent']}
    />
  )
}

// ---------------------------------------------------------------- sparkline

/** A month-by-month trend line. Nothing to draw with fewer than two months. */
export function Sparkline(props: { values: number[]; highlightLast?: boolean; width?: number; height?: number }): JSX.Element {
  const W = props.width ?? 72
  const H = props.height ?? 22
  const vals = props.values
  if (vals.length < 2) return <svg class="ch-spark" width={W} height={H} aria-hidden="true" />
  const pad = props.highlightLast ? 4 : 1.5
  let lo = 0
  let hi = 0
  for (const v of vals) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const span = hi - lo || 1
  const X = (k: number) => pad + (k * (W - 2 * pad)) / (vals.length - 1)
  const Y = (v: number) => H - pad - ((v - lo) / span) * (H - 2 * pad)
  const pts: [number, number][] = vals.map((v, k) => [X(k), Y(v)])
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg class="ch-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <path d={linePath(pts)} />
      {props.highlightLast && <circle cx={lx} cy={ly} r={2.75} />}
    </svg>
  )
}
