import { useState } from 'preact/hooks'
import { evalAmount } from '../lib/money'
import { hasRate, refreshRates } from '../lib/rates'
import { addAccount, getDB, recordCount, seedCategories, settings, today, updateSettings } from '../lib/store'
import { joinSync, normalizeCode } from '../lib/sync'
import { RTA } from '../lib/types'
import { CurrencyPicker } from '../ui/currency'
import { IconPlus, regroup, toast } from '../ui/kit'
import { play } from '../ui/sound'

interface DraftAccount {
  name: string
  cur: string
  bal: string
}

export function Onboarding(props: { joinCode?: string; onDone: () => void }) {
  const [step, setStep] = useState<'welcome' | 'setup' | 'join'>(props.joinCode ? 'join' : 'welcome')
  const [main, setMain] = useState('TWD')
  const [selected, setSelected] = useState<string[]>(['TWD', 'EUR', 'PLN'])
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
        <ol class="rules">
          <li>
            <span>
              <b>Give every bit of money a job</b>
              <span>Count what you have, then plan it down to zero.</span>
            </span>
          </li>
          <li>
            <span>
              <b>Log it the moment you spend</b>
              <span>Type the amount, tap the category.</span>
            </span>
          </li>
          <li>
            <span>
              <b>Roll with it</b>
              <span>Overspent? Move money from somewhere else.</span>
            </span>
          </li>
          <li>
            <span>
              <b>Fund the big things monthly</b>
              <span>Trips, a new phone, yearly bills: a little every month.</span>
            </span>
          </li>
        </ol>
        <div class="foot">
          <button class="btn block" onClick={() => setStep('setup')}>
            Set up my budget
          </button>
          <button class="btn soft block" onClick={() => setStep('join')}>
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
        <p class="lede">Settings → Sync on your other device shows the code.</p>
        <input
          type="text"
          class="num"
          style={{ marginTop: '24px' }}
          aria-label="Sync code"
          spellcheck={false}
          autocorrect="off"
          value={code}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          autocapitalize="characters"
          onInput={(e) => setCode(e.currentTarget.value)}
        />
        <div class="foot">
          <button
            class="btn block"
            disabled={busy || !normalizeCode(code)}
            onClick={async () => {
              const c = normalizeCode(code)
              if (!c) return
              setBusy(true)
              const r = await joinSync(c)
              setBusy(false)
              if (r === 'joined' && getDB().meta.settings?.ready) {
                play('success')
                history.replaceState(null, '', '#/today')
                props.onDone()
              } else {
                play('error')
                toast(r === 'error' ? 'Couldn’t reach the server' : 'Nothing is stored under that code')
              }
            }}
          >
            {busy ? 'Connecting…' : 'Join'}
          </button>
          <button class="btn soft block" onClick={() => setStep('welcome')}>
            Back
          </button>
        </div>
      </div>
    )
  }

  const ready = accounts.some((a) => a.name.trim())
  const curs = [main, ...selected.filter((c) => c !== main)]

  async function finish() {
    setBusy(true)
    updateSettings({ base: main, extraCurrencies: selected.filter((c) => c !== main) })
    await refreshRates(true)
    // Never count foreign money 1:1: without a rate, stop and say so.
    const used = accounts.filter((a) => a.name.trim()).map((a) => (curs.includes(a.cur) ? a.cur : main))
    const missing = [...new Set(used)].filter((c) => !hasRate(c))
    if (missing.length) {
      setBusy(false)
      play('error')
      toast(`Couldn’t get exchange rates for ${missing.join(', ')}. Check your connection.`)
      return
    }
    seedCategories()
    const bal: Record<string, number> = {}
    for (const a of accounts) {
      if (!a.name.trim()) continue
      const acct = addAccount(a.name.trim(), curs.includes(a.cur) ? a.cur : main)
      bal[acct.id] = evalAmount(a.bal, acct.cur) ?? 0
    }
    // With no balances typed yet, the first real count becomes the starting balance.
    if (Object.values(bal).some((v) => v !== 0)) recordCount({ date: today(), bal, rates: settings().rates, diffTo: RTA })
    updateSettings({ ready: 1 })
    setBusy(false)
    play('success')
    history.replaceState(null, '', '#/plan')
    props.onDone()
  }

  return (
    <div class="welcome" style={{ paddingTop: 'calc(env(safe-area-inset-top) + 28px)' }}>
      <h1 style={{ fontSize: '34px' }}>Your money</h1>

      <div style={{ marginTop: '22px' }}>
        <CurrencyPicker
          selected={selected}
          main={main}
          onChange={(sel, m) => {
            setSelected(sel)
            setMain(m)
          }}
        />
        <p class="hint">Tap the currencies you use. Double-tap the one you plan in.</p>
      </div>

      <div style={{ marginTop: '18px' }}>
        {accounts.map((a, i) => (
          <div class="acct-row" key={i}>
            <input
              type="text"
              aria-label="Account name"
              spellcheck={false} autocorrect="off"
              value={a.name}
              onInput={(e) => setAccounts(accounts.map((x, k) => (k === i ? { ...x, name: e.currentTarget.value } : x)))}
            />
            <button
              class="pill sm"
              aria-label={`Currency ${a.cur}. Tap to change`}
              onClick={() => {
                const next = curs[(curs.indexOf(a.cur) + 1) % curs.length] ?? main
                setAccounts(accounts.map((x, k) => (k === i ? { ...x, cur: next } : x)))
              }}
            >
              {curs.includes(a.cur) ? a.cur : main}
            </button>
            <input
              type="text"
              inputMode="decimal"
              class="num"
              aria-label={`${a.name || 'Account'} balance`}
              placeholder="0"
              style={{ textAlign: 'right' }}
              value={a.bal}
              onFocus={(e) => e.currentTarget.select()}
              onInput={(e) => {
                const bal = regroup(e, { numbersOnly: true })
                setAccounts(accounts.map((x, k) => (k === i ? { ...x, bal } : x)))
              }}
            />
          </div>
        ))}
        <button class="pill ghost" style={{ marginTop: '12px' }} onClick={() => setAccounts([...accounts, { name: '', cur: main, bal: '' }])}>
          <IconPlus /> Account
        </button>
      </div>

      <div class="foot">
        <button class="btn block" disabled={!ready || busy} onClick={finish}>
          {busy ? 'Setting up…' : 'Start planning'}
        </button>
      </div>
    </div>
  )
}
