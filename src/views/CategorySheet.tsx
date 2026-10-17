import { Fragment } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { assignedInMonth, averageSpent, monthView, spentInMonth, type CatMonth } from '../lib/budget'
import { addMonths, monthName } from '../lib/dates'
import { evalAmount, fmt } from '../lib/money'
import { archiveCategory, categoryHasHistory, deleteCategory, moveMoney, saveCategory, setAssigned, unarchiveCategory, undoable } from '../lib/store'
import { RTA, type Category, type ID, type Target } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { toast } from '../ui/kit'
import { useCountUp } from '../ui/motion'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'

export function CategorySheet(props: { catId: ID | null; month: string; current: string; onClose: () => void; onHistory: (id: ID) => void }) {
  const ix = useIndex()
  const { month, current } = props
  const base = ix.settings.base
  const cat = props.catId ? ix.catById.get(props.catId) ?? null : null
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const cm = cat ? view.byId.get(cat.id) : undefined
  const available = cm?.available ?? 0
  const shown = useCountUp(available)

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

  // One line of what happened: only the parts that aren't zero (assigned always).
  const parts = [`${fmt(assigned, base)} assigned`]
  if (spent) parts.push(`${fmt(spent, base)} spent`)
  if (carry) parts.push(`${fmt(carry, base, { sign: true })} from ${monthName(prev, { short: true })}`)

  return (
    <Sheet open onClose={props.onClose} title={cat.name}>
      <div class={`cs-avail ${available < 0 ? 'neg' : available > 0 ? 'pos' : 'faint'}`}>
        <span class={`marked${available < 0 ? ' neg' : ''}`}>{fmt(shown, base)}</span>
      </div>
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

      {quick.length > 0 && (
        <div class="pills cs-quick">
          {quick.map((q) => (
            <button
              key={q.label}
              class="pill"
              onClick={() => {
                assign(q.value)
                toast(`${fmt(q.value, base)} assigned`, { undo: true })
              }}
            >
              {q.label} <small>{fmt(q.value, base)}</small>
            </button>
          ))}
        </div>
      )}

      <TargetEditor cat={cat} cm={cm} base={base} month={month} />

      <div class="pills cs-toggles">
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
            class="link"
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
            class="link"
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
      class="pill toggle"
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

/** Kind pills; the amount is a small field right after the pressed one ("Monthly 335"). */
function TargetEditor(props: { cat: Category; cm: CatMonth | undefined; base: string; month: string }) {
  const { cat, cm, base, month } = props
  const t = cat.target
  const kind = t?.kind ?? 'none'
  const show = (v: number) => (v ? fmt(v, base, { bare: true }) : '')
  const [amountStr, setAmountStr] = useState(t ? show(t.amount) : '')
  useEffect(() => setAmountStr(t ? show(t.amount) : ''), [t?.amount, t?.kind, cat.id])
  // A kind just picked without an amount: the field takes focus so the amount can be typed right away.
  const focusNext = useRef(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusNext.current) return
    focusNext.current = false
    fieldRef.current?.focus()
  }, [kind])

  function save(next: Target | undefined) {
    const c: Category = { ...cat }
    if (next) c.target = next
    else delete c.target
    undoable('Changed target', () => saveCategory(c))
  }
  function setKind(k: string) {
    if (k === kind) return
    play('toggle')
    const amount = t?.amount ?? 0
    focusNext.current = !amount
    if (k === 'none') save(undefined)
    else if (k === 'goal') save({ kind: 'goal', amount })
    else save({ kind: k as 'monthly' | 'refill', amount })
  }
  function commit(raw: string) {
    if (!t) return
    const v = raw.trim() === '' ? 0 : evalAmount(raw, base)
    if (v === null || v < 0) return setAmountStr(show(t.amount))
    setAmountStr(show(v))
    if (v === t.amount) return
    save(t.kind === 'goal' ? { ...t, amount: v } : { kind: t.kind, amount: v })
  }

  // The goal's pace: what this month asks for, the same figure as the Target pill and Fund targets.
  let pace = ''
  if (t?.kind === 'goal' && t.by && t.amount > 0 && cm) pace = cm.goal > 0 ? `About ${fmt(cm.goal, base)} a month.` : 'Goal reached.'

  return (
    <section class="section">
      <h2>Target</h2>
      <div class="pills cs-kinds">
        {KINDS.map(([k, label]) => (
          <Fragment key={k}>
            <button class="pill sm soft" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
            {t && kind === k && k !== 'none' && (
              <input
                ref={fieldRef}
                class="cs-target"
                type="text"
                inputMode="decimal"
                aria-label="Target amount"
                placeholder="0"
                value={amountStr}
                onFocus={(e) => {
                  const el = e.currentTarget
                  requestAnimationFrame(() => document.activeElement === el && el.select())
                }}
                onInput={(e) => setAmountStr(e.currentTarget.value)}
                onBlur={(e) => commit(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    // Abandon what was typed; the sheet closes as usual.
                    e.currentTarget.value = show(t.amount)
                    setAmountStr(show(t.amount))
                  }
                }}
              />
            )}
          </Fragment>
        ))}
      </div>
      {t?.kind === 'goal' && (
        <div class="pills scroll" style={{ marginTop: '10px' }}>
          <button class="pill sm soft" aria-pressed={!t.by} onClick={() => save({ kind: 'goal', amount: t.amount })}>
            Any time
          </button>
          {Array.from({ length: 18 }, (_, i) => addMonths(month, i)).map((m) => (
            <button key={m} class="pill sm soft" aria-pressed={t.by === m} onClick={() => save({ kind: 'goal', amount: t.amount, by: m })}>
              {monthName(m, { short: true })} {m.slice(2, 4)}
            </button>
          ))}
        </div>
      )}
      {pace && <p class="hint">{pace}</p>}
    </section>
  )
}
