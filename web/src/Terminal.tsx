// The terminal panel: a login shell on the session's machine, in the session's
// folder, drawn with xterm.js. Loaded on demand; the rest of the page does not
// carry the terminal emulator around.
import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, Machine, Session, TermEvent } from './api'
import { Icon, Spinner } from './icons'
import { onTerm, useStore } from './store'
import { takeTerminalInput } from './termbus'
import { shortPath } from './util'
import { lang, t } from './i18n'

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

const THEME = {
  background: '#1a1b1e', foreground: '#dcdad3', cursor: '#f3b25c', cursorAccent: '#1a1b1e', selectionBackground: 'rgba(255,255,255,0.22)',
  black: '#2a2c31', red: '#ff7b72', green: '#7ee787', yellow: '#e3b341', blue: '#79b8ff', magenta: '#d2a8ff', cyan: '#76d9e6', white: '#dcdad3',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#a5f0b0', brightYellow: '#f2cc60', brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
}

type Status = { kind: 'starting' } | { kind: 'ready' } | { kind: 'ended'; text: string }

export default function TerminalView({ session, machine }: { session: Session; machine?: Machine }) {
  const host = useRef<HTMLDivElement>(null)
  const ctl = useRef<{ restart: () => void; resync: () => void }>()
  const [status, setStatus] = useState<Status>({ kind: 'starting' })
  const connected = useStore((s) => s.connected)
  const key = session.id
  const machineName = session.machine
  const cwd = session.cwd || ''

  useEffect(() => {
    const el = host.current
    if (!el) return
    let gone = false
    const xt = new XTerm({
      fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 8000, macOptionIsMeta: true, theme: THEME,
    })
    const fit = new FitAddon()
    xt.loadAddon(fit)
    xt.open(el)
    const refit = () => { try { fit.fit() } catch { /* not laid out yet */ } }
    refit()

    let id = ''
    let end = 0 // how much of the terminal's output has been drawn
    let live = false
    let ended = false
    let unlisten = () => {}
    const backlog: TermEvent[] = []

    const finish = (e: { code?: number; error?: string; error_zh?: string }) => {
      ended = true
      const err = (lang === 'zh' ? e.error_zh || e.error : e.error) || ''
      setStatus({ kind: 'ended', text: err || (e.code ? t(`终端已结束（退出码 ${e.code}）`, `The terminal ended (exit ${e.code})`) : t('终端已结束', 'The terminal ended')) })
    }

    const draw = (e: TermEvent) => {
      if (e.exit) return finish(e)
      if (!e.data) return
      const b = bytes(e.data)
      const off = e.off ?? end
      if (off > end) return void attach(id) // a piece went missing (the page was briefly offline): take the hub's copy
      if (off + b.length <= end) return // already drawn
      const first = end === 0
      xt.write(off < end ? b.subarray(end - off) : b)
      end = off + b.length
      // A command sent ahead of a brand-new terminal waits for the shell's first prompt, so it is not echoed twice.
      if (first) window.setTimeout(flushPending, 150)
    }

    // Join a terminal: draw what the hub has kept, then follow it live.
    const attach = async (termId: string) => {
      id = termId
      live = false
      unlisten()
      unlisten = onTerm(id, (e) => (live ? draw(e) : backlog.push(e)))
      try {
        const d = await api.termGet(id)
        if (gone || id !== termId) return
        xt.reset()
        xt.write(bytes(d.data))
        end = d.end
        live = true
        ended = false
        for (const e of backlog.splice(0)) draw(e)
        if (d.term.exited) finish(d.term)
        else {
          setStatus({ kind: 'ready' })
          api.termResize(id, xt.cols, xt.rows).catch(() => {})
          if (end > 0) flushPending()
          xt.focus()
        }
      } catch (e: any) {
        if (!gone) setStatus({ kind: 'ended', text: e.message || t('连不上这个终端', 'Cannot reach this terminal') })
      }
    }

    const start = async (fresh: boolean) => {
      setStatus({ kind: 'starting' })
      try {
        if (!fresh) {
          const mine = (await api.terms()).terms.filter((x) => x.key === key && x.machine === machineName && !x.exited).pop()
          if (gone) return
          if (mine) return void attach(mine.id)
        }
        const d = await api.termOpen({ machine: machineName, key, cwd, cols: xt.cols, rows: xt.rows })
        if (!gone) attach(d.term.id)
      } catch (e: any) {
        if (!gone) setStatus({ kind: 'ended', text: e.message || t('终端没有启动', 'The terminal did not start') })
      }
    }

    // Keystrokes go out one request at a time, so they arrive in the order typed.
    let outbox = ''
    let sending = false
    const pump = async () => {
      if (sending) return
      sending = true
      try {
        while (outbox && id && !ended) {
          const d = outbox
          outbox = ''
          await api.termInput(id, d)
        }
      } catch {
        /* the connection indicator already says so; typing again retries */
      } finally {
        sending = false
      }
    }
    const type = (d: string) => {
      if (!id || ended) return
      outbox += d
      pump()
    }
    const flushPending = () => {
      if (gone || !live || ended) return
      const text = takeTerminalInput(key)
      if (text) type(text)
    }
    const onPending = (e: Event) => { if ((e as CustomEvent).detail === key && end > 0) flushPending() }
    window.addEventListener('atrium:term-input', onPending)

    const dataSub = xt.onData(type)
    let resizeTimer = 0
    const sizeSub = xt.onResize(({ cols, rows }) => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => { if (id && !ended) api.termResize(id, cols, rows).catch(() => {}) }, 120)
    })
    const ro = new ResizeObserver(() => requestAnimationFrame(refit))
    ro.observe(el)

    ctl.current = {
      restart: () => {
        const old = id
        id = ''
        unlisten()
        if (old && !ended) api.termClose(old).catch(() => {})
        xt.reset()
        start(true)
      },
      resync: () => { if (id && !ended) attach(id) },
    }
    start(false)

    return () => {
      gone = true
      unlisten()
      window.removeEventListener('atrium:term-input', onPending)
      window.clearTimeout(resizeTimer)
      ro.disconnect()
      dataSub.dispose()
      sizeSub.dispose()
      xt.dispose()
    }
  }, [key, machineName, cwd])

  // Back online after a gap: output may have been missed.
  const wasConnected = useRef(connected)
  useEffect(() => {
    if (connected && !wasConnected.current) ctl.current?.resync()
    wasConnected.current = connected
  }, [connected])

  return (
    <div className="term">
      <div className="term-bar">
        <span className={'dot ' + (machine?.online ? 'on' : 'off')} />
        <span className="ellip" title={cwd}>{machine?.label} · {shortPath(cwd || '~', 38)}</span>
        <span className="grow" />
        {status.kind === 'starting' && <Spinner size={12} />}
        <button className="iconbtn" title={t('重新开一个终端（当前这个会被关掉）', 'Start a fresh terminal (this one is closed)')} onClick={() => ctl.current?.restart()}><Icon name="retry" size={14} /></button>
      </div>
      <div className="term-host" ref={host} />
      {status.kind === 'ended' && (
        <div className="term-ended">
          <span>{status.text}</span>
          <button className="btn sm" onClick={() => ctl.current?.restart()}>{t('新终端', 'New terminal')}</button>
        </div>
      )}
    </div>
  )
}
