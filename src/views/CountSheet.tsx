import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { evalAmount, fmt } from '../lib/money'
import { hasRate, refreshRates } from '../lib/rates'
import { lastCount, previewCount, recordCount, undoable } from '../lib/store'
import { live, RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { AmountField, toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'

/**
 * Count your money: type each account's real balance. The difference from what the plan expected
 * is booked so the plan matches reality.
 */
export function CountSheet(props: { open: boolean; onClose: () => void; onAccounts: () => void; today: string }) {
  const ix = useIndex()
  const base = ix.settings.base
  const accounts = live(ix.db.accounts).sort((a, b) => a.order - b.order)
  const prev = lastCount()
  const [vals, setVals] = useState<Record<ID, string>>({})
  const [diffTo, setDiffTo] = useState<ID>(RTA)
  const saveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!props.open) return
    setVals({})
    setDiffTo(RTA)
    void refreshRates()
  }, [props.open])

  const bal = useMemo(() => {
    const out: Record<ID, number> = {}
    for (const a of accounts) out[a.id] = evalAmount(vals[a.id] ?? '', a.cur) ?? 0
    return out
  }, [vals, ix.db.accounts])
  const invalid = (a: { id: ID; cur: string }) => (vals[a.id] ?? '').trim() !== '' && evalAmount(vals[a.id], a.cur) === null
  const noRate = accounts.filter((a) => !hasRate(a.cur)).map((a) => a.cur)
  const filled =
    accounts.length > 0 && accounts.every((a) => (vals[a.id] ?? '').trim() !== '' && !invalid(a)) && !noRate.length
  const r = previewCount({ date: props.today, bal, rates: ix.settings.rates })
  const gap = r.diff + r.fx

  function save() {
    const res = undoable('Counted', () => recordCount({ date: props.today, bal, rates: ix.settings.rates, diffTo }))
    play('success')
    props.onClose()
    if (res.first) toast(`Starting with ${fmt(res.total, base)}`, { undo: true })
    else if (!res.diff && !res.fx) toast('Everything matches', { undo: true })
    else toast(`Corrected by ${fmt(res.diff + res.fx, base, { sign: true })}`, { undo: true })
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Count your money">
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
        {accounts.map((a) => (
          <div class="count-row" key={a.id}>
            <span class="grow">
              <b>{a.name}</b>
              <span class="faint num count-sub">
                {a.cur}
                {prev?.bal[a.id] !== undefined && ` · last ${fmt(prev.bal[a.id], prev.curs?.[a.id] ?? a.cur)}`}
              </span>
            </span>
            <AmountField
              class={`count-amt${invalid(a) ? ' bad' : ''}`}
              label={`${a.name} balance in ${a.cur}`}
              value={vals[a.id] ?? ''}
              onInput={(v) => setVals((all) => ({ ...all, [a.id]: v }))}
            />
          </div>
        ))}
      </div>
      <button class="link" onClick={props.onAccounts}>
        Edit accounts
      </button>

      {accounts.length > 0 && filled && (
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
      <button class="btn block" ref={saveRef} style={{ marginTop: '20px' }} disabled={!filled} onClick={save}>
        Save
      </button>
    </Sheet>
  )
}
