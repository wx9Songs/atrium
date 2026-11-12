// Two overlays: start a new session on a machine, and search every conversation.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, SearchHit } from './api'
import { allSessions } from './derive'
import { AgentTag, Icon, Spinner } from './icons'
import { snippetHtml } from './md'
import { putRun, useStore } from './store'
import { displayTitle, folderName, imeKey, machineLabel, modeOptions, ms, shortPath, shortTime } from './util'

// ---------- new session ----------

export function NewSession({ onClose, onStarted }: { onClose: () => void; onStarted: (key: string) => void }) {
  const machines = useStore((s) => s.machines)
  const sessions = useStore((s) => s.sessions)
  const runners = machines.filter((m) => m.runner)
  const [machine, setMachine] = useState(() => {
    const last = localStorage.getItem('sh.new.machine')
    return (runners.find((m) => m.name === last && m.online) || runners.find((m) => m.online) || runners[0])?.name || ''
  })
  const [agent, setAgent] = useState(() => localStorage.getItem('sh.new.agent') || 'claude')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState('machine')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [browse, setBrowse] = useState<{ path: string; parent: string; entries: { name: string }[] } | null>(null)
  const [browsing, setBrowsing] = useState(false)

  const m = machines.find((x) => x.name === machine)
  const agentsInfo = m?.info?.agents || {}

  const recent = useMemo(() => {
    const seen = new Map<string, number>()
    for (const s of sessions) {
      if (s.machine !== machine || !s.cwd) continue
      const t = ms(s.ended)
      if (!seen.has(s.cwd) || seen.get(s.cwd)! < t) seen.set(s.cwd, t)
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p)
  }, [sessions, machine])

  useEffect(() => {
    setCwd(recent[0] || m?.info?.home || '')
    setBrowse(null)
  }, [machine]) // eslint-disable-line react-hooks/exhaustive-deps

  const openDir = async (path: string) => {
    setBrowsing(true)
    setErr('')
    try {
      setBrowse(await api.ls(machine, path))
    } catch (e: any) {
      setErr(e.message || '读取目录失败')
    } finally {
      setBrowsing(false)
    }
  }

  const start = async () => {
    if (!prompt.trim() || !cwd.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      const d = await api.createRun({ machine, agent, cwd: cwd.trim(), prompt: prompt.trim(), mode })
      localStorage.setItem('sh.new.machine', machine)
      localStorage.setItem('sh.new.agent', agent)
      putRun(d.run)
      onStarted(`run:${d.run.id}`)
    } catch (e: any) {
      setErr(e.message || '启动失败')
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog">
        <div className="dialog-head">
          <h2>新会话</h2>
          <button className="iconbtn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        {runners.length === 0 ? (
          <div className="dialog-body"><div className="note">还没有机器接入操控，暂时只能查看历史。</div></div>
        ) : (
          <div className="dialog-body">
            <label className="fl">在哪台机器上</label>
            <div className="pick">
              {runners.map((x) => (
                <button key={x.name} className={'pickbtn' + (machine === x.name ? ' on' : '')} disabled={!x.online} onClick={() => setMachine(x.name)}>
                  <span className={'dot ' + (x.online ? 'on' : 'off')} />{x.label}{!x.online && <i>不在线</i>}
                </button>
              ))}
            </div>

            <label className="fl">用哪个助手</label>
            <div className="pick">
              {['claude', 'codex'].map((a) => (
                <button key={a} className={'pickbtn' + (agent === a ? ' on' : '')} onClick={() => { setAgent(a); setMode('machine') }}>
                  {a === 'claude' ? 'Claude' : 'Codex'}
                  {agentsInfo[a]?.version && <i>{String(agentsInfo[a].version).replace(/\s*\(.*\)/, '')}</i>}
                  {m?.info && !agentsInfo[a]?.path && <i>未安装</i>}
                </button>
              ))}
            </div>

            <label className="fl">工作目录</label>
            <div className="dirrow">
              <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" spellCheck={false} />
              <button className="btn" onClick={() => openDir(cwd || '')} disabled={browsing}>{browsing ? <Spinner size={13} /> : <Icon name="folder" size={15} />}浏览</button>
            </div>
            {browse ? (
              <div className="browser">
                <div className="browser-head">
                  <button className="linkbtn" onClick={() => openDir(browse.parent)} disabled={browse.parent === browse.path}>↑ 上一级</button>
                  <span className="mono" title={browse.path}>{shortPath(browse.path, 52)}</span>
                  <button className="linkbtn" onClick={() => { setCwd(browse.path); setBrowse(null) }}>选这个目录</button>
                </div>
                <div className="browser-list">
                  {browse.entries.length === 0 && <div className="dim">没有子目录</div>}
                  {browse.entries.map((e) => (
                    <button key={e.name} onClick={() => openDir(browse.path.replace(/\/+$/, '') + '/' + e.name)}>
                      <Icon name="folder" size={14} />{e.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : recent.length > 0 && (
              <div className="recent">
                {recent.map((p) => (
                  <button key={p} className={'chip' + (cwd === p ? ' on' : '')} title={p} onClick={() => setCwd(p)}>{folderName(p)}</button>
                ))}
              </div>
            )}

            <label className="fl">第一条消息</label>
            <textarea className="input area" autoFocus rows={4} value={prompt} placeholder="想让它做什么？" onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !imeKey(e)) start() }} />

            <div className="dialog-foot">
              <label className="mode">
                <Icon name="shield" size={14} />
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {modeOptions(agent).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <span className="grow" />
              {err && <span className="errtext">{err}</span>}
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn primary" onClick={start} disabled={busy || !prompt.trim() || !cwd.trim() || !m?.online}>
                {busy ? <Spinner size={13} /> : <Icon name="send" size={15} />}开始
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- search everything ----------

export function SearchPalette({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string, ord?: number) => void }) {
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.runs)
  const metaMap = useStore((s) => s.meta)
  const machines = useStore((s) => s.machines)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(0)
  const seq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const titleHits = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return allSessions(sessions, runs)
      .filter((s) => {
        const hay = `${displayTitle(s, metaMap[s.id])} ${s.cwd || ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      .sort((a, b) => ms(b.ended) - ms(a.ended))
      .slice(0, 6)
  }, [q, sessions, runs, metaMap])

  useEffect(() => {
    const query = q.trim()
    setSel(0)
    if (query.length < 2) {
      setHits([])
      setBusy(false)
      return
    }
    const my = ++seq.current
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const d = await api.search(query)
        if (my === seq.current) {
          setHits(d.hits)
          setErr('')
        }
      } catch (e: any) {
        if (my === seq.current) setErr(e.message || '搜索失败')
      } finally {
        if (my === seq.current) setBusy(false)
      }
    }, 260)
    return () => clearTimeout(t)
  }, [q])

  const items: { id: string; ord?: number }[] = [...titleHits.map((s) => ({ id: s.id })), ...hits.map((h) => ({ id: h.session_id, ord: h.ord }))]
  const go = (i: number) => {
    const it = items[i]
    if (it) onOpen(it.id, it.ord)
  }
  useEffect(() => {
    listRef.current?.querySelector('.hit.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  return (
    <div className="overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            autoFocus
            value={q}
            placeholder="搜索所有机器上的对话内容…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (imeKey(e)) return
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              else if (e.key === 'Enter') go(sel)
            }}
          />
          {busy && <Spinner size={15} />}
          <button className="kbd" onClick={onClose}>Esc</button>
        </div>
        <div className="palette-list" ref={listRef}>
          {q.trim().length < 2 && <div className="palette-empty">输入关键词，搜索标题和每一条对话内容。</div>}
          {err && <div className="palette-empty error">{err}</div>}
          {titleHits.length > 0 && <div className="palette-sec">标题匹配</div>}
          {titleHits.map((s, i) => (
            <button key={'t' + s.id} className={'hit' + (sel === i ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
              <div className="hit-top">
                <span className="hit-title">{displayTitle(s, metaMap[s.id])}</span>
                <span className="hit-time">{shortTime(ms(s.ended))}</span>
              </div>
              <div className="hit-meta"><AgentTag agent={s.agent} /><span>{machineLabel(machines, s.machine)}</span>{s.cwd && <span>{folderName(s.cwd)}</span>}</div>
            </button>
          ))}
          {hits.length > 0 && <div className="palette-sec">对话内容</div>}
          {hits.map((h, j) => {
            const i = titleHits.length + j
            return (
              <button key={'h' + h.session_id + h.ord} className={'hit' + (sel === i ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
                <div className="hit-top">
                  <span className="hit-title">{metaMap[h.session_id]?.title || h.title || '（无标题）'}</span>
                  <span className="hit-time">{shortTime(ms(h.ended))}</span>
                </div>
                <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
                <div className="hit-meta"><AgentTag agent={h.agent} /><span>{machineLabel(machines, h.machine)}</span></div>
              </button>
            )
          })}
          {q.trim().length >= 2 && !busy && !err && items.length === 0 && <div className="palette-empty">没有找到相关内容。</div>}
        </div>
      </div>
    </div>
  )
}
