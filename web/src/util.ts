import { Machine, Meta, Run, Session } from './api'
import { t as tr } from './i18n'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const ms = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0)

// ---------- input methods (Chinese, Japanese, … typing) ----------
// While a candidate is being chosen, Enter / arrows / Esc belong to the input
// method, not to the page. Browsers disagree on how they report this: Chrome
// marks the key event as "composing"; Safari ends the composition first and
// then delivers the Enter key (with keyCode 229). All three signals are checked.
let composing = false
let compositionEndedAt = -1e9
document.addEventListener('compositionstart', () => { composing = true }, true)
document.addEventListener('compositionend', () => { composing = false; compositionEndedAt = performance.now() }, true)

/** True when this key press was consumed by the input method and must not trigger an action. */
export function imeKey(e: { nativeEvent: KeyboardEvent }): boolean {
  const n = e.nativeEvent
  return n.isComposing || composing || n.keyCode === 229 || performance.now() - compositionEndedAt < 100
}

const pad = (n: number) => String(n).padStart(2, '0')

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Short time for list rows: 刚刚 / 12 分钟前 / 14:03 / 昨天 / 11月3日 / 2025年3月 */
export function shortTime(t: number, now = Date.now()): string {
  if (!t) return ''
  const d = new Date(t)
  const n = new Date(now)
  const diff = now - t
  if (diff < 60_000) return tr('刚刚', 'now')
  if (diff < 3600_000) return tr(`${Math.floor(diff / 60_000)} 分钟前`, `${Math.floor(diff / 60_000)}m ago`)
  if (sameDay(d, n)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const y = new Date(now - 86400_000)
  if (sameDay(d, y)) return tr('昨天', 'Yesterday')
  if (d.getFullYear() === n.getFullYear()) return tr(`${d.getMonth() + 1}月${d.getDate()}日`, `${MON[d.getMonth()]} ${d.getDate()}`)
  return tr(`${d.getFullYear()}年${d.getMonth() + 1}月`, `${MON[d.getMonth()]} ${d.getFullYear()}`)
}

export function fullTime(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function clockTime(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dayLabel(t: number, now = Date.now()): string {
  const d = new Date(t)
  const n = new Date(now)
  if (sameDay(d, n)) return tr('今天', 'Today')
  if (sameDay(d, new Date(now - 86400_000))) return tr('昨天', 'Yesterday')
  const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  const wkEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  if (d.getFullYear() === n.getFullYear()) return tr(`${d.getMonth() + 1}月${d.getDate()}日 周${wk}`, `${wkEn}, ${MON[d.getMonth()]} ${d.getDate()}`)
  return tr(`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`, `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`)
}

export type Bucket = { key: string; label: string }

/** Time bucket for the sidebar, like a chat app. */
export function timeBucket(t: number, now = Date.now()): Bucket {
  const n = new Date(now)
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (t >= startToday) return { key: 'a-today', label: tr('今天', 'Today') }
  if (t >= startToday - 86400_000) return { key: 'b-yesterday', label: tr('昨天', 'Yesterday') }
  if (t >= startToday - 6 * 86400_000) return { key: 'c-week', label: tr('过去 7 天', 'Previous 7 days') }
  if (t >= startToday - 29 * 86400_000) return { key: 'd-month', label: tr('过去 30 天', 'Previous 30 days') }
  const d = new Date(t)
  return { key: `e-${9999 - d.getFullYear()}-${String(12 - d.getMonth()).padStart(2, '0')}`, label: tr(`${d.getFullYear()}年${d.getMonth() + 1}月`, `${MON[d.getMonth()]} ${d.getFullYear()}`) }
}

/** Folder name shown for a working directory. */
export function folderName(cwd?: string): string {
  if (!cwd) return ''
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] || '/'
}

/** Shorten a long path in the middle, keeping the end. */
export function shortPath(p: string, max = 46): string {
  if (!p) return ''
  let s = p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/root(?=\/|$)/, '~')
  if (s.length <= max) return s
  const parts = s.split('/')
  let tail = parts.pop() || ''
  while (parts.length && (tail.length + parts[parts.length - 1].length + 1) < max - 4) tail = parts.pop() + '/' + tail
  return '…/' + tail
}

export const agentName = (a: string) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : a)

export function machineLabel(machines: Machine[], name: string) {
  return machines.find((m) => m.name === name)?.label || name
}

export const displayTitle = (s: Session, meta?: Meta) => meta?.title || s.title || tr('（无标题）', '(untitled)')

export type ModeOption = { value: string; label: string; hint: string }

export function modeOptions(agent: string): ModeOption[] {
  if (agent === 'codex')
    return [
      { value: 'machine', label: tr('跟随机器设置', "Machine default"), hint: tr('和在那台机器的终端里运行一样', "Same as running it in that machine's terminal") },
      { value: 'readonly', label: tr('只读', "Read-only"), hint: tr('只看不改，不能写文件', "Look but don't touch: no file writes") },
      { value: 'edits', label: tr('可改工作目录', "Edit workspace"), hint: tr('可以在工作目录里读写', "Read and write inside the working directory") },
      { value: 'full', label: tr('完全放开', "Full access"), hint: tr('不设沙箱，谨慎使用', "No sandbox. Use with care") },
    ]
  return [
    { value: 'machine', label: tr('跟随机器设置', "Machine default"), hint: tr('和在那台机器的终端里运行一样', "Same as running it in that machine's terminal") },
    { value: 'ask', label: tr('需要时问我', "Ask me"), hint: tr('改文件、跑命令前在这里弹出确认', "Confirm here before edits and commands") },
    { value: 'plan', label: tr('只做计划', "Plan only"), hint: tr('只调研和出方案，不动手', "Research and propose, change nothing") },
    { value: 'edits', label: tr('自动改文件', "Auto-accept edits"), hint: tr('改文件不问，跑命令仍会确认', "Edits go through, commands still ask") },
    { value: 'full', label: tr('全部放行', "Allow everything"), hint: tr('不再确认，谨慎使用', "Never asks. Use with care") },
  ]
}

export const statusText: Record<string, string> = {
  queued: tr('等待机器接收…', 'Waiting for the machine…'),
  starting: tr('正在启动…', 'Starting…'),
  running: tr('正在运行', 'Running'),
  permission: tr('等待你确认', 'Waiting for you'),
  done: tr('已完成', 'Done'),
  error: tr('出错了', 'Failed'),
  stopped: tr('已停止', 'Stopped'),
  lost: tr('已中断', 'Interrupted'),
}

/** A run still needs to be drawn from its live events when the archive has not caught up with it. */
export function runCoveredByArchive(r: Run, s?: Session): boolean {
  if (!s || s.synthetic) return false
  if (!r.last_ts) return true // produced nothing worth overlaying
  return ms(s.ended) >= r.last_ts - 2000
}

export function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  fallbackCopy(text)
  return Promise.resolve()
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* ignore */
  }
  ta.remove()
}

export function resumeCommand(s: Session): string {
  const cd = s.cwd ? `cd ${JSON.stringify(s.cwd)} && ` : ''
  return s.agent === 'codex' ? `${cd}codex resume ${s.nid}` : `${cd}claude --resume ${s.nid}`
}
