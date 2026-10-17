import { memo } from 'preact/compat'
import { useEffect, useState } from 'preact/hooks'
import { cur, evalAmount, fmt } from '../lib/money'

/** How an amount appears in the editor: no grouping, and no cents for currencies without them. */
function amountText(amt: number, code: string): string {
  const v = Math.abs(amt) / 100
  return cur(code).decimals ? String(Math.round(v * 100) / 100) : String(Math.round(v))
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

/**
 * One History row. It takes everything as props (no store subscription) and is memoized, so a long list
 * re-renders only the rows that changed.
 */
export const TxnRow = memo(function TxnRow(props: { t: Txn; base: string; catName: string; onOpen: (t: Txn) => void; selected?: boolean; plain?: boolean }) {
  const { t, base, catName } = props
  const title = t.note || (t.kind ? KIND_LABEL[t.kind] : catName)
  const positive = t.base > 0
  return (
    <button class={`txn${props.selected ? ' sel' : ''}`} onClick={() => props.onOpen(t)} data-txn={t.id}>
      <div class="txn-main">
        <div class="txn-title">{title}</div>
        {title !== catName && !props.plain && <div class="txn-sub">{catName}</div>}
      </div>
      <div class="txn-amt">
        <span class={`num${positive ? ' pos' : ''}`}>{fmt(t.base, base, { sign: positive })}</span>
        {t.cur !== base && <small class="num">{fmt(t.amt, t.cur)}</small>}
      </div>
    </button>
  )
})

/** Edit a transaction. Every change applies right away (and can be undone). */
export function TxnSheet(props: { txn: Txn | null; today: string; onClose: () => void }) {
  const ix = useIndex()
  const t = props.txn ? ix.db.txns[props.txn.id] ?? props.txn : null
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  // Show what is stored: when the sheet opens, and whenever the record changes underneath it (undo, sync).
  // The field being typed in is left alone.
  useEffect(() => {
    if (!t) return
    const typing = (label: string) => document.activeElement instanceof HTMLInputElement && document.activeElement.getAttribute('aria-label') === label
    if (!typing('Amount')) setAmount(amountText(t.amt, t.cur))
    if (!typing('Note')) setNote(t.note ?? '')
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
    play('toggle')
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
                play('toggle')
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
