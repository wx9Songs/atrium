// The message box: text, attachments (pasted, dropped or picked), the "/"
// command menu, permission mode and model pickers, send / stop, and one queued
// message while a run is in flight.
import { CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, Machine, SlashCmd } from './api'
import { Icon, Spinner } from './icons'
import { setMachines } from './store'
import { Dropdown, MenuItem, MenuLabel, MenuSep, toast } from './ui'
import { hasFeature, imeKey, modeOptions, modelChoices } from './util'
import { t } from './i18n'
import { fileSize, MAX_ATTACH_COUNT, MAX_ATTACH_SIZE, pastedName, rememberPreview, withAttachments } from './attach'

/** A file waiting to go out with the message. `path` once it is saved on machine `on`. */
type Att = { id: number; file: File; name: string; url?: string; path?: string; on?: string }
let attSeq = 0

/** A command Atrium itself carries out (as opposed to one passed on to the agent). */
export type AppCommand = { name: string; description: string; run: (arg: string) => void; disabled?: string }

// Built-in agent commands that only make sense in the interactive terminal UI.
const INTERACTIVE_ONLY = new Set([
  'clear', 'config', 'model', 'mcp', 'agents', 'color', 'fast', 'effort', 'focus', 'heapdump', 'import', 'doctor', 'output-style',
  'usage', 'usage-credits', 'extra-usage', 'login', 'logout', 'exit', 'quit', 'help', 'resume', 'rename', 'theme', 'vim', 'ide',
  'terminal-setup', 'permissions', 'hooks', 'status', 'statusline', 'memory', 'add-dir', 'bug', 'feedback', 'release-notes',
  'reload-plugins', 'reload-skills', 'plugin', 'autocompact', 'auto-mode-setup', 'advisor', 'insights', 'list-agents',
  'design-consent', 'design-revoke', 'team-onboarding', 'workflow-launch-exec', 'goal', 'skill-doctor', 'export', 'rewind', 'btw',
])

const FALLBACK_AGENT_COMMANDS: SlashCmd[] = [
  { name: 'compact', description: t('压缩上下文，只保留摘要', 'Compact the conversation into a summary'), hint: t('[额外说明]', '[instructions]') },
  { name: 'context', description: t('查看上下文占用', 'Show what is using the context window') },
  { name: 'init', description: t('为这个项目生成 CLAUDE.md', 'Write a CLAUDE.md for this project') },
  { name: 'review', description: t('审查一个 Pull Request', 'Review a pull request'), hint: '[PR]' },
  { name: 'security-review', description: t('对当前分支的改动做安全审查', 'Security-review the pending changes') },
]

type Item = { key: string; name: string; description?: string; hint?: string; app?: AppCommand }

export function useRunPrefs(agent: string, machine?: Machine) {
  const modeKey = 'sh.mode.' + agent
  const modelKey = 'atrium.model.' + agent
  const effortKey = 'atrium.effort.' + agent
  const modes = modeOptions(agent)
  const { choices: models, reported } = modelChoices(machine, agent)
  const [mode, setModeS] = useState(() => {
    const v = localStorage.getItem(modeKey) || 'machine'
    return modes.some((o) => o.value === v) ? v : 'machine'
  })
  const [model, setModelS] = useState(() => localStorage.getItem(modelKey) || '')
  const [effortChoice, setEffortS] = useState(() => localStorage.getItem(effortKey) || '')
  useEffect(() => {
    const v = localStorage.getItem(modeKey) || 'machine'
    setModeS(modes.some((o) => o.value === v) ? v : 'machine')
    setModelS(localStorage.getItem(modelKey) || '')
    setEffortS(localStorage.getItem(effortKey) || '')
  }, [agent]) // eslint-disable-line react-hooks/exhaustive-deps
  // The effort levels on offer are those of the chosen model on this machine; a remembered level it lacks is not sent.
  const efforts = models.find((o) => o.value === model)?.efforts || []
  const effort = efforts.includes(effortChoice) ? effortChoice : ''
  return {
    mode, model, effort, modes, models, efforts, reported, machine,
    /** What to send with a run. */
    run: { mode, model: model || undefined, effort: effort || undefined },
    setMode: (v: string) => { setModeS(v); localStorage.setItem(modeKey, v) },
    setModel: (v: string) => { setModelS(v); if (v) localStorage.setItem(modelKey, v); else localStorage.removeItem(modelKey) },
    setEffort: (v: string) => { setEffortS(v); if (v) localStorage.setItem(effortKey, v); else localStorage.removeItem(effortKey) },
  }
}

export type RunPrefs = ReturnType<typeof useRunPrefs>

export function ModePicker({ prefs, up = true }: { prefs: RunPrefs; up?: boolean }) {
  const cur = prefs.modes.find((o) => o.value === prefs.mode)
  return (
    <Dropdown up={up} className={'pill' + (prefs.mode === 'full' ? ' warn' : '')} title={cur?.hint}
      button={<><Icon name="shield" size={14} /><span>{cur?.label}</span><Icon name="down" size={12} className="caret" /></>}>
      {(close) => (
        <>
          <MenuLabel>{t('权限', 'Permissions')}</MenuLabel>
          {prefs.modes.map((o) => (
            <MenuItem key={o.value} label={o.label} sub={o.hint} checked={o.value === prefs.mode} onClick={() => { prefs.setMode(o.value); close() }} />
          ))}
        </>
      )}
    </Dropdown>
  )
}

export function ModelPicker({ prefs, up = true, open, onOpenChange }: { prefs: RunPrefs; up?: boolean; open?: boolean; onOpenChange?: (v: boolean) => void }) {
  const [custom, setCustom] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const cur = prefs.models.find((o) => o.value === prefs.model)
  const label = cur ? cur.label : prefs.model
  const canRefresh = hasFeature(prefs.machine, 'effort') && !!prefs.machine?.online
  const refresh = async () => {
    if (!prefs.machine || refreshing) return
    setRefreshing(true)
    try {
      setMachines((await api.capsRefresh(prefs.machine.name)).machines)
    } catch (e: any) {
      toast(e.message || t('没有读到', 'Could not read it'))
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <>
    <Dropdown up={up} wide className="pill" open={open} onOpenChange={onOpenChange}
      button={<><Icon name="chip" size={14} /><span>{label}</span><Icon name="down" size={12} className="caret" /></>}>
      {(close) => (
        <>
          <div className="menu-label row">
            <span>{t('模型', 'Model')}{prefs.machine && <i> · {prefs.machine.label}</i>}</span>
            {canRefresh && <button type="button" className="linkbtn" onClick={refresh} disabled={refreshing}>{refreshing ? <Spinner size={11} /> : t('重新读取', 'Reload')}</button>}
          </div>
          <div className="menu-scroll">
            {prefs.models.map((o) => (
              <MenuItem key={o.value} label={o.label} sub={o.value === '' ? o.hint : undefined} hint={o.value && o.value !== o.label.toLowerCase() ? <span className="mono">{o.value}</span> : undefined}
                checked={o.value === prefs.model} onClick={() => prefs.setModel(o.value)} />
            ))}
            {!cur && prefs.model && <MenuItem label={<span className="mono">{prefs.model}</span>} sub={t('手动填写的模型名', 'A model name you typed')} checked onClick={() => {}} />}
          </div>
          {!prefs.reported && (
            <div className="menu-note">{prefs.machine?.runner ? t('这台机器还没有上报它的模型列表（runner 版本较旧），这里先给出常用的几个。', 'This machine has not reported its models yet (its runner is out of date), so these are the usual ones.') : t('选好机器后，这里会列出那台机器上可用的模型。', 'Once a machine is chosen, the models available there are listed here.')}</div>
          )}
          <form className="menu-form" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { prefs.setModel(custom.trim()); setCustom(''); close() } }}>
            <input className="input sm mono" value={custom} placeholder={t('或填写模型名…', 'Or type a model name…')} onChange={(e) => setCustom(e.target.value)} spellCheck={false} />
          </form>
        </>
      )}
    </Dropdown>
    {prefs.efforts.length > 0 && (
      <Dropdown up={up} wide className="pill" title={t('思考强度', 'Reasoning effort')}
        button={<><Icon name="think" size={14} /><span>{prefs.effort ? effortName(prefs.effort) : t('思考：默认', 'Effort: default')}</span><Icon name="down" size={12} className="caret" /></>}>
        {() => <EffortSlider levels={prefs.efforts} value={prefs.effort} onChange={prefs.setEffort} />}
      </Dropdown>
    )}
    </>
  )
}

const EFFORT_NAMES: Record<string, [string, string]> = {
  minimal: ['极低', 'Minimal'], low: ['低', 'Low'], medium: ['中', 'Medium'], high: ['高', 'High'],
  xhigh: ['很高', 'Extra high'], max: ['最高', 'Max'], ultra: ['极限', 'Ultra'],
}
const effortName = (e: string) => (e ? (EFFORT_NAMES[e] ? t(...EFFORT_NAMES[e]) : e) : t('默认', 'Default'))

/** The effort levels as stops on a slider; the first stop leaves it to the machine's own setting. */
function EffortSlider({ levels, value, onChange }: { levels: string[]; value: string; onChange: (v: string) => void }) {
  const stops = ['', ...levels]
  const at = Math.max(0, stops.indexOf(value))
  const last = stops.length - 1
  return (
    <div className="effort-box">
      <div className="effort-head">
        <Icon name="think" size={16} />
        <div className="effort-now">
          <b>{effortName(value)}</b>
          <span>{value ? t('思考强度', 'Reasoning effort') : t('用那台机器上的设置', 'Whatever that machine is set to')}</span>
        </div>
        <button type="button" className="iconbtn" title={t('恢复默认', 'Back to default')} disabled={!value} onClick={() => onChange('')}><Icon name="retry" size={15} /></button>
      </div>
      <div className="effort-slider" style={{ '--p': last ? at / last : 0 } as CSSProperties}>
        <div className="effort-fill" />
        {stops.map((e, i) => <i key={e} className={i <= at ? 'in' : ''} style={{ left: `calc(14px + (100% - 28px) * ${last ? i / last : 0})` }} />)}
        <div className="effort-thumb" />
        <input type="range" min={0} max={last} step={1} value={at} aria-label={t('思考强度', 'Reasoning effort')} aria-valuetext={effortName(value)}
          onChange={(e) => onChange(stops[+e.target.value] || '')} />
      </div>
      <div className="effort-ends"><span>{effortName('')}</span><span>{effortName(stops[last])}</span></div>
    </div>
  )
}

export function Composer({
  draftKey, placeholder, busy: running, blocked, prefs, machine, agent, appCommands = [], onSend, onStop, onShell, before, autoFocus, compact, focusSignal, menusDown,
}: {
  /** Drafts and the queued message are remembered under this key. */
  draftKey: string
  placeholder: string
  /** A run is in flight: Enter queues instead of sending, and the button stops it. */
  busy?: boolean
  /** When set, the box is replaced by this explanation (view-only sessions). */
  blocked?: string
  prefs: RunPrefs
  machine?: Machine
  agent: string
  appCommands?: AppCommand[]
  onSend: (text: string) => Promise<void>
  onStop?: () => void
  /** "!command": run it in the terminal instead of sending it to the agent. */
  onShell?: (cmd: string) => void
  before?: ReactNode
  autoFocus?: boolean
  compact?: boolean
  focusSignal?: number
  /** Open the mode and model menus downwards (the box sits high on the page). */
  menusDown?: boolean
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [queued, setQueued] = useState('')
  const [sel, setSel] = useState(0)
  const [menuOff, setMenuOff] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [files, setFiles] = useState<Att[]>([])
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setText(localStorage.getItem('sh.draft.' + draftKey) || '')
    setQueued(localStorage.getItem('atrium.queue.' + draftKey) || '')
    setErr('')
    setFiles([])
  }, [draftKey])
  useEffect(() => {
    if (text) localStorage.setItem('sh.draft.' + draftKey, text)
    else localStorage.removeItem('sh.draft.' + draftKey)
    const el = ta.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px'
    }
  }, [text, draftKey])
  useEffect(() => {
    if (queued) localStorage.setItem('atrium.queue.' + draftKey, queued)
    else localStorage.removeItem('atrium.queue.' + draftKey)
  }, [queued, draftKey])
  useEffect(() => {
    if (focusSignal) ta.current?.focus()
  }, [focusSignal])
  useEffect(() => {
    if (compact) return
    const on = (e: Event) => {
      if ((e as CustomEvent).detail !== 'slash') return
      ta.current?.focus()
      setText((cur) => cur || '/')
    }
    window.addEventListener('atrium:cmd', on)
    return () => window.removeEventListener('atrium:cmd', on)
  }, [compact])

  // ----- attachments
  const addFiles = (list: File[]) => {
    if (!list.length) return
    setErr('')
    setFiles((cur) => {
      const next = [...cur]
      for (const file of list) {
        if (next.length >= MAX_ATTACH_COUNT) {
          setErr(t(`一条消息最多带 ${MAX_ATTACH_COUNT} 个附件`, `A message takes ${MAX_ATTACH_COUNT} attachments at most`))
          break
        }
        if (file.size > MAX_ATTACH_SIZE) {
          setErr(t(`${file.name} 太大了（${fileSize(file.size)}），单个附件上限 25 MB`, `${file.name} is too large (${fileSize(file.size)}); 25 MB per attachment at most`))
          continue
        }
        const name = pastedName(file, next.filter((x) => x.name.startsWith('pasted-')).length)
        next.push({ id: ++attSeq, file, name, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined })
      }
      return next
    })
    ta.current?.focus()
  }
  /** The files of a drop, leaving folders out. */
  const droppedFiles = (dt: DataTransfer): File[] => {
    const out: File[] = []
    let folders = 0
    const items = Array.from(dt.items || [])
    if (items.length) {
      for (const it of items) {
        if (it.kind !== 'file') continue
        if ((it as any).webkitGetAsEntry?.()?.isDirectory) { folders++; continue }
        const f = it.getAsFile()
        if (f) out.push(f)
      }
    } else out.push(...Array.from(dt.files))
    if (folders) toast(t('文件夹不能作为附件，请拖里面的文件', 'A folder cannot be attached. Drop the files inside it'))
    return out
  }
  const canAttach = !blocked
  const addRef = useRef(addFiles)
  addRef.current = addFiles
  // Files dropped anywhere on the page land in the main message box; the small one takes those dropped on it.
  useEffect(() => {
    const target: HTMLElement | Window | null = compact ? wrap.current : window
    if (!target) return
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    let depth = 0
    const enter = (e: Event) => { if (hasFiles(e as DragEvent)) { depth++; if (canAttach) setDragging(true) } }
    const over = (e: Event) => {
      const d = e as DragEvent
      if (!hasFiles(d)) return
      d.preventDefault() // otherwise the browser opens the file in place of the page
      if (compact) d.stopPropagation()
      d.dataTransfer!.dropEffect = canAttach ? 'copy' : 'none'
    }
    const leave = (e: Event) => { if (hasFiles(e as DragEvent)) { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) } }
    const drop = (e: Event) => {
      const d = e as DragEvent
      if (!hasFiles(d)) return
      d.preventDefault()
      if (compact) d.stopPropagation()
      depth = 0
      setDragging(false)
      if (canAttach) addRef.current(droppedFiles(d.dataTransfer!))
    }
    target.addEventListener('dragenter', enter)
    target.addEventListener('dragover', over)
    target.addEventListener('dragleave', leave)
    target.addEventListener('drop', drop)
    return () => {
      target.removeEventListener('dragenter', enter)
      target.removeEventListener('dragover', over)
      target.removeEventListener('dragleave', leave)
      target.removeEventListener('drop', drop)
    }
  }, [compact, canAttach]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves the attachments on the machine and returns the message that names them, or null if that failed. */
  const attach = async (body: string): Promise<string | null> => {
    if (!files.length) return body
    if (!machine) {
      setErr(t('先选一台机器：附件要存到运行会话的那台机器上', 'Choose a machine first: attachments are saved on the machine the session runs on'))
      return null
    }
    if (!hasFeature(machine, 'upload')) {
      setErr(t(`${machine.label} 上的 runner 版本太旧，还不能接收附件。更新 runner 后再试。`, `The runner on ${machine.label} is too old to take attachments. Update it and try again.`))
      return null
    }
    setSending(true)
    setErr('')
    const paths: string[] = []
    try {
      for (const f of files) {
        if (!f.path || f.on !== machine.name) {
          setUploading(f.id)
          const saved = await api.upload(machine.name, f.name, f.file)
          f.path = saved.path
          f.on = machine.name
          if (f.url) rememberPreview(saved.path, f.url)
        }
        paths.push(f.path)
      }
    } catch (e: any) {
      setErr(e.message || t('附件上传失败', 'Could not upload the attachment'))
      return null
    } finally {
      setUploading(0)
      setSending(false)
    }
    setFiles([])
    return withAttachments(body, paths)
  }

  const deliver = async (prompt: string) => {
    setSending(true)
    setErr('')
    try {
      await onSend(prompt)
      return true
    } catch (e: any) {
      setErr(e.message || t('发送失败', 'Could not send'))
      return false
    } finally {
      setSending(false)
    }
  }

  // The queued message goes out as soon as the run in flight ends.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running && queued && !blocked) {
      const q = queued
      setQueued('')
      deliver(q).then((ok) => { if (!ok) setText((cur) => cur || q) })
    }
    wasRunning.current = running
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  // ----- "/" menu
  const agentCommands = useMemo(() => {
    if (agent !== 'claude') return []
    const reported = machine?.caps?.claude?.commands
    return (reported?.length ? reported : FALLBACK_AGENT_COMMANDS).filter((c) => !INTERACTIVE_ONLY.has(c.name))
  }, [machine, agent])
  const slash = /^\/([^\s/]*)$/.exec(text)
  const items: Item[] = useMemo(() => {
    if (!slash || menuOff) return []
    const q = slash[1].toLowerCase()
    const match = (n: string) => (n.toLowerCase().startsWith(q) ? 0 : n.toLowerCase().includes(q) ? 1 : -1)
    const rank = <T extends { name: string }>(list: T[]) => list.map((c) => [match(c.name), c] as const).filter(([r]) => r >= 0).sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    const taken = new Set(appCommands.map((c) => c.name))
    return [
      ...rank(appCommands).map((c) => ({ key: 'app:' + c.name, name: c.name, description: c.description, app: c })),
      ...rank(agentCommands.filter((c) => !taken.has(c.name))).slice(0, 60).map((c) => ({ key: 'agent:' + c.name, name: c.name, description: c.description, hint: c.hint })),
    ]
  }, [slash?.[1], menuOff, appCommands, agentCommands]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSel(0) }, [slash?.[1]])
  useEffect(() => { if (!slash) setMenuOff(false) }, [!!slash]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.querySelector('.cmd.sel')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const pick = (it: Item) => {
    if (it.app) {
      if (it.app.disabled) {
        setErr(it.app.disabled)
        return
      }
      setText('')
      if (it.name === 'model' || it.name === 'effort') setModelOpen(true)
      else it.app.run('')
    } else {
      setText('/' + it.name + ' ')
      ta.current?.focus()
    }
  }

  const isShell = !!onShell && text.startsWith('!') && text.length > 1
  const send = async () => {
    const typed = text.trim()
    if ((!typed && !files.length) || sending || blocked) return
    if (isShell) {
      onShell!(typed.slice(1).trim())
      setText('')
      return
    }
    // "/name args" typed out in full: Atrium's own commands run here, the rest go to the agent.
    const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(typed)
    const app = m && appCommands.find((c) => c.name === m[1])
    if (app && !app.disabled) {
      setText('')
      if ((app.name === 'model' || app.name === 'effort') && !m![2]) setModelOpen(true)
      else app.run((m![2] || '').trim())
      return
    }
    if (running && queued) return
    const prompt = await attach(typed)
    if (prompt === null) return
    if (running) {
      setQueued(prompt)
      setText('')
      return
    }
    setText('')
    if (!(await deliver(prompt))) setText((cur) => cur || prompt)
  }

  if (blocked) {
    return (
      <div className="composer-wrap">
        <div className="column">
          {before}
          <div className="composer blocked"><Icon name="eye" size={16} />{blocked}</div>
        </div>
      </div>
    )
  }

  const firstAgent = items.findIndex((x) => !x.app)
  return (
    <div className={'composer-wrap' + (compact ? ' compact' : '')} ref={wrap}>
      <div className="column">
        {before}
        {err && <div className="hint error" onClick={() => setErr('')}>{err}</div>}
        {queued && (
          <div className="queued">
            <Icon name="clock" size={14} />
            <span className="q-text">{t('排队中，当前这轮结束后发送：', 'Queued, goes out when this run ends: ')}{queued}</span>
            <button className="linkbtn" onClick={() => { setText((cur) => cur || queued); setQueued('') }}>{t('取回', 'Take back')}</button>
          </div>
        )}
        <div className={'composer' + (running ? ' busy' : '') + (isShell ? ' shell' : '') + (dragging ? ' dropping' : '')}>
          {dragging && <div className="dropnote"><Icon name="clip" size={16} />{t('松开，把文件加到这条消息里', 'Drop to add the files to this message')}</div>}
          {files.length > 0 && (
            <div className="atts">
              {files.map((f) => (
                <span key={f.id} className={'att' + (f.url ? ' pic' : '')} title={`${f.name} · ${fileSize(f.file.size)}`}>
                  {f.url ? <img src={f.url} alt={f.name} draggable={false} /> : <><Icon name="file" size={15} /><span className="att-name">{f.name}</span><span className="att-size">{fileSize(f.file.size)}</span></>}
                  {uploading === f.id ? <span className="att-busy"><Spinner size={12} /></span>
                    : <button type="button" className="att-x" disabled={sending} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} title={t('移除', 'Remove')}><Icon name="x" size={11} /></button>}
                </span>
              ))}
            </div>
          )}
          {items.length > 0 && (
            <div className="cmdmenu" ref={listRef}>
              {items.map((it, i) => (
                <div key={it.key}>
                  {i === 0 && it.app && <div className="menu-label">Atrium</div>}
                  {i === firstAgent && <div className="menu-label">{t('发给 Claude 的命令', 'Commands for Claude')}</div>}
                  <button className={'cmd' + (i === sel ? ' sel' : '') + (it.app?.disabled ? ' off' : '')} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(it) }}>
                    <span className="cmd-name">/{it.name}{it.hint && <i> {it.hint}</i>}</span>
                    <span className="cmd-desc">{it.app?.disabled || it.description}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={ta}
            rows={1}
            autoFocus={autoFocus}
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const cd = e.clipboardData
              const pasted = Array.from(cd.files)
              if (!pasted.length) return
              // Copied from a document (text that also comes as a picture of itself): paste the text.
              const types = Array.from(cd.types)
              if (cd.getData('text/plain').trim() && (types.includes('text/html') || types.includes('text/rtf'))) return
              e.preventDefault()
              addFiles(pasted)
            }}
            onKeyDown={(e) => {
              if (imeKey(e)) return
              if (items.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % items.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + items.length) % items.length); return }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(items[Math.min(sel, items.length - 1)]); return }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenuOff(true); return }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="composer-bar">
            <button type="button" className="pill clipbtn" onClick={() => picker.current?.click()} title={t('添加图片或文件（也可以直接粘贴、拖进来）', 'Add pictures or files (or paste them, or drop them here)')}><Icon name="clip" size={15} /></button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
            <ModePicker prefs={prefs} up={!menusDown} />
            <ModelPicker prefs={prefs} up={!menusDown} open={modelOpen} onOpenChange={setModelOpen} />
            <span className="grow" />
            {isShell ? <span className="keys shellhint"><Icon name="terminal" size={13} />{t('回车发到终端', 'Enter sends it to the terminal')}</span>
              : !compact && <span className="keys">{running ? t('回车排队', 'Enter to queue') : <><kbd>/</kbd>{t(' 命令', ' commands')}</>}</span>}
            {running && !text.trim() && !files.length ? (
              <button className="sendbtn stop" onClick={onStop} title={t('停止', 'Stop')}><Icon name="stop" size={14} /></button>
            ) : (
              <button className="sendbtn" onClick={send} disabled={(!text.trim() && !files.length) || sending || (running && !!queued)} title={running ? t('排队', 'Queue') : t('发送', 'Send')}>
                {sending ? <Spinner size={13} /> : <Icon name="send" size={17} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
