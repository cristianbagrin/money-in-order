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

/** Where the caret goes in `value` to sit after `want` characters, not counting thousands separators. */
function caretAfter(value: string, want: number): number {
  let pos = 0
  for (let n = 0; pos < value.length && n < want; pos++) if (value[pos] !== ',') n++
  return pos
}

/**
 * Press a key on a field holding `value` with the caret at `caret` (or the text from `caret` to `end`
 * selected). Keys: digits, '00', '.', '+', '−', '×', '÷', 'back'. Returns the new value and caret, or null
 * when the key does nothing there. A selection goes first, as with a keyboard: ⌫ deletes it, anything
 * else types over it.
 */
export function calcPress(value: string, caret: number, key: string, decimals: number, end = caret): { value: string; caret: number } | null {
  if (end > caret) {
    const raw = value.replace(/,/g, '')
    const a = plainBefore(value, caret)
    const cut = groupTyped(raw.slice(0, a) + raw.slice(plainBefore(value, end)))
    const at = caretAfter(cut, a)
    return key === 'back' ? { value: cut, caret: at } : calcPress(cut, at, key, decimals)
  }
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
  return { value: next, caret: caretAfter(next, before.length) }
}

/** True when the text is a sum still to be worked out ("1,200 + 15"), not a plain number. */
export const isSum = (s: string) => /\d\s*[+\-−×÷*/]/.test(s)
