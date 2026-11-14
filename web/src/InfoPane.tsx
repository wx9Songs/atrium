// The Info tab of the side panel: where the session runs, how full its context
// window is and with what, the background tasks of the turn in flight, what
// the last turn cost, and the MCP servers. During a turn the figures come
// from the run (the runner asks the agent as it works); for a session at rest
// they are read from its machine when the tab is opened.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, Machine, Run, Session, SessionInfo } from './api'
import { runsOf } from './derive'
import { AgentIcon, Icon, Spinner } from './icons'
import { isTerminal, useStore } from './store'
import { tok } from './Usage'
import { toast } from './ui'
import { agentName, hasFeature, modeOptions, shortPath } from './util'
import { t } from './i18n'

// One colour per kind of content, the same every time (not by rank).
const CAT_COLOR: Record<string, string> = {
  messages: 'var(--c-blue)', system_tools: 'var(--c-orange)', system_prompt: 'var(--c-teal)', skills: 'var(--c-amber)',
  memory_files: 'var(--c-violet)', mcp_tools: 'var(--c-pink)', mcp_instructions: 'var(--c-rose)', custom_agents: 'var(--c-green)',
}
const CAT_NAME: Record<string, [string, string]> = {
  messages: ['对话消息', 'Messages'], system_tools: ['系统工具', 'System tools'], system_prompt: ['系统提示词', 'System prompt'],
  skills: ['技能', 'Skills'], memory_files: ['记忆文件', 'Memory files'], mcp_tools: ['MCP 工具', 'MCP tools'],
  mcp_instructions: ['MCP 说明', 'MCP instructions'], custom_agents: ['自定义子代理', 'Custom agents'],
  autocompact_buffer: ['自动压缩预留', 'Autocompact buffer'], free_space: ['剩余空间', 'Free space'],
  system_tools_deferred: ['系统工具（按需加载）', 'System tools (deferred)'], mcp_tools_deferred: ['MCP 工具（按需加载）', 'MCP tools (deferred)'],
}
const catName = (c: { id: string; name: string }) => (CAT_NAME[c.id] ? t(...CAT_NAME[c.id]) : c.name)
const catColor = (id: string) => CAT_COLOR[id] || 'var(--c-slate)'

const TASK_TYPE: Record<string, [string, string]> = {
  local_bash: ['后台命令', 'Shell'], local_agent: ['子代理', 'Sub-agent'], monitor: ['监视', 'Monitor'], remote_agent: ['远程代理', 'Remote agent'],
}

const TASK_END: Record<string, [string, string]> = { completed: ['已完成', 'done'], stopped: ['已停止', 'stopped'], killed: ['已停止', 'stopped'], failed: ['失败', 'failed'] }

function span(msec: number): string {
  const s = Math.max(0, Math.round(msec / 1000))
  if (s < 60) return t(`${s} 秒`, `${s}s`)
  const m = Math.floor(s / 60)
  if (m < 60) return t(`${m} 分 ${s % 60} 秒`, `${m}m ${s % 60}s`)
  return t(`${Math.floor(m / 60)} 小时 ${m % 60} 分`, `${Math.floor(m / 60)}h ${m % 60}m`)
}

export function InfoPane({ session, machine }: { session: Session; machine?: Machine }) {
  const runsMap = useStore((s) => s.runs)
  const runs = useMemo(() => runsOf(session.id, runsMap), [session.id, runsMap])
  const run: Run | undefined = runs[runs.length - 1]
  const active = !!run && !isTerminal(run)
  const can = hasFeature(machine, 'info') && !!machine?.online && !session.synthetic

  const [base, setBase] = useState<SessionInfo | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const load = async () => {
    if (!can) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const d = await api.sessionInfo(session.id)
      if (mine === seq.current) { setBase(d); setErr('') }
    } catch (e: any) {
      if (mine === seq.current) setErr(e.message || t('没有读到', 'Could not read it'))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }
  // Read it when the tab opens on a session, and again when a turn ends (the context has grown).
  useEffect(() => { setBase(null); setErr(''); seq.current++; setLoading(false) }, [session.id])
  useEffect(() => { if (!active) load() }, [session.id, active, can]) // eslint-disable-line react-hooks/exhaustive-deps

  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(timer)
  }, [active])

  // During a turn the run knows best; afterwards the fresh reading does.
  const live = run?.info || {}
  const info: SessionInfo = active ? { ...base, ...live } : { ...live, ...(base || {}) }
  const ctx = info.context
  const sess = { ...(base?.session || {}), ...(live.session || {}) }
  const tasks = (live.tasks || []).slice().reverse()
  const running = tasks.filter((x) => x.status === 'running')
  const last = live.last
  const mode = modeOptions(session.agent).find((o) => o.value === run?.mode)

  const stopTask = async (id: string) => {
    if (!run) return
    try { await api.stopTask(run.id, id) } catch (e: any) { toast(e.message || t('没有停下来', 'Could not stop it')) }
  }

  const used = ctx?.categories.filter((c) => c.kind === 'used' && c.tokens > 0) || []
  const rest = ctx?.categories.filter((c) => c.kind !== 'used' && c.tokens > 0) || []
  const max = ctx?.max || 0
  const pct = (n: number) => (max ? (n * 100 / max < 0.05 ? '<0.1%' : (n * 100 / max).toFixed(1) + '%') : '')

  return (
    <div className="info">
      <section>
        <h4>{t('会话', 'Session')}</h4>
        <div className="info-kv">
          <span><AgentIcon agent={session.agent} size={14} /></span>
          <b>{agentName(session.agent)}{(sess.model || ctx?.model) && <i className="mono"> {sess.model || ctx?.model}</i>}</b>
          {(sess.effort || run?.effort) && <><span><Icon name="think" size={14} /></span><b>{t('思考强度', 'Effort')} <i>{sess.effort || run?.effort}</i></b></>}
          <span><Icon name={machine?.info?.os === 'linux' ? 'server' : 'machine'} size={14} /></span>
          <b>{machine?.label || session.machine}{machine && !machine.online && <i> · {t('离线', 'offline')}</i>}</b>
          {session.cwd && <><span><Icon name="folder" size={14} /></span><b className="mono" title={session.cwd}>{shortPath(session.cwd, 40)}</b></>}
          {(mode || sess.mode || sess.approval || sess.sandbox) && <><span><Icon name="shield" size={14} /></span><b>{mode ? mode.label : sess.mode || sess.approval || sess.sandbox}{sess.sandbox && (mode || sess.mode || sess.approval) && <i> · {sess.sandbox}</i>}</b></>}
        </div>
        {(sess.version || info.account?.plan) && (
          <div className="info-note">{[sess.version && `${agentName(session.agent)} ${sess.version}`, info.account?.plan].filter(Boolean).join(' · ')}</div>
        )}
      </section>

      <section>
        <h4>
          {t('上下文', 'Context')}
          {can && !active && <button type="button" className="linkbtn" onClick={load} disabled={loading}>{loading ? <Spinner size={11} /> : t('重新读取', 'Reload')}</button>}
        </h4>
        {ctx ? (
          <>
            <div className="ctx-top">
              <b>{max ? t(`已用 ${ctx.percent ?? Math.round(ctx.used * 100 / max)}%`, `${ctx.percent ?? Math.round(ctx.used * 100 / max)}% used`) : t('已用', 'Used')}</b>
              <span>{tok(ctx.used)}{max ? ' / ' + tok(max) : ''}</span>
            </div>
            {max > 0 && (
              <div className="ctx-bar" role="img" aria-label={t('上下文占用', 'Context use')}>
                {used.map((c) => <i key={c.id} style={{ width: Math.max(0.6, c.tokens * 100 / max) + '%', background: catColor(c.id) }} title={`${catName(c)} · ${tok(c.tokens)}`} />)}
              </div>
            )}
            <div className="ctx-rows">
              {used.map((c) => (
                <div key={c.id}><i style={{ background: catColor(c.id) }} /><span>{catName(c)}</span><em>{tok(c.tokens)}</em><b>{pct(c.tokens)}</b></div>
              ))}
              {rest.length > 0 && <hr />}
              {rest.map((c) => (
                <div key={c.id} className="dim"><i className={c.kind} /><span>{catName(c)}</span><em>{tok(c.tokens)}</em><b>{c.kind === 'deferred' ? '—' : pct(c.tokens)}</b></div>
              ))}
            </div>
            {ctx.memory && ctx.memory.length > 0 && (
              <details className="info-more">
                <summary>{t(`记忆文件 ${ctx.memory.length} 个`, `${ctx.memory.length} memory files`)}</summary>
                {ctx.memory.map((f) => <div key={f.path} className="info-line"><span className="mono" title={f.path}>{shortPath(f.path, 38)}</span><em>{tok(f.tokens || 0)}</em></div>)}
              </details>
            )}
            {ctx.mcp_tools && ctx.mcp_tools.length > 0 && (
              <details className="info-more">
                <summary>{t(`MCP 工具，来自 ${ctx.mcp_tools.length} 个服务`, `MCP tools from ${ctx.mcp_tools.length} servers`)}</summary>
                {ctx.mcp_tools.map((s) => <div key={s.server} className="info-line"><span>{s.server} · {t(`${s.tools} 个工具`, `${s.tools} tools`)}{s.loaded < s.tools && <i> · {t(`已加载 ${s.loaded}`, `${s.loaded} loaded`)}</i>}</span><em>{tok(s.tokens)}</em></div>)}
              </details>
            )}
            {session.agent === 'codex' && <div className="info-note">{t('Codex 不报告细分，这里是最近一次请求占用的上下文。', 'Codex reports no breakdown; this is what the latest request took of the window.')}</div>}
          </>
        ) : loading || (active && !err) ? (
          <div className="info-note"><Spinner size={12} /> {t('正在读取…', 'Reading…')}</div>
        ) : err ? (
          <div className="info-note error">{err}</div>
        ) : (
          <div className="info-note">{!machine?.runner ? t('这台机器没有接入操控，读不到。', 'This machine has no runner, so it cannot be read.') : !machine.online ? t('机器不在线，读不到。', 'The machine is offline.') : !hasFeature(machine, 'info') ? t('这台机器上的 runner 版本较旧，更新后才能读取。', 'The runner on this machine is too old; update it to read this.') : t('还没有数据。', 'Nothing yet.')}</div>
        )}
      </section>

      <section>
        <h4>{t('后台任务', 'Background tasks')}{running.length > 0 && <span className="tcount">{running.length}</span>}</h4>
        {tasks.length === 0 ? (
          <div className="info-note">{active ? t('这一轮还没有启动后台任务。', 'This turn has started no background task.') : t('没有在运行的后台任务。助手启动的后台命令和监视只在那一轮的进程里存活，结束后会显示在这里直到下一轮。', 'Nothing is running. Background commands and monitors an agent starts live inside that turn’s process; they stay listed here until the next turn.')}</div>
        ) : (
          <div className="tasks">
            {tasks.map((x) => {
              const on = x.status === 'running' && active
              return (
                <div key={x.id} className={'task' + (on ? ' on' : '')}>
                  <span className="task-st">{on ? <Spinner size={12} /> : <Icon name={x.status === 'completed' ? 'check' : x.status === 'running' ? 'clock' : 'x'} size={13} />}</span>
                  <div className="task-main">
                    <b title={x.summary || x.description}>{x.description || x.id}</b>
                    <span>
                      {TASK_TYPE[x.type] ? t(...TASK_TYPE[x.type]) : x.type}
                      {' · '}
                      {on ? span(Date.now() - (x.started || Date.now())) : x.status === 'running' ? t('随这一轮结束', 'ended with the turn') : TASK_END[x.status] ? t(...TASK_END[x.status]) : x.status}
                      {!on && x.started && x.ended ? ' · ' + span(x.ended - x.started) : ''}
                    </span>
                  </div>
                  {on && <button type="button" className="btn sm" onClick={() => stopTask(x.id)}>{t('停止', 'Stop')}</button>}
                </div>
              )
            })}
          </div>
        )}
        {active && running.length > 0 && run?.status !== 'permission' && (
          <div className="info-note">{t('后台任务还在跑，这一轮要等它们结束才算完成；可以在这里停掉。', 'With background tasks still going, this turn is not over until they end. You can stop them here.')}</div>
        )}
      </section>

      {last && (
        <section>
          <h4>{active ? t('这一轮', 'This turn') : t('上一轮', 'Last turn')}</h4>
          <div className="info-stats">
            {typeof last.duration_ms === 'number' && <div><b>{span(last.duration_ms)}</b><span>{t('用时', 'time')}</span></div>}
            {typeof last.turns === 'number' && <div><b>{last.turns}</b><span>{t('步', 'steps')}</span></div>}
            {typeof last.cost === 'number' && <div title={t('按公开 API 价格折算，不是账单', 'At public API prices: an estimate, not a bill')}><b>${last.cost < 0.01 ? last.cost.toFixed(4) : last.cost.toFixed(2)}</b><span>{t('折算费用', 'est. cost')}</span></div>}
          </div>
          {(last.models || []).map((m) => (
            <div key={m.model} className="info-line"><span className="mono">{m.model}</span><em>{t('入', 'in')} {tok((m.in || 0) + (m.cache_read || 0) + (m.cache_write || 0))} · {t('出', 'out')} {tok(m.out || 0)}</em></div>
          ))}
        </section>
      )}
      {!last && info.totals && (
        <section>
          <h4>{t('累计用量', 'Tokens so far')}</h4>
          <div className="info-line"><span>{t('输入', 'Input')}{info.totals.cached ? <i> · {t(`其中缓存 ${tok(info.totals.cached)}`, `${tok(info.totals.cached)} cached`)}</i> : null}</span><em>{tok(info.totals.input || 0)}</em></div>
          <div className="info-line"><span>{t('输出', 'Output')}{info.totals.reasoning ? <i> · {t(`其中思考 ${tok(info.totals.reasoning)}`, `${tok(info.totals.reasoning)} reasoning`)}</i> : null}</span><em>{tok(info.totals.output || 0)}</em></div>
        </section>
      )}

      {((info.mcp && info.mcp.length > 0) || sess.tools) && (
        <section>
          <h4>{t('工具与连接', 'Tools and connectors')}</h4>
          {(info.mcp || []).map((m) => (
            <div key={m.name} className="info-line">
              <span><i className={'dot ' + (m.status === 'connected' ? 'ok' : m.status === 'failed' ? 'bad' : 'wait')} />{m.name}</span>
              <em>{m.status === 'connected' ? t('已连接', 'connected') : m.status === 'pending' ? t('连接中', 'connecting') : m.status === 'needs-auth' ? t('需要登录', 'needs sign-in') : m.status === 'failed' ? t('失败', 'failed') : m.status}</em>
            </div>
          ))}
          {sess.tools ? (
            <div className="info-note">{[t(`${sess.tools} 个工具`, `${sess.tools} tools`), sess.skills ? t(`${sess.skills} 个技能`, `${sess.skills} skills`) : '', sess.agents ? t(`${sess.agents} 个子代理`, `${sess.agents} sub-agents`) : '', sess.plugins ? t(`${sess.plugins} 个插件`, `${sess.plugins} plugins`) : ''].filter(Boolean).join(' · ')}</div>
          ) : ctx?.skills?.count ? (
            <div className="info-note">{t(`${ctx.skills.count} 个技能`, `${ctx.skills.count} skills`)}</div>
          ) : null}
        </section>
      )}
    </div>
  )
}
