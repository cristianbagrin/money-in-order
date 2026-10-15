import { useEffect, useMemo, useState } from 'preact/hooks'
import { assignedInMonth, averageSpent, monthView, spentInMonth } from '../lib/budget'
import { addMonths, monthName } from '../lib/dates'
import { evalAmount, fmt } from '../lib/money'
import { archiveCategory, categoryHasHistory, deleteCategory, moveMoney, saveCategory, setAssigned, undoable } from '../lib/store'
import { RTA, type Category, type ID, type Target } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { AmountField, Section, toast } from '../ui/kit'
import { useCountUp } from '../ui/motion'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'

function toInput(minor: number): string {
  return minor ? String(minor / 100) : ''
}

export function CategorySheet(props: { catId: ID | null; month: string; current: string; onClose: () => void; onHistory: (id: ID) => void }) {
  const ix = useIndex()
  const { month, current } = props
  const base = ix.settings.base
  const cat = props.catId ? ix.catById.get(props.catId) ?? null : null
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const cm = cat ? view.byId.get(cat.id) : undefined
  const available = cm?.available ?? 0
  const shown = useCountUp(available)
  const [assignStr, setAssignStr] = useState('')

  useEffect(() => setAssignStr(toInput(cm?.assigned ?? 0)), [props.catId, month, cm?.assigned])

  if (!cat) return <Sheet open={false} onClose={props.onClose} children={null} />

  const assigned = cm?.assigned ?? 0
  const spent = -(cm?.activity ?? 0)
  const carry = cm?.carry ?? 0

  function assign(v: number) {
    if (!cat || v === assigned) return
    undoable(`Assigned ${cat.name}`, () => setAssigned(month, cat.id, v))
    play('tap')
  }

  const prev = addMonths(month, -1)
  const quick: { label: string; value: number }[] = []
  const offer = (label: string, value: number) => {
    if (value > 0 && value !== assigned && !quick.some((q) => q.value === value)) quick.push({ label, value })
  }
  if (cm && cm.need > 0) offer(cat.target ? 'Target' : 'Clear it', assigned + cm.need)
  offer('Last month', assignedInMonth(ix, cat.id, prev))
  offer('Spent last month', spentInMonth(ix, cat.id, prev))
  offer('Average', averageSpent(ix, cat.id, month))

  const sources = view.cats.filter((c) => c.cat.id !== cat.id && c.available > 0).sort((a, b) => b.available - a.available)
  function cover(from: ID, have: number) {
    if (!cat) return
    const amt = Math.min(-available, have)
    const name = from === RTA ? 'Ready to assign' : ix.catById.get(from)?.name
    undoable(`Covered ${cat.name}`, () => moveMoney(month, from, cat.id, amt))
    play('success')
    toast(`${fmt(amt, base)} from ${name}`, { undo: true })
  }

  const parts = [`${fmt(assigned, base)} assigned`, `${fmt(spent, base)} spent`]
  if (carry) parts.push(`${fmt(carry, base, { sign: true })} from ${monthName(prev)}`)

  return (
    <Sheet open onClose={props.onClose} title={cat.name}>
      <div class={`cs-avail ${available < 0 ? 'neg' : available > 0 ? 'pos' : 'faint'}`}>{fmt(shown, base)}</div>
      <p class="cs-line">{parts.join(' · ')}</p>

      {available < 0 && (
        <div class="cover">
          <p>Cover {fmt(-available, base)} from</p>
          <div class="pills">
            {view.readyToAssign > 0 && (
              <button class="pill" onClick={() => cover(RTA, view.readyToAssign)}>
                Ready to assign <small>{fmt(view.readyToAssign, base)}</small>
              </button>
            )}
            {sources.map((s) => (
              <button key={s.cat.id} class="pill" onClick={() => cover(s.cat.id, s.available)}>
                {s.cat.name} <small>{fmt(s.available, base)}</small>
              </button>
            ))}
            {!sources.length && view.readyToAssign <= 0 && <span class="muted">Nothing has money to spare yet.</span>}
          </div>
        </div>
      )}

      <Section title={`Assigned in ${monthName(month)}`}>
        <AmountField
          label="Assigned"
          value={assignStr}
          onInput={setAssignStr}
          onCommit={(raw) => {
            const v = raw.trim() === '' ? 0 : evalAmount(raw)
            if (v !== null) assign(v)
          }}
        />
        {quick.length > 0 && (
          <div class="pills" style={{ marginTop: '10px' }}>
            {quick.map((q) => (
              <button
                key={q.label}
                class="pill"
                onClick={() => {
                  assign(q.value)
                  setAssignStr(toInput(q.value))
                }}
              >
                {q.label} <small>{fmt(q.value, base)}</small>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Target">
        <TargetEditor cat={cat} base={base} month={month} />
      </Section>

      <div class="pills section">
        <Toggle cat={cat} field="daily" label="Daily allowance" />
        <Toggle cat={cat} field="saving" label="Savings" />
      </div>

      <div class="cs-foot">
        <button class="link" onClick={() => props.onHistory(cat.id)}>
          History
        </button>
        {categoryHasHistory(cat.id) ? (
          <button
            class="link red"
            onClick={() => {
              undoable(`Archived ${cat.name}`, () => archiveCategory(cat.id, current, current))
              play('delete')
              props.onClose()
              toast(`${cat.name} archived`, { undo: true })
            }}
          >
            Archive
          </button>
        ) : (
          <button
            class="link red"
            onClick={() => {
              undoable(`Deleted ${cat.name}`, () => deleteCategory(cat.id))
              play('delete')
              props.onClose()
              toast(`${cat.name} deleted`, { undo: true })
            }}
          >
            Delete
          </button>
        )}
      </div>
    </Sheet>
  )
}

function Toggle(props: { cat: Category; field: 'daily' | 'saving'; label: string }) {
  const on = !!props.cat[props.field]
  return (
    <button
      class="pill soft"
      aria-pressed={on}
      onClick={() => {
        const next: Category = { ...props.cat }
        if (on) delete next[props.field]
        else next[props.field] = true
        undoable(props.label, () => saveCategory(next))
        play('toggle')
      }}
    >
      {props.label}
    </button>
  )
}

const KINDS: [Target['kind'] | 'none', string][] = [
  ['none', 'None'],
  ['monthly', 'Monthly'],
  ['refill', 'Top up'],
  ['goal', 'Goal'],
]

function TargetEditor(props: { cat: Category; base: string; month: string }) {
  const { cat } = props
  const t = cat.target
  const kind = t?.kind ?? 'none'
  const [amountStr, setAmountStr] = useState(t ? String(t.amount / 100) : '')
  useEffect(() => setAmountStr(t ? String(t.amount / 100) : ''), [t?.amount, t?.kind, cat.id])

  function save(next: Target | undefined) {
    const c: Category = { ...cat }
    if (next) c.target = next
    else delete c.target
    undoable('Changed target', () => saveCategory(c))
  }
  function setKind(k: string) {
    play('toggle')
    const amount = t?.amount ?? 0
    if (k === 'none') save(undefined)
    else if (k === 'goal') save({ kind: 'goal', amount })
    else save({ kind: k as 'monthly' | 'refill', amount })
  }

  return (
    <>
      <div class="pills">
        {KINDS.map(([k, label]) => (
          <button key={k} class="pill" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>
      {t && (
        <div class="row" style={{ marginTop: '10px' }}>
          <div class="grow">
            <AmountField
              label="Target amount"
              value={amountStr}
              onInput={setAmountStr}
              onCommit={(raw) => {
                const v = evalAmount(raw)
                if (v === null || v < 0 || v === t.amount) return
                save(t.kind === 'goal' ? { ...t, amount: v } : { kind: t.kind, amount: v })
              }}
            />
          </div>
          {t.kind === 'goal' && (
            <input
              type="month"
              aria-label="By month"
              style={{ width: '42%', minHeight: '56px' }}
              value={t.by ?? ''}
              min={props.month}
              onChange={(e) => {
                const by = e.currentTarget.value || undefined
                save(by ? { kind: 'goal', amount: t.amount, by } : { kind: 'goal', amount: t.amount })
              }}
            />
          )}
        </div>
      )}
    </>
  )
}
