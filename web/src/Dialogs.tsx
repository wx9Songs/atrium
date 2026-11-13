// The search palette: titles first, then every message on every machine.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, SearchHit } from './api'
import { allSessions } from './derive'
import { AgentTag, Icon, Spinner } from './icons'
import { snippetHtml } from './md'
import { useStore } from './store'
import { copyText, displayTitle, folderName, imeKey, machineLabel, ms, shortTime } from './util'
import { toast } from './ui'
import { t } from './i18n'

// ---------- search everything ----------

export function SearchPalette({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string, ord?: number) => void }) {
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.runs)
  const metaMap = useStore((s) => s.meta)
  const machines = useStore((s) => s.machines)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(0)
  const seq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const titleHits = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return allSessions(sessions, runs)
      .filter((s) => {
        const hay = `${displayTitle(s, metaMap[s.id])} ${s.cwd || ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      .sort((a, b) => ms(b.ended) - ms(a.ended))
      .slice(0, 8)
  }, [q, sessions, runs, metaMap])

  useEffect(() => {
    const query = q.trim()
    setSel(0)
    if (query.length < 2) {
      setHits([])
      setBusy(false)
      return
    }
    const my = ++seq.current
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const d = await api.search(query)
        if (my === seq.current) {
          setHits(d.hits)
          setErr('')
        }
      } catch (e: any) {
        if (my === seq.current) setErr(e.message || t('搜索失败', 'Search failed'))
      } finally {
        if (my === seq.current) setBusy(false)
      }
    }, 260)
    return () => clearTimeout(timer)
  }, [q])

  const items: { id: string; ord?: number }[] = [...titleHits.map((s) => ({ id: s.id })), ...hits.map((h) => ({ id: h.session_id, ord: h.ord }))]
  const go = (i: number) => {
    const it = items[i]
    if (it) onOpen(it.id, it.ord)
  }
  useEffect(() => {
    listRef.current?.querySelector('.hit.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  return (
    <div className="overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            autoFocus
            value={q}
            placeholder={t('搜索所有机器上的对话内容…', 'Search conversations on every machine…')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (imeKey(e)) return
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              else if (e.key === 'Enter') go(sel)
            }}
          />
          {busy && <Spinner size={15} />}
          <button className="kbd" onClick={onClose}>Esc</button>
        </div>
        <div className="palette-list" ref={listRef}>
          {q.trim().length < 2 && <div className="palette-empty">{t('输入关键词，搜索标题和每一条对话内容。', 'Type to search titles and every message.')}</div>}
          {err && <div className="palette-empty error">{err}</div>}
          {titleHits.length > 0 && <div className="palette-sec">{t('标题匹配', 'Titles')}</div>}
          {titleHits.map((s, i) => (
            <button key={'t' + s.id} className={'hit' + (sel === i ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
              <div className="hit-top">
                <span className="hit-title">{displayTitle(s, metaMap[s.id])}</span>
                <span className="hit-time">{shortTime(ms(s.ended))}</span>
              </div>
              <div className="hit-meta"><AgentTag agent={s.agent} /><span>{machineLabel(machines, s.machine)}</span>{s.cwd && <span>{folderName(s.cwd)}</span>}</div>
            </button>
          ))}
          {hits.length > 0 && <div className="palette-sec">{t('对话内容', 'Messages')}</div>}
          {hits.map((h, j) => {
            const i = titleHits.length + j
            return (
              <button key={'h' + h.session_id + h.ord} className={'hit' + (sel === i ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
                <div className="hit-top">
                  <span className="hit-title">{metaMap[h.session_id]?.title || h.title || t('（无标题）', '(untitled)')}</span>
                  <span className="hit-time">{shortTime(ms(h.ended))}</span>
                </div>
                <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
                <div className="hit-meta"><AgentTag agent={h.agent} /><span>{machineLabel(machines, h.machine)}</span></div>
              </button>
            )
          })}
          {q.trim().length >= 2 && !busy && !err && items.length === 0 && <div className="palette-empty">{t('没有找到相关内容。', 'Nothing found.')}</div>}
        </div>
      </div>
    </div>
  )
}

// ---------- sign in on another device ----------

/**
 * A one-time link made by this, already signed-in, page. Pasted into the
 * sign-in box on another phone or computer it signs that device in, with no
 * terminal and no access to the server needed.
 */
export function DeviceLink({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const make = async () => {
    setBusy(true)
    setErr('')
    try {
      const d = await api.loginLink()
      setLink(`${location.origin}/#login=${d.code}`)
    } catch (e: any) {
      setErr(e.message || t('生成失败', 'Could not make a link'))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { make() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label={t('在另一台设备上登录', 'Sign in on another device')}>
        <h2>{t('在另一台设备上登录', 'Sign in on another device')}</h2>
        <p>{t('在那台设备上打开 Atrium，把下面这条链接粘贴到登录页的输入框里。链接 15 分钟内有效，只能用一次。', 'Open Atrium on that device and paste this link into the box on its sign-in page. The link works once, within 15 minutes.')}</p>
        <div className="setup-cmd">
          <code>{busy ? t('正在生成…', 'Making a link…') : link}</code>
          <button className="linkbtn" disabled={!link || busy} onClick={() => { copyText(link); toast(t('已复制', 'Copied')) }}>{t('复制', 'Copy')}</button>
        </div>
        {err && <div className="errtext">{err}</div>}
        <p className="dim">{t('拿到这条链接的人能看到并操作你的全部会话，只发给你自己的设备。两台设备访问 Atrium 的地址不同也没关系：粘贴进输入框时只取其中的登录码。', 'Whoever has this link can see and run everything here, so send it only to your own devices. It does not matter if the two devices reach Atrium at different addresses: the box only takes the sign-in code out of the link.')}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={make} disabled={busy}>{busy ? <Spinner size={13} /> : t('换一条', 'New link')}</button>
          <button className="btn primary" onClick={onClose}>{t('完成', 'Done')}</button>
        </div>
      </div>
    </div>
  )
}
