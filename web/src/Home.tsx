// The start page: a message box that begins a new session on any connected
// machine, with the few recent sessions underneath.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { Composer, useRunPrefs } from './Composer'
import { allSessions, liveIndex } from './derive'
import { AgentTag, Icon, Logo, Spinner } from './icons'
import { putRun, startAt, useStore } from './store'
import { Dropdown, kbd, MenuItem, MenuLabel, MenuSep } from './ui'
import { displayTitle, folderName, machineLabel, ms, shortPath, shortTime } from './util'
import { t } from './i18n'

export function Home({ onOpen, onSearch, sidebarHidden, onShowSidebar, focusSignal, onBack }: {
  onBack: () => void
  onOpen: (key: string) => void
  onSearch: () => void
  sidebarHidden: boolean
  onShowSidebar: () => void
  focusSignal: number
}) {
  const machines = useStore((s) => s.machines)
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.runs)
  const metaMap = useStore((s) => s.meta)
  const loaded = useStore((s) => s.loaded)
  const runners = useMemo(() => machines.filter((m) => m.runner), [machines])

  const [machine, setMachine] = useState('')
  const [agent, setAgent] = useState(() => localStorage.getItem('sh.new.agent') || 'claude')
  const [cwd, setCwd] = useState('')
  const [browse, setBrowse] = useState<{ path: string; parent: string; entries: { name: string }[] } | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [browseErr, setBrowseErr] = useState('')
  // "New session here" on a machine or folder in the sidebar asks for a place (store.startAt).
  const [placeTick, setPlaceTick] = useState(0)
  const [dirOpen, setDirOpen] = useState(false) // the folder menu
  const dirInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const on = () => setPlaceTick((x) => x + 1)
    window.addEventListener('atrium:start-at', on)
    return () => window.removeEventListener('atrium:start-at', on)
  }, [])

  // Pick a machine once the list is known: the last one used if it is online, else any online one.
  useEffect(() => {
    if (startAt.machine && runners.some((m) => m.name === startAt.machine)) {
      setMachine(startAt.machine)
      return
    }
    if (machine && runners.some((m) => m.name === machine)) return
    const last = localStorage.getItem('sh.new.machine')
    setMachine((runners.find((m) => m.name === last && m.online) || runners.find((m) => m.online) || runners[0])?.name || '')
  }, [runners, placeTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const m = machines.find((x) => x.name === machine)
  const prefs = useRunPrefs(agent, m)
  const agentsInfo = m?.info?.agents || {}

  const recent = useMemo(() => {
    const seen = new Map<string, number>()
    for (const s of sessions) {
      if (s.machine !== machine || !s.cwd) continue
      const at = ms(s.ended)
      if (!seen.has(s.cwd) || seen.get(s.cwd)! < at) seen.set(s.cwd, at)
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p)
  }, [sessions, machine])

  useEffect(() => {
    const asked = !!machine && startAt.machine === machine
    const want = asked ? startAt.cwd : ''
    if (asked) {
      startAt.machine = ''
      startAt.cwd = ''
    }
    const saved = localStorage.getItem('atrium.new.cwd.' + machine)
    setCwd(want || (saved && recent.includes(saved) ? saved : recent[0]) || m?.info?.home || '')
    setBrowse(null)
    // Asked for a machine but no folder: open the folder menu, to pick one or type a path.
    if (asked) setDirOpen(!want)
  }, [machine, loaded, placeTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // With a keyboard, the folder menu opens ready for typing a path.
  useEffect(() => {
    if (!dirOpen || window.matchMedia?.('(pointer: coarse)').matches) return
    const timer = setTimeout(() => { dirInput.current?.focus(); dirInput.current?.select() }, 80)
    return () => clearTimeout(timer)
  }, [dirOpen])

  const openDir = async (path: string) => {
    setBrowsing(true)
    setBrowseErr('')
    try {
      setBrowse(await api.ls(machine, path))
    } catch (e: any) {
      setBrowseErr(e.message || t('读取目录失败', 'Could not read the folder'))
    } finally {
      setBrowsing(false)
    }
  }

  const start = async (prompt: string) => {
    if (!cwd.trim()) throw new Error(t('先选一个工作目录', 'Choose a working directory first'))
    const d = await api.createRun({ machine, agent, cwd: cwd.trim(), prompt, ...prefs.run })
    localStorage.setItem('sh.new.machine', machine)
    localStorage.setItem('sh.new.agent', agent)
    localStorage.setItem('atrium.new.cwd.' + machine, cwd.trim())
    putRun(d.run)
    onOpen(`run:${d.run.id}`)
  }

  const live = useMemo(() => liveIndex(runs), [runs])
  const latest = useMemo(
    () => allSessions(sessions, runs)
      .filter((s) => !metaMap[s.id]?.hidden && metaMap[s.id]?.fork_kind !== 'side' && s.forkKind !== 'side' && (s.nu > 0 || s.synthetic))
      .sort((a, b) => ms(b.ended) - ms(a.ended)).slice(0, 4),
    [sessions, runs, metaMap],
  )

  let blocked = ''
  if (loaded && runners.length === 0) blocked = t('还没有机器接入操控，暂时只能查看历史。', 'No machine has a runner yet, so there is history only.')
  else if (m && !m.online) blocked = t(`"${m.label}"现在不在线，换一台机器，或者等它上线。`, `${m.label} is offline. Pick another machine, or wait for it.`)

  return (
    <div className="main home">
      <header className="chat-head bare" data-drag>
        {sidebarHidden && <button className="iconbtn" onClick={onShowSidebar} title={t('显示侧栏', 'Show sidebar') + ' ' + kbd('B')}><Icon name="sidebar" size={18} /></button>}
        <button className="iconbtn only-mobile" onClick={onBack} title={t('返回列表', 'Back to the list')}><Icon name="back" size={18} /></button>
      </header>
      <div className="home-body">
        <div className="home-hero"><Logo size={60} /></div>

        <Composer
          draftKey="new"
          placeholder={m ? t(`交给 ${m.label} 上的 ${agent === 'codex' ? 'Codex' : 'Claude'}…`, `Ask ${agent === 'codex' ? 'Codex' : 'Claude'} on ${m.label}…`) : t('想让它做什么？', 'What should it do?')}
          blocked={runners.length === 0 ? blocked : ''}
          prefs={prefs}
          machine={m}
          agent={agent}
          onSend={start}
          autoFocus
          menusDown
          focusSignal={focusSignal}
          before={
            <div className="home-where">
              <Dropdown className="pill solid" button={<><span className={'dot ' + (m?.online ? 'on' : 'off')} /><span>{m?.label || t('选择机器', 'Choose a machine')}</span><Icon name="down" size={12} className="caret" /></>}>
                {(close) => (
                  <>
                    <MenuLabel>{t('在哪台机器上', 'Machine')}</MenuLabel>
                    {runners.map((x) => (
                      <MenuItem key={x.name} label={<><span className={'dot ' + (x.online ? 'on' : 'off')} /> {x.label}</>} hint={x.online ? '' : t('不在线', 'offline')} disabled={!x.online} checked={x.name === machine} onClick={() => { setMachine(x.name); close() }} />
                    ))}
                  </>
                )}
              </Dropdown>
              <Dropdown className="pill solid" button={<><AgentTag agent={agent} /><Icon name="down" size={12} className="caret" /></>}>
                {(close) => (
                  <>
                    <MenuLabel>{t('用哪个助手', 'Agent')}</MenuLabel>
                    {['claude', 'codex'].map((a) => (
                      <MenuItem key={a} label={<AgentTag agent={a} />} checked={a === agent}
                        hint={agentsInfo[a]?.version ? String(agentsInfo[a].version).replace(/\s*\(.*\)/, '') : m?.info && !agentsInfo[a]?.path ? t('未安装', 'not installed') : ''}
                        onClick={() => { setAgent(a); close() }} />
                    ))}
                  </>
                )}
              </Dropdown>
              <Dropdown wide className="pill solid" open={dirOpen} onOpenChange={(o) => { setDirOpen(o); if (!o) setBrowse(null) }}
                button={<><Icon name="folder" size={14} /><span className="mono ellip" title={cwd}>{cwd ? folderName(cwd) : t('选择目录', 'Choose a folder')}</span><Icon name="down" size={12} className="caret" /></>}>
                {(close) => (
                  <>
                    <MenuLabel>{t('工作目录', 'Working directory')}</MenuLabel>
                    <div className="menu-form row">
                      <input ref={dirInput} className="input sm mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" spellCheck={false}
                        onKeyDown={(e) => { if (e.key === 'Enter') close() }} />
                      <button className="btn sm" onClick={() => openDir(cwd || '')} disabled={browsing || !m?.online}>{browsing ? <Spinner size={12} /> : t('浏览', 'Browse')}</button>
                    </div>
                    {browseErr && <div className="menu-note err">{browseErr}</div>}
                    {browse ? (
                      <div className="browser">
                        <div className="browser-head">
                          <button className="linkbtn" onClick={() => openDir(browse.parent)} disabled={browse.parent === browse.path}>{t('↑ 上一级', '↑ Up')}</button>
                          <span className="mono" title={browse.path}>{shortPath(browse.path, 40)}</span>
                          <button className="linkbtn" onClick={() => { setCwd(browse.path); setBrowse(null); close() }}>{t('选这个目录', 'Use this folder')}</button>
                        </div>
                        <div className="browser-list">
                          {browse.entries.length === 0 && <div className="dim">{t('没有子目录', 'No subfolders')}</div>}
                          {browse.entries.map((e) => (
                            <button key={e.name} onClick={() => openDir(browse.path.replace(/\/+$/, '') + '/' + e.name)}><Icon name="folder" size={14} />{e.name}</button>
                          ))}
                        </div>
                      </div>
                    ) : recent.length > 0 && (
                      <>
                        <MenuSep />
                        <MenuLabel>{t('最近用过', 'Recent')}</MenuLabel>
                        {recent.map((p) => (
                          <MenuItem key={p} icon="folder" label={folderName(p)} sub={<span className="mono">{shortPath(p, 52)}</span>} checked={p === cwd} onClick={() => { setCwd(p); close() }} />
                        ))}
                      </>
                    )}
                  </>
                )}
              </Dropdown>
              {blocked && runners.length > 0 && <span className="home-warn">{blocked}</span>}
            </div>
          }
        />

        <div className="home-recent">
          <div className="home-recent-head">
            <span>{t('继续最近的会话', 'Pick up where you left off')}</span>
            <button className="linkbtn" onClick={onSearch}>{t('搜索全部', 'Search everything')} <kbd>{kbd('K')}</kbd></button>
          </div>
          {!loaded && <div className="side-note"><Spinner size={14} /> {t('正在加载…', 'Loading…')}</div>}
          {latest.map((s) => (
            <button key={s.id} className="home-row" onClick={() => onOpen(s.id)}>
              <span className="home-row-title">{displayTitle(s, metaMap[s.id])}</span>
              <span className="home-row-meta"><AgentTag agent={s.agent} /><span>{machineLabel(machines, s.machine)}</span>{s.cwd && <span className="mono">{folderName(s.cwd)}</span>}</span>
              <span className="home-row-time">{live.has(s.id) ? <Spinner size={12} /> : shortTime(ms(s.ended))}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
