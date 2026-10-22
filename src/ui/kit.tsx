import type { ComponentChildren } from 'preact'
import { createPortal } from 'preact/compat'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { calcPress, isSum } from '../lib/calc'
import { cur, evalAmount, fmt, groupTyped } from '../lib/money'
import { settings, undo } from '../lib/store'
import { useMedia } from './hooks'
import { onTopSheet, topSheet } from './sheet'
import './calc.css'
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
  // An open sheet makes everything behind it inert and covers it, so the toast (and its Undo) lives inside the top one.
  const [host, setHost] = useState<HTMLDialogElement | null>(topSheet)
  const [moved, setMoved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(
    () =>
      onTopSheet((d) => {
        setHost(d)
        setMoved(true) // already on screen: change layers without slipping in again
      }),
    [],
  )
  useEffect(() => {
    pushToast = (t) => {
      clearTimeout(timer.current)
      setLeaving(false)
      setMoved(false)
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
  const node = (
    <div class={`toast${leaving ? ' out' : ''}${moved ? ' still' : ''}`} role="status" key={msg.id}>
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
  return host ? createPortal(node, host) : node
}

// ---------------------------------------------------------------- keypad (phones only)

const OPS = '+-*/'
const OP_SIGN: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' }
const OP_NAME: Record<string, string> = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by' }

/** How a typed sum reads: "1200+15*3" -> "1,200 + 15 × 3". */
export function showSum(s: string): string {
  return groupTyped(s)
    .replace(/\s+/g, '')
    .replace(/[+\-−*/×÷]/g, (op, i) => (i === 0 ? op : ` ${OP_SIGN[op] ?? op} `))
}

/** Phone keypad: digits, and + − × ÷ for sums (a + in front means money coming in). */
export function Keypad(props: { value: string; onChange: (v: string) => void; decimals: number }) {
  const value = useRef(props.value)
  value.current = props.value

  const press = (k: string) => {
    let v = value.current
    // The number being typed: the part after the last + − × ÷.
    const num = v.split(/[+\-*/]/).pop() ?? ''
    const last = v.slice(-1)
    if (k === 'back') v = v.slice(0, -1)
    else if (OPS.includes(k)) {
      // A + in front means money coming in; anything else needs a number before it.
      if (!v) {
        if (k !== '+') return
        v = '+'
      } else if (OPS.includes(last)) {
        if (v.length === 1) return
        v = v.slice(0, -1) + k
      } else {
        if (v.length >= 40) return
        v += k
      }
    } else if (k === '.') {
      if (num.includes('.')) return
      v += num ? '.' : '0.'
    } else if (k === '00') {
      if (!num || num.includes('.') || num === '0' || num.length >= 8) return
      v += '00'
    } else {
      if (num.includes('.') && num.split('.')[1].length >= 2) return
      if (num === '0') v = v.slice(0, -1)
      if (num.replace('.', '').length >= 9) return
      v += k
    }
    haptic('light')
    value.current = v
    props.onChange(v)
  }
  const clear = () => {
    if (!value.current) return false
    value.current = ''
    props.onChange('')
    return true
  }
  return <KeyGrid decimals={props.decimals} press={press} clear={clear} />
}

/**
 * The keys themselves, shared by Today's keypad and the one docked under amount fields. With `done`, the
 * bottom right key is a return key that lets go of the field, where a phone keyboard has it.
 */
function KeyGrid(props: { decimals: number; press: (k: string) => void; clear: () => boolean; done?: () => void }) {
  const lastPointer = useRef(0)
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined)
  const endHold = () => clearTimeout(hold.current)
  useEffect(() => endHold, [])
  const keys = ['1', '2', '3', '+', '4', '5', '6', '-', '7', '8', '9', '*', props.decimals ? '.' : '00', '0', 'back', '/']
  const key = (k: string) => (
        <button
          key={k}
          type="button"
          class={`key${OPS.includes(k) ? ' op' : ''}`}
          // Pointer-down feels instant on a phone (and keeps the focus where it is). The click that
          // follows a touch is ignored; a click with no pointer before it comes from the keyboard.
          onPointerDown={(e) => {
            e.preventDefault()
            lastPointer.current = Date.now()
            props.press(k)
            if (k === 'back') {
              endHold()
              // Hold ⌫ to clear everything (iOS never fires contextmenu, so time it ourselves).
              hold.current = setTimeout(() => {
                if (!props.clear()) return
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
            props.press(k)
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={k === 'back' ? 'Delete (hold to clear)' : OP_NAME[k] ?? k}
        >
          {k === 'back' ? <IconBack /> : OP_SIGN[k] ?? k}
        </button>
      )
  if (!props.done)
    return (
      <div class="keypad" role="group" aria-label="Amount keypad">
        {keys.map(key)}
      </div>
    )
  const done = props.done
  // Digits in a 3×4 block; the operators and the return key share the column beside it.
  return (
    <div class="keypad has-done" role="group" aria-label="Amount keypad">
      <div class="keypad-digits">{keys.filter((k) => !OPS.includes(k)).map(key)}</div>
      <div class="keypad-ops">
        {keys.filter((k) => OPS.includes(k)).map(key)}
        <button
          type="button"
          class="key done"
          onPointerDown={(e) => {
            e.preventDefault()
            lastPointer.current = Date.now()
            done()
          }}
          onClick={() => Date.now() - lastPointer.current >= 1000 && done()}
        >
          Done
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the keypad under amount fields (phones)

/** Put the caret after the last character once the field shows its value (never select it all). */
export function caretToEnd(el: HTMLInputElement) {
  requestAnimationFrame(() => {
    if (document.activeElement !== el) return
    const n = el.value.length
    el.setSelectionRange(n, n)
  })
}

/** Change a field as typing would, so its own input handlers (regrouping, drafts) run just as for a key. */
function typeInto(el: HTMLInputElement, value: string, caret: number, inputType: string, data: string | null) {
  el.value = value
  el.setSelectionRange(caret, caret)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }))
  // iOS doesn't scroll a field to a caret set from script: keep what's being typed in view.
  requestAnimationFrame(() => {
    if (el.selectionEnd === el.value.length) el.scrollLeft = el.scrollWidth
  })
}

/** Enter on the field, as the keyboard would press it; a field that has no use for it just lets go. */
function pressEnter(el: HTMLInputElement) {
  letGo = true
  try {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    if (!ev.defaultPrevented && document.activeElement === el) el.blur()
  } finally {
    letGo = false
  }
}

/** Done where Enter would go on to the next field: this one just lets go. */
function release(el: HTMLInputElement) {
  letGo = true
  try {
    el.blur()
  } finally {
    letGo = false
  }
}

/** When the keypad was last touched, and whether the field is meant to let go now (Done, Next, a one-tap amount). */
let padTouchedAt = 0
let letGo = false

/**
 * Our keypad for an amount field on touch screens: the system keyboard stays away (inputMode none)
 * and the keypad docks at the bottom while the field has focus. Spread `field` on the input and
 * render `pad(...)` beside it.
 */
export function useCalc() {
  const touch = useMedia('(pointer: coarse)')
  const [el, setEl] = useState<HTMLInputElement | null>(null)
  return {
    touch,
    field: {
      inputMode: (touch ? 'none' : 'decimal') as 'none' | 'decimal',
      onFocusCapture: (e: FocusEvent) => {
        if (touch) setEl(e.target as HTMLInputElement)
      },
      onBlurCapture: (e: FocusEvent) => {
        // A tap on the keypad must never take the focus away (iOS can, from the touch's own mouse events):
        // the field gets it straight back and the keypad stays. Focus moving to another field is real.
        const input = e.target as HTMLInputElement
        if (touch && !letGo && !e.relatedTarget && Date.now() - padTouchedAt < 700) {
          setTimeout(() => input.isConnected && document.activeElement !== input && input.focus({ preventScroll: true }))
          return
        }
        setEl(null)
      },
    },
    /** the keypad while its field has focus; options can be a function, worked out only then */
    pad: (opts: PadOpts | (() => PadOpts) = {}) => el && <CalcPad input={el} {...(typeof opts === 'function' ? opts() : opts)} />,
  }
}

interface PadOpts {
  /** currency of the amount (decimals, and how a sum's result reads); the budget's own by default */
  cur?: string
  /** Enter goes on to the next field */
  next?: boolean
  /** a one-tap amount offered in the bar while the field is empty */
  hint?: { label: string; value: number }
}

const PAD_KEY: Record<string, string> = { '-': '−', '*': '×', '/': '÷' }
let padsOpen = 0
let padClosedAt = 0

/**
 * Docked at the bottom of the screen, inside the top sheet when one is open (everything outside a
 * sheet is inert). The page or the sheet makes room, so the field stays in view above it.
 */
function CalcPad(props: PadOpts & { input: HTMLInputElement }) {
  const { input } = props
  const code = props.cur ?? settings().base
  const decimals = cur(code).decimals
  const ref = useRef<HTMLDivElement>(null)
  const [host] = useState(topSheet)
  // Next swaps one field's keypad for another's: the new one doesn't slide in again.
  const [still] = useState(() => padsOpen > 0 || Date.now() - padClosedAt < 200)
  const [value, setValue] = useState(input.value)

  useEffect(() => {
    const on = () => setValue(input.value)
    on()
    input.addEventListener('input', on)
    return () => input.removeEventListener('input', on)
  }, [input])

  useLayoutEffect(() => {
    padsOpen++
    const h = ref.current?.offsetHeight ?? 0
    if (host) {
      host.style.setProperty('--sheet-kb', `${h}px`)
      host.style.setProperty('--sheet-vh', `${window.innerHeight - h}px`)
    } else document.body.style.paddingBottom = `${h}px`
    const id = requestAnimationFrame(() => {
      const r = input.getBoundingClientRect()
      const limit = window.innerHeight - h - 12
      if (r.bottom <= limit && r.top >= 0) return
      if (host) input.scrollIntoView({ block: 'nearest' })
      else window.scrollBy({ top: r.bottom - limit, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    })
    return () => {
      cancelAnimationFrame(id)
      padsOpen--
      padClosedAt = Date.now()
      if (padsOpen) return
      if (host) {
        host.style.removeProperty('--sheet-kb')
        host.style.removeProperty('--sheet-vh')
      } else document.body.style.paddingBottom = ''
    }
  }, [input])

  const press = (k: string) => {
    const key = PAD_KEY[k] ?? k
    const r = calcPress(input.value, input.selectionStart ?? input.value.length, key, decimals)
    if (!r) return
    haptic('light')
    typeInto(input, r.value, r.caret, k === 'back' ? 'deleteContentBackward' : 'insertText', k === 'back' ? null : key)
  }
  const clear = () => {
    if (!input.value) return false
    typeInto(input, '', 0, 'deleteContentBackward', null)
    return true
  }
  const sum = isSum(value) ? evalAmount(value, code) : null
  const hint = props.hint && !value.trim() ? props.hint : null

  // Everything here acts on pointer-down. Cancelling the touch as well keeps iOS from following up with the
  // mouse events and click that would move the focus off the field and close the keypad after one key.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: TouchEvent) => e.cancelable && e.preventDefault()
    // A tap anywhere else is a real goodbye, however soon after a key.
    const away = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) padTouchedAt = 0
    }
    el.addEventListener('touchstart', stop, { passive: false })
    document.addEventListener('pointerdown', away, true)
    return () => {
      el.removeEventListener('touchstart', stop)
      document.removeEventListener('pointerdown', away, true)
    }
  }, [])
  const act = (fn: () => void) => ({
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      fn()
    },
    // a click with no pointer before it comes from the keyboard
    onClick: (e: MouseEvent) => e.detail === 0 && fn(),
  })

  return createPortal(
    <div
      class={`calc${still ? ' still' : ''}`}
      ref={ref}
      onPointerDown={(e) => {
        padTouchedAt = Date.now()
        e.preventDefault()
      }}
    >
      <div class="calc-bar">
        {sum !== null ? (
          <span class="calc-sum num">= {fmt(sum, code)}</span>
        ) : hint ? (
          <button
            type="button"
            class="pill sm"
            {...act(() => {
              const v = groupTyped(String(hint.value / 100))
              typeInto(input, v, v.length, 'insertText', v)
              pressEnter(input)
            })}
          >
            {hint.label} <small>{fmt(hint.value, code, { bare: true })}</small>
          </button>
        ) : (
          <span />
        )}
        {props.next && (
          <button type="button" class="calc-done" {...act(() => pressEnter(input))}>
            Next
          </button>
        )}
      </div>
      <KeyGrid decimals={decimals} press={press} clear={clear} done={() => (props.next ? release(input) : pressEnter(input))} />
    </div>,
    host ?? document.body,
  )
}

// ---------------------------------------------------------------- the system keyboard on phones

/**
 * iOS only brings its keyboard up for a focus made during the tap itself. A field that appears a moment
 * later (after a re-render) gets it by taking over from this stand-in, focused now. Call it in the tap's
 * handler, before the state change that shows the field; it says whether it did anything (touch screens only).
 */
export function primeKeyboard(): boolean {
  if (!matchMedia('(pointer: coarse)').matches) return false
  let el = document.getElementById('kb-standin') as HTMLInputElement | null
  if (!el) {
    el = document.createElement('input')
    el.id = 'kb-standin'
    el.type = 'text'
    el.tabIndex = -1
    el.autocomplete = 'off'
    el.setAttribute('aria-hidden', 'true')
    // on screen (iOS ignores a focus far outside it) but invisible, and 16px so the page doesn't zoom
    el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none'
    document.body.appendChild(el)
  }
  el.focus({ preventScroll: true })
  return true
}

/**
 * On a phone, a tap on empty space lets go of the field being typed in (and of selected text), as in any
 * app. iOS doesn't do this for web pages: the keyboard stays up until another field is tapped. A tap, not
 * a scroll: it has to end close to where it started.
 */
export function letGoOnTapAway() {
  const KEEP = 'input, textarea, select, button, a, label, [role="button"], [contenteditable], [tabindex], .calc, .keypad'
  let start: { x: number; y: number; t: number; target: EventTarget | null } | null = null
  document.addEventListener(
    'pointerdown',
    (e) => {
      start = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY, t: Date.now(), target: e.target }
    },
    true,
  )
  document.addEventListener(
    'pointerup',
    (e) => {
      const s = start
      start = null
      if (!s || e.target !== s.target || Date.now() - s.t > 600 || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) return
      if ((e.target as Element).closest?.(KEEP)) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) el.blur()
      const sel = getSelection()
      if (sel && !sel.isCollapsed) sel.removeAllRanges()
    },
    true,
  )
}

// ---------------------------------------------------------------- typed amounts

/**
 * Call first thing in an amount field's input handler. Only numbers and sums get in ("200 + 15 - 12";
 * no letters), one decimal point per number, and the thousands separators go in as you type (not on
 * a paste, which may use other conventions). Keeps the caret after the same digit; returns the new value.
 */
export function regroup(e: Event): string {
  const el = e.currentTarget as HTMLInputElement
  const raw = el.value
  const type = (e as InputEvent).inputType ?? ''
  const caret = el.selectionStart ?? raw.length
  const MARK = '\u0001'
  let s = (raw.slice(0, caret) + MARK + raw.slice(caret))
    .replace(/[^\d.,+\-−*/×÷ \u0001]/g, '')
    .replace(/\*/g, '×')
    .replace(/\//g, '÷')
  // In each number the first decimal point stays; another one typed is ignored.
  s = s.replace(/[\d.,\u0001]+/g, (run) => {
    let dot = false
    return run.replace(/\./g, (m) => (dot ? '' : ((dot = true), m)))
  })
  const before = s.slice(0, s.indexOf(MARK))
  s = s.replace(MARK, '')
  const value = type === 'insertFromPaste' || type === 'insertFromDrop' ? s : groupTyped(s)
  // The caret goes after the same number of characters, not counting separators.
  const want = before.replace(/,/g, '').length
  let pos = 0
  for (let n = 0; pos < value.length && n < want; pos++) if (value[pos] !== ',') n++
  if (value !== raw) {
    el.value = value
    el.setSelectionRange(pos, pos)
  }
  return value
}

// ---------------------------------------------------------------- amount field with clear button

/** Keeps password managers and iOS's password bar away from fields that are only amounts or notes. */
export const NO_AUTOFILL = { autocomplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-bwignore': true, 'data-form-type': 'other' }

/**
 * A text field for money: the caret goes to the end on focus, an × clears it to type fresh, and on
 * phones our keypad (sums included) replaces the system one.
 */
export function AmountField(props: {
  value: string
  onInput: (v: string) => void
  onCommit?: (v: string) => void
  class?: string
  autoFocus?: boolean
  label: string
  placeholder?: string
  /** currency of the amount (decimals on the keypad); the budget's own by default */
  cur?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const orig = useRef(props.value) // what the field held when it got focus
  const abandoned = useRef(false) // Esc was pressed: the blur that follows must not commit
  const calc = useCalc()
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus()
  }, [])
  return (
    <div class={`amountfield ${props.class ?? ''}`}>
      <input
        ref={ref}
        type="text"
        {...NO_AUTOFILL}
        {...calc.field}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={props.value}
        onFocus={(e) => {
          orig.current = props.value
          abandoned.current = false
          caretToEnd(e.currentTarget)
        }}
        onInput={(e) => {
          abandoned.current = false
          props.onInput(regroup(e))
        }}
        onBlur={(e) => {
          if (abandoned.current) abandoned.current = false
          else props.onCommit?.(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // Esc abandons what was typed. A sheet around the field closes by itself (don't cancel that).
          else if (e.key === 'Escape') {
            abandoned.current = true
            props.onInput(orig.current)
          }
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
      {calc.pad({ cur: props.cur })}
    </div>
  )
}

/** A note field with a pencil instead of placeholder text. */
export function NoteField(props: { value: string; onInput: (v: string) => void; onCommit?: (v: string) => void; onEnter?: () => void; list?: string }) {
  const orig = useRef(props.value)
  const abandoned = useRef(false)
  return (
    <label class="note">
      <IconPencil />
      <input
        type="text"
        aria-label="Note"
        value={props.value}
        // Past notes are offered once you start typing, not as a list the moment the field is touched.
        list={props.value.trim() ? props.list : undefined}
        enterKeyHint="done"
        {...NO_AUTOFILL}
        onFocus={() => {
          orig.current = props.value
          abandoned.current = false
        }}
        onInput={(e) => {
          abandoned.current = false
          props.onInput(e.currentTarget.value)
        }}
        onBlur={(e) => {
          if (abandoned.current) abandoned.current = false
          else props.onCommit?.(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
            props.onEnter?.()
          } else if (e.key === 'Escape' && props.onCommit) {
            // Fields that save on blur: Esc abandons the edit (a sheet around it closes by itself).
            abandoned.current = true
            props.onInput(orig.current)
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
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
      <path d="M8.56 3.76L8.79 1.38L11.21 1.38L11.44 3.76L13.39 4.57L15.24 3.05L16.95 4.76L15.43 6.61L16.24 8.56L18.62 8.79L18.62 11.21L16.24 11.44L15.43 13.39L16.95 15.24L15.24 16.95L13.39 15.43L11.44 16.24L11.21 18.62L8.79 18.62L8.56 16.24L6.61 15.43L4.76 16.95L3.05 15.24L4.57 13.39L3.76 11.44L1.38 11.21L1.38 8.79L3.76 8.56L4.57 6.61L3.05 4.76L4.76 3.05L6.61 4.57Z" />
      <circle cx="10" cy="10" r="2.7" />
    </svg>
  )
}
