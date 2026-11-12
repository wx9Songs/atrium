// Renders a conversation: your messages as bubbles, the agent's prose as
// markdown, and its tool work folded into compact, expandable steps.
import { memo, useMemo, useState } from 'react'
import { api, Msg, Tool } from './api'
import { Icon, Spinner } from './icons'
import { highlight, renderMarkdown } from './md'
import { commandOf, field, kindNames, parseInput, ToolKind, toolView } from './tools'
import { clockTime, copyText, dayLabel, ms } from './util'
import { t as tr } from './i18n'

type Step =
  | { type: 'tool'; tool: Tool; msg: Msg; index: number; key: string }
  | { type: 'thinking'; text: string; key: string }
  | { type: 'sys'; text: string; src?: string; key: string }

type Block =
  | { type: 'day'; label: string; key: string }
  | { type: 'user'; msg: Msg; key: string }
  | { type: 'text'; msg: Msg; key: string }
  | { type: 'steps'; steps: Step[]; key: string; live: boolean }
  | { type: 'compact'; key: string }
  | { type: 'error'; text: string; key: string }

const keyOf = (m: Msg) => m.key || `a${m.ord}`

function buildBlocks(msgs: Msg[]): Block[] {
  const out: Block[] = []
  let steps: Step[] = []
  let stepsLive = false
  let lastDay = ''
  const flush = () => {
    if (steps.length) out.push({ type: 'steps', steps, key: 'g' + steps[0].key, live: stepsLive })
    steps = []
    stepsLive = false
  }
  for (const m of msgs) {
    const t = ms(m.ts)
    if (t) {
      const d = new Date(t)
      const dk = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      if (dk !== lastDay) {
        flush()
        lastDay = dk
        out.push({ type: 'day', label: dayLabel(t), key: 'd' + dk + keyOf(m) })
      }
    }
    const k = keyOf(m)
    if (m.compact) {
      flush()
      out.push({ type: 'compact', key: 'c' + k })
      continue
    }
    if (m.error) {
      flush()
      out.push({ type: 'error', text: m.text, key: 'e' + k })
      continue
    }
    if (m.sys || m.role === 'system') {
      if (m.text) {
        steps.push({ type: 'sys', text: m.text, src: m.src, key: 's' + k })
        if (m.live) stepsLive = true
      }
      continue
    }
    if (m.role === 'user') {
      flush()
      if (m.text.trim()) out.push({ type: 'user', msg: m, key: 'u' + k })
      continue
    }
    if (m.thinking) {
      steps.push({ type: 'thinking', text: m.thinking, key: 'h' + k })
      if (m.live) stepsLive = true
    }
    if (m.text.trim()) {
      flush()
      out.push({ type: 'text', msg: m, key: 't' + k })
    }
    ;(m.tools || []).forEach((tool, i) => {
      steps.push({ type: 'tool', tool, msg: m, index: i, key: `x${k}.${i}` })
      if (m.live) stepsLive = true
    })
  }
  flush()
  return out
}

// ---------- user message ----------

function cleanUserText(s: string) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<\/?command-(message|args)>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim()
}

const UserBubble = memo(function UserBubble({ msg }: { msg: Msg }) {
  const text = useMemo(() => cleanUserText(msg.text), [msg.text])
  const long = text.length > 1400 || text.split('\n').length > 16
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="row-user">
      <div className={'bubble' + (long && !open ? ' clamp' : '')} title={msg.ts ? clockTime(ms(msg.ts)) : undefined}>
        {text}
        {long && (
          <button className="linkbtn more" onClick={() => setOpen(!open)}>
            {open ? tr('收起', 'Show less') : tr('展开全部', 'Show all')}
          </button>
        )}
      </div>
    </div>
  )
})

// ---------- assistant prose ----------

const AssistantText = memo(function AssistantText({ msg }: { msg: Msg }) {
  const html = useMemo(() => renderMarkdown(msg.text), [msg.text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

// ---------- steps (tool calls, thinking, system notes) ----------

const kindIcon: Record<ToolKind, string> = {
  bash: 'terminal', read: 'file', write: 'file', edit: 'edit', search: 'search', task: 'sub',
  todo: 'todo', web: 'globe', question: 'question', plan: 'list', skill: 'spark', other: 'layers',
}

function Pre({ text, lang, className }: { text: string; lang?: string; className?: string }) {
  const html = useMemo(() => (lang ? highlight(text, lang) : null), [text, lang])
  return html !== null ? (
    <pre className={'pre ' + (className || '')}>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  ) : (
    <pre className={'pre ' + (className || '')}>{text}</pre>
  )
}

function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="diff">
      {oldText !== '' && oldText.split('\n').map((l, i) => <div key={'o' + i} className="del">{'- ' + l}</div>)}
      {newText !== '' && newText.split('\n').map((l, i) => <div key={'n' + i} className="add">{'+ ' + l}</div>)}
    </div>
  )
}

function Todos({ items }: { items: any[] }) {
  return (
    <ul className="todos">
      {items.map((x, i) => {
        const st = x.status || (x.completed ? 'completed' : 'pending')
        return (
          <li key={i} className={st}>
            <span className="box">{st === 'completed' ? <Icon name="check" size={12} /> : st === 'in_progress' ? <span className="dot" /> : null}</span>
            {x.content || x.step || x.text || x.subject || ''}
          </li>
        )
      })}
    </ul>
  )
}

function ToolDetail({ step, sessionId }: { step: Extract<Step, { type: 'tool' }>; sessionId?: string }) {
  const [full, setFull] = useState<Tool | null>(null)
  const [loading, setLoading] = useState(false)
  const t = full || step.tool
  const obj = parseInput(t)
  const view = toolView(t)
  const canLoad =
    !full && !step.msg.live && !!sessionId &&
    ((t.resultLen || 0) > (t.result || '').length || (t.inputLen || 0) > (t.input || '').length)
  const load = async () => {
    setLoading(true)
    try {
      setFull(await api.tool(sessionId!, step.msg.ord, step.index))
    } catch {
      /* keep the short version */
    } finally {
      setLoading(false)
    }
  }
  const result = t.result || ''
  const out = result ? <Pre text={result} className="out" /> : null
  let body: JSX.Element
  switch (view.kind) {
    case 'bash':
      body = (
        <>
          <Pre text={commandOf(t, obj)} lang="bash" className="cmd" />
          {out}
        </>
      )
      break
    case 'edit': {
      const path = field(t, obj, 'file_path', 'path', 'notebook_path')
      const edits: any[] = Array.isArray(obj?.edits) ? obj.edits : obj && obj.old_string !== undefined ? [obj] : []
      body = (
        <>
          {path && <div className="pathline">{path}</div>}
          {edits.length > 0 ? (
            edits.map((e, i) => <DiffBlock key={i} oldText={String(e.old_string ?? '')} newText={String(e.new_string ?? '')} />)
          ) : Array.isArray(obj?.changes) ? (
            <ul className="plain">{obj.changes.map((c: any, i: number) => <li key={i}>{c.kind || tr('修改', 'change')} {c.path}</li>)}</ul>
          ) : (
            <Pre text={typeof obj?.patch === 'string' ? obj.patch : typeof obj?.input === 'string' ? obj.input : t.input} lang="diff" />
          )}
          {out}
        </>
      )
      break
    }
    case 'write':
      body = (
        <>
          <div className="pathline">{field(t, obj, 'file_path', 'path')}</div>
          <Pre text={String(obj?.content ?? field(t, obj, 'content') ?? '')} className="out" />
          {out}
        </>
      )
      break
    case 'read':
      body = (
        <>
          <div className="pathline">{field(t, obj, 'file_path', 'path', 'notebook_path')}</div>
          {out}
        </>
      )
      break
    case 'todo': {
      const items = obj?.todos || obj?.plan || obj?.items
      body = Array.isArray(items) ? <Todos items={items} /> : <Pre text={t.input} />
      break
    }
    case 'question': {
      const qs: any[] = Array.isArray(obj?.questions) ? obj.questions : []
      body = (
        <>
          {qs.map((q, i) => (
            <div key={i} className="qa">
              <div className="q">{q.question}</div>
              <ul className="plain">{(q.options || []).map((o: any, j: number) => <li key={j}>{o.label}</li>)}</ul>
            </div>
          ))}
          {out}
        </>
      )
      break
    }
    case 'task':
      body = (
        <>
          <div className="prose-plain">{field(t, obj, 'prompt', 'description')}</div>
          {out}
        </>
      )
      break
    default: {
      let input = t.input
      if (obj !== null && obj !== undefined) {
        try {
          input = JSON.stringify(obj, null, 2)
        } catch {
          /* keep raw */
        }
      }
      body = (
        <>
          {input && input !== '{}' && <Pre text={input} lang="json" className="cmd" />}
          {out}
        </>
      )
    }
  }
  return (
    <div className="step-detail">
      {body}
      {canLoad && (
        <button className="linkbtn" onClick={load} disabled={loading}>
          {loading ? tr('加载中…', 'Loading…') : tr(`显示完整内容（约 ${Math.max(1, Math.round(((t.resultLen || 0) + (t.inputLen || 0)) / 1024))} KB）`, `Show everything (about ${Math.max(1, Math.round(((t.resultLen || 0) + (t.inputLen || 0)) / 1024))} KB)`)}
        </button>
      )}
    </div>
  )
}

function StepRow({ step, sessionId }: { step: Step; sessionId?: string }) {
  const [open, setOpen] = useState(false)
  if (step.type === 'thinking' || step.type === 'sys') {
    const isThink = step.type === 'thinking'
    return (
      <div className={'step' + (open ? ' open' : '')}>
        <button className="step-head" onClick={() => setOpen(!open)}>
          <Icon name={isThink ? 'brain' : 'alert'} size={14} className="kind" />
          <span className="lbl">{isThink ? tr('思考过程', 'Thinking') : tr('系统通知', 'System note')}</span>
          <span className="sum">{isThink ? '' : step.text.replace(/<[^>]+>/g, ' ').trim().slice(0, 80)}</span>
          <Icon name={open ? 'down' : 'right'} size={13} className="chev" />
        </button>
        {open && <div className="step-detail"><div className="prose-plain">{step.text}</div></div>}
      </div>
    )
  }
  const v = toolView(step.tool)
  const t = step.tool
  const failed = t.status === 'error' || t.status === 'failed'
  return (
    <div className={'step' + (open ? ' open' : '') + (failed ? ' failed' : '')}>
      <button className="step-head" onClick={() => setOpen(!open)}>
        <Icon name={kindIcon[v.kind]} size={14} className="kind" />
        <span className="lbl">{v.label}</span>
        <span className={'sum' + (v.kind === 'bash' || v.kind === 'read' || v.kind === 'edit' || v.kind === 'write' ? ' mono' : '')}>{v.summary}</span>
        {t.running ? <Spinner size={12} /> : failed ? <Icon name="x" size={13} className="bad" /> : null}
        <Icon name={open ? 'down' : 'right'} size={13} className="chev" />
      </button>
      {open && <ToolDetail step={step} sessionId={sessionId} />}
    </div>
  )
}

function summarize(steps: Step[]): string {
  const counts = new Map<string, number>()
  for (const s of steps) {
    const name = s.type === 'tool' ? kindNames[toolView(s.tool).kind] : s.type === 'thinking' ? tr('思考', 'thinking') : tr('系统通知', 'system notes')
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ')
}

const StepGroup = memo(function StepGroup({ steps, live, sessionId }: { steps: Step[]; live: boolean; sessionId?: string }) {
  const collapsible = steps.length > 3 && !live
  const [open, setOpen] = useState(false)
  const running = steps.some((s) => s.type === 'tool' && s.tool.running)
  if (collapsible && !open) {
    return (
      <div className="steps">
        <button className="steps-head" onClick={() => setOpen(true)}>
          <Icon name="layers" size={14} className="kind" />
          <span className="lbl">{tr(`${steps.length} 个步骤`, `${steps.length} steps`)}</span>
          <span className="sum">{summarize(steps)}</span>
          <Icon name="right" size={13} className="chev" />
        </button>
      </div>
    )
  }
  // While live, keep long groups short: show the latest few and fold the rest.
  const shown = live && steps.length > 6 && !open ? steps.slice(-5) : steps
  const hidden = steps.length - shown.length
  return (
    <div className={'steps' + (running ? ' running' : '')}>
      {collapsible && (
        <button className="steps-head" onClick={() => setOpen(false)}>
          <Icon name="layers" size={14} className="kind" />
          <span className="lbl">{tr(`${steps.length} 个步骤`, `${steps.length} steps`)}</span>
          <span className="sum">{summarize(steps)}</span>
          <Icon name="down" size={13} className="chev" />
        </button>
      )}
      {hidden > 0 && (
        <button className="steps-head" onClick={() => setOpen(true)}>
          <Icon name="layers" size={14} className="kind" />
          <span className="lbl">{tr(`前面还有 ${hidden} 个步骤`, `${hidden} earlier steps`)}</span>
          <span className="sum" />
          <Icon name="right" size={13} className="chev" />
        </button>
      )}
      {shown.map((s) => <StepRow key={s.key} step={s} sessionId={sessionId} />)}
    </div>
  )
})

// ---------- transcript ----------

export function Transcript({ msgs, sessionId, focusOrd }: { msgs: Msg[]; sessionId?: string; focusOrd?: number }) {
  const blocks = useMemo(() => buildBlocks(msgs), [msgs])
  const onClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null
    if (!btn) return
    const code = btn.closest('.codeblock')?.querySelector('code')
    if (code) {
      copyText(code.textContent || '')
      const old = btn.textContent
      btn.textContent = tr('已复制', 'Copied')
      setTimeout(() => (btn.textContent = old), 1200)
    }
  }
  return (
    <div className="transcript" onClick={onClick}>
      {blocks.map((b) => {
        switch (b.type) {
          case 'day':
            return <div key={b.key} className="daysep"><span>{b.label}</span></div>
          case 'user':
            return (
              <div key={b.key} data-ord={b.msg.ord} className={focusOrd !== undefined && b.msg.ord === focusOrd ? 'focus' : undefined}>
                <UserBubble msg={b.msg} />
              </div>
            )
          case 'text':
            return (
              <div key={b.key} data-ord={b.msg.ord} className={'row-assistant' + (focusOrd !== undefined && b.msg.ord === focusOrd ? ' focus' : '')}>
                <AssistantText msg={b.msg} />
              </div>
            )
          case 'steps':
            return <StepGroup key={b.key} steps={b.steps} live={b.live} sessionId={sessionId} />
          case 'compact':
            return <div key={b.key} className="daysep compact"><span>{tr('更早的内容已被压缩成摘要', 'Earlier messages were compacted into a summary')}</span></div>
          case 'error':
            return (
              <div key={b.key} className="note error">
                <Icon name="alert" size={15} />
                <span>{b.text}</span>
              </div>
            )
        }
      })}
    </div>
  )
}
