import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { undo } from '../lib/store'
import { haptic, play } from './sound'

// ---------------------------------------------------------------- toast

interface ToastMsg {
  id: number
  text: string
  undo?: boolean
  action?: { label: string; run: () => void }
}

let pushToast: ((t: Omit<ToastMsg, 'id'>) => void) | null = null

/** Show a short message. With undo: true it offers to take back the last action for 5 seconds. */
export function toast(text: string, opts: { undo?: boolean; action?: ToastMsg['action'] } = {}) {
  pushToast?.({ text, ...opts })
}

export function runUndo() {
  const e = undo()
  if (!e) return
  play('undo')
  toast(`Undone: ${e.label}`)
}

export function Toasts() {
  const [msg, setMsg] = useState<ToastMsg | null>(null)
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    pushToast = (t) => {
      clearTimeout(timer.current)
      setLeaving(false)
      setMsg({ ...t, id: Date.now() })
      timer.current = setTimeout(
        () => {
          setLeaving(true)
          timer.current = setTimeout(() => setMsg(null), 200)
        },
        t.undo || t.action ? 5000 : 2400,
      )
    }
    return () => {
      pushToast = null
    }
  }, [])
  if (!msg) return null
  const close = () => {
    clearTimeout(timer.current)
    setMsg(null)
  }
  return (
    <div class={`toast${leaving ? ' out' : ''}`} role="status" key={msg.id}>
      <span>{msg.text}</span>
      {msg.action && (
        <button
          class="toast-act"
          onClick={() => {
            msg.action!.run()
            close()
          }}
        >
          {msg.action.label}
        </button>
      )}
      {msg.undo && (
        <button
          class="toast-act"
          onClick={() => {
            close()
            runUndo()
          }}
        >
          Undo
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- keypad (phones only)

export function Keypad(props: { value: string; onChange: (v: string) => void; decimals: number }) {
  const value = useRef(props.value)
  value.current = props.value
  const lastPointer = useRef(0)
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined)

  const press = (k: string) => {
    let v = value.current
    if (k === 'back') v = v.slice(0, -1)
    else if (k === '.') {
      if (v.includes('.')) return
      v = (v || '0') + '.'
    } else if (k === '00') {
      if (!v || v.includes('.') || v.length >= 8) return
      v += '00'
    } else {
      if (v.includes('.') && v.split('.')[1].length >= 2) return
      if (v === '0') v = ''
      if (v.replace('.', '').length >= 9) return
      v += k
    }
    play('key')
    haptic('light')
    value.current = v
    props.onChange(v)
  }
  const endHold = () => clearTimeout(hold.current)
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', props.decimals ? '.' : '00', '0', 'back']
  return (
    <div class="keypad" role="group" aria-label="Amount keypad">
      {keys.map((k) => (
        <button
          key={k}
          class="key"
          // Pointer-down feels instant on a phone. The click that follows a touch is ignored;
          // a click with no pointer before it comes from the keyboard.
          onPointerDown={(e) => {
            e.preventDefault()
            lastPointer.current = Date.now()
            press(k)
            if (k === 'back') {
              endHold()
              // Hold ⌫ to clear everything (iOS never fires contextmenu, so time it ourselves).
              hold.current = setTimeout(() => {
                if (!value.current) return
                value.current = ''
                props.onChange('')
                play('delete')
                haptic('medium')
              }, 480)
            }
          }}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          onClick={() => {
            if (Date.now() - lastPointer.current < 1000) return
            press(k)
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={k === 'back' ? 'Delete (hold to clear)' : k}
        >
          {k === 'back' ? <IconBack /> : k}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- amount field with clear button

/** A text field for money: selects everything on focus, and has an × to clear and type fresh. */
export function AmountField(props: {
  value: string
  onInput: (v: string) => void
  onCommit?: (v: string) => void
  class?: string
  autoFocus?: boolean
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus()
  }, [])
  return (
    <div class={`amountfield ${props.class ?? ''}`}>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        aria-label={props.label}
        value={props.value}
        onFocus={(e) => {
          const el = e.currentTarget
          requestAnimationFrame(() => document.activeElement === el && el.select())
        }}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onBlur={(e) => props.onCommit?.(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {props.value && (
        <button
          class="iconbtn clear"
          aria-label="Clear"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            props.onInput('')
            ref.current?.focus()
          }}
        >
          <IconClear />
        </button>
      )}
    </div>
  )
}

/** A note field with a pencil instead of placeholder text. */
export function NoteField(props: { value: string; onInput: (v: string) => void; onCommit?: (v: string) => void; onEnter?: () => void; list?: string }) {
  return (
    <label class="note">
      <IconPencil />
      <input
        type="text"
        aria-label="Note"
        value={props.value}
        list={props.list}
        enterKeyHint="done"
        autocomplete="off"
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onBlur={(e) => props.onCommit?.(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
            props.onEnter?.()
          }
        }}
      />
    </label>
  )
}

export function Section(props: { title?: string; children: ComponentChildren }) {
  return (
    <section class="section">
      {props.title && <h2>{props.title}</h2>}
      {props.children}
    </section>
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

export function IconClear() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--rule-strong)" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  )
}

export function IconPencil() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3L5.5 13.5 2 14l.5-3.5z" />
    </svg>
  )
}

export function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

export function IconGear() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" />
      <path
        d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7"
        stroke-linecap="round"
      />
    </svg>
  )
}
