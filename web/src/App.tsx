import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveKey } from './derive'
import { SearchPalette } from './Dialogs'
import { Home } from './Home'
import { Logo, Spinner } from './icons'
import { SessionView } from './SessionView'
import { Setup, SETUP_SEEN } from './Setup'
import { Sidebar, ThemeChoice } from './Sidebar'
import { inApp, signIn, tellNative, useStore } from './store'
import { isMac, Toaster, usePersisted } from './ui'
import { copyText } from './util'
import { t } from './i18n'

// Routes live in the hash: #/ is the start page, #/s/<session id>[?m=<message ordinal>] a conversation,
// #/setup the setup guide.
function parseHash(): { key?: string; ord?: number; setup?: boolean } {
  if (location.hash.startsWith('#/setup')) return { setup: true }
  const m = location.hash.match(/^#\/s\/([^?]+)(?:\?m=(\d+))?/)
  if (!m) return {}
  return { key: decodeURIComponent(m[1]), ord: m[2] !== undefined ? Number(m[2]) : undefined }
}

const systemDark = matchMedia('(prefers-color-scheme: dark)')

function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const v = localStorage.getItem('sh.theme')
    return v === 'light' || v === 'dark' ? v : 'system'
  })
  useEffect(() => {
    const apply = () => {
      const theme = choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice
      document.documentElement.dataset.theme = theme
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#17181b' : '#f6f5f1')
    }
    apply()
    systemDark.addEventListener('change', apply)
    return () => systemDark.removeEventListener('change', apply)
  }, [choice])
  return [choice, (c) => { if (c === 'system') localStorage.removeItem('sh.theme'); else localStorage.setItem('sh.theme', c); setChoice(c) }]
}

if (inApp) document.documentElement.classList.add('in-app')

// Inside the desktop app the page is the whole window, so its empty header
// areas (marked data-drag) move the window, as a title bar would.
if (inApp) {
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    if (!el.closest('[data-drag]') || el.closest('button, a, input, textarea, select, h1, .menu, .rename')) return
    tellNative({ type: e.detail === 2 ? 'zoom' : 'drag' })
  })
}

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function App() {
  const authed = useStore((s) => s.authed)
  const [theme, setTheme] = useTheme()
  if (authed === null) return <div className="splash" data-drag><Spinner size={22} /></div>
  if (!authed) return <Login />
  return <Shell theme={theme} setTheme={setTheme} />
}

function Shell({ theme, setTheme }: { theme: ThemeChoice; setTheme: (t: ThemeChoice) => void }) {
  const runs = useStore((s) => s.runs)
  const [route, setRoute] = useState(parseHash)
  const [showSearch, setShowSearch] = useState(false)
  const [sidebar, setSidebar] = usePersisted('atrium.sidebar', true)
  const [homeFocus, setHomeFocus] = useState(0)
  const sidebarRef = useRef(sidebar)
  sidebarRef.current = sidebar

  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const open = useCallback((id: string, ord?: number) => {
    location.hash = `#/s/${encodeURIComponent(id)}${ord !== undefined ? `?m=${ord}` : ''}`
    setShowSearch(false)
  }, [])
  // On a phone the list and the start page share the screen: "new session" brings the start page forward.
  const [homeUp, setHomeUp] = useState(false)
  const home = useCallback(() => {
    location.hash = '#/'
    setShowSearch(false)
    setHomeUp(true)
    setHomeFocus((x) => x + 1)
  }, [])

  // A new install opens on the setup guide, once: no machine can run anything yet, or nothing
  // has ever been run or marked from this page.
  const loaded = useStore((s) => s.loaded)
  const machines = useStore((s) => s.machines)
  const metaMap = useStore((s) => s.meta)
  const offered = useRef(false)
  useEffect(() => {
    if (!loaded || offered.current) return
    offered.current = true
    let seen = false
    try { seen = !!localStorage.getItem(SETUP_SEEN) } catch { /* private mode */ }
    if (seen || location.hash.startsWith('#/s/')) return
    const fresh = !machines.some((m) => m.runner && m.online) || (Object.keys(runs).length === 0 && Object.keys(metaMap).length === 0)
    if (fresh) location.hash = '#/setup'
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // A brand-new session is routed by its run id until it reports its real id.
  const id = route.key ? resolveKey(route.key, runs) : undefined
  useEffect(() => {
    if (route.key && id && id !== route.key) history.replaceState(null, '', `#/s/${encodeURIComponent(id)}`)
  }, [route.key, id])

  useEffect(() => {
    const cmd = (c: string) => window.dispatchEvent(new CustomEvent('atrium:cmd', { detail: c }))
    const on = (e: KeyboardEvent) => {
      // On a Mac the shortcuts are ⌘ only: Ctrl+K, Ctrl+B, Ctrl+J… belong to the shell in the terminal panel.
      const inTerm = !!(e.target as HTMLElement | null)?.closest?.('.xterm')
      const mod = isMac ? e.metaKey : e.ctrlKey && !inTerm
      const k = e.key.toLowerCase()
      if (mod && k === 'k') {
        e.preventDefault()
        setShowSearch((v) => !v)
      } else if (mod && (k === 'b' || k === '\\')) {
        e.preventDefault()
        setSidebar(!sidebarRef.current)
      } else if (mod && (k === 'n' || (e.shiftKey && k === 'o'))) {
        e.preventDefault()
        home()
      } else if (mod && k === '.') {
        e.preventDefault()
        cmd('side')
      } else if (mod && k === 'j') {
        e.preventDefault()
        cmd('terminal')
      } else if (mod && k === 'e') {
        e.preventDefault()
        cmd('files')
      } else if (e.key === 'Escape') {
        setShowSearch(false)
      } else if (e.key === '/' && !mod && !e.altKey && !typing(e)) {
        // "/" anywhere outside a text field jumps to the message box and opens the command menu.
        e.preventDefault()
        cmd('slash')
      }
    }
    window.addEventListener('keydown', on)
    // The desktop app's menu bar sends the same commands.
    const menu = (e: Event) => {
      const c = (e as CustomEvent).detail
      if (c === 'new') home()
      else if (c === 'search') setShowSearch(true)
      else if (c === 'sidebar') setSidebar(!sidebarRef.current)
    }
    window.addEventListener('atrium:cmd', menu)
    return () => { window.removeEventListener('keydown', on); window.removeEventListener('atrium:cmd', menu) }
  }, [home, setSidebar])

  return (
    <div className={'app' + (id ? ' has-session' : homeUp || route.setup ? ' home-up' : '') + (sidebar ? '' : ' no-sidebar')}>
      {sidebar && <Sidebar currentId={id} onOpen={(sid) => open(sid)} onNew={home} onSearch={() => setShowSearch(true)} theme={theme} onTheme={setTheme} onHide={() => setSidebar(false)} />}
      {id ? (
        <SessionView key={id} id={id} focusOrd={route.ord} onBack={home} onOpen={open} onNew={home} onSearch={() => setShowSearch(true)} sidebarHidden={!sidebar} onShowSidebar={() => setSidebar(true)} />
      ) : route.setup ? (
        <Setup onStart={home} onBack={() => { location.hash = '#/'; setHomeUp(false) }} />
      ) : (
        <Home onOpen={open} onSearch={() => setShowSearch(true)} sidebarHidden={!sidebar} onShowSidebar={() => setSidebar(true)} focusSignal={homeFocus} onBack={() => setHomeUp(false)} />
      )}
      {showSearch && <SearchPalette onClose={() => setShowSearch(false)} onOpen={open} />}
      <Toaster />
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
    <div className="login" data-drag>
      <div className="login-card">
        <Logo size={48} />
        <h1>{t('Atrium 中庭', 'Atrium')}</h1>
        <p>{t('这个页面需要先登录。', 'Sign in first.')}</p>
        <p><b>{t('已经在别的设备上登录了？', 'Already signed in on another device?')}</b> {t('在那边点左下角 ⋯ →"在另一台设备上登录"，把得到的链接粘贴到下面。', 'There, open ⋯ at the bottom left → "Sign in on another device", and paste the link it gives you below.')}</p>
        <div className="dirrow">
          <input className="input" value={code} placeholder={t('粘贴登录链接', 'Sign-in link')} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <button className="btn primary" onClick={submit} disabled={busy || !code.trim()}>{busy ? <Spinner size={13} /> : t('登录', 'Sign in')}</button>
        </div>
        {(err || loadError) && <div className="errtext">{err || loadError}</div>}
        <p className="dim">{hint
          ? t('第一次登录，或者没有已登录的设备：在装好 Atrium 的那台电脑的终端里运行下面这条命令（它是那台电脑上的命令，别的电脑上可能没有）；或者在服务器上运行 atrium login-link。', 'First sign-in, or no signed-in device at hand: run this in a terminal on the computer where Atrium was set up (the command lives there and may not exist elsewhere), or run atrium login-link on the server.')
          : t('第一次登录，或者没有已登录的设备：在运行 Atrium 的服务器上执行下面这条命令，把它输出的链接粘贴到上面。', 'First sign-in, or no signed-in device at hand: run this on the Atrium server and paste the link it prints above.')}</p>
        <div className="login-cmd">
          <code>{cmd}</code>
          <button className="linkbtn" onClick={() => copyText(cmd)}>{t('复制', 'Copy')}</button>
        </div>
      </div>
    </div>
  )
}
