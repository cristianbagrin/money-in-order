import { useEffect, useMemo, useState } from 'preact/hooks'
import { chipOrder, daily, monthView } from '../lib/budget'
import { dateLabel, monthOf } from '../lib/dates'
import { cur, fmt, keypadToMinor } from '../lib/money'
import { currenciesInUse } from '../lib/rates'
import { addTxn, deleteTxn, getIndex, toBase } from '../lib/store'
import { RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { Keypad, Sheet, toast } from '../ui/kit'

const TOP = 5

/** The quick-log register: type an amount, tap where it went. That's the whole interaction. */
export function Register(props: { today: string; onCover: (cat: ID) => void }) {
  const ix = useIndex()
  const { today } = props
  const base = ix.settings.base
  const [digits, setDigits] = useState('')
  const [currency, setCurrency] = useState(base)
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today)
  const [more, setMore] = useState(false)

  useEffect(() => setDate(today), [today])
  useEffect(() => setCurrency(base), [base])

  const currencies = currenciesInUse()
  const c = cur(currency)
  const amount = keypadToMinor(digits)
  const amountBase = currency === base ? amount : toBase(amount, currency)

  const month = monthOf(date)
  const view = useMemo(() => monthView(ix, month, monthOf(today)), [ix, month, today])
  const d = useMemo(() => (date === today ? daily(ix, view, today) : null), [ix, view, today, date])
  // Chip order is learned from habits but frozen while the screen is open so buttons don't jump.
  const order = useMemo(() => chipOrder(ix, today).map((c) => c.id), [ix.cats.length, today])

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
  const suggested = note.trim() ? memory.get(note.trim().toLowerCase()) ?? null : null

  const live = order.filter((id) => ix.catById.get(id) && !ix.catById.get(id)!.archived)
  let top = live.slice(0, TOP)
  if (suggested && suggested !== RTA && !top.includes(suggested) && live.includes(suggested)) top = [...top.slice(0, TOP - 1), suggested]

  function reset() {
    setDigits('')
    setNote('')
    setDate(today)
    setCurrency(base)
  }

  function log(cat: ID) {
    if (!amount) {
      toast('Type the amount first, then tap where it went')
      return
    }
    setMore(false)
    const income = cat === RTA
    const t = addTxn({ date, cat, amt: income ? amount : -amount, cur: currency, note: note.trim() || undefined })
    reset()
    const undo = { label: 'Undo', run: () => deleteTxn(t.id) }
    if (income) {
      toast(`${fmt(amount, currency)} added to Ready to assign`, undo)
      return
    }
    // Tell the consequence, not just the fact.
    const fresh = getIndex()
    const after = monthView(fresh, month, monthOf(today))
    const cm = after.byId.get(cat)
    const cat_ = ix.catById.get(cat)
    const name = cat_?.name ?? ''
    const dd = date === today ? daily(fresh, after, today) : null
    if (dd && cat_?.daily) {
      if (dd.leftToday >= 0) toast(`${fmt(amount, currency)} · ${name}. ${fmt(dd.leftToday, base)} left today`, undo)
      else toast(`${fmt(-dd.leftToday, base)} over today. Tomorrow's share drops to ${fmt(dd.tomorrow ?? 0, base)}`, undo)
    } else if (cm && cm.available < 0 && !cat_?.saving) {
      toast(`${name} is ${fmt(-cm.available, base)} over. Cover it from another category.`, {
        label: 'Cover',
        run: () => props.onCover(cat),
      })
    } else {
      toast(`${fmt(amount, currency)} · ${name}. ${fmt(cm?.available ?? 0, base)} left`, undo)
    }
  }

  // Physical keyboard on laptops: just start typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      if (document.querySelector('dialog[open]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (/^[0-9]$/.test(e.key)) {
        setDigits((v) => (v.replace('.', '').length >= 9 ? v : v === '0' ? e.key : v + e.key))
      } else if (e.key === '.' || e.key === ',') {
        if (c.decimals) setDigits((v) => (v.includes('.') ? v : (v || '0') + '.'))
      } else if (e.key === 'Backspace') {
        setDigits((v) => v.slice(0, -1))
      } else if (e.key === 'Escape') {
        reset()
      } else if (e.key === 'Enter') {
        if (suggested && amount) log(suggested)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function chipText(id: ID): { text: string; over: boolean } {
    const cm = view.byId.get(id)
    const cat = ix.catById.get(id)
    if (cat?.daily && d) {
      const left = d.leftToday - amountBase
      return { text: `${fmt(left, base)} today`, over: left < 0 }
    }
    const left = (cm?.available ?? 0) - amountBase
    return { text: fmt(left, base), over: left < 0 }
  }

  const display = digits
    ? c.suffix
      ? `${fmtDigits(digits)} ${c.symbol}`
      : `${c.symbol}${fmtDigits(digits)}`
    : c.suffix
      ? `0 ${c.symbol}`
      : `${c.symbol}0`

  return (
    <div class="register">
      <div class="amount">
        <div class={`amount-val${digits ? '' : ' empty-amt'}`} aria-live="polite">
          {display}
          {currency !== base && amount > 0 && <span class="amount-conv"> ≈ {fmt(amountBase, base)}</span>}
        </div>
        {currencies.length > 1 && (
          <button
            class={`pill${currency !== base ? ' on' : ''}`}
            onClick={() => setCurrency(currencies[(currencies.indexOf(currency) + 1) % currencies.length])}
            aria-label={`Currency ${currency}. Tap to change`}
          >
            {currency}
          </button>
        )}
        <span class="datepick">
          <button class={`pill${date !== today ? ' on' : ''}`} tabIndex={-1} aria-hidden="true">
            {dateLabel(date, today)}
          </button>
          <input type="date" value={date} max={today} aria-label="Date" onChange={(e) => e.currentTarget.value && setDate(e.currentTarget.value)} />
        </span>
      </div>
      <div class="memo">
        <input
          type="text"
          placeholder="What for? (optional)"
          value={note}
          list="mio-notes"
          enterKeyHint="done"
          autocomplete="off"
          onInput={(e) => setNote(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
              if (suggested && amount) log(suggested)
            }
          }}
        />
        <datalist id="mio-notes">
          {notesList.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </div>
      <div class="chips">
        {top.map((id) => {
          const cat = ix.catById.get(id)!
          const { text, over } = chipText(id)
          return (
            <button
              key={id}
              class={`chip${cat.daily ? ' daily' : ''}${over ? ' over' : ''}${suggested === id ? ' suggest' : ''}`}
              onClick={() => log(id)}
            >
              <span class="chip-name">{cat.name}</span>
              <span class="chip-left">{text}</span>
            </button>
          )
        })}
        <button class="chip more" onClick={() => setMore(true)}>
          <span class="chip-name">More</span>
          <span class="chip-left">income · all</span>
        </button>
      </div>
      <Keypad value={digits} onChange={setDigits} decimals={c.decimals} />

      <Sheet open={more} onClose={() => setMore(false)} title={amount ? `${fmt(amount, currency)} goes to…` : 'Where did it go?'}>
        <ul class="lines">
          <li>
            <button class="line-btn row" style={{ minHeight: '44px' }} onClick={() => log(RTA)}>
              <b class="grow pos">+ Income</b>
              <span class="faint" style={{ fontSize: '13px' }}>
                to Ready to assign
              </span>
            </button>
          </li>
          {view.groups.map((g) =>
            g.cats
              .filter((cm) => !cm.cat.archived)
              .map((cm) => {
                const { text, over } = chipText(cm.cat.id)
                return (
                  <li key={cm.cat.id}>
                    <button class="line-btn row" style={{ minHeight: '44px' }} onClick={() => log(cm.cat.id)}>
                      <span class="grow">
                        {cm.cat.name}
                        <small class="faint" style={{ display: 'block', fontSize: '12px' }}>
                          {g.group.name}
                        </small>
                      </span>
                      <span class={`num ${over ? 'neg' : 'faint'}`} style={{ fontSize: '13px' }}>
                        {text}
                      </span>
                    </button>
                  </li>
                )
              }),
          )}
        </ul>
      </Sheet>
    </div>
  )
}

function fmtDigits(s: string): string {
  const [w, f] = s.split('.')
  const whole = Number(w || '0').toLocaleString('en-US')
  return f !== undefined ? `${whole}.${f}` : whole
}
