import { useMemo, useState } from 'preact/hooks'
import { dateLabel } from '../lib/dates'
import { fmt } from '../lib/money'
import { RTA, type Txn } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { IconSearch } from '../ui/kit'
import { TxnRow } from './TxnSheet'

const PAGE = 120

export function Ledger(props: { today: string; header: preact.ComponentChildren; onEdit: (t: Txn) => void }) {
  const ix = useIndex()
  const base = ix.settings.base
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const [limit, setLimit] = useState(PAGE)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return ix.txns.filter((t) => {
      if (filter === 'income' && t.cat !== RTA) return false
      if (filter !== 'all' && filter !== 'income' && t.cat !== filter) return false
      if (!needle) return true
      const cat = ix.catById.get(t.cat)?.name ?? ''
      const amt = (Math.abs(t.amt) / 100).toString()
      return (t.note ?? '').toLowerCase().includes(needle) || cat.toLowerCase().includes(needle) || amt.startsWith(needle)
    })
  }, [ix, q, filter])

  const shown = rows.slice(0, limit)
  const days: { date: string; items: Txn[]; total: number }[] = []
  for (const t of shown) {
    let d = days[days.length - 1]
    if (!d || d.date !== t.date) days.push((d = { date: t.date, items: [], total: 0 }))
    d.items.push(t)
    if (t.cat !== RTA && !t.kind) d.total += t.base
  }
  const total = rows.reduce((s, t) => (t.kind ? s : s + t.base), 0)
  const used = ix.cats.filter((c) => !c.archived)

  return (
    <div>
      {props.header}
      <div class="row" style={{ marginTop: '4px' }}>
        <label class="grow" style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: '12px', top: '14px', color: 'var(--ink-3)' }}>
            <IconSearch />
          </span>
          <input type="search" placeholder="Search notes, categories, amounts" value={q} style={{ paddingLeft: '36px' }} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <select style={{ width: '38%' }} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} aria-label="Filter">
          <option value="all">Everything</option>
          <option value="income">Income</option>
          {used.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {(q || filter !== 'all') && (
        <p class="faint" style={{ fontSize: '13px', margin: '10px 0 0' }}>
          {rows.length} {rows.length === 1 ? 'entry' : 'entries'} · <span class="num">{fmt(total, base, { sign: total > 0 })}</span>
        </p>
      )}
      {days.map((d) => (
        <div key={d.date}>
          <div class="dayhead">
            <span class="label" style={{ color: 'var(--ink-2)' }}>
              {dateLabel(d.date, props.today)}
            </span>
            {d.total !== 0 && <span class="label num">{fmt(d.total, base)}</span>}
          </div>
          {d.items.map((t) => (
            <TxnRow key={t.id} t={t} onClick={() => props.onEdit(t)} />
          ))}
        </div>
      ))}
      {!rows.length && <p class="empty">{ix.txns.length ? 'Nothing matches.' : 'Nothing logged yet. Everything you log on Today shows up here.'}</p>}
      {rows.length > limit && (
        <button class="btn ghost block" style={{ marginTop: '16px' }} onClick={() => setLimit(limit + PAGE)}>
          Show more
        </button>
      )}
    </div>
  )
}
