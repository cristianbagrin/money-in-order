import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { dateLabel } from '../lib/dates'
import { fmt } from '../lib/money'
import { deleteTxn, undoable } from '../lib/store'
import { RTA, type Txn } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { IconSearch, toast } from '../ui/kit'
import { play } from '../ui/sound'
import { TxnRow } from './TxnSheet'

const PAGE = 150

export function History(props: { today: string; filter: string; setFilter: (f: string) => void; onEdit: (t: Txn) => void }) {
  const ix = useIndex()
  const base = ix.settings.base
  const { filter, setFilter } = props
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [sel, setSel] = useState(-1)
  const searchRef = useRef<HTMLInputElement>(null)

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

  // Keep the active filter in view (it may sit far to the right in the pill row).
  const pillsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    pillsRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [filter])

  const shown = rows.slice(0, limit)

  // Keyboard: / searches, ↑ ↓ walk the list, Enter opens, Delete deletes (undoable).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey) return
      const el = document.activeElement
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing && el !== searchRef.current) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = Math.max(0, Math.min(shown.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)))
        setSel(next)
        if (el === searchRef.current) searchRef.current?.blur()
        document.querySelector(`[data-txn="${shown[next]?.id}"]`)?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && sel >= 0 && !typing) {
        e.preventDefault()
        props.onEdit(shown[sel])
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && sel >= 0 && !typing) {
        e.preventDefault()
        const t = shown[sel]
        undoable('Deleted', () => deleteTxn(t.id))
        play('delete')
        toast('Deleted', { undo: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, sel])

  const days: { date: string; items: Txn[]; total: number }[] = []
  for (const t of shown) {
    let d = days[days.length - 1]
    if (!d || d.date !== t.date) days.push((d = { date: t.date, items: [], total: 0 }))
    d.items.push(t)
    if (t.cat !== RTA && !t.kind) d.total += t.base
  }
  const used = ix.cats.filter((c) => !c.archived)
  const filtered = q || filter !== 'all'
  const total = filtered ? rows.reduce((s, t) => s + t.base, 0) : 0
  if (!ix.txns.length) return <p class="empty">Nothing yet.</p>

  return (
    <div>
      <label class="searchbar">
        <IconSearch />
        <input ref={searchRef} type="search" aria-label="Search" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      <div class="pills scroll filters" ref={pillsRef}>
        <button class="pill sm" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </button>
        <button class="pill sm" aria-pressed={filter === 'income'} onClick={() => setFilter('income')}>
          Income
        </button>
        {used.map((c) => (
          <button key={c.id} class="pill sm" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {filtered && rows.length > 0 && (
        <p class="faint" style={{ fontSize: '13px', margin: '12px 0 0' }}>
          {rows.length} · <span class="num">{fmt(total, base, { sign: total > 0 })}</span>
        </p>
      )}
      {days.map((d) => (
        <div key={d.date}>
          <div class="day">
            <span>{dateLabel(d.date, props.today)}</span>
            {d.total !== 0 && <span class="num faint">{fmt(d.total, base)}</span>}
          </div>
          {d.items.map((t) => (
            <TxnRow key={t.id} t={t} plain={filter !== 'all'} selected={shown[sel]?.id === t.id} onClick={() => props.onEdit(t)} />
          ))}
        </div>
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
