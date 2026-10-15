import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { daily, monthView } from '../lib/budget'
import { dayOfMonth, daysInMonth, monthOf } from '../lib/dates'
import { cur, fmt, keypadToMinor, parseAmount } from '../lib/money'
import { currenciesInUse } from '../lib/rates'
import { addTxn, getIndex, toBase, undoable } from '../lib/store'
import { RTA, type ID } from '../lib/types'
import { DatePill } from '../ui/calendar'
import { useIndex, useMedia } from '../ui/hooks'
import { Keypad, NoteField, toast } from '../ui/kit'
import { flash, useCountUp } from '../ui/motion'
import { haptic, play } from '../ui/sound'

// The draft lives outside the component so it survives switching tabs, and undo can put it back.
interface Draft {
  digits: string
  currency: string | null
  note: string
  date: string | null
}
let draft: Draft = { digits: '', currency: null, note: '', date: null }
const draftListeners = new Set<() => void>()
function setDraft(next: Partial<Draft>) {
  draft = { ...draft, ...next }
  for (const fn of draftListeners) fn()
}
function useDraft(): Draft {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    draftListeners.add(fn)
    return () => {
      draftListeners.delete(fn)
    }
  }, [])
  return draft
}

export function Today(props: { today: string; onPlan: () => void }) {
  const ix = useIndex()
  const { today } = props
  const base = ix.settings.base
  const month = monthOf(today)
  const view = useMemo(() => monthView(ix, month, month), [ix, month])
  const d = useMemo(() => daily(ix, view, today), [ix, view, today])
  const touch = useMedia('(pointer: coarse)')

  const planFirst = d && d.monthBudget <= 0 && d.available <= 0 && d.monthSpent === 0
  const monthOver = d && d.available < 0 && d.allowance === 0
  const heroValue = d ? (monthOver ? d.available : d.leftToday) : 0
  const shown = useCountUp(heroValue)

  return (
    <div class="today">
      <section class="hero">
        {!d ? null : planFirst ? (
          <>
            <div class="hero-num" style={{ fontSize: 'clamp(36px, 10vw, 52px)' }}>
              Plan first
            </div>
            <div class="hero-cap">Give {d.cats.map((c) => c.name).join(' + ')} money for the month to see what's left each day.</div>
            <button class="btn plan-first" onClick={props.onPlan}>
              Open the plan
            </button>
          </>
        ) : (
          <>
            <div class={`hero-num${heroValue < 0 ? ' neg' : ''}`}>
              <span class={`marked${heroValue < 0 ? ' neg' : ''}`}>{fmt(Math.abs(shown), base)}</span>
            </div>
            <div class="hero-cap">{monthOver ? `over for the month in ${d.cats.map((c) => c.name).join(' + ')}` : heroValue < 0 ? 'over today' : 'left for today'}</div>
          </>
        )}
        <Ruler today={today} />
      </section>
      <Register today={today} touch={touch} />
    </div>
  )
}

function Ruler(props: { today: string }) {
  const month = monthOf(props.today)
  const dim = daysInMonth(month)
  const dom = dayOfMonth(props.today)
  const [y, m, dd] = props.today.split('-').map(Number)
  const wd = new Date(y, m - 1, dd).toLocaleDateString('en-US', { weekday: 'short' })
  const pos = dim > 1 ? ((dom - 1) / (dim - 1)) * 100 : 0
  return (
    <div class="ruler" aria-label={`Day ${dom} of ${dim}`}>
      <div class="ruler-ticks" aria-hidden="true">
        {Array.from({ length: dim }, (_, i) => (
          <i key={i} class={i + 1 < dom ? 'past' : i + 1 === dom ? 'now' : ''} />
        ))}
      </div>
      <span class="ruler-label" style={{ left: `clamp(16px, ${pos}%, calc(100% - 16px))` }}>
        {wd} {dom}
      </span>
    </div>
  )
}

/** Type the amount, tap where it went. On phones a keypad; on laptops the keyboard. */
export function Register(props: { today: string; touch: boolean }) {
  const ix = useIndex()
  const { today, touch } = props
  const base = ix.settings.base
  const dr = useDraft()
  const currency = dr.currency ?? base
  const date = dr.date ?? today
  const c = cur(currency)
  const amount = touch ? keypadToMinor(dr.digits) : Math.abs(parseAmount(dr.digits) ?? 0)
  const amountBase = currency === base ? amount : toBase(amount, currency)
  const currencies = currenciesInUse()
  const amountRef = useRef<HTMLInputElement>(null)
  const amountBox = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const month = monthOf(date)
  const view = useMemo(() => monthView(ix, month, monthOf(today)), [ix, month, today])
  const dd = useMemo(() => (date === today ? daily(ix, view, today) : null), [ix, view, today, date])
  const cats = view.cats.filter((cm) => !cm.cat.archived)

  // Past notes for autocomplete, and which category a known note usually belongs to.
  const memory = useMemo(() => {
    const byNote = new Map<string, ID>()
    for (const t of ix.txns) {
      if (!t.note || t.kind) continue
      const k = t.note.trim().toLowerCase()
      if (!byNote.has(k)) byNote.set(k, t.cat)
    }
    return byNote
  }, [ix])
  const notesList = useMemo(() => [...new Set(ix.txns.filter((t) => t.note && !t.kind).map((t) => t.note!))].slice(0, 80), [ix])
  const suggested = dr.note.trim() ? memory.get(dr.note.trim().toLowerCase()) ?? null : null

  function left(id: ID): { text: string; over: boolean } {
    const cm = view.byId.get(id)
    if (cm?.cat.daily && dd) {
      const l = dd.leftToday - amountBase
      return { text: `${fmt(l, base)} today`, over: l < 0 }
    }
    const l = (cm?.available ?? 0) - amountBase
    return { text: fmt(l, base), over: l < 0 }
  }

  function log(cat: ID, el?: Element | null) {
    if (!amount) {
      play('error')
      flash(amountBox.current, 'shake')
      if (!touch) amountRef.current?.focus()
      return
    }
    const before = { ...draft }
    const income = cat === RTA
    const name = income ? 'Income' : ix.catById.get(cat)?.name ?? ''
    const label = `${fmt(amount, currency)} ${income ? 'income' : `· ${name}`}`
    undoable(
      label,
      () => addTxn({ date, cat, amt: income ? amount : -amount, cur: currency, note: dr.note.trim() || undefined }),
      () => setDraft(before),
    )
    play(income ? 'income' : 'log')
    haptic('medium')
    flash(el ?? null, 'pulse-once')
    setDraft({ digits: '', note: '', date: null, currency: null })
    if (!touch) amountRef.current?.focus()

    // Say what it means, not just what happened.
    if (income) return toast(`+${fmt(amount, currency)} ready to assign`, { undo: true })
    const fresh = getIndex()
    const after = monthView(fresh, month, monthOf(today))
    const cm = after.byId.get(cat)
    const isDaily = ix.catById.get(cat)?.daily
    const ddAfter = date === today && isDaily ? daily(fresh, after, today) : null
    if (ddAfter) {
      toast(
        ddAfter.leftToday >= 0
          ? `${name} · ${fmt(ddAfter.leftToday, base)} left today`
          : `${fmt(-ddAfter.leftToday, base)} over today · tomorrow ${fmt(ddAfter.tomorrow ?? 0, base)}`,
        { undo: true },
      )
    } else if (cm && cm.available < 0) {
      toast(`${name} is ${fmt(-cm.available, base)} over`, { undo: true })
    } else {
      toast(`${name} · ${fmt(cm?.available ?? 0, base)} left`, { undo: true })
    }
  }

  // Laptop: typing digits anywhere goes to the amount; arrows walk the bubbles; Enter logs.
  useEffect(() => {
    if (touch) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('dialog[open]')) return
      const el = document.activeElement as HTMLElement | null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (!typing && /^[0-9.,]$/.test(e.key)) {
        amountRef.current?.focus()
        return
      }
      if (e.key === 'Escape' && el === amountRef.current) {
        setDraft({ digits: '' })
        return
      }
      const bubbles = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('.bubble') ?? [])]
      const i = bubbles.indexOf(el as HTMLButtonElement)
      if (i < 0) return
      const cols = getComputedStyle(gridRef.current!).gridTemplateColumns.split(' ').length
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key]
      if (step) {
        e.preventDefault()
        const j = i + step
        if (j < 0) amountRef.current?.focus()
        else bubbles[Math.min(j, bubbles.length - 1)]?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [touch])

  const display = dr.digits ? (c.suffix ? `${fmtDigits(dr.digits)} ${c.symbol}` : `${c.symbol}${fmtDigits(dr.digits)}`) : c.suffix ? `0 ${c.symbol}` : `${c.symbol}0`

  return (
    <div class="register">
      <div class="amountline" ref={amountBox}>
        {touch ? (
          <div class={`amount-val${dr.digits ? '' : ' empty'}`} aria-live="polite">
            {display}
          </div>
        ) : (
          <input
            ref={amountRef}
            class="amount-input"
            type="text"
            inputMode="decimal"
            aria-label="Amount"
            placeholder={c.suffix ? `0 ${c.symbol}` : `${c.symbol}0`}
            value={dr.digits}
            autoFocus
            onInput={(e) => setDraft({ digits: e.currentTarget.value.replace(/[^\d.,]/g, '') })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (suggested) log(suggested)
                else gridRef.current?.querySelector<HTMLButtonElement>('.bubble')?.focus()
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                gridRef.current?.querySelector<HTMLButtonElement>('.bubble')?.focus()
              }
            }}
          />
        )}
        {currencies.length > 1 && (
          <button
            class={`pill${currency !== base ? ' picked' : ''}`}
            aria-label={`Currency ${currency}. Tap to change`}
            onClick={() => {
              play('toggle')
              setDraft({ currency: currencies[(currencies.indexOf(currency) + 1) % currencies.length] })
            }}
          >
            {currency}
          </button>
        )}
        <DatePill value={date} today={today} max={today} onChange={(v) => setDraft({ date: v === today ? null : v })} />
      </div>
      {currency !== base && amount > 0 && <div class="conv">≈ {fmt(amountBase, base)}</div>}
      <NoteField
        value={dr.note}
        list="mio-notes"
        onInput={(v) => setDraft({ note: v })}
        onEnter={() => {
          if (suggested && amount) log(suggested)
        }}
      />
      <datalist id="mio-notes">
        {notesList.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div class="bubbles" ref={gridRef}>
        {cats.map((cm) => {
          const l = left(cm.cat.id)
          return (
            <button
              key={cm.cat.id}
              class={`bubble${l.over ? ' over' : ''}${suggested === cm.cat.id ? ' suggest' : ''}`}
              onClick={(e) => log(cm.cat.id, e.currentTarget)}
            >
              <b>{cm.cat.name}</b>
              <span>{l.text}</span>
            </button>
          )
        })}
        <button class="bubble income" onClick={(e) => log(RTA, e.currentTarget)}>
          <b>Income</b>
          <span>{amount ? `+${fmt(amount, currency)}` : 'to plan'}</span>
        </button>
      </div>
      {touch && <Keypad value={dr.digits} onChange={(v) => setDraft({ digits: v })} decimals={c.decimals} />}
    </div>
  )
}

function fmtDigits(s: string): string {
  const [w, f] = s.split('.')
  const whole = Number(w || '0').toLocaleString('en-US')
  return f !== undefined ? `${whole}.${f}` : whole
}
