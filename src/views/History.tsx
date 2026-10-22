import { memo } from 'preact/compat'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { dateLabel } from '../lib/dates'
import { fmt } from '../lib/money'
import { deleteTxns, undoable } from '../lib/store'
import { RTA, type Category, type ID, type Txn } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { IconSearch, toast } from '../ui/kit'
import { play } from '../ui/sound'
import { TxnRow } from './TxnSheet'

const PAGE = 150
const NONE: ReadonlySet<ID> = new Set()

interface Day {
  date: string
  items: Txn[]
  total: number
}

/** One day of rows. Memoized, and left unrendered while it is off screen, so thousands of rows stay smooth. */
const DayGroup = memo(function DayGroup(props: { day: Day; today: string; base: string; catById: Map<ID, Category>; plain: boolean; sel: ReadonlySet<ID> | null; onOpen: (t: Txn, e: MouseEvent) => void; onDelete: (t: Txn) => void }) {
  const { day: d, base, catById } = props
  return (
    <div class="daygrp" style={{ '--n': d.items.length }}>
      <div class="day">
        <span>{dateLabel(d.date, props.today)}</span>
        {d.total !== 0 && <span class="num faint">{fmt(d.total, base)}</span>}
      </div>
      {d.items.map((t) => (
        <TxnRow
          key={t.id}
          t={t}
          base={base}
          catName={t.cat === RTA ? 'Income' : catById.get(t.cat)?.name ?? 'Unknown'}
          plain={props.plain}
          selected={!!props.sel?.has(t.id)}
          onOpen={props.onOpen}
          onDelete={props.onDelete}
        />
      ))}
    </div>
  )
})

export function History(props: { today: string; filter: string; setFilter: (f: string) => void; onEdit: (t: Txn) => void }) {
  const ix = useIndex()
  const base = ix.settings.base
  const { filter } = props
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  // The keyboard selection is a transaction, not a position, so it can't drift onto another row when the list changes.
  const [selId, setSelId] = useState<ID | null>(null)
  // Cmd/Ctrl+click and Shift+click/arrows grow it into a set (always containing selId, the one the arrows move from).
  const [selIds, setSelIds] = useState<ReadonlySet<ID>>(NONE)
  // The key handler reads the latest list and selection from here, so keys pressed faster than a render still act on the right row.
  // anchor is where a Shift range starts.
  const cur = useRef<{ shown: Txn[]; selId: ID | null; ids: ReadonlySet<ID>; anchor: ID | null }>({ shown: [], selId: null, ids: NONE, anchor: null })
  const pick = useCallback((id: ID | null, ids: ReadonlySet<ID>) => {
    cur.current.selId = id
    cur.current.ids = ids
    setSelId(id)
    setSelIds(ids)
  }, [])
  const select = useCallback((id: ID | null) => {
    cur.current.anchor = id
    pick(id, id ? new Set([id]) : NONE)
  }, [])
  /** Select everything from the anchor to id. */
  const range = useCallback((id: ID) => {
    const { shown } = cur.current
    const a = shown.findIndex((t) => t.id === (cur.current.anchor ?? id))
    const b = shown.findIndex((t) => t.id === id)
    if (a < 0 || b < 0) return select(id)
    pick(id, new Set(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((t) => t.id)))
  }, [])
  /** One undoable step for any number of transactions. */
  const remove = useCallback((ts: Txn[]) => {
    if (!ts.length) return
    const gone = new Set(ts.map((t) => t.id))
    const left = [...cur.current.ids].filter((id) => !gone.has(id))
    if (left.length !== cur.current.ids.size) {
      const sel = cur.current.selId
      pick(sel && !gone.has(sel) ? sel : left[left.length - 1] ?? null, left.length ? new Set(left) : NONE)
    }
    undoable('Deleted', () => deleteTxns(ts.map((t) => t.id)))
    play('delete')
    toast(ts.length > 1 ? `${ts.length} deleted` : 'Deleted', { undo: true })
  }, [])
  const removeOne = useCallback((t: Txn) => remove([t]), [])
  const searchRef = useRef<HTMLInputElement>(null)
  const onEdit = useRef(props.onEdit)
  onEdit.current = props.onEdit
  const open = useCallback(
    (t: Txn, e: MouseEvent) => {
      const { ids } = cur.current
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(ids)
        if (!next.delete(t.id)) next.add(t.id)
        cur.current.anchor = t.id
        pick(next.has(t.id) ? t.id : [...next].pop() ?? null, next)
      } else if (e.shiftKey) {
        if (!cur.current.anchor) cur.current.anchor = cur.current.selId ?? t.id
        range(t.id)
      } else onEdit.current(t)
    },
    [],
  )

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const digits = needle.replace(/[,\s]/g, '')
    const isNum = /^\d+(\.\d*)?$/.test(digits)
    return ix.txns.filter((t) => {
      if (filter === 'income' && t.cat !== RTA) return false
      if (filter !== 'all' && filter !== 'income' && t.cat !== filter) return false
      if (!needle) return true
      const cat = t.cat === RTA ? 'income' : ix.catById.get(t.cat)?.name ?? ''
      if ((t.note ?? '').toLowerCase().includes(needle) || cat.toLowerCase().includes(needle)) return true
      // Match the amount as shown (base currency) or as entered, with or without thousands separators.
      return isNum && [t.amt, t.base].some((v) => String(Math.abs(v) / 100).startsWith(digits) || String(Math.round(Math.abs(v) / 100)).startsWith(digits))
    })
  }, [ix, q, filter])

  // A new search or filter starts the list over: nothing selected, back to the first page.
  function restart<T>(set: (v: T) => void, v: T) {
    set(v)
    select(null)
    setLimit(PAGE)
  }

  // Keep the active filter in view where the row scrolls sideways (it may sit far to the right on a phone).
  const pillsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = pillsRef.current
    if (el && el.scrollWidth > el.clientWidth) el.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [filter])

  const shown = useMemo(() => rows.slice(0, limit), [rows, limit])
  cur.current.shown = shown
  cur.current.selId = selId

  // Keyboard: / searches, ↑ ↓ walk the list (Shift extends), Enter opens, Delete deletes the selection (undoable), Esc clears it. The list only takes these
  // keys when nothing else owns them: focus on the page itself or on a row, never on another button or field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey) return
      if (e.key === 'Escape' && cur.current.ids.size) select(null)
      const { shown, selId, ids } = cur.current
      const selIdx = selId ? shown.findIndex((t) => t.id === selId) : -1
      const el = document.activeElement as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      const row = el?.classList.contains('txn') ? el : null
      const inSearch = el === searchRef.current
      const onPage = !el || el === document.body || el === document.documentElement || el.tagName === 'MAIN'
      const arrow = e.key === 'ArrowDown' || e.key === 'ArrowUp'
      // A clicked rail tab or filter pill keeps focus; arrows mean nothing to a button, so they still walk the rows.
      const onButton = !!el && el.tagName === 'BUTTON' && arrow
      if (!row && !inSearch && !onPage && !onButton) return
      const focusedIdx = row ? shown.findIndex((t) => t.id === row.dataset.txn) : -1

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!shown.length) return
        e.preventDefault()
        const from = row ? focusedIdx : selIdx
        const next = Math.max(0, Math.min(shown.length - 1, from + (e.key === 'ArrowDown' ? 1 : -1)))
        if (e.shiftKey) {
          if (!cur.current.anchor || !ids.size) cur.current.anchor = shown[Math.max(from, 0)].id
          range(shown[next].id)
        } else select(shown[next].id)
        if (inSearch) searchRef.current?.blur()
        const node = document.querySelector<HTMLElement>(`[data-txn="${shown[next].id}"]`)
        // Walking with focus on a row keeps the focus on the row you land on.
        if (row || onButton) node?.focus({ preventScroll: true })
        node?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && !typing && !row) {
        // (On a focused row, Enter is the row's own click and opens that row.)
        const t = shown[selIdx]
        if (!t) return
        e.preventDefault()
        onEdit.current(t)
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && !typing) {
        const hit = ids.size > 1 ? shown.filter((t) => ids.has(t.id)) : [shown[row ? focusedIdx : selIdx]].filter(Boolean)
        if (!hit.length) return
        e.preventDefault()
        const i = shown.indexOf(hit[hit.length - 1])
        const j = shown.indexOf(hit[0])
        // The selection moves to the neighbour, so Delete can be pressed again.
        select((shown.slice(i + 1).find((t) => !hit.includes(t)) ?? shown[j - 1])?.id ?? null)
        remove(hit)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A day whose rows haven't changed keeps its object, so its memoized group skips rendering (Show more, sync, edits elsewhere).
  const dayCache = useRef(new Map<string, Day>())
  const days = useMemo(() => {
    const out: Day[] = []
    for (const t of shown) {
      let d = out[out.length - 1]
      if (!d || d.date !== t.date) out.push((d = { date: t.date, items: [], total: 0 }))
      d.items.push(t)
      if (t.cat !== RTA && !t.kind) d.total += t.base
    }
    const prev = dayCache.current
    dayCache.current = new Map()
    return out.map((d) => {
      const p = prev.get(d.date)
      const same = p && p.total === d.total && p.items.length === d.items.length && p.items.every((t, i) => t === d.items[i])
      dayCache.current.set(d.date, same ? p : d)
      return same ? p : d
    })
  }, [shown])
  // Names only matter to the rows, so the map is reused until a name actually changes.
  const nameKey = ix.cats.map((c) => c.id + c.name).join('|')
  const catById = useMemo(() => ix.catById, [nameKey])
  // Each day gets only its own selected rows (the same Set while they don't change), so other days keep skipping render.
  const selCache = useRef(new Map<string, ReadonlySet<ID>>())
  const daySel = useMemo(() => {
    const prev = selCache.current
    const next = new Map<string, ReadonlySet<ID>>()
    if (selIds.size)
      for (const d of days) {
        const s = new Set(d.items.filter((t) => selIds.has(t.id)).map((t) => t.id))
        const p = prev.get(d.date)
        if (s.size) next.set(d.date, p && p.size === s.size && [...s].every((id) => p.has(id)) ? p : s)
      }
    selCache.current = next
    return next
  }, [days, selIds])
  const used = ix.cats.filter((c) => !c.archived)
  const filtered = !!q || filter !== 'all'
  const total = useMemo(() => (filtered ? rows.reduce((s, t) => s + t.base, 0) : 0), [rows, filtered])
  if (!ix.txns.length) return <p class="empty">Nothing yet.</p>

  return (
    <div>
      <label class="searchbar">
        <IconSearch />
        <input ref={searchRef} type="search" aria-label="Search" value={q} onInput={(e) => restart(setQ, e.currentTarget.value)} />
      </label>
      <div class="pills scroll filters" ref={pillsRef}>
        <button class="pill sm" aria-pressed={filter === 'all'} onClick={() => restart(props.setFilter, 'all')}>
          All
        </button>
        <button class="pill sm" aria-pressed={filter === 'income'} onClick={() => restart(props.setFilter, 'income')}>
          Income
        </button>
        {used.map((c) => (
          <button key={c.id} class="pill sm" aria-pressed={filter === c.id} onClick={() => restart(props.setFilter, c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {filtered && rows.length > 0 && (
        <p class="faint" style={{ fontSize: '13px', margin: '12px 0 0' }}>
          {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} · <span class="num">{fmt(total, base, { sign: total > 0 })}</span>
        </p>
      )}
      {days.map((d) => (
        <DayGroup key={d.date} day={d} today={props.today} base={base} catById={catById} plain={filter !== 'all'} sel={daySel.get(d.date) ?? null} onOpen={open} onDelete={removeOne} />
      ))}
      {!rows.length && <p class="empty">Nothing matches.</p>}
      {rows.length > limit && (
        <button class="btn soft block" style={{ marginTop: '16px' }} onClick={() => setLimit(limit + PAGE)}>
          Show more
        </button>
      )}
    </div>
  )
}
