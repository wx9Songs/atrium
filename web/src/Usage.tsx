// Usage, on the strip along the bottom of the window: how much of each agent's
// plan allowance is spent and when it starts over, and the tokens of the last week.
// Allowances are what the CLI on each machine last saw (see the runner's
// limits.go); tokens are counted by the archive from the transcripts.
import { useEffect, useMemo, useState } from 'react'
import { Limits, LimitWindow, Machine, Tokens, Usage } from './api'
import { AgentIcon, Icon } from './icons'
import { refreshUsage, useStore } from './store'
import { Dropdown } from './ui'
import { agentName, machineLabel, shortTime } from './util'
import { t, lang } from './i18n'

type Reading = Limits & { machine: string }

/** Per agent: every machine's reading, the latest first. */
function readingsOf(machines: Machine[]): Record<string, Reading[]> {
  const out: Record<string, Reading[]> = {}
  for (const m of machines) {
    for (const agent in m.limits || {}) {
      const l = m.limits![agent]
      if (!l || !Array.isArray(l.windows) || !l.windows.length) continue
      ;(out[agent] ||= []).push({ ...l, agent, machine: m.name })
    }
  }
  for (const a in out) out[a].sort((x, y) => y.at - x.at)
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')
const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function windowName(w: LimitWindow): string {
  const model = w.id.startsWith('seven_day_') ? ' ' + w.id.slice(10).replace(/^./, (c) => c.toUpperCase()) : ''
  const min = w.minutes || (w.id === 'five_hour' ? 300 : 10080)
  if (min === 10080) return t('本周', 'Week') + model
  if (min % 1440 === 0) return t(`${min / 1440} 天`, `${min / 1440}d`) + model
  return t(`${Math.round(min / 60)} 小时`, `${Math.round(min / 60)}h`) + model
}

/** Time left: "45m", "1h 52m", "2d 4h" (`long`: spelled out a little more in Chinese). */
function remain(ms: number, long = false): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return t(long ? `${m} 分钟` : `${m}分`, `${m}m`)
  const h = Math.floor(m / 60)
  if (h < 24) return t(long ? `${h} 小时 ${m % 60} 分` : `${h}时${pad(m % 60)}分`, `${h}h ${m % 60}m`)
  return t(long ? `${Math.floor(h / 24)} 天 ${h % 24} 小时` : `${Math.floor(h / 24)}天${h % 24}时`, `${Math.floor(h / 24)}d ${h % 24}h`)
}

/** A moment in the coming days: "21:30", "明天 09:00", "周六 09:00", "11月19日 09:00". */
function when(ts: number, now: number): string {
  const d = new Date(ts)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day0(d) - day0(new Date(now))) / 86400_000)
  if (days === 0) return t('今天 ', 'today ') + clock
  if (days === 1) return t('明天 ', 'tomorrow ') + clock
  if (days > 1 && days < 7) return (lang === 'zh' ? WEEK_ZH : WEEK_EN)[d.getDay()] + ' ' + clock
  return t(`${d.getMonth() + 1}月${d.getDate()}日 `, `${MON[d.getMonth()]} ${d.getDate()} `) + clock
}

/** A token count, short: 4.1万 / 283万 / 1.02亿, or 41.2K / 2.8M / 1.02B. */
export function tok(n: number): string {
  const f = (v: number) => (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)))
  if (lang === 'zh') {
    if (n < 1e4) return String(Math.round(n))
    if (n < 1e8) return f(n / 1e4) + '万'
    return (n / 1e8).toFixed(2) + '亿'
  }
  if (n < 1e3) return String(Math.round(n))
  if (n < 1e6) return f(n / 1e3) + 'K'
  if (n < 1e9) return f(n / 1e6) + 'M'
  return (n / 1e9).toFixed(2) + 'B'
}

const money = (n: number) => '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US'))

/** What a turn makes the model read anew and write: everything except cache reads. */
const work = (x?: Tokens) => (x ? x.in + x.cache_write + x.out : 0)

/** A window as it stands now: once its reset time has passed, the old figure no longer holds. */
function standing(w: LimitWindow, now: number) {
  const lapsed = !!w.resets && now >= w.resets
  const used = lapsed ? 0 : Math.max(0, Math.min(100, w.used))
  return { used, lapsed, level: used >= 90 ? 'crit' : used >= 75 ? 'warn' : 'ok' }
}

function Meter({ w, now, long }: { w: LimitWindow; now: number; long?: boolean }) {
  const s = standing(w, now)
  const left = w.resets && !s.lapsed ? remain(w.resets - now, long) : ''
  return (
    <>
      <span className="um-name">{windowName(w)}</span>
      <span className={'um-track ' + s.level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.used}><i style={{ width: s.used + '%' }} /></span>
      <span className={'um-pct ' + s.level}>{s.level === 'crit' && <Icon name="alert" size={11} />}{Math.round(s.used)}%</span>
      <span className="um-reset">
        {s.lapsed ? t('已重置', 'reset') : !w.resets ? '' : long ? t(`${when(w.resets, now)} 重置 · 还有 ${left}`, `resets ${when(w.resets, now)} · in ${left}`) : left}
      </span>
    </>
  )
}

const meterTitle = (r: Reading, w: LimitWindow, machines: Machine[], now: number) => {
  const s = standing(w, now)
  const src = t(`${machineLabel(machines, r.machine)} 在${shortTime(r.at, now)}读到`, `read on ${machineLabel(machines, r.machine)}, ${shortTime(r.at, now)}`)
  if (s.lapsed) return t(`${agentName(r.agent)} ${windowName(w)}：上次读到之后已经重置，新的用量要等下一次读取（${src}）`, `${agentName(r.agent)} ${windowName(w)}: it has reset since the last reading; the new figure comes with the next one (${src})`)
  return t(`${agentName(r.agent)} ${windowName(w)}：已用 ${w.used}%`, `${agentName(r.agent)} ${windowName(w)}: ${w.used}% used`) +
    (w.resets ? t(`，${when(w.resets, now)} 重置`, `, resets ${when(w.resets, now)}`) : '') + t(`（${src}）`, ` (${src})`)
}

const AGENT_ORDER = ['claude', 'codex']
const agentsIn = (keys: string[]) => [...AGENT_ORDER.filter((a) => keys.includes(a)), ...keys.filter((a) => !AGENT_ORDER.includes(a)).sort()]

/** What both forms of the usage readout show. */
function useUsage() {
  const machines = useStore((s) => s.machines)
  const usage = useStore((s) => s.usage)
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 30_000) // countdowns move on
    return () => clearInterval(timer)
  }, [])
  const byAgent = useMemo(() => readingsOf(machines), [machines])
  const days = usage?.available ? usage.days : []
  return { machines, usage, byAgent, agents: agentsIn(Object.keys(byAgent)), days, today: days[days.length - 1] as Usage['days'][number] | undefined, now: Date.now() }
}

/**
 * The strip along the bottom of the window: each agent's allowance (a meter,
 * the share used and the time until it starts over, per window), the tokens of
 * today and of the week, and how many machines are connected. A click opens
 * the details.
 */
export function StatusBar() {
  const { machines, usage, byAgent, agents, days, today, now } = useUsage()
  const connected = useStore((s) => s.connected)
  const runners = machines.filter((m) => m.runner)
  const online = runners.filter((m) => m.online).length
  const peak = Math.max(1, ...days.map((d) => work(d)))
  return (
    <footer className="statusbar">
      <Dropdown up className="sb-usage" title={t('用量详情', 'Usage details')} button={
        <>
          {agents.map((a) => {
            const r = byAgent[a][0]
            return (
              <span className="sb-agent" key={a}>
                <AgentIcon agent={a} size={13} />
                {r.windows.map((w, i) => {
                  const s = standing(w, now)
                  return (
                    <span className="sb-win" key={w.id} title={meterTitle(r, w, machines, now)}>
                      {i > 0 && <span className="sb-dot">·</span>}
                      <span className={'um-track ' + s.level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.used} aria-label={`${agentName(a)} ${windowName(w)}`}><i style={{ width: s.used + '%' }} /></span>
                      <span className={'um-pct ' + s.level}>{s.level === 'crit' && <Icon name="alert" size={11} />}{Math.round(s.used)}%</span>
                      <span className="sb-left">{s.lapsed ? t('已重置', 'reset') : w.resets ? remain(w.resets - now) : ''}</span>
                    </span>
                  )
                })}
              </span>
            )
          })}
          {!agents.length && <span className="sb-none">{t('限额还没读到', 'No limits read yet')}</span>}
          <span className="grow" />
          {today && (
            <span className="sb-tok" title={t('今天和最近 7 天的 token（不含缓存读取）', 'Tokens today and over the last 7 days (cache reads not counted)')}>
              <span className="usage-spark" aria-hidden="true">
                {days.map((d, i) => <i key={d.date} className={i === days.length - 1 ? 'now' : ''} style={{ height: Math.max(work(d) ? 2 : 1, Math.round((work(d) / peak) * 12)) }} />)}
              </span>
              <span>{t('今天', 'Today')} <b>{tok(work(today))}</b></span>
              <span className="sb-week">{t('7 天', '7 days')} {tok(days.reduce((x, d) => x + work(d), 0))}</span>
            </span>
          )}
        </>
      }>
        {() => <UsageDetail byAgent={byAgent} usage={usage} machines={machines} now={now} />}
      </Dropdown>
      <span className={'sb-conn conn ' + (connected ? 'ok' : 'bad')} title={connected ? t('实时更新已连接', 'Live updates on') : t('实时更新断开，正在重连', 'Live updates lost, reconnecting')}>
        <span className="dot" />
        {connected ? (runners.length ? t(`${online}/${runners.length} 台机器在线`, `${online} of ${runners.length} machines online`) : t('已连接', 'Connected')) : t('重连中…', 'Reconnecting…')}
      </span>
    </footer>
  )
}

/** On a phone there is no room for the strip: one line at the foot of the session list instead. */
export function UsageLine() {
  const { machines, usage, byAgent, agents, today, now } = useUsage()
  if (!agents.length && !today) return null
  return (
    <div className="usage">
      <Dropdown up className="usage-btn" title={t('用量详情', 'Usage details')} button={
        <span className="usage-line">
          {agents.map((a) => {
            const top = byAgent[a][0].windows.map((w) => standing(w, now)).sort((x, y) => y.used - x.used)[0]
            return <span key={a} className="usage-chip"><AgentIcon agent={a} size={12} /><span className={'um-pct ' + top.level}>{Math.round(top.used)}%</span></span>
          })}
          {today && <span className="usage-chip dim">{t('今天', 'Today')} {tok(work(today))}</span>}
        </span>
      }>
        {() => <UsageDetail byAgent={byAgent} usage={usage} machines={machines} now={now} />}
      </Dropdown>
    </div>
  )
}

function UsageDetail({ byAgent, usage, machines, now }: { byAgent: Record<string, Reading[]>; usage: Usage | null; machines: Machine[]; now: number }) {
  const agents = agentsIn(Object.keys(byAgent))
  const days = usage?.available ? usage.days : []
  const [hover, setHover] = useState(-1)
  const [busy, setBusy] = useState(false)
  const at = hover >= 0 ? hover : days.length - 1
  const day = days[at]
  const week: Tokens = days.reduce((a, d) => ({ in: a.in + d.in, out: a.out + d.out, cache_read: a.cache_read + d.cache_read, cache_write: a.cache_write + d.cache_write, cost: a.cost + d.cost }), { in: 0, out: 0, cache_read: 0, cache_write: 0, cost: 0 })
  const series = agentsIn([...new Set(days.flatMap((d) => Object.keys(d.agents || {})))])
  const peak = Math.max(1, ...days.map((d) => work(d)))
  const dayName = (date: string, i: number) => {
    if (i === days.length - 1) return t('今天', 'Today')
    const d = new Date(date + 'T12:00:00')
    return (lang === 'zh' ? WEEK_ZH : WEEK_EN)[d.getDay()]
  }
  const dayFull = (date: string) => {
    const d = new Date(date + 'T12:00:00')
    return t(`${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_ZH[d.getDay()]}`, `${WEEK_EN[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`)
  }
  const reload = async () => {
    setBusy(true)
    await refreshUsage(true)
    setBusy(false)
  }
  const share = (list: (Tokens & { name: string })[], label: (name: string) => string) => {
    const top = list.filter((x) => work(x) > 0).slice(0, 5)
    const max = Math.max(1, ...top.map((x) => work(x)))
    return top.map((x) => (
      <div className="ud-share" key={x.name} title={t(`输出 ${tok(x.out)} · 输入 ${tok(x.in + x.cache_write)} · 缓存读取 ${tok(x.cache_read)}`, `Output ${tok(x.out)} · input ${tok(x.in + x.cache_write)} · cache reads ${tok(x.cache_read)}`)}>
        <span className="ud-share-name">{label(x.name)}</span>
        <span className="ud-share-bar"><i style={{ width: Math.max(2, (work(x) / max) * 100) + '%' }} /></span>
        <span className="ud-num">{tok(work(x))}</span>
      </div>
    ))
  }

  return (
    <div className="usage-detail" onClick={(e) => e.stopPropagation()}>
      <div className="ud-head">
        <b>{t('用量', 'Usage')}</b>
        <span className="grow" />
        <button className="iconbtn" onClick={reload} disabled={busy} title={t('重新读取 token 统计', 'Read the token counts again')}><Icon name="refresh" size={14} /></button>
      </div>

      <div className="ud-label">{t('套餐限额', 'Plan limits')}</div>
      {agents.length === 0 && <div className="ud-note">{t('还没有读到。Claude 的限额在 Atrium 里跑过一轮后出现，Codex 的在它用过之后出现。', 'Nothing read yet. Claude\'s limits appear after a turn run from Atrium, Codex\'s after it has been used.')}</div>}
      {agents.map((a) => {
        const [r, ...others] = byAgent[a]
        return (
          <div className="ud-agent" key={a}>
            <div className="ud-agent-head">
              <AgentIcon agent={a} size={14} /><b>{agentName(a)}</b>
              {r.plan && <span className="ud-plan">{r.plan}</span>}
              <span className="grow" />
              <span className="dim">{machineLabel(machines, r.machine)} · {shortTime(r.at, now)}</span>
            </div>
            <div className="um-grid long">
              {r.windows.map((w) => <span className="um-row" key={w.id}><Meter w={w} now={now} long /></span>)}
            </div>
            {others.map((o) => (
              <div className="ud-other" key={o.machine}>
                {machineLabel(machines, o.machine)}{t('：', ': ')}
                {o.windows.map((w) => { const s = standing(w, now); return `${windowName(w)} ${s.lapsed ? t('已重置', 'reset') : Math.round(s.used) + '%'}` }).join(' · ')}
                {t(`（${shortTime(o.at, now)}）`, ` (${shortTime(o.at, now)})`)}
              </div>
            ))}
          </div>
        )
      })}
      {agents.length > 0 && !byAgent.claude && <div className="ud-note">{t('Claude 的限额在 Atrium 里跑过一轮后出现。', 'Claude\'s limits appear after a turn run from Atrium.')}</div>}

      {days.length > 0 && day && (
        <>
          <div className="ud-label">
            {t('Token · 最近 7 天', 'Tokens · last 7 days')}
            <span className="grow" />
            {series.length > 1 && <span className="ud-legend">{series.map((a) => <span key={a}><i className={'sw ' + a} />{agentName(a)}</span>)}</span>}
          </div>
          <div className="ud-readout">
            <b>{dayFull(day.date)}</b>
            <span>{tok(work(day))}</span>
            {series.length > 1 && series.map((a) => day.agents?.[a] && <span className="dim" key={a}>{agentName(a)} {tok(work(day.agents[a]))}</span>)}
          </div>
          <div className="ud-chart" onMouseLeave={() => setHover(-1)}>
            {days.map((d, i) => (
              <button key={d.date} className={'ud-col' + (i === at ? ' on' : '')} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(-1)}
                aria-label={`${dayFull(d.date)}: ${tok(work(d))}`}>
                <span className="ud-stack">
                  {series.map((a) => {
                    const v = work(d.agents?.[a])
                    return v > 0 ? <i key={a} className={'sw ' + a} style={{ height: Math.max(2, (v / peak) * 64) }} /> : null
                  })}
                  {work(d) === 0 && <i className="none" />}
                </span>
                <span className="ud-day">{dayName(d.date, i)}</span>
              </button>
            ))}
          </div>
          <table className="ud-table">
            <thead><tr><th /><th>{hover >= 0 ? dayName(day.date, at) : t('今天', 'Today')}</th><th>{t('7 天', '7 days')}</th></tr></thead>
            <tbody>
              <tr><td>{t('输出', 'Output')}</td><td>{tok(day.out)}</td><td>{tok(week.out)}</td></tr>
              <tr><td title={t('没有命中缓存的输入，包括写入缓存的部分', 'Input that missed the cache, including what was written to it')}>{t('输入', 'Input')}</td><td>{tok(day.in + day.cache_write)}</td><td>{tok(week.in + week.cache_write)}</td></tr>
              <tr className="dim"><td>{t('缓存读取', 'Cache reads')}</td><td>{tok(day.cache_read)}</td><td>{tok(week.cache_read)}</td></tr>
              <tr className="dim"><td title={t('按公开的 API 价格估算。订阅套餐不按这个数扣费', 'Estimated at public API prices. A subscription is not billed this way')}>{t('按 API 价估算', 'At API prices')}</td><td>{money(day.cost)}</td><td>{money(week.cost)}</td></tr>
            </tbody>
          </table>
          {usage!.machines.length > 1 && <><div className="ud-label">{t('按机器 · 7 天', 'By machine · 7 days')}</div>{share(usage!.machines, (n) => machineLabel(machines, n))}</>}
          {usage!.models.length > 1 && <><div className="ud-label">{t('按模型 · 7 天', 'By model · 7 days')}</div>{share(usage!.models, (n) => n)}</>}
        </>
      )}
      <div className="ud-foot">
        {t('Token 按各机器的会话记录统计，在终端里跑的也算在内，不含缓存读取。限额是各机器上的 CLI 最近一次读到的数：Claude 的在 Atrium 里每跑一轮更新一次，Codex 的约每 10 分钟读一次。',
          'Tokens are counted from every machine\'s transcripts, terminal work included, without cache reads. Limits are what the CLI on each machine last saw: Claude\'s update with every turn run from Atrium, Codex\'s are read about every 10 minutes.')}
      </div>
    </div>
  )
}
