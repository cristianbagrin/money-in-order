import { useEffect, useMemo, useState } from 'preact/hooks'
import { monthView } from './lib/budget'
import { longDate, monthOf } from './lib/dates'
import { fmt } from './lib/money'
import { enableSync, normalizeCode, syncStatus } from './lib/sync'
import type { ID, Txn } from './lib/types'
import { useIndex, useMedia, useSync, useToday } from './ui/hooks'
import { toast, Toasts } from './ui/kit'
import { CategorySheet } from './views/CategorySheet'
import { CountSheet } from './views/CountSheet'
import { Ledger } from './views/Ledger'
import { Onboarding } from './views/Onboarding'
import { Plan } from './views/Plan'
import { Review } from './views/Review'
import { Settings } from './views/Settings'
import { Today } from './views/Today'
import { TxnSheet } from './views/TxnSheet'

type Route = 'today' | 'plan' | 'ledger' | 'review' | 'settings'
const TABS: { id: Route; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'plan', label: 'Plan' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'review', label: 'Review' },
]

function readRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  return (['today', 'plan', 'ledger', 'review', 'settings'] as Route[]).includes(h as Route) ? (h as Route) : 'today'
}

function readJoin(): string | undefined {
  const m = location.hash.match(/join=([A-Za-z0-9-]+)/)
  return m ? normalizeCode(m[1]) ?? undefined : undefined
}

export function App() {
  const ix = useIndex()
  const today = useToday()
  const wide = useMedia('(min-width: 960px)')
  const [route, setRoute] = useState<Route>(readRoute)
  const [planMonth, setPlanMonth] = useState(monthOf(today))
  const [reviewMonth, setReviewMonth] = useState(monthOf(today))
  const [catSheet, setCatSheet] = useState<ID | 'new' | null>(null)
  const [catMonth, setCatMonth] = useState(monthOf(today))
  const [txn, setTxn] = useState<Txn | null>(null)
  const [counting, setCounting] = useState(false)
  const joinCode = readJoin()

  useEffect(() => {
    const on = () => setRoute(readRoute())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  // Keep the visible months on "now" when the month rolls over.
  useEffect(() => {
    setPlanMonth(monthOf(today))
    setReviewMonth(monthOf(today))
  }, [monthOf(today)])

  // A join link opened on a device that's already set up: offer to merge.
  useEffect(() => {
    if (!joinCode || !ix.settings.ready) return
    history.replaceState(null, '', '#/today')
    if (syncStatus().code === joinCode) return
    if (confirm('Sync this device with the budget from that link? Both sides are merged.')) {
      void enableSync(joinCode).then(() => toast('Synced'))
    }
  }, [joinCode, ix.settings.ready])

  if (!ix.settings.ready) {
    return (
      <>
        <Onboarding joinCode={joinCode} onDone={() => setRoute(readRoute())} />
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
  const openCategory = (id: ID | 'new', month = current) => {
    setCatMonth(month)
    setCatSheet(id)
  }

  const header = <Header route={route} today={today} wide={wide} onSync={() => go('settings')} />

  let page
  if (route === 'plan')
    page = (
      <Plan
        today={today}
        month={planMonth}
        setMonth={setPlanMonth}
        wide={wide}
        header={header}
        onCategory={(id) => openCategory(id, planMonth)}
        onCount={() => setCounting(true)}
        onReflect={(m) => {
          setReviewMonth(m)
          go('review')
        }}
      />
    )
  else if (route === 'ledger') page = <Ledger today={today} header={header} onEdit={setTxn} />
  else if (route === 'review')
    page = <Review today={today} month={reviewMonth} setMonth={setReviewMonth} header={header} onSettings={() => go('settings')} />
  else if (route === 'settings') page = <Settings header={header} onCount={() => setCounting(true)} onBack={() => history.length > 1 ? history.back() : go('review')} />
  else page = <Today today={today} wide={wide} header={header} onCover={(id) => openCategory(id)} onEdit={setTxn} onPlan={() => go('plan')} />

  return (
    <div class="app">
      <Rail route={route} go={go} today={today} />
      <main class="main">{page}</main>
      <TabBar route={route} go={go} today={today} />
      <CategorySheet catId={catSheet} month={catMonth} current={current} today={today} onClose={() => setCatSheet(null)} onEdit={setTxn} />
      <TxnSheet txn={txn} onClose={() => setTxn(null)} />
      <CountSheet open={counting} onClose={() => setCounting(false)} today={today} />
      <Toasts />
    </div>
  )
}

function Header(props: { route: Route; today: string; wide: boolean; onSync: () => void }) {
  const sync = useSync()
  const label = props.route === 'today' ? longDate(props.today) : props.wide ? '' : 'Money in Order'
  const word = sync.state === 'off' ? 'Not synced' : sync.state === 'syncing' ? 'Syncing' : sync.state === 'offline' ? 'Offline' : sync.state === 'error' ? 'Sync problem' : 'Synced'
  return (
    <div class="topline">
      <h1>{label}</h1>
      <button class={`syncdot ${sync.state}`} onClick={props.onSync} aria-label={`${word}. Open settings`}>
        <i />
        {word}
      </button>
    </div>
  )
}

function useBadges(today: string) {
  const ix = useIndex()
  const m = monthOf(today)
  const v = useMemo(() => monthView(ix, m, m), [ix, m])
  return { rta: v.readyToAssign, overspent: v.overspent.length, base: ix.settings.base }
}

function TabBar(props: { route: Route; go: (r: Route) => void; today: string }) {
  const b = useBadges(props.today)
  return (
    <nav class="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <button key={t.id} class="tab" aria-current={props.route === t.id ? 'page' : undefined} onClick={() => props.go(t.id)}>
          {t.label}
          {t.id === 'plan' && (b.rta < 0 || b.overspent > 0) && <span class="dot" aria-label="needs attention" />}
          {t.id === 'plan' && b.rta > 0 && b.overspent === 0 && <span class="dot go" aria-label="money to assign" />}
        </button>
      ))}
    </nav>
  )
}

function Rail(props: { route: Route; go: (r: Route) => void; today: string }) {
  const b = useBadges(props.today)
  return (
    <aside class="rail">
      <div class="brand">
        Money
        <br />
        in Order
      </div>
      <nav>
        {TABS.map((t) => (
          <button key={t.id} class="tab" aria-current={props.route === t.id ? 'page' : undefined} onClick={() => props.go(t.id)}>
            {t.label}
            {t.id === 'plan' && (b.rta < 0 || b.overspent > 0) && <span class="dot" />}
            {t.id === 'plan' && b.rta > 0 && b.overspent === 0 && <span class="dot go" />}
          </button>
        ))}
        <button class="tab" aria-current={props.route === 'settings' ? 'page' : undefined} onClick={() => props.go('settings')}>
          Settings
        </button>
      </nav>
      <div class="rail-foot">
        <span class="label">Ready to assign</span>
        <span class={`num ${b.rta < 0 ? 'neg' : b.rta > 0 ? 'pos' : 'zero'}`} style={{ fontSize: '18px', fontWeight: 650 }}>
          {fmt(b.rta, b.base)}
        </span>
      </div>
    </aside>
  )
}
