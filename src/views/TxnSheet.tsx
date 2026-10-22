import { memo } from 'preact/compat'
import { useEffect, useRef, useState } from 'preact/hooks'
import { accountsInOrder, cashAccounts } from '../lib/accounts'
import { convert, cur, evalAmount, fmt, groupTyped } from '../lib/money'

/** How an amount appears in the editor: no grouping, and no cents for currencies without them. */
function amountText(amt: number, code: string): string {
  const v = Math.abs(amt) / 100
  return groupTyped(cur(code).decimals ? String(Math.round(v * 100) / 100) : String(Math.round(v)))
}
import { currenciesInUse, hasRate } from '../lib/rates'
import { deleteTxn, undoable, updateTxn, type NewTxn } from '../lib/store'
import { RTA, type Account, type ID, type Txn } from '../lib/types'
import { Calendar } from '../ui/calendar'
import { useIndex } from '../ui/hooks'
import { AmountField, NoteField, toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'
import { useSwipeDelete } from '../ui/swipe'
import './txn.css'

const KIND_LABEL: Record<NonNullable<Txn['kind']>, string> = {
  start: 'Starting balance',
  adj: 'Count correction',
  fx: 'Exchange rates',
  move: 'Moved',
}

/**
 * One History row. It takes everything as props (no store subscription) and is memoized, so a long list
 * re-renders only the rows that changed. Hover shows a × (mouse); a left swipe deletes (touch).
 * `extra` is what follows the category in the sub-line (source, account); `moveLabel` is "From → To" for a move.
 */
export const TxnRow = memo(function TxnRow(props: {
  t: Txn
  base: string
  catName: string
  onOpen: (t: Txn, e: MouseEvent) => void
  onDelete: (t: Txn) => void
  selected?: boolean
  plain?: boolean
  extra?: string
  moveLabel?: string
  /** currency a move arrived in, when it differs from the one it left */
  toCur?: string
}) {
  const { t, base, catName } = props
  const isMove = t.kind === 'move'
  const title = t.note || (isMove && props.moveLabel ? props.moveLabel : t.kind ? KIND_LABEL[t.kind] : catName)
  // A move names its accounts in the sub-line only when a note took the title.
  const sub = isMove
    ? t.note
      ? props.moveLabel
      : ''
    : [title !== catName && !props.plain && !(t.kind && t.cat === RTA) ? catName : '', props.extra].filter(Boolean).join(' · ')
  const positive = t.base > 0
  const sw = useSwipeDelete<HTMLDivElement, HTMLButtonElement>(() => props.onDelete(t))

  function click(e: MouseEvent) {
    if (sw.swallow(e)) return
    props.onOpen(t, e)
  }

  return (
    <div class={`txn-wrap${props.selected ? ' sel' : ''}`} ref={sw.wrap}>
      <div class="txn-del" aria-hidden="true">
        Delete
      </div>
      <button
        ref={sw.row}
        class={`txn${props.selected ? ' sel' : ''}`}
        onClick={click}
        {...sw.handlers}
        data-txn={t.id}
      >
        <div class="txn-main">
          <div class="txn-title">{title}</div>
          {sub && <div class="txn-sub">{sub}</div>}
        </div>
        <div class="txn-amt">
          {isMove ? (
            // Money that only changed place: neither spent nor earned.
            <>
              <span class="num">{fmt(Math.abs(t.amt), t.cur)}</span>
              {props.toCur && t.toAmt !== undefined && <small class="num">{fmt(t.toAmt, props.toCur)}</small>}
            </>
          ) : (
            <>
              <span class={`num${positive ? ' pos' : ''}`}>{fmt(t.base, base, { sign: positive })}</span>
              {t.cur !== base && <small class="num">{fmt(t.amt, t.cur)}</small>}
            </>
          )}
        </div>
      </button>
      <button class="txn-x" tabIndex={-1} aria-label="Delete" onClick={() => props.onDelete(t)}>
        ×
      </button>
    </div>
  )
})

/** Pills for accounts; a currency tag when the list mixes currencies. */
function AccountPills(props: { list: Account[]; value: ID | undefined; onPick: (a: Account) => void; label: string; tag?: boolean }) {
  return (
    <>
      {props.list.map((a) => (
        <button key={a.id} class="pill soft sm" aria-label={`${props.label} ${a.name}`} aria-pressed={props.value === a.id} onClick={() => props.onPick(a)}>
          {a.name}
          {props.tag && <small>{a.cur}</small>}
        </button>
      ))}
    </>
  )
}

/** Edit a transaction. Every change applies right away (and can be undone). */
export function TxnSheet(props: { txn: Txn | null; today: string; onClose: () => void }) {
  const ix = useIndex()
  const t = props.txn ? ix.db.txns[props.txn.id] ?? props.txn : null
  const [amount, setAmount] = useState('')
  const [arrived, setArrived] = useState('')
  const [note, setNote] = useState('')

  // Show what is stored: when the sheet opens, and whenever the record changes underneath it (undo, sync).
  // A field with text typed into it (different from what the record last put there) is left alone;
  // one that is merely focused takes the restored value, so leaving it can't re-apply the old text.
  const stored = useRef({ Amount: '', Arrived: '', Note: '' })
  useEffect(() => {
    if (!t) return
    const focus = document.activeElement instanceof HTMLInputElement ? document.activeElement.getAttribute('aria-label') : null
    const toCur = t.to ? ix.db.accounts[t.to]?.cur : undefined
    const a = amountText(t.amt, t.cur)
    const r = t.toAmt !== undefined && toCur ? amountText(t.toAmt, toCur) : ''
    const n = t.note ?? ''
    if (!(focus === 'Amount' && amount !== stored.current.Amount)) setAmount(a)
    if (!(focus === 'Arrived' && arrived !== stored.current.Arrived)) setArrived(r)
    if (!(focus === 'Note' && note !== stored.current.Note)) setNote(n)
    stored.current = { Amount: a, Arrived: r, Note: n }
  }, [t?.id, t?.amt, t?.cur, t?.note, t?.toAmt, t?.to])

  if (!t || t.d) return <Sheet open={false} onClose={props.onClose} children={null} />
  const tx = t
  const isMove = tx.kind === 'move'
  const currencies = [...new Set([...currenciesInUse().filter(hasRate), tx.cur])]
  const cats = ix.cats.filter((c) => !c.archived || c.id === tx.cat)
  const refund = tx.cat !== RTA && tx.amt > 0

  // Accounts show when they are tracked, or when this entry already names one.
  const cash = cashAccounts(ix)
  const own = tx.acct ? ix.db.accounts[tx.acct] : undefined
  const acctChoices = own && !own.d && !cash.some((a) => a.id === own.id) ? [...cash, own] : cash
  const showAcct = !tx.kind && (!!own || (!!ix.settings.trackAccounts && cash.length > 0))
  const sources = ix.settings.sources ?? []
  const showSrc = tx.cat === RTA && !tx.kind && (sources.length > 0 || !!tx.src)

  function change(patch: Partial<NewTxn>, label = 'Edited') {
    undoable(label, () => updateTxn(tx.id, patch))
    toast(label, { undo: true })
  }

  function setCategory(cat: string) {
    if (cat === tx.cat) return
    const income = cat === RTA
    // Income is money in; spending is money out (a refund keeps its sign).
    const amt = income ? Math.abs(tx.amt) : refund ? tx.amt : -Math.abs(tx.amt)
    // A source belongs to income only.
    change({ cat, amt, ...(income ? {} : { src: undefined }) }, 'Changed category')
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
    // A move that arrived as another amount keeps its rate.
    const toAmt = isMove && tx.toAmt !== undefined && tx.amt ? Math.round((tx.toAmt * signed) / tx.amt) : undefined
    if (signed !== tx.amt) change({ amt: signed, ...(toAmt !== undefined ? { toAmt } : {}) }, 'Changed amount')
  }

  function pickAccount(a: Account) {
    change({ acct: tx.acct === a.id ? undefined : a.id }, 'Changed account')
  }

  // Moves: from and to are accounts; what arrives is in the receiving account's currency.
  const from = isMove && tx.acct ? ix.db.accounts[tx.acct] : undefined
  const to = isMove && tx.to ? ix.db.accounts[tx.to] : undefined
  const mixed = isMove && !!from && !!to && from.cur !== to.cur

  function moveTo(nextFrom: Account, nextTo: Account) {
    // The figure stays; what arrives is re-estimated at today's rates when the currencies differ.
    const toAmt = nextFrom.cur !== nextTo.cur ? convert(Math.abs(tx.amt), nextFrom.cur, nextTo.cur, ix.settings.rates, ix.settings.base) : undefined
    change({ acct: nextFrom.id, to: nextTo.id, cur: nextFrom.cur, toAmt }, 'Changed account')
  }
  function pickFrom(a: Account) {
    if (a.id === tx.acct || !to) return
    // Choosing the receiving account as the sender swaps the two.
    moveTo(a, a.id === tx.to && from ? from : to)
  }
  function pickTo(a: Account) {
    if (a.id === tx.to || !from) return
    if (a.id === tx.acct && to) return moveTo(to, a)
    moveTo(from, a)
  }
  function commitArrived(raw: string) {
    if (!to || tx.toAmt === undefined) return
    if (raw.trim() === amountText(tx.toAmt, to.cur)) return
    const v = evalAmount(raw, to.cur)
    if (v === null || v === 0) {
      setArrived(amountText(tx.toAmt, to.cur))
      return
    }
    setArrived(amountText(Math.abs(v), to.cur))
    if (Math.abs(v) !== tx.toAmt) change({ toAmt: Math.abs(v) }, 'Changed amount')
  }

  const title = tx.kind ? KIND_LABEL[tx.kind] : tx.cat === RTA ? 'Income' : refund ? 'Refund' : 'Spending'
  const allAccts = isMove ? accountsInOrder(ix) : []
  const mixedList = new Set(allAccts.map((a) => a.cur)).size > 1

  return (
    <Sheet open onClose={props.onClose} title={title}>
      <AmountField label="Amount" cur={tx.cur} value={amount} onInput={setAmount} onCommit={commitAmount} />
      {mixed && (
        <div class="row" style={{ marginTop: '8px', gap: '8px', alignItems: 'center' }}>
          <AmountField label="Arrived" cur={to!.cur} class="grow" value={arrived} onInput={setArrived} onCommit={commitArrived} />
          <span class="faint">{to!.cur}</span>
        </div>
      )}
      {!isMove && currencies.length > 1 && (
        <div class="row" style={{ marginTop: '10px', flexWrap: 'wrap' }}>
          {currencies.map((c) => (
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
        </div>
      )}
      {showAcct && (
        <div class="pills" style={{ marginTop: '10px' }}>
          <AccountPills list={acctChoices} value={tx.acct} onPick={pickAccount} label="Account" />
        </div>
      )}
      {showSrc && (
        <div class="pills" style={{ marginTop: '10px' }}>
          {sources.map((s) => (
            <button key={s.id} class="pill soft sm" aria-pressed={tx.src === s.id} onClick={() => change({ src: tx.src === s.id ? undefined : s.id }, 'Changed source')}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: '8px' }}>
        <NoteField
          value={note}
          onInput={setNote}
          onCommit={(v) => {
            if (v.trim() !== (tx.note ?? '')) change({ note: v.trim() || undefined }, 'Edited note')
          }}
        />
      </div>
      <div class="txn-split">
        <div class="txn-funds">
          <div class="txn-funds-in">
            {isMove ? (
              <>
                <span class="txn-lbl">From</span>
                <AccountPills list={allAccts} value={tx.acct} onPick={pickFrom} label="From" tag={mixedList} />
                <span class="txn-lbl">To</span>
                <AccountPills list={allAccts} value={tx.to} onPick={pickTo} label="To" tag={mixedList} />
              </>
            ) : (
              <>
                <button class="pill soft sm" aria-pressed={tx.cat === RTA} onClick={() => setCategory(RTA)}>
                  Income
                </button>
                {cats.map((c) => (
                  <button key={c.id} class="pill soft sm" aria-pressed={tx.cat === c.id} onClick={() => setCategory(c.id)}>
                    {c.name}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
        <div class="txn-cal">
          <Calendar
            value={tx.date}
            today={props.today}
            max={props.today}
            onChange={(d) => {
              if (d !== tx.date) change({ date: d }, 'Changed date')
            }}
          />
        </div>
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
