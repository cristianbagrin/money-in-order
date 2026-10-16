import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { monthView, type CatMonth } from '../lib/budget'
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
import { useIndex } from '../ui/hooks'
import { IconChevron, IconGear, IconPlus, toast } from '../ui/kit'
import { flash, useCountUp } from '../ui/motion'
import { play } from '../ui/sound'
import { useSortable } from '../ui/sortable'

export function Plan(props: {
  today: string
  month: string
  setMonth: (m: string) => void
  onCategory: (id: ID) => void
  onCount: () => void
  onReflect: (month: string) => void
  onSettings: () => void
}) {
  const ix = useIndex()
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

  const prevHasPlan = (ix.asg.get(addMonths(month, -1))?.size ?? 0) > 0
  let lastMonthTotal = 0
  for (const [id, v] of ix.asg.get(addMonths(month, -1)) ?? []) if (v > 0 && !ix.catById.get(id)?.archived) lastMonthTotal += v
  const [addingGroup, setAddingGroup] = useState(false)
  const showRitual = month === current && dayOfMonth(today) <= 12

  useSortable(listRef, {
    groupSelector: '[data-sort-group]',
    disabled: !!editing || !!editingGroup,
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
    disabled: !!editing || !!editingGroup,
    onDrop: (info) => {
      undoable('Moved group', () => placeGroup(info.id, info.index))
      play('drop')
    },
  })

  // ← → switch months on a keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowLeft') props.setMonth(addMonths(month, -1))
      else if (e.key === 'ArrowRight') props.setMonth(addMonths(month, 1))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [month])

  function fund() {
    const amt = undoable('Funded targets', () => fundTargets(month, current))
    if (!amt) return
    play('success')
    flash(rtaRef.current, 'pulse-once')
    toast(`${fmt(amt, base)} went to your targets`, { undo: true })
  }

  function newCategory(group: ID) {
    const c = addCategory(group, '')
    setEditing({ id: c.id, field: 'name' })
  }

  return (
    <div>
      <div class="pagehead">
        <div class="monthnav">
          <button class="iconbtn" aria-label="Previous month" onClick={() => props.setMonth(addMonths(month, -1))}>
            <IconChevron dir="left" />
          </button>
          <h1>{monthName(month, { year: month.slice(0, 4) !== today.slice(0, 4) })}</h1>
          <button class="iconbtn" aria-label="Next month" onClick={() => props.setMonth(addMonths(month, 1))}>
            <IconChevron dir="right" />
          </button>
        </div>
        {month !== current ? (
          <button class="pill sm" onClick={() => props.setMonth(current)}>
            Now
          </button>
        ) : (
          <button class="iconbtn gear" aria-label="Settings" onClick={props.onSettings}>
            <IconGear />
          </button>
        )}
      </div>

      <section class="rta">
        <div class="rta-num" ref={rtaRef} style={{ color: rta < 0 ? 'var(--red)' : rta > 0 ? 'var(--green)' : 'var(--pen)' }}>
          <span class={`marked${rta < 0 ? ' neg' : ''}`}>{fmt(shownRta, base)}</span>
        </div>
        <div class="rta-cap">
          {rta > 0 ? 'ready to assign, give it all a job.' : rta < 0 ? 'more assigned than you have.' : 'Every bit has a job.'}
        </div>
        {(view.need > 0 && rta > 0) || (view.assigned === 0 && prevHasPlan && rta > 0) ? (
          <div class="rta-actions">
            {view.need > 0 && rta > 0 && (
              <button class="pill solid" onClick={fund}>
                Fund targets <small>{fmt(Math.min(view.need, rta), base)}</small>
              </button>
            )}
            {view.assigned === 0 && prevHasPlan && rta > 0 && (
              <button
                class="pill"
                onClick={() => {
                  undoable('Repeated last month', () => repeatLastMonth(month))
                  play('success')
                  toast('Last month’s plan copied', { undo: true })
                }}
              >
                Repeat last month <small>{fmt(lastMonthTotal, base)}</small>
              </button>
            )}
          </div>
        ) : null}
      </section>

      {showRitual && <Ritual today={today} onCount={props.onCount} onReflect={props.onReflect} />}

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
                  <span onClick={() => setEditingGroup(g.group.id)}>{g.group.name}</span>
                )}
              </div>
              <button class="iconbtn grp-add" aria-label={`Add a category to ${g.group.name}`} onClick={() => newCategory(g.group.id)}>
                <IconPlus />
              </button>
            </div>
            <div data-sort-group={g.group.id} style={{ minHeight: g.cats.length ? undefined : '14px' }}>
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

/** A text input that commits on Enter/blur (value) and cancels on Escape (null). */
function InlineInput(props: { value: string; label: string; onDone: (v: string | null) => void; placeholder?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    props.onDone(v)
  }
  return (
    <input
      ref={ref}
      type="text"
      aria-label={props.label}
      placeholder={props.placeholder}
      defaultValue={props.value}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value)
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
  const used = budget > 0 ? Math.min(100, (Math.max(0, spent) / budget) * 100) : spent > 0 ? 100 : 0
  const [draft, setDraftVal] = useState<string | null>(null)

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
    setDraftVal(null)
    const v = raw.trim() === '' ? 0 : evalAmount(raw)
    if (v === null || v === c.assigned) return
    undoable(`Assigned ${cat.name}`, () => setAssigned(props.month, cat.id, v))
    play('tap')
  }

  return (
    <div class={`crow${c.available < 0 ? ' over' : ''}${props.editing ? ' editing' : ''}`} data-sort-id={cat.id} style={{ '--used': `${used}%` }}>
      <div class="cname">
        <div class="cname-line">
          {props.editing === 'name' ? (
            <InlineInput value={cat.name} label="Category name" onDone={(v) => saveName(v)} />
          ) : (
            <span class="cname-text" onClick={() => props.setEditing('name')}>
              {cat.name || '—'}
            </span>
          )}
          {!cat.note && props.editing !== 'note' && (
            <span
              class="cnote-add"
              onPointerDown={(e) => {
                // Keep the name field from blurring first (that would re-render this away before the tap lands).
                e.preventDefault()
                const input = (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement | null) ?? null
                if (input) saveName(input.value, true)
                props.setEditing('note')
              }}
              onClick={() => props.setEditing('note')}
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
          <div class="cnote" onClick={() => props.setEditing('note')}>
            {cat.note}
          </div>
        ) : null}
      </div>
      <input
        class="casg"
        type="text"
        inputMode="decimal"
        data-no-drag
        aria-label={`Assigned to ${cat.name}`}
        value={draft ?? fmt(c.assigned, base, { bare: true })}
        onFocus={(e) => {
          setDraftVal(c.assigned ? String(c.assigned / 100) : '')
          const el = e.currentTarget
          requestAnimationFrame(() => document.activeElement === el && el.select())
        }}
        onInput={(e) => setDraftVal(e.currentTarget.value)}
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
            setDraftVal(null)
            e.currentTarget.value = fmt(c.assigned, base, { bare: true })
            e.currentTarget.blur()
          }
        }}
      />
      <span class="cspent num">{fmt(spent, base, { bare: true })}</span>
      <button class={`avail num ${tone}`} data-no-drag onClick={props.onOpen} aria-label={`${cat.name}: ${fmt(c.available, base)} available. Open`}>
        {fmt(c.available, base)}
      </button>
    </div>
  )
}

/** The start-of-month routine from the spreadsheet: count, log income, fund, look back. */
function Ritual(props: { today: string; onCount: () => void; onReflect: (m: string) => void }) {
  const ix = useIndex()
  const { today } = props
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
  const count = lastCount()
  const counted = !!count && monthOf(count.date) === month
  const incomeNow = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === month)
  const seen = new Set(incomeNow.map((t) => (t.note ?? '').toLowerCase()))
  const suggestions = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) === prev && !seen.has((t.note ?? '').toLowerCase())).slice(0, 4)
  const hasHistory = ix.months.some((m) => m < month)
  const reflected = !!ix.db.notes[prev]?.text?.trim()
  const funded = view.need === 0 || view.readyToAssign <= 0
  const allDone = counted && incomeNow.length > 0 && funded && (reflected || !hasHistory)
  if (hidden || allDone || !live(ix.db.accounts).length) return null

  return (
    <section class="ritual">
      <ol>
        <li class={counted ? 'done' : ''}>
          <span class="step">✓</span>
          <span class="ritual-text">Count your money</span>
          {!counted && (
            <button class="pill sm" onClick={props.onCount}>
              Count
            </button>
          )}
        </li>
        <li class={incomeNow.length ? 'done' : ''}>
          <span class="step">✓</span>
          <span class="ritual-text">Log your income</span>
        </li>
        {suggestions.length > 0 && (
          <div class="pills">
            {suggestions.map((t) => (
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
        <li class={funded ? 'done' : ''}>
          <span class="step">✓</span>
          <span class="ritual-text">Fund your targets</span>
        </li>
        {hasHistory && (
          <li class={reflected ? 'done' : ''}>
            <span class="step">✓</span>
            <span class="ritual-text">Look back at {monthName(prev)}</span>
            {!reflected && (
              <button class="pill sm" onClick={() => props.onReflect(prev)}>
                Write
              </button>
            )}
          </li>
        )}
      </ol>
      <button
        class="link"
        style={{ fontSize: '13px', color: 'var(--ink-3)' }}
        onClick={() => {
          try {
            localStorage.setItem(key, '1')
          } catch {
            /* private mode */
          }
          setHidden(true)
        }}
      >
        Hide for this month
      </button>
    </section>
  )
}
