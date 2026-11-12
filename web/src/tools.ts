// Turns a raw tool call (from the archive or from a live run) into something
// readable: a kind, a short Chinese label and a one-line summary.
import { Tool } from './api'

export type ToolKind =
  | 'bash' | 'read' | 'write' | 'edit' | 'search' | 'task' | 'todo' | 'web' | 'question' | 'plan' | 'skill' | 'other'

export type ToolView = { kind: ToolKind; label: string; summary: string }

export function parseInput(t: Tool): any {
  if (t.inputObj !== undefined) return t.inputObj
  const raw = t.input
  if (!raw) return null
  const s = raw.trim()
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s)
    } catch {
      return null // truncated JSON
    }
  }
  return null
}

/** Pull one string field out of JSON that may have been cut off. */
export function fieldFromRaw(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
  if (!m) return undefined
  try {
    return JSON.parse('"' + m[1] + '"')
  } catch {
    return m[1]
  }
}

export function field(t: Tool, obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj && typeof obj === 'object' ? obj[k] : undefined
    if (typeof v === 'string' && v) return v
    if (!obj && t.input) {
      const r = fieldFromRaw(t.input, k)
      if (r) return r
    }
  }
  return ''
}

export function commandOf(t: Tool, obj: any): string {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const c = obj.command ?? obj.cmd ?? obj.script ?? obj.code
    if (Array.isArray(c)) {
      if (c.length >= 3 && /(^|\/)(ba|z)?sh$/.test(String(c[0])) && /^-l?c$/.test(String(c[1]))) return String(c[2])
      return c.map(String).join(' ')
    }
    if (typeof c === 'string') return c
  }
  if (!obj && t.input) {
    const c = fieldFromRaw(t.input, 'command') ?? fieldFromRaw(t.input, 'cmd')
    if (c) return c
    return t.input // Codex stores some commands as plain text
  }
  return ''
}

const firstLine = (s: string, n = 110) => {
  const l = (s || '').trim().split('\n')[0]
  return l.length > n ? l.slice(0, n) + '…' : l
}

const base = (p: string) => (p || '').replace(/\/+$/, '').split('/').slice(-2).join('/')

function kindOf(t: Tool): ToolKind {
  const n = t.name || ''
  if (/^(Bash|BashOutput|KillShell|exec|shell|local_shell|exec_command|command_execution|container\.exec|shell_command|unified_exec|write_stdin)$/i.test(n)) return 'bash'
  if (/^(Read|NotebookRead|read_file|view_image)$/i.test(n)) return 'read'
  if (/^(Write|write_file)$/i.test(n)) return 'write'
  if (/^(Edit|MultiEdit|NotebookEdit|apply_patch|str_replace_editor)$/i.test(n)) return 'edit'
  if (/^(Grep|Glob|LS|ToolSearch|grep_files|list_dir)$/i.test(n)) return 'search'
  if (/^(Task|Agent|spawn_agent)$/i.test(n)) return 'task'
  if (/^(TodoWrite|update_plan|todo|TaskCreate|TaskUpdate)$/i.test(n) || /update_plan$/.test(n)) return 'todo'
  if (/^(WebSearch|WebFetch|web_search|web_fetch)$/i.test(n)) return 'web'
  if (/^AskUserQuestion$/i.test(n)) return 'question'
  if (/^(ExitPlanMode|EnterPlanMode)$/i.test(n)) return 'plan'
  if (/^Skill$/i.test(n)) return 'skill'
  switch (t.cat) {
    case 'Bash': return 'bash'
    case 'Read': return 'read'
    case 'Write': return 'write'
    case 'Edit': return 'edit'
    case 'Grep': case 'Glob': return 'search'
    case 'Task': return 'task'
  }
  return 'other'
}

export function prettyToolName(n: string): string {
  const m = n.match(/^mcp__(.+?)__(.+)$/)
  if (m) return `${m[1].replace(/^[0-9a-f-]{20,}$/i, '连接器').replace(/_/g, ' ')} · ${m[2].replace(/_/g, ' ')}`
  return n
}

export function toolView(t: Tool): ToolView {
  const obj = parseInput(t)
  const kind = kindOf(t)
  switch (kind) {
    case 'bash': {
      const desc = field(t, obj, 'description')
      return { kind, label: '运行命令', summary: desc || firstLine(commandOf(t, obj)) }
    }
    case 'read':
      return { kind, label: '读取', summary: base(field(t, obj, 'file_path', 'path', 'notebook_path')) }
    case 'write':
      return { kind, label: '写入', summary: base(field(t, obj, 'file_path', 'path')) }
    case 'edit': {
      let p = field(t, obj, 'file_path', 'path', 'notebook_path')
      if (!p && Array.isArray(obj?.changes)) p = obj.changes.map((c: any) => c.path).filter(Boolean).join('、')
      if (!p) {
        const m = (t.input || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)
        if (m) p = m[1]
      }
      return { kind, label: '编辑', summary: base(p) }
    }
    case 'search':
      return { kind, label: '搜索', summary: firstLine(field(t, obj, 'pattern', 'query', 'path'), 90) }
    case 'task':
      return { kind, label: '子任务', summary: firstLine(field(t, obj, 'description', 'prompt'), 90) }
    case 'todo':
      return { kind, label: '更新待办', summary: '' }
    case 'web':
      return { kind, label: '联网', summary: firstLine(field(t, obj, 'query', 'url'), 90) }
    case 'question':
      return { kind, label: '向你提问', summary: firstLine(obj?.questions?.[0]?.question || '', 90) }
    case 'plan':
      return { kind, label: /Enter/i.test(t.name) ? '进入计划模式' : '提交计划', summary: '' }
    case 'skill':
      return { kind, label: '使用技能', summary: field(t, obj, 'skill', 'command') }
    default:
      return { kind, label: prettyToolName(t.name), summary: firstLine(field(t, obj, 'description', 'query', 'prompt', 'path', 'url'), 80) }
  }
}

export const kindNames: Record<ToolKind, string> = {
  bash: '运行命令', read: '读取文件', write: '写入文件', edit: '编辑文件', search: '搜索', task: '子任务',
  todo: '待办', web: '联网', question: '提问', plan: '计划', skill: '技能', other: '其他工具',
}
