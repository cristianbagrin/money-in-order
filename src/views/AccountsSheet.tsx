import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { balances, investmentsInPlan, netWorth, totalMoney, type Balance } from '../lib/accounts'
import { dayOfMonth, monthName, monthOf } from '../lib/dates'
import { convert, cur, evalAmount, fmt, groupTyped } from '../lib/money'
import { hasRate, refreshRates } from '../lib/rates'
import { addAccount, addMove, deleteAccount, placeAccountOfKind, previewCount, recordCount, saveAccount, setInvestment, takeOutOfPlan, undoable } from '../lib/store'
import { RTA, type Account, type Day, type ID } from '../lib/types'
import { NO_AUTOFILL } from '../ui/account'
import { useIndex } from '../ui/hooks'
import { AnyCurrency, CurrencyPill } from '../ui/currency'
import { AmountField, IconPlus, toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'
import { sortKey, useSortable } from '../ui/sortable'
import { useSwipeDelete } from '../ui/swipe'
import '../ui/accounts.css'

/** How an amount appears in a field: no grouping beyond thousands, and no cents for currencies without them. */
function amountText(minor: number, code: string): string {
  const v = Math.abs(minor) / 100
  return groupTyped(cur(code).decimals ? String(Math.round(v * 100) / 100) : String(Math.round(v)))
}

/** "3 Oct" (with the year when it isn't this one). */
function dayText(d: Day, today: Day): string {
  const y = d.slice(0, 4)
  return `${dayOfMonth(d)} ${monthName(monthOf(d), { short: true })}${y === today.slice(0, 4) ? '' : ` ${y}`}`
}

/**
 * Where the money is: every account's balance, the total, and the few things you do with them.
 * Tap a balance to type what is really there (updating balances): the accounts left alone keep theirs, and
 * the difference from what the plan expected is booked so the plan matches reality. Investments alone never
 * touch the plan. `count` opens it ready to type the first balance.
 */
export function AccountsSheet(props: {
  open: boolean
  onClose: () => void
  /** open with a balance ready to type: the first account's, or with 'invest' the first investment's */
  count?: boolean | 'invest'
  today: Day
}) {
  const ix = useIndex()
  const { base, trackAccounts } = ix.settings
  const [form, setForm] = useState<'add' | 'move' | { edit: ID } | null>(null)
  const [vals, setVals] = useState<Record<ID, string>>({})
  const [editing, setEditing] = useState<ID | null>(null)
  const [diffTo, setDiffTo] = useState<ID>(RTA)
  const saveRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const cashRef = useRef<HTMLDivElement>(null)
  const investRef = useRef<HTMLDivElement>(null)

  const all = balances(ix)
  const first = all[0]?.acct.id
  useEffect(() => {
    if (!props.open) return
    setForm(null)
    setVals({})
    setDiffTo(RTA)
    setEditing(null)
    void refreshRates()
    if (!props.count) return
    const pick = props.count === 'invest' ? (all.find((b) => b.acct.invest)?.acct.id ?? first) : first
    const t = setTimeout(() => setEditing(pick ?? null), 60)
    return () => clearTimeout(t)
  }, [props.open])

  const cash = all.filter((b) => !b.acct.invest)
  const invest = all.filter((b) => b.acct.invest)
  const accounts = all.map((b) => b.acct)
  const edit = typeof form === 'object' && form ? form.edit : null

  // An empty field is not typed: that account keeps the balance it has.
  const typed = (id: ID) => (vals[id] ?? '').trim() !== ''
  const invalid = (a: Account) => typed(a.id) && evalAmount(vals[a.id], a.cur) === null
  const bal = useMemo(() => {
    const out: Record<ID, number> = {}
    for (const a of accounts) if (typed(a.id)) out[a.id] = evalAmount(vals[a.id], a.cur) ?? 0
    return out
  }, [vals, ix.db.accounts])
  const noRate = [...new Set(accounts.filter((a) => typed(a.id) && !hasRate(a.cur)).map((a) => a.cur))]
  const any = accounts.some((a) => typed(a.id))
  const ready = any && !accounts.some(invalid) && !noRate.length
  // Hold and drag a row to reorder, within cash or within investments. Not while something is being typed.
  const sortable = {
    disabled: any || !!form || editing !== null,
    onDrop: (info: { id: string; index: number }) => {
      undoable('Moved account', () => placeAccountOfKind(info.id, info.index))
      play('drop')
    },
  }
  useSortable(cashRef, sortable)
  useSortable(investRef, sortable)
  const r = any ? previewCount({ date: props.today, bal, rates: ix.settings.rates }) : null

  // Enter in a balance goes on to the next account's, and after the last one to Save.
  const next = (id: ID) => {
    const i = accounts.findIndex((a) => a.id === id)
    if (i < accounts.length - 1) {
      const n = accounts[i + 1].id
      const open = listRef.current?.querySelector<HTMLInputElement>(`[data-acct="${n}"] input`)
      if (open) open.focus()
      else setEditing(n)
    } else saveRef.current?.focus()
  }

  const cancel = () => {
    setVals({})
    setEditing(null)
    setDiffTo(RTA)
  }
  function save() {
    const res = undoable('Updated balances', () => recordCount({ date: props.today, bal, rates: ix.settings.rates, diffTo }))
    play('success')
    props.onClose()
    if (!res.cash) toast('Investments updated', { undo: true })
    else if (res.first) toast(`Starting with ${fmt(res.total, base)}`, { undo: true })
    else if (!res.diff && !res.fx) toast('Everything matches', { undo: true })
    else toast(`Corrected by ${fmt(res.diff + res.fx, base, { sign: true })}`, { undo: true })
  }

  // Shift + arrows on a name or balance moves the row, for the keyboard.
  const keys = (b: Balance, list: Balance[]) => (e: KeyboardEvent) => {
    const t = (e.target as HTMLElement).closest('.acc-name, .acc-amt')
    if (!t || sortable.disabled) return
    sortKey(e, list.indexOf(b), list.length, (to) => sortable.onDrop({ id: b.acct.id, index: to }), { focus: t.matches('.acc-amt') ? '.acc-amt' : '.acc-name' })
  }
  const row = (b: Balance, list: Balance[]) => (
    <div key={b.acct.id} data-sort-id={b.acct.id} onKeyDown={keys(b, list)}>
      <AccountRow
        b={b}
        base={base}
        today={props.today}
        open={edit === b.acct.id}
        onOpen={() => setForm(edit === b.acct.id ? null : { edit: b.acct.id })}
        field={editing === b.acct.id || typed(b.acct.id)}
        value={vals[b.acct.id] ?? ''}
        invalid={invalid(b.acct)}
        onEdit={() => setEditing(b.acct.id)}
        onInput={(v) => setVals((all) => ({ ...all, [b.acct.id]: v }))}
        onDone={() => setEditing((cur) => (cur === b.acct.id ? null : cur))}
        onEnter={() => next(b.acct.id)}
      />
      {edit === b.acct.id && <AccountEditor key={b.acct.id} a={b.acct} today={props.today} onDone={() => setForm(null)} />}
    </div>
  )

  // Closed, there is nothing to work out (while it slides away the sheet keeps what it last showed).
  if (!props.open) return <Sheet open={false} onClose={props.onClose} children={null} />

  const gap = r ? r.diff + r.fx : 0
  const line = (label: string, v: number) => (
    <div class="acc-line">
      <span class="muted">{label}</span>
      <span class={`num ${v < 0 ? 'neg' : 'pos'}`}>{fmt(v, base, { sign: true })}</span>
    </div>
  )

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Accounts">
      <div ref={listRef}>
        {cash.length > 0 && (
          <div class="acc-list" ref={cashRef}>
            {cash.map((b) => row(b, cash))}
            <div class="acc-total">
              <span>Total money</span>
              <b class="num marked">{fmt(totalMoney(ix), base)}</b>
            </div>
          </div>
        )}
        {invest.length > 0 && (
          <div class="acc-list" ref={investRef}>
            <h3 class="acc-head">Investments</h3>
            {invest.map((b) => row(b, invest))}
            <div class="acc-total">
              <span>Net worth</span>
              <b class="num marked">{fmt(netWorth(ix), base)}</b>
            </div>
          </div>
        )}
      </div>

      {investmentsInPlan(ix).map(({ acct }) => (
        <p class="acc-fix" key={acct.id}>
          <span>Total money still counts {acct.name}</span>
          <button
            class="link"
            onClick={() => {
              undoable(`Took ${acct.name} out of Total money`, () => takeOutOfPlan(acct.id, props.today))
              play('success')
              toast(`${acct.name} taken out of Total money`, { undo: true })
            }}
          >
            Take it out
          </button>
        </p>
      ))}

      {r && (
        <div class="acc-rec">
          {r.cash && (
            <>
              <div class="acc-line">
                <span>{r.first ? 'Your money' : 'Counted'}</span>
                <b class="num">{fmt(r.total, base)}</b>
              </div>
              {!r.first && gap === 0 && <p class="muted acc-ok">Matches your plan</p>}
              {!r.first && r.fx !== 0 && line('Exchange rates', r.fx)}
              {!r.first && r.diff !== 0 && line(r.diff < 0 ? 'Missing' : 'Extra', r.diff)}
              {!r.first && r.diff !== 0 && (
                <>
                  <p class="section-title">{r.diff < 0 ? 'Where did it go?' : 'Where should it go?'}</p>
                  <div class="pills">
                    <button class="pill soft" aria-pressed={diffTo === RTA} onClick={() => setDiffTo(RTA)}>
                      Ready to assign
                    </button>
                    {ix.cats
                      .filter((c) => !c.archived)
                      .map((c) => (
                        <button key={c.id} class="pill soft" aria-pressed={diffTo === c.id} onClick={() => setDiffTo(c.id)}>
                          {c.name}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </>
          )}
          {noRate.length > 0 && <p class="hint neg">No exchange rate for {noRate.join(', ')} yet. Connect to the internet and try again.</p>}
          <div class="acc-save">
            <button class="link" onClick={cancel}>
              Cancel
            </button>
            <button class="btn" ref={saveRef} disabled={!ready} onClick={save}>
              Save
            </button>
          </div>
        </div>
      )}

      {!any && (
        <div class="pills acc-actions">
          {trackAccounts && all.length > 1 && (
            <button class="pill" aria-pressed={form === 'move'} onClick={() => setForm(form === 'move' ? null : 'move')}>
              Move money
            </button>
          )}
          <button class="pill ghost" aria-pressed={form === 'add'} onClick={() => setForm(form === 'add' ? null : 'add')}>
            <IconPlus /> Account
          </button>
        </div>
      )}

      {form === 'add' && <NewAccount onDone={() => setForm(null)} />}
      {form === 'move' && <MoveMoney accounts={accounts} today={props.today} onDone={() => setForm(null)} />}
    </Sheet>
  )
}

/** The name opens the account's editor; the balance turns into a field to type the real one. */
function AccountRow(props: {
  b: Balance
  base: string
  today: Day
  open: boolean
  onOpen: () => void
  field: boolean
  value: string
  invalid: boolean
  onEdit: () => void
  onInput: (v: string) => void
  onDone: () => void
  onEnter: () => void
}) {
  const { b, base } = props
  const a = b.acct
  const remove = () => removeAccount(a)
  const sw = useSwipeDelete<HTMLDivElement, HTMLDivElement>(remove)
  // When the balance was last typed in, and what it was then (a tracked balance has moved on since).
  const sub = b.asOf && b.typedBal !== null ? `Updated ${dayText(b.asOf, props.today)} · ${fmt(b.typedBal, a.cur)}` : a.invest ? 'No value yet' : 'Not counted'
  return (
    <div class="acc-wrap" ref={sw.wrap} data-acct={a.id}>
      <div class="swipe-del" aria-hidden="true">
        Remove
      </div>
      <div
        ref={sw.row}
        class="acc-row"
        {...sw.handlers}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !(e.target as HTMLElement).closest('.acc-count')) return
          // (Without this the same Enter would also press Save once the focus lands on it.)
          e.preventDefault()
          props.onEnter()
        }}
      >
        <button
          class="acc-name"
          aria-expanded={props.open}
          onClick={(e) => {
            if (!sw.swallow(e)) props.onOpen()
          }}
        >
          <b>{a.name}</b>
          {sub && <small class="acc-sub">{sub}</small>}
        </button>
        {props.field ? (
          <AmountField
            class={`acc-count${props.invalid ? ' bad' : ''}`}
            label={`${a.name} balance in ${a.cur}`}
            cur={a.cur}
            // the balance kept, until something is typed
            placeholder={fmt(b.bal, a.cur)}
            value={props.value}
            onInput={props.onInput}
            onCommit={props.onDone}
            autoFocus
          />
        ) : (
          <button
            class="acc-amt"
            aria-label={`${a.name} balance ${fmt(b.bal, a.cur)}, change`}
            onClick={(e) => {
              if (!sw.swallow(e)) props.onEdit()
            }}
          >
            <span class="num">{fmt(b.bal, a.cur)}</span>
            {a.cur !== base && <small class="num acc-sub">{fmt(b.base, base)}</small>}
          </button>
        )}
      </div>
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
        <CurPills list={currencies} value={c} onPick={setC} />
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

function AccountEditor(props: { a: Account; today: Day; onDone: () => void }) {
  const { a } = props
  const ix = useIndex()
  const { base } = ix.settings
  const currencies = [...new Set([base, ...ix.settings.extraCurrencies, a.cur])]
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
        <CurPills list={currencies} value={a.cur} onPick={(c) => c !== a.cur && saveAccount({ ...a, cur: c })} />
        <button
          class="pill sm toggle"
          aria-pressed={!!a.invest}
          onClick={() => {
            // The balance leaves the plan's total with it (or comes back), in the same undoable step.
            const on = !a.invest
            const moved = undoable(on ? `${a.name} to investments` : `${a.name} to cash`, () => setInvestment(a.id, on, props.today))
            if (moved) toast(on ? `${fmt(-moved, base)} moved out of Total money` : `${fmt(moved, base)} back in Total money`, { undo: true })
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
        <AmountField label={`Amount in ${f.cur}`} cur={f.cur} class="acc-field" value={amount} onInput={(v) => (setAmount(v), setArrived(null))} autoFocus />
        <span class="acc-cur">{f.cur}</span>
      </div>
      {differ && (
        <div class="acc-move-amt">
          <AmountField label={`Arrived in ${t.cur}`} cur={t.cur} class="acc-field" value={shownArrived} onInput={setArrived} />
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

/** The currencies offered, one tap each; holding one offers every currency there is. */
function CurPills(props: { list: string[]; value: string; onPick: (code: string) => void }) {
  const [any, setAny] = useState(false)
  return (
    <>
      {[...new Set([...props.list, props.value])].map((x) => (
        <CurrencyPill key={x} code={x} class="sm" pressed={props.value === x} onTap={() => props.onPick(x)} onHold={() => setAny(true)} />
      ))}
      <AnyCurrency open={any} onClose={() => setAny(false)} value={props.value} onPick={props.onPick} />
    </>
  )
}
