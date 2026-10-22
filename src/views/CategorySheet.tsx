import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { investAccounts } from '../lib/accounts'
import { assignedInMonth, averageSpent, monthView, type CatMonth } from '../lib/budget'
import { addMonths, monthName } from '../lib/dates'
import { evalAmount, fmt, roundFor } from '../lib/money'
import { suggestions } from '../lib/plan'
import { archiveCategory, categoryHasHistory, deleteCategory, getIndex, moveMoney, saveCategory, setAssigned, unarchiveCategory, undoable } from '../lib/store'
import { RTA, type Category, type ID, type Target } from '../lib/types'
import { useIndex, useToday } from '../ui/hooks'
import { caretToEnd, regroup, toast, useCalc, useTapAway } from '../ui/kit'
import { useCountUp } from '../ui/motion'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'
import { SpentSheet } from './SpentSheet'

let pendingDelete: ID | null = null

/** Open the category's sheet straight at its delete choice (a swipe on a row with history). Call before opening it. */
export function askToDelete(id: ID) {
  pendingDelete = id
}

export function CategorySheet(props: { catId: ID | null; month: string; current: string; onClose: () => void; onHistory: (id: ID) => void }) {
  const ix = useIndex()
  const today = useToday()
  const { month, current } = props
  const base = ix.settings.base
  const cat = props.catId ? ix.catById.get(props.catId) ?? null : null
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const cm = cat ? view.byId.get(cat.id) : undefined
  const available = cm?.available ?? 0
  const shown = useCountUp(available)
  const [deleting, setDeleting] = useState(false)
  useTapAway(deleting, () => setDeleting(false), (el) => !!el.closest('.cs-del, .link.red'))
  const [spentOpen, setSpentOpen] = useState(false)
  useEffect(() => {
    setDeleting(!!props.catId && pendingDelete === props.catId)
    pendingDelete = null
    setSpentOpen(false)
  }, [props.catId])

  if (!cat) return <Sheet open={false} onClose={props.onClose} children={null} />

  const assigned = cm?.assigned ?? 0
  const spent = -(cm?.activity ?? 0)
  const carry = cm?.carry ?? 0
  const prev = addMonths(month, -1)

  function assign(v: number) {
    if (!cat || v === assigned) return
    undoable(`Assigned ${cat.name}`, () => setAssigned(month, cat.id, v))
  }

  // One-tap amounts for Assigned; never one that is already there.
  const quick: { label: string; value: number }[] = []
  const offer = (label: string, value: number) => {
    if (value > 0 && value !== assigned && !quick.some((q) => q.value === value)) quick.push({ label, value })
  }
  if (cm && cm.goal > 0) offer(cat.target ? 'Target' : 'Clear it', cm.goal)
  if (cat.saving) {
    // Savings: its share of the month's savings target (spending from it isn't a cost to repeat).
    const s = month >= current ? suggestions(ix, month, current).find((x) => x.cat === cat.id) : undefined
    if (s) offer('Savings share', s.want)
  } else offer('Usual', roundFor(base, averageSpent(ix, cat.id, month, 3)))
  offer('Last month', assignedInMonth(ix, cat.id, prev))

  const sources = view.cats.filter((c) => c.cat.id !== cat.id && c.available > 0).sort((a, b) => b.available - a.available)
  function cover(from: ID, have: number) {
    if (!cat) return
    const amt = Math.min(-available, have)
    const name = from === RTA ? 'Ready to assign' : ix.catById.get(from)?.name
    undoable(`Covered ${cat.name}`, () => moveMoney(month, from, cat.id, amt))
    play('success')
    toast(`${fmt(amt, base)} from ${name}`, { undo: true })
  }

  const prevShort = monthName(prev, { short: true })
  const invest = cat.saving ? investAccounts(ix) : []

  return (
    <Sheet open onClose={props.onClose} title={cat.name}>
      <div class={`cs-avail ${available < 0 ? 'neg' : cm && cm.need > 0 ? 'short' : available > 0 ? 'pos' : 'faint'}`}>
        <span class={`marked${available < 0 ? ' neg' : ''}`}>{fmt(shown, base)}</span>
      </div>

      {/* How the big number comes about: Assigned (editable) ± what came over from last month − Spent. */}
      <div class="cs-math">
        <label class="cs-fig">
          <span class="cs-fig-l">Assigned</span>
          <AssignedField value={assigned} base={base} label={`Assigned to ${cat.name}`} onCommit={assign} />
        </label>
        {carry !== 0 && (
          <>
            <span class="cs-op" aria-hidden="true">
              {carry > 0 ? '+' : '−'}
            </span>
            <span class="cs-fig">
              <span class="cs-fig-l">{carry > 0 ? `Left from ${prevShort}` : `Over in ${prevShort}`}</span>
              <span class="num">{fmt(Math.abs(carry), base, { bare: true })}</span>
            </span>
          </>
        )}
        <span class="cs-op" aria-hidden="true">
          {spent < 0 ? '+' : '−'}
        </span>
        <button class="cs-fig cs-spent" onClick={() => setSpentOpen(true)} aria-label={`${fmt(spent, base)} spent. Show`}>
          <span class="cs-fig-l">{spent < 0 ? 'Refunded' : 'Spent'}</span>
          <span class="num">{fmt(Math.abs(spent), base, { bare: true })}</span>
        </button>
      </div>

      {quick.length > 0 && (
        <div class="pills cs-quick">
          {quick.map((q) => (
            <button
              key={q.label}
              class="pill sm"
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
            {!sources.length && view.readyToAssign <= 0 && <span class="muted">Nothing has money to spare yet</span>}
          </div>
        </div>
      )}

      <TargetEditor cat={cat} cm={cm} base={base} month={month} />

      <div class="pills cs-toggles">
        <Toggle cat={cat} field="daily" label="Daily allowance" />
        <Toggle cat={cat} field="saving" label="Savings" />
      </div>

      {invest.length > 0 && (
        <PillRow label="Goes into">
          {[{ id: '', name: 'None' }, ...invest].map((a) => (
            <button
              key={a.id}
              class="pill sm soft"
              aria-pressed={(cat.acct ?? '') === a.id}
              onClick={() => {
                if ((cat.acct ?? '') === a.id) return
                const next: Category = { ...cat }
                if (a.id) next.acct = a.id
                else delete next.acct
                undoable('Changed where savings go', () => saveCategory(next))
              }}
            >
              {a.name}
            </button>
          ))}
        </PillRow>
      )}

      <div class="cs-foot">
        <button class="link" onClick={() => props.onHistory(cat.id)}>
          History
        </button>
        <span class="cs-foot-r">
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
          ) : (
            categoryHasHistory(cat.id) && (
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
            )
          )}
          <button class="link red" aria-expanded={deleting} onClick={() => (deleting ? setDeleting(false) : startDelete(cat, setDeleting, props.onClose))}>
            Delete
          </button>
        </span>
      </div>
      {deleting && <DeleteStep cat={cat} onCancel={() => setDeleting(false)} onDone={props.onClose} />}

      <SpentSheet cat={spentOpen ? cat.id : null} month={month} today={today} onClose={() => setSpentOpen(false)} />
    </Sheet>
  )
}

/** A labelled row of pills ("Goes into  None  Vanguard"). */
function PillRow(props: { label: string; children: ComponentChildren }) {
  return (
    <div class="cs-row">
      <span class="cs-row-l">{props.label}</span>
      <div class="pills">{props.children}</div>
    </div>
  )
}

/** The Assigned amount, edited right here: commits on Enter or leaving the field, Esc puts it back. */
function AssignedField(props: { value: number; base: string; label: string; onCommit: (v: number) => void }) {
  const { value, base } = props
  const show = (v: number) => (v ? fmt(v, base, { bare: true }) : '')
  const [text, setText] = useState(show(value))
  const focused = useRef(false)
  const abandoned = useRef(false)
  const calc = useCalc()
  // A quick pill, an undo or a sync changed it: show the new amount unless it's being typed over.
  useEffect(() => {
    if (!focused.current) setText(show(value))
  }, [value, base])
  return (
    <>
      <input
        class="cs-asg num"
        type="text"
        autocomplete="off"
        {...calc.field}
        aria-label={props.label}
        placeholder="0"
        value={text}
        style={{ '--len': Math.max(1, text.length) }}
        onFocus={(e) => {
          focused.current = true
          abandoned.current = false
          caretToEnd(e.currentTarget)
        }}
        onInput={(e) => {
          abandoned.current = false
          setText(regroup(e))
        }}
        onBlur={(e) => {
          focused.current = false
          if (abandoned.current) {
            abandoned.current = false
            return setText(show(value))
          }
          const raw = e.currentTarget.value
          const v = raw.trim() === '' ? 0 : evalAmount(raw, base)
          if (v === null) return setText(show(value))
          setText(show(v))
          props.onCommit(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // Esc abandons what was typed; the sheet closes as usual.
          else if (e.key === 'Escape') {
            abandoned.current = true
            setText(show(value))
          }
        }}
      />
      {calc.pad()}
    </>
  )
}

/**
 * Delete from the footer: an unused category just goes; one with only money given to it goes and the
 * money returns to Ready to assign; one with transactions asks where they go (the step below).
 */
function startDelete(cat: Category, setDeleting: (v: boolean) => void, close: () => void) {
  if (!categoryHasHistory(cat.id)) {
    undoable(`Deleted ${cat.name}`, () => deleteCategory(cat.id))
  } else if (!txnsOf(cat.id).length) {
    undoable(`Deleted ${cat.name}`, () => deleteCategory(cat.id, { dropTxns: true }))
  } else return setDeleting(true)
  play('delete')
  close()
  toast(`${cat.name} deleted`, { undo: true })
}

function txnsOf(id: ID) {
  return getIndex().txns.filter((t) => t.cat === id)
}

/** "Move its 12 transactions to" another category, or delete them too (which changes your total money). */
function DeleteStep(props: { cat: Category; onCancel: () => void; onDone: () => void }) {
  const { cat } = props
  const ix = useIndex()
  const base = ix.settings.base
  const txns = useMemo(() => ix.txns.filter((t) => t.cat === cat.id), [ix, cat.id])
  const others = ix.cats.filter((c) => c.id !== cat.id && !c.archived)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), [])

  function into(to: Category) {
    undoable(`Deleted ${cat.name}`, () => deleteCategory(cat.id, { into: to.id }))
    play('delete')
    props.onDone()
    toast(`${cat.name} deleted, its history is in ${to.name}`, { undo: true })
  }
  function dropAll() {
    // Deleting spending gives that money back (and income takes it away): your total changes.
    const change = -txns.reduce((s, t) => s + t.base, 0)
    const n = txns.length
    if (!confirm(`Delete ${cat.name} and its ${n} ${n === 1 ? 'transaction' : 'transactions'}? Your total money changes by ${fmt(change, base, { sign: true })}`)) return
    undoable(`Deleted ${cat.name}`, () => deleteCategory(cat.id, { dropTxns: true }))
    play('delete')
    props.onDone()
    toast(`${cat.name} and its history deleted`, { undo: true })
  }

  return (
    <div class="cs-del" ref={ref}>
      <p>
        Move its {txns.length} {txns.length === 1 ? 'transaction' : 'transactions'} to
      </p>
      <div class="pills">
        {others.map((c) => (
          <button key={c.id} class="pill sm" onClick={() => into(c)}>
            {c.name}
          </button>
        ))}
      </div>
      <div class="cs-del-foot">
        <button class="link red" onClick={dropAll}>
          Delete them too
        </button>
        <button class="link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
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
      }}
    >
      {props.label}
    </button>
  )
}

const KINDS: [Target['kind'] | 'none', string][] = [
  ['none', 'None'],
  ['monthly', 'Monthly'],
  ['topup', 'Top up'],
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
  // The chosen goal month stays in view in the sideways row.
  const monthsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = monthsRef.current
    if (el && el.scrollWidth > el.clientWidth) el.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [kind, t?.kind === 'goal' ? t.by : ''])
  // A kind just picked without an amount: the field takes focus so the amount can be typed right away.
  const focusNext = useRef(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  const calc = useCalc()
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
    const amount = t?.amount ?? 0
    focusNext.current = !amount
    if (k === 'none') save(undefined)
    else if (k === 'goal') save({ kind: 'goal', amount })
    else save({ kind: k as 'monthly' | 'topup', amount })
  }
  function commit(raw: string) {
    if (!t) return
    const v = raw.trim() === '' ? 0 : evalAmount(raw, base)
    if (v === null || v < 0) return setAmountStr(show(t.amount))
    setAmountStr(show(v))
    if (v === t.amount) return
    save(t.kind === 'goal' ? { ...t, amount: v } : { kind: t.kind, amount: v })
  }

  // The goal's pace: what this month asks for, the same figure as the Target pill and Fill in.
  let pace = ''
  if (t?.kind === 'goal' && t.by && t.amount > 0 && cm) pace = cm.goal > 0 ? '' : 'Goal reached'
  // Monthly and Top up differ only in what came over from last month: say what that means this month.
  else if (t && t.amount > 0 && cm && !cat.archived) {
    const carry = cm.carry
    const prev = monthName(addMonths(month, -1))
    if (t.kind === 'topup') pace = `Add ${fmt(t.amount, base)} every month, no matter what`
    else if (t.kind === 'monthly')
      pace =
        carry > 0
          ? `${fmt(carry, base)} came over from ${prev}, so ${fmt(cm.goal, base)} tops it up`
          : carry < 0
            ? `You need ${fmt(cm.goal, base)} because you went ${fmt(-carry, base)} over in ${prev}`
            : 'What’s left at the end of the month counts toward the next'
  }

  return (
    <section class="section">
      <div class="pills cs-kinds" role="group" aria-label="Target">
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
                autocomplete="off"
                {...calc.field}
                aria-label="Target amount"
                placeholder="0"
                value={amountStr}
                onFocus={(e) => caretToEnd(e.currentTarget)}
                onInput={(e) => setAmountStr(regroup(e))}
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
      {calc.pad()}
      {t?.kind === 'goal' && (
        <div class="pills scroll" style={{ marginTop: '10px' }} ref={monthsRef}>
          <button class="pill sm soft" aria-pressed={!t.by} onClick={() => save({ kind: 'goal', amount: t.amount })}>
            Any time
          </button>
          {[...(t.by && t.by < month ? [t.by] : []), ...Array.from({ length: 18 }, (_, i) => addMonths(month, i))].map((m) => (
            <button key={m} class="pill sm soft" aria-pressed={t.by === m} onClick={() => save({ kind: 'goal', amount: t.amount, by: m })}>
              {monthName(m, { short: true })} {m.slice(0, 4)}
            </button>
          ))}
        </div>
      )}
      {pace && <p class="hint">{pace}</p>}
    </section>
  )
}
