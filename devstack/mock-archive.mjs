#!/usr/bin/env node
// A stand-in for the session archive (agentsview) with the endpoints the
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
    if (u.pathname === '/api/v1/usage/summary') {
      // Made-up but steady numbers: each day's size comes from its date.
      const day = (d) => d.toISOString().slice(0, 10)
      const tok = (n, cached) => ({ inputTokens: Math.round(n * 0.004), outputTokens: Math.round(n), cacheCreationTokens: Math.round(n * 6.1), cacheReadTokens: Math.round(n * cached), cost: { microdollars: Math.round(n * 190) } })
      const sum = (list) => list.reduce((a, x) => { for (const k of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens']) a[k] += x[k]; a.cost.microdollars += x.cost.microdollars; return a }, tok(0, 0))
      const daily = []
      for (let t = new Date(q.get('from') + 'T00:00:00Z'); day(t) <= q.get('to'); t = new Date(+t + 86400_000)) {
        const seed = (t.getUTCDate() * 37 + t.getUTCMonth() * 11) % 17
        if (seed === 3) continue // a day off
        const claude = tok(90_000 + seed * 41_000, 230), codex = tok(seed % 3 ? 6_000 + seed * 1_900 : 0, 190)
        const all = sum([claude, codex])
        daily.push({
          date: day(t), ...all, totalCost: all.cost,
          agentBreakdowns: [{ agent: 'claude', ...claude }, ...(codex.outputTokens ? [{ agent: 'codex', ...codex }] : [])],
          machineBreakdowns: [{ machineName: 'dev', ...tok(all.outputTokens * 0.55, 220) }, { machineName: 'gpu-a', ...tok(all.outputTokens * 0.33, 220) }, { machineName: 'mac2', ...tok(all.outputTokens * 0.12, 220) }],
        })
      }
      const agent = (name) => ({ agent: name, ...sum(daily.flatMap((d) => d.agentBreakdowns.filter((x) => x.agent === name))) })
      const claude = agent('claude'), codex = agent('codex')
      const part = (model, x, f) => ({ model, ...tok(x.outputTokens * f, 228) })
      return send(res, 200, {
        from: q.get('from'), to: q.get('to'), daily, totals: sum(daily), agentTotals: [claude, codex],
        modelTotals: [part('claude-opus-4-7', claude, 0.72), part('claude-sonnet-4-6', claude, 0.25), part('claude-haiku-4-5', claude, 0.03), part('gpt-5.5-codex', codex, 1)],
      })
    }
    send(res, 404, { error: 'not found' })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock archive on http://127.0.0.1:${PORT}`))
