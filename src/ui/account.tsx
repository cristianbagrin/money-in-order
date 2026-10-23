import { useState } from 'preact/hooks'
import { MIN_PASSWORD, signIn, signUp, validEmail } from '../lib/sync'
import { toast } from './kit'
import { play } from './sound'

/**
 * For every text field that is not the sign-in form (names of accounts, income sources...). iOS and the
 * password managers take a text field next to a password field, or with a name like "account", for a
 * login and offer to fill it: these attributes tell them all it is not one.
 */
export const NO_AUTOFILL = {
  autocomplete: 'off',
  spellcheck: false,
  autocorrect: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

/**
 * Sign in, or create an account with the budget on this device. A real form with the fields password
 * managers know, so the browser can save and fill the email and password.
 */
export function AccountForm(props: { signInOnly?: boolean; onDone?: () => void }) {
  const [mode, setMode] = useState<'in' | 'new'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const creating = mode === 'new' && !props.signInOnly

  const fail = (msg: string) => {
    play('error')
    toast(msg)
  }

  async function submit(e: Event) {
    e.preventDefault()
    if (busy) return
    if (!validEmail(email)) return fail('That email doesn’t look right')
    if (creating && password.length < MIN_PASSWORD) return fail(`Use at least ${MIN_PASSWORD} characters for the password`)
    if (creating && repeat !== password) return fail('The passwords don’t match')
    setBusy(true)
    if (creating) {
      const r = await signUp(email, password)
      setBusy(false)
      if (r === 'created') {
        play('success')
        toast('Account created. Your budget syncs now')
        props.onDone?.()
      } else fail(r === 'exists' ? 'There’s already an account for this email. Sign in instead' : 'Couldn’t reach the server')
      return
    }
    // A device with no budget yet has nothing to lose; otherwise ask before the account's budget replaces this one.
    const r = await signIn(email, password, () =>
      props.signInOnly ? true : confirm('Use the budget from your account on this device? What is on this device now is replaced'),
    )
    setBusy(false)
    if (r === 'joined') {
      play('success')
      toast('Signed in')
      props.onDone?.()
    } else if (r === 'wrong') fail('Wrong password')
    else if (r === 'none') fail('No account for this email yet')
    else if (r === 'error') fail('Couldn’t reach the server')
  }

  return (
    <form class="account" onSubmit={submit} noValidate>
      {!props.signInOnly && (
        <div class="pills" role="group" aria-label="Sign in or create">
          <button type="button" class="pill sm" aria-pressed={mode === 'in'} onClick={() => setMode('in')}>
            Sign in
          </button>
          <button type="button" class="pill sm" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
            Create account
          </button>
        </div>
      )}
      <input
        type="email"
        name="email"
        autocomplete="username"
        aria-label="Email"
        placeholder="Email"
        spellcheck={false}
        autocapitalize="off"
        value={email}
        onInput={(e) => setEmail(e.currentTarget.value)}
      />
      <input
        type="password"
        name="password"
        autocomplete={creating ? 'new-password' : 'current-password'}
        aria-label="Password"
        placeholder="Password"
        minLength={creating ? MIN_PASSWORD : undefined}
        value={password}
        onInput={(e) => setPassword(e.currentTarget.value)}
      />
      {creating && (
        <input
          type="password"
          name="password-repeat"
          autocomplete="new-password"
          aria-label="Repeat password"
          placeholder="Repeat password"
          value={repeat}
          onInput={(e) => setRepeat(e.currentTarget.value)}
        />
      )}
      <button type="submit" class={props.signInOnly ? 'btn block' : 'pill solid'} disabled={busy || !email.trim() || !password || (creating && !repeat)}>
        {busy ? (creating ? 'Creating…' : 'Signing in…') : creating ? 'Create account' : 'Sign in'}
      </button>
    </form>
  )
}
