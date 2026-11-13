// Takes a screenshot of a page in headless Chrome over the DevTools protocol, after
// giving it time to load its data. This is how the pictures in docs/images are made:
//   chrome --headless=new --remote-debugging-port=9341 --user-data-dir=/tmp/x --lang=en-US about:blank &
//   node devstack/shoot.mjs 9341 'http://127.0.0.1:8791/#/setup' docs/images/setup-en.png 1360 1420
const [port, url, out, w, h] = process.argv.slice(2)
import fs from 'node:fs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Emulation.setDeviceMetricsOverride', { width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Page.navigate', { url })
await sleep(4500)
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
await send('Target.closeTarget', { targetId: target.id }).catch(() => {})
ws.close()
