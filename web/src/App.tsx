import { useCallback, useEffect, useMemo, useState } from 'react'
import { allSessions, resolveKey } from './derive'
import { NewSession, SearchPalette } from './Dialogs'
import { Icon, Spinner } from './icons'
import { SessionView } from './SessionView'
import { Sidebar } from './Sidebar'
import { signIn, useStore } from './store'
import { copyText, ms } from './util'
import { t } from './i18n'

// Routes live in the hash: #/s/<session id>[?m=<message ordinal>]
function parseHash(): { key?: string; ord?: number } {
  const m = location.hash.match(/^#\/s\/([^?]+)(?:\?m=(\d+))?/)
  if (!m) return {}
  return { key: decodeURIComponent(m[1]), ord: m[2] !== undefined ? Number(m[2]) : undefined }
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('sh.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#191a1c' : '#f7f6f3')
  }, [theme])
  return [theme, () => { const t = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('sh.theme', t); setTheme(t) }]
}

export function App() {
  const authed = useStore((s) => s.authed)
  const [theme, toggleTheme] = useTheme()
  if (authed === null) return <div className="splash"><Spinner size={22} /></div>
  if (!authed) return <Login />
  return <Shell theme={theme} toggleTheme={toggleTheme} />
}

function Shell({ theme, toggleTheme }: { theme: string; toggleTheme: () => void }) {
  const runs = useStore((s) => s.runs)
  const sessions = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.loaded)
  const machines = useStore((s) => s.machines)
  const [route, setRoute] = useState(parseHash)
  const [showNew, setShowNew] = useState(false)
  const [showSearch, setShowSearch] = useState(false)

  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const open = useCallback((id: string, ord?: number) => {
    location.hash = `#/s/${encodeURIComponent(id)}${ord !== undefined ? `?m=${ord}` : ''}`
    setShowSearch(false)
    setShowNew(false)
  }, [])
  const back = useCallback(() => { location.hash = '#/' }, [])

  // A brand-new session is routed by its run id until it reports its real id.
  const id = route.key ? resolveKey(route.key, runs) : undefined
  useEffect(() => {
    if (route.key && id && id !== route.key) history.replaceState(null, '', `#/s/${encodeURIComponent(id)}`)
  }, [route.key, id])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowSearch((v) => !v)
      } else if (e.key === 'Escape') {
        setShowSearch(false)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const stats = useMemo(() => {
    const all = allSessions(sessions, runs)
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    return { total: all.length, today: all.filter((s) => ms(s.ended) >= start).length }
  }, [sessions, runs])

  return (
    <div className={'app' + (id ? ' has-session' : '')}>
      <Sidebar currentId={id} onOpen={(sid) => open(sid)} onNew={() => setShowNew(true)} onSearch={() => setShowSearch(true)} theme={theme} onTheme={toggleTheme} />
      {id ? (
        <SessionView key={id} id={id} focusOrd={route.ord} onBack={back} />
      ) : (
        <div className="main">
          <div className="empty">
            <div className="empty-logo"><span className="logo big" /></div>
            <div className="empty-title">{t('所有机器上的会话，都在这里', 'Every session, from every machine')}</div>
            <div className="empty-sub">
              {loaded ? t(`共 ${stats.total} 个会话，今天有 ${stats.today} 个在更新。`, `${stats.total} sessions, ${stats.today} active today.`) : t('正在加载…', 'Loading…')}
              <br />{t('从左边选一个继续，或者开始一个新的。', 'Pick one on the left to continue, or start a new one.')}
            </div>
            <div className="empty-actions">
              <button className="btn primary" onClick={() => setShowNew(true)}><Icon name="plus" size={15} />{t('新会话', 'New session')}</button>
              <button className="btn" onClick={() => setShowSearch(true)}><Icon name="search" size={15} />{t('搜索对话内容', 'Search conversations')}</button>
            </div>
            <div className="empty-machines">
              {machines.filter((m) => m.runner).map((m) => (
                <span key={m.name} className="mach"><span className={'dot ' + (m.online ? 'on' : 'off')} />{m.label}<i>{m.online ? t('在线', 'online') : t('不在线', 'offline')}</i></span>
              ))}
            </div>
          </div>
        </div>
      )}
      {showNew && <NewSession onClose={() => setShowNew(false)} onStarted={(key) => open(key)} />}
      {showSearch && <SearchPalette onClose={() => setShowSearch(false)} onOpen={open} />}
    </div>
  )
}

function Login() {
  const loadError = useStore((s) => s.loadError)
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const hint = useStore((s) => s.loginHint)
  const cmd = hint || `atrium login-link --base ${location.origin}`
  const submit = async () => {
    const m = code.match(/login=([A-Za-z0-9_-]+)/)
    const c = (m ? m[1] : code).trim()
    if (!c) return
    setBusy(true)
    setErr('')
    try {
      await signIn(c)
    } catch (e: any) {
      setErr(e.message || t('登录失败', 'Sign-in failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <div className="login-card">
        <span className="logo big" />
        <h1>{t('Atrium 中庭', 'Atrium')}</h1>
        <p>{hint ? t('这个页面需要先登录。在终端里运行下面这条命令，它会打开已登录的页面：', 'Sign in first. Run this in a terminal; it opens the page signed in:') : t('这个页面需要先登录。在运行 Atrium 的服务器上执行下面这条命令，把它输出的链接在这个浏览器里打开：', 'Sign in first. Run this on the Atrium server and open the link it prints in this browser:')}</p>
        <div className="login-cmd">
          <code>{cmd}</code>
          <button className="linkbtn" onClick={() => copyText(cmd)}>{t('复制', 'Copy')}</button>
        </div>
        <p className="dim">{t('或者把登录链接粘贴到这里：', 'Or paste the sign-in link here:')}</p>
        <div className="dirrow">
          <input className="input" value={code} placeholder={t('粘贴登录链接', 'Sign-in link')} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <button className="btn primary" onClick={submit} disabled={busy || !code.trim()}>{busy ? <Spinner size={13} /> : t('登录', 'Sign in')}</button>
        </div>
        {(err || loadError) && <div className="errtext">{err || loadError}</div>}
      </div>
    </div>
  )
}
