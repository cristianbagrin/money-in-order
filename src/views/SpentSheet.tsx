import { useCallback, useMemo, useState } from 'preact/hooks'
import { dateLabel, monthName, monthOf } from '../lib/dates'
import { fmt, SEP } from '../lib/money'
import { deleteTxns, undoable } from '../lib/store'
import { type ID, type Txn } from '../lib/types'
import { useIndex } from '../ui/hooks'
import { toast } from '../ui/kit'
import { Sheet } from '../ui/sheet'
import { play } from '../ui/sound'
import { TxnRow, TxnSheet } from './TxnSheet'

/**
 * What a category's money went on in a month: every transaction, newest first. Tap one to edit it,
 * swipe it away to delete. Opened from any spent number (Plan, a category, Review).
 */
export function SpentSheet(props: { cat: ID | null; month: string; today: string; onClose: () => void }) {
  const ix = useIndex()
  const { month } = props
  const base = ix.settings.base
  const cat = props.cat ? ix.catById.get(props.cat) : undefined
  const [open, setOpen] = useState<Txn | null>(null)
  const rows = useMemo(() => (cat ? ix.txns.filter((t) => t.cat === cat.id && monthOf(t.date) === month) : []), [ix, cat, month])
  const spent = rows.reduce((s, t) => s - t.base, 0)
  const onOpen = useCallback((t: Txn) => setOpen(t), [])
  const onDelete = useCallback((t: Txn) => {
    undoable('Deleted', () => deleteTxns([t.id]))
    play('delete')
    toast('Deleted', { undo: true })
  }, [])

  if (!cat) return <Sheet open={false} onClose={props.onClose} children={null} />
  return (
    <Sheet open onClose={props.onClose} title={`${cat.name}${SEP}${monthName(month, { short: true })}`}>
      <p class="cs-line">
        <span class="num">{fmt(spent, base)}</span> spent{rows.length > 1 ? `${SEP}${rows.length} times` : ''}
      </p>
      {rows.length ? (
        <div class="spent-list">
          {rows.map((t, i) => (
            <div key={t.id}>
              {(i === 0 || rows[i - 1].date !== t.date) && <div class="day">{dateLabel(t.date, props.today)}</div>}
              <TxnRow t={t} base={base} catName={cat.name} plain onOpen={onOpen} onDelete={onDelete} />
            </div>
          ))}
        </div>
      ) : (
        <p class="empty">Nothing spent yet.</p>
      )}
      <TxnSheet txn={open} today={props.today} onClose={() => setOpen(null)} />
    </Sheet>
  )
}
