import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { daily, monthView } from '../lib/budget'
import { dayOfMonth, daysInMonth, isoDate, monthOf } from '../lib/dates'
import { cur, evalAmount, fmt, keypadToMinor } from '../lib/money'
import { currenciesInUse, hasRate } from '../lib/rates'
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
  /** the day `date` was last set: a picked day is only good for that day */
  day?: string
}
const DRAFT_KEY = 'mio-draft'
function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null
    // The amount and note may wait for tomorrow; a past date picked yesterday may not.
    if (d && typeof d.digits === 'string') return d.day === isoDate() ? d : { ...d, date: null }
  } catch {
    /* storage unavailable */
  }
  return { digits: '', currency: null, note: '', date: null }
}
let draft: Draft = loadDraft()
const draftListeners = new Set<() => void>()
function setDraft(next: Partial<Draft>) {
  draft = { ...draft, ...next }
  if ('date' in next || !draft.day) draft.day = isoDate()
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* storage unavailable */
  }
  for (const fn of draftListeners) fn()
}

/** Big numbers shrink instead of spilling out or being cut off. */
function fitSize(text: string, base: number, room: number): string {
  const n = text.length
  return n <= room ? `${base}px` : `${Math.max(20, Math.floor((base * room) / n))}px`
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
  // Without a daily category, the key number is what's left to spend this month.
  const monthLeft = d ? 0 : view.cats.filter((c) => !c.cat.saving && !c.cat.archived).reduce((s, c) => s + c.available, 0)
  const heroValue = d ? (monthOver ? d.available : d.leftToday) : monthLeft
  const shown = useCountUp(heroValue)
  const heroText = fmt(Math.abs(shown), base)

  return (
    <div class="today">
      <section class="hero">
        {planFirst ? (
          <>
            <div class="hero-num" style={{ fontSize: 'clamp(36px, 10vw, 52px)' }}>
              Plan first
            </div>
            <button class="btn plan-first" onClick={props.onPlan}>
              Open the plan
            </button>
          </>
        ) : (
          <>
            <div class={`hero-num${heroValue < 0 ? ' neg' : ''}`} style={{ fontSize: heroText.length > 8 ? fitSize(heroText, 72, 8) : undefined }}>
              <span class={`marked${heroValue < 0 ? ' neg' : ''}`}>{heroText}</span>
            </div>
            <div class="hero-cap">
              {!d
                ? heroValue < 0
                  ? 'over this month'
                  : 'left to spend this month'
                : monthOver
                  ? `over for the month in ${d.cats.map((c) => c.name).join(' + ')}`
                  : heroValue < 0
                    ? 'over today'
                    : 'left for today'}
            </div>
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
  const typed = touch ? null : evalAmount(dr.digits, currency)
  const invalid = !touch && dr.digits.trim() !== '' && typed === null
  const amount = touch ? keypadToMinor(dr.digits) : Math.abs(typed ?? 0)
  const amountBase = currency === base ? amount : toBase(amount, currency)
  const currencies = currenciesInUse().filter(hasRate)
  const amountRef = useRef<HTMLInputElement>(null)
  const amountBox = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const regRef = useRef<HTMLDivElement>(null)

  // Toasts sit in the free band just above the amount line, so they never cover the number that just changed.
  useLayoutEffect(() => {
    const el = regRef.current
    if (!el) return
    const root = document.documentElement
    const set = () => {
      // one toast (44px, see .toast) and a small gap above the register
      root.style.setProperty('--toast-top', `${Math.round(el.getBoundingClientRect().top) - 52}px`)
      root.style.setProperty('--toast-bottom', 'auto')
    }
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    window.addEventListener('resize', set)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', set)
      root.style.removeProperty('--toast-top')
      root.style.removeProperty('--toast-bottom')
    }
  }, [])

  // The app left open past midnight: a date picked yesterday goes back to today.
  useEffect(() => {
    if (draft.date && draft.day !== today) setDraft({ date: null })
  }, [today])

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

  /** What a bubble says. While typing, categories with money to spend show what would be left; the rest keep their value. */
  function left(id: ID): { text: string; over: boolean } {
    const cm = view.byId.get(id)
    if (!cm) return { text: fmt(0, base), over: false }
    const now = cm.cat.daily && dd && !(dd.allowance === 0 && cm.available <= 0) ? dd.leftToday : cm.available
    const spendable = !cm.cat.saving && cm.available > 0
    const l = spendable ? now - amountBase : now
    // Red is for a real problem: already overspent, or this entry would overspend.
    return { text: fmt(l, base), over: l < 0 && !cm.cat.saving }
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
    if (ddAfter && cm && ddAfter.allowance === 0 && cm.available < 0) {
      toast(`${name} is ${fmt(-cm.available, base)} over for the month`, { undo: true })
    } else if (ddAfter) {
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

  // Laptop: typing digits anywhere goes to the amount; arrows walk the bubbles; Enter logs; Esc starts over.
  useEffect(() => {
    if (touch) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('dialog[open]')) return
      const el = document.activeElement as HTMLElement | null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (!typing && /^[0-9.,]$/.test(e.key)) {
        amountRef.current?.focus()
        return
      }
      if (e.key === 'Escape') {
        // Abandon the whole entry, from the amount, the note, a bubble or nowhere in particular.
        if (!el || el === document.body || regRef.current?.contains(el)) {
          setDraft({ digits: '', note: '', date: null, currency: null })
          amountRef.current?.focus()
        }
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
  const sym = (
    <span class="amount-sym" aria-hidden="true">
      {c.symbol}
    </span>
  )
  // The line under the amount only speaks in another currency, but it keeps its height (wherever the
  // currency can be switched) so choosing one moves nothing.
  const converted = currency !== base && amount > 0

  return (
    <div class="register" ref={regRef}>
      <div class="amountline" ref={amountBox}>
        {touch ? (
          <div class={`amount-val${dr.digits ? '' : ' is-empty'}`} aria-live="polite" style={{ fontSize: fitSize(display, 40, 9) }}>
            {display}
          </div>
        ) : (
          // The currency stays put beside the number, as on the phone; an amount that can't be read turns red.
          <div
            class={`amount-wrap${dr.digits ? '' : ' is-empty'}${invalid ? ' invalid' : ''}`}
            onMouseDown={(e) => {
              if (e.target === amountRef.current) return
              e.preventDefault()
              amountRef.current?.focus()
            }}
          >
            {!c.suffix && sym}
            <span class="amount-fit">
              <input
                ref={amountRef}
                class="amount-input"
                type="text"
                size={1}
                inputMode="decimal"
                aria-label="Amount"
                aria-invalid={invalid ? 'true' : undefined}
                placeholder="0"
                maxLength={24}
                value={dr.digits}
                autoFocus
                onInput={(e) => setDraft({ digits: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (suggested) log(suggested)
                    else gridRef.current?.querySelector<HTMLButtonElement>('.bubble')?.focus()
                  }
                  if (e.key === 'ArrowDown') {
                    // Land on the first bubble and stop there: the window's arrow handler must not also step down a row.
                    e.preventDefault()
                    e.stopPropagation()
                    gridRef.current?.querySelector<HTMLButtonElement>('.bubble')?.focus()
                  }
                }}
              />
              <span class="amount-mirror" aria-hidden="true">
                {dr.digits || '0'}
              </span>
            </span>
            {c.suffix && sym}
          </div>
        )}
        {currencies.length > 1 && (
          <button
            class={`pill${currency !== base ? ' picked' : ''}`}
            aria-label={`Currency ${currency}. Tap to change`}
            onClick={() => {
              play('toggle')
              const next = currencies[(currencies.indexOf(currency) + 1) % currencies.length]
              // A currency without cents can't keep typed cents.
              setDraft({ currency: next, digits: touch && !cur(next).decimals ? dr.digits.split('.')[0] : dr.digits })
            }}
          >
            {currency}
          </button>
        )}
        <DatePill value={date} today={today} max={today} onChange={(v) => setDraft({ date: v === today ? null : v })} />
      </div>
      {currencies.length > 1 && (
        <div class="conv" aria-hidden={converted ? undefined : 'true'}>
          {converted ? `≈ ${fmt(amountBase, base)}` : ' '}
        </div>
      )}
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
        <button class={`bubble income${suggested === RTA ? ' suggest' : ''}`} onClick={(e) => log(RTA, e.currentTarget)}>
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
