import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { allCurrencyCodes, COMMON_CURRENCIES, CURRENCIES, CURRENCY_NAMES } from '../lib/money'
import { currenciesInUse, hasRate, refreshRates } from '../lib/rates'
import { IconSearch, toast } from './kit'
import { Sheet } from './sheet'
import { haptic, play } from './sound'
import { sortKey, useSortable } from './sortable'
import './currency.css'

/**
 * Pick the currencies you use. Tap to add or remove; double-tap to make one the currency you plan in
 * (it turns solid). With `onReorder` the chosen ones lead, the plan's currency first and then the rest in
 * the order they are kept in, and can be dragged (or moved with Shift and the arrow keys) to change it.
 */
export function CurrencyPicker(props: {
  selected: string[]
  main: string
  onChange: (selected: string[], main: string) => void
  /** `index` counts among the chosen ones after the plan's currency, without the one moved */
  onReorder?: (code: string, index: number) => void
}) {
  const { selected, main, onReorder } = props
  const [more, setMore] = useState(false)
  const last = useRef<{ code: string; t: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  // A pill that was just tapped stays where it is for a moment, so the second tap of a double-tap lands on it.
  const [held, setHeld] = useState<string[] | null>(null)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  // Without ordering the common ones always come first, in the same order, so pills never jump around under a finger.
  const first = onReorder ? [...new Set([main, ...selected, ...COMMON_CURRENCIES])] : [...new Set([...COMMON_CURRENCIES, ...selected, main])]
  const all = more ? [...first, ...Object.keys(CURRENCIES).filter((c) => !first.includes(c))] : first
  const visible = held ? [...held.filter((c) => all.includes(c)), ...all.filter((c) => !held.includes(c))] : all
  const extras = selected.filter((c) => c !== main)

  useSortable(ref, {
    flow: true,
    disabled: !onReorder || !!held,
    onDrop: (info) => onReorder?.(info.id, info.index),
  })

  function tap(code: string) {
    const now = Date.now()
    const double = last.current?.code === code && now - last.current.t < 380
    last.current = { code, t: now }
    if (onReorder) {
      setHeld(visible)
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setHeld(null), 500)
    }
    if (double) {
      if (code !== main) {
        play('success')
        props.onChange([...new Set([...selected, code])], code)
      }
      return
    }
    if (code === main) return
    props.onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code], main)
  }

  return (
    <div class="pills" ref={ref}>
      {visible.map((code) => {
        const movable = !!onReorder && code !== main && selected.includes(code)
        return (
          <button
            key={code}
            class={`pill${code === main ? ' solid' : selected.includes(code) ? ' picked' : ''}`}
            aria-pressed={code === main || selected.includes(code)}
            aria-label={`${code}${code === main ? ', the currency you plan in' : selected.includes(code) ? ', in use' : ''}`}
            data-sort-id={movable ? code : undefined}
            onClick={() => tap(code)}
            onKeyDown={(e) => movable && !held && onReorder && sortKey(e, extras.indexOf(code), extras.length, (to) => onReorder(code, to))}
          >
            {code}
          </button>
        )
      })}
      <button class="pill ghost" onClick={() => setMore(!more)}>
        {more ? 'Less' : 'More'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- any currency, by holding a pill

/** How long a pill is held before it counts as a long press. */
export const LONG_PRESS_MS = 450
/** A finger or mouse that drifts further than this is scrolling or dragging, not holding. */
const SLOP = 10

/**
 * Hold a button to do something else than its tap. Spread the result on the button and give it the `lp`
 * class (no text selection or callout while held). Works with touch and mouse; right-click, the context-menu
 * key and Shift+Enter do the same for keyboards. A hold that fired never also taps. `onTap` replaces onClick.
 */
export function useLongPress(onLong: () => void, onTap?: (e: MouseEvent) => void, ms = LONG_PRESS_MS) {
  const live = useRef({ onLong, onTap })
  live.current = { onLong, onTap }
  const st = useRef({ timer: 0, x: 0, y: 0, down: false, fired: false })
  useEffect(() => () => clearTimeout(st.current.timer), [])

  const stop = () => {
    clearTimeout(st.current.timer)
    st.current.timer = 0
    st.current.down = false
    // The click that follows the release of a hold is swallowed; after that the flag is spent.
    if (st.current.fired) window.setTimeout(() => (st.current.fired = false), 60)
  }
  const fire = () => {
    st.current.fired = true
    haptic('medium')
    live.current.onLong()
  }

  return {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const s = st.current
      clearTimeout(s.timer)
      s.fired = false
      s.down = true
      s.x = e.clientX
      s.y = e.clientY
      s.timer = window.setTimeout(() => {
        s.timer = 0
        fire()
      }, ms)
    },
    onPointerMove(e: PointerEvent) {
      const s = st.current
      if (s.timer && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) {
        clearTimeout(s.timer)
        s.timer = 0
      }
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onClick(e: MouseEvent) {
      if (st.current.fired) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      live.current.onTap?.(e)
    },
    onContextMenu(e: Event) {
      // Phones raise this themselves after a hold, a mouse with a right click, a keyboard with the menu key.
      e.preventDefault()
      const s = st.current
      if (s.fired) return
      clearTimeout(s.timer)
      s.timer = 0
      if (s.down) fire()
      else live.current.onLong()
    },
    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        live.current.onLong()
      }
    },
  }
}

/**
 * Make sure a currency can be converted before it is used: a rate on hand is enough (it refreshes quietly
 * when it is old); without one it is fetched now. Offline that fails with a word, and nothing changes.
 */
export async function ensureRate(code: string): Promise<boolean> {
  if (hasRate(code)) {
    void refreshRates(false, [code])
    return true
  }
  await refreshRates(false, [code])
  if (hasRate(code)) return true
  toast(`No rate for ${code} yet. It needs a connection`)
  return false
}

/** A currency pill that also opens the any-currency picker when held (or right-clicked, or Shift+Enter). */
export function CurrencyPill(props: { code: string; class?: string; pressed?: boolean; label?: string; onTap: () => void; onHold: () => void; children?: ComponentChildren }) {
  const lp = useLongPress(props.onHold, props.onTap)
  return (
    <button
      type="button"
      class={`pill lp${props.class ? ` ${props.class}` : ''}`}
      aria-pressed={props.pressed}
      aria-label={props.label ?? `${props.code}. Hold for any currency`}
      title="Hold for any currency"
      {...lp}
    >
      {props.children ?? props.code}
    </button>
  )
}

/**
 * Every currency there is, in a sheet: the ones in use and the common ones first, a field to find one by
 * code or name ("thb", "baht"). Picking one makes sure it has a rate (unless `needRate` is false), hands it to
 * `onPick` and closes; with no rate and no connection it stays open and says so.
 */
export function AnyCurrency(props: {
  open: boolean
  onClose: () => void
  onPick: (code: string) => void
  /** the currency in use right now, shown as chosen */
  value?: string
  /** convert-ability matters (an entry in the budget); false for things that only name a currency */
  needRate?: boolean
  title?: string
}) {
  const { open, value } = props
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    if (open) setQ('')
  }, [open])
  if (!open) return <Sheet open={false} onClose={props.onClose} children={null} />

  const used = currenciesInUse()
  const first = [...new Set([...used, ...COMMON_CURRENCIES])]
  const all = [...new Set([...first, ...allCurrencyCodes()])]
  const needle = q.trim().toLowerCase()
  const list = needle
    ? all.filter((c) => c.toLowerCase().includes(needle) || (CURRENCY_NAMES[c] ?? '').toLowerCase().includes(needle))
    : all
  // Codes that start with what was typed come before names that merely contain it.
  if (needle) list.sort((a, b) => Number(b.toLowerCase().startsWith(needle)) - Number(a.toLowerCase().startsWith(needle)))
  const fine = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches

  async function pick(code: string) {
    if (busy) return
    if (props.needRate !== false && !hasRate(code)) {
      setBusy(code)
      const ok = await ensureRate(code)
      setBusy(null)
      if (!ok) return
    }
    props.onPick(code)
    props.onClose()
  }

  return (
    <Sheet open onClose={props.onClose} title={props.title ?? 'Currency'}>
      <label class="searchbar">
        <IconSearch />
        <input
          type="search"
          aria-label="Find a currency"
          autoComplete="off"
          autoCapitalize="none"
          spellcheck={false}
          autoFocus={fine}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list.length) {
              e.preventDefault()
              void pick(list[0])
            }
          }}
        />
      </label>
      <div class="pills anycur" role="group" aria-label="Currencies">
        {list.map((code) => (
          <button
            key={code}
            type="button"
            class={`pill sm${busy === code ? ' busy' : ''}`}
            aria-pressed={code === value}
            title={CURRENCY_NAMES[code]}
            onClick={() => void pick(code)}
          >
            {code}
            {needle && CURRENCY_NAMES[code] && <small>{CURRENCY_NAMES[code]}</small>}
          </button>
        ))}
        {!list.length && <span class="faint">No match</span>}
      </div>
    </Sheet>
  )
}
