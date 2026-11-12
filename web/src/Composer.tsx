// The message box: text, the "/" command menu, permission mode and model
// pickers, send / stop, and one queued message while a run is in flight.
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, Machine, SlashCmd } from './api'
import { Icon, Spinner } from './icons'
import { setMachines } from './store'
import { Dropdown, MenuItem, MenuLabel, MenuSep, toast } from './ui'
import { hasFeature, imeKey, modeOptions, modelChoices } from './util'
import { t } from './i18n'

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
  const label = (cur ? cur.label : prefs.model) + (prefs.effort ? ' · ' + prefs.effort : '')
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
          {prefs.efforts.length > 0 && (
            <>
              <MenuSep />
              <MenuLabel>{t('思考强度', 'Reasoning effort')}</MenuLabel>
              <div className="effort">
                {['', ...prefs.efforts].map((e) => (
                  <button key={e} type="button" className={e === prefs.effort ? 'on' : ''} onClick={() => prefs.setEffort(e)}>{e || t('默认', 'Default')}</button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Dropdown>
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
  const ta = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setText(localStorage.getItem('sh.draft.' + draftKey) || '')
    setQueued(localStorage.getItem('atrium.queue.' + draftKey) || '')
    setErr('')
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
    const prompt = text.trim()
    if (!prompt || sending || blocked) return
    if (isShell) {
      onShell!(prompt.slice(1).trim())
      setText('')
      return
    }
    // "/name args" typed out in full: Atrium's own commands run here, the rest go to the agent.
    const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(prompt)
    const app = m && appCommands.find((c) => c.name === m[1])
    if (app && !app.disabled) {
      setText('')
      if ((app.name === 'model' || app.name === 'effort') && !m![2]) setModelOpen(true)
      else app.run((m![2] || '').trim())
      return
    }
    if (running) {
      if (queued) return
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
    <div className={'composer-wrap' + (compact ? ' compact' : '')}>
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
        <div className={'composer' + (running ? ' busy' : '') + (isShell ? ' shell' : '')}>
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
            <ModePicker prefs={prefs} up={!menusDown} />
            <ModelPicker prefs={prefs} up={!menusDown} open={modelOpen} onOpenChange={setModelOpen} />
            <span className="grow" />
            {isShell ? <span className="keys shellhint"><Icon name="terminal" size={13} />{t('回车发到终端', 'Enter sends it to the terminal')}</span>
              : !compact && <span className="keys">{running ? t('回车排队', 'Enter to queue') : <><kbd>/</kbd>{t(' 命令', ' commands')}</>}</span>}
            {running && !text.trim() ? (
              <button className="sendbtn stop" onClick={onStop} title={t('停止', 'Stop')}><Icon name="stop" size={14} /></button>
            ) : (
              <button className="sendbtn" onClick={send} disabled={!text.trim() || sending || (running && !!queued)} title={running ? t('排队', 'Queue') : t('发送', 'Send')}>
                {sending ? <Spinner size={13} /> : <Icon name="send" size={17} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
