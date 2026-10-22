import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { totalMoney } from './lib/accounts'
import { monthView } from './lib/budget'
import { monthOf } from './lib/dates'
import { fmt, shownSign } from './lib/money'
import { redo } from './lib/store'
import type { ID, Txn } from './lib/types'
import { useIndex, useSync, useToday } from './ui/hooks'
import { runUndo, toast, Toasts } from './ui/kit'
import { AccountsSheet } from './views/AccountsSheet'
import { CategorySheet } from './views/CategorySheet'
import { History } from './views/History'
import { Onboarding } from './views/Onboarding'
import { Plan } from './views/Plan'
import { Review } from './views/Review'
import { Settings } from './views/Settings'
import { Today } from './views/Today'
import { TxnSheet } from './views/TxnSheet'

type Route = 'today' | 'plan' | 'history' | 'review' | 'settings'
const TABS: { id: Route; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'plan', label: 'Plan' },
  { id: 'history', label: 'History' },
  { id: 'review', label: 'Review' },
]
const ROUTES: Route[] = ['today', 'plan', 'history', 'review', 'settings']

function readRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  if (h === 'ledger') return 'history'
  return ROUTES.includes(h as Route) ? (h as Route) : 'today'
}

/** Fields that keep their own undo once you've typed in them. */
function isTextField(el: Element): boolean {
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test((el as HTMLInputElement).type))
}

export function App() {
  const ix = useIndex()
  const today = useToday()
  const [route, setRoute] = useState<Route>(readRoute)
  const [planMonth, setPlanMonth] = useState(monthOf(today))
  const [reviewMonth, setReviewMonth] = useState(monthOf(today))
  const [catSheet, setCatSheet] = useState<ID | null>(null)
  const [catMonth, setCatMonth] = useState(monthOf(today))
  const [txn, setTxn] = useState<Txn | null>(null)
  const [accounts, setAccounts] = useState(false)
  // opened to count: the first balance is ready to type
  const [counting, setCounting] = useState(false)
  const openAccounts = (count = false) => {
    setCounting(count)
    setAccounts(true)
  }
  const [historyFilter, setHistoryFilter] = useState('all')

  useEffect(() => {
    const on = () => setRoute(readRoute())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // Leaving History, by a tap or the browser's Back button, clears its filter.
  useEffect(() => {
    if (route !== 'history') setHistoryFilter('all')
  }, [route])

  // Keep the visible months on "now" when the month rolls over.
  useEffect(() => {
    setPlanMonth(monthOf(today))
    setReviewMonth(monthOf(today))
  }, [monthOf(today)])

  // Undo / redo from the keyboard. A text field keeps its own undo once you've typed in it; while it is
  // empty or untouched since it got focus (right after logging, or after Enter in an Assigned box) the keys are the app's.
  useEffect(() => {
    let edited: EventTarget | null = null
    const onFocus = () => {
      edited = null
    }
    const onInput = (e: Event) => {
      edited = e.target
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = document.activeElement as HTMLInputElement | null
      if (el && isTextField(el) && el.value && edited === el) return
      e.preventDefault()
      if (e.shiftKey) {
        const r = redo()
        if (r) {
          toast(`Redone: ${r.label}`)
        }
      } else runUndo()
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('input', onInput)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('input', onInput)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // A sheet whose record is gone (deleted on another device) closes for good, so it can't pop open again later.
  useEffect(() => {
    if (txn) {
      const r = ix.db.txns[txn.id]
      if (!r || r.d) setTxn(null)
    }
    if (catSheet) {
      const c = ix.db.cats[catSheet]
      if (!c || c.d) setCatSheet(null)
    }
  }, [ix, txn, catSheet])

  // Settings' Done goes back to where you came from.
  const lastMain = useRef<Route>('plan')
  useEffect(() => {
    if (route !== 'settings') lastMain.current = route
  }, [route])

  if (!ix.settings.ready) {
    return (
      <>
        <div class="statusbar" />
        <Onboarding onDone={() => setRoute(readRoute())} />
        <Toasts />
      </>
    )
  }

  const go = (r: Route) => {
    location.hash = `#/${r}`
    setRoute(r)
    window.scrollTo(0, 0)
  }

  const current = monthOf(today)

  let page
  if (route === 'plan')
    page = (
      <Plan
        today={today}
        month={planMonth}
        setMonth={setPlanMonth}
        onCategory={(id) => {
          setCatMonth(planMonth)
          setCatSheet(id)
        }}
        onCount={() => openAccounts(true)}
        onReflect={(m) => {
          setReviewMonth(m)
          go('review')
        }}
        onSettings={() => go('settings')}
      />
    )
  else if (route === 'history')
    page = (
      <History
        today={today}
        filter={historyFilter}
        setFilter={setHistoryFilter}
        onEdit={(t) => {
          setTxn(t)
        }}
      />
    )
  else if (route === 'review') page = <Review today={today} month={reviewMonth} setMonth={setReviewMonth} onCount={() => openAccounts(true)} />
  else if (route === 'settings') page = <Settings onCount={() => openAccounts(true)} onAccounts={() => openAccounts()} onBack={() => go(lastMain.current)} />
  else page = <Today today={today} onPlan={() => go('plan')} />

  return (
    <div class="app">
      <div class="statusbar" />
      <Rail route={route} go={go} today={today} onAccounts={() => openAccounts()} />
      <main class={`main${route === 'today' ? ' main-today' : ''}`} key={route}>
        {page}
      </main>
      <TabBar route={route} go={go} today={today} />
      <CategorySheet
        catId={catSheet}
        month={catMonth}
        current={current}
        onClose={() => setCatSheet(null)}
        onHistory={(id) => {
          setCatSheet(null)
          setHistoryFilter(id)
          go('history')
        }}
      />
      <TxnSheet txn={txn} today={today} onClose={() => setTxn(null)} />
      <AccountsSheet open={accounts} count={counting} today={today} onClose={() => setAccounts(false)} />
      <Toasts />
    </div>
  )
}

function useBadges(today: string) {
  const ix = useIndex()
  const m = monthOf(today)
  const v = useMemo(() => monthView(ix, m, m), [ix, m])
  return { rta: shownSign(v.readyToAssign, ix.settings.base), overspent: v.overspent.length }
}

function Dot(props: { rta: number; overspent: number }) {
  if (props.rta < 0 || props.overspent > 0) return <span class="dot" aria-label="needs attention" />
  if (props.rta > 0) return <span class="dot go" aria-label="money to assign" />
  return null
}

function TabBar(props: { route: Route; go: (r: Route) => void; today: string }) {
  const b = useBadges(props.today)
  return (
    <nav class="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <button key={t.id} class="tab" aria-current={props.route === t.id || (t.id === 'plan' && props.route === 'settings') ? 'page' : undefined} onClick={() => props.go(t.id)}>
          {t.label}
          {t.id === 'plan' && <Dot rta={b.rta} overspent={b.overspent} />}
        </button>
      ))}
    </nav>
  )
}

function Rail(props: { route: Route; go: (r: Route) => void; today: string; onAccounts: () => void }) {
  const ix = useIndex()
  const b = useBadges(props.today)
  const total = useMemo(() => totalMoney(ix), [ix])
  const base = ix.settings.base
  const stale = useSync().stale
  return (
    <aside class="rail">
      <div class="brand">
        <span>
          Money
          <br />
          in Order
        </span>
      </div>
      <nav>
        {[...TABS, { id: 'settings' as Route, label: 'Settings' }].map((t) => (
          <button key={t.id} class="tab" aria-current={props.route === t.id ? 'page' : undefined} onClick={() => props.go(t.id)}>
            {t.label}
            {t.id === 'plan' && <Dot rta={b.rta} overspent={b.overspent} />}
            {t.id === 'settings' && stale && <span class="dot" aria-label="changes not synced" />}
          </button>
        ))}
      </nav>
      <button class="rail-foot" onClick={props.onAccounts}>
        <small>Total money</small>
        <span class={`num ${shownSign(total, base) < 0 ? 'neg' : ''}`} style={{ fontSize: '17px', fontWeight: 650 }}>
          {fmt(total, base)}
        </span>
      </button>
    </aside>
  )
}
