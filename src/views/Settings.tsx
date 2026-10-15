import { useState } from 'preact/hooks'
import { merge } from '../lib/merge'
import { CURRENCIES } from '../lib/money'
import { refreshRates } from '../lib/rates'
import { addGroup, deleteAccount, deleteGroup, getDB, replaceDB, saveGroup, unarchiveCategory, updateSettings } from '../lib/store'
import { codeHasData, disableSync, enableSync, newCode, normalizeCode, syncNow } from '../lib/sync'
import { live, type DB } from '../lib/types'
import { useIndex, useSync } from '../ui/hooks'
import { Field, toast } from '../ui/kit'

export function Settings(props: { header: preact.ComponentChildren; onCount: () => void; onBack: () => void }) {
  const ix = useIndex()
  const s = ix.settings
  const hasTxns = ix.txns.length > 0
  const [rateEdit, setRateEdit] = useState<Record<string, string>>({})
  const [addCur, setAddCur] = useState('')
  const [groupName, setGroupName] = useState('')
  const accounts = live(ix.db.accounts).sort((a, b) => a.order - b.order)

  return (
    <div>
      {props.header}
      <div class="topline" style={{ minHeight: '40px', paddingTop: 0 }}>
        <h1 style={{ fontSize: '17px', color: 'var(--ink)' }}>Settings</h1>
        <button class="link" onClick={props.onBack}>
          Back
        </button>
      </div>

      <SyncBox />

      <div class="section">
        <span class="label">Money</span>
        <ul class="lines">
          {accounts.map((a) => (
            <li key={a.id}>
              <span class="grow">{a.name}</span>
              <span class="faint num">{a.cur}</span>
              <button
                class="iconbtn"
                aria-label={`Remove ${a.name}`}
                onClick={() => confirm(`Remove ${a.name}? Past counts keep their numbers.`) && deleteAccount(a.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button class="btn ghost block" style={{ marginTop: '12px' }} onClick={props.onCount}>
          Count your money · add accounts
        </button>
      </div>

      <div class="section">
        <span class="label">Currencies</span>
        <Field label="Budget currency" hint={hasTxns ? 'Fixed once you have transactions: every amount in the plan is stored in it.' : 'The currency your plan is written in.'}>
          <select
            value={s.base}
            disabled={hasTxns}
            onChange={(e) => {
              updateSettings({ base: e.currentTarget.value, rates: {}, ratesAt: 0, extraCurrencies: s.extraCurrencies.filter((c) => c !== e.currentTarget.value) })
              void refreshRates(true)
            }}
          >
            {Object.keys(CURRENCIES).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <span class="field-label">Other currencies you use</span>
        <ul class="lines">
          {s.extraCurrencies.map((c) => (
            <li key={c}>
              <span class="num" style={{ width: '48px' }}>
                {c}
              </span>
              <span class="faint grow" style={{ fontSize: '13px' }}>
                1 {c} =
              </span>
              <input
                type="text"
                inputMode="decimal"
                class="num"
                style={{ width: '96px', textAlign: 'right' }}
                value={rateEdit[c] ?? String(s.rates[c] ?? '')}
                onInput={(e) => setRateEdit({ ...rateEdit, [c]: e.currentTarget.value })}
                onBlur={(e) => {
                  const v = Number(e.currentTarget.value.replace(',', '.'))
                  if (v > 0 && v !== s.rates[c]) {
                    updateSettings({ rates: { ...s.rates, [c]: v }, pinned: { ...(s.pinned ?? {}), [c]: 1 } })
                    toast(`${c} rate pinned. Live updates skip it.`)
                  }
                  const next = { ...rateEdit }
                  delete next[c]
                  setRateEdit(next)
                }}
              />
              <span class="faint num" style={{ fontSize: '13px' }}>
                {s.base}
              </span>
              <button
                class="iconbtn"
                aria-label={`Stop using ${c}`}
                onClick={() => updateSettings({ extraCurrencies: s.extraCurrencies.filter((x) => x !== c) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div class="row" style={{ marginTop: '10px' }}>
          <select class="grow" value={addCur} onChange={(e) => setAddCur(e.currentTarget.value)}>
            <option value="">Add a currency…</option>
            {Object.keys(CURRENCIES)
              .filter((c) => c !== s.base && !s.extraCurrencies.includes(c))
              .map((c) => (
                <option key={c}>{c}</option>
              ))}
          </select>
          <button
            class="btn ghost"
            disabled={!addCur}
            onClick={() => {
              updateSettings({ extraCurrencies: [...s.extraCurrencies, addCur] })
              setAddCur('')
              void refreshRates(true)
            }}
          >
            Add
          </button>
        </div>
        <p class="field-hint">
          Rates update by themselves{s.ratesAt ? ` (last ${new Date(s.ratesAt).toLocaleString()})` : ''}. Typing a rate pins it.{' '}
          {s.pinned && Object.keys(s.pinned).length > 0 && (
            <button
              class="link"
              onClick={async () => {
                updateSettings({ pinned: {} })
                const ok = await refreshRates(true)
                toast(ok ? 'Using live rates again' : 'Couldn’t reach the rates service')
              }}
            >
              Use live rates
            </button>
          )}
        </p>
      </div>

      <div class="section">
        <span class="label">Savings</span>
        <Field label="Savings-rate target" hint="Share of each month's income you want to give to savings categories.">
          <div class="row">
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(s.savingsTarget * 100)}
              style={{ width: '96px' }}
              onChange={(e) => updateSettings({ savingsTarget: Math.max(0, Math.min(100, Number(e.currentTarget.value))) / 100 })}
            />
            <span class="muted">%</span>
          </div>
        </Field>
      </div>

      <div class="section">
        <span class="label">Category groups</span>
        <ul class="lines">
          {ix.groups.map((g) => (
            <li key={g.id}>
              <input
                type="text"
                class="grow"
                value={g.name}
                style={{ border: 0, background: 'transparent', padding: '0' }}
                onChange={(e) => e.currentTarget.value.trim() && saveGroup({ ...g, name: e.currentTarget.value.trim() })}
              />
              <span class="faint" style={{ fontSize: '12.5px' }}>
                {(() => {
                  const n = ix.cats.filter((c) => c.group === g.id && !c.archived).length
                  return `${n} ${n === 1 ? 'category' : 'categories'}`
                })()}
              </span>
              <button
                class="iconbtn"
                aria-label={`Move ${g.name} up`}
                onClick={() => {
                  const list = [...ix.groups]
                  const i = list.indexOf(g)
                  if (i <= 0) return
                  ;[list[i - 1], list[i]] = [list[i], list[i - 1]]
                  list.forEach((x, k) => x.order !== k && saveGroup({ ...x, order: k }))
                }}
              >
                ↑
              </button>
              {!ix.cats.some((c) => c.group === g.id) && (
                <button class="iconbtn" aria-label={`Delete ${g.name}`} onClick={() => deleteGroup(g.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        <div class="row" style={{ marginTop: '10px' }}>
          <input type="text" class="grow" placeholder="New group" value={groupName} onInput={(e) => setGroupName(e.currentTarget.value)} />
          <button
            class="btn ghost"
            disabled={!groupName.trim()}
            onClick={() => {
              addGroup(groupName.trim())
              setGroupName('')
            }}
          >
            Add
          </button>
        </div>
        <ArchivedList />
      </div>

      <div class="section">
        <span class="label">Restore</span>
        <p class="field-hint">Load a backup file. It's merged with what's here, so nothing newer gets lost.</p>
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0]
            if (!f) return
            try {
              const data = JSON.parse(await f.text()) as DB
              if (!data.cats || !data.txns) throw new Error('not a backup')
              replaceDB(merge(getDB(), data), { local: true })
              toast('Backup restored')
            } catch {
              toast('That file isn’t a Money in Order backup')
            }
          }}
        />
      </div>

      <div class="section">
        <span class="label">On your iPhone</span>
        <p class="muted" style={{ fontSize: '14px' }}>
          Open this page in Safari, tap Share, then <b>Add to Home Screen</b>. Open it from the Home Screen and choose “I already use it on another
          device” to join with your sync code. It runs full screen, works offline, and syncs when it's back online.
        </p>
      </div>
    </div>
  )
}

function ArchivedList() {
  const ix = useIndex()
  const archived = ix.cats.filter((c) => c.archived)
  if (!archived.length) return null
  return (
    <>
      <span class="field-label" style={{ display: 'block', marginTop: '18px' }}>
        Archived categories
      </span>
      <ul class="lines">
        {archived.map((c) => (
          <li key={c.id}>
            <span class="grow faint">{c.name}</span>
            <button class="link" onClick={() => unarchiveCategory(c.id)}>
              Bring back
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

function SyncBox() {
  const sync = useSync()
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const link = sync.code ? `${location.origin}/#join=${sync.code}` : ''

  if (!sync.code) {
    return (
      <div class="section">
        <span class="label">Sync between devices</span>
        <p class="muted" style={{ fontSize: '14px' }}>
          Keep your phone and laptop in step. Your data is encrypted on this device with a code only you have; the server stores scrambled bytes it can't read.
        </p>
        <button
          class="btn block"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await enableSync(newCode())
            setBusy(false)
          }}
        >
          Turn on sync
        </button>
        <div class="row" style={{ marginTop: '12px' }}>
          <input type="text" class="grow" placeholder="Code from your other device" value={joinCode} onInput={(e) => setJoinCode(e.currentTarget.value)} autocapitalize="characters" />
          <button
            class="btn ghost"
            disabled={busy || !normalizeCode(joinCode)}
            onClick={async () => {
              const code = normalizeCode(joinCode)
              if (!code) return
              setBusy(true)
              const exists = await codeHasData(code).catch(() => false)
              if (!exists && !confirm('Nothing is stored under that code yet. Start syncing with it anyway?')) {
                setBusy(false)
                return
              }
              await enableSync(code)
              setBusy(false)
              toast('Joined. Your devices now share one budget.')
            }}
          >
            Join
          </button>
        </div>
      </div>
    )
  }

  const status =
    sync.state === 'syncing'
      ? 'Syncing…'
      : sync.state === 'offline'
        ? 'Offline. Changes will upload when you’re back online.'
        : sync.state === 'error'
          ? `Problem: ${sync.error}`
          : sync.last
            ? `Up to date · ${new Date(sync.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'On'
  return (
    <div class="section">
      <span class="label">Sync between devices</span>
      <p class="muted" style={{ fontSize: '14px', marginBottom: '6px' }}>
        {status}
      </p>
      <Field
        label="Your sync code"
        hint="Anyone with this code can read your budget, so keep it like a password. On an iPhone, add the app to your Home Screen first, open it from there, then enter this code (the Home Screen app keeps its own storage, separate from Safari)."
      >
        <input type="text" readOnly value={sync.code} class="num" onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <div class="row">
        <button
          class="btn grow"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link)
              toast('Link copied. Open it on your other device.')
            } catch {
              toast(link)
            }
          }}
        >
          Copy link for other device
        </button>
        <button class="btn ghost" onClick={() => void syncNow()}>
          Sync now
        </button>
      </div>
      <button
        class="link"
        style={{ color: 'var(--red)', marginTop: '6px' }}
        onClick={async () => {
          if (!confirm('Stop syncing on this device? Your data stays here.')) return
          await disableSync()
        }}
      >
        Turn off sync on this device
      </button>
    </div>
  )
}
