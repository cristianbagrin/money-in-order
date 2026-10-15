import { useEffect, useState } from 'preact/hooks'
import { fmt, parseAmount } from '../lib/money'
import { currenciesInUse } from '../lib/rates'
import { deleteTxn, restoreTxn, updateTxn } from '../lib/store'
import { RTA, type Txn } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { Field, Sheet, toast } from '../ui/kit'

const KIND_LABEL: Record<NonNullable<Txn['kind']>, string> = {
  start: 'Starting balance',
  adj: 'Count correction',
  fx: 'Exchange rates',
}

export function TxnRow(props: { t: Txn; onClick: () => void; showDate?: string; compact?: boolean }) {
  const ix = useIndex()
  const { t } = props
  const base = ix.settings.base
  const cat = t.cat === RTA ? null : ix.catById.get(t.cat)
  const catName = t.cat === RTA ? 'Ready to assign' : cat?.name ?? 'Unknown'
  const title = t.note || (t.kind ? KIND_LABEL[t.kind] : t.cat === RTA ? 'Income' : catName)
  const sub = [title !== catName ? catName : '', props.showDate ?? ''].filter(Boolean).join(' · ')
  const positive = t.base > 0
  return (
    <button class={`txn${props.compact ? ' compact' : ''}`} onClick={props.onClick}>
      <div class="txn-main">
        <div class="txn-title">{title}</div>
        {sub && <div class="txn-sub">{sub}</div>}
      </div>
      <div class="txn-amt">
        <span class={`num${positive ? ' pos' : ''}`}>{fmt(t.base, base, { sign: positive })}</span>
        {t.cur !== base && <small class="num">{fmt(t.amt, t.cur)}</small>}
      </div>
    </button>
  )
}

export function TxnSheet(props: { txn: Txn | null; onClose: () => void }) {
  const ix = useIndex()
  const t = props.txn
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('')
  const [cat, setCat] = useState('')
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!t) return
    setAmount((Math.abs(t.amt) / 100).toString())
    setCurrency(t.cur)
    setCat(t.cat)
    setDate(t.date)
    setNote(t.note ?? '')
  }, [t?.id])

  if (!t) return null
  const income = cat === RTA
  const currencies = [...new Set([...currenciesInUse(), t.cur])]

  function save() {
    if (!t) return
    const v = parseAmount(amount)
    if (v === null) return toast('That amount doesn’t look right')
    // Income is positive; spending negative. A refund keeps its sign.
    const wasRefund = t.cat !== RTA && t.amt > 0
    const signed = cat === RTA ? Math.abs(v) : wasRefund ? Math.abs(v) : -Math.abs(v)
    updateTxn(t.id, { amt: signed, cur: currency, cat, date, note: note.trim() || undefined })
    props.onClose()
  }

  function remove() {
    if (!t) return
    const copy = { ...t }
    deleteTxn(t.id)
    props.onClose()
    toast('Deleted', { label: 'Undo', run: () => restoreTxn(copy) })
  }

  return (
    <Sheet open={!!t} onClose={props.onClose} title={income ? 'Income' : t.amt > 0 ? 'Refund' : 'Spending'}>
      <div class="row">
        <Field label="Amount">
          <input type="text" inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
        </Field>
        <div style={{ width: '110px' }}>
          <Field label="Currency">
            <select value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Field label="Category">
        <select value={cat} onChange={(e) => setCat(e.currentTarget.value)}>
          <option value={RTA}>Income → Ready to assign</option>
          {ix.groups.map((g) => (
            <optgroup key={g.id} label={g.name}>
              {ix.cats
                .filter((c) => c.group === g.id && (!c.archived || c.id === t.cat))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <Field label="Date">
        <input type="date" value={date} onChange={(e) => setDate(e.currentTarget.value)} />
      </Field>
      <Field label="Note">
        <input type="text" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="What was it?" />
      </Field>
      <div class="stack" style={{ marginTop: '20px' }}>
        <button class="btn block" onClick={save}>
          Save
        </button>
        <button class="btn danger block" onClick={remove}>
          Delete
        </button>
      </div>
    </Sheet>
  )
}
