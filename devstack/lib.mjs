// Shared helpers for the local development stand-ins (mock archive, fake agents).
// Everything lives under devstack/data, which is disposable.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const DEV = path.dirname(fileURLToPath(import.meta.url))
export const DATA = path.join(DEV, 'data')
export const SESS = path.join(DATA, 'sessions') // mock archive: one JSON per session
export const CLAUDE_HOME = path.join(DATA, 'claude-home')
export const CODEX_HOME = path.join(DATA, 'codex-home')
export const MACHINE = 'dev'

export const uuid = () => crypto.randomUUID()
export const iso = (t) => new Date(t).toISOString()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')

export function readJSON(p, def) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return def
  }
}

export function writeJSON(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(v))
  fs.renameSync(tmp, p)
}

const fileOf = (id) => path.join(SESS, encodeURIComponent(id) + '.json')
export const loadSession = (id) => readJSON(fileOf(id), null)
export const saveSession = (s) => writeJSON(fileOf(s.id), s)
export function allSessions() {
  if (!fs.existsSync(SESS)) return []
  return fs.readdirSync(SESS).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(SESS, f), null)).filter(Boolean)
}

// ---------- Claude transcripts (the subset the runner and the fake agent read) ----------

export function claudeFile(id, cwd) {
  if (cwd) return path.join(CLAUDE_HOME, 'projects', slug(cwd), id + '.jsonl')
  const root = path.join(CLAUDE_HOME, 'projects')
  if (!fs.existsSync(root)) return ''
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, id + '.jsonl')
    if (fs.existsSync(f)) return f
  }
  return ''
}

export function readLines(file) {
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** Transcript lines → the archive's message shape (what agentsview would index). */
export function linesToArchive(lines) {
  const msgs = []
  const tools = new Map()
  for (const l of lines) {
    const c = l.message?.content
    if (l.type === 'user') {
      if (typeof c === 'string') {
        msgs.push({ ordinal: msgs.length, role: 'user', content: c, timestamp: l.timestamp })
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result' && tools.has(b.tool_use_id)) {
            const t = tools.get(b.tool_use_id)
            t.result_content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
            t.result_content_length = t.result_content.length
            if (b.is_error) t.result_events = [{ status: 'error', content: '' }]
          }
        }
      }
    } else if (l.type === 'assistant' && Array.isArray(c)) {
      const m = { ordinal: msgs.length, role: 'assistant', content: '', thinking_text: '', timestamp: l.timestamp, model: l.message.model, tool_calls: [] }
      for (const b of c) {
        if (b.type === 'text') m.content += b.text
        else if (b.type === 'thinking') m.thinking_text += b.thinking
        else if (b.type === 'tool_use') {
          const t = { tool_name: b.name, category: b.name, tool_use_id: b.id, input_json: JSON.stringify(b.input), result_content: '', result_content_length: 0 }
          m.tool_calls.push(t)
          tools.set(b.id, t)
        }
      }
      m.has_tool_use = m.tool_calls.length > 0
      msgs.push(m)
    } else if (l.type === 'system' && l.subtype === 'compact_boundary') {
      msgs.push({ ordinal: msgs.length, role: 'system', content: '', timestamp: l.timestamp, is_system: true, is_compact_boundary: true })
    }
  }
  return msgs
}

/** Publish a Claude transcript into the mock archive (stands in for rsync + indexing). */
export function publishClaude(id, cwd, extra = {}) {
  const lines = readLines(claudeFile(id, cwd))
  const messages = linesToArchive(lines)
  const users = messages.filter((m) => m.role === 'user')
  const prev = loadSession(id) || {}
  saveSession({
    id, machine: MACHINE, agent: 'claude', entrypoint: 'cli', cwd,
    first_message: users[0]?.content || '', display_name: prev.display_name || '',
    started_at: messages[0]?.timestamp, ended_at: messages[messages.length - 1]?.timestamp,
    message_count: messages.length, user_message_count: users.length, git_branch: 'main',
    ...extra, messages,
  })
}
