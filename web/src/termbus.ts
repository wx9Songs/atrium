// Text on its way to a session's terminal from elsewhere on the page (a "!command"
// typed in the message box). The terminal may not be open yet, so it waits here.
const pending = new Map<string, string>()

export function sendToTerminal(key: string, text: string) {
  pending.set(key, (pending.get(key) || '') + text)
  window.dispatchEvent(new CustomEvent('atrium:term-input', { detail: key }))
}

export function takeTerminalInput(key: string): string {
  const text = pending.get(key) || ''
  pending.delete(key)
  return text
}
