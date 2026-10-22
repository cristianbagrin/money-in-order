import { useEffect, useRef, useState } from 'preact/hooks'
import { monthName } from '../lib/dates'
import { transactionsCSV } from '../lib/export'
import { importSheet, loggedIn, readSheetFile, type SheetFile } from '../lib/sheetImport'
import { refreshRates } from '../lib/rates'
import { addAccount, changeBase, deleteAccount, restoreBackup, saveAccount, settings, unarchiveCategory, undoable, updateSettings } from '../lib/store'
import { disableSync } from '../lib/sync'
import { AccountForm } from '../ui/account'
import { live, type Account, type DB } from '../lib/types'
import { CurrencyPicker } from '../ui/currency'
import { useIndex, useSync } from '../ui/hooks'
import { IconPlus, Section, toast } from '../ui/kit'
import { play, setSoundOn, soundOn } from '../ui/sound'

export function Settings(props: { onCount: () => void; onBack: () => void }) {
  const ix = useIndex()
  const s = ix.settings
  const [sound, setSound] = useState(soundOn())
  const [sheet, setSheet] = useState<SheetFile | null>(null)

  return (
    <div>
      <div class="pagehead">
        <h1>Settings</h1>
        <button class="pill sm settings-done" onClick={props.onBack}>
          Done
        </button>
      </div>

      <SyncBox />

      <Section title="Accounts">
        <Accounts onCount={props.onCount} />
      </Section>

      <Section title="Currencies">
        <CurrencyPicker
          selected={[s.base, ...s.extraCurrencies]}
          main={s.base}
          onChange={async (selected, main) => {
            if (main !== s.base) {
              // The first tap of the double-tap may have removed it: keep it selected whatever happens next.
              updateSettings({ extraCurrencies: selected.filter((c) => c !== s.base) })
              if (!settings().rates[main]) await refreshRates(true)
              if (!settings().rates[main]) {
                play('error')
                return toast('Couldn’t get an exchange rate. Try again online.')
              }
              if (!confirm(`Plan in ${main} from now on? Every amount is converted at today's rate.`)) return
              undoable(`Plan in ${main}`, () => changeBase(main))
              play('success')
              toast(`Your plan is now in ${main}`, { undo: true })
              void refreshRates(true)
              return
            }
            updateSettings({ extraCurrencies: selected.filter((c) => c !== main) })
            void refreshRates(true)
          }}
        />
      </Section>

      <Section title="Save each month">
        <div class="pills">
          {[0.1, 0.15, 0.2, 0.25, 0.3, 0.4].map((v) => (
            <button
              key={v}
              class="pill"
              aria-pressed={Math.abs(s.savingsTarget - v) < 0.001}
              onClick={() => {
                updateSettings({ savingsTarget: v })
              }}
            >
              {Math.round(v * 100)}%
            </button>
          ))}
        </div>
      </Section>

      <Section>
        <div class="pills">
          <button
            class="pill toggle"
            aria-pressed={sound}
            onClick={() => {
              setSoundOn(!sound)
              setSound(!sound)
              if (!sound) play('success')
            }}
          >
            Sound
          </button>
        </div>
      </Section>

      <Archived />

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
                  if (!confirm('Replace everything here with this backup?')) return
                  undoable('Restored backup', () => restoreBackup(data))
                  play('success')
                  toast('Backup restored', { undo: true })
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
          <label class="pill" style={{ cursor: 'pointer' }}>
            Import sheet
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0]
                e.currentTarget.value = ''
                const file = f && readSheetFile(await f.text())
                if (file) setSheet(file)
                else if (f) {
                  play('error')
                  toast('That isn’t a sheet import file')
                }
              }}
            />
          </label>
        </div>
        {sheet && <SheetImport file={sheet} onDone={() => setSheet(null)} />}
      </Section>
    </div>
  )
}

/** One-time import of months kept in a spreadsheet (temporary). */
function SheetImport(props: { file: SheetFile; onDone: () => void }) {
  const months = props.file.months.map((m) => ({ m: m.month, n: m.txns.length, here: loggedIn(m.month).length }))
  // Months with entries logged here already are left alone unless chosen.
  const [chosen, setChosen] = useState(months.filter((x) => !x.here).map((x) => x.m))
  const toggle = (m: string) => setChosen(chosen.includes(m) ? chosen.filter((x) => x !== m) : [...chosen, m])
  const replacing = months.filter((x) => x.here && chosen.includes(x.m))
  return (
    <div class="card" style={{ marginTop: '10px' }}>
      <div class="pills">
        {months.map((x) => (
          <button key={x.m} class="pill soft" aria-pressed={chosen.includes(x.m)} onClick={() => toggle(x.m)}>
            {monthName(x.m)} <small>{x.n}</small>
          </button>
        ))}
      </div>
      {replacing.length > 0 && (
        <p class="hint">
          Replaces what you logged here in {replacing.map((x) => `${monthName(x.m)} (${x.here})`).join(' and ')}.
        </p>
      )}
      <div class="cs-foot" style={{ marginTop: '12px' }}>
        <button class="link" onClick={props.onDone}>
          Cancel
        </button>
        <button
          class="link"
          disabled={!chosen.length}
          onClick={() => {
            const n = undoable('Imported sheet', () => importSheet(props.file, chosen, replacing.map((x) => x.m)))
            play('success')
            toast(`${n} entries imported`, { undo: true })
            props.onDone()
          }}
        >
          Import
        </button>
      </div>
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

function Accounts(props: { onCount: () => void }) {
  const ix = useIndex()
  const s = ix.settings
  const accounts = live(ix.db.accounts).sort((a, b) => a.order - b.order)
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
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
            setOpen(null)
            setAdding(true)
          }}
        >
          <IconPlus />
        </button>
        <button class="pill" onClick={props.onCount}>
          Count your money
        </button>
      </div>
      {adding && <NewAccount currencies={currencies} onDone={() => setAdding(false)} />}
      {editing && <AccountEditor key={editing.id} a={editing} currencies={currencies} onDone={() => setOpen(null)} />}
    </>
  )
}

function NewAccount(props: { currencies: string[]; onDone: () => void }) {
  const [name, setName] = useState('')
  const [cur, setCur] = useState(props.currencies[0])
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])
  const add = () => {
    if (!name.trim()) return
    undoable(`Added ${name.trim()}`, () => addAccount(name.trim(), cur))
    props.onDone()
  }
  return (
    <div class="card" style={{ marginTop: '10px' }}>
      <input
        type="text"
        aria-label="New account name"
        spellcheck={false} autocorrect="off"
        ref={nameRef}
        value={name}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add()
          if (e.key === 'Escape') props.onDone()
        }}
      />
      <div class="pills" style={{ marginTop: '10px' }}>
        {props.currencies.map((c) => (
          <button key={c} class="pill sm soft" aria-pressed={cur === c} onClick={() => setCur(c)}>
            {c}
          </button>
        ))}
      </div>
      <div class="cs-foot" style={{ marginTop: '12px' }}>
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

function Archived() {
  const ix = useIndex()
  const archived = ix.cats.filter((c) => c.archived)
  if (!archived.length) return null
  return (
    <Section title="Archived">
      <div class="pills">
        {archived.map((c) => (
          <button
            key={c.id}
            class="pill"
            onClick={() => {
              undoable(`Brought back ${c.name}`, () => unarchiveCategory(c.id))
              play('success')
              toast(`${c.name} is back`, { undo: true })
            }}
          >
            {c.name} <small>bring back</small>
          </button>
        ))}
      </div>
    </Section>
  )
}

function AccountEditor(props: { a: Account; currencies: string[]; onDone: () => void }) {
  const { a } = props
  return (
    <div class="card" style={{ marginTop: '10px' }}>
      <input
        type="text"
        aria-label="Account name"
        spellcheck={false} autocorrect="off"
        defaultValue={a.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim()
          if (!name) e.currentTarget.value = a.name
          else if (name !== a.name) saveAccount({ ...a, name })
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div class="pills" style={{ marginTop: '10px' }}>
        {[...new Set([...props.currencies, a.cur])].map((c) => (
          <button
            key={c}
            class="pill sm soft"
            aria-pressed={a.cur === c}
            onClick={() => {
              saveAccount({ ...a, cur: c })
            }}
          >
            {c}
          </button>
        ))}
      </div>
      <div class="cs-foot" style={{ marginTop: '12px' }}>
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
  // Not signed in. A device still on a sync code from before accounts keeps syncing meanwhile.
  if (!sync.email) {
    return (
      <Section title="Sync">
        <AccountForm />
        {(navigator as Navigator & { standalone?: boolean }).standalone === false && (
          <p class="hint">Add this app to your Home Screen first, then sign in there.</p>
        )}
      </Section>
    )
  }

  const status =
    sync.state === 'syncing'
      ? 'Syncing…'
      : sync.state === 'offline' || sync.state === 'error'
        ? sync.error
        : sync.last
          ? `Synced ${new Date(sync.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'On'
  return (
    <Section title="Sync">
      <div class="signed-in">
        <span class="grow">
          <b>{sync.email}</b>
          <small class={sync.state === 'error' ? 'neg' : 'muted'}>{status}</small>
        </span>
        <button
          class="pill sm"
          onClick={async () => {
            if (!confirm('Sign out on this device? Your data stays here.')) return
            await disableSync()
          }}
        >
          Sign out
        </button>
      </div>
    </Section>
  )
}
