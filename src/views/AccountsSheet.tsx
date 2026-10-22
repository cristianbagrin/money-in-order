import { useEffect, useRef, useState } from 'preact/hooks'
import { balances, netWorth, totalMoney, type Balance } from '../lib/accounts'
import { dayOfMonth, monthName, monthOf } from '../lib/dates'
import { convert, cur, evalAmount, fmt, groupTyped } from '../lib/money'
import { hasRate } from '../lib/rates'
import { addAccount, addMove, deleteAccount, saveAccount, undoable } from '../lib/store'
import type { Account, Day, ID } from '../lib/types'
import { NO_AUTOFILL } from '../ui/account'
import { useIndex } from '../ui/hooks'
import { AmountField, IconPlus, toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'
import { useSwipeDelete } from '../ui/swipe'
import '../ui/accounts.css'

/** How an amount appears in a field: no grouping beyond thousands, and no cents for currencies without them. */
function amountText(minor: number, code: string): string {
  const v = Math.abs(minor) / 100
  return groupTyped(cur(code).decimals ? String(Math.round(v * 100) / 100) : String(Math.round(v)))
}

/** "3 Oct" (with the year when it isn't this one). */
export function dayText(d: Day, today: Day): string {
  const y = d.slice(0, 4)
  return `${dayOfMonth(d)} ${monthName(monthOf(d), { short: true })}${y === today.slice(0, 4) ? '' : ` ${y}`}`
}

/** Where the money is: every account's balance, the total, and the few things you do with them. */
export function AccountsSheet(props: { open: boolean; onClose: () => void; onCount: () => void; today: Day }) {
  const ix = useIndex()
  const { base, trackAccounts } = ix.settings
  const [form, setForm] = useState<'add' | 'move' | { edit: ID } | null>(null)
  useEffect(() => {
    if (props.open) setForm(null)
  }, [props.open])

  const all = balances(ix)
  const cash = all.filter((b) => !b.acct.invest)
  const invest = all.filter((b) => b.acct.invest)
  const edit = typeof form === 'object' && form ? form.edit : null
  const row = (b: Balance) => (
    <div key={b.acct.id}>
      <AccountRow b={b} base={base} today={props.today} open={edit === b.acct.id} onOpen={() => setForm(edit === b.acct.id ? null : { edit: b.acct.id })} />
      {edit === b.acct.id && <AccountEditor key={b.acct.id} a={b.acct} onDone={() => setForm(null)} />}
    </div>
  )

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Accounts">
      {cash.length > 0 && (
        <div class="acc-list">
          {cash.map(row)}
          <div class="acc-total">
            <span>Total money</span>
            <b class="num marked">{fmt(totalMoney(ix), base)}</b>
          </div>
        </div>
      )}
      {invest.length > 0 && (
        <div class="acc-list">
          <h3 class="acc-head">Investments</h3>
          {invest.map(row)}
          <div class="acc-total">
            <span>Net worth</span>
            <b class="num marked">{fmt(netWorth(ix), base)}</b>
          </div>
        </div>
      )}

      <div class="pills acc-actions">
        <button class="pill" onClick={props.onCount}>
          Update balances
        </button>
        {trackAccounts && all.length > 1 && (
          <button class="pill" aria-pressed={form === 'move'} onClick={() => setForm(form === 'move' ? null : 'move')}>
            Move money
          </button>
        )}
        <button class="pill ghost" aria-pressed={form === 'add'} onClick={() => setForm(form === 'add' ? null : 'add')}>
          <IconPlus /> Account
        </button>
      </div>

      {form === 'add' && <NewAccount onDone={() => setForm(null)} />}
      {form === 'move' && <MoveMoney accounts={all.map((b) => b.acct)} today={props.today} onDone={() => setForm(null)} />}
    </Sheet>
  )
}

function AccountRow(props: { b: Balance; base: string; today: Day; open: boolean; onOpen: () => void }) {
  const { b, base } = props
  const a = b.acct
  const remove = () => removeAccount(a)
  const sw = useSwipeDelete<HTMLDivElement, HTMLButtonElement>(remove)
  // A tracked balance follows what you log; the others are as of the day they were typed in.
  const sub = b.tracked ? '' : b.asOf ? `${a.invest ? 'updated' : 'counted'} ${dayText(b.asOf, props.today)}` : a.invest ? 'no value yet' : 'not counted'
  return (
    <div class="acc-wrap" ref={sw.wrap}>
      <div class="swipe-del" aria-hidden="true">
        Remove
      </div>
      <button
        ref={sw.row}
        class="acc-row"
        aria-expanded={props.open}
        onClick={(e) => {
          if (!sw.swallow(e)) props.onOpen()
        }}
        {...sw.handlers}
      >
        <span class="grow">
          <b>{a.name}</b>
          {sub && <small class="acc-sub">{sub}</small>}
        </span>
        <span class="acc-amt">
          <span class="num">{fmt(b.bal, a.cur)}</span>
          {a.cur !== base && <small class="num acc-sub">{fmt(b.base, base)}</small>}
        </span>
      </button>
      <button class="acc-x" tabIndex={-1} aria-label={`Remove ${a.name}`} onClick={remove}>
        ×
      </button>
    </div>
  )
}

function removeAccount(a: Account) {
  undoable(`Removed ${a.name}`, () => deleteAccount(a.id))
  play('delete')
  toast(`${a.name} removed`, { undo: true })
}

/** Name, currency and the investment flag: the same fields to add an account and to change one. */
function NewAccount(props: { onDone: () => void }) {
  const ix = useIndex()
  const currencies = [ix.settings.base, ...ix.settings.extraCurrencies]
  const [name, setName] = useState('')
  const [c, setC] = useState(currencies[0])
  const [invest, setInvest] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const add = () => {
    const n = name.trim()
    if (!n) return
    undoable(`Added ${n}`, () => addAccount(n, c, { invest }))
    play('success')
    props.onDone()
    toast(`${n} added`, { undo: true })
  }
  return (
    <div class="acc-form">
      <input
        {...NO_AUTOFILL}
        type="text"
        ref={ref}
        aria-label="Bank or wallet"
        placeholder="Bank or wallet"
        autocapitalize="words"
        value={name}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
          if (e.key === 'Escape') props.onDone()
        }}
      />
      <div class="pills">
        {currencies.map((x) => (
          <button key={x} class="pill sm" aria-pressed={c === x} onClick={() => setC(x)}>
            {x}
          </button>
        ))}
        <button class="pill sm toggle" aria-pressed={invest} onClick={() => setInvest(!invest)}>
          Investment
        </button>
      </div>
      <div class="cs-foot">
        <button class="link" onClick={props.onDone}>
          Cancel
        </button>
        <button class="link" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  )
}

function AccountEditor(props: { a: Account; onDone: () => void }) {
  const { a } = props
  const ix = useIndex()
  const currencies = [...new Set([ix.settings.base, ...ix.settings.extraCurrencies, a.cur])]
  return (
    <div class="acc-form">
      <input
        {...NO_AUTOFILL}
        type="text"
        aria-label="Name"
        autocapitalize="words"
        defaultValue={a.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim()
          if (!name) e.currentTarget.value = a.name
          else if (name !== a.name) saveAccount({ ...a, name })
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div class="pills">
        {currencies.map((c) => (
          <button key={c} class="pill sm" aria-pressed={a.cur === c} onClick={() => saveAccount({ ...a, cur: c })}>
            {c}
          </button>
        ))}
        <button
          class="pill sm toggle"
          aria-pressed={!!a.invest}
          onClick={() => {
            const { invest: _, ...rest } = a
            saveAccount(a.invest ? rest : { ...rest, invest: 1 })
          }}
        >
          Investment
        </button>
      </div>
      <div class="cs-foot">
        <button
          class="link red"
          onClick={() => {
            props.onDone()
            removeAccount(a)
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}

/** Money from one account to another: the plan doesn't change, only where the money sits. */
function MoveMoney(props: { accounts: Account[]; today: Day; onDone: () => void }) {
  const ix = useIndex()
  const { base, rates } = ix.settings
  const [from, setFrom] = useState<ID>(props.accounts[0].id)
  const [to, setTo] = useState<ID>(props.accounts[1].id)
  const [amount, setAmount] = useState('')
  // What arrived, once typed over; until then it follows today's rate.
  const [arrived, setArrived] = useState<string | null>(null)
  const f = props.accounts.find((a) => a.id === from)!
  const t = props.accounts.find((a) => a.id === to)!
  const differ = f.cur !== t.cur
  const amt = evalAmount(amount, f.cur)
  const auto = amt && differ ? convert(amt, f.cur, t.cur, rates, base) : 0
  const shownArrived = arrived ?? (auto ? amountText(auto, t.cur) : '')
  const toAmt = differ ? evalAmount(shownArrived, t.cur) : undefined
  const noRate = differ && !(hasRate(f.cur) && hasRate(t.cur))
  const ok = !!amt && amt > 0 && (!differ || (!!toAmt && toAmt > 0)) && !noRate

  const pick = (which: 'from' | 'to', id: ID) => {
    setArrived(null)
    if (which === 'from') {
      setFrom(id)
      if (id === to) setTo(from)
    } else {
      setTo(id)
      if (id === from) setFrom(to)
    }
  }
  const move = () => {
    if (!ok || !amt) return
    undoable('Moved money', () => addMove({ date: props.today, from, to, amt, toAmt: differ ? toAmt ?? undefined : undefined }))
    play('success')
    props.onDone()
    toast(`Moved ${fmt(amt, f.cur)} to ${t.name}`, { undo: true })
  }
  const pills = (which: 'from' | 'to') => (
    <div class="pills">
      {props.accounts.map((a) => (
        <button key={a.id} class="pill sm" aria-pressed={(which === 'from' ? from : to) === a.id} onClick={() => pick(which, a.id)}>
          {a.name}
        </button>
      ))}
    </div>
  )
  return (
    <div class="acc-form">
      <span class="acc-lab">From</span>
      {pills('from')}
      <span class="acc-lab">To</span>
      {pills('to')}
      <div class="acc-move-amt">
        <AmountField label={`Amount in ${f.cur}`} class="acc-field" value={amount} onInput={(v) => (setAmount(v), setArrived(null))} autoFocus />
        <span class="acc-cur">{f.cur}</span>
      </div>
      {differ && (
        <div class="acc-move-amt">
          <AmountField label={`Arrived in ${t.cur}`} class="acc-field" value={shownArrived} onInput={setArrived} />
          <span class="acc-cur">{t.cur}</span>
        </div>
      )}
      {noRate && <p class="hint neg">No exchange rate for {f.cur} and {t.cur} yet. Connect to the internet and try again.</p>}
      <div class="cs-foot">
        <button class="link" onClick={props.onDone}>
          Cancel
        </button>
        <button class="link" disabled={!ok} onClick={move}>
          Move
        </button>
      </div>
    </div>
  )
}
