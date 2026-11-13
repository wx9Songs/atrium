#!/usr/bin/env node
// Fills devstack/data with made-up sessions: a few machines, both agents, a spread
// of dates. Sessions on the "dev" machine also get a transcript on disk, so the
// local runner can continue, fork and edit them through the fake agents.
import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_HOME, CODEX_HOME, DATA, MACHINE, claudeFile, iso, publishClaude, saveSession, uuid, writeLines } from './lib.mjs'

fs.rmSync(DATA, { recursive: true, force: true })
fs.mkdirSync(CLAUDE_HOME, { recursive: true })
fs.mkdirSync(CODEX_HOME, { recursive: true })

const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H
const now = Date.now()

/** A Claude session on the dev machine: turns → transcript → archive. */
function claude(title, cwd, endedAgo, turns, model = 'claude-opus-5-5') {
  const id = uuid()
  let t = now - endedAgo - turns.length * 4 * MIN
  let parent = null
  const lines = []
  const add = (type, message) => {
    t += 20_000 + Math.floor(Math.random() * 30_000)
    const l = { type, uuid: uuid(), parentUuid: parent, sessionId: id, timestamp: iso(t), cwd, isSidechain: false, message }
    parent = l.uuid
    lines.push(l)
  }
  let n = 0
  for (const [user, ...steps] of turns) {
    add('user', { role: 'user', content: user })
    for (const s of steps) {
      if (typeof s === 'string') add('assistant', { id: 'msg_' + n++, role: 'assistant', model, content: [{ type: 'text', text: s }] })
      else if (s.think) add('assistant', { id: 'msg_' + n++, role: 'assistant', model, content: [{ type: 'thinking', thinking: s.think }] })
      else {
        const tid = 'toolu_' + n++
        add('assistant', { id: 'msg_' + n++, role: 'assistant', model, content: [{ type: 'tool_use', id: tid, name: s.tool, input: s.input }] })
        add('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: s.result || '', ...(s.error ? { is_error: true } : {}) }] })
      }
    }
  }
  writeLines(claudeFile(id, cwd), lines)
  publishClaude(id, cwd, { display_name: title })
  return id
}

/** History-only sessions from other machines (no transcript here). */
function remote(machine, agent, title, cwd, endedAgo, pairs) {
  const raw = uuid()
  const id = agent === 'codex' ? 'codex:' + raw : raw
  let t = now - endedAgo - pairs.length * 3 * MIN
  const messages = []
  for (const [u, a] of pairs) {
    messages.push({ ordinal: messages.length, role: 'user', content: u, timestamp: iso((t += 40_000)) })
    messages.push({ ordinal: messages.length, role: 'assistant', content: a, timestamp: iso((t += 50_000)), model: agent === 'codex' ? 'gpt-5.5-codex' : 'claude-sonnet-5-5' })
  }
  saveSession({
    id, source_session_id: raw, machine, agent, entrypoint: 'cli', cwd, first_message: pairs[0][0], display_name: title,
    started_at: messages[0].timestamp, ended_at: messages[messages.length - 1].timestamp,
    message_count: messages.length, user_message_count: pairs.length, messages,
  })
  if (machine === MACHINE && agent === 'codex') {
    const dir = path.join(CODEX_HOME, 'sessions', '2026', '11', '12')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `rollout-${raw}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: raw, cwd } }) + '\n')
  }
  return id
}

const proj = (n) => {
  const p = path.join(DATA, 'projects', n)
  fs.mkdirSync(p, { recursive: true })
  return p
}
// A few files in the main demo project, for the Files panel and the terminal.
const demo = proj('atrium')
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(demo, rel)), { recursive: true })
  fs.writeFileSync(path.join(demo, rel), text)
}
put('README.md', '# demo\n\nA made-up project for trying Atrium locally.\n\n- `make lint` runs the checks\n- the page lives in `web/`\n')
put('Makefile', 'lint:\n\tgo vet ./...\n\tcd web && npx tsc --noEmit\n')
put('.env', 'PORT=8791\nDEBUG=1\n')
put('web/src/App.tsx', "import { useState } from 'react'\n\n// A counter, so there is something to edit.\nexport function App() {\n  const [n, setN] = useState(0)\n  return (\n    <>\n      <button onClick={() => setN(n + 1)}>{n}</button>\n      <button onClick={() => setN(0)}>reset</button>\n    </>\n  )\n}\n")
put('web/src/util.ts', 'export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))\n')
put('server/main.py', 'import sys\n\n\ndef main() -> int:\n    print("hello from the demo project")\n    return 0\n\n\nif __name__ == "__main__":\n    sys.exit(main())\n')
put('docs/笔记.md', '# 笔记\n\n- 侧栏分组：按时间 / 按项目\n- 终端和文件需要在 runner.json 里打开 allow_shell\n')
fs.writeFileSync(path.join(demo, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))

const bash = (command, description, result, error) => ({ tool: 'Bash', input: { command, description }, result, error })

claude('重构侧栏的会话分组', proj('atrium'), 6 * MIN, [
  ['侧栏现在按时间分组，我想加一个按项目分组的开关，分组头可以折叠。先看看现在的实现。',
    { think: 'The sidebar groups by time bucket. Adding a project grouping means a second key function and a collapsed-state map.' },
    '我先读一下侧栏的代码。',
    { tool: 'Read', input: { file_path: proj('atrium') + '/web/src/Sidebar.tsx' }, result: "export function Sidebar() {\n  const groups = useMemo(() => bucketByTime(sessions), [sessions])\n  …\n}" },
    { tool: 'Grep', input: { pattern: 'timeBucket', path: 'web/src' }, result: 'web/src/util.ts:71\nweb/src/Sidebar.tsx:117' },
    bash('git log --oneline -5', 'Recent history', 'a1f3c9e sidebar: sticky group heads\n9d2e771 search palette\n77b01aa first import'),
    '现在的分组只有一种键：`timeBucket(ms(s.ended))`。要支持按项目分组，改动很小：\n\n1. 加一个 `groupBy` 状态（`time` | `project`），记在 `localStorage`\n2. 项目分组的键用 `machine|cwd`，这样两台机器上同名目录不会混在一起\n3. 分组头在项目模式下变成按钮，点一下折叠\n\n要我直接改吗？'],
  ['改吧。折叠状态不用持久化。',
    { tool: 'Edit', input: { file_path: proj('atrium') + '/web/src/Sidebar.tsx', old_string: 'const b = timeBucket(ms(s.ended), now)', new_string: "const key = groupBy === 'project' ? `${s.machine}|${s.cwd || ''}` : timeBucket(ms(s.ended), now).key" }, result: 'The file has been updated.' },
    { tool: 'TodoWrite', input: { todos: [{ content: 'groupBy 状态', status: 'completed' }, { content: '项目分组键', status: 'completed' }, { content: '分组头折叠', status: 'in_progress' }, { content: '类型检查', status: 'pending' }] }, result: 'ok' },
    bash('cd web && npx tsc --noEmit', 'Type-check', "src/Sidebar.tsx(124,11): error TS2345: Argument of type 'string' is not assignable to parameter of type 'Bucket'.", true),
    '类型检查报了一个错，是我把 `Bucket` 和字符串键混用了，修一下。',
    { tool: 'Edit', input: { file_path: proj('atrium') + '/web/src/Sidebar.tsx', old_string: 'map.get(key)', new_string: 'map.get(g.key)' }, result: 'The file has been updated.' },
    bash('cd web && npx tsc --noEmit && npx vite build', 'Type-check and build', '✓ 214 modules transformed.\n✓ built in 1.84s'),
    '改完了，类型检查和构建都过了。\n\n## 改动\n\n| 文件 | 说明 |\n|---|---|\n| `web/src/Sidebar.tsx` | 新增 `groupBy`，项目分组与折叠 |\n| `web/src/styles.css` | 分组头的按钮样式 |\n\n```tsx\nconst [groupBy, setGroupBy] = usePersisted<\'time\' | \'project\'>(\'sh.groupby\', \'time\')\n```\n\n两点说明：\n\n- 置顶的会话不参与分组，始终在最上面\n- 折叠状态只在内存里，刷新后全部展开（按你说的，不持久化）'],
  ['好。顺便把分组头做成吸顶的。', '已经是吸顶的了：`.sgroup-head` 有 `position: sticky; top: -4px`。刚才的改动没有动它，项目模式下同样生效。'],
])

// The same piece of work in English, so screenshots and a first look work in either language.
claude('Add a project view to the sidebar', proj('atrium'), 9 * MIN, [
  ['The sidebar groups sessions by date. I want a switch to group them by project instead, with group heads that collapse. Look at how it works today first.',
    { think: 'The sidebar groups by time bucket. Adding a project grouping means a second key function and a collapsed-state map.' },
    'Let me read the sidebar code.',
    { tool: 'Read', input: { file_path: proj('atrium') + '/web/src/Sidebar.tsx' }, result: "export function Sidebar() {\n  const groups = useMemo(() => bucketByTime(sessions), [sessions])\n  …\n}" },
    { tool: 'Grep', input: { pattern: 'timeBucket', path: 'web/src' }, result: 'web/src/util.ts:71\nweb/src/Sidebar.tsx:117' },
    bash('git log --oneline -5', 'Recent history', 'a1f3c9e sidebar: sticky group heads\n9d2e771 search palette\n77b01aa first import'),
    'Today there is one grouping key: `timeBucket(ms(s.ended))`. Grouping by project is a small change:\n\n1. a `groupBy` setting (`time` | `project`), remembered in `localStorage`\n2. the project key is `machine|cwd`, so two machines with a folder of the same name stay apart\n3. in project mode the group head becomes a button that collapses the group\n\nShall I go ahead?'],
  ['Go ahead. The collapsed state does not need to survive a reload.',
    { tool: 'Edit', input: { file_path: proj('atrium') + '/web/src/Sidebar.tsx', old_string: 'const b = timeBucket(ms(s.ended), now)', new_string: "const key = groupBy === 'project' ? `${s.machine}|${s.cwd || ''}` : timeBucket(ms(s.ended), now).key" }, result: 'The file has been updated.' },
    bash('cd web && npx tsc --noEmit', 'Type-check', "src/Sidebar.tsx(124,11): error TS2345: Argument of type 'string' is not assignable to parameter of type 'Bucket'.", true),
    'The type check found one mistake: I mixed up `Bucket` and the string key. Fixing it.',
    { tool: 'Edit', input: { file_path: proj('atrium') + '/web/src/Sidebar.tsx', old_string: 'map.get(key)', new_string: 'map.get(g.key)' }, result: 'The file has been updated.' },
    bash('cd web && npx tsc --noEmit && npx vite build', 'Type-check and build', '✓ 214 modules transformed.\n✓ built in 1.84s'),
    'Done. The type check and the build both pass.\n\n## What changed\n\n| File | Change |\n|---|---|\n| `web/src/Sidebar.tsx` | `groupBy`, grouping by project, collapsing |\n| `web/src/styles.css` | the group head as a button |\n\n```tsx\nconst [groupBy, setGroupBy] = usePersisted<\'time\' | \'project\'>(\'sh.groupby\', \'time\')\n```\n\nTwo things to know:\n\n- pinned sessions stay out of the groups, always on top\n- the collapsed state lives in memory only, so a reload opens everything again, as you asked'],
  ['Good. Make the group heads sticky while you are there.', 'They already are: `.sgroup-head` has `position: sticky; top: -4px`. This change did not touch that, so it holds in project mode too.'],
])

claude('排查 runner 长轮询偶发 502', proj('atrium'), 3 * H, [
  ['runner 的 poll 偶尔返回 502，日志里是 `hub: HTTP 502`，大概每小时两三次。帮我看看。',
    { think: 'Long poll waits 25s; the tunnel or a proxy in between may have a shorter idle timeout.' },
    bash("journalctl -u atrium --since '2 hours ago' | grep -c 'poll'", 'Count poll requests', '288'),
    bash('ssh vps "grep proxy_read_timeout -r /etc/nginx/"', 'Check proxy timeouts', '/etc/nginx/conf.d/atrium.conf:    proxy_read_timeout 20s;'),
    '原因找到了：Nginx 的 `proxy_read_timeout` 是 **20s**，而 runner 的长轮询等 **25s**。hub 没有命令可发的时候，连接先被 Nginx 掐掉，于是 502。\n\n两种修法：\n\n- 把 `proxy_read_timeout` 调到 60s（推荐）\n- 或者让 runner 用 `?wait=15`\n\n我建议改 Nginx，因为 SSE 的 `/api/events` 也会受同一个超时影响。'],
])

claude('给登录页写个说明', proj('atrium'), 26 * H, [
  ['登录页的文案太硬了，帮我改得友好一点，中英文都要。', '可以。现在的文案是“这个页面需要先登录。”，我建议：\n\n> **中文**：先确认一下是你。在终端里运行下面这条命令，它会打开已登录的页面。\n>\n> **English**: Let’s make sure it’s you. Run this in a terminal and it opens the page signed in.\n\n要直接改到 `App.tsx` 里吗？'],
])

claude('数据清洗脚本加速', proj('data-pipeline'), 2 * DAY, [
  ['clean.py 跑 200 万行要 40 分钟，瓶颈在哪？',
    bash('python -m cProfile -s cumtime clean.py --limit 50000 | head -20', 'Profile a sample', '   50000    0.412   18.3  clean.py:88(normalize_row)\n   50000   17.611   17.6  re.py:203(sub)'),
    '瓶颈在 `normalize_row` 里的正则：每一行都重新编译了 5 个 pattern。把它们提到模块级 `re.compile`，再用 `str.translate` 替掉其中两个，样本上从 18.3s 降到 2.1s。'],
], 'claude-sonnet-5-5')

remote(MACHINE, 'codex', 'Makefile 加 lint 目标', proj('atrium'), 50 * MIN, [['给 Makefile 加一个 lint 目标，跑 go vet 和 tsc。', 'Added a `lint` target:\n\n```make\nlint:\n\tgo vet ./...\n\tcd web && npx tsc --noEmit\n```']])
remote('mac2', 'claude', 'Homebrew rsync 版本不兼容', '/Users/dev/dotfiles', 5 * H, [['macOS 自带的 rsync 推不上去，报 protocol version mismatch。', '自带的是 openrsync（协议 29）。`brew install rsync` 装 3.x，然后在推送脚本里用 `/opt/homebrew/bin/rsync`。']])
remote('mac2', 'codex', '排查 Claude 登录未显示验证码', '/Users/dev', 9 * H, [['claude /login 之后浏览器没有显示验证码', 'The callback page needs the same browser profile that started the flow. Copy the URL into the profile where you are signed in.']])
remote('gpu-a', 'claude', '训练 pipeline 调参', '/root/train', 7 * H, [['把 pipeline 的 batch size 调到 64 试试', '调好了，`configs/train.yaml` 里 `batch_size: 64`。显存占用 71%，吞吐提升约 1.7×。']])
remote('gpu-a', 'claude', '训练日志里的 NaN', '/root/train', 4 * DAY, [['第 3 个 epoch 开始 loss 变成 NaN', '梯度在第 2.8 个 epoch 爆了。把学习率从 3e-4 降到 1e-4，并打开 `grad_clip: 1.0`。']])
remote('gpu-b', 'claude', '评测脚本对齐', '/root/eval-suite', 9 * DAY, [['评测集的分词和训练时不一致', '是的，评测用了默认 tokenizer。改成从 checkpoint 目录加载同一个 tokenizer 后，BLEU 从 21.4 回到 27.9。']])
remote('gpu-b', 'codex', 'Dockerfile 瘦身', '/root/eval-suite', 20 * DAY, [['镜像 9GB 太大了', 'Switched to a multi-stage build and dropped the dev headers: 9.1 GB → 3.4 GB.']])
remote('macbook-old', 'claude', '旧电脑上的笔记整理', '/Users/dev/notes', 45 * DAY, [['把 notes 目录按年份归档', '归档完成：2023/、2024/、2025/ 三个目录，共移动 412 个文件。']])
remote('mac2', 'claude', '', '/Users/dev/tmp', 3 * DAY, [['ls', 'README.md']])

console.log('seeded', fs.readdirSync(path.join(DATA, 'sessions')).length, 'sessions into', DATA)
