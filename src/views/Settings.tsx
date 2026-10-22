import { useEffect, useRef, useState } from 'preact/hooks'
import { transactionsCSV } from '../lib/export'
import { refreshRates } from '../lib/rates'
import { accountsInOrder } from '../lib/accounts'
import { addSource, changeBase, deleteSource, renameSource, restoreBackup, setTrackAccounts, settings, sources, unarchiveCategory, undoable, updateSettings } from '../lib/store'
import { disableSync } from '../lib/sync'
import { AccountForm, NO_AUTOFILL } from '../ui/account'
import type { DB, Source } from '../lib/types'
import { CurrencyPicker } from '../ui/currency'
import { useIndex, useSync } from '../ui/hooks'
import { IconPlus, Section, toast } from '../ui/kit'
import { play, setSoundOn, soundOn } from '../ui/sound'
import '../ui/accounts.css'

export function Settings(props: { onAccounts: () => void; onBack: () => void }) {
  const ix = useIndex()
  const s = ix.settings
  const [sound, setSound] = useState(soundOn())

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
        <Accounts onAccounts={props.onAccounts} />
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

      <Section title="Income">
        <Sources />
      </Section>

      <Section title="Save of each month’s income">
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

/** The accounts; tapping one opens the same sheet the rail's Total money does, where they are edited. */
function Accounts(props: { onAccounts: () => void }) {
  const ix = useIndex()
  const accounts = accountsInOrder(ix)
  return (
    <div class="pills">
      {accounts.map((a) => (
        <button key={a.id} class="pill" onClick={props.onAccounts}>
          {a.name} <small>{a.invest ? 'investment' : a.cur}</small>
        </button>
      ))}
      <button class="pill ghost" aria-label="Add an account" onClick={props.onAccounts}>
        <IconPlus />
      </button>
      <button class="pill toggle" aria-pressed={!!ix.settings.trackAccounts} onClick={() => setTrackAccounts(!ix.settings.trackAccounts)}>
        Track accounts
      </button>
    </div>
  )
}

/** Income sources: pills, a + that turns into a name field, a tap to rename or remove. */
function Sources() {
  useIndex()
  const list = sources()
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const editing = list.find((x) => x.id === open)

  return (
    <>
      <div class="pills">
        {list.map((x) => (
          <button
            key={x.id}
            class="pill"
            aria-pressed={open === x.id}
            onClick={() => {
              setAdding(false)
              setOpen(open === x.id ? null : x.id)
            }}
          >
            {x.name}
          </button>
        ))}
        {adding ? (
          <NewSource onDone={() => setAdding(false)} />
        ) : (
          <button
            class="pill ghost"
            aria-label="Add an income source"
            onClick={() => {
              setOpen(null)
              setAdding(true)
            }}
          >
            <IconPlus />
          </button>
        )}
      </div>
      {editing && <SourceEditor key={editing.id} x={editing} onDone={() => setOpen(null)} />}
    </>
  )
}

function NewSource(props: { onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => ref.current?.focus(), [])
  // Enter adds, Esc cancels; leaving the field with a name typed adds it too.
  const finish = (add: boolean) => {
    if (done.current) return
    done.current = true
    const name = ref.current?.value.trim()
    if (add && name) {
      undoable(`Added ${name}`, () => addSource(name))
      play('success')
    }
    props.onDone()
  }
  return (
    <input
      {...NO_AUTOFILL}
      ref={ref}
      type="text"
      class="pill-input"
      aria-label="Name"
      placeholder="Name"
      autocapitalize="words"
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

function SourceEditor(props: { x: Source; onDone: () => void }) {
  const { x } = props
  return (
    <div class="acc-form">
      <input
        {...NO_AUTOFILL}
        type="text"
        aria-label="Name"
        autocapitalize="words"
        defaultValue={x.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const name = e.currentTarget.value.trim()
          if (!name) e.currentTarget.value = x.name
          else if (name !== x.name) undoable(`Renamed ${x.name}`, () => renameSource(x.id, name))
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <div class="cs-foot">
        <button
          class="link red"
          onClick={() => {
            undoable(`Removed ${x.name}`, () => deleteSource(x.id))
            play('delete')
            props.onDone()
            toast(`${x.name} removed`, { undo: true })
          }}
        >
          Remove
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
