// Converts the raw events of a live run (Claude stream-json or Codex exec
// JSON) into the same message shape the archive uses, so both render alike.
import { Msg, Run, RunEvent, Tool } from './api'
import { t } from './i18n'

function textOf(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : p?.type === 'image' ? t('[图片]', '[image]') : ''))
      .join('')
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

type CodexRec = { msg: Msg; tool?: Tool }

function applyCodexItem(rec: CodexRec, it: any, done: boolean) {
  const m = rec.msg
  const tool = (name: string, cat: string | undefined, inputObj: any): Tool => {
    if (!rec.tool) rec.tool = { name, cat, input: '', inputObj }
    rec.tool.inputObj = inputObj
    rec.tool.running = !done
    m.tools = [rec.tool]
    return rec.tool
  }
  switch (it.type) {
    case 'agent_message':
      m.text = it.text || ''
      break
    case 'reasoning':
      m.thinking = it.text || ''
      break
    case 'command_execution': {
      const t = tool('exec', 'Bash', { command: it.command })
      t.result = it.aggregated_output || ''
      t.resultLen = t.result!.length
      if (done) t.status = it.exit_code != null && it.exit_code !== 0 ? 'error' : 'ok'
      break
    }
    case 'file_change': {
      const t = tool('apply_patch', 'Edit', { changes: it.changes })
      if (done) t.status = it.status === 'failed' ? 'error' : 'ok'
      break
    }
    case 'mcp_tool_call': {
      const t = tool(`mcp__${it.server}__${it.tool}`, 'Tool', it.arguments ?? {})
      t.result = it.error?.message || textOf(it.result?.content)
      t.resultLen = (t.result || '').length
      if (done) t.status = it.status === 'failed' ? 'error' : 'ok'
      break
    }
    case 'web_search':
      tool('web_search', 'Tool', { query: it.query })
      break
    case 'todo_list':
      tool('todo', 'Tool', { todos: (it.items || []).map((x: any) => ({ content: x.text, status: x.completed ? 'completed' : 'pending' })) })
      break
    case 'error':
      m.role = 'system'
      m.error = true
      m.text = it.message || t('出错了', 'Failed')
      break
    default:
      tool(String(it.type || 'tool'), 'Tool', it)
  }
}

export function runToMsgs(run: Run, events: RunEvent[]): Msg[] {
  const out: Msg[] = []
  let n = 0
  const key = () => `${run.id}:${n++}`
  out.push({ ord: -1, role: 'user', text: run.prompt, ts: new Date(run.created).toISOString(), key: key(), live: true })

  const tools = new Map<string, Tool>()
  const codex = new Map<string, CodexRec>()
  let lastId = ''
  let lastMsg: Msg | null = null

  for (const e of events) {
    if (e.t !== 'agent' || !e.data) continue
    const d = e.data
    const ts = new Date(e.ts).toISOString()

    if (run.agent === 'claude') {
      if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
        let text = ''
        let thinking = ''
        const tl: Tool[] = []
        for (const b of d.message.content) {
          if (b.type === 'text') text += b.text || ''
          else if (b.type === 'thinking') thinking += b.thinking || ''
          else if (b.type === 'tool_use') {
            const t: Tool = { id: b.id, name: b.name, input: '', inputObj: b.input, running: true }
            tl.push(t)
            tools.set(b.id, t)
          }
        }
        if (!text && !thinking && !tl.length) continue
        // One API message arrives as several events (thinking, text, tool use): merge them.
        if (lastMsg && d.message.id && d.message.id === lastId && out[out.length - 1] === lastMsg) {
          if (text) lastMsg.text = lastMsg.text ? lastMsg.text + '\n\n' + text : text
          if (thinking) lastMsg.thinking = (lastMsg.thinking || '') + thinking
          if (tl.length) lastMsg.tools = [...(lastMsg.tools || []), ...tl]
        } else {
          lastMsg = { ord: -1, role: 'assistant', text, thinking: thinking || undefined, tools: tl.length ? tl : undefined, ts, model: d.message.model, key: key(), live: true }
          lastId = d.message.id || ''
          out.push(lastMsg)
        }
      } else if (d.type === 'user' && Array.isArray(d.message?.content)) {
        for (const b of d.message.content) {
          if (b.type !== 'tool_result') continue
          const t = tools.get(b.tool_use_id)
          if (!t) continue
          t.result = textOf(b.content)
          t.resultLen = t.result.length
          t.running = false
          t.status = b.is_error ? 'error' : 'ok'
        }
      } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
        out.push({ ord: -1, role: 'system', text: '', compact: true, key: key(), live: true, ts })
      }
    } else {
      const it = d.item
      if ((d.type === 'item.started' || d.type === 'item.updated' || d.type === 'item.completed') && it?.id) {
        let rec = codex.get(it.id)
        if (!rec) {
          rec = { msg: { ord: -1, role: 'assistant', text: '', ts, key: key(), live: true } }
          codex.set(it.id, rec)
          out.push(rec.msg)
        }
        applyCodexItem(rec, it, d.type === 'item.completed')
      }
    }
  }

  // Nothing is still running once the run itself has ended.
  if (['done', 'error', 'stopped', 'lost'].includes(run.status)) {
    for (const m of out) for (const t of m.tools || []) t.running = false
  }
  return out
}
