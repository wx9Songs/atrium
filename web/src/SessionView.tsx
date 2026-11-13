// The conversation page: history from the archive, live output of runs
// started here, and a message box to keep working. The same view, in a
// narrower form, shows a side chat next to its parent.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, ForkKind, Msg, PermReq, Run, Session } from './api'
import { AppCommand, Composer, useRunPrefs } from './Composer'
import { allSessions, runsOf } from './derive'
import { AgentTag, Icon, Spinner } from './icons'
import { runToMsgs } from './live'
import { SidePane } from './SidePane'
import { ensureEvents, isTerminal, putRun, setMeta, useStore } from './store'
import { sendToTerminal } from './termbus'
import { toolView, commandOf, parseInput } from './tools'
import { cleanUserText, Transcript, TranscriptActions } from './Transcript'
import { Dropdown, kbd, MenuItem, MenuSep, toast, usePersisted } from './ui'
import {
  canFork, clipText, copyText, displayTitle, fullTime, hasFeature, hasShell, imeKey, machineLabel, ms, resumeCommand, runCoveredByArchive, shortPath, statusText,
} from './util'
import { lang, t } from './i18n'

const msgKey = (m: Msg) => m.key || `a${m.ord}`

const PAGE = 80

/** Run errors are stored in both languages; older ones only in Chinese. */
export const runError = (r: Run) => (lang === 'zh' ? r.error_zh || r.error : r.error) || ''

/** Which side chat each session last showed, for as long as the page is open. */
const lastThread = new Map<string, string>()

export type Pane = '' | 'side' | 'terminal' | 'files'

export function SessionView({
  id, focusOrd, onBack, onOpen, onNew, onSearch, variant = 'main', sidebarHidden, onShowSidebar,
}: {
  id: string
  focusOrd?: number
  onBack: () => void
  /** Go to another session (a fork made here, the parent of a branch). */
  onOpen: (key: string) => void
  onNew?: () => void
  onSearch?: () => void
  /** "side": the narrow view inside the side panel: no header, only what was said after the fork. */
  variant?: 'main' | 'side'
  sidebarHidden?: boolean
  onShowSidebar?: () => void
}) {
  const side = variant === 'side'
  const sessions = useStore((s) => s.sessions)
  const runsMap = useStore((s) => s.runs)
  const events = useStore((s) => s.events)
  const machines = useStore((s) => s.machines)
  const metaMap = useStore((s) => s.meta)

  const all = useMemo(() => allSessions(sessions, runsMap), [sessions, runsMap])
  const session: Session | undefined = useMemo(() => all.find((s) => s.id === id), [all, id])
  const runs = useMemo(() => runsOf(id, runsMap), [id, runsMap])
  const meta = metaMap[id]
  const machine = machines.find((m) => m.name === session?.machine)
  const prefs = useRunPrefs(session?.agent || 'claude', machine)

  const [archive, setArchive] = useState<Msg[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [err, setErr] = useState('')
  const [atLatest, setAtLatest] = useState(true)
  const [merged, setMerged] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<number | undefined>(focusOrd)

  const sessionRef = useRef(session)
  sessionRef.current = session
  const runsRef = useRef(runs)
  runsRef.current = runs
  const archiveRef = useRef(archive)
  archiveRef.current = archive

  const coveredNow = useCallback(() => {
    const s = sessionRef.current
    const set = new Set<string>()
    for (const r of runsRef.current) if (isTerminal(r) && runCoveredByArchive(r, s)) set.add(r.id)
    return set
  }, [])

  // ----- initial load (and reload when the session or focus target changes)
  const loadSeq = useRef(0)
  const load = useCallback(
    async (target?: number) => {
      const seq = ++loadSeq.current
      setLoading(true)
      setErr('')
      try {
        const d = await api.messages(id, { limit: PAGE, before: target !== undefined ? target + PAGE / 2 : undefined })
        if (seq !== loadSeq.current) return
        setArchive(d.messages)
        setMore(d.more)
        setAtLatest(target === undefined)
        setMerged(coveredNow())
      } catch (e: any) {
        if (seq === loadSeq.current) setErr(e.message || t('加载失败', 'Could not load'))
      } finally {
        if (seq === loadSeq.current) setLoading(false)
      }
    },
    [id, coveredNow],
  )

  useEffect(() => {
    setArchive([])
    setMerged(new Set())
    setFocus(focusOrd)
    setBranch(null)
    stick.current = true
    load(focusOrd)
  }, [id, focusOrd, load])

  // ----- follow the archive: new messages written elsewhere, or a run of ours being indexed
  const tailBusy = useRef(false)
  const refreshTail = useCallback(async () => {
    if (tailBusy.current || loadSeq.current === 0) return
    tailBusy.current = true
    const seq = loadSeq.current
    try {
      const cur = archiveRef.current
      const last = cur.length ? cur[cur.length - 1].ord : -1
      const d = await api.messages(id, { after: last, limit: 400 })
      if (seq !== loadSeq.current) return
      if (d.messages.length) setArchive((a) => [...a, ...d.messages.filter((m) => !a.length || m.ord > a[a.length - 1].ord)])
      setMerged(coveredNow())
    } catch {
      /* try again on the next change */
    } finally {
      tailBusy.current = false
    }
  }, [id, coveredNow])

  const sig = session ? `${session.synthetic ? 's' : 'a'}|${session.ended}|${session.n}` : ''
  const sigSeen = useRef('')
  useEffect(() => {
    if (!sig || loading) return
    if (sigSeen.current && sigSeen.current !== sig && atLatest) {
      // A session that just reached the archive may carry a long inherited history (a fork): take its latest page.
      if (sigSeen.current[0] === 's' && sig[0] === 'a') load(undefined)
      else refreshTail()
    }
    sigSeen.current = sig
  }, [sig, loading, atLatest, refreshTail, load])
  useEffect(() => {
    sigSeen.current = ''
  }, [id])

  // ----- forks: where this session came from
  const forkOf = session?.forkOf || meta?.fork_of
  const forkKind: ForkKind | undefined = session?.forkKind || meta?.fork_kind
  const parent = forkOf ? all.find((s) => s.id === forkOf) : undefined
  const parentTitle = parent ? displayTitle(parent, metaMap[parent.id]) : ''
  const forkTs = meta?.fork_ts || 0

  // Until the archive has indexed a fork, its inherited history is read from the parent.
  const [borrowed, setBorrowed] = useState<Msg[]>([])
  const borrowFrom = session?.synthetic && !side ? session.forkOf : undefined
  const borrowOrd = session?.forkOrd
  useEffect(() => {
    setBorrowed([])
    if (!borrowFrom) return
    let live = true
    api.messages(borrowFrom, { limit: PAGE, before: borrowOrd }).then((d) => {
      if (live) setBorrowed(d.messages.map((m) => ({ ...m, key: 'p' + m.ord, ord: -2, inherited: true })))
    }).catch(() => {})
    return () => { live = false }
  }, [borrowFrom, borrowOrd])

  const own: Msg[] = useMemo(() => {
    if (!forkTs) return archive
    const marked = archive.map((m) => (m.ts && ms(m.ts) < forkTs ? { ...m, inherited: true } : m))
    return side ? marked.filter((m) => !m.inherited) : marked
  }, [archive, forkTs, side])

  // ----- live overlay
  const unmerged = useMemo(() => runs.filter((r) => !merged.has(r.id)), [runs, merged])
  useEffect(() => {
    for (const r of unmerged) ensureEvents(r.id)
  }, [unmerged])

  const full: Msg[] = useMemo(() => {
    let cut = Infinity
    for (const r of unmerged) if (r.started_ts) cut = Math.min(cut, r.started_ts - 1500)
    // Runs can follow each other without a pause (a queued message). What an earlier run said is
    // already in the archive and is never part of the next one, however close together they are.
    let floor = 0
    for (const r of runs) if (merged.has(r.id) && r.last_ts) floor = Math.max(floor, r.last_ts)
    if (cut !== Infinity) cut = Math.max(cut, floor + 1)
    const base = cut === Infinity ? own : own.filter((m) => !m.ts || m.inherited || ms(m.ts) < cut)
    if (!unmerged.length || !atLatest) return base
    const live = unmerged.flatMap((r) => runToMsgs(r, events[r.id] || []))
    return [...borrowed, ...base, ...live]
  }, [own, borrowed, unmerged, runs, merged, events, atLatest])

  // ----- rewrites: an edited or retried message replaces what followed it, in this same session.
  // The transcript keeps the replaced turns (the archive lists them in the order they were written),
  // so they are folded away here, using what the machine said it left behind.
  const rewinds = meta?.rewinds
  const [cutting, setCutting] = useState<{ run: string; key: string } | null>(null)
  const [oldOpen, setOldOpen] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setCutting(null)
    setOldOpen(new Set())
  }, [id])
  const marked: Msg[] = useMemo(() => {
    const cuts = (rewinds || []).filter((r) => r.to > r.from)
    // A message being rewritten right now, until the machine has said where it cut.
    const cutRun = cutting ? runs.find((r) => r.id === cutting.run) : undefined
    const pending = cutting && cutRun && !isTerminal(cutRun) && !cuts.some((r) => r.run === cutting.run) ? cutting : null
    if (!cuts.length && !pending) return full
    const byId = new Map(runs.map((r) => [r.id, r]))
    let after = false
    return full.map((m) => {
      if (pending && msgKey(m) === pending.key) after = true
      const own = m.live && m.key ? byId.get(m.key.slice(0, m.key.lastIndexOf(':'))) : undefined
      let gone = false
      if (own) {
        // Still shown live, not from the archive: replaced when a later run rewound to before it.
        const last = own.last_ts || own.started_ts || own.created
        gone = cuts.some((r) => (byId.get(r.run)?.created || 0) > own.created && last >= r.from - 1500)
      } else if (!m.live) {
        const at = ms(m.ts)
        gone = !!at && cuts.some((r) => at >= r.from && at < r.to)
      }
      if (!gone && after && pending) gone = !(m.key || '').startsWith(pending.run + ':')
      return gone ? { ...m, dropped: true } : m
    })
  }, [full, rewinds, cutting, runs])
  const current = useMemo(() => marked.filter((m) => !m.dropped), [marked])

  // ----- branching: "from here" trims the view to that point until the first message is sent
  const [branch, setBranch] = useState<{ next?: Msg } | null>(null)
  const display = useMemo(() => {
    let list = marked
    if (branch?.next) {
      const i = list.indexOf(branch.next)
      if (i >= 0) list = list.slice(0, i)
    }
    if (!list.some((m) => m.dropped)) return list
    const out: Msg[] = []
    for (let i = 0; i < list.length; ) {
      if (!list[i].dropped) {
        out.push(list[i++])
        continue
      }
      let j = i
      while (j < list.length && list[j].dropped) j++
      const key = 'old:' + msgKey(list[i])
      const open = oldOpen.has(key)
      const n = list.slice(i, j).filter((m) => m.role === 'user' && !m.sys && m.text.trim()).length
      out.push({ ord: -3, role: 'fold', text: '', key, fold: { n, open } })
      if (open) out.push(...list.slice(i, j))
      i = j
    }
    return out
  }, [marked, branch, oldOpen])
  const toggleOld = useCallback((key: string) => {
    stick.current = false
    setOldOpen((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const active = runs.find((r) => !isTerminal(r))
  const lastRun = runs[runs.length - 1]
  const failedRun = lastRun && !merged.has(lastRun.id) && (lastRun.status === 'error' || lastRun.status === 'lost') ? lastRun : undefined

  // ----- scrolling: stay at the bottom while following, keep position when loading older messages
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevHeight = useRef(0)
  const restore = useRef(false)
  const [showJump, setShowJump] = useState(false)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (restore.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      restore.current = false
    } else if (focus !== undefined && !loading) {
      const target = el.querySelector(`[data-ord="${focus}"]`) as HTMLElement | null
      if (target) {
        el.scrollTop = Math.max(0, target.offsetTop - 120)
        stick.current = false
      }
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [display, loading, focus])

  const loadMore = useCallback(async () => {
    if (loadingMore || !more || !archive.length) return
    setLoadingMore(true)
    try {
      const d = await api.messages(id, { before: archive[0].ord, limit: PAGE })
      const el = scroller.current
      if (el) {
        prevHeight.current = el.scrollHeight
        restore.current = true
      }
      setArchive((a) => [...d.messages, ...a])
      setMore(d.more)
    } catch {
      /* ignore; the button stays */
    } finally {
      setLoadingMore(false)
    }
  }, [id, archive, more, loadingMore])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = fromBottom < 140
    setShowJump(fromBottom > 600)
    if (el.scrollTop < 120 && more && !loadingMore && !loading) loadMore()
  }

  const jumpLatest = () => {
    stick.current = true
    setFocus(undefined)
    if (!atLatest) load(undefined)
    else {
      const el = scroller.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }

  // ----- header state, side panel
  const [renaming, setRenaming] = useState(false)
  const [pane, setPane] = usePersisted<Pane>('atrium.pane', '')
  const [thread, setThreadS] = useState<string>(() => lastThread.get(id) || '')
  useEffect(() => { setThreadS(lastThread.get(id) || '') }, [id])
  const setThread = (k: string) => { lastThread.set(id, k); setThreadS(k) }
  const [focusSignal, setFocusSignal] = useState(0)

  // Keyboard shortcuts and the app's menu bar reach the open conversation through this event.
  const cmdRef = useRef<(c: string) => void>(() => {})
  useEffect(() => {
    if (side) return
    const on = (e: Event) => cmdRef.current((e as CustomEvent).detail)
    window.addEventListener('atrium:cmd', on)
    return () => window.removeEventListener('atrium:cmd', on)
  }, [side])

  if (!session) {
    return (
      <div className="main">
        <div className="empty">
          <div className="empty-title">{t('找不到这个会话', 'Session not found')}</div>
          <div className="empty-sub">{t('它可能还没同步到存档，或者已经被隐藏。', 'It may not be archived yet, or it was hidden.')}</div>
          <button className="btn" onClick={onBack}>{t('返回列表', 'Back to the list')}</button>
        </div>
      </div>
    )
  }

  const title = displayTitle(session, meta)
  const agentName = session.agent === 'codex' ? 'Codex' : 'Claude'
  const mlabel = machine?.label || machineLabel(machines, session.machine)

  let blocked = ''
  if (session.agent !== 'claude' && session.agent !== 'codex') blocked = t('这种会话暂时只能查看。', 'This kind of session is view-only for now.')
  else if (!machine?.runner) blocked = t(`"${mlabel}"还没有接入操控，这里只能查看历史。`, `${mlabel} has no runner, so this is history only.`)
  else if (!machine.online) blocked = t(`"${machine.label}"现在不在线，等它上线后就能继续。`, `${machine.label} is offline. You can continue once it is back.`)
  else if (session.synthetic && !session.nid && !active) blocked = t('这个会话没有成功启动，请新建一个。', 'This session never started. Please start a new one.')

  // ----- sending, forking
  const known = !session.synthetic || !!session.nid // the session has an id the machine knows
  let forkWhy = ''
  if (blocked) forkWhy = blocked
  else if (!canFork(machine)) forkWhy = t(`"${mlabel}"上的 runner 版本较旧，更新后才能分叉、编辑和重试。`, `The runner on ${mlabel} is too old for this. Update it to fork, edit and retry.`)
  else if (!known) forkWhy = t('等这个会话启动完再试。', 'Wait until this session has started.')
  const forkOK = !forkWhy
  const cutOK = forkOK && session.agent === 'claude'

  const send = async (prompt: string) => {
    if (branch) {
      const run = await fork('branch', prompt, branch.next)
      setBranch(null)
      onOpen(`run:${run.id}`)
      return
    }
    const d = await api.createRun({ session_id: session.id, prompt, ...prefs.run })
    stick.current = true
    putRun(d.run)
  }

  const fork = async (kind: ForkKind, prompt: string, before?: Msg, forkTitle?: string) => {
    const cut = !before ? {} : before.live ? { before_text: before.text } : { before_ts: before.ts, before_text: before.text, before_ord: before.ord >= 0 ? before.ord : undefined }
    const base = title.replace(/\s*[（(](分支|branch)[)）]$/i, '')
    const d = await api.createRun({
      prompt, ...prefs.run,
      fork: { session_id: session.id, kind, ...cut, title: forkTitle ?? t(`${base}（分支）`, `${base} (branch)`) },
    })
    putRun(d.run)
    return d.run
  }

  const guarded = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e: any) {
      toast(e.message || t('没有成功', 'That did not work'))
    }
  }

  // Edit / try again: the session itself goes on from just before that message. Where that cannot be
  // done (the first message of a session, an older runner) it becomes a new session, as it used to.
  const rewindOK = cutOK && hasFeature(machine, 'rewind')
  const rewrite = async (kind: 'edit' | 'retry', m: Msg, text: string) => {
    const i = current.indexOf(m)
    const own = m.live && m.key ? runs.find((r) => r.id === m.key!.slice(0, m.key!.lastIndexOf(':'))) : undefined
    if (own && isTerminal(own) && !own.last_ts && i === current.map((x) => x.role === 'user' && !x.sys).lastIndexOf(true)) {
      // The last message never reached the machine (its run failed before starting): just send it.
      await send(text)
      return
    }
    const answered = more || current.slice(0, Math.max(i, 0)).some((x) => x.role === 'assistant')
    if (!rewindOK || !answered) {
      const run = await fork(kind, text, m)
      onOpen(`run:${run.id}`)
      return
    }
    const cut = m.live ? { before_text: m.text } : { before_ts: m.ts, before_text: m.text }
    const d = await api.createRun({ session_id: session.id, prompt: text, ...prefs.run, rewind: cut })
    setCutting({ run: d.run.id, key: msgKey(m) })
    stick.current = true
    putRun(d.run)
  }

  const actions: TranscriptActions | undefined = side ? undefined : {
    busy: !!active,
    canFork: forkOK,
    canCut: cutOK,
    why: forkWhy,
    onEdit: (m, text) => rewrite('edit', m, text),
    onRetry: (m) => guarded(() => rewrite('retry', m, cleanUserText(m.text))),
    onBranch: async (next) => {
      if (!forkOK) return toast(forkWhy)
      setBranch({ next })
      setFocus(undefined)
      stick.current = true
      setFocusSignal((x) => x + 1)
    },
  }

  const stop = async () => {
    if (!active) return
    try {
      const d = await api.stop(active.id)
      putRun(d.run)
    } catch (e: any) {
      toast(e.message || t('停止失败', 'Could not stop'))
    }
  }

  const openSide = (firstMessage?: string) => {
    setPane('side')
    if (firstMessage) guarded(() => startSide(firstMessage))
  }
  const startSide = async (prompt: string) => {
    const run = await fork('side', prompt, undefined, t('边聊：', 'Side: ') + clipText(prompt, 40))
    setThread(`run:${run.id}`)
  }
  // "!command" in the message box: typed into the session's terminal, as if you had typed it there.
  const shell = (cmd: string) => {
    setPane('terminal')
    if (hasShell(machine)) sendToTerminal(session.id, cmd + '\n')
  }
  const lastUser = [...current].reverse().find((m) => m.role === 'user' && !m.sys && m.text.trim())

  const appCommands: AppCommand[] = side ? [] : [
    { name: 'new', description: t('开始一个新会话', 'Start a new session'), run: () => onNew?.() },
    { name: 'fork', description: t('从当前位置分叉出一个新会话', 'Branch off into a new session from here'), disabled: forkWhy, run: () => actions!.onBranch() },
    { name: 'side', description: t('边聊：问个旁支问题，不写进这个会话', 'Side chat: ask something without adding it to this session'), disabled: forkWhy, run: (arg) => openSide(arg) },
    { name: 'retry', description: t('重新生成上一条回复（在新分支里）', 'Try the last message again (in a new branch)'), disabled: cutOK ? (lastUser && !active ? '' : t('现在没有可以重试的消息', 'Nothing to retry right now')) : forkWhy || t('Codex 会话只能从末尾分叉', 'Codex sessions can only fork from the end'), run: () => lastUser && actions!.onRetry(lastUser) },
    { name: 'terminal', description: t('打开这台机器上的终端', 'Open a terminal on this machine'), run: () => setPane('terminal') },
    { name: 'files', description: t('浏览和编辑会话目录里的文件', "Browse and edit files in the session's folder"), run: () => setPane('files') },
    { name: 'model', description: t('换一个模型', 'Choose a model'), run: (arg) => { if (arg) prefs.setModel(arg) } },
    { name: 'effort', description: t('调整思考强度', 'Set the reasoning effort'), run: (arg) => { if (prefs.efforts.includes(arg)) prefs.setEffort(arg); else if (arg) toast(t(`这个模型的思考强度可以是：${prefs.efforts.join('、') || '（不可调）'}`, `This model takes: ${prefs.efforts.join(', ') || '(none)'}`)) } },
    { name: 'stop', description: t('停止正在运行的这一轮', 'Stop the run in flight'), disabled: active ? '' : t('现在没有在运行', 'Nothing is running'), run: stop },
    { name: 'rename', description: t('给这个会话改名', 'Rename this session'), run: (arg) => (arg ? setMeta(id, { title: arg }) : setRenaming(true)) },
    { name: 'pin', description: meta?.pinned ? t('取消置顶', 'Unpin') : t('置顶这个会话', 'Pin this session'), run: () => setMeta(id, { pinned: !meta?.pinned }) },
    { name: 'copy-resume', description: t('复制在终端里恢复这个会话的命令', 'Copy the command that resumes this session in a terminal'), run: () => { copyText(resumeCommand(session)); toast(t('已复制，可在那台机器的终端里粘贴运行', 'Copied. Paste it into a terminal on that machine')) } },
    { name: 'search', description: t('搜索所有对话', 'Search every conversation'), run: () => onSearch?.() },
  ]

  cmdRef.current = (c) => {
    if (c === 'side') setPane(pane === 'side' ? '' : 'side')
    else if (c === 'terminal') setPane(pane === 'terminal' ? '' : 'terminal')
    else if (c === 'files') setPane(pane === 'files' ? '' : 'files')
    else if (c === 'fork') actions?.onBranch()
    else if (c === 'focus') setFocusSignal((x) => x + 1)
  }

  // Heads-up when the session was just written to by something other than us.
  const lastEndedMs = ms(session.ended)
  const recentElsewhere = !active && runs.length === 0 && lastEndedMs > 0 && Date.now() - lastEndedMs < 120_000

  const before = (
    <>
      {branch && (
        <div className="hint fork">
          <Icon name="branch" size={15} />
          <span>{t('下一条消息会开出一个新分支，这个会话保持原样。', 'Your next message starts a new branch. This session stays as it is.')}</span>
          <button className="linkbtn" onClick={() => setBranch(null)}>{t('取消', 'Cancel')}</button>
        </div>
      )}
      {recentElsewhere && !blocked && !branch && (
        <div className="hint warn">{t('这个会话一两分钟前还在别处更新，可能正在另一个窗口里运行。两边同时发消息会让记录错乱，建议先停掉那边。', 'This session changed elsewhere a minute or two ago and may still be running in another window. Writing from both places scrambles the transcript, so stop it there first.')}</div>
      )}
    </>
  )

  const body = (
    <>
      <div className="scroller" ref={scroller} onScroll={onScroll}>
        <div className="column">
          {loading && <div className="loading"><Spinner size={18} /> {t('正在加载…', 'Loading…')}</div>}
          {err && (
            <div className="note error">
              <Icon name="alert" size={15} />
              <span>{err}</span>
              <button className="linkbtn" onClick={() => load(focus)}>{t('重试', 'Retry')}</button>
            </div>
          )}
          {!loading && more && !side && (
            <div className="loadmore">
              <button className="linkbtn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? t('加载中…', 'Loading…') : t('加载更早的消息', 'Load earlier messages')}</button>
            </div>
          )}
          {!loading && !err && display.length === 0 && !side && <div className="loading">{t('这个会话还没有内容。', 'Nothing in this session yet.')}</div>}
          {side && !loading && (
            <div className="forkmark"><span><Icon name="sidechat" size={13} />{t('从主对话的当时位置分出，不会写回主对话', 'Split off from the main conversation; nothing here is written back')}</span></div>
          )}
          <Transcript
            msgs={display}
            sessionId={session.synthetic ? undefined : id}
            focusOrd={focus}
            actions={actions}
            onFold={toggleOld}
            inheritLabel={parentTitle ? t(`以上继承自「${parentTitle}」`, `Everything above comes from “${parentTitle}”`) : undefined}
          />
          {!atLatest && !loading && (
            <div className="loadmore">
              <button className="btn" onClick={jumpLatest}>{t('正在查看较早的位置 · 回到最新', 'Viewing an earlier point · Jump to latest')}</button>
            </div>
          )}
          {failedRun && atLatest && !branch && (
            <div className="note error">
              <Icon name="alert" size={15} />
              <span>{runError(failedRun) || t('这次运行没有成功', 'This run did not succeed')}</span>
              {!blocked && known && (
                <button className="linkbtn" onClick={() => guarded(() => send(failedRun.prompt))}>{t('重试', 'Retry')}</button>
              )}
            </div>
          )}
          {active && atLatest && !branch && <RunStatus run={active} />}
          <div className="bottom-pad" />
        </div>
      </div>

      {showJump && (
        <button className="jump" onClick={jumpLatest} title={t('回到最新', 'Jump to latest')}><Icon name="down" size={18} /></button>
      )}

      <Composer
        draftKey={session.id}
        placeholder={
          branch ? t('在新分支里说点什么…', 'Say something in the new branch…')
            : side ? t('接着边聊…', 'Continue the side chat…')
              : t(`回复 ${mlabel} 上的 ${agentName}…`, `Reply to ${agentName} on ${mlabel}…`)
        }
        busy={!!active && !branch}
        blocked={blocked}
        prefs={prefs}
        machine={machine}
        agent={session.agent}
        appCommands={appCommands}
        onSend={send}
        onStop={stop}
        onShell={side ? undefined : shell}
        before={before}
        compact={side}
        focusSignal={focusSignal}
      />
    </>
  )

  if (side) return <div className="main side">{body}</div>

  const dot = machine?.runner ? (machine.online ? 'on' : 'off') : 'none'
  return (
    <div className={'session' + (pane ? ' with-pane' : '')}>
      <div className="main">
        <header className="chat-head" data-drag>
          {sidebarHidden && <button className="iconbtn" onClick={onShowSidebar} title={t('显示侧栏', 'Show sidebar') + ' ' + kbd('B')}><Icon name="sidebar" size={18} /></button>}
          <button className="iconbtn only-mobile" onClick={onBack} title={t('返回列表', 'Back to the list')}><Icon name="back" size={18} /></button>
          <div className="chat-title">
            {renaming ? (
              <input
                autoFocus
                className="rename"
                defaultValue={title}
                onBlur={(e) => {
                  setRenaming(false)
                  const v = e.target.value.trim()
                  if (v !== title) setMeta(id, { title: v === session.title ? '' : v })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !imeKey(e)) (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(false)
                }}
              />
            ) : (
              <h1 title={t('双击改名', 'Double-click to rename')} onDoubleClick={() => setRenaming(true)}>{title}</h1>
            )}
            <div className="chat-sub">
              <AgentTag agent={session.agent} />
              <span className="mach"><span className={'dot ' + dot} />{mlabel}</span>
              {session.cwd && <span className="path" title={session.cwd}>{shortPath(session.cwd)}</span>}
              {forkOf && (
                <button className="forkchip" onClick={() => parent && onOpen(parent.id)} disabled={!parent} title={t('打开原会话', 'Open the original session')}>
                  <Icon name={forkKind === 'side' ? 'sidechat' : 'branch'} size={12} />
                  {forkKind === 'side' ? t('边聊自', 'Side chat of') : t('分支自', 'Branch of')} {parentTitle || t('原会话', 'the original')}
                </button>
              )}
              {session.started && <span className="when">{fullTime(ms(session.started))}</span>}
            </div>
          </div>
          <div className="chat-actions">
            <button className={'iconbtn' + (branch ? ' active' : '') + (forkOK ? '' : ' off')} title={forkOK ? t('分叉：从当前位置开一个新会话', 'Fork: branch off into a new session from here') : forkWhy} onClick={() => (branch ? setBranch(null) : actions!.onBranch())}>
              <Icon name="branch" size={17} />
            </button>
            <button className={'iconbtn' + (pane === 'side' ? ' active' : '')} title={t('边聊', 'Side chat') + ' ' + kbd('.')} onClick={() => setPane(pane === 'side' ? '' : 'side')}>
              <Icon name="sidechat" size={17} />
            </button>
            <button className={'iconbtn' + (pane === 'terminal' ? ' active' : '')} title={t('终端', 'Terminal') + ' ' + kbd('J')} onClick={() => setPane(pane === 'terminal' ? '' : 'terminal')}>
              <Icon name="terminal" size={17} />
            </button>
            <button className={'iconbtn' + (pane === 'files' ? ' active' : '')} title={t('文件', 'Files') + ' ' + kbd('E')} onClick={() => setPane(pane === 'files' ? '' : 'files')}>
              <Icon name="folder" size={17} />
            </button>
            <Dropdown align="right" className="iconbtn" title={t('更多', 'More')} button={<Icon name="dots" size={18} />}>
              {(close) => (
                <>
                  <MenuItem icon="pin" label={meta?.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')} onClick={() => { close(); setMeta(id, { pinned: !meta?.pinned }) }} />
                  <MenuItem icon="edit" label={t('改名', 'Rename')} onClick={() => { close(); setRenaming(true) }} />
                  <MenuSep />
                  {!session.synthetic && (
                    <MenuItem icon="terminal" label={t('复制终端恢复命令', 'Copy terminal resume command')} onClick={() => { close(); copyText(resumeCommand(session)); toast(t('已复制，可在那台机器的终端里粘贴运行', 'Copied. Paste it into a terminal on that machine')) }} />
                  )}
                  <MenuItem icon="copy" label={t('复制会话 ID', 'Copy session ID')} onClick={() => { close(); copyText(session.nid || session.id); toast(t('已复制会话 ID', 'Session ID copied')) }} />
                  <MenuSep />
                  <MenuItem icon={meta?.hidden ? 'eye' : 'eyeoff'} label={meta?.hidden ? t('取消隐藏', 'Unhide') : t('从列表隐藏', 'Hide from the list')}
                    onClick={() => { close(); setMeta(id, { hidden: !meta?.hidden }); toast(meta?.hidden ? t('已恢复显示', 'Back in the list') : t('已隐藏，可在侧栏的筛选里找回', 'Hidden. Find it again under the sidebar filter')) }} />
                </>
              )}
            </Dropdown>
          </div>
        </header>
        {body}
      </div>
      {pane && (
        <SidePane
          tab={pane}
          setTab={setPane}
          session={session}
          machine={machine}
          thread={thread}
          setThread={setThread}
          forkWhy={forkWhy}
          prefs={prefs}
          onStartSide={startSide}
          onOpen={onOpen}
        />
      )}
    </div>
  )
}

// ---------- run status + permission ----------

function RunStatus({ run }: { run: Run }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.floor((Date.now() - run.created) / 1000))
  const elapsed = secs >= 60 ? t(`${Math.floor(secs / 60)} 分 ${secs % 60} 秒`, `${Math.floor(secs / 60)}m ${secs % 60}s`) : t(`${secs} 秒`, `${secs}s`)
  return (
    <div className="runstatus">
      {run.perm ? <PermissionCard run={run} perm={run.perm} /> : (
        <div className="running-line">
          <span className="pulse" />
          <span className="shimmer">{statusText[run.status] || run.status}</span>
          <span className="dim">{elapsed}</span>
        </div>
      )}
    </div>
  )
}

function PermissionCard({ run, perm }: { run: Run; perm: PermReq }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const tool = { name: perm.tool_name, input: '', inputObj: perm.input }
  const v = toolView(tool)
  const obj = parseInput(tool)
  const isQuestion = perm.tool_name === 'AskUserQuestion' && Array.isArray(obj?.questions)
  const canAlways = Array.isArray(perm.suggestions) && perm.suggestions.length > 0

  const answer = async (behavior: 'allow' | 'deny', always = false) => {
    setBusy(true)
    setErr('')
    try {
      let input: any = undefined
      if (isQuestion && behavior === 'allow') {
        const a: Record<string, string> = {}
        for (const q of obj.questions) a[q.question] = (answers[q.question] || []).join(', ')
        input = { ...obj, answers: a }
      }
      await api.permission(run.id, { request_id: perm.request_id, behavior, always, input, message: behavior === 'deny' ? 'The user denied this action in Atrium.' : undefined })
    } catch (e: any) {
      setErr(e.message || t('发送失败', 'Could not send'))
      setBusy(false)
    }
  }

  if (isQuestion) {
    const ready = obj.questions.every((q: any) => (answers[q.question] || []).length > 0)
    return (
      <div className="perm">
        <div className="perm-head"><Icon name="question" size={16} />{t('需要你回答', 'Needs your answer')}</div>
        {obj.questions.map((q: any, i: number) => (
          <div key={i} className="perm-q">
            <div className="q">{q.question}</div>
            <div className="opts">
              {(q.options || []).map((o: any, j: number) => {
                const sel = (answers[q.question] || []).includes(o.label)
                return (
                  <button
                    key={j}
                    className={'opt' + (sel ? ' sel' : '')}
                    onClick={() =>
                      setAnswers((a) => {
                        const cur = a[q.question] || []
                        const next = q.multiSelect ? (sel ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label]
                        return { ...a, [q.question]: next }
                      })
                    }
                  >
                    <b>{o.label}</b>
                    {o.description && <span>{o.description}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        {err && <div className="perm-err">{err}</div>}
        <div className="perm-actions">
          <button className="btn primary" disabled={busy || !ready} onClick={() => answer('allow')}>{t('提交回答', 'Submit')}</button>
          <button className="btn" disabled={busy} onClick={() => answer('deny')}>{t('跳过', 'Skip')}</button>
        </div>
      </div>
    )
  }

  const cmd = v.kind === 'bash' ? commandOf(tool, obj) : ''
  return (
    <div className="perm">
      <div className="perm-head"><Icon name="shield" size={16} />{t('需要你确认：', 'Needs your OK: ')}{v.label}</div>
      {perm.description && <div className="perm-desc">{perm.description}</div>}
      {cmd ? (
        <pre className="pre cmd">{cmd}</pre>
      ) : v.kind === 'edit' || v.kind === 'write' ? (
        <>
          <div className="pathline">{obj?.file_path || obj?.path || ''}</div>
          {obj?.old_string !== undefined ? (
            <div className="diff">
              {String(obj.old_string).split('\n').map((l: string, i: number) => <div key={'o' + i} className="del">{'- ' + l}</div>)}
              {String(obj.new_string ?? '').split('\n').map((l: string, i: number) => <div key={'n' + i} className="add">{'+ ' + l}</div>)}
            </div>
          ) : (
            <pre className="pre out">{String(obj?.content ?? '').slice(0, 4000)}</pre>
          )}
        </>
      ) : (
        <pre className="pre cmd">{JSON.stringify(perm.input ?? {}, null, 2).slice(0, 4000)}</pre>
      )}
      {err && <div className="perm-err">{err}</div>}
      <div className="perm-actions">
        <button className="btn primary" disabled={busy} onClick={() => answer('allow')}>{t('允许', 'Allow')}</button>
        {canAlways && <button className="btn" disabled={busy} onClick={() => answer('allow', true)}>{t('允许，这类以后不再问', "Allow, and don't ask again for this")}</button>}
        <button className="btn danger" disabled={busy} onClick={() => answer('deny')}>{t('拒绝', 'Deny')}</button>
      </div>
    </div>
  )
}

