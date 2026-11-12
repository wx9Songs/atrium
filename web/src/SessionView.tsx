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

const PAGE = 80

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
        if (seq === loadSeq.current) setErr(e.message || '加载失败')
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
          <div className="empty-title">找不到这个会话</div>
          <div className="empty-sub">它可能还没同步到存档，或者已经被隐藏。</div>
          <button className="btn" onClick={onBack}>返回列表</button>
        </div>
      </div>
    )
  }

  const machine = machines.find((m) => m.name === session.machine)
  const title = displayTitle(session, meta)

  return (
    <div className="main">
      <header className="chat-head">
        <button className="iconbtn only-mobile" onClick={onBack} title="返回列表"><Icon name="back" size={18} /></button>
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
            <h1 title="双击改名" onDoubleClick={() => setRenaming(true)}>{title}</h1>
          )}
          <div className="chat-sub">
            <AgentTag agent={session.agent} />
            <span className="mach">
              <span className={'dot ' + (machine?.runner ? (machine.online ? 'on' : 'off') : 'none')} />
              {machineLabel(machines, session.machine)}
            </span>
            {session.cwd && <span className="path" title={session.cwd}>{shortPath(session.cwd)}</span>}
            {session.started && <span className="when">{fullTime(ms(session.started))} 开始</span>}
          </div>
        </div>
        <div className="chat-actions">
          <button className={'iconbtn' + (meta?.pinned ? ' active' : '')} title={meta?.pinned ? '取消置顶' : '置顶'} onClick={() => setMeta(id, { pinned: !meta?.pinned })}>
            <Icon name="pin" size={17} />
          </button>
          <div className="menu-wrap">
            <button className="iconbtn" title="更多" onClick={() => setMenu(!menu)}><Icon name="dots" size={18} /></button>
            {menu && (
              <>
                <div className="menu-back" onClick={() => setMenu(false)} />
                <div className="menu">
                  <button onClick={() => { setMenu(false); setRenaming(true) }}><Icon name="edit" size={15} />改名</button>
                  {!session.synthetic && (
                    <button onClick={() => { setMenu(false); copyText(resumeCommand(session)); flash('已复制，可在那台机器的终端里粘贴运行') }}>
                      <Icon name="terminal" size={15} />复制终端恢复命令
                    </button>
                  )}
                  <button onClick={() => { setMenu(false); copyText(session.nid || session.id); flash('已复制会话 ID') }}>
                    <Icon name="copy" size={15} />复制会话 ID
                  </button>
                  <button onClick={() => { setMenu(false); setMeta(id, { hidden: !meta?.hidden }); flash(meta?.hidden ? '已恢复显示' : '已隐藏，可在侧栏底部"显示隐藏的会话"里找回') }}>
                    <Icon name={meta?.hidden ? 'eye' : 'eyeoff'} size={15} />{meta?.hidden ? '取消隐藏' : '从列表隐藏'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="scroller" ref={scroller} onScroll={onScroll}>
        <div className="column">
          {loading && <div className="loading"><Spinner size={18} /> 正在加载…</div>}
          {err && (
            <div className="note error">
              <Icon name="alert" size={15} />
              <span>{err}</span>
              <button className="linkbtn" onClick={() => load(focus)}>重试</button>
            </div>
          )}
          {!loading && more && (
            <div className="loadmore">
              <button className="linkbtn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? '加载中…' : '加载更早的消息'}</button>
            </div>
          )}
          {!loading && !err && display.length === 0 && <div className="loading">这个会话还没有内容。</div>}
          <Transcript msgs={display} sessionId={session.synthetic ? undefined : id} focusOrd={focus} />
          {!atLatest && !loading && (
            <div className="loadmore">
              <button className="btn" onClick={jumpLatest}>正在查看较早的位置 · 回到最新</button>
            </div>
          )}
          {failedRun && atLatest && (
            <div className="note error">
              <Icon name="alert" size={15} />
              <span>{failedRun.error || '这次运行没有成功'}</span>
            </div>
          )}
          {active && atLatest && <RunStatus run={active} />}
          <div className="bottom-pad" />
        </div>
      </div>

      {showJump && (
        <button className="jump" onClick={jumpLatest} title="回到最新"><Icon name="down" size={18} /></button>
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
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`
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
      await api.permission(run.id, { request_id: perm.request_id, behavior, always, input, message: behavior === 'deny' ? '用户在会话中心拒绝了这个操作' : undefined })
    } catch (e: any) {
      setErr(e.message || '发送失败')
      setBusy(false)
    }
  }

  if (isQuestion) {
    const ready = obj.questions.every((q: any) => (answers[q.question] || []).length > 0)
    return (
      <div className="perm">
        <div className="perm-head"><Icon name="question" size={16} />需要你回答</div>
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
          <button className="btn primary" disabled={busy || !ready} onClick={() => answer('allow')}>提交回答</button>
          <button className="btn" disabled={busy} onClick={() => answer('deny')}>跳过</button>
        </div>
      </div>
    )
  }

  const cmd = v.kind === 'bash' ? commandOf(tool, obj) : ''
  return (
    <div className="perm">
      <div className="perm-head"><Icon name="shield" size={16} />需要你确认：{v.label}</div>
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
        <button className="btn primary" disabled={busy} onClick={() => answer('allow')}>允许</button>
        {canAlways && <button className="btn" disabled={busy} onClick={() => answer('allow', true)}>允许，这类以后不再问</button>}
        <button className="btn danger" disabled={busy} onClick={() => answer('deny')}>拒绝</button>
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
  if (session.agent !== 'claude' && session.agent !== 'codex') blocked = '这种会话暂时只能查看。'
  else if (!machine?.runner) blocked = `"${machineLabel(machines, session.machine)}"还没有接入操控，这里只能查看历史。`
  else if (!machine.online) blocked = `"${machine.label}"现在不在线，等它上线后就能继续。`
  else if (session.synthetic && !session.nid && !active) blocked = '这个会话没有成功启动，请新建一个。'

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
      setErr(e.message || '发送失败')
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
      setErr(e.message || '停止失败')
    }
  }

  return (
    <div className="composer-wrap">
      <div className="column">
        {recentElsewhere && !blocked && (
          <div className="hint warn">这个会话一两分钟前还在别处更新，可能正在另一个窗口里运行。两边同时发消息会让记录错乱，建议先停掉那边。</div>
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
              placeholder={active ? '正在运行，结束后可以继续发消息…' : `接着这个会话继续，发给 ${machine?.label || session.machine} 上的 ${session.agent === 'codex' ? 'Codex' : 'Claude'}`}
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
              <span className="keys">Enter 发送 · Shift+Enter 换行</span>
              {active ? (
                <button className="sendbtn stop" onClick={stop} title="停止"><Icon name="stop" size={15} /></button>
              ) : (
                <button className="sendbtn" onClick={send} disabled={!text.trim() || busy} title="发送"><Icon name="send" size={17} /></button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
