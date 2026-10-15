import { daily, expectedTotal, monthView, type Index, type MonthView } from './budget'
import { addDays, addMonths, dayOfMonth, daysInMonth, monthName, monthOf } from './dates'
import { fmt } from './money'
import { live, RTA, type DB } from './types'

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`
}

function targetText(ix: Index, id: string, base: string): string {
  const t = ix.catById.get(id)?.target
  if (!t) return ''
  if (t.kind === 'monthly') return `${fmt(t.amount, base)}/month`
  if (t.kind === 'refill') return `top up to ${fmt(t.amount, base)}`
  return `save ${fmt(t.amount, base)}${t.by ? ` by ${t.by}` : ''}`
}

function esc(s: string): string {
  return s.replace(/\|/g, '/').replace(/\n/g, ' ')
}

/**
 * A compact, self-explaining summary written for Claude (or any assistant) to analyze.
 * Plain markdown so it can be pasted anywhere.
 */
export function claudeSummary(ix: Index, today: string, opts: { months: number; transactions: boolean }): string {
  const s = ix.settings
  const base = s.base
  const f = (n: number) => fmt(n, base)
  const current = monthOf(today)
  const view = monthView(ix, current, current)
  const d = daily(ix, view, today)
  const db: DB = ix.db
  const out: string[] = []

  out.push('# Money in Order: my finances')
  out.push('')
  out.push(
    `Generated ${today}, day ${dayOfMonth(today)} of ${daysInMonth(current)} in ${monthName(current, { year: true })}. ` +
      `Amounts are in ${base} unless marked.`,
  )
  const rateList = Object.entries(s.rates)
    .filter(([c]) => c !== base && s.extraCurrencies.includes(c))
    .map(([c, r]) => `1 ${c} = ${r} ${base}`)
  if (rateList.length) out.push(`Exchange rates: ${rateList.join(' · ')}.`)
  out.push('')
  out.push('How my budget works: zero-based, like YNAB. Every unit of money gets a job (a category). ')
  out.push('Unspent money rolls over to next month; overspending carries over as a negative balance until covered. ')
  out.push('"Ready to assign" is money that has no job yet. "Savings categories" count toward my savings rate ')
  out.push(`(money given to them ÷ income that month; my target is ${pct(s.savingsTarget)}). `)
  out.push('For savings categories, "spent" means money moved out of the budget on purpose (e.g. invested), not consumption.')
  out.push('')

  // ------------------------------------------------ now
  out.push('## Right now')
  const total = expectedTotal(ix)
  const lastCount = live(db.counts).sort((a, b) => (a.date < b.date ? 1 : -1))[0]
  out.push(`- Total money: ${f(total)}`)
  if (lastCount) {
    const accts = live(db.accounts)
      .sort((a, b) => a.order - b.order)
      .map((a) => `${a.name} ${fmt(lastCount.bal[a.id] ?? 0, a.cur)}`)
    out.push(`- Last counted ${lastCount.date}: ${f(lastCount.total)} (${accts.join(', ')})`)
  }
  out.push(`- Ready to assign: ${f(view.readyToAssign)}`)
  const full = [1, 2, 3].map((i) => addMonths(current, -i)).filter((m) => ix.months[0] && m >= ix.months[0])
  if (full.length) {
    const avgSpent = Math.round(full.reduce((sum, m) => sum + monthView(ix, m, current).spent, 0) / full.length)
    if (avgSpent > 0) {
      out.push(
        `- Average monthly spending over the last ${full.length} complete month${full.length > 1 ? 's' : ''}: ${f(avgSpent)}, ` +
          `so all my money would last about ${(total / avgSpent).toFixed(1)} months`,
      )
    }
  }
  if (d) {
    out.push(
      `- Daily spending (${d.cats.map((c) => c.name).join(', ')}): ${f(d.available)} left for ${d.daysLeft} days ` +
        `= ${f(d.allowance)}/day. Spent today: ${f(d.spentToday)}.`,
    )
  }
  if (view.overspent.length) {
    out.push(`- Overspent and not yet covered: ${view.overspent.map((c) => `${c.cat.name} ${f(c.available)}`).join(', ')}`)
  }
  if (view.need > 0) out.push(`- Still needed to fully fund this month's targets: ${f(view.need)}`)
  out.push('')

  // ------------------------------------------------ this month
  out.push(`## ${monthName(current, { year: true })} so far`)
  out.push(`Income ${f(view.income)} · Spent ${f(view.spent)} · Saved ${f(view.saved)} (${pct(view.savingsRate)})`)
  out.push('')
  out.push('| Category | Group | Target | Rolled in | Assigned | Spent | Available | Note |')
  out.push('|---|---|---|---:|---:|---:|---:|---|')
  for (const g of view.groups) {
    for (const c of g.cats) {
      out.push(
        `| ${esc(c.cat.name)}${c.cat.saving ? ' (savings)' : ''}${c.cat.daily ? ' (daily)' : ''} | ${esc(g.group.name)} | ${targetText(ix, c.cat.id, base)} | ` +
          `${f(c.carry)} | ${f(c.assigned)} | ${f(-c.activity)} | ${f(c.available)} | ${esc(c.cat.note ?? '')} |`,
      )
    }
  }
  out.push('')

  // ------------------------------------------------ history
  const months: string[] = []
  for (let i = opts.months - 1; i >= 0; i--) months.push(addMonths(current, -i))
  const firstData = ix.months[0]
  const shown = months.filter((m) => !firstData || m >= firstData)
  if (shown.length > 1) {
    const views: MonthView[] = shown.map((m) => monthView(ix, m, current))
    out.push(`## Month by month`)
    out.push('| Month | Income | Spent | Saved | Savings rate | Overspent categories at month end |')
    out.push('|---|---:|---:|---:|---:|---|')
    for (const v of views) {
      const over = v.overspent.map((c) => `${c.cat.name} ${f(c.available)}`).join(', ') || 'none'
      out.push(`| ${v.month}${v.month === current ? ' (so far)' : ''} | ${f(v.income)} | ${f(v.spent)} | ${f(v.saved)} | ${pct(v.savingsRate)} | ${esc(over)} |`)
    }
    out.push('')
    out.push('### Planned vs spent per category')
    out.push(`| Category | ${shown.map((m) => `${m} planned / spent`).join(' | ')} |`)
    out.push(`|---|${shown.map(() => '---:').join('|')}|`)
    for (const cat of ix.cats) {
      if (cat.archived) continue
      const cells = views.map((v) => {
        const c = v.byId.get(cat.id)
        return c ? `${f(c.assigned)} / ${f(-c.activity)}` : '—'
      })
      out.push(`| ${esc(cat.name)} | ${cells.join(' | ')} |`)
    }
    out.push('')
  }

  // ------------------------------------------------ big items & income
  const since = addDays(today, -60)
  const big = ix.txns
    .filter((t) => t.date >= since && t.cat !== RTA && !t.kind && t.base < 0 && !ix.catById.get(t.cat)?.saving)
    .sort((a, b) => a.base - b.base)
    .slice(0, 12)
  if (big.length) {
    out.push('## Biggest expenses, last 60 days')
    for (const t of big) {
      const orig = t.cur !== base ? ` (${fmt(t.amt, t.cur)})` : ''
      out.push(`- ${t.date} · ${ix.catById.get(t.cat)?.name ?? '?'} · ${f(-t.base)}${orig}${t.note ? ` · ${t.note}` : ''}`)
    }
    out.push('')
  }
  const firstMonth = months[0]
  const incomes = ix.txns.filter((t) => t.cat === RTA && !t.kind && monthOf(t.date) >= firstMonth)
  if (incomes.length) {
    out.push('## Income received')
    for (const t of incomes.slice().reverse()) {
      const orig = t.cur !== base ? ` (${fmt(t.amt, t.cur)})` : ''
      out.push(`- ${t.date} · ${f(t.base)}${orig}${t.note ? ` · ${t.note}` : ''}`)
    }
    out.push('')
  }

  const counts = live(db.counts)
    .filter((c) => monthOf(c.date) >= firstMonth)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  if (counts.length > 1) {
    out.push('## Money counts (real balances vs what the budget expected)')
    for (const c of counts) {
      const gap = c.total - c.expected
      out.push(`- ${c.date}: counted ${f(c.total)}, expected ${f(c.expected)}, gap ${fmt(gap, base, { sign: true })}`)
    }
    out.push('')
  }

  const notes = live(db.notes)
    .filter((n) => n.text.trim() && n.id >= firstMonth)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  if (notes.length) {
    out.push('## My own notes on each month')
    for (const n of notes) out.push(`- ${n.id}: ${n.text.trim().replace(/\n+/g, ' / ')}`)
    out.push('')
  }

  if (opts.transactions) {
    out.push('## All transactions in this period (CSV)')
    out.push('```csv')
    out.push(transactionsCSV(ix, firstMonth).trim())
    out.push('```')
    out.push('')
  }

  out.push('## What I want from you')
  out.push(
    'Look at where my money actually goes compared with my plan. Point out patterns (categories I keep overspending, ' +
      'months that went wrong and why), check whether my savings rate and emergency money are on track, and suggest ' +
      'concrete numbers for next month\'s budget. Be direct.',
  )
  return out.join('\n')
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function transactionsCSV(ix: Index, fromMonth?: string): string {
  const base = ix.settings.base
  const rows = [['date', 'category', 'group', 'amount', 'currency', `amount_${base}`, 'note', 'type'].join(',')]
  const gName = new Map(ix.groups.map((g) => [g.id, g.name]))
  for (const t of [...ix.txns].reverse()) {
    if (fromMonth && monthOf(t.date) < fromMonth) continue
    const cat = t.cat === RTA ? undefined : ix.catById.get(t.cat)
    rows.push(
      [
        t.date,
        t.cat === RTA ? 'Ready to assign' : cat?.name ?? '?',
        cat ? gName.get(cat.group) ?? '' : '',
        (t.amt / 100).toFixed(2),
        t.cur,
        (t.base / 100).toFixed(2),
        t.note ?? '',
        t.kind ?? (t.cat === RTA ? 'income' : t.base < 0 ? 'expense' : 'refund'),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return rows.join('\n') + '\n'
}
