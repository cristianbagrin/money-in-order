import { useEffect, useState } from 'preact/hooks'
import { evalAmount, fmt } from '../lib/money'
import { currenciesInUse } from '../lib/rates'
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

export function TxnRow(props: { t: Txn; onClick: () => void; selected?: boolean }) {
  const ix = useIndex()
  const { t } = props
  const base = ix.settings.base
  const cat = t.cat === RTA ? null : ix.catById.get(t.cat)
  const catName = t.cat === RTA ? 'Income' : cat?.name ?? 'Unknown'
  const title = t.note || (t.kind ? KIND_LABEL[t.kind] : catName)
  const positive = t.base > 0
  return (
    <button class={`txn${props.selected ? ' sel' : ''}`} onClick={props.onClick} data-txn={t.id}>
      <div class="txn-main">
        <div class="txn-title">{title}</div>
        {title !== catName && <div class="txn-sub">{catName}</div>}
      </div>
      <div class="txn-amt">
        <span class={`num${positive ? ' pos' : ''}`}>{fmt(t.base, base, { sign: positive })}</span>
        {t.cur !== base && <small class="num">{fmt(t.amt, t.cur)}</small>}
      </div>
    </button>
  )
}

/** Edit a transaction. Every change applies right away (and can be undone). */
export function TxnSheet(props: { txn: Txn | null; today: string; onClose: () => void }) {
  const ix = useIndex()
  const t = props.txn ? ix.db.txns[props.txn.id] ?? props.txn : null
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!t) return
    setAmount(String(Math.abs(t.amt) / 100))
    setNote(t.note ?? '')
  }, [t?.id])

  if (!t || t.d) return <Sheet open={false} onClose={props.onClose} children={null} />
  const tx = t
  const currencies = [...new Set([...currenciesInUse(), tx.cur])]
  const cats = ix.cats.filter((c) => !c.archived || c.id === tx.cat)
  const refund = tx.cat !== RTA && tx.amt > 0

  function change(patch: Partial<NewTxn>, label = 'Edited') {
    undoable(label, () => updateTxn(tx.id, patch))
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
    const v = evalAmount(raw)
    if (v === null || v === 0) {
      setAmount(String(Math.abs(tx.amt) / 100))
      return
    }
    const signed = tx.cat === RTA || refund ? Math.abs(v) : -Math.abs(v)
    if (signed !== tx.amt) change({ amt: signed }, 'Changed amount')
  }

  return (
    <Sheet open onClose={props.onClose} title={tx.cat === RTA ? 'Income' : refund ? 'Refund' : 'Spending'}>
      <AmountField label="Amount" value={amount} onInput={setAmount} onCommit={commitAmount} />
      <div class="row" style={{ marginTop: '10px', flexWrap: 'wrap' }}>
        {currencies.length > 1 &&
          currencies.map((c) => (
            <button
              key={c}
              class="pill sm"
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
