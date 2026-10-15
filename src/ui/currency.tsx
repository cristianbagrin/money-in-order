import { useRef, useState } from 'preact/hooks'
import { COMMON_CURRENCIES, CURRENCIES } from '../lib/money'
import { play } from './sound'

/**
 * Pick the currencies you use. Tap to add or remove; double-tap to make one the currency you plan in
 * (it turns solid).
 */
export function CurrencyPicker(props: { selected: string[]; main: string; onChange: (selected: string[], main: string) => void }) {
  const { selected, main } = props
  const [more, setMore] = useState(false)
  const last = useRef<{ code: string; t: number } | null>(null)
  const all = Object.keys(CURRENCIES)
  const visible = more ? all : [...new Set([...COMMON_CURRENCIES, ...selected, main])]

  function tap(code: string) {
    const now = Date.now()
    const double = last.current?.code === code && now - last.current.t < 380
    last.current = { code, t: now }
    if (double) {
      if (code !== main) {
        play('success')
        props.onChange([...new Set([...selected, code])], code)
      }
      return
    }
    if (code === main) return
    play('toggle')
    props.onChange(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code], main)
  }

  return (
    <div class="pills">
      {visible.map((code) => (
        <button
          key={code}
          class={`pill${code === main ? ' main' : selected.includes(code) ? ' picked' : ''}`}
          aria-pressed={code === main || selected.includes(code)}
          aria-label={`${code}${code === main ? ', the currency you plan in' : selected.includes(code) ? ', in use' : ''}`}
          onClick={() => tap(code)}
        >
          {code}
        </button>
      ))}
      {!more && (
        <button class="pill ghost" onClick={() => setMore(true)}>
          More
        </button>
      )}
    </div>
  )
}
