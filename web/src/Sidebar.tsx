// The conversation list. By default it is a tree: machine, then working
// folder, then that folder's sessions, newest first. It can also be a flat
// list by date, like a chat app. Either way it can be filtered by machine and
// agent, and empty or one-off sessions are tucked away.
import { useEffect, useMemo, useState } from 'react'
import { Session } from './api'
import { DeviceLink } from './Dialogs'
import { allSessions, liveIndex, runSessionKey } from './derive'
import { AgentTag, Icon, Logo, Spinner } from './icons'
import { setMeta, signOut, startIn, useStore } from './store'
import { UsageLine } from './Usage'
import { Dropdown, kbd, MenuItem, MenuLabel, MenuSep, Segmented, toast, usePersisted } from './ui'
import { agentName, copyText, displayTitle, folderName, imeKey, machineLabel, ms, resumeCommand, shortTime, timeBucket } from './util'
import { t, lang, setLang } from './i18n'

type Group = { key: string; label: string; items: Session[]; old: boolean }
type Folder = { key: string; cwd: string; label: string; items: Session[] }
type MachineNode = { key: string; name: string; label: string; state: 'on' | 'off' | 'hist'; runner: boolean; server: boolean; folders: Folder[]; count: number }

const FOLDER_ROWS = 5 // sessions listed under a folder before "show more"
const MACHINE_FOLDERS = 8 // folders listed under a machine before "show more"
const STALE = 7 * 86400_000 // what has not been used for this long folds itself away
const RECENT_ROWS = 5 // sessions listed under "Recent" above the machines
const STALE_ROWS = 3 // sessions listed in a folder that was opened although nothing in it is recent

export type ThemeChoice = 'light' | 'dark' | 'system'

export function Sidebar({
  currentId, onOpen, onNew, onSearch, theme, onTheme, onHide,
}: {
  currentId?: string
  onOpen: (id: string) => void
  onNew: () => void
  onSearch: () => void
  theme: ThemeChoice
  onTheme: (t: ThemeChoice) => void
  onHide: () => void
}) {
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.runs)
  const metaMap = useStore((s) => s.meta)
  const machines = useStore((s) => s.machines)
  const connected = useStore((s) => s.connected)
  const loaded = useStore((s) => s.loaded)
  const loadError = useStore((s) => s.loadError)

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
  const [groupBy, setGroupBy] = usePersisted<'time' | 'project'>('atrium.groupby', 'project')
  const [showMinor, setShowMinor] = usePersisted('sh.minor', false)
  const [showHidden, setShowHidden] = usePersisted('sh.hidden', false)
  const [showSide, setShowSide] = usePersisted('atrium.f.side', false)
  // Tree nodes the user opened or closed by hand, and when: the time opened, or minus the time
  // closed (earlier versions stored true / false). The rest follow a default (see isOpen).
  const [openMap, setOpenMap] = usePersisted<Record<string, number | boolean>>('atrium.tree.open', {})
  const [full, setFull] = useState<Record<string, boolean>>({}) // nodes whose "show more" was clicked
  const [renaming, setRenaming] = useState('')
  const [deviceLink, setDeviceLink] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 60_000) // keep "5 分钟前" fresh
    return () => clearInterval(timer)
  }, [])

  const all = useMemo(() => allSessions(sessions, runs), [sessions, runs])
  // Ignore remembered machines that no longer exist, so a stale choice can never hide everything.
  const pickedSet = useMemo(() => {
    const known = new Set([...machines.map((m) => m.name), ...all.map((s) => s.machine)])
    return new Set(picked.filter((n) => known.has(n)))
  }, [picked, machines, all])
  const live = useMemo(() => liveIndex(runs), [runs])
  const touchedHere = useMemo(() => new Set(Object.values(runs).map(runSessionKey)), [runs])

  const { groups, tree, pinned, recent, minorCount, hiddenCount, sideCount, total } = useMemo(() => {
    let minorCount = 0
    let hiddenCount = 0
    let sideCount = 0
    const rows: Session[] = []
    for (const s of all) {
      const m = metaMap[s.id]
      if (pickedSet.size && !pickedSet.has(s.machine)) continue
      if (agent && s.agent !== agent) continue
      if (m?.hidden) {
        hiddenCount++
        if (!showHidden) continue
      }
      // Side chats live in their parent's side panel; the list leaves them out unless asked.
      if ((s.forkKind || m?.fork_kind) === 'side') {
        sideCount++
        if (!showSide && s.id !== currentId) continue
      }
      // Only sessions with no conversation at all (opened and closed, or no reply yet) are folded away.
      // A session with a single message is real work and must show up right away, and anything
      // from the last day is always listed (a brand-new session may still be waiting for its first reply).
      const minor =
        (s.nu === 0 || s.n <= 1) && Date.now() - ms(s.ended) > 86400_000 &&
        !s.synthetic && !m?.pinned && !live.has(s.id) && !touchedHere.has(s.id)
      if (minor) {
        minorCount++
        if (!showMinor) continue
      }
      rows.push(s)
    }
    rows.sort((a, b) => ms(b.ended) - ms(a.ended))
    const pinned = rows.filter((s) => metaMap[s.id]?.pinned)
    const rest = rows.filter((s) => !metaMap[s.id]?.pinned)
    const now = Date.now()
    const groups: Group[] = []
    const tree: MachineNode[] = []
    if (groupBy === 'project') {
      // `rest` is newest first, so folders come out by latest activity and so do their sessions.
      const byMachine = new Map<string, MachineNode>()
      const byFolder = new Map<string, Folder>()
      for (const s of rest) {
        let node = byMachine.get(s.machine)
        if (!node) {
          const m = machines.find((x) => x.name === s.machine)
          node = { key: 'm:' + s.machine, name: s.machine, label: machineLabel(machines, s.machine), state: m?.runner ? (m.online ? 'on' : 'off') : 'hist', runner: !!m?.runner, server: m?.info?.os === 'linux', folders: [], count: 0 }
          byMachine.set(s.machine, node)
          tree.push(node)
        }
        node.count++
        const key = `f:${s.machine}|${s.cwd || ''}`
        let f = byFolder.get(key)
        if (!f) {
          f = { key, cwd: s.cwd || '', label: folderName(s.cwd) || t('（未知目录）', '(unknown folder)'), items: [] }
          byFolder.set(key, f)
          node.folders.push(f)
        }
        f.items.push(s)
      }
      // A machine that can run sessions is listed even before it has any, so one can be started there.
      for (const m of machines) {
        if (!m.runner || byMachine.has(m.name) || (pickedSet.size && !pickedSet.has(m.name))) continue
        tree.push({ key: 'm:' + m.name, name: m.name, label: m.label, state: m.online ? 'on' : 'off', runner: true, server: m.info?.os === 'linux', folders: [], count: 0 })
      }
      // Machines keep a steady order: online first, then offline, then history-only; within that, the hub's own order.
      const rank = { on: 0, off: 1, hist: 2 }
      const at = (name: string) => { const i = machines.findIndex((x) => x.name === name); return i < 0 ? 1e9 : i }
      tree.sort((a, b) => rank[a.state] - rank[b.state] || at(a.name) - at(b.name))
    } else {
      const map = new Map<string, Group>()
      for (const s of rest) {
        const b = timeBucket(ms(s.ended), now)
        const g = map.get(b.key) || { key: b.key, label: b.label, items: [], old: b.key >= 'd' }
        map.set(b.key, g)
        g.items.push(s)
      }
      groups.push(...map.values())
      groups.sort((a, b) => (a.key < b.key ? -1 : 1))
    }
    // In the tree, the sessions used last are also listed on their own above the machines,
    // so the one being worked on is never a few folders away.
    const recent = groupBy === 'project' ? rest.filter((s) => now - ms(s.ended) < STALE || live.has(s.id)).slice(0, RECENT_ROWS) : []
    return { groups, tree, pinned, recent, minorCount, hiddenCount, sideCount, total: rows.length }
  }, [all, metaMap, machines, pickedSet, agent, groupBy, showMinor, showHidden, showSide, live, touchedHere, currentId])

  // Open or closed. Machines are open. A folder is open when it was used in the last seven
  // days, has something running, or holds the open session; after seven idle days it folds
  // itself. Closing by hand sticks; opening by hand holds for seven days, then the rule is back.
  const fresh = (s: Session) => Date.now() - ms(s.ended) < STALE
  const folderDefault = (f: Folder) => (!!f.items[0] && fresh(f.items[0])) || f.items.some((s) => s.id === currentId || live.has(s.id))
  const isOpen = (key: string, def: boolean) => {
    const v = openMap[key]
    if (v === false || (typeof v === 'number' && v < 0)) return false
    if (typeof v === 'number' && Date.now() - v < STALE) return true
    return def
  }
  const toggle = (key: string, now: boolean) => setOpenMap({ ...openMap, [key]: now ? -Date.now() : Date.now() })
  // The worst live state among some sessions, shown on a closed node so nothing waits unseen.
  const liveOf = (items: Session[]) => {
    let st: 'running' | 'permission' | undefined
    for (const s of items) {
      const x = live.get(s.id)
      if (x === 'permission') return x
      if (x) st = x
    }
    return st
  }
  const liveMark = (st?: 'running' | 'permission') =>
    st === 'permission' ? <span className="badge warn">{t('待确认', 'Needs you')}</span> : st === 'running' ? <Spinner size={11} /> : null

  // Opening a session (from search, a link, the start page) reveals it in the tree, once:
  // the user can still close the folder afterwards.
  useEffect(() => {
    if (!currentId || groupBy !== 'project') return
    for (const node of tree) {
      const f = node.folders.find((x) => x.items.some((s) => s.id === currentId))
      if (!f) continue
      if (!isOpen(node.key, true) || !isOpen(f.key, true)) setOpenMap({ ...openMap, [node.key]: Date.now(), [f.key]: Date.now() })
      return
    }
  }, [currentId, groupBy, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const machineRows = useMemo(() => {
    const count = new Map<string, number>()
    for (const s of all) count.set(s.machine, (count.get(s.machine) || 0) + 1)
    return machines.filter((m) => m.runner || count.has(m.name)).map((m) => ({ m, n: count.get(m.name) || 0 }))
      .sort((a, b) => Number(b.m.online) - Number(a.m.online) || Number(b.m.runner) - Number(a.m.runner) || b.n - a.n)
  }, [machines, all])
  const onlineCount = machines.filter((m) => m.runner && m.online).length
  const runnerCount = machines.filter((m) => m.runner).length

  const filterActive = pickedSet.size > 0 || !!agent
  const filterText = [
    pickedSet.size === 0 ? t('全部机器', 'All machines') : pickedSet.size === 1 ? machineLabel(machines, [...pickedSet][0]) : t(`${pickedSet.size} 台机器`, `${pickedSet.size} machines`),
    agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : '',
  ].filter(Boolean).join(' · ')

  const row = (s: Session, inTree = false) => {
    const m = metaMap[s.id]
    const st = live.get(s.id)
    const kind = s.forkKind || m?.fork_kind
    const title = displayTitle(s, m)
    if (renaming === s.id) {
      return (
        <div key={s.id} className={'srow active' + (inTree ? ' in-tree' : '')}>
          <input
            autoFocus
            className="rename"
            defaultValue={title}
            onBlur={(e) => {
              setRenaming('')
              const v = e.target.value.trim()
              if (v !== title) setMeta(s.id, { title: v === s.title ? '' : v })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !imeKey(e)) (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming('')
            }}
          />
        </div>
      )
    }
    return (
      <div key={s.id} className={'srow' + (s.id === currentId ? ' active' : '') + (m?.hidden ? ' dimmed' : '') + (inTree ? ' in-tree' : '')}>
        <button className="srow-main" onClick={() => onOpen(s.id)} onDoubleClick={() => setRenaming(s.id)}>
          <span className="srow-top">
            {st && <span className={'srow-live ' + st} title={st === 'permission' ? t('在等你确认', 'Waiting for you') : t('正在生成', 'Working')}>{st === 'running' ? <Spinner size={11} /> : <i />}</span>}
            {inTree && <span className="srow-agent" title={agentName(s.agent)}><AgentTag agent={s.agent} bare /></span>}
            {kind && <Icon name={kind === 'side' ? 'sidechat' : 'branch'} size={12} className="srow-kind" />}
            <span className="srow-title">{title}</span>
            {st === 'permission' ? <span className="badge warn">{t('待确认', 'Needs you')}</span> : <span className="srow-time">{st === 'running' ? t('生成中', 'working') : shortTime(ms(s.ended))}</span>}
          </span>
          {!inTree && (
            <span className="srow-meta">
              <AgentTag agent={s.agent} />
              {s.cwd && <span className="folder" title={s.cwd}>{folderName(s.cwd)}</span>}
              <span className="mname">{machineLabel(machines, s.machine)}</span>
            </span>
          )}
        </button>
        <Dropdown align="right" className="srow-more" title={t('更多', 'More')} button={<Icon name="dots" size={16} />}>
          {(close) => (
            <>
              <MenuItem icon="pin" label={m?.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')} onClick={() => { close(); setMeta(s.id, { pinned: !m?.pinned }) }} />
              <MenuItem icon="edit" label={t('改名', 'Rename')} onClick={() => { close(); setRenaming(s.id) }} />
              {!s.synthetic && <MenuItem icon="terminal" label={t('复制终端恢复命令', 'Copy terminal resume command')} onClick={() => { close(); copyText(resumeCommand(s)); toast(t('已复制，可在那台机器的终端里粘贴运行', 'Copied. Paste it into a terminal on that machine')) }} />}
              <MenuSep />
              <MenuItem icon={m?.hidden ? 'eye' : 'eyeoff'} label={m?.hidden ? t('取消隐藏', 'Unhide') : t('从列表隐藏', 'Hide from the list')} onClick={() => { close(); setMeta(s.id, { hidden: !m?.hidden }) }} />
            </>
          )}
        </Dropdown>
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="side-top" data-drag>
        <div className="brand"><Logo size={22} /><span className="brand-name">Atrium</span>{lang === 'zh' && <span className="brand-sub">中庭</span>}</div>
        <span className="grow" />
        <button className="iconbtn" onClick={onHide} title={t('收起侧栏', 'Hide sidebar') + ' ' + kbd('B')}><Icon name="sidebar" size={18} /></button>
      </div>

      <div className="side-nav">
        <button className="navbtn" onClick={onNew}><Icon name="plus" size={17} /><span>{t('新会话', 'New session')}</span><kbd>{kbd('N')}</kbd></button>
        <button className="navbtn" onClick={onSearch}><Icon name="search" size={16} /><span>{t('搜索', 'Search')}</span><kbd>{kbd('K')}</kbd></button>
      </div>

      <div className="side-filter">
        <Dropdown wide className={'filterbtn' + (filterActive ? ' on' : '')} button={<><Icon name="filter" size={14} /><span className="ellip">{filterText}</span><Icon name="down" size={12} className="caret" /></>}>
          {() => (
            <>
              <MenuLabel>{t('机器', 'Machines')}</MenuLabel>
              <MenuItem label={t('全部机器', 'All machines')} checked={pickedSet.size === 0} onClick={() => setPicked([])} />
              {machineRows.map(({ m, n }) => (
                <MenuItem key={m.name}
                  label={<><span className={'dot ' + (m.runner ? (m.online ? 'on' : 'off') : 'hist')} /> {m.label}</>}
                  hint={<>{m.runner ? (m.online ? '' : t('不在线 · ', 'offline · ')) : t('仅历史 · ', 'history · ')}{n}</>}
                  checked={pickedSet.has(m.name)} onClick={() => toggleMachine(m.name)} />
              ))}
              <MenuSep />
              <div className="menu-row"><span>{t('助手', 'Agent')}</span><Segmented value={agent} options={[['', t('全部', 'All')], ['claude', 'Claude'], ['codex', 'Codex']]} onChange={setAgent} /></div>
              <div className="menu-row"><span>{t('排列', 'Arrange by')}</span><Segmented value={groupBy} options={[['project', t('项目', 'Project')], ['time', t('时间', 'Date')]]} onChange={setGroupBy} /></div>
              <MenuSep />
              <MenuItem label={t('显示空会话', 'Show empty sessions')} hint={minorCount || ''} checked={showMinor} onClick={() => setShowMinor(!showMinor)} />
              <MenuItem label={t('显示边聊', 'Show side chats')} hint={sideCount || ''} checked={showSide} onClick={() => setShowSide(!showSide)} />
              <MenuItem label={t('显示已隐藏的会话', 'Show hidden sessions')} hint={hiddenCount || ''} checked={showHidden} onClick={() => setShowHidden(!showHidden)} />
            </>
          )}
        </Dropdown>
      </div>

      <div className="slist">
        {!loaded && <div className="side-note"><Spinner size={14} /> {t('正在加载会话…', 'Loading sessions…')}</div>}
        {loadError && <div className="side-note error">{loadError}</div>}
        {loaded && total === 0 && !loadError && <div className="side-note">{t('没有符合条件的会话。', 'No matching sessions.')}</div>}
        {pinned.length > 0 && (
          <div className="sgroup">
            <div className="sgroup-head"><Icon name="pin" size={11} />{t('置顶', 'Pinned')}</div>
            {pinned.map((s) => row(s))}
          </div>
        )}
        {recent.length > 1 && (() => {
          const rOpen = isOpen('recent', true)
          return (
            <div className="sgroup">
              <button className="sgroup-head fold" onClick={() => toggle('recent', rOpen)}>
                <Icon name={rOpen ? 'down' : 'right'} size={11} />{t('最近', 'Recent')}
                {!rOpen && liveMark(liveOf(recent))}
              </button>
              {rOpen && recent.map((s) => row(s))}
            </div>
          )
        })()}
        {tree.map((node) => {
          const mOpen = isOpen(node.key, true)
          // Past the first few folders the rest wait behind "show more", except the one holding the open session.
          const folders = full[node.key] ? node.folders : node.folders.filter((f, i) => i < MACHINE_FOLDERS || f.items.some((s) => s.id === currentId))
          const moreFolders = node.folders.length - folders.length
          return (
            <div className="tree-m" key={node.key}>
              <div className={'tree-head m' + (node.runner ? ' can-add' : '') + (mOpen ? ' open' : '')}>
                <button className="tree-toggle" onClick={() => toggle(node.key, mOpen)} title={node.state === 'on' ? t('在线', 'Online') : node.state === 'off' ? t('不在线', 'Offline') : t('仅历史，没有接入操控', 'History only, no runner')}>
                  <Icon name={node.server ? 'server' : 'machine'} size={16} className="micon" />
                  <span className="tname">{node.label}</span>
                  <span className={'dot ' + node.state} />
                  <span className="tcount">{node.count}</span>
                  {!mOpen && liveMark(liveOf(node.folders.flatMap((f) => f.items)))}
                  <Icon name={mOpen ? 'down' : 'right'} size={12} className="chev" />
                </button>
                {node.runner && (
                  <button className="tree-add" title={t('在这台机器上开新会话，目录可以选或填', 'New session on this machine: pick or type the folder')} onClick={() => { startIn(node.name, ''); onNew() }}>
                    <Icon name="plus" size={15} />
                  </button>
                )}
              </div>
              {mOpen && (
                <div className="tree-kids">
                  {folders.map((f) => {
                const fOpen = isOpen(f.key, folderDefault(f))
                // Listed: the newest few of the last seven days, plus whatever is open or running.
                // A folder opened although all of it is older shows its newest three.
                const keep = (s: Session) => s.id === currentId || live.has(s.id)
                const recent = f.items.filter((s, i) => (i < FOLDER_ROWS && fresh(s)) || keep(s))
                const items = full[f.key] ? f.items : recent.some(fresh) || recent.length >= STALE_ROWS ? recent : f.items.filter((s, i) => i < STALE_ROWS || keep(s))
                const more = f.items.length - items.length
                const canStart = node.runner && !!f.cwd
                return (
                  <div className="tree-f" key={f.key}>
                    <div className={'tree-head f' + (canStart ? ' can-add' : '')}>
                      <button className="tree-toggle" title={f.cwd} onClick={() => toggle(f.key, fOpen)}>
                        <Icon name={fOpen ? 'down' : 'right'} size={12} className="chev" />
                        <Icon name="folder" size={14} className="ficon" />
                        <span className="tname">{f.label}</span>
                        {!fOpen && liveMark(liveOf(f.items))}
                        <span className="tcount">{f.items.length}</span>
                      </button>
                      {canStart && (
                        <button className="tree-add" title={t('在这个目录开新会话', 'New session in this folder')} onClick={() => { startIn(node.name, f.cwd); onNew() }}>
                          <Icon name="plus" size={15} />
                        </button>
                      )}
                    </div>
                    {fOpen && (
                      <div className="tree-kids">
                        {items.map((s) => row(s, true))}
                        {more > 0 && (
                          <button className="tree-more" onClick={() => setFull({ ...full, [f.key]: true })}>{t(`还有 ${more} 个更早的会话`, `${more} older`)}</button>
                        )}
                      </div>
                    )}
                  </div>
                )
                  })}
                  {node.folders.length === 0 && <div className="tree-empty">{t('还没有会话', 'No sessions yet')}</div>}
                  {moreFolders > 0 && (
                    <button className="tree-more" onClick={() => setFull({ ...full, [node.key]: true })}>{t(`还有 ${moreFolders} 个目录`, `${moreFolders} more folders`)}</button>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {groups.map((g) => {
          // By date: what is older than seven days waits behind its heading.
          const gOpen = !g.old || isOpen('g:' + g.key, g.items.some((s) => s.id === currentId || live.has(s.id)))
          return (
            <div className="sgroup" key={g.key}>
              {g.old ? (
                <button className="sgroup-head fold" onClick={() => toggle('g:' + g.key, gOpen)}>
                  <Icon name={gOpen ? 'down' : 'right'} size={11} />{g.label}
                  {!gOpen && liveMark(liveOf(g.items))}
                  <span className="tcount">{g.items.length}</span>
                </button>
              ) : <div className="sgroup-head">{g.label}</div>}
              {gOpen && g.items.map((s) => row(s))}
            </div>
          )
        })}
        {!showMinor && minorCount > 0 && (
          <button className="side-more" onClick={() => setShowMinor(true)}>{t(`还有 ${minorCount} 个没有对话内容的空会话 · 显示`, `${minorCount} empty sessions hidden · Show`)}</button>
        )}
      </div>

      <UsageLine />
      <div className="side-foot">
        <span className={'conn only-phone ' + (connected ? 'ok' : 'bad')} title={connected ? t('实时更新已连接', 'Live updates on') : t('实时更新断开，正在重连', 'Live updates lost, reconnecting')}>
          <span className="dot" />
          {connected ? (runnerCount ? t(`${onlineCount}/${runnerCount} 台机器在线`, `${onlineCount} of ${runnerCount} machines online`) : t('已连接', 'Connected')) : t('重连中…', 'Reconnecting…')}
        </span>
        <span className="grow" />
        <Dropdown up align="right" className="iconbtn" title={t('设置', 'Settings')} button={<Icon name="dots" size={17} />}>
          {(close) => (
            <>
              <div className="menu-row"><span>{t('外观', 'Theme')}</span><Segmented value={theme} options={[['light', t('浅色', 'Light')], ['dark', t('深色', 'Dark')], ['system', t('跟随系统', 'Auto')]]} onChange={onTheme} /></div>
              <div className="menu-row"><span>{t('语言', 'Language')}</span><Segmented value={lang} options={[['zh', '中文'], ['en', 'English']]} onChange={(l) => { if (l !== lang) setLang(l) }} /></div>
              <MenuSep />
              <MenuLabel>{t('快捷键', 'Shortcuts')}</MenuLabel>
              <div className="keys-list">
                <span>{t('新会话', 'New session')}</span><kbd>{kbd('N')}</kbd>
                <span>{t('搜索', 'Search')}</span><kbd>{kbd('K')}</kbd>
                <span>{t('显示 / 收起侧栏', 'Toggle sidebar')}</span><kbd>{kbd('B')}</kbd>
                <span>{t('边聊', 'Side chat')}</span><kbd>{kbd('.')}</kbd>
                <span>{t('终端', 'Terminal')}</span><kbd>{kbd('J')}</kbd>
                <span>{t('文件', 'Files')}</span><kbd>{kbd('E')}</kbd>
                <span>{t('命令菜单', 'Command menu')}</span><kbd>/</kbd>
                <span>{t('把命令发到终端', 'Send a command to the terminal')}</span><kbd>!</kbd>
              </div>
              <MenuSep />
              <MenuItem icon="machine" label={t('接入向导', 'Setup guide')} onClick={() => { close(); location.hash = '#/setup' }} />
              <MenuItem icon="external" label={t('在另一台设备上登录', 'Sign in on another device')} onClick={() => { close(); setDeviceLink(true) }} />
              <MenuItem icon="logout" label={t('退出登录', 'Sign out')} onClick={() => { close(); signOut() }} />
            </>
          )}
        </Dropdown>
      </div>
      {deviceLink && <DeviceLink onClose={() => setDeviceLink(false)} />}
    </aside>
  )
}
