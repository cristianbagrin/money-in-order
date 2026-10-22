import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { balances, type Balance } from '../lib/accounts'
import { evalAmount, fmt } from '../lib/money'
import { hasRate, refreshRates } from '../lib/rates'
import { previewCount, recordCount, undoable } from '../lib/store'
import { RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { AmountField, toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'
import { dayText } from './AccountsSheet'

/**
 * Update balances: type the real balance of any accounts, the rest stay as they are (their field shows
 * the balance kept). The difference from what the plan expected is booked so the plan matches reality;
 * investments alone never touch the plan.
 */
export function CountSheet(props: { open: boolean; onClose: () => void; onAccounts: () => void; today: string }) {
  const ix = useIndex()
  const base = ix.settings.base
  const known = balances(ix)
  const cash = known.filter((b) => !b.acct.invest)
  const invest = known.filter((b) => b.acct.invest)
  const accounts = known.map((b) => b.acct)
  const [vals, setVals] = useState<Record<ID, string>>({})
  const [diffTo, setDiffTo] = useState<ID>(RTA)
  const saveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!props.open) return
    setVals({})
    setDiffTo(RTA)
    void refreshRates()
  }, [props.open])

  // An empty field is not typed: that account keeps the balance it has.
  const typed = (id: ID) => (vals[id] ?? '').trim() !== ''
  const invalid = (a: { id: ID; cur: string }) => typed(a.id) && evalAmount(vals[a.id], a.cur) === null
  const bal = useMemo(() => {
    const out: Record<ID, number> = {}
    for (const a of accounts) if (typed(a.id)) out[a.id] = evalAmount(vals[a.id], a.cur) ?? 0
    return out
  }, [vals, ix.db.accounts])
  const noRate = [...new Set(accounts.filter((a) => !hasRate(a.cur)).map((a) => a.cur))]
  const any = accounts.some((a) => typed(a.id))
  const ready = any && !accounts.some(invalid) && !noRate.length
  const r = previewCount({ date: props.today, bal, rates: ix.settings.rates })
  const gap = r.diff + r.fx

  function save() {
    const res = undoable('Updated balances', () => recordCount({ date: props.today, bal, rates: ix.settings.rates, diffTo }))
    play('success')
    props.onClose()
    if (!res.cash) toast('Investments updated', { undo: true })
    else if (res.first) toast(`Starting with ${fmt(res.total, base)}`, { undo: true })
    else if (!res.diff && !res.fx) toast('Everything matches', { undo: true })
    else toast(`Corrected by ${fmt(res.diff + res.fx, base, { sign: true })}`, { undo: true })
  }

  const field = (b: Balance) => {
    const a = b.acct
    return (
      <div class="count-row" key={a.id}>
        <span class="grow">
          <b>{a.name}</b>
          <span class="faint num count-sub">
            {a.cur}
            {!b.tracked && b.asOf && ` · ${a.invest ? 'updated' : 'counted'} ${dayText(b.asOf, props.today)}`}
          </span>
        </span>
        <div class="count-box">
          <AmountField
            class={`count-amt${invalid(a) ? ' bad' : ''}`}
            label={`${a.name} balance in ${a.cur}`}
            value={vals[a.id] ?? ''}
            onInput={(v) => setVals((all) => ({ ...all, [a.id]: v }))}
          />
          {/* The balance kept, until something is typed. */}
          {!typed(a.id) && (
            <span class="count-ph num" aria-hidden="true">
              {fmt(b.bal, a.cur, { bare: true })}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Update balances">
      {/* Enter walks down the accounts, then to Save. */}
      <div
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          const fields = [...e.currentTarget.querySelectorAll('input')]
          const i = fields.indexOf(e.target as HTMLInputElement)
          if (i < 0) return
          // (Without this the same Enter would also press Save once the focus lands on it.)
          e.preventDefault()
          if (i < fields.length - 1) fields[i + 1].focus()
          else saveRef.current?.focus()
        }}
      >
        {cash.map(field)}
        {invest.length > 0 && <h3 class="count-head">Investments</h3>}
        {invest.map(field)}
      </div>
      <button class="link" onClick={props.onAccounts}>
        Edit accounts
      </button>

      {r.cash && ready && (
        <div class="section">
          <div class="row" style={{ justifyContent: 'space-between', fontSize: '15px' }}>
            <span>{r.first ? 'Your money' : 'Counted'}</span>
            <b class="num">{fmt(r.total, base)}</b>
          </div>
          {!r.first && gap === 0 && <p class="muted" style={{ fontSize: '14px', margin: '6px 0 0' }}>Matches your plan</p>}
          {!r.first && r.fx !== 0 && (
            <div class="row" style={{ justifyContent: 'space-between', fontSize: '14px', marginTop: '6px' }}>
              <span class="muted">Exchange rates</span>
              <span class={`num ${r.fx < 0 ? 'neg' : 'pos'}`}>{fmt(r.fx, base, { sign: true })}</span>
            </div>
          )}
          {!r.first && r.diff !== 0 && (
            <div class="row" style={{ justifyContent: 'space-between', fontSize: '14px', marginTop: '6px' }}>
              <span class="muted">{r.diff < 0 ? 'Missing' : 'Extra'}</span>
              <span class={`num ${r.diff < 0 ? 'neg' : 'pos'}`}>{fmt(r.diff, base, { sign: true })}</span>
            </div>
          )}
          {!r.first && r.diff !== 0 && (
            <>
              <p class="section-title" style={{ marginTop: '18px' }}>
                {r.diff < 0 ? 'Where did it go?' : 'Where should it go?'}
              </p>
              <div class="pills">
                <button
                  class="pill soft"
                  aria-pressed={diffTo === RTA}
                  onClick={() => {
                    setDiffTo(RTA)
                  }}
                >
                  Ready to assign
                </button>
                {ix.cats
                  .filter((c) => !c.archived)
                  .map((c) => (
                    <button
                      key={c.id}
                      class="pill soft"
                      aria-pressed={diffTo === c.id}
                      onClick={() => {
                        setDiffTo(c.id)
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
      {noRate.length > 0 && <p class="hint neg">No exchange rate for {noRate.join(', ')} yet. Connect to the internet and try again.</p>}
      <button class="btn block" ref={saveRef} style={{ marginTop: '20px' }} disabled={!ready} onClick={save}>
        Save
      </button>
    </Sheet>
  )
}
