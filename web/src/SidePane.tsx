// The panel to the right of a conversation: side chats, a terminal on the
// session's machine, and its files.
import { lazy, Suspense, useMemo } from 'react'
import { Machine, Session } from './api'
import { Composer, RunPrefs } from './Composer'
import { allSessions, resolveKey } from './derive'
import { Files } from './Files'
import { Icon, Spinner } from './icons'
import { Pane, SessionView } from './SessionView'
import { useStore } from './store'
import { Dropdown, MenuItem, toast, usePersisted } from './ui'
import { copyText, displayTitle, hasFeature, hasShell, ms, resumeCommand, shortTime } from './util'
import { t } from './i18n'

// xterm.js is only fetched when a terminal is first opened.
const TerminalView = lazy(() => import('./Terminal'))

export function SidePane({
  tab, setTab, session, machine, thread, setThread, forkWhy, prefs, onStartSide, onOpen,
}: {
  tab: Pane
  setTab: (p: Pane) => void
  session: Session
  machine?: Machine
  /** The side chat on show: a session id, or `run:<id>` until it has one. '' = none yet. */
  thread: string
  setThread: (key: string) => void
  /** Why a side chat cannot be started here ('' when it can). */
  forkWhy: string
  prefs: RunPrefs
  onStartSide: (prompt: string) => Promise<void>
  onOpen: (key: string) => void
}) {
  const [wide, setWide] = usePersisted('atrium.pane.wide', false)
  const tabs: [Pane, string, string][] = [['side', 'sidechat', t('边聊', 'Side chat')], ['terminal', 'terminal', t('终端', 'Terminal')], ['files', 'folder', t('文件', 'Files')]]
  return (
    <aside className={'pane' + (wide ? ' wide' : '')}>
      <div className="pane-head" data-drag>
        <div className="tabs">
          {tabs.map(([k, icon, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={icon} size={15} />{label}</button>
          ))}
        </div>
        <span className="grow" />
        <button className="iconbtn" onClick={() => setWide(!wide)} title={wide ? t('收窄面板', 'Narrow the panel') : t('加宽面板', 'Widen the panel')}><Icon name={wide ? 'narrow' : 'widen'} size={16} /></button>
        <button className="iconbtn" onClick={() => setTab('')} title={t('关闭面板', 'Close panel')}><Icon name="x" size={16} /></button>
      </div>
      {tab === 'side' ? (
        <SideChat session={session} machine={machine} thread={thread} setThread={setThread} forkWhy={forkWhy} prefs={prefs} onStart={onStartSide} onOpen={onOpen} />
      ) : !hasShell(machine) || !hasFeature(machine, tab === 'files' ? 'files' : 'term') ? (
        <ShellOff session={session} machine={machine} what={tab === 'files' ? 'files' : 'term'} />
      ) : tab === 'terminal' ? (
        <Suspense fallback={<div className="pane-empty"><Spinner size={16} /></div>}>
          <TerminalView session={session} machine={machine} />
        </Suspense>
      ) : (
        <Files session={session} machine={machine} wide={wide} onShowTerminal={() => setTab('terminal')} />
      )}
    </aside>
  )
}

/** Why the terminal or the files are not available on this machine, and how to change that. */
function ShellOff({ session, machine, what }: { session: Session; machine?: Machine; what: 'term' | 'files' }) {
  const label = machine?.label || session.machine
  const old = hasShell(machine) && !hasFeature(machine, what)
  return (
    <div className="pane-empty wide">
      <Icon name={what === 'files' ? 'folder' : 'terminal'} size={26} />
      {!machine?.runner ? (
        <>
          <b>{t(`"${label}"没有接入操控`, `${label} has no runner`)}</b>
          <p>{t('终端和文件都要通过那台机器上的 runner。这台机器只有历史记录。', 'The terminal and the files go through the runner on that machine. This one only has history.')}</p>
        </>
      ) : old ? (
        <>
          <b>{t(`"${label}"上的 runner 版本较旧`, `The runner on ${label} is out of date`)}</b>
          <p>{t('把那台机器上的 runner 更新到新版本后，这里就能用了。', 'Update the runner on that machine and this will work.')}</p>
        </>
      ) : (
        <>
          <b>{t(`"${label}"没有开启终端和文件`, `The terminal and files are off on ${label}`)}</b>
          <p>{t('默认情况下，runner 只能启动 claude 和 codex 两个程序，不能执行命令，也不能读写文件。要在这里像 SSH 上去一样使用那台机器，需要在那台机器上明确打开：', 'By default a runner can start claude and codex and nothing else: no commands, no reading or writing files. To use that machine from here as if you had SSHed in, switch it on yourself on that machine:')}</p>
          <ol>
            <li>{t('在它的 runner 配置里加一行 ', 'Add ')}<code>"allow_shell": true</code>{t('（文件通常是 ', ' to its runner config (usually ')}<code>~/.config/atrium/runner.json</code>{t('）', ')')}</li>
            <li>{t('重启 runner', 'Restart the runner')}</li>
          </ol>
          <p>{t('打开之后，能登录这个页面的人就等于能登录那台机器，请只在你信任这套部署的机器上打开。', 'Once it is on, whoever can sign in to this page can in effect sign in to that machine, so turn it on only where you trust this setup.')}</p>
        </>
      )}
      {!session.synthetic && what === 'term' && (
        <button className="btn sm" onClick={() => { copyText(resumeCommand(session)); toast(t('已复制', 'Copied')) }}><Icon name="copy" size={14} />{t('复制在终端里恢复会话的命令', 'Copy the command to resume in a terminal')}</button>
      )}
    </div>
  )
}

// ---------- side chat ----------

function SideChat({
  session, machine, thread, setThread, forkWhy, prefs, onStart, onOpen,
}: {
  session: Session
  machine?: Machine
  thread: string
  setThread: (key: string) => void
  forkWhy: string
  prefs: RunPrefs
  onStart: (prompt: string) => Promise<void>
  onOpen: (key: string) => void
}) {
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.runs)
  const metaMap = useStore((s) => s.meta)
  const threads = useMemo(
    () => allSessions(sessions, runs)
      .filter((s) => (s.forkOf || metaMap[s.id]?.fork_of) === session.id && (s.forkKind || metaMap[s.id]?.fork_kind) === 'side')
      .sort((a, b) => ms(b.ended) - ms(a.ended)),
    [sessions, runs, metaMap, session.id],
  )
  // Nothing chosen yet: show the latest side chat if there is one. 'new' is the empty box, asked for by name.
  const current = thread === 'new' ? '' : thread ? resolveKey(thread, runs) : threads[0]?.id || ''
  const name = (s: Session) => displayTitle(s, metaMap[s.id]).replace(/^(边聊：|Side: )/, '')

  return (
    <>
      <div className="pane-bar">
        {threads.length > 0 ? (
          <Dropdown className="pill" button={<><span className="ellip">{current ? name(threads.find((s) => s.id === current) || threads[0]) : t('新边聊', 'New side chat')}</span><Icon name="down" size={12} className="caret" /></>}>
            {(close) => threads.map((s) => (
              <MenuItem key={s.id} label={name(s)} hint={shortTime(ms(s.ended))} checked={s.id === current} onClick={() => { setThread(s.id); close() }} />
            ))}
          </Dropdown>
        ) : <span className="pane-note">{t('问个旁支问题，不打断主线', 'Ask on the side without touching the main thread')}</span>}
        <span className="grow" />
        {current && <button className="iconbtn" title={t('在主窗口里打开这段边聊', 'Open this side chat in the main view')} onClick={() => onOpen(current)}><Icon name="external" size={15} /></button>}
        {current && <button className="iconbtn" title={t('新边聊', 'New side chat')} onClick={() => setThread('new')}><Icon name="plus" size={16} /></button>}
      </div>
      {current ? (
        <SessionView key={current} id={current} variant="side" onBack={() => setThread('new')} onOpen={onOpen} />
      ) : (
        <div className="main side">
          <div className="pane-empty">
            <Icon name="sidechat" size={26} />
            <b>{t('边聊', 'Side chat')}</b>
            <p>{t('它带着当前对话到此刻为止的全部上下文，但你在这里问的、它在这里答的，都不会写进主对话。适合顺手问一句“这段是什么意思”，或者在主线还在跑的时候先聊别的。', 'It starts with everything this conversation knows so far, but nothing asked or answered here is written back. Good for a quick “what does this part mean”, or for talking while the main thread is still running.')}</p>
          </div>
          <Composer
            draftKey={'side:' + session.id}
            placeholder={t('问点旁支的…', 'Ask something on the side…')}
            blocked={forkWhy}
            prefs={prefs}
            machine={machine}
            agent={session.agent}
            onSend={onStart}
            compact
            autoFocus
          />
        </div>
      )}
    </>
  )
}

