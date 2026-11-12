#!/usr/bin/env node
// A stand-in for the session archive (agentsview) with the three endpoints the
// hub reads. Serves whatever is in devstack/data/sessions; `node devstack/seed.mjs` fills it.
import http from 'node:http'
import { allSessions, loadSession } from './lib.mjs'

const PORT = Number(process.env.PORT || 8792)

const send = (res, code, v) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(v))
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const q = u.searchParams
    if (u.pathname === '/api/v1/sessions') {
      const sessions = allSessions()
        .map(({ messages, ...s }) => s)
        .sort((a, b) => (a.ended_at < b.ended_at ? 1 : -1))
      return send(res, 200, { sessions, next_cursor: '' })
    }
    let m = u.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
    if (m) {
      const s = loadSession(decodeURIComponent(m[1]))
      if (!s) return send(res, 404, { error: 'not found' })
      const limit = Number(q.get('limit') || 100)
      let list = s.messages
      if (q.get('direction') === 'desc') {
        const from = q.has('from') ? Number(q.get('from')) : Infinity
        list = list.filter((x) => x.ordinal <= from).slice(-limit).reverse()
      } else {
        const from = Number(q.get('from') || 0)
        list = list.filter((x) => x.ordinal >= from).slice(0, limit)
      }
      return send(res, 200, { messages: list })
    }
    if (u.pathname === '/api/v1/search') {
      const term = (q.get('q') || '').trim()
      const re = new RegExp(esc(term), 'i')
      const results = []
      for (const s of allSessions()) {
        for (const x of s.messages) {
          const i = (x.content || '').search(re)
          if (i < 0) continue
          const a = Math.max(0, i - 40)
          const snip = x.content.slice(a, i + term.length + 80).replace(new RegExp(esc(term), 'ig'), (t) => `<mark>${t}</mark>`)
          results.push({ session_id: s.id, agent: s.agent, machine: s.machine, name: s.display_name || s.first_message.slice(0, 70), ordinal: x.ordinal, session_ended_at: s.ended_at, snippet: snip })
          if (results.length >= Number(q.get('limit') || 40)) return send(res, 200, { results })
        }
      }
      return send(res, 200, { results })
    }
    send(res, 404, { error: 'not found' })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock archive on http://127.0.0.1:${PORT}`))
