import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { fmt } from '../lib/money'

// ---------------------------------------------------------------- money

export function Money(props: { v: number; cur: string; sign?: boolean; tone?: boolean; class?: string }) {
  const tone = props.tone ? (props.v < 0 ? ' neg' : props.v > 0 ? ' pos' : ' zero') : ''
  return <span class={`num${tone}${props.class ? ' ' + props.class : ''}`}>{fmt(props.v, props.cur, { sign: props.sign })}</span>
}

// ---------------------------------------------------------------- sheet

/** Bottom sheet on phones, centered panel on wide screens. Uses the native dialog element. */
export function Sheet(props: { open: boolean; onClose: () => void; title?: string; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (props.open && !d.open) d.showModal()
    if (!props.open && d.open) d.close()
  }, [props.open])
  if (!props.open) return null
  return (
    <dialog
      ref={ref}
      class={`sheet${props.wide ? ' wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose()
      }}
    >
      <div class="sheet-body">
        <header class="sheet-head">
          <h2>{props.title}</h2>
          <button class="link" onClick={props.onClose}>
            Done
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  )
}

// ---------------------------------------------------------------- toast

interface ToastMsg {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

let pushToast: ((t: Omit<ToastMsg, 'id'>) => void) | null = null

export function toast(text: string, action?: ToastMsg['action']) {
  pushToast?.({ text, action })
}

export function Toasts() {
  const [msg, setMsg] = useState<ToastMsg | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    pushToast = (t) => {
      clearTimeout(timer.current)
      setMsg({ ...t, id: Date.now() })
      timer.current = setTimeout(() => setMsg(null), t.action ? 5000 : 2600)
    }
    return () => {
      pushToast = null
    }
  }, [])
  if (!msg) return null
  return (
    <div class="toast" role="status" key={msg.id}>
      <span>{msg.text}</span>
      {msg.action && (
        <button
          class="toast-act"
          onClick={() => {
            msg.action!.run()
            setMsg(null)
          }}
        >
          {msg.action.label}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- keypad

export function Keypad(props: { value: string; onChange: (v: string) => void; decimals: number; onDone?: () => void; doneLabel?: string }) {
  const press = (k: string) => {
    let v = props.value
    if (k === 'back') v = v.slice(0, -1)
    else if (k === '.') {
      if (props.decimals === 0 || v.includes('.')) return
      v = (v || '0') + '.'
    } else {
      if (v.includes('.') && v.split('.')[1].length >= 2) return
      if (v === '0') v = ''
      if (v.replace('.', '').length >= 9) return
      v += k
    }
    props.onChange(v)
  }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', props.decimals ? '.' : '00', '0', 'back']
  return (
    <div class="keypad" role="group" aria-label="Amount keypad">
      {keys.map((k) => (
        <button
          key={k}
          class={`key${k === 'back' ? ' key-back' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault()
            if (k === '00') {
              if (!props.value || props.value.length >= 8) return
              props.onChange(props.value + '00')
            } else press(k)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (k === 'back') props.onChange('')
          }}
          aria-label={k === 'back' ? 'Delete' : k}
        >
          {k === 'back' ? <IconBack /> : k}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- icons (only the few that earn their place)

export function IconBack() {
  return (
    <svg width="26" height="20" viewBox="0 0 26 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <path d="M8 2h15a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 23 18H8l-6.5-8z" stroke-linejoin="round" />
      <path d="M12 6.5l7 7M19 6.5l-7 7" stroke-linecap="round" />
    </svg>
  )
}

export function IconChevron(props: { dir: 'left' | 'right' | 'down' }) {
  const d = props.dir === 'left' ? 'M10 3L5 8l5 5' : props.dir === 'right' ? 'M6 3l5 5-5 5' : 'M3 6l5 5 5-5'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="5" />
      <path d="M11 11l3.5 3.5" stroke-linecap="round" />
    </svg>
  )
}

/** Small progress rule: how much of the money for the month is used. */
export function Gauge(props: { used: number; total: number; pace?: number }) {
  const { used, total } = props
  const over = used > total
  const frac = total > 0 ? Math.min(1, used / total) : used > 0 ? 1 : 0
  return (
    <div class={`gauge${over ? ' over' : ''}`} aria-hidden="true">
      <div class="gauge-fill" style={{ width: `${frac * 100}%` }} />
      {props.pace !== undefined && <div class="gauge-pace" style={{ left: `${props.pace * 100}%` }} />}
    </div>
  )
}

export function Field(props: { label: string; children: ComponentChildren; hint?: string }) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </label>
  )
}

export function money(v: number, c: string) {
  return fmt(v, c)
}
