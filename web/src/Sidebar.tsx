// The conversation list: grouped like a chat app, filterable by machine and
// agent, with small or one-off sessions tucked away by default.
import { useEffect, useMemo, useState } from 'react'
import { Session } from './api'
import { allSessions, liveIndex, runSessionKey } from './derive'
import { AgentTag, Icon, Spinner } from './icons'
import { signOut, useStore } from './store'
import { displayTitle, folderName, imeKey, machineLabel, ms, shortTime, timeBucket } from './util'
import { t, lang, setLang } from './i18n'

function usePersisted<T>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? def : (JSON.parse(raw) as T)
    } catch {
      return def
    }
  })
  return [v, (nv: T) => { setV(nv); localStorage.setItem(key, JSON.stringify(nv)) }]
}

type Group = { key: string; label: string; sub?: string; title?: string; items: Session[] }

export function Sidebar({
  currentId, onOpen, onNew, onSearch, theme, onTheme,
}: {
  currentId?: string
  onOpen: (id: string) => void
  onNew: () => void
  onSearch: () => void
  theme: string
  onTheme: () => void
}) {
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.runs)
  const metaMap = useStore((s) => s.meta)
  const machines = useStore((s) => s.machines)
  const connected = useStore((s) => s.connected)
  const loaded = useStore((s) => s.loaded)
  const loadError = useStore((s) => s.loadError)

  const [query, setQuery] = useState('')
  // Which machines to list. Empty means all of them; the choice is remembered in this browser.
  const [picked, setPicked] = usePersisted<string[]>('sh.f.machines', (() => {
    try {
      const old = JSON.parse(localStorage.getItem('sh.f.machine') || '""') // earlier single-choice setting
      return typeof old === 'string' && old ? [old] : []
    } catch {
      return []
    }
  })())
  const toggleMachine = (name: string) => setPicked(picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name])
  const [agent, setAgent] = usePersisted('sh.f.agent', '')
  const [groupBy, setGroupBy] = usePersisted<'time' | 'project'>('sh.groupby', 'time')
  const [showMinor, setShowMinor] = usePersisted('sh.minor', false)
  const [showHidden, setShowHidden] = usePersisted('sh.hidden', false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000) // keep "5 分钟前" fresh
    return () => clearInterval(t)
  }, [])

  const all = useMemo(() => allSessions(sessions, runs), [sessions, runs])
  // Ignore remembered machines that no longer exist, so a stale choice can never hide everything.
  const pickedSet = useMemo(() => {
    const known = new Set([...machines.map((m) => m.name), ...all.map((s) => s.machine)])
    return new Set(picked.filter((n) => known.has(n)))
  }, [picked, machines, all])
  const live = useMemo(() => liveIndex(runs), [runs])
  const touchedHere = useMemo(() => new Set(Object.values(runs).map(runSessionKey)), [runs])

  const { groups, pinned, minorCount, hiddenCount, total } = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    let minorCount = 0
    let hiddenCount = 0
    const rows: Session[] = []
    for (const s of all) {
      const m = metaMap[s.id]
      if (pickedSet.size && !pickedSet.has(s.machine)) continue
      if (agent && s.agent !== agent) continue
      if (terms.length) {
        const hay = `${displayTitle(s, m)} ${s.first || ''} ${s.cwd || ''} ${machineLabel(machines, s.machine)}`.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) continue
      }
      if (m?.hidden) {
        hiddenCount++
        if (!showHidden) continue
      }
      // Only sessions with no conversation at all (opened and closed, or no reply yet) are folded away.
      // A session with a single message is real work and must show up right away, and anything
      // from the last day is always listed (a brand-new session may still be waiting for its first reply).
      const minor =
        (s.nu === 0 || s.n <= 1) && Date.now() - ms(s.ended) > 86400_000 &&
        !s.synthetic && !m?.pinned && !live.has(s.id) && !touchedHere.has(s.id)
      if (minor) {
        minorCount++
        if (!showMinor && !terms.length) continue
      }
      rows.push(s)
    }
    rows.sort((a, b) => ms(b.ended) - ms(a.ended))
    const pinned = rows.filter((s) => metaMap[s.id]?.pinned)
    const rest = rows.filter((s) => !metaMap[s.id]?.pinned)
    const map = new Map<string, Group>()
    const now = Date.now()
    for (const s of rest) {
      let g: Group
      if (groupBy === 'project') {
        const key = `${s.machine}|${s.cwd || ''}`
        g = map.get(key) || { key, label: folderName(s.cwd) || t('（未知目录）', '(unknown folder)'), sub: machineLabel(machines, s.machine), title: s.cwd, items: [] }
        map.set(key, g)
      } else {
        const b = timeBucket(ms(s.ended), now)
        g = map.get(b.key) || { key: b.key, label: b.label, items: [] }
        map.set(b.key, g)
      }
      g.items.push(s)
    }
    const groups = [...map.values()]
    if (groupBy === 'time') groups.sort((a, b) => (a.key < b.key ? -1 : 1))
    return { groups, pinned, minorCount, hiddenCount, total: rows.length }
  }, [all, metaMap, machines, pickedSet, agent, query, groupBy, showMinor, showHidden, live, touchedHere])

  const machineChips = useMemo(() => {
    const used = new Set(all.map((s) => s.machine))
    return machines.filter((m) => m.runner || used.has(m.name))
  }, [machines, all])

  const row = (s: Session) => {
    const m = metaMap[s.id]
    const st = live.get(s.id)
    return (
      <button key={s.id} className={'srow' + (s.id === currentId ? ' active' : '') + (m?.hidden ? ' dimmed' : '')} onClick={() => onOpen(s.id)}>
        <div className="srow-top">
          <span className="srow-title">{displayTitle(s, m)}</span>
          {st === 'permission' ? <span className="badge warn">{t('待确认', 'Needs you')}</span> : st === 'running' ? <Spinner size={12} /> : <span className="srow-time">{shortTime(ms(s.ended))}</span>}
        </div>
        <div className="srow-meta">
          <AgentTag agent={s.agent} />
          {groupBy !== 'project' && s.cwd && <span className="folder" title={s.cwd}>{folderName(s.cwd)}</span>}
          <span className="mname">{machineLabel(machines, s.machine)}</span>
        </div>
      </button>
    )
  }

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="brand"><span className="logo" />Atrium{lang === 'zh' && <span className="brand-sub">中庭</span>}</div>
        <button className="btn primary sm" onClick={onNew}><Icon name="plus" size={15} />{t('新会话', 'New')}</button>
      </div>

      <div className="side-search">
        <Icon name="search" size={15} />
        <input
          value={query}
          placeholder={t('筛选标题、目录…', 'Filter by title or folder…')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !imeKey(e)) onSearch() }}
        />
        <button className="kbd" onClick={onSearch} title={t('搜索所有对话内容', 'Search inside every conversation')}>{t('全文', 'Search')} ⌘K</button>
      </div>

      <div className="chips">
        <button className={'chip' + (pickedSet.size === 0 ? ' on' : '')} onClick={() => setPicked([])} title={t('显示所有机器的会话', 'Show sessions from every machine')}>{t('全部机器', 'All machines')}</button>
        {machineChips.map((m) => (
          <button key={m.name} className={'chip' + (pickedSet.has(m.name) ? ' on' : '')} onClick={() => toggleMachine(m.name)}
            title={m.runner ? (m.online ? t('在线，可以操控', 'Online: you can work here') : t('不在线，只能看历史', 'Offline: history only')) : t('只有历史记录', 'History only')}>
            <span className={'dot ' + (m.runner ? (m.online ? 'on' : 'off') : 'none')} />{m.label}
          </button>
        ))}
      </div>
      <div className="chips second">
        {[['', t('全部', 'All')], ['claude', 'Claude'], ['codex', 'Codex']].map(([v, l]) => (
          <button key={v} className={'chip' + (agent === v ? ' on' : '')} onClick={() => setAgent(v)}>{l}</button>
        ))}
        <span className="grow" />
        <div className="seg" title={t('分组方式', 'Group by')}>
          <button className={groupBy === 'time' ? 'on' : ''} onClick={() => setGroupBy('time')}>{t('按时间', 'Date')}</button>
          <button className={groupBy === 'project' ? 'on' : ''} onClick={() => setGroupBy('project')}>{t('按项目', 'Project')}</button>
        </div>
      </div>

      <div className="slist">
        {!loaded && <div className="side-note"><Spinner size={14} /> {t('正在加载会话…', 'Loading sessions…')}</div>}
        {loadError && <div className="side-note error">{loadError}</div>}
        {loaded && total === 0 && !loadError && <div className="side-note">{t('没有符合条件的会话。', 'No matching sessions.')}</div>}
        {pinned.length > 0 && (
          <div className="sgroup">
            <div className="sgroup-head"><Icon name="pin" size={12} />{t('置顶', 'Pinned')}</div>
            {pinned.map(row)}
          </div>
        )}
        {groups.map((g) => {
          const isCol = groupBy === 'project' && collapsed[g.key]
          return (
            <div className="sgroup" key={g.key}>
              {groupBy === 'project' ? (
                <button className="sgroup-head click" title={g.title} onClick={() => setCollapsed({ ...collapsed, [g.key]: !collapsed[g.key] })}>
                  <Icon name={isCol ? 'right' : 'down'} size={12} />
                  <span className="gname">{g.label}</span>
                  <span className="gsub">{g.sub}</span>
                  <span className="gcount">{g.items.length}</span>
                </button>
              ) : (
                <div className="sgroup-head">{g.label}</div>
              )}
              {!isCol && g.items.map(row)}
            </div>
          )
        })}
        {!showMinor && minorCount > 0 && !query && (
          <button className="side-more" onClick={() => setShowMinor(true)}>{t(`还有 ${minorCount} 个没有对话内容的空会话 · 显示`, `${minorCount} empty sessions hidden · Show`)}</button>
        )}
      </div>

      <div className="side-foot">
        <span className={'conn ' + (connected ? 'ok' : 'bad')} title={connected ? t('实时更新已连接', 'Live updates on') : t('实时更新断开，正在重连', 'Live updates lost, reconnecting')}>
          <span className="dot" />{connected ? t('已连接', 'Connected') : t('重连中…', 'Reconnecting…')}
        </span>
        <span className="grow" />
        <button className="iconbtn" onClick={onTheme} title={t('切换深浅色', 'Light / dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} /></button>
        <div className="menu-wrap">
          <button className="iconbtn" onClick={() => setMenu(!menu)} title={t('更多', 'More')}><Icon name="dots" size={17} /></button>
          {menu && (
            <>
              <div className="menu-back" onClick={() => setMenu(false)} />
              <div className="menu up">
                <button onClick={() => { setShowMinor(!showMinor); setMenu(false) }}>
                  <Icon name={showMinor ? 'check' : 'list'} size={15} />{showMinor ? t('隐藏空会话', 'Hide empty sessions') : t(`显示空会话（${minorCount}）`, `Show empty sessions (${minorCount})`)}
                </button>
                <button onClick={() => { setShowHidden(!showHidden); setMenu(false) }}>
                  <Icon name={showHidden ? 'check' : 'eye'} size={15} />{showHidden ? t('不显示已隐藏的会话', 'Leave hidden sessions out') : t(`显示已隐藏的会话（${hiddenCount}）`, `Show hidden sessions (${hiddenCount})`)}
                </button>
                <button onClick={() => { setMenu(false); setLang(lang === 'zh' ? 'en' : 'zh') }}><Icon name="globe" size={15} />{lang === 'zh' ? 'English' : '中文'}</button>
                <button onClick={() => { setMenu(false); signOut() }}><Icon name="logout" size={15} />{t('退出登录', 'Sign out')}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  )
}
