import { groupTyped } from './money'

/*
  The amount keypad editing a text field at its caret: the same rules as Today's keypad (one decimal
  point, at most two decimals, a leading zero replaced, operators never doubled), applied to the
  number the caret is in. Separators are put back after every key and the caret keeps its place.
*/

const OPS = '+-−×÷*/'
const isOp = (ch: string | undefined) => !!ch && OPS.includes(ch)

/** Characters before `pos` in `s`, not counting thousands separators. */
const plainBefore = (s: string, pos: number) => s.slice(0, pos).replace(/,/g, '').length

/**
 * Press a key on a field holding `value` with the caret at `caret`. Keys: digits, '00', '.', '+', '−',
 * '×', '÷', 'back'. Returns the new value and caret, or null when the key does nothing there.
 */
export function calcPress(value: string, caret: number, key: string, decimals: number): { value: string; caret: number } | null {
  const raw = value.replace(/,/g, '')
  const at = Math.min(raw.length, plainBefore(value, caret))
  let before = raw.slice(0, at)
  let after = raw.slice(at)
  // The number the caret is in: from the last operator before it to the first one after.
  const head = before.match(/[^+\-−×÷*/\s]*$/)?.[0] ?? ''
  const tail = after.match(/^[^+\-−×÷*/\s]*/)?.[0] ?? ''
  const num = head + tail
  const last = before.trimEnd().slice(-1)

  if (key === 'back') {
    if (!before) return null
    before = before.trimEnd().slice(0, -1).trimEnd()
  } else if (isOp(key)) {
    if (!before.trim()) {
      // In front only a sign makes sense.
      if (key !== '+' && key !== '−') return null
      if (isOp(after[0])) after = after.slice(1)
      before = key
    } else if (isOp(last)) {
      before = before.trimEnd().slice(0, -1) + key
    } else {
      if (raw.length >= 40) return null
      before += key
      if (isOp(after.trimStart()[0])) after = after.trimStart().slice(1)
    }
  } else if (key === '.') {
    if (!decimals || num.includes('.')) return null
    before += head ? '.' : '0.'
  } else if (key === '00') {
    if (!head || num.includes('.') || num === '0' || num.length >= 8) return null
    before += '00'
  } else if (/^\d$/.test(key)) {
    const dot = num.indexOf('.')
    if (dot >= 0 && head.length > dot && num.length - dot - 1 >= decimals) return null
    if (num.replace('.', '').length >= 9) return null
    if (head === '0' && !tail) before = before.slice(0, -1)
    before += key
  } else return null

  const next = groupTyped(before + after)
  const want = before.length
  let pos = 0
  for (let n = 0; pos < next.length && n < want; pos++) if (next[pos] !== ',') n++
  return { value: next, caret: pos }
}

/** True when the text is a sum still to be worked out ("1,200 + 15"), not a plain number. */
export const isSum = (s: string) => /\d\s*[+\-−×÷*/]/.test(s)
