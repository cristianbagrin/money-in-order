import { memo } from 'preact/compat'
import { useEffect, useRef, useState } from 'preact/hooks'
import { cur, evalAmount, fmt, groupTyped } from '../lib/money'

/** How an amount appears in the editor: no grouping, and no cents for currencies without them. */
function amountText(amt: number, code: string): string {
  const v = Math.abs(amt) / 100
  return groupTyped(cur(code).decimals ? String(Math.round(v * 100) / 100) : String(Math.round(v)))
}
import { currenciesInUse, hasRate } from '../lib/rates'
import { deleteTxn, undoable, updateTxn, type NewTxn } from '../lib/store'
import { RTA, type Txn } from '../lib/types'
import { DatePill } from '../ui/calendar'
import { useIndex } from '../ui/hooks'
import { AmountField, NoteField, toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'

const KIND_LABEL: Record<NonNullable<Txn['kind']>, string> = {
  start: 'Starting balance',
  adj: 'Count correction',
  fx: 'Exchange rates',
}

interface Swipe {
  id: number
  x0: number
  y0: number
  /** where the row already was when grabbed (non-zero when it is caught mid spring-back) */
  from: number
  drag: boolean
  pts: { t: number; x: number }[]
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * One History row. It takes everything as props (no store subscription) and is memoized, so a long list
 * re-renders only the rows that changed. Hover shows a × (mouse); a left swipe deletes (touch).
 */
export const TxnRow = memo(function TxnRow(props: { t: Txn; base: string; catName: string; onOpen: (t: Txn, e: MouseEvent) => void; onDelete: (t: Txn) => void; selected?: boolean; plain?: boolean }) {
  const { t, base, catName } = props
  const title = t.note || (t.kind ? KIND_LABEL[t.kind] : catName)
  const positive = t.base > 0
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const swipe = useRef<Swipe | null>(null)
  const swallow = useRef(false)
  const gone = useRef(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  // The swipe moves the row with transform only and never re-renders it; a red area behind shows what it will do.
  function down(e: PointerEvent) {
    const el = btn.current
    if (!el || e.pointerType !== 'touch' || !e.isPrimary || gone.current) return
    clearTimeout(timer.current)
    // Catch the row where it is, even mid spring-back, so it can be grabbed again.
    const from = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41
    el.style.transition = 'none'
    el.style.transform = `translateX(${from}px)`
    swipe.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from, drag: false, pts: [{ t: e.timeStamp, x: e.clientX }] }
    if (from) start(e.pointerId)
  }

  function start(id: number) {
    swipe.current!.drag = true
    btn.current!.setPointerCapture(id)
    wrap.current!.classList.add('swiping')
  }

  function move(e: PointerEvent) {
    const s = swipe.current
    const el = btn.current
    if (!s || !el || e.pointerId !== s.id) return
    const dx = e.clientX - s.x0
    if (!s.drag) {
      const dy = e.clientY - s.y0
      // Vertical first (or to the right): it is a scroll, not ours.
      if (Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx)) swipe.current = null
      else if (Math.abs(dx) >= 10) dx < 0 ? start(e.pointerId) : (swipe.current = null)
      if (!swipe.current?.drag) return
    }
    // 1:1 from where it was grabbed.
    el.style.transform = `translateX(${Math.min(0, Math.max(-el.offsetWidth, s.from + dx))}px)`
    s.pts.push({ t: e.timeStamp, x: e.clientX })
    while (s.pts.length > 2 && e.timeStamp - s.pts[0].t > 100) s.pts.shift()
  }

  function up(e: PointerEvent) {
    const s = swipe.current
    const el = btn.current
    if (!s || !el || e.pointerId !== s.id) return
    swipe.current = null
    if (!s.drag) return
    swallow.current = true
    setTimeout(() => (swallow.current = false), 60)
    const a = s.pts[0]
    const b = s.pts[s.pts.length - 1]
    // px/ms over the last ~100ms; a finger that stopped before lifting is not a flick.
    const v = e.type === 'pointerup' && b.t > a.t && e.timeStamp - b.t < 80 ? (b.x - a.x) / (b.t - a.t) : 0
    const w = el.offsetWidth
    const x = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41
    settle(e.type === 'pointerup' && v < 0.5 && (x <= -0.45 * w || (v <= -0.5 && x < -8)), v, x, w)
  }

  function settle(del: boolean, v: number, x: number, w: number) {
    const el = btn.current!
    const box = wrap.current!
    const calm = reduced()
    if (!del) {
      const done = () => {
        box.classList.remove('swiping')
        el.style.transition = el.style.transform = ''
      }
      if (calm) return done()
      el.style.transition = 'transform 260ms var(--ease)'
      el.style.transform = 'translateX(0)'
      timer.current = window.setTimeout(done, 280)
      return
    }
    gone.current = true
    const finish = () => props.onDelete(t)
    if (calm) {
      // No slide: the row just fades.
      el.style.transition = 'opacity 150ms linear'
      el.style.opacity = '0'
      timer.current = window.setTimeout(finish, 160)
      return
    }
    // Carry on at the finger's speed (linear, so the speed doesn't change), then close the gap.
    const ms = Math.round(Math.min(260, Math.max(100, (w + x) / Math.max(-v, 0.9))))
    el.style.transition = `transform ${ms}ms linear`
    el.style.transform = `translateX(${-w}px)`
    timer.current = window.setTimeout(() => {
      box.style.height = `${box.offsetHeight}px`
      box.getBoundingClientRect()
      box.style.transition = 'height 180ms var(--ease)'
      box.style.height = '0px'
      timer.current = window.setTimeout(finish, 190)
    }, ms)
  }

  function click(e: MouseEvent) {
    if (swallow.current) return e.preventDefault()
    props.onOpen(t, e)
  }

  return (
    <div class={`txn-wrap${props.selected ? ' sel' : ''}`} ref={wrap}>
      <div class="txn-del" aria-hidden="true">
        Delete
      </div>
      <button
        ref={btn}
        class={`txn${props.selected ? ' sel' : ''}`}
        onClick={click}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        data-txn={t.id}
      >
        <div class="txn-main">
          <div class="txn-title">{title}</div>
          {title !== catName && !props.plain && <div class="txn-sub">{catName}</div>}
        </div>
        <div class="txn-amt">
          <span class={`num${positive ? ' pos' : ''}`}>{fmt(t.base, base, { sign: positive })}</span>
          {t.cur !== base && <small class="num">{fmt(t.amt, t.cur)}</small>}
        </div>
      </button>
      <button class="txn-x" tabIndex={-1} aria-label="Delete" onClick={() => props.onDelete(t)}>
        ×
      </button>
    </div>
  )
})


/** Edit a transaction. Every change applies right away (and can be undone). */
export function TxnSheet(props: { txn: Txn | null; today: string; onClose: () => void }) {
  const ix = useIndex()
  const t = props.txn ? ix.db.txns[props.txn.id] ?? props.txn : null
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  // Show what is stored: when the sheet opens, and whenever the record changes underneath it (undo, sync).
  // A field with text typed into it (different from what the record last put there) is left alone;
  // one that is merely focused takes the restored value, so leaving it can't re-apply the old text.
  const stored = useRef({ Amount: '', Note: '' })
  useEffect(() => {
    if (!t) return
    const focus = document.activeElement instanceof HTMLInputElement ? document.activeElement.getAttribute('aria-label') : null
    const a = amountText(t.amt, t.cur)
    const n = t.note ?? ''
    if (!(focus === 'Amount' && amount !== stored.current.Amount)) setAmount(a)
    if (!(focus === 'Note' && note !== stored.current.Note)) setNote(n)
    stored.current = { Amount: a, Note: n }
  }, [t?.id, t?.amt, t?.cur, t?.note])

  if (!t || t.d) return <Sheet open={false} onClose={props.onClose} children={null} />
  const tx = t
  const currencies = [...new Set([...currenciesInUse().filter(hasRate), tx.cur])]
  const cats = ix.cats.filter((c) => !c.archived || c.id === tx.cat)
  const refund = tx.cat !== RTA && tx.amt > 0

  function change(patch: Partial<NewTxn>, label = 'Edited') {
    undoable(label, () => updateTxn(tx.id, patch))
    toast(label, { undo: true })
  }

  function setCategory(cat: string) {
    if (cat === tx.cat) return
    const income = cat === RTA
    // Income is money in; spending is money out (a refund keeps its sign).
    const amt = income ? Math.abs(tx.amt) : refund ? tx.amt : -Math.abs(tx.amt)
    change({ cat, amt }, 'Changed category')
  }

  function commitAmount(raw: string) {
    // Untouched: never rewrite (the shown text may be rounded).
    if (raw.trim() === amountText(tx.amt, tx.cur)) return
    const v = evalAmount(raw, tx.cur)
    if (v === null || v === 0) {
      setAmount(amountText(tx.amt, tx.cur))
      return
    }
    // Keep the entry's own direction (income in, spending out, corrections either way).
    const signed = (tx.amt < 0 ? -1 : 1) * Math.abs(v)
    setAmount(amountText(signed, tx.cur))
    if (signed !== tx.amt) change({ amt: signed }, 'Changed amount')
  }

  return (
    <Sheet open onClose={props.onClose} title={tx.kind ? KIND_LABEL[tx.kind] : tx.cat === RTA ? 'Income' : refund ? 'Refund' : 'Spending'}>
      <AmountField label="Amount" value={amount} onInput={setAmount} onCommit={commitAmount} />
      <div class="row" style={{ marginTop: '10px', flexWrap: 'wrap' }}>
        {currencies.length > 1 &&
          currencies.map((c) => (
            <button
              key={c}
              class="pill soft"
              aria-pressed={tx.cur === c}
              onClick={() => {
                if (c === tx.cur) return
                change({ cur: c }, 'Changed currency')
              }}
            >
              {c}
            </button>
          ))}
        <span class="grow" />
        <DatePill value={tx.date} today={props.today} max={props.today} onChange={(d) => change({ date: d }, 'Changed date')} />
      </div>
      <div style={{ marginTop: '8px' }}>
        <NoteField
          value={note}
          onInput={setNote}
          onCommit={(v) => {
            if (v.trim() !== (tx.note ?? '')) change({ note: v.trim() || undefined }, 'Edited note')
          }}
        />
      </div>
      <div class="pills" style={{ marginTop: '16px' }}>
        <button class="pill soft" aria-pressed={tx.cat === RTA} onClick={() => setCategory(RTA)}>
          Income
        </button>
        {cats.map((c) => (
          <button key={c.id} class="pill soft" aria-pressed={tx.cat === c.id} onClick={() => setCategory(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      <div class="cs-foot">
        <span />
        <button
          class="link red"
          onClick={() => {
            undoable(`Deleted ${fmt(Math.abs(tx.amt), tx.cur)}`, () => deleteTxn(tx.id))
            play('delete')
            props.onClose()
            toast('Deleted', { undo: true })
          }}
        >
          Delete
        </button>
      </div>
    </Sheet>
  )
}
