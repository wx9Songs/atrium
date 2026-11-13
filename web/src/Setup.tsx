// The setup guide: what a new install still needs, the commands to run on each
// machine, and a live check that every machine is really connected. It opens by
// itself the first time, and stays reachable from the settings menu.
import { ReactNode, useMemo, useState } from 'react'
import { Machine } from './api'
import { Icon, Logo, Spinner } from './icons'
import { useStore } from './store'
import { kbd, toast } from './ui'
import { copyText } from './util'
import { t } from './i18n'

export const SETUP_SEEN = 'atrium.setup.seen'

type Check = { state: 'ok' | 'wait' | 'bad' | 'info'; text: string; fix?: string }

function Cmd({ where, text }: { where: string; text: string }) {
  return (
    <div className="setup-cmd">
      <span className="setup-where">{where}</span>
      <code>{text}</code>
      <button className="linkbtn" onClick={() => { copyText(text); toast(t('已复制', 'Copied')) }}>{t('复制', 'Copy')}</button>
    </div>
  )
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <section className={'setup-step' + (done ? ' done' : '')}>
      <div className="setup-num">{done ? <Icon name="check" size={15} /> : n}</div>
      <div className="setup-body">
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  )
}

// What can be verified about one machine from what the hub already knows.
function checksFor(m: Machine, sessions: number): Check[] {
  const agents = m.info?.agents || {}
  // An agent counts as found when the runner located it, or when its CLI has already reported what it offers.
  const found = ['claude', 'codex'].filter((a) => agents[a]?.path || m.caps?.[a])
  const names = found.map((a) => `${a === 'claude' ? 'Claude Code' : 'Codex'}${agents[a]?.version ? ' ' + String(agents[a].version).replace(/\s*\(.*\)/, '') : ''}`)
  const out: Check[] = []
  out.push(m.online
    ? { state: 'ok', text: t('runner 已连接', 'Runner connected') }
    : m.last_seen
      ? { state: 'bad', text: t('runner 之前连过，现在不在线', 'Runner was connected, offline now'), fix: t('确认那台机器开着、能联网；看它的 runner 日志。', 'Check the machine is on and online; look at its runner log.') }
      : { state: 'wait', text: t('等 runner 第一次连上来…', 'Waiting for the runner to connect…'), fix: t('在那台机器上跑完安装命令后，几秒内会变成已连接。', 'It turns green a few seconds after the install command finishes on that machine.') })
  if (m.online && !m.info && !found.length) {
    // Connected, but the runner has not described the machine yet (right after the hub restarts).
    out.push({ state: 'wait', text: t('等 runner 报告这台机器上装了什么…', 'Waiting for the runner to report what is installed…') })
  } else if (m.online || m.info) {
    out.push(found.length
      ? { state: 'ok', text: t(`找到 ${names.join('、')}`, `Found ${names.join(', ')}`) }
      : { state: 'bad', text: t('没找到 claude 或 codex', 'Neither claude nor codex was found'), fix: t('在那台机器上装好并登录其中一个，确认在终端里能直接运行，然后重启 runner。', 'Install and sign in to one of them there, make sure it runs from a terminal, then restart the runner.') })
  }
  out.push(sessions > 0
    ? { state: 'ok', text: t(`历史记录已到达（${sessions} 个会话）`, `History arrived (${sessions} sessions)`) }
    : { state: 'info', text: t('还没有历史记录', 'No history yet'), fix: t('这台机器上用过 claude 或 codex 才会有；新的会话大约一分钟内出现。', 'There is some once claude or codex has been used on this machine; new sessions show up within about a minute.') })
  return out
}

export function Setup({ onStart, onBack }: { onStart: () => void; onBack: () => void }) {
  const machines = useStore((s) => s.machines)
  const sessions = useStore((s) => s.sessions)
  const mode = useStore((s) => s.mode)
  const loaded = useStore((s) => s.loaded)
  const local = mode === 'local'
  const [name, setName] = useState('laptop')
  const [server, setServer] = useState('my.server')

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const s of sessions) c.set(s.machine, (c.get(s.machine) || 0) + 1)
    return c
  }, [sessions])
  const runners = machines.filter((m) => m.runner)
  const ready = runners.filter((m) => m.online && ['claude', 'codex'].some((a) => m.info?.agents?.[a]?.path || m.caps?.[a]))
  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'laptop'
  const host = server.trim() || 'my.server'

  const finish = () => {
    try { localStorage.setItem(SETUP_SEEN, '1') } catch { /* private mode */ }
    onStart()
  }

  return (
    <div className="main setup">
      <header className="chat-head bare" data-drag>
        <button className="iconbtn only-mobile" onClick={onBack} title={t('返回列表', 'Back to the list')}><Icon name="back" size={18} /></button>
      </header>
      <div className="setup-scroll">
        <div className="setup-col">
          <div className="setup-hero">
            <Logo size={56} />
            <h1>{t('把机器接进 Atrium', 'Connect your machines to Atrium')}</h1>
            <p>{local
              ? t('这是单机安装：页面、历史记录和 runner 都在这台电脑上，不需要服务器。下面检查一下它是否已经就绪。', 'This is a one-computer install: the page, the history and the runner all live on this computer, with no server. The check below shows whether it is ready.')
              : t('每台要用的机器做一次：登记、安装、检查。全部变绿就可以开始了。', 'Once per machine: register it, install, check. When everything is green you are ready.')}</p>
          </div>

          <Step n={1} title={t('页面已经在运行', 'The page is running')} done>
            <p>{local
              ? t('你现在看到的就是它。它只监听本机，地址是：', 'You are looking at it. It listens on this computer only, at:')
              : t('你现在看到的就是它。它只监听服务器本机，机器通过 SSH 隧道访问：', 'You are looking at it. It listens on the server’s loopback only; machines reach it through an SSH tunnel:')} <code>{location.origin}</code></p>
          </Step>

          <Step n={2} title={local ? t('这台电脑已经接入', 'This computer is connected') : t('在每台机器上接入', 'Connect each machine')} done={local ? ready.length > 0 : runners.length > 0}>
            {local ? (
              <>
                <p>{t('安装脚本已经在这台电脑上装好了 runner，不用再做什么。以后升级，重新 make 再跑一次安装脚本即可：', 'The install script already set up the runner on this computer; nothing more to do here. To update later, run make and the install script again:')}</p>
                <Cmd where={t('这台电脑', 'this computer')} text="make && ./scripts/local-install.sh install" />
                <p className="dim">{t('想把别的机器也接进来？它们需要一台都能连到的电脑当服务器：可以是云服务器，也可以是家里一直开着的 Linux 小主机。见 docs/install.md。', 'Want other machines too? They need one computer they can all reach to act as the server: a cloud server, or a Linux box at home that stays on. See docs/install.md.')}</p>
              </>
            ) : (
              <>
                <p>{t('每台机器需要：装好并登录 claude 或 codex、能 SSH 到服务器、rsync 3.x（macOS 自带的不行：brew install rsync）。接入后它会跑三个后台小任务：推送历史记录、保持到服务器的隧道、runner。', 'Each machine needs: claude or codex installed and signed in, SSH access to the server, and rsync 3.x (the one macOS ships does not work: brew install rsync). Once connected it runs three small background jobs: pushing transcripts, keeping a tunnel to the server, and the runner.')}</p>
                <div className="setup-fill">
                  <label>{t('机器名', 'Machine name')}<input className="input sm mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} /></label>
                  <label>{t('服务器地址', 'Server address')}<input className="input sm mono" value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} /></label>
                </div>
                <ol className="setup-list">
                  <li>
                    <span>{t('在那台机器上生成一把专用密钥，它会打印公钥：', 'On the machine, create its dedicated key; it prints the public half:')}</span>
                    <Cmd where={t('机器', 'machine')} text="./scripts/machine-install.sh key" />
                  </li>
                  <li>
                    <span>{t('在服务器上登记这台机器（贴上刚才的公钥），它会打印一个 runner 令牌：', 'On the server, register the machine with that public key; it prints a runner token:')}</span>
                    <Cmd where={t('服务器', 'server')} text={`atrium-machine add ${safeName} 'ssh-ed25519 AAAA…'`} />
                  </li>
                  <li>
                    <span>{t('回到那台机器，用令牌安装：', 'Back on the machine, install with the token:')}</span>
                    <Cmd where={t('机器', 'machine')} text={`./scripts/machine-install.sh install --server ${host} --name ${safeName} --token TOKEN`} />
                  </li>
                </ol>
                <p className="dim">{t('密钥只能做两件事：往自己的文件夹里写历史记录、打开到页面的那一条隧道。凭据和设置不会离开机器。', 'The key can do exactly two things: write transcripts into its own folder, and open that one tunnel to the page. Credentials and settings never leave the machine.')}</p>
              </>
            )}
          </Step>

          <Step n={3} title={t('检查', 'Check')} done={ready.length > 0}>
            {!loaded && <p className="dim"><Spinner size={12} /> {t('正在读取…', 'Loading…')}</p>}
            {loaded && runners.length === 0 && (
              <p className="setup-empty"><Spinner size={12} /> {t('还没有机器登记。做完第 2 步，这里会自动出现，不用刷新。', 'No machine is registered yet. Finish step 2 and it appears here by itself, no reload needed.')}</p>
            )}
            {runners.map((m) => (
              <div className="setup-machine" key={m.name}>
                <div className="setup-mname"><Icon name="machine" size={15} /><b>{m.label}</b>{m.label !== m.name && <span className="dim mono">{m.name}</span>}</div>
                <ul>
                  {checksFor(m, counts.get(m.name) || 0).map((c, i) => (
                    <li key={i} className={c.state}>
                      <span className="setup-mark">{c.state === 'ok' ? <Icon name="check" size={13} /> : c.state === 'wait' ? <Spinner size={11} /> : c.state === 'bad' ? <Icon name="x" size={13} /> : <Icon name="dots" size={13} />}</span>
                      <span>{c.text}{c.fix && <span className="setup-fix">{c.fix}</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {runners.length > 0 && <p className="dim">{t('这里是实时的：机器上线、掉线都会马上反映出来。', 'This is live: a machine coming online or dropping off shows up right away.')}</p>}
          </Step>

          <Step n={4} title={t('开始使用', 'Start')}>
            <p>{ready.length > 0
              ? t(`${ready.length} 台机器已就绪。开一个新会话，或者在左边点开任何一个旧会话接着聊。`, `${ready.length} ${ready.length === 1 ? 'machine is' : 'machines are'} ready. Start a new session, or open any old one on the left and carry on.`)
              : t('至少一台机器全部变绿后就能开始。现在也可以先看看页面，只是还不能发消息。', 'You can start once one machine is all green. You can look around now too, but not send messages yet.')}</p>
            <div className="setup-actions">
              <button className="btn primary" onClick={finish}>{ready.length > 0 ? t('开始第一个会话', 'Start a session') : t('先看看页面', 'Look around')}</button>
              <span className="dim">{t('这个向导以后在左下角 ⋯ 菜单里。', 'This guide stays in the ⋯ menu at the bottom left.')}</span>
            </div>
            <ul className="setup-tips">
              <li><kbd>{kbd('K')}</kbd>{t('全文搜索所有会话', 'Search everything')}</li>
              <li><kbd>/</kbd>{t('命令菜单：分叉、边聊、换模型…', 'Commands: fork, side chat, model…')}</li>
              <li><kbd>{kbd('.')}</kbd>{t('边聊：问一句不写回原会话的话', 'Side chat: ask without writing to the session')}</li>
              <li><kbd>{kbd('J')}</kbd>{t('终端和文件（要在那台机器的 runner.json 里打开 allow_shell）', 'Terminal and files (turn on allow_shell in that machine’s runner.json)')}</li>
            </ul>
          </Step>
        </div>
      </div>
    </div>
  )
}
