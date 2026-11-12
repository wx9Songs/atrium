// The files panel: the session's folder as a tree, and a small editor for
// text files. Enough to look at what the agent changed and fix a line or a
// config value without leaving the page; not an IDE.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, FsEntry, FsFile, Machine, Session } from './api'
import { Icon, Spinner } from './icons'
import { highlight } from './md'
import { toast } from './ui'
import { copyText, shortPath } from './util'
import { sendToTerminal } from './termbus'
import { t } from './i18n'

type Dir = { entries?: FsEntry[]; error?: string; loading?: boolean; more?: boolean }

const join = (dir: string, name: string) => dir.replace(/\/+$/, '') + '/' + name
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || '/'
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/** The highlighter's name for a file, from its name or extension. */
function langOf(path: string): string {
  const name = baseName(path).toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'makefile' || name.endsWith('.mk')) return 'bash'
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return ({ htm: 'html', mjs: 'js', cjs: 'js', h: 'c', hpp: 'cpp', cc: 'cpp', conf: 'ini', cfg: 'ini', env: 'bash', zshrc: 'bash', bashrc: 'bash', svg: 'xml', plist: 'xml', swift: 'typescript', kt: 'java' } as Record<string, string>)[ext] || ext
}

export function Files({ session, machine, wide, onShowTerminal }: { session: Session; machine?: Machine; wide: boolean; onShowTerminal: () => void }) {
  const home = session.cwd || machine?.info?.home || '~'
  const name = session.machine
  const [root, setRoot] = useState(home)
  const [dirs, setDirs] = useState<Record<string, Dir>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [file, setFile] = useState<(FsFile & { error?: string }) | null>(null)
  const [draft, setDraft] = useState('')
  const [loadingFile, setLoadingFile] = useState('')
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState('')
  const [wanted, setWanted] = useState('') // a file asked for while the open one has unsaved changes
  const seq = useRef(0)

  const dirty = !!file && file.content !== undefined && draft !== file.content

  const loadDir = useCallback(async (path: string) => {
    setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true, error: undefined } }))
    try {
      const res = await api.fsList(name, path)
      setDirs((d) => ({ ...d, [path]: { entries: res.entries, more: res.more } }))
      return res
    } catch (e: any) {
      setDirs((d) => ({ ...d, [path]: { error: e.message || t('读取目录失败', 'Could not read the folder') } }))
    }
  }, [name])

  useEffect(() => {
    setRoot(home)
    setDirs({})
    setOpen(new Set())
    setFile(null)
    setWanted('')
  }, [home, name])
  useEffect(() => {
    if (!dirs[root]) loadDir(root)
  }, [root, dirs, loadDir])

  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!dirs[path]?.entries) loadDir(path)
    }
    setOpen(next)
  }

  const refresh = () => {
    loadDir(root)
    for (const p of open) loadDir(p)
  }

  const openFile = async (path: string, force = false) => {
    if (dirty && !force) return setWanted(path)
    setWanted('')
    setConflict('')
    const my = ++seq.current
    setLoadingFile(path)
    try {
      const f = await api.fsRead(name, path)
      if (my !== seq.current) return
      setFile(f)
      setDraft(f.content ?? '')
    } catch (e: any) {
      if (my === seq.current) setFile({ path, size: 0, mtime: 0, error: e.message || t('打不开这个文件', 'Cannot open this file') })
    } finally {
      if (my === seq.current) setLoadingFile('')
    }
  }

  const save = async (overwrite = false) => {
    if (!file || saving || file.content === undefined) return
    setSaving(true)
    setConflict('')
    try {
      const res = await api.fsWrite(name, file.path, draft, overwrite ? 0 : file.mtime)
      setFile({ ...file, content: draft, mtime: res.mtime, size: res.size })
      toast(t('已保存', 'Saved'))
      if (wanted) openFile(wanted, true)
    } catch (e: any) {
      setConflict(e.message || t('保存失败', 'Could not save'))
    } finally {
      setSaving(false)
    }
  }

  const close = () => {
    if (dirty) return setWanted('close')
    setFile(null)
  }

  const rows: JSX.Element[] = []
  const walk = (dir: string, depth: number) => {
    const d = dirs[dir]
    if (!d) return
    if (d.error) rows.push(<div key={dir + '!e'} className="frow note" style={{ paddingLeft: 12 + depth * 14 }}>{d.error}</div>)
    for (const e of d.entries || []) {
      const p = join(dir, e.name)
      const isOpen = open.has(p)
      rows.push(
        <button
          key={p}
          className={'frow' + (file?.path === p ? ' on' : '') + (e.name.startsWith('.') ? ' hid' : '')}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={e.dir ? p : `${p}\n${fmtSize(e.size || 0)}`}
          onClick={() => (e.dir ? toggle(p) : openFile(p))}
        >
          {e.dir ? <Icon name={isOpen ? 'down' : 'right'} size={11} className="tw" /> : <span className="tw" />}
          <Icon name={e.dir ? 'folder' : 'file'} size={14} />
          <span className="ellip">{e.name}</span>
          {(loadingFile === p || (e.dir && isOpen && dirs[p]?.loading)) && <Spinner size={11} />}
        </button>,
      )
      if (e.dir && isOpen) walk(p, depth + 1)
    }
    if (d.more) rows.push(<div key={dir + '!m'} className="frow note" style={{ paddingLeft: 12 + depth * 14 }}>{t('目录太大，只列出了前一部分', 'Too many entries; only the first ones are listed')}</div>)
  }
  walk(root, 0)

  const rootDir = dirs[root]
  const showTree = wide || !file
  const rel = file ? (file.path.startsWith(root.replace(/\/+$/, '') + '/') ? file.path.slice(root.replace(/\/+$/, '').length + 1) : shortPath(file.path, 60)) : ''

  return (
    <div className={'files' + (wide ? ' wide' : '')}>
      {showTree && (
        <div className="ftree">
          <div className="ftree-head">
            <button className="iconbtn" title={t('上一级目录', 'Parent folder')} disabled={root === '/'} onClick={() => setRoot(root.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/')}><Icon name="up" size={14} /></button>
            <span className="mono ellip" title={root}>{shortPath(root, 34)}</span>
            <span className="grow" />
            {root !== home && <button className="iconbtn" title={t('回到会话目录', 'Back to the session folder')} onClick={() => setRoot(home)}><Icon name="back" size={14} /></button>}
            <button className="iconbtn" title={t('在终端里打开这个目录', 'Open this folder in the terminal')} onClick={() => { sendToTerminal(session.id, `cd ${JSON.stringify(root)}\n`); onShowTerminal() }}><Icon name="terminal" size={14} /></button>
            <button className="iconbtn" title={t('刷新', 'Refresh')} onClick={refresh}><Icon name="refresh" size={14} /></button>
          </div>
          <div className="ftree-list">
            {rootDir?.loading && !rootDir.entries && <div className="frow note"><Spinner size={12} /> {t('正在读取…', 'Reading…')}</div>}
            {rows}
            {rootDir?.entries?.length === 0 && <div className="frow note">{t('空目录', 'Empty folder')}</div>}
          </div>
        </div>
      )}
      {file && (
        <div className="fview">
          <div className="fview-head">
            {!wide && <button className="iconbtn" title={t('返回文件列表', 'Back to the files')} onClick={close}><Icon name="back" size={15} /></button>}
            <span className="fname ellip" title={file.path}>{rel}{dirty && <i title={t('有未保存的修改', 'Unsaved changes')} />}</span>
            <span className="grow" />
            <button className="iconbtn" title={t('复制路径', 'Copy path')} onClick={() => { copyText(file.path); toast(t('已复制路径', 'Path copied')) }}><Icon name="copy" size={14} /></button>
            {file.content !== undefined && (
              <button className="btn sm primary" disabled={!dirty || saving} onClick={() => save()} title="⌘S">{saving ? <Spinner size={12} /> : t('保存', 'Save')}</button>
            )}
            {wide && <button className="iconbtn" title={t('关闭文件', 'Close file')} onClick={close}><Icon name="x" size={15} /></button>}
          </div>
          {(conflict || wanted) && (
            <div className="fview-bar">
              {conflict ? (
                <>
                  <span>{conflict}</span>
                  <button className="linkbtn" onClick={() => openFile(file.path, true)}>{t('重新载入', 'Reload')}</button>
                  <button className="linkbtn" onClick={() => save(true)}>{t('覆盖保存', 'Overwrite')}</button>
                </>
              ) : (
                <>
                  <span>{t('这个文件有未保存的修改。', 'This file has unsaved changes.')}</span>
                  <button className="linkbtn" onClick={() => save()}>{t('保存', 'Save')}</button>
                  <button className="linkbtn" onClick={() => { const w = wanted; setWanted(''); if (w === 'close') setFile(null); else openFile(w, true) }}>{t('不保存', 'Discard')}</button>
                  <button className="linkbtn" onClick={() => setWanted('')}>{t('取消', 'Cancel')}</button>
                </>
              )}
            </div>
          )}
          {file.error ? <div className="fview-note">{file.error}</div>
            : file.too_big ? <div className="fview-note">{t(`这个文件有 ${fmtSize(file.size)}，太大了，不在这里打开。可以在终端里查看。`, `This file is ${fmtSize(file.size)}, too large to open here. Look at it in the terminal.`)}</div>
              : file.binary ? <div className="fview-note">{t(`这不是文本文件（${fmtSize(file.size)}），不能在这里查看或编辑。`, `This is not a text file (${fmtSize(file.size)}), so it cannot be shown or edited here.`)}</div>
                : <CodeEditor key={file.path} value={draft} onChange={setDraft} lang={langOf(file.path)} onSave={() => save()} />}
        </div>
      )}
      {wide && !file && <div className="fview empty"><Icon name="file" size={24} /><span>{t('选一个文件查看或编辑', 'Pick a file to view or edit')}</span></div>}
    </div>
  )
}

// A text area laid exactly over a highlighted copy of the same text: you type
// into the (transparent) text area and see the coloured copy underneath.
function CodeEditor({ value, onChange, lang, onSave }: { value: string; onChange: (v: string) => void; lang: string; onSave: () => void }) {
  const ta = useRef<HTMLTextAreaElement>(null)
  // Colouring a very large file on every keystroke is too slow: those are edited as plain text.
  const plain = value.length > 150_000
  const html = useMemo(() => (plain ? '' : highlight(value, lang)), [value, lang, plain])
  const lines = useMemo(() => value.split('\n').length, [value])
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join('\n'), [lines])
  const indent = useMemo(() => (/^\t/m.test(value) ? '\t' : /^ {4}\S/m.test(value) && !/^ {2}\S/m.test(value) ? '    ' : '  '), []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="editor">
      <div className="editor-in">
        <pre className="gutter" aria-hidden="true">{numbers}</pre>
        <div className={'code' + (plain ? ' plain' : '')}>
          <pre aria-hidden="true"><code className="hljs" dangerouslySetInnerHTML={{ __html: html + '\n' }} /></pre>
          <textarea
            ref={ta}
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                onSave()
              } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                // execCommand keeps the edit on the undo stack; the fallback covers browsers that dropped it.
                if (!document.execCommand('insertText', false, indent)) {
                  const el = e.currentTarget
                  const { selectionStart: a, selectionEnd: b } = el
                  onChange(value.slice(0, a) + indent + value.slice(b))
                  requestAnimationFrame(() => el.setSelectionRange(a + indent.length, a + indent.length))
                }
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}
