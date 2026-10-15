import { useEffect, useMemo, useState } from 'preact/hooks'
import { evalAmount, fmt } from '../lib/money'
import { refreshRates } from '../lib/rates'
import { lastCount, previewCount, recordCount, undoable } from '../lib/store'
import { live, RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { toast } from '../ui/kit'
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

  useEffect(() => {
    if (!props.open) return
    setVals({})
    setDiffTo(RTA)
    void refreshRates()
  }, [props.open])

  const bal = useMemo(() => {
    const out: Record<ID, number> = {}
    for (const a of accounts) out[a.id] = evalAmount(vals[a.id] ?? '') ?? 0
    return out
  }, [vals, accounts.length])
  const filled = accounts.length > 0 && accounts.every((a) => (vals[a.id] ?? '').trim() !== '')
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
      {accounts.map((a) => (
        <div class="row" key={a.id} style={{ minHeight: '56px', borderBottom: '1px solid var(--rule)' }}>
          <span class="grow">
            <b style={{ fontWeight: 600 }}>{a.name}</b>
            {prev?.bal[a.id] !== undefined && (
              <span class="faint num" style={{ display: 'block', fontSize: '12px' }}>
                last {fmt(prev.bal[a.id], a.cur)}
              </span>
            )}
          </span>
          <input
            type="text"
            inputMode="decimal"
            class="num"
            aria-label={`${a.name} balance in ${a.cur}`}
            style={{ width: '46%', textAlign: 'right' }}
            placeholder={a.cur}
            value={vals[a.id] ?? ''}
            onFocus={(e) => e.currentTarget.select()}
            onInput={(e) => setVals({ ...vals, [a.id]: e.currentTarget.value })}
          />
        </div>
      ))}
      <button class="link" onClick={props.onAccounts}>
        Edit accounts
      </button>

      {accounts.length > 0 && filled && (
        <div class="section">
          <div class="row" style={{ justifyContent: 'space-between', fontSize: '15px' }}>
            <span>{r.first ? 'Your money' : 'Counted'}</span>
            <b class="num">{fmt(r.total, base)}</b>
          </div>
          {!r.first && (
            <div class="row" style={{ justifyContent: 'space-between', fontSize: '14px', marginTop: '6px' }}>
              <span class="muted">{gap === 0 ? 'Matches your plan' : gap < 0 ? 'Missing from your plan' : 'More than your plan'}</span>
              <span class={`num ${gap < 0 ? 'neg' : gap > 0 ? 'pos' : 'faint'}`}>{fmt(gap, base, { sign: true })}</span>
            </div>
          )}
          {!r.first && r.fx !== 0 && <p class="hint">{fmt(r.fx, base, { sign: true })} of that is exchange rates.</p>}
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
                    play('toggle')
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
                        play('toggle')
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
      <button class="btn block green" style={{ marginTop: '20px' }} disabled={!filled} onClick={save}>
        Save
      </button>
    </Sheet>
  )
}
