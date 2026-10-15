import { useState } from 'preact/hooks'
import { transactionsCSV } from '../lib/export'
import { merge } from '../lib/merge'
import { refreshRates } from '../lib/rates'
import { addAccount, changeBase, deleteAccount, getDB, replaceDB, saveAccount, undoable, updateSettings } from '../lib/store'
import { codeHasData, disableSync, enableSync, newCode, normalizeCode, syncNow } from '../lib/sync'
import { live, type Account, type DB } from '../lib/types'
import { CurrencyPicker } from '../ui/currency'
import { useIndex, useSync } from '../ui/hooks'
import { IconPlus, Section, toast } from '../ui/kit'
import { play, setSoundOn, soundOn } from '../ui/sound'

export function Settings(props: { onCount: () => void; onBack: () => void }) {
  const ix = useIndex()
  const s = ix.settings
  const [sound, setSound] = useState(soundOn())

  return (
    <div>
      <div class="pagehead">
        <h1 style={{ fontSize: '20px' }}>Settings</h1>
        <button class="pill sm" onClick={props.onBack}>
          Done
        </button>
      </div>

      <SyncBox />

      <Section title="Accounts">
        <Accounts />
        <button class="btn soft block" style={{ marginTop: '12px' }} onClick={props.onCount}>
          Count your money
        </button>
      </Section>

      <Section title="Currencies">
        <CurrencyPicker
          selected={[s.base, ...s.extraCurrencies]}
          main={s.base}
          onChange={async (selected, main) => {
            if (main !== s.base) {
              if (!s.rates[main]) await refreshRates(true)
              if (!confirm(`Plan in ${main} from now on? Every amount in your plan is converted at today's rate.`)) return
              if (!undoable(`Plan in ${main}`, () => changeBase(main))) return toast('Couldn’t get an exchange rate. Try again online.')
              toast(`Your plan is now in ${main}`, { undo: true })
              void refreshRates(true)
              return
            }
            updateSettings({ extraCurrencies: selected.filter((c) => c !== main) })
            void refreshRates(true)
          }}
        />
        <p class="hint">Double-tap the one you plan in.</p>
      </Section>

      <Section title="Save each month">
        <div class="pills">
          {[0.1, 0.15, 0.2, 0.25, 0.3, 0.4].map((v) => (
            <button
              key={v}
              class="pill"
              aria-pressed={Math.abs(s.savingsTarget - v) < 0.001}
              onClick={() => {
                play('toggle')
                updateSettings({ savingsTarget: v })
              }}
            >
              {Math.round(v * 100)}%
            </button>
          ))}
        </div>
      </Section>

      <Section title="Sound">
        <div class="pills">
          <button
            class="pill"
            aria-pressed={sound}
            onClick={() => {
              setSoundOn(!sound)
              setSound(!sound)
              if (!sound) play('success')
            }}
          >
            {sound ? 'On' : 'Off'}
          </button>
        </div>
      </Section>

      <Section title="Your data">
        <div class="pills">
          <button class="pill" onClick={() => share(`money-in-order-${stamp()}.json`, JSON.stringify(ix.db), 'application/json')}>
            Save backup
          </button>
          <label class="pill" style={{ cursor: 'pointer' }}>
            Restore
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0]
                if (!f) return
                try {
                  const data = JSON.parse(await f.text()) as DB
                  if (!data.cats || !data.txns) throw new Error('not a backup')
                  replaceDB(merge(getDB(), data), { local: true })
                  play('success')
                  toast('Backup restored')
                } catch {
                  play('error')
                  toast('That isn’t a Money in Order backup')
                }
              }}
            />
          </label>
          <button class="pill" onClick={() => share(`money-in-order-${stamp()}.csv`, transactionsCSV(ix), 'text/csv')}>
            Transactions CSV
          </button>
        </div>
      </Section>
    </div>
  )
}

function stamp() {
  return new Date().toISOString().slice(0, 10)
}

async function share(name: string, text: string, type: string) {
  const file = new File([text], name, { type })
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean }
  if (nav.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch {
      /* fall through to download */
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function Accounts() {
  const ix = useIndex()
  const s = ix.settings
  const accounts = live(ix.db.accounts).sort((a, b) => a.order - b.order)
  const [open, setOpen] = useState<string | null>(null)
  const currencies = [s.base, ...s.extraCurrencies]
  const editing = accounts.find((a) => a.id === open)

  return (
    <>
      <div class="pills">
        {accounts.map((a) => (
          <button key={a.id} class="pill soft" aria-pressed={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
            {a.name} <small>{a.cur}</small>
          </button>
        ))}
        <button
          class="pill ghost"
          aria-label="Add an account"
          onClick={() => {
            const a = addAccount('New account', s.base)
            setOpen(a.id)
          }}
        >
          <IconPlus />
        </button>
      </div>
      {editing && <AccountEditor key={editing.id} a={editing} currencies={currencies} onDone={() => setOpen(null)} />}
    </>
  )
}

function AccountEditor(props: { a: Account; currencies: string[]; onDone: () => void }) {
  const { a } = props
  return (
    <div class="card" style={{ marginTop: '10px' }}>
      <input
        type="text"
        aria-label="Account name"
        defaultValue={a.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim()
          if (name && name !== a.name) saveAccount({ ...a, name })
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div class="pills" style={{ marginTop: '10px' }}>
        {[...new Set([...props.currencies, a.cur])].map((c) => (
          <button
            key={c}
            class="pill sm"
            aria-pressed={a.cur === c}
            onClick={() => {
              play('toggle')
              saveAccount({ ...a, cur: c })
            }}
          >
            {c}
          </button>
        ))}
      </div>
      <div class="cs-foot" style={{ marginTop: '12px' }}>
        <button class="link" onClick={props.onDone}>
          Done
        </button>
        <button
          class="link red"
          onClick={() => {
            undoable(`Removed ${a.name}`, () => deleteAccount(a.id))
            play('delete')
            props.onDone()
            toast(`${a.name} removed`, { undo: true })
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}

function SyncBox() {
  const sync = useSync()
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)

  if (!sync.code) {
    return (
      <Section title="Sync">
        <button
          class="btn block"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await enableSync(newCode())
            setBusy(false)
            play('success')
          }}
        >
          Turn on sync
        </button>
        <div class="row" style={{ marginTop: '10px' }}>
          <input
            type="text"
            class="grow num"
            aria-label="Sync code from your other device"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            value={joinCode}
            autocapitalize="characters"
            onInput={(e) => setJoinCode(e.currentTarget.value)}
          />
          <button
            class="pill"
            disabled={busy || !normalizeCode(joinCode)}
            onClick={async () => {
              const code = normalizeCode(joinCode)
              if (!code) return
              setBusy(true)
              const exists = await codeHasData(code).catch(() => false)
              if (!exists && !confirm('Nothing is stored under that code yet. Use it anyway?')) {
                setBusy(false)
                return
              }
              await enableSync(code)
              setBusy(false)
              play('success')
              toast('Joined')
            }}
          >
            Join
          </button>
        </div>
      </Section>
    )
  }

  const status =
    sync.state === 'syncing'
      ? 'Syncing…'
      : sync.state === 'offline'
        ? 'Offline, will sync when back online'
        : sync.state === 'error'
          ? `Couldn’t sync: ${sync.error}`
          : sync.last
            ? `Synced ${new Date(sync.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'On'
  return (
    <Section title="Sync">
      <p class={sync.state === 'error' ? 'neg' : 'muted'} style={{ margin: '0 0 10px', fontSize: '14px' }}>
        {status}
      </p>
      <div class="code">{sync.code}</div>
      <div class="pills" style={{ marginTop: '10px' }}>
        <button
          class="pill"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(sync.code!)
              play('tap')
              toast('Code copied')
            } catch {
              toast(sync.code!)
            }
          }}
        >
          Copy code
        </button>
        <button class="pill" onClick={() => void syncNow()}>
          Sync now
        </button>
        <button
          class="pill"
          onClick={async () => {
            if (!confirm('Stop syncing on this device? Your data stays here.')) return
            await disableSync()
          }}
        >
          Turn off
        </button>
      </div>
      <p class="hint">On iPhone: add the app to your Home Screen, open it from there, then enter this code.</p>
    </Section>
  )
}
