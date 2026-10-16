import { useEffect, useMemo, useState } from 'preact/hooks'
import { assignedInMonth, averageSpent, monthView, spentInMonth } from '../lib/budget'
import { addMonths, monthDiff, monthName } from '../lib/dates'
import { evalAmount, fmt } from '../lib/money'
import { archiveCategory, categoryHasHistory, deleteCategory, moveMoney, saveCategory, setAssigned, unarchiveCategory, undoable } from '../lib/store'
import { RTA, type Category, type ID, type Target } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { AmountField, Section, toast } from '../ui/kit'
import { useCountUp } from '../ui/motion'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'

function toInput(minor: number, base: string): string {
  return minor ? fmt(minor, base, { bare: true }) : ''
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

  useEffect(() => setAssignStr(toInput(cm?.assigned ?? 0, base)), [props.catId, month, cm?.assigned])

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
            setAssignStr(toInput(v ?? assigned, base))
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
                  setAssignStr(toInput(q.value, base))
                  toast(`${fmt(q.value, base)} assigned`, { undo: true })
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
        {cat.archived ? (
          <button
            class="link"
            onClick={() => {
              undoable(`Brought back ${cat.name}`, () => unarchiveCategory(cat.id))
              play('success')
            }}
          >
            Bring back
          </button>
        ) : categoryHasHistory(cat.id) ? (
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
  const show = (v: number) => (v ? fmt(v, props.base, { bare: true }) : '')
  const [amountStr, setAmountStr] = useState(t ? show(t.amount) : '')
  useEffect(() => setAmountStr(t ? show(t.amount) : ''), [t?.amount, t?.kind, cat.id])

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
                if (v === null || v < 0) return setAmountStr(show(t.amount))
                setAmountStr(show(v))
                if (v === t.amount) return
                save(t.kind === 'goal' ? { ...t, amount: v } : { kind: t.kind, amount: v })
              }}
            />
          </div>
        </div>
      )}
      {t?.kind === 'goal' && (
        <div class="pills scroll" style={{ marginTop: '10px' }}>
          <button class="pill sm soft" aria-pressed={!t.by} onClick={() => save({ kind: 'goal', amount: t.amount })}>
            Any time
          </button>
          {Array.from({ length: 18 }, (_, i) => addMonths(props.month, i)).map((m) => (
            <button key={m} class="pill sm soft" aria-pressed={t.by === m} onClick={() => save({ kind: 'goal', amount: t.amount, by: m })}>
              {monthName(m, { short: true })} {m.slice(2, 4)}
            </button>
          ))}
        </div>
      )}
      {t && t.amount > 0 && <p class="hint">{targetMeaning(t, props.base, props.month)}</p>}
    </>
  )
}

/** What the target asks for, in one plain line. */
function targetMeaning(t: Target, base: string, month: string): string {
  const a = fmt(t.amount, base)
  if (t.kind === 'monthly') return `${a} every month.`
  if (t.kind === 'refill') return `Filled up to ${a} each month. Leftovers count.`
  if (!t.by) return `Build up to ${a}.`
  const months = Math.max(1, monthDiff(month, t.by) + 1)
  return `${a} by ${monthName(t.by, { year: true })}, about ${fmt(Math.ceil(t.amount / months / 100) * 100, base)} a month.`
}
