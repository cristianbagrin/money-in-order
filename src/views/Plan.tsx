import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { expectedTotal, monthView, type CatMonth } from '../lib/budget'
import { addMonths, dayOfMonth, monthName, monthOf } from '../lib/dates'
import { evalAmount, fmt } from '../lib/money'
import {
  addCategory,
  addGroup,
  addTxn,
  deleteCategory,
  deleteGroup,
  fundTargets,
  lastCount,
  placeCategory,
  placeGroup,
  repeatLastMonth,
  saveCategory,
  saveGroup,
  setAssigned,
  undoable,
} from '../lib/store'
import { live, RTA, type Category, type Group, type ID } from '../lib/types'
import { useIndex, useSync } from '../ui/hooks'
import { IconChevron, IconGear, IconPlus, toast } from '../ui/kit'
import { flash, useCountUp } from '../ui/motion'
import { play } from '../ui/sound'
import { useSortable } from '../ui/sortable'

/** Enter or Space on a focused text "button" (names, notes) does what a click does. */
const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  fn()
}

const logIncome = () => {
  location.hash = '#/today'
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
  const shownRta = useCountUp(rta)
  const rtaRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<{ id: ID; field: 'name' | 'note' } | null>(null)
  const [editingGroup, setEditingGroup] = useState<ID | null>(null)
  const [adding, setAdding] = useState<ID | null>(null)

  const prevHasPlan = (ix.asg.get(addMonths(month, -1))?.size ?? 0) > 0
  let lastMonthTotal = 0
  for (const [id, v] of ix.asg.get(addMonths(month, -1)) ?? []) if (v > 0 && !ix.catById.get(id)?.archived) lastMonthTotal += v
  const [addingGroup, setAddingGroup] = useState(false)
  const ritual = useRitual(today)
  const showRitual = month === current && !!ritual
  // A budget with no money in it yet: the next step is to count it or log income.
  const empty = rta === 0 && view.assigned === 0 && expectedTotal(ix) <= 0

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

  function fund() {
    const amt = undoable('Funded targets', () => fundTargets(month, current))
    if (!amt) return
    play('success')
    flash(rtaRef.current, 'pulse-once')
    toast(`${fmt(amt, base)} went to your targets`, { undo: true })
  }

  function repeat() {
    undoable('Repeated last month', () => repeatLastMonth(month))
    play('success')
    toast('Last month’s plan copied', { undo: true })
  }

  /** The category exists only once it has a name: one undoable step, and Enter goes on to its Assigned box. */
  function newCategory(group: ID, v: string | null, enter: boolean) {
    setAdding(null)
    const name = v?.trim()
    if (!name) return
    const c = undoable(`Added ${name}`, () => addCategory(group, name))
    play('tap')
    if (enter) requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`[data-sort-id="${c.id}"] .casg`)?.focus())
  }

  const canFund = view.need > 0 && rta > 0
  const canRepeat = view.assigned === 0 && prevHasPlan && rta > 0
  const fundPill = canFund && (
    <button class="pill solid sm" onClick={fund}>
      Fund targets {view.need < rta && <small>{fmt(view.need, base)}</small>}
    </button>
  )
  const repeatPill = canRepeat && (
    <button class="pill sm" onClick={repeat}>
      Repeat last month <small>{fmt(lastMonthTotal, base)}</small>
    </button>
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
        <div class="rta-num" ref={rtaRef} style={{ color: rta < 0 ? 'var(--red)' : rta > 0 ? 'var(--green)' : 'var(--pen)' }}>
          <span class={`marked${rta < 0 ? ' neg' : ''}`}>{fmt(shownRta, base)}</span>
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
            <span class="rta-cap">{rta > 0 ? 'ready to assign, give it all a job.' : rta < 0 ? 'more assigned than you have.' : 'every bit has a job.'}</span>
            {!showRitual && (fundPill || repeatPill) && (
              <span class="rta-actions">
                {fundPill}
                {repeatPill}
              </span>
            )}
          </div>
        )}
      </section>

      {showRitual && ritual && (
        <Ritual
          r={ritual}
          today={today}
          onCount={props.onCount}
          onReflect={props.onReflect}
          fund={
            canFund && (
              <button class="pill sm" onClick={fund}>
                Fund <small>{fmt(Math.min(view.need, rta), base)}</small>
              </button>
            )
          }
          repeat={repeatPill}
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
                  editing={editing?.id === c.cat.id ? editing.field : null}
                  setEditing={(f) => setEditing(f ? { id: c.cat.id, field: f } : null)}
                  onOpen={() => props.onCategory(c.cat.id)}
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
                    play('tap')
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
  editing: 'name' | 'note' | null
  setEditing: (f: 'name' | 'note' | null) => void
  onOpen: () => void
}) {
  const { c, base } = props
  const cat = c.cat
  const budget = c.carry + c.assigned
  const spent = -c.activity
  const short = c.need > 0 && c.available >= 0
  const tone = c.available < 0 ? 'neg' : short ? 'short' : c.available > 0 ? 'pos' : 'zero'
  const used = budget > 0 ? Math.min(1, Math.max(0, spent) / budget) : spent > 0 ? 1 : 0
  const availText = fmt(c.available, base, { bare: true })
  const [draft, setDraftVal] = useState<string | null>(null)
  const asgRef = useRef<HTMLInputElement>(null)
  // Typed into since it got focus. Until then the box just mirrors the stored amount.
  const edited = useRef(false)
  const toDraft = (v: number) => (v ? String(v / 100) : '')
  const asgText = draft ?? fmt(c.assigned, base, { bare: true })

  // The stored amount changed (undo, sync, a quick-assign pill): never keep showing an old draft.
  useEffect(() => {
    if (edited.current) return
    setDraftVal(document.activeElement === asgRef.current ? toDraft(c.assigned) : null)
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
    play('tap')
  }

  /** Save the name being typed (if any) and open the note field instead. */
  function addNote(nameInput: HTMLInputElement | null) {
    if (nameInput) saveName(nameInput.value, true)
    props.setEditing('note')
  }

  return (
    <div class={`crow${c.available < 0 ? ' over' : ''}${props.editing ? ' editing' : ''}`} data-sort-id={cat.id} style={{ '--used': used }}>
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
              onClick={() => props.setEditing('name')}
              onKeyDown={onActivate(() => props.setEditing('name'))}
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
          <div class="cnote" role="button" tabIndex={0} onClick={() => props.setEditing('note')} onKeyDown={onActivate(() => props.setEditing('note'))}>
            {cat.note}
          </div>
        ) : null}
      </div>
      <input
        ref={asgRef}
        class="casg"
        type="text"
        inputMode="decimal"
        data-no-drag
        aria-label={`Assigned to ${cat.name}`}
        value={asgText}
        style={{ '--len': asgText.length }}
        onFocus={(e) => {
          edited.current = false
          setDraftVal(toDraft(c.assigned))
          const el = e.currentTarget
          requestAnimationFrame(() => document.activeElement === el && el.select())
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
          setDraftVal(el.value)
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
            e.currentTarget.value = fmt(c.assigned, base, { bare: true })
            e.currentTarget.blur()
          }
        }}
      />
      <span class="cspent num">{fmt(spent, base, { bare: true })}</span>
      <button
        class={`avail num ${tone}`}
        data-no-drag
        style={{ '--len': availText.length }}
        onClick={props.onOpen}
        aria-label={`${cat.name}: ${fmt(c.available, base)} available. Open`}
      >
        {availText}
      </button>
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
  const view = useMemo(() => monthView(ix, month, month), [ix, month])
  if (dayOfMonth(today) > 12 || hidden || !live(ix.db.accounts).length) return null
  const count = lastCount()
  const counted = !!count && monthOf(count.date) === month
  const incomeNow = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === month)
  const seen = new Set(incomeNow.map((t) => (t.note ?? '').toLowerCase()))
  const suggestions = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === prev && !seen.has((t.note ?? '').toLowerCase())).slice(0, 4)
  const hasHistory = ix.months.some((m) => m < month)
  const reflected = !!ix.db.notes[prev]?.text?.trim()
  const funded = view.need === 0 || view.readyToAssign <= 0
  if (counted && incomeNow.length > 0 && funded && (reflected || !hasHistory)) return null
  const hide = () => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* private mode */
    }
    setHidden(true)
  }
  return { prev, counted, logged: incomeNow.length > 0, suggestions, hasHistory, reflected, funded, hide }
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

/** The start-of-month routine from the spreadsheet: count, log income, fund, look back. */
function Ritual(props: {
  r: NonNullable<ReturnType<typeof useRitual>>
  today: string
  onCount: () => void
  onReflect: (m: string) => void
  fund: ComponentChildren
  repeat: ComponentChildren
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
        <Step n={3} done={r.funded} text="Fund your targets">
          {props.fund}
          {props.repeat && <div class="pills">{props.repeat}</div>}
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
