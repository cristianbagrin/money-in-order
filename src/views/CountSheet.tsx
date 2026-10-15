import { useEffect, useMemo, useState } from 'preact/hooks'
import { CURRENCIES, fmt, parseAmount } from '../lib/money'
import { refreshRates } from '../lib/rates'
import { addAccount, lastCount, previewCount, recordCount, settings, updateSettings } from '../lib/store'
import { live, RTA, type ID } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { Field, Sheet, toast } from '../ui/kit'

/**
 * Count your money: type the real balance of every account. The app compares the total with
 * what the budget expected and books the difference, so the plan always matches reality.
 */
export function CountSheet(props: { open: boolean; onClose: () => void; today: string }) {
  const ix = useIndex()
  const base = ix.settings.base
  const accounts = live(ix.db.accounts).sort((a, b) => a.order - b.order)
  const prev = lastCount()
  const [vals, setVals] = useState<Record<ID, string>>({})
  const [diffTo, setDiffTo] = useState<ID>(RTA)
  const [newName, setNewName] = useState('')
  const [newCur, setNewCur] = useState(base)

  useEffect(() => {
    if (props.open) {
      setVals({})
      setDiffTo(RTA)
      void refreshRates()
    }
  }, [props.open])

  const bal = useMemo(() => {
    const out: Record<ID, number> = {}
    for (const a of accounts) {
      const v = parseAmount(vals[a.id] ?? '')
      out[a.id] = v ?? 0
    }
    return out
  }, [vals, accounts.length])
  const filled = accounts.length > 0 && accounts.every((a) => (vals[a.id] ?? '').trim() !== '')
  const result = previewCount({ date: props.today, bal, rates: ix.settings.rates })

  function save() {
    const r = recordCount({ date: props.today, bal, rates: ix.settings.rates, diffTo })
    props.onClose()
    if (r.first) toast(`Starting with ${fmt(r.total, base)}. Now give it jobs.`)
    else if (r.diff === 0 && r.fx === 0) toast('Counted. Everything matches.')
    else toast(`Counted ${fmt(r.total, base)}. Budget corrected by ${fmt(r.diff + r.fx, base, { sign: true })}.`)
  }

  function add() {
    if (!newName.trim()) return
    addAccount(newName.trim(), newCur)
    if (newCur !== base && !settings().extraCurrencies.includes(newCur)) {
      updateSettings({ extraCurrencies: [...settings().extraCurrencies, newCur] })
      void refreshRates(true)
    }
    setNewName('')
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Count your money">
      <p class="muted" style={{ margin: '10px 0 4px', fontSize: '14px' }}>
        Open each account and type what's really there.{prev ? ` Last count: ${prev.date}.` : ''}
      </p>
      <ul class="lines">
        {accounts.map((a) => (
          <li key={a.id}>
            <div class="grow">
              <b style={{ fontWeight: 560 }}>{a.name}</b>
              <div class="faint" style={{ fontSize: '12px' }}>
                {a.cur}
                {prev?.bal[a.id] !== undefined && ` · last ${fmt(prev.bal[a.id], a.cur)}`}
              </div>
            </div>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0"
              style={{ width: '42%', textAlign: 'right' }}
              class="num"
              value={vals[a.id] ?? ''}
              onInput={(e) => setVals({ ...vals, [a.id]: e.currentTarget.value })}
            />
          </li>
        ))}
      </ul>
      <div class="row" style={{ marginTop: '10px' }}>
        <input type="text" class="grow" placeholder="New account" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} />
        <select style={{ width: '96px' }} value={newCur} onChange={(e) => setNewCur(e.currentTarget.value)}>
          {Object.keys(CURRENCIES).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button class="btn ghost" onClick={add} disabled={!newName.trim()}>
          Add
        </button>
      </div>

      {accounts.length > 0 && (
        <div class="section">
          <ul class="lines">
            <li>
              <span class="grow">Counted</span>
              <span class="num">{fmt(result.total, base)}</span>
            </li>
            {!result.first && (
              <li>
                <span class="grow">Budget expected</span>
                <span class="num faint">{fmt(result.expected, base)}</span>
              </li>
            )}
            {result.fx !== 0 && (
              <li>
                <span class="grow">
                  Exchange rates moved
                  <small class="faint" style={{ display: 'block', fontSize: '12px' }}>
                    goes to Ready to assign
                  </small>
                </span>
                <span class={`num ${result.fx < 0 ? 'neg' : 'pos'}`}>{fmt(result.fx, base, { sign: true })}</span>
              </li>
            )}
            {!result.first && (
              <li class="total-rule">
                <span class="grow">{result.diff < 0 ? 'Missing (probably unlogged spending)' : result.diff > 0 ? 'Extra money' : 'Difference'}</span>
                <span class={`num ${result.diff < 0 ? 'neg' : result.diff > 0 ? 'pos' : ''}`}>{fmt(result.diff, base, { sign: true })}</span>
              </li>
            )}
          </ul>
          {result.first && (
            <p class="field-hint">This is your starting money. It goes to Ready to assign, where you give every bit of it a job.</p>
          )}
          {!result.first && result.diff !== 0 && (
            <Field
              label={result.diff < 0 ? 'Where did it go?' : 'Where should it go?'}
              hint={result.diff < 0 ? 'Pick the category you most likely forgot to log, or take it from Ready to assign.' : 'Usually Ready to assign.'}
            >
              <select value={diffTo} onChange={(e) => setDiffTo(e.currentTarget.value)}>
                <option value={RTA}>Ready to assign</option>
                {ix.cats
                  .filter((c) => !c.archived)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <button class="btn block green" style={{ marginTop: '16px' }} disabled={!filled} onClick={save}>
            {result.first ? 'Start with this' : 'Save count'}
          </button>
          {!filled && <p class="field-hint" style={{ textAlign: 'center' }}>Fill in every account (0 is fine).</p>}
        </div>
      )}
    </Sheet>
  )
}
