import { useEffect, useMemo, useState } from 'preact/hooks'
import { assignedInMonth, averageSpent, monthView, spentInMonth } from '../lib/budget'
import { addMonths, dateLabel, monthName } from '../lib/dates'
import { fmt, parseAmount } from '../lib/money'
import {
  addCategory,
  archiveCategory,
  categoryHasHistory,
  deleteCategory,
  moveMoney,
  reorderCategory,
  saveCategory,
  setAssigned,
  unarchiveCategory,
} from '../lib/store'
import { RTA, type Category, type ID, type Target } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { Field, Sheet, toast } from '../ui/kit'
import { TxnRow } from './TxnSheet'
import type { Txn } from '../lib/types'

function toInput(minor: number): string {
  return minor ? String(minor / 100) : ''
}

export function CategorySheet(props: {
  catId: ID | 'new' | null
  month: string
  current: string
  today: string
  onClose: () => void
  onEdit: (t: Txn) => void
}) {
  const ix = useIndex()
  const { month, current } = props
  const base = ix.settings.base
  const isNew = props.catId === 'new'
  const cat = props.catId && !isNew ? ix.catById.get(props.catId) ?? null : null
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const cm = cat ? view.byId.get(cat.id) : undefined
  const [assignStr, setAssignStr] = useState('')
  const [moveStr, setMoveStr] = useState('')
  const [moveTarget, setMoveTarget] = useState<string>(`to:${RTA}`)
  const [draft, setDraft] = useState<Partial<Category>>({})

  useEffect(() => {
    setAssignStr(toInput(cm?.assigned ?? 0))
    setMoveStr('')
    setDraft(isNew ? { name: '', group: ix.groups[0]?.id } : {})
  }, [props.catId, month, cm?.assigned])

  if (!props.catId) return null

  // ------------------------------------------------ new category
  if (isNew) {
    return (
      <Sheet open onClose={props.onClose} title="New category">
        <Details draft={draft} setDraft={setDraft} />
        <TargetEditor target={draft.target} base={base} month={month} onChange={(target) => setDraft({ ...draft, target })} />
        <button
          class="btn block"
          style={{ marginTop: '20px' }}
          disabled={!draft.name?.trim() || !draft.group}
          onClick={() => {
            addCategory(draft.group!, draft.name!.trim(), { ...draft, name: draft.name!.trim() })
            props.onClose()
          }}
        >
          Create
        </button>
      </Sheet>
    )
  }
  if (!cat) return null

  const available = cm?.available ?? 0
  const assigned = cm?.assigned ?? 0
  const spent = -(cm?.activity ?? 0)

  function commitAssign(raw: string) {
    const v = raw.trim() === '' ? 0 : parseAmount(raw)
    if (v === null || !cat) return
    if (v !== assigned) setAssigned(month, cat.id, v)
  }

  const prev = addMonths(month, -1)
  const lastAssigned = assignedInMonth(ix, cat.id, prev)
  const lastSpent = spentInMonth(ix, cat.id, prev)
  const avg = averageSpent(ix, cat.id, month)
  const quick: { label: string; value: number }[] = []
  const offer = (label: string, value: number) => {
    if (value > 0 && value !== assigned && !quick.some((q) => q.value === value)) quick.push({ label, value })
  }
  if (cm && cm.need > 0) offer(cm.carry < 0 && !cat.target ? 'Clear debt' : 'Meet target', assigned + cm.need)
  offer('Last month', lastAssigned)
  offer('Spent last month', lastSpent)
  offer('3-month average', avg)

  const sources = view.cats
    .filter((c) => c.cat.id !== cat.id && c.available > 0)
    .sort((a, b) => b.available - a.available)
  const recent = ix.txns.filter((t) => t.cat === cat.id).slice(0, 6)

  function doMove() {
    const v = parseAmount(moveStr)
    if (!v || v <= 0 || !cat) return
    const [moveDir, moveOther] = moveTarget.split(':') as ['to' | 'from', ID]
    if (moveDir === 'to') moveMoney(month, cat.id, moveOther, v)
    else moveMoney(month, moveOther, cat.id, v)
    const otherName = moveOther === RTA ? 'Ready to assign' : ix.catById.get(moveOther)?.name
    toast(`Moved ${fmt(v, base)} ${moveDir === 'to' ? `to ${otherName}` : `from ${otherName}`}`)
    setMoveStr('')
  }

  return (
    <Sheet open onClose={props.onClose} title={cat.name}>
      <div class="headline">
        <span class="label">Available{month !== current ? ` · ${monthName(month)}` : ''}</span>
        <span class={`hand ${available < 0 ? 'neg' : available > 0 ? 'pos' : 'zero'}`}>{fmt(available, base)}</span>
      </div>
      <div class="bignums">
        <div>
          <span class="label">Rolled in</span>
          <span class="num">{fmt(cm?.carry ?? 0, base)}</span>
        </div>
        <div>
          <span class="label">Assigned</span>
          <span class="num">{fmt(assigned, base)}</span>
        </div>
        <div>
          <span class="label">Spent</span>
          <span class="num">{fmt(spent, base)}</span>
        </div>
      </div>

      {available < 0 && (
        <div class="cover">
          <p>Overspent by {fmt(-available, base)}. Cover it from:</p>
          <ul class="lines">
            {view.readyToAssign > 0 && (
              <li>
                <span class="grow">Ready to assign</span>
                <span class="num faint">{fmt(view.readyToAssign, base)}</span>
                <button
                  class="link"
                  onClick={() => {
                    const amt = Math.min(-available, view.readyToAssign)
                    moveMoney(month, RTA, cat.id, amt)
                    toast(`Covered ${fmt(amt, base)} from Ready to assign`)
                  }}
                >
                  Use
                </button>
              </li>
            )}
            {sources.map((s) => (
              <li key={s.cat.id}>
                <span class="grow">{s.cat.name}</span>
                <span class="num faint">{fmt(s.available, base)}</span>
                <button
                  class="link"
                  onClick={() => {
                    const amt = Math.min(-available, s.available)
                    moveMoney(month, s.cat.id, cat.id, amt)
                    toast(`Moved ${fmt(amt, base)} from ${s.cat.name}`)
                  }}
                >
                  Use
                </button>
              </li>
            ))}
            {!sources.length && view.readyToAssign <= 0 && <li class="faint">No money anywhere to cover it yet. Next month's plan will have to.</li>}
          </ul>
        </div>
      )}

      <Field label={`Assigned in ${monthName(month)}`}>
        <input
          type="text"
          inputMode="decimal"
          value={assignStr}
          placeholder="0"
          onInput={(e) => setAssignStr(e.currentTarget.value)}
          onBlur={(e) => commitAssign(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </Field>
      {quick.length > 0 && (
        <div class="quick">
          {quick.map((q) => (
            <button
              key={q.label}
              onClick={() => {
                setAssigned(month, cat.id, q.value)
                setAssignStr(toInput(q.value))
              }}
            >
              {q.label}
              <b>{fmt(q.value, base)}</b>
            </button>
          ))}
        </div>
      )}

      <div class="section">
        <span class="label">Move money</span>
        <div class="row" style={{ marginTop: '10px' }}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="Amount"
            value={moveStr}
            style={{ width: '38%' }}
            onInput={(e) => setMoveStr(e.currentTarget.value)}
          />
          <select class="grow" value={moveTarget} onChange={(e) => setMoveTarget(e.currentTarget.value)} aria-label="Where to move it">
            <optgroup label="Give it to">
              <option value={`to:${RTA}`}>→ Ready to assign</option>
              {view.cats
                .filter((c) => c.cat.id !== cat.id && !c.cat.archived)
                .map((c) => (
                  <option key={c.cat.id} value={`to:${c.cat.id}`}>
                    → {c.cat.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Take it from">
              <option value={`from:${RTA}`}>← Ready to assign ({fmt(view.readyToAssign, base)})</option>
              {view.cats
                .filter((c) => c.cat.id !== cat.id && c.available > 0)
                .map((c) => (
                  <option key={c.cat.id} value={`from:${c.cat.id}`}>
                    ← {c.cat.name} ({fmt(c.available, base)})
                  </option>
                ))}
            </optgroup>
          </select>
        </div>
        <button class="btn ghost block" style={{ marginTop: '10px' }} disabled={!parseAmount(moveStr)} onClick={doMove}>
          Move
        </button>
      </div>

      <div class="section">
        <span class="label">Target</span>
        <TargetEditor target={cat.target} base={base} month={month} onChange={(target) => saveCategory(withTarget(cat, target))} />
      </div>

      {recent.length > 0 && (
        <div class="section">
          <span class="label">Recent</span>
          {recent.map((t) => (
            <TxnRow key={t.id} t={t} showDate={dateLabel(t.date, props.today)} onClick={() => props.onEdit(t)} />
          ))}
        </div>
      )}

      <details class="section">
        <summary class="label" style={{ cursor: 'pointer', paddingBottom: '8px' }}>
          Category settings
        </summary>
        <Details
          draft={cat}
          setDraft={(next) => {
            const n = next as Category
            if (n.name !== undefined && !n.name.trim()) return
            saveCategory({ ...cat, ...n })
          }}
        />
        <div class="row" style={{ marginTop: '6px' }}>
          <button class="btn ghost grow" onClick={() => reorderCategory(cat.id, -1)}>
            Move up
          </button>
          <button class="btn ghost grow" onClick={() => reorderCategory(cat.id, 1)}>
            Move down
          </button>
        </div>
        <div class="danger-zone">
          {cat.archived ? (
            <button class="btn ghost" onClick={() => unarchiveCategory(cat.id)}>
              Bring back
            </button>
          ) : categoryHasHistory(cat.id) ? (
            <button
              class="btn danger"
              onClick={() => {
                if (!confirm(`Archive ${cat.name}? Its history stays; anything left in it goes back to Ready to assign.`)) return
                archiveCategory(cat.id, current, current)
                props.onClose()
              }}
            >
              Archive
            </button>
          ) : (
            <button
              class="btn danger"
              onClick={() => {
                deleteCategory(cat.id)
                props.onClose()
              }}
            >
              Delete
            </button>
          )}
        </div>
      </details>
    </Sheet>
  )
}

function withTarget(cat: Category, target: Target | undefined): Category {
  const next = { ...cat }
  if (target) next.target = target
  else delete next.target
  return next
}

function Details(props: { draft: Partial<Category>; setDraft: (c: Partial<Category>) => void }) {
  const ix = useIndex()
  const { draft, setDraft } = props
  return (
    <>
      <Field label="Name">
        <input type="text" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      </Field>
      <Field label="Group">
        <select value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.currentTarget.value })}>
          {ix.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <input type="text" value={draft.note ?? ''} placeholder="What goes here" onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })} />
      </Field>
      <label class="check">
        <input type="checkbox" checked={!!draft.daily} onChange={(e) => setDraft({ ...draft, daily: e.currentTarget.checked || undefined })} />
        <span>
          Daily allowance
          <small>Spread what's left over the days left in the month, and show it on Today.</small>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" checked={!!draft.saving} onChange={(e) => setDraft({ ...draft, saving: e.currentTarget.checked || undefined })} />
        <span>
          Counts as saving
          <small>Money you give it counts toward your savings rate, and spending from it isn't “spending”.</small>
        </span>
      </label>
    </>
  )
}

function TargetEditor(props: { target?: Target; base: string; month: string; onChange: (t: Target | undefined) => void }) {
  const t = props.target
  const kind = t?.kind ?? 'none'
  const [amountStr, setAmountStr] = useState(t ? String(t.amount / 100) : '')
  useEffect(() => setAmountStr(t ? String(t.amount / 100) : ''), [t?.amount, t?.kind])
  const set = (k: string, amount = t?.amount ?? 0, by = t?.kind === 'goal' ? t.by : undefined) => {
    if (k === 'none') return props.onChange(undefined)
    if (k === 'goal') return props.onChange({ kind: 'goal', amount, ...(by ? { by } : {}) })
    props.onChange({ kind: k as 'monthly' | 'refill', amount })
  }
  const help: Record<string, string> = {
    none: 'No target. Assign by hand.',
    monthly: 'Set aside this much every month (bills, subscriptions, investing).',
    refill: 'Top it up to this much each month. Leftovers count (everyday spending, a cushion).',
    goal: 'Build up to a total, spread over the months until the date (trips, big purchases).',
  }
  return (
    <div style={{ marginTop: '10px' }}>
      <div class="seg">
        {[
          ['none', 'None'],
          ['monthly', 'Monthly'],
          ['refill', 'Top up'],
          ['goal', 'Goal'],
        ].map(([k, label]) => (
          <button key={k} aria-pressed={kind === k} onClick={() => set(k)}>
            {label}
          </button>
        ))}
      </div>
      <p class="field-hint" style={{ margin: '8px 0 0' }}>
        {help[kind]}
      </p>
      {t && (
        <div class="row">
          <div class="grow">
            <Field label={`Amount (${props.base})`}>
              <input
                type="text"
                inputMode="decimal"
                value={amountStr}
                onInput={(e) => setAmountStr(e.currentTarget.value)}
                onBlur={(e) => {
                  const v = parseAmount(e.currentTarget.value)
                  if (v !== null && v >= 0) set(kind, v)
                }}
              />
            </Field>
          </div>
          {t.kind === 'goal' && (
            <div class="grow">
              <Field label="By (optional)">
                <input type="month" value={t.by ?? ''} min={props.month} onChange={(e) => set('goal', t.amount, e.currentTarget.value || undefined)} />
              </Field>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
