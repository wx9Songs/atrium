// The conversation page: history from the archive, live output of runs
// started here, and a message box to keep working.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, Msg, PermReq, Run, Session } from './api'
import { allSessions, runsOf } from './derive'
import { AgentTag, Icon, Spinner } from './icons'
import { runToMsgs } from './live'
import { ensureEvents, isTerminal, putRun, setMeta, useStore } from './store'
import { toolView, commandOf, parseInput } from './tools'
import { Transcript } from './Transcript'
import {
  copyText, displayTitle, fullTime, imeKey, machineLabel, modeOptions, ms, resumeCommand, runCoveredByArchive, shortPath, statusText,
} from './util'
import { lang, t } from './i18n'

const PAGE = 80

/** Run errors are stored in both languages; older ones only in Chinese. */
export const runError = (r: Run) => (lang === 'zh' ? r.error_zh || r.error : r.error) || ''

export function SessionView({ id, focusOrd, onBack }: { id: string; focusOrd?: number; onBack: () => void }) {
  const sessions = useStore((s) => s.sessions)
  const runsMap = useStore((s) => s.runs)
  const events = useStore((s) => s.events)
  const machines = useStore((s) => s.machines)
  const metaMap = useStore((s) => s.meta)

  const session: Session | undefined = useMemo(() => allSessions(sessions, runsMap).find((s) => s.id === id), [sessions, runsMap, id])
  const runs = useMemo(() => runsOf(id, runsMap), [id, runsMap])
  const meta = metaMap[id]

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
    if (sigSeen.current && sigSeen.current !== sig && atLatest) refreshTail()
    sigSeen.current = sig
  }, [sig, loading, atLatest, refreshTail])
  useEffect(() => {
    sigSeen.current = ''
  }, [id])

  // ----- live overlay
  const unmerged = useMemo(() => runs.filter((r) => !merged.has(r.id)), [runs, merged])
  useEffect(() => {
    for (const r of unmerged) ensureEvents(r.id)
  }, [unmerged])

  const display: Msg[] = useMemo(() => {
    let cut = Infinity
    for (const r of unmerged) if (r.started_ts) cut = Math.min(cut, r.started_ts - 1500)
    const base = cut === Infinity ? archive : archive.filter((m) => !m.ts || ms(m.ts) < cut)
    if (!unmerged.length || !atLatest) return base
    const live = unmerged.flatMap((r) => runToMsgs(r, events[r.id] || []))
    return [...base, ...live]
  }, [archive, unmerged, events, atLatest])

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

  // ----- header actions
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState(false)
  const [toast, setToast] = useState('')
  const flash = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 1600)
  }

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

  const machine = machines.find((m) => m.name === session.machine)
  const title = displayTitle(session, meta)

  return (
    <div className="main">
      <header className="chat-head">
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
            <span className="mach">
              <span className={'dot ' + (machine?.runner ? (machine.online ? 'on' : 'off') : 'none')} />
              {machineLabel(machines, session.machine)}
            </span>
            {session.cwd && <span className="path" title={session.cwd}>{shortPath(session.cwd)}</span>}
            {session.started && <span className="when">{t(`${fullTime(ms(session.started))} 开始`, `started ${fullTime(ms(session.started))}`)}</span>}
          </div>
        </div>
        <div className="chat-actions">
          <button className={'iconbtn' + (meta?.pinned ? ' active' : '')} title={meta?.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')} onClick={() => setMeta(id, { pinned: !meta?.pinned })}>
            <Icon name="pin" size={17} />
          </button>
          <div className="menu-wrap">
            <button className="iconbtn" title={t('更多', 'More')} onClick={() => setMenu(!menu)}><Icon name="dots" size={18} /></button>
            {menu && (
              <>
                <div className="menu-back" onClick={() => setMenu(false)} />
                <div className="menu">
                  <button onClick={() => { setMenu(false); setRenaming(true) }}><Icon name="edit" size={15} />{t('改名', 'Rename')}</button>
                  {!session.synthetic && (
                    <button onClick={() => { setMenu(false); copyText(resumeCommand(session)); flash(t('已复制，可在那台机器的终端里粘贴运行', 'Copied. Paste it into a terminal on that machine')) }}>
                      <Icon name="terminal" size={15} />{t('复制终端恢复命令', 'Copy terminal resume command')}
                    </button>
                  )}
                  <button onClick={() => { setMenu(false); copyText(session.nid || session.id); flash(t('已复制会话 ID', 'Session ID copied')) }}>
                    <Icon name="copy" size={15} />{t('复制会话 ID', 'Copy session ID')}
                  </button>
                  <button onClick={() => { setMenu(false); setMeta(id, { hidden: !meta?.hidden }); flash(meta?.hidden ? t('已恢复显示', 'Back in the list') : t('已隐藏，可在侧栏底部"显示隐藏的会话"里找回', 'Hidden. Find it again under "Show hidden sessions" at the bottom of the sidebar')) }}>
                    <Icon name={meta?.hidden ? 'eye' : 'eyeoff'} size={15} />{meta?.hidden ? t('取消隐藏', 'Unhide') : t('从列表隐藏', 'Hide from the list')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

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
          {!loading && more && (
            <div className="loadmore">
              <button className="linkbtn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? t('加载中…', 'Loading…') : t('加载更早的消息', 'Load earlier messages')}</button>
            </div>
          )}
          {!loading && !err && display.length === 0 && <div className="loading">{t('这个会话还没有内容。', 'Nothing in this session yet.')}</div>}
          <Transcript msgs={display} sessionId={session.synthetic ? undefined : id} focusOrd={focus} />
          {!atLatest && !loading && (
            <div className="loadmore">
              <button className="btn" onClick={jumpLatest}>{t('正在查看较早的位置 · 回到最新', 'Viewing an earlier point · Jump to latest')}</button>
            </div>
          )}
          {failedRun && atLatest && (
            <div className="note error">
              <Icon name="alert" size={15} />
              <span>{runError(failedRun) || t('这次运行没有成功', 'This run did not succeed')}</span>
            </div>
          )}
          {active && atLatest && <RunStatus run={active} />}
          <div className="bottom-pad" />
        </div>
      </div>

      {showJump && (
        <button className="jump" onClick={jumpLatest} title={t('回到最新', 'Jump to latest')}><Icon name="down" size={18} /></button>
      )}
      {toast && <div className="toast">{toast}</div>}

      <Composer session={session} active={active} lastEndedMs={ms(session.ended)} hasHubRuns={runs.length > 0} />
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
          <Spinner size={14} />
          <span>{statusText[run.status] || run.status}</span>
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

// ---------- message box ----------

function Composer({ session, active, lastEndedMs, hasHubRuns }: { session: Session; active?: Run; lastEndedMs: number; hasHubRuns: boolean }) {
  const machines = useStore((s) => s.machines)
  const machine = machines.find((m) => m.name === session.machine)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const modeKey = 'sh.mode.' + session.agent
  const options = modeOptions(session.agent)
  const [mode, setMode] = useState(() => {
    const v = localStorage.getItem(modeKey) || 'machine'
    return options.some((o) => o.value === v) ? v : 'machine'
  })
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText(localStorage.getItem('sh.draft.' + session.id) || '')
    setErr('')
  }, [session.id])
  useEffect(() => {
    if (text) localStorage.setItem('sh.draft.' + session.id, text)
    else localStorage.removeItem('sh.draft.' + session.id)
    const el = ta.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px'
    }
  }, [text, session.id])

  let blocked = ''
  if (session.agent !== 'claude' && session.agent !== 'codex') blocked = t('这种会话暂时只能查看。', 'This kind of session is view-only for now.')
  else if (!machine?.runner) blocked = t(`"${machineLabel(machines, session.machine)}"还没有接入操控，这里只能查看历史。`, `${machineLabel(machines, session.machine)} has no runner, so this is history only.`)
  else if (!machine.online) blocked = t(`"${machine.label}"现在不在线，等它上线后就能继续。`, `${machine.label} is offline. You can continue once it is back.`)
  else if (session.synthetic && !session.nid && !active) blocked = t('这个会话没有成功启动，请新建一个。', 'This session never started. Please start a new one.')

  // Heads-up when the session was just written to by something other than us.
  const recentElsewhere = !active && !hasHubRuns && lastEndedMs > 0 && Date.now() - lastEndedMs < 120_000

  const send = async () => {
    const prompt = text.trim()
    if (!prompt || busy || active || blocked) return
    setBusy(true)
    setErr('')
    try {
      const d = await api.createRun({ session_id: session.id, prompt, mode })
      putRun(d.run)
      setText('')
    } catch (e: any) {
      setErr(e.message || t('发送失败', 'Could not send'))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!active) return
    try {
      const d = await api.stop(active.id)
      putRun(d.run)
    } catch (e: any) {
      setErr(e.message || t('停止失败', 'Could not stop'))
    }
  }

  return (
    <div className="composer-wrap">
      <div className="column">
        {recentElsewhere && !blocked && (
          <div className="hint warn">{t('这个会话一两分钟前还在别处更新，可能正在另一个窗口里运行。两边同时发消息会让记录错乱，建议先停掉那边。', 'This session changed elsewhere a minute or two ago and may still be running in another window. Writing from both places scrambles the transcript, so stop it there first.')}</div>
        )}
        {err && <div className="hint error">{err}</div>}
        {blocked ? (
          <div className="composer blocked"><Icon name="eye" size={16} />{blocked}</div>
        ) : (
          <div className={'composer' + (active ? ' busy' : '')}>
            <textarea
              ref={ta}
              rows={1}
              value={text}
              placeholder={active ? t('正在运行，结束后可以继续发消息…', 'Running. You can send again when it finishes…') : t(`接着这个会话继续，发给 ${machine?.label || session.machine} 上的 ${session.agent === 'codex' ? 'Codex' : 'Claude'}`, `Continue this session with ${session.agent === 'codex' ? 'Codex' : 'Claude'} on ${machine?.label || session.machine}`)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !imeKey(e)) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="composer-bar">
              <label className="mode" title={options.find((o) => o.value === mode)?.hint}>
                <Icon name="shield" size={14} />
                <select
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value)
                    localStorage.setItem(modeKey, e.target.value)
                  }}
                >
                  {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <span className="grow" />
              <span className="keys">{t('Enter 发送 · Shift+Enter 换行', 'Enter to send · Shift+Enter for a new line')}</span>
              {active ? (
                <button className="sendbtn stop" onClick={stop} title={t('停止', 'Stop')}><Icon name="stop" size={15} /></button>
              ) : (
                <button className="sendbtn" onClick={send} disabled={!text.trim() || busy} title={t('发送', 'Send')}><Icon name="send" size={17} /></button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
