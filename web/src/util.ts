import { Machine, Meta, Run, Session } from './api'

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
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (sameDay(d, n)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const y = new Date(now - 86400_000)
  if (sameDay(d, y)) return '昨天'
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
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
  if (sameDay(d, n)) return '今天'
  if (sameDay(d, new Date(now - 86400_000))) return '昨天'
  const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 周${wk}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export type Bucket = { key: string; label: string }

/** Time bucket for the sidebar, like a chat app. */
export function timeBucket(t: number, now = Date.now()): Bucket {
  const n = new Date(now)
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (t >= startToday) return { key: 'a-today', label: '今天' }
  if (t >= startToday - 86400_000) return { key: 'b-yesterday', label: '昨天' }
  if (t >= startToday - 6 * 86400_000) return { key: 'c-week', label: '过去 7 天' }
  if (t >= startToday - 29 * 86400_000) return { key: 'd-month', label: '过去 30 天' }
  const d = new Date(t)
  return { key: `e-${9999 - d.getFullYear()}-${String(12 - d.getMonth()).padStart(2, '0')}`, label: `${d.getFullYear()}年${d.getMonth() + 1}月` }
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

export const displayTitle = (s: Session, meta?: Meta) => meta?.title || s.title || '（无标题）'

export type ModeOption = { value: string; label: string; hint: string }

export function modeOptions(agent: string): ModeOption[] {
  if (agent === 'codex')
    return [
      { value: 'machine', label: '跟随机器设置', hint: '和在那台机器的终端里运行一样' },
      { value: 'readonly', label: '只读', hint: '只看不改，不能写文件' },
      { value: 'edits', label: '可改工作目录', hint: '可以在工作目录里读写' },
      { value: 'full', label: '完全放开', hint: '不设沙箱，谨慎使用' },
    ]
  return [
    { value: 'machine', label: '跟随机器设置', hint: '和在那台机器的终端里运行一样' },
    { value: 'ask', label: '需要时问我', hint: '改文件、跑命令前在这里弹出确认' },
    { value: 'plan', label: '只做计划', hint: '只调研和出方案，不动手' },
    { value: 'edits', label: '自动改文件', hint: '改文件不问，跑命令仍会确认' },
    { value: 'full', label: '全部放行', hint: '不再确认，谨慎使用' },
  ]
}

export const statusText: Record<string, string> = {
  queued: '等待机器接收…',
  starting: '正在启动…',
  running: '正在运行',
  permission: '等待你确认',
  done: '已完成',
  error: '出错了',
  stopped: '已停止',
  lost: '已中断',
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
