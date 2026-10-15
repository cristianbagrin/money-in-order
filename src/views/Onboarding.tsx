import { useState } from 'preact/hooks'
import { CURRENCIES, parseAmount } from '../lib/money'
import { refreshRates } from '../lib/rates'
import { addAccount, recordCount, seedCategories, settings, today, updateSettings } from '../lib/store'
import { enableSync, normalizeCode } from '../lib/sync'
import { getDB } from '../lib/store'
import { RTA } from '../lib/types'
import { Field, toast } from '../ui/kit'

const COMMON = ['TWD', 'EUR', 'PLN', 'USD', 'GBP', 'CHF', 'JPY', 'CZK']

interface DraftAccount {
  name: string
  cur: string
  bal: string
}

export function Onboarding(props: { joinCode?: string; onDone: () => void }) {
  const [step, setStep] = useState<'welcome' | 'setup' | 'join'>(props.joinCode ? 'join' : 'welcome')
  const [base, setBase] = useState('TWD')
  const [extra, setExtra] = useState<string[]>(['EUR', 'PLN'])
  const [accounts, setAccounts] = useState<DraftAccount[]>([
    { name: 'Cash', cur: 'TWD', bal: '' },
    { name: 'Revolut', cur: 'PLN', bal: '' },
  ])
  const [code, setCode] = useState(props.joinCode ?? '')
  const [busy, setBusy] = useState(false)

  if (step === 'welcome') {
    return (
      <div class="welcome">
        <h1>
          Money
          <br />
          in Order
        </h1>
        <p class="lede">A plan for every bit of money you have, and a two-tap habit for everything you spend.</p>
        <ol class="rules">
          <li>
            <span>
              <b>Give every bit of money a job</b>
              <span>Count what you really have, then plan it down to zero.</span>
            </span>
          </li>
          <li>
            <span>
              <b>Log it the moment you spend</b>
              <span>Type the amount, tap the category. See what's left for today.</span>
            </span>
          </li>
          <li>
            <span>
              <b>Roll with it</b>
              <span>Overspent? Move money from somewhere else. The plan stays honest.</span>
            </span>
          </li>
          <li>
            <span>
              <b>Fund the big things monthly</b>
              <span>Trips, a new phone, yearly bills: a little every month, no surprises.</span>
            </span>
          </li>
        </ol>
        <div class="foot">
          <button class="btn block" onClick={() => setStep('setup')}>
            Set up my budget
          </button>
          <button class="btn ghost block" onClick={() => setStep('join')}>
            I already use it on another device
          </button>
        </div>
      </div>
    )
  }

  if (step === 'join') {
    return (
      <div class="welcome">
        <h1 style={{ fontSize: '34px' }}>Join your other device</h1>
        <p class="lede">On the device you already use, open Settings → Sync between devices and copy the code. Type or paste it here.</p>
        <Field label="Sync code">
          <input type="text" class="num" value={code} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autocapitalize="characters" onInput={(e) => setCode(e.currentTarget.value)} />
        </Field>
        <div class="foot">
          <button
            class="btn block"
            disabled={busy || !normalizeCode(code)}
            onClick={async () => {
              const c = normalizeCode(code)
              if (!c) return
              setBusy(true)
              await enableSync(c)
              setBusy(false)
              if (getDB().meta.settings?.ready) {
                history.replaceState(null, '', '#/today')
                props.onDone()
              } else toast('Nothing found for that code yet. Check it, or sync once on the other device.')
            }}
          >
            {busy ? 'Connecting…' : 'Join'}
          </button>
          <button class="btn ghost block" onClick={() => setStep('welcome')}>
            Back
          </button>
        </div>
      </div>
    )
  }

  const currencies = [base, ...extra.filter((c) => c !== base)]
  const ready = accounts.some((a) => a.name.trim())

  async function finish() {
    setBusy(true)
    updateSettings({ base, extraCurrencies: extra.filter((c) => c !== base) })
    await refreshRates(true)
    seedCategories()
    const bal: Record<string, number> = {}
    for (const a of accounts) {
      if (!a.name.trim()) continue
      const acct = addAccount(a.name.trim(), a.cur)
      bal[acct.id] = parseAmount(a.bal) ?? 0
    }
    recordCount({ date: today(), bal, rates: settings().rates, diffTo: RTA })
    updateSettings({ ready: 1 })
    setBusy(false)
    history.replaceState(null, '', '#/plan')
    props.onDone()
  }

  return (
    <div class="welcome" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 28px)' }}>
      <h1 style={{ fontSize: '34px' }}>Count your money</h1>
      <p class="lede">Every account, every wallet. This is what you'll plan with.</p>

      <Field label="I plan in">
        <select value={base} onChange={(e) => setBase(e.currentTarget.value)}>
          {Object.keys(CURRENCIES).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <span class="field-label">I also hold or spend</span>
      <div class="chips" style={{ paddingTop: '8px' }}>
        {COMMON.filter((c) => c !== base).map((c) => (
          <button key={c} class={`pill${extra.includes(c) ? ' on' : ''}`} onClick={() => setExtra(extra.includes(c) ? extra.filter((x) => x !== c) : [...extra, c])}>
            {c}
          </button>
        ))}
      </div>

      <span class="field-label" style={{ marginTop: '12px' }}>
        Accounts and their balance right now
      </span>
      <ul class="lines">
        {accounts.map((a, i) => (
          <li key={i}>
            <input
              type="text"
              class="grow"
              placeholder="Name"
              value={a.name}
              onInput={(e) => setAccounts(accounts.map((x, k) => (k === i ? { ...x, name: e.currentTarget.value } : x)))}
            />
            <select style={{ width: '84px' }} value={a.cur} onChange={(e) => setAccounts(accounts.map((x, k) => (k === i ? { ...x, cur: e.currentTarget.value } : x)))}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <input
              type="text"
              inputMode="decimal"
              class="num"
              placeholder="0"
              style={{ width: '30%', textAlign: 'right' }}
              value={a.bal}
              onInput={(e) => setAccounts(accounts.map((x, k) => (k === i ? { ...x, bal: e.currentTarget.value } : x)))}
            />
          </li>
        ))}
      </ul>
      <button class="link" style={{ alignSelf: 'flex-start' }} onClick={() => setAccounts([...accounts, { name: '', cur: base, bal: '' }])}>
        + Another account
      </button>
      <div class="foot" style={{ marginTop: '28px' }}>
        <button class="btn block" disabled={!ready || busy} onClick={finish}>
          {busy ? 'Setting up…' : 'Start planning'}
        </button>
        <p class="field-hint" style={{ textAlign: 'center' }}>
          Categories from your spreadsheet are ready to go. Rename or add any later.
        </p>
      </div>
    </div>
  )
}
