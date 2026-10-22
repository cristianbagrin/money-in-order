import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { expectedTotal, monthView, type CatMonth, type Index } from '../lib/budget'
import { addMonths, dayOfMonth, monthName, monthOf } from '../lib/dates'
import { evalAmount, fmt, groupTyped, shownSign } from '../lib/money'
import { catsWithHistory, extraOf, fillPlan, forecast, savingsGoal, suggestions, type Forecast, type Suggestion } from '../lib/plan'
import {
  addCategory,
  addGroup,
  addTxn,
  deleteCategory,
  deleteGroup,
  getIndex,
  lastCount,
  placeCategory,
  placeGroup,
  saveCategory,
  saveGroup,
  setAssigned,
  undoable,
} from '../lib/store'
import { live, RTA, type Category, type Group, type ID, type Month } from '../lib/types'
import { useIndex, useSync } from '../ui/hooks'
import { caretToEnd, IconChevron, IconGear, IconPlus, regroup, toast, useCalc } from '../ui/kit'
import { flash, useCountUp } from '../ui/motion'
import { confetti } from '../ui/confetti'
import { haptic, play } from '../ui/sound'
import { useSortable } from '../ui/sortable'
import { useSwipeDelete } from '../ui/swipe'
import { askToDelete } from './CategorySheet'
import { SpentSheet } from './SpentSheet'
import '../ui/plan.css'

/** Enter or Space on a focused text "button" (names, notes) does what a click does. */
const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  fn()
}

const logIncome = () => {
  location.hash = '#/today'
}

/** Everything assigned to any month: grows when money gets a job, wherever it went. */
function assignedAll(ix: Index): number {
  let s = 0
  for (const a of ix.asg.values()) for (const v of a.values()) s += v
  return s
}

/** Assign a month's suggestions as far as Ready to assign goes, as one undoable step. Returns what was added. */
function fillMonth(month: Month, current: Month, label: string): number {
  const ix = getIndex()
  const plan = fillPlan(suggestions(ix, month, current), monthView(ix, month, current).readyToAssign)
  if (!plan.length) return 0
  undoable(label, () => {
    for (const p of plan) setAssigned(month, p.cat, p.amount)
  })
  return plan.reduce((s, p) => s + p.add, 0)
}

export function Plan(props: {
  today: string
  month: string
  setMonth: (m: string | ((prev: string) => string)) => void
  onCategory: (id: ID) => void
  onCount: () => void
  onReflect: (month: string) => void
  onSettings: () => void
}) {
  const ix = useIndex()
  const stale = useSync().stale
  const { today, month } = props
  const current = monthOf(today)
  const base = ix.settings.base
  const view = useMemo(() => monthView(ix, month, current), [ix, month, current])
  const rta = view.readyToAssign
  // Rounded as shown: a sliver left over from a conversion counts as nothing to assign.
  const rtaSign = shownSign(rta, base)
  const shownRta = useCountUp(rta)
  const rtaRef = useRef<HTMLDivElement>(null)

  // Landing on exactly zero is worth a small celebration: the last of the money assigned (to this month or
  // ahead), or an over-assigned plan put right (assigning less, or income covering it). Not switching
  // months, nor an income removed.
  const given = assignedAll(ix)
  const was = useRef({ month, sign: rtaSign, given })
  useEffect(() => {
    const p = was.current
    was.current = { month, sign: rtaSign, given }
    if (p.month !== month || rtaSign !== 0 || p.sign === 0) return
    if (p.sign > 0 && given <= p.given) return
    play('complete')
    haptic('medium')
    confetti(rtaRef.current)
  }, [month, rtaSign, given])

  // The planner: what each category should get this month (shown as ghosts in empty boxes), the
  // savings target, and how the coming months play out. Past months are history: none of it there.
  const planning = month >= current
  const plan = useMemo(() => (planning ? suggestions(ix, month, current) : []), [ix, month, current, planning])
  const byCat = useMemo(() => new Map(plan.map((s) => [s.cat, s])), [plan])
  const toFill = plan.reduce((s, x) => s + extraOf(x), 0)
  const fc = useMemo(() => forecast(ix, current), [ix, current])
  const used = useMemo(() => catsWithHistory(ix), [ix])
  const [spentOf, setSpentOf] = useState<ID | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<{ id: ID; field: 'name' | 'note' } | null>(null)
  const [editingGroup, setEditingGroup] = useState<ID | null>(null)
  const [adding, setAdding] = useState<ID | null>(null)

  // A row or group that disappears (undo, sync) can't stay in edit mode: that would keep drag switched off.
  useEffect(() => {
    if (editing && !view.cats.some((c) => c.cat.id === editing.id)) setEditing(null)
    if (editingGroup && !view.groups.some((g) => g.group.id === editingGroup)) setEditingGroup(null)
    if (adding && !view.groups.some((g) => g.group.id === adding)) setAdding(null)
  }, [view, editing, editingGroup, adding])

  const [addingGroup, setAddingGroup] = useState(false)
  const ritual = useRitual(today)
  const showRitual = month === current && !!ritual
  // A budget with no money in it yet: the next step is to count it or log income.
  const empty = rtaSign === 0 && view.assigned === 0 && expectedTotal(ix) <= 0

  useSortable(listRef, {
    groupSelector: '[data-sort-group]',
    disabled: !!editing || !!editingGroup || !!adding,
    onDrop: (info) => {
      if (!info.toGroup) return
      undoable('Moved category', () => placeCategory(info.id, info.toGroup!, info.index))
      play('drop')
    },
  })
  useSortable(listRef, {
    itemSelector: '[data-group-id]',
    idAttr: 'data-group-id',
    handleSelector: '[data-group-handle]',
    disabled: !!editing || !!editingGroup || !!adding,
    onDrop: (info) => {
      undoable('Moved group', () => placeGroup(info.id, info.index))
      play('drop')
    },
  })

  // ← → switch months on a keyboard. Functional updates, so quick or held presses each move one month.
  const setMonth = props.setMonth
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowLeft') setMonth((m) => addMonths(m, -1))
      else if (e.key === 'ArrowRight') setMonth((m) => addMonths(m, 1))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setMonth])

  const allAssigned = () => shownSign(monthView(getIndex(), month, current).readyToAssign, base) === 0

  /** Fill in a month's plan (this one, or the next as a head start). */
  function fill(m: Month = month) {
    const ahead = m !== month
    const amt = fillMonth(m, current, ahead ? `Head start for ${monthName(m)}` : 'Filled in the plan')
    if (!amt) return
    if (!allAssigned()) play('success') // otherwise the celebration plays
    flash(rtaRef.current, 'pulse-once')
    toast(ahead ? `${fmt(amt, base)} set aside for ${monthName(m)}` : `${fmt(amt, base)} assigned`, { undo: true })
  }

  /** Delete a category from its row: an unused one goes (undoable); one with history asks what happens to it. */
  function removeCategory(cat: Category) {
    if (used.has(cat.id)) {
      askToDelete(cat.id)
      props.onCategory(cat.id)
      return
    }
    undoable(`Deleted ${cat.name}`, () => deleteCategory(cat.id))
    play('delete')
    toast(`${cat.name || 'Category'} deleted`, { undo: true })
  }

  /** The category exists only once it has a name: one undoable step, and Enter goes on to its Assigned box. */
  function newCategory(group: ID, v: string | null, enter: boolean) {
    setAdding(null)
    const name = v?.trim()
    if (!name) return
    const c = undoable(`Added ${name}`, () => addCategory(group, name))
    if (enter) requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`[data-sort-id="${c.id}"] .casg`)?.focus())
  }

  // The one obvious action: fill this month in; once it is full and money is left, give the next month a head start.
  const canFill = planning && toFill > 0 && rtaSign > 0
  const nextMonth = addMonths(month, 1)
  const nextNeed = fc.months.find((f) => f.month === nextMonth)?.need ?? 0
  const fillPill = canFill ? (
    <button class="pill solid sm" onClick={() => fill()}>
      Fill in <small>{fmt(Math.min(toFill, rta), base)}</small>
    </button>
  ) : (
    planning &&
    rtaSign > 0 &&
    nextNeed > 0 && (
      <button class="pill sm" onClick={() => fill(nextMonth)}>
        Head start for {monthName(nextMonth)} <small>{fmt(Math.min(nextNeed, rta), base)}</small>
      </button>
    )
  )

  return (
    <div>
      <div class="pagehead">
        <div class="monthnav">
          <button class="iconbtn" aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <IconChevron dir="left" />
          </button>
          <h1>{monthName(month, { year: month.slice(0, 4) !== today.slice(0, 4) })}</h1>
          <button class="iconbtn" aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <IconChevron dir="right" />
          </button>
        </div>
        {month !== current ? (
          <button class="pill sm" onClick={() => props.setMonth(current)}>
            Now
          </button>
        ) : (
          <button class="iconbtn gear" aria-label={stale ? 'Settings, changes not synced' : 'Settings'} onClick={props.onSettings}>
            <IconGear />
            {stale && <span class="dot" />}
          </button>
        )}
      </div>

      <section class="rta">
        <div class="rta-num" ref={rtaRef} style={{ color: rtaSign < 0 ? 'var(--red)' : rtaSign > 0 ? 'var(--green)' : 'var(--pen)' }}>
          <span class={`marked${rtaSign < 0 ? ' neg' : ''}`}>{fmt(shownRta, base)}</span>
        </div>
        {empty ? (
          // The routine below already lists these steps.
          !showRitual && (
            <div class="rta-line">
              <button class="pill solid sm" onClick={props.onCount}>
                Count your money
              </button>
              <button class="pill sm" onClick={logIncome}>
                Log income
              </button>
            </div>
          )
        ) : (
          <div class="rta-line">
            <span class="rta-cap">{rtaSign > 0 ? 'ready to assign, give it all a job' : rtaSign < 0 ? 'more assigned than you have' : 'every bit has a job'}</span>
            {!showRitual && fillPill && <span class="rta-actions">{fillPill}</span>}
          </div>
        )}
        {planning && !empty && <Saving ix={ix} month={month} current={current} saved={view.saved} />}
        {planning && !empty && <Outlook fc={fc} month={month} base={base} onMonth={props.setMonth} />}
      </section>

      {showRitual && ritual && (
        <Ritual
          r={ritual}
          today={today}
          onCount={props.onCount}
          onReflect={props.onReflect}
          fill={
            canFill && (
              <button class="pill sm" onClick={() => fill()}>
                Fill in <small>{fmt(Math.min(toFill, rta), base)}</small>
              </button>
            )
          }
        />
      )}

      <div class="colhead" aria-hidden="true">
        <span style={{ textAlign: 'left' }} />
        <span>Assigned</span>
        <span>Spent</span>
        <span>Available</span>
      </div>

      <div ref={listRef}>
        {view.groups.map((g) => (
          <div class="grp" key={g.group.id} data-group-id={g.group.id}>
            <div class="grp-head">
              <div class="grp-name" data-group-handle>
                {editingGroup === g.group.id ? (
                  <InlineInput
                    value={g.group.name}
                    label="Group name"
                    plain
                    onDone={(v) => {
                      setEditingGroup(null)
                      if (v === null) return
                      if (!v.trim()) {
                        if (!g.cats.length) {
                          undoable(`Deleted ${g.group.name}`, () => deleteGroup(g.group.id))
                          play('delete')
                          toast(`${g.group.name} deleted`, { undo: true })
                        }
                        return
                      }
                      if (v.trim() !== g.group.name) saveGroup({ ...g.group, name: v.trim() } as Group)
                    }}
                  />
                ) : (
                  <span
                    class="grp-text"
                    role="button"
                    tabIndex={0}
                    aria-label={`Rename ${g.group.name}`}
                    onClick={() => setEditingGroup(g.group.id)}
                    onKeyDown={onActivate(() => setEditingGroup(g.group.id))}
                  >
                    {g.group.name}
                  </span>
                )}
              </div>
              <button class="iconbtn grp-add" aria-label={`Add a category to ${g.group.name}`} onClick={() => setAdding(g.group.id)}>
                <IconPlus />
              </button>
            </div>
            <div data-sort-group={g.group.id} style={{ minHeight: g.cats.length || adding === g.group.id ? undefined : '14px' }}>
              {g.cats.map((c) => (
                <CatRow
                  key={c.cat.id}
                  c={c}
                  base={base}
                  month={month}
                  plan={byCat.get(c.cat.id)}
                  used={used.has(c.cat.id)}
                  editing={editing?.id === c.cat.id ? editing.field : null}
                  setEditing={(f) => setEditing(f ? { id: c.cat.id, field: f } : null)}
                  onOpen={() => props.onCategory(c.cat.id)}
                  onSpent={() => setSpentOf(c.cat.id)}
                  onDelete={() => removeCategory(c.cat)}
                />
              ))}
            </div>
            {adding === g.group.id && (
              <div class="crow editing">
                <div class="cname">
                  <div class="cname-line">
                    <InlineInput value="" label="New category name" placeholder="Name" plain onDone={(v, enter) => newCategory(g.group.id, v, enter)} />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div class="newgroup">
        {addingGroup ? (
          <div class="grp-head">
            <div class="grp-name">
              <InlineInput
                value=""
                label="New group name"
                plain
                onDone={(v) => {
                  setAddingGroup(false)
                  if (v?.trim()) {
                    undoable('Added group', () => addGroup(v.trim()))
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <button class="pill ghost" onClick={() => setAddingGroup(true)}>
            <IconPlus /> Group
          </button>
        )}
      </div>
      <SpentSheet cat={spentOf} month={month} today={today} onClose={() => setSpentOf(null)} />
    </div>
  )
}

/** The month's savings against the target: "Saving NT$9,000 of NT$12,000", a thin bar, the share of income. */
function Saving(props: { ix: Index; month: Month; current: Month; saved: number }) {
  const { ix, month } = props
  const base = ix.settings.base
  const goal = savingsGoal(ix, month, props.current)
  if (goal <= 0 || !ix.cats.some((c) => c.saving && !c.archived)) return null
  const done = props.saved >= goal
  return (
    <div class={`plan-save${done ? ' done' : ''}`}>
      <div class="plan-save-line">
        <span>
          Saving <b class="num">{fmt(Math.max(0, props.saved), base)}</b>
          {!done && <> of {fmt(goal, base)}</>}
        </span>
        <span class="faint">{Math.round(ix.settings.savingsTarget * 100)}% of income</span>
      </div>
      <div class="plan-save-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(0, (props.saved / goal) * 100))}%` }} />
      </div>
    </div>
  )
}

/**
 * How the coming months play out: one chip per month (planned, covered by what's expected, or short),
 * tap one to go there, and one line saying where the money runs out or how far it reaches.
 */
function Outlook(props: { fc: Forecast; month: Month; base: string; onMonth: (m: Month) => void }) {
  const { fc, base } = props
  if (fc.typical <= 0) return null
  const short = fc.runsOut ? fc.months.find((m) => m.month === fc.runsOut)! : null
  const last = fc.months[fc.months.length - 1]
  const ahead = Math.floor(fc.ahead * 10) / 10
  return (
    <div class="outlook">
      <div class="outlook-months" role="group" aria-label="Coming months">
        {fc.months.map((m) => {
          const state = m.left < 0 ? 'short' : m.funded ? 'funded' : 'covered'
          const label = state === 'short' ? `short ${fmt(-m.left, base)}` : state === 'funded' ? 'planned' : 'covered'
          return (
            <button
              key={m.month}
              class={`outlook-m ${state}`}
              aria-current={m.month === props.month ? 'true' : undefined}
              aria-label={`${monthName(m.month)}: ${label}`}
              onClick={() => props.onMonth(m.month)}
            >
              {monthName(m.month, { short: true })}
            </button>
          )
        })}
      </div>
      <p class={`outlook-line${short ? ' neg' : ''}`}>
        {short ? (
          <>
            Short <span class="num">{fmt(-short.left, base)}</span> in {monthName(short.month)}
          </>
        ) : (
          <>
            Covered through {monthName(last.month)}
            {ahead >= 1 && <span class="faint"> · {ahead} {ahead === 1 ? 'month' : 'months'} ahead</span>}
          </>
        )}
      </p>
    </div>
  )
}

/**
 * A text input that commits on Enter/blur (value) and cancels on Escape (null).
 * Once it is taken away (the row switched to another editor) a late blur no longer counts.
 * `plain` is for names: no spellcheck squiggles or autocorrect.
 */
function InlineInput(props: { value: string; label: string; onDone: (v: string | null, enter: boolean) => void; placeholder?: string; plain?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  // A layout cleanup runs before the input leaves the DOM (and fires its blur); a passive one would run too late.
  useLayoutEffect(
    () => () => {
      done.current = true
    },
    [],
  )
  const finish = (v: string | null, enter = false) => {
    if (done.current) return
    done.current = true
    props.onDone(v, enter)
  }
  return (
    <input
      ref={ref}
      type="text"
      aria-label={props.label}
      placeholder={props.placeholder}
      defaultValue={props.value}
      spellcheck={props.plain ? false : undefined}
      autocorrect={props.plain ? 'off' : undefined}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value, true)
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

function CatRow(props: {
  c: CatMonth
  base: string
  month: string
  /** the planner's suggestion for this month (none in past months) */
  plan?: Suggestion
  /** has history: a swipe asks what to do with it instead of deleting */
  used: boolean
  editing: 'name' | 'note' | null
  setEditing: (f: 'name' | 'note' | null) => void
  onOpen: () => void
  onSpent: () => void
  onDelete: () => void
}) {
  const { c, base } = props
  const cat = c.cat
  const spent = -c.activity
  const short = c.need > 0 && c.available >= 0
  const tone = c.available < 0 ? 'neg' : short ? 'short' : c.available > 0 ? 'pos' : 'zero'
  const availText = fmt(c.available, base, { bare: true })
  const [draft, setDraftVal] = useState<string | null>(null)
  const asgRef = useRef<HTMLInputElement>(null)
  // Typed into since it got focus. Until then the box just mirrors the stored amount.
  const edited = useRef(false)
  const toDraft = (v: number) => (v ? groupTyped(String(v / 100)) : '')
  // An empty box shows what the plan suggests, faintly; typing (or Fill in) makes it real.
  const ghost = !c.assigned && props.plan && props.plan.want > 0 ? props.plan.want : 0
  const asgText = draft ?? (ghost ? '' : fmt(c.assigned, base, { bare: true }))
  const calc = useCalc()
  const swipe = useSwipeDelete<HTMLDivElement, HTMLDivElement>(props.onDelete, { keep: props.used, disabled: !!props.editing })

  // The stored amount changed (undo, sync, a quick-assign pill): never keep showing an old draft.
  useEffect(() => {
    if (edited.current) return
    const el = asgRef.current
    const focused = document.activeElement === el
    setDraftVal(focused ? toDraft(c.assigned) : null)
    if (focused && el) caretToEnd(el)
  }, [c.assigned])

  function saveName(v: string | null, keepEditing = false) {
    if (!keepEditing) props.setEditing(null)
    const name = (v ?? '').trim()
    if (v === null || !name) {
      // An unnamed new category disappears, a moment later so the tap that left it still lands where aimed.
      if (!cat.name) setTimeout(() => deleteCategory(cat.id), 260)
      return
    }
    if (name !== cat.name) undoable('Renamed category', () => saveCategory({ ...cat, name }))
  }

  function saveNote(v: string | null) {
    props.setEditing(null)
    if (v === null) return
    const note = v.trim()
    if (note === (cat.note ?? '')) return
    const next: Category = { ...cat }
    if (note) next.note = note
    else delete next.note
    undoable('Edited note', () => saveCategory(next))
  }

  function commitAssign(raw: string) {
    const wasEdited = edited.current
    edited.current = false
    setDraftVal(null)
    if (!wasEdited) return
    const v = raw.trim() === '' ? 0 : evalAmount(raw, base)
    if (v === null || v === c.assigned) return
    undoable(`Assigned ${cat.name}`, () => setAssigned(props.month, cat.id, v))
  }

  /** Save the name being typed (if any) and open the note field instead. */
  function addNote(nameInput: HTMLInputElement | null) {
    if (nameInput) saveName(nameInput.value, true)
    props.setEditing('note')
  }

  const isLast = () => {
    const all = document.querySelectorAll('.casg')
    return all[all.length - 1] === asgRef.current
  }
  const shown = (v: number) => (v || !ghost ? fmt(v, base, { bare: true }) : '')

  return (
    <div class="crow-wrap" ref={swipe.wrap} data-sort-id={cat.id}>
      <div class="swipe-del" aria-hidden="true">
        Delete
      </div>
      <div
        ref={swipe.row}
        class={`crow${c.available < 0 ? ' over' : ''}${props.editing ? ' editing' : ''}`}
        // A swipe starts anywhere but the Assigned box, and never while the row is being dragged into place.
        onPointerDown={(e) => {
          if (!(e.target as Element).closest('input')) swipe.handlers.onPointerDown(e)
        }}
        onPointerMove={(e) => {
          if (!document.body.classList.contains('is-sorting')) swipe.handlers.onPointerMove(e)
        }}
        onPointerUp={swipe.handlers.onPointerUp}
        onPointerCancel={swipe.handlers.onPointerCancel}
      >
        <div class="cname">
          <div class="cname-line">
            {props.editing === 'name' ? (
              <InlineInput key="edit" value={cat.name} label="Category name" plain onDone={(v) => saveName(v)} />
            ) : (
              <span
                key="name"
                class="cname-text"
                role="button"
                tabIndex={0}
                aria-label={`Rename ${cat.name}`}
                aria-keyshortcuts="Delete"
                onClick={(e) => !swipe.swallow(e) && props.setEditing('name')}
                onKeyDown={(e) => {
                  // Delete on a focused name deletes the row, as a swipe does on a phone.
                  if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault()
                    props.onDelete()
                  } else onActivate(() => props.setEditing('name'))(e)
                }}
              >
                {cat.name || '—'}
              </span>
            )}
            {!cat.note && props.editing !== 'note' && (
              <span
                key="add"
                class="cnote-add"
                role="button"
                // A tab stop only while renaming, so the keyboard path is name → Add note → Assigned.
                tabIndex={props.editing === 'name' ? 0 : -1}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  // Act now and keep the name field from blurring first (that would re-render this away before the tap lands).
                  e.preventDefault()
                  addNote(e.currentTarget.closest('.cname')?.querySelector('input') ?? null)
                }}
                onClick={() => props.setEditing('note')}
                onKeyDown={onActivate(() => props.setEditing('note'))}
              >
                Add note
              </span>
            )}
          </div>
          {props.editing === 'note' ? (
            <div class="cnote">
              <InlineInput value={cat.note ?? ''} label="Note" onDone={saveNote} />
            </div>
          ) : cat.note ? (
            <div
              class="cnote"
              role="button"
              tabIndex={0}
              onClick={(e) => !swipe.swallow(e) && props.setEditing('note')}
              onKeyDown={onActivate(() => props.setEditing('note'))}
            >
              {cat.note}
            </div>
          ) : null}
        </div>
        <input
          ref={asgRef}
          class="casg"
          type="text"
          autocomplete="off"
          {...calc.field}
          data-no-drag
          aria-label={`Assigned to ${cat.name}`}
          placeholder={ghost ? fmt(ghost, base, { bare: true }) : undefined}
          value={asgText}
          style={{ '--len': (asgText || (ghost ? fmt(ghost, base, { bare: true }) : '')).length }}
          onFocus={(e) => {
            edited.current = false
            setDraftVal(toDraft(c.assigned))
            caretToEnd(e.currentTarget)
          }}
          onInput={(e) => {
            const el = e.currentTarget
            // Edits that don't come from typing here (the browser's own undo reaching a box that has
            // lost focus) are put back: the box always shows what is stored.
            if (document.activeElement !== el) {
              el.value = asgText
              return
            }
            edited.current = true
            setDraftVal(regroup(e))
          }}
          onBlur={(e) => commitAssign(e.currentTarget.value)}
          onKeyDown={(e) => {
            const all = [...document.querySelectorAll<HTMLInputElement>('.casg')]
            const i = all.indexOf(e.currentTarget)
            if (e.key === 'Enter' || e.key === 'ArrowDown') {
              e.preventDefault()
              if (all[i + 1]) all[i + 1].focus()
              else e.currentTarget.blur()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              all[i - 1]?.focus()
            } else if (e.key === 'Escape') {
              edited.current = false
              setDraftVal(null)
              e.currentTarget.value = shown(c.assigned)
              e.currentTarget.blur()
            }
          }}
        />
        {calc.pad(() => ({
          next: !isLast(),
          hint: ghost ? { label: cat.target ? 'Target' : cat.saving ? 'Savings' : 'Usual', value: ghost } : undefined,
        }))}
        <button
          class="cspent num"
          data-no-drag
          tabIndex={-1}
          onClick={(e) => !swipe.swallow(e) && props.onSpent()}
          aria-label={`${cat.name}: ${fmt(spent, base)} spent. Show`}
        >
          {fmt(spent, base, { bare: true })}
        </button>
        <button
          class={`avail num ${tone}`}
          data-no-drag
          style={{ '--len': availText.length }}
          onClick={(e) => !swipe.swallow(e) && props.onOpen()}
          aria-label={`${cat.name}: ${fmt(c.available, base)} available. Open`}
        >
          {availText}
        </button>
      </div>
    </div>
  )
}

/** Where the start-of-month routine stands, or null while it isn't showing (after the 12th, hidden, or all done). */
function useRitual(today: string) {
  const ix = useIndex()
  const month = monthOf(today)
  const prev = addMonths(month, -1)
  const key = `mio-ritual-${month}`
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const left = useMemo(() => {
    const view = monthView(ix, month, month)
    return { rta: view.readyToAssign, toFill: suggestions(ix, month, month).reduce((s, x) => s + extraOf(x), 0) }
  }, [ix, month])
  if (dayOfMonth(today) > 12 || hidden || !live(ix.db.accounts).length) return null
  const count = lastCount()
  const counted = !!count && monthOf(count.date) === month
  const incomeNow = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === month)
  const seen = new Set(incomeNow.map((t) => (t.note ?? '').toLowerCase()))
  const again = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === prev && !seen.has((t.note ?? '').toLowerCase())).slice(0, 4)
  const hasHistory = ix.months.some((m) => m < month)
  const reflected = !!ix.db.notes[prev]?.text?.trim()
  const funded = left.toFill === 0 || left.rta <= 0
  if (counted && incomeNow.length > 0 && funded && (reflected || !hasHistory)) return null
  const hide = () => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* private mode */
    }
    setHidden(true)
  }
  return { prev, counted, logged: incomeNow.length > 0, suggestions: again, hasHistory, reflected, funded, hide }
}

/** One numbered step; a check once it's done. */
function Step(props: { n: number; done: boolean; text: ComponentChildren; children?: ComponentChildren }) {
  return (
    <li class={props.done ? 'done' : ''}>
      <span class="step" aria-label={props.done ? 'Done' : undefined}>
        {props.done ? '✓' : props.n}
      </span>
      <span class="ritual-text">{props.text}</span>
      {props.children}
    </li>
  )
}

/** The start-of-month routine from the spreadsheet: count, log income, fill in the plan, look back. */
function Ritual(props: {
  r: NonNullable<ReturnType<typeof useRitual>>
  today: string
  onCount: () => void
  onReflect: (m: string) => void
  fill: ComponentChildren
}) {
  const { r, today } = props
  return (
    <section class="ritual">
      <ol>
        <Step n={1} done={r.counted} text="Count your money">
          {!r.counted && (
            <button class="pill sm" onClick={props.onCount}>
              Count
            </button>
          )}
        </Step>
        <Step n={2} done={r.logged} text="Log your income">
          {!r.logged && !r.suggestions.length && (
            <button class="pill sm" onClick={logIncome}>
              Log
            </button>
          )}
          {r.suggestions.length > 0 && (
            <div class="pills">
              {r.suggestions.map((t) => (
                <button
                  key={t.id}
                  class="pill sm"
                  onClick={() => {
                    undoable(`${fmt(t.amt, t.cur)} income`, () => addTxn({ date: today, cat: RTA, amt: t.amt, cur: t.cur, note: t.note }))
                    play('income')
                    toast(`+${fmt(t.amt, t.cur)} ready to assign`, { undo: true })
                  }}
                >
                  {t.note || 'Income'} <small>{fmt(t.amt, t.cur)}</small>
                </button>
              ))}
            </div>
          )}
        </Step>
        <Step n={3} done={r.funded} text="Fill in your plan">
          {props.fill}
        </Step>
        {r.hasHistory && (
          <Step n={4} done={r.reflected} text={`Look back at ${monthName(r.prev)}`}>
            {!r.reflected && (
              <button class="pill sm" onClick={() => props.onReflect(r.prev)}>
                Write
              </button>
            )}
          </Step>
        )}
      </ol>
      <button class="link ritual-hide" onClick={r.hide}>
        Hide for this month
      </button>
    </section>
  )
}
