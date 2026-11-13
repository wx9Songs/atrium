// Renders a conversation: your messages as bubbles, the agent's prose as
// markdown, and its tool work folded into compact, expandable steps.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { api, Msg, Tool } from './api'
import { Icon, Spinner } from './icons'
import { highlight, renderMarkdown } from './md'
import { commandOf, field, kindNames, parseInput, ToolKind, toolView } from './tools'
import { clockTime, copyText, dayLabel, imeKey, ms } from './util'
import { t as tr } from './i18n'

/** What the reader can do with a message. Absent for read-only transcripts. */
export type TranscriptActions = {
  /** A run is in flight: the last turn is not finished yet. */
  busy: boolean
  /** Forking is possible at all (the machine is online and its runner can fork). */
  canFork: boolean
  /** Forks may end before a message in the middle (edit, retry, branch from a reply). */
  canCut: boolean
  /** Why forking is unavailable, shown when a disabled action is tapped. */
  why?: string
  onEdit: (m: Msg, text: string) => Promise<void>
  onRetry: (m: Msg) => Promise<void>
  /** Branch off after a reply: `next` is the user message the copy stops before (none = the end). */
  onBranch: (next?: Msg) => Promise<void>
}

type Step =
  | { type: 'tool'; tool: Tool; msg: Msg; index: number; key: string }
  | { type: 'thinking'; text: string; key: string }
  | { type: 'sys'; text: string; src?: string; key: string }

type Block =
  | { type: 'day'; label: string; key: string }
  | { type: 'user'; msg: Msg; key: string }
  | { type: 'text'; msg: Msg; key: string }
  | { type: 'steps'; steps: Step[]; key: string; live: boolean; old?: boolean }
  /** Where turns replaced by a rewritten message are folded away. */
  | { type: 'fold'; key: string; n: number; open: boolean }
  | { type: 'compact'; key: string }
  | { type: 'error'; text: string; key: string }
  | { type: 'inherit'; key: string }
  | { type: 'foot'; key: string; user?: Msg; next?: Msg; last: Msg; text: string; isLast: boolean }

const keyOf = (m: Msg) => m.key || `a${m.ord}`

function buildBlocks(msgs: Msg[]): Block[] {
  const out: Block[] = []
  let steps: Step[] = []
  let stepsLive = false
  let lastDay = ''
  let old = false // inside a stretch that a rewritten message replaced
  const flush = () => {
    if (steps.length) out.push({ type: 'steps', steps, key: 'g' + steps[0].key, live: stepsLive, old })
    steps = []
    stepsLive = false
  }
  let wasInherited = false
  for (const m of msgs) {
    if (!!m.dropped !== old) {
      flush()
      old = !!m.dropped
    }
    if (m.fold) {
      flush()
      out.push({ type: 'fold', key: keyOf(m), n: m.fold.n, open: m.fold.open })
      continue
    }
    if (wasInherited && !m.inherited) {
      flush()
      out.push({ type: 'inherit', key: 'i' + keyOf(m) })
    }
    wasInherited = !!m.inherited
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
  return withFooters(out)
}

/** After each finished turn, a row of actions: copy the reply, try again, branch off. */
function withFooters(blocks: Block[]): Block[] {
  const out: Block[] = []
  let user: Msg | undefined
  let texts: Msg[] = []
  const close = (next?: Msg) => {
    if (texts.length) {
      const last = texts[texts.length - 1]
      out.push({ type: 'foot', key: 'f' + keyOf(last), user, next, last, text: texts.map((m) => m.text.trim()).join('\n\n'), isLast: !next })
    }
    texts = []
  }
  blocks.forEach((b, i) => {
    if (b.type === 'user') {
      close(b.msg)
      user = b.msg
    } else if (b.type === 'inherit' || b.type === 'fold') {
      // The footer of the turn before it belongs above the mark.
      const nextUser = blocks.slice(i + 1).find((x) => x.type === 'user') as Extract<Block, { type: 'user' }> | undefined
      close(nextUser?.msg)
    } else if (b.type === 'text') {
      texts.push(b.msg)
    }
    out.push(b)
  })
  close()
  return out
}

// ---------- small action buttons ----------

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="act"
      title={label || tr('复制', 'Copy')}
      onClick={() => {
        copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1300)
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
    </button>
  )
}

function ActButton({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: () => Promise<void> | void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={'act' + (disabled ? ' off' : '')}
      title={title}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await onClick()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Spinner size={12} /> : <Icon name={icon} size={14} />}
    </button>
  )
}

// ---------- user message ----------

export function cleanUserText(s: string) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<\/?command-(message|args)>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim()
}

const UserBubble = memo(function UserBubble({ msg, actions }: { msg: Msg; actions?: TranscriptActions }) {
  const text = useMemo(() => cleanUserText(msg.text), [msg.text])
  const long = text.length > 1400 || text.split('\n').length > 16
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  if (!text) return null
  if (editing && actions) {
    return (
      <div className="row-user editing">
        <EditBox
          initial={text}
          onCancel={() => setEditing(false)}
          onSend={async (v) => {
            await actions.onEdit(msg, v)
            setEditing(false)
          }}
        />
      </div>
    )
  }
  return (
    <div className="row-user">
      <div className={'bubble' + (long && !open ? ' clamp' : '')}>
        {text}
        {long && (
          <button className="linkbtn more" onClick={() => setOpen(!open)}>
            {open ? tr('收起', 'Show less') : tr('展开全部', 'Show all')}
          </button>
        )}
      </div>
      <div className="acts">
        {msg.ts && <span className="act-time">{clockTime(ms(msg.ts))}</span>}
        <CopyButton text={text} />
        {actions?.canCut && !(msg.inherited && msg.ord < 0) && (
          <button className="act" title={tr('编辑这条消息，会话从这里重新继续（之后的内容会被替换）', 'Edit this message: the session continues from here, and what followed is replaced')} onClick={() => setEditing(true)}>
            <Icon name="edit" size={14} />
          </button>
        )}
      </div>
    </div>
  )
})

function EditBox({ initial, onCancel, onSend }: { initial: string; onCancel: () => void; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.5) + 'px'
  }, [text])
  useEffect(() => {
    const el = ta.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])
  const send = async () => {
    const v = text.trim()
    if (!v || busy) return
    setBusy(true)
    setErr('')
    try {
      await onSend(v)
    } catch (e: any) {
      setErr(e.message || tr('发送失败', 'Could not send'))
      setBusy(false)
    }
  }
  return (
    <div className="editbox">
      <textarea
        ref={ta}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          else if (e.key === 'Enter' && !e.shiftKey && !imeKey(e)) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="editbox-bar">
        <span className={'editbox-note' + (err ? ' err' : '')}>
          {err || <><Icon name="branch" size={13} />{tr('会从这里开出一个新分支，原来的对话原样保留', 'This starts a new branch from here. The original stays as it is')}</>}
        </span>
        <button className="btn sm" onClick={onCancel} disabled={busy}>{tr('取消', 'Cancel')}</button>
        <button className="btn sm primary" onClick={send} disabled={busy || !text.trim()}>{busy ? <Spinner size={12} /> : tr('发送', 'Send')}</button>
      </div>
    </div>
  )
}

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

export function Transcript({ msgs, sessionId, focusOrd, actions, inheritLabel, onFold }: {
  msgs: Msg[]; sessionId?: string; focusOrd?: number; actions?: TranscriptActions; inheritLabel?: string
  /** Show or hide the turns folded under a "rewritten here" mark. */
  onFold?: (key: string) => void
}) {
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
              <div key={b.key} data-ord={b.msg.ord} className={(b.msg.inherited ? 'inherited ' : '') + (b.msg.dropped ? 'replaced ' : '') + (focusOrd !== undefined && b.msg.ord === focusOrd ? 'focus' : '')}>
                <UserBubble msg={b.msg} actions={b.msg.dropped ? undefined : actions} />
              </div>
            )
          case 'text':
            return (
              <div key={b.key} data-ord={b.msg.ord} className={'row-assistant' + (b.msg.dropped ? ' replaced' : '') + (focusOrd !== undefined && b.msg.ord === focusOrd ? ' focus' : '')}>
                <AssistantText msg={b.msg} />
              </div>
            )
          case 'steps':
            return b.old
              ? <div key={b.key} className="replaced"><StepGroup steps={b.steps} live={false} sessionId={sessionId} /></div>
              : <StepGroup key={b.key} steps={b.steps} live={b.live} sessionId={sessionId} />
          case 'fold':
            return (
              <div key={b.key} className={'foldmark' + (b.open ? ' open' : '')}>
                <button className="linkbtn" onClick={() => onFold?.(b.key)}>
                  <Icon name="edit" size={13} />
                  {b.open
                    ? tr('以下是改写前的内容，已不属于这个会话 · 收起', 'Below is what was replaced, no longer part of this session · Hide')
                    : tr(`这里改写过 · 查看被替换的 ${b.n} 轮对话`, b.n === 1 ? 'Rewritten here · show the turn it replaced' : `Rewritten here · show the ${b.n} turns it replaced`)}
                </button>
              </div>
            )
          case 'compact':
            return <div key={b.key} className="daysep compact"><span>{tr('更早的内容已被压缩成摘要', 'Earlier messages were compacted into a summary')}</span></div>
          case 'inherit':
            return (
              <div key={b.key} className="forkmark">
                <span><Icon name="branch" size={13} />{inheritLabel || tr('以上是分叉前的内容', 'Everything above is from before the fork')}</span>
              </div>
            )
          case 'foot': {
            if (b.isLast && actions?.busy) return null
            const why = actions?.why || ''
            // Borrowed from the parent while the archive catches up: readable, but not yet this session's to fork.
            const borrowed = (b.last.inherited && b.last.ord < 0) || b.last.dropped
            if (borrowed) {
              return (
                <div key={b.key} className={'acts turn' + (b.last.dropped ? ' replaced' : '')}>
                  <CopyButton text={b.text} label={tr('复制回复', 'Copy reply')} />
                  <span className="act-time">{[shortModel(b.last.model), b.last.ts ? clockTime(ms(b.last.ts)) : ''].filter(Boolean).join(' · ')}</span>
                </div>
              )
            }
            return (
              <div key={b.key} className={'acts turn' + (b.isLast ? ' last' : '')}>
                <CopyButton text={b.text} label={tr('复制回复', 'Copy reply')} />
                {actions && b.isLast && b.user && !(b.user.inherited && b.user.ord < 0) && (actions.canCut || why) && (
                  <ActButton icon="retry" disabled={!actions.canCut} title={actions.canCut ? tr('重新生成：把这条消息再发一次，替换这条回复', 'Try again: send the same message again and replace this reply') : why} onClick={() => actions.onRetry(b.user!)} />
                )}
                {actions && (actions.canFork || why) && (b.isLast || actions.canCut) && (
                  <ActButton icon="branch" disabled={!actions.canFork} title={actions.canFork ? tr('从这里分叉出一个新会话', 'Branch off into a new session from here') : why} onClick={() => actions.onBranch(b.next)} />
                )}
                <span className="act-time">{[shortModel(b.last.model), b.last.ts ? clockTime(ms(b.last.ts)) : ''].filter(Boolean).join(' · ')}</span>
              </div>
            )
          }
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

/** "claude-opus-5-5-20260101" → "opus-5-5": enough to tell models apart at a glance. */
function shortModel(m?: string) {
  if (!m || m.startsWith('<')) return ''
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
