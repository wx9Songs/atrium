// Data derived from the store: the full session list (archive + sessions
// started here that the archive has not indexed yet) and per-session runs.
import { Run, Session } from './api'

let lastS: Session[] | null = null
let lastR: Record<string, Run> | null = null
let lastOut: Session[] = []

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

export const runSessionKey = (r: Run) => r.session_id || `run:${r.id}`

export function allSessions(sessions: Session[], runs: Record<string, Run>): Session[] {
  if (sessions === lastS && runs === lastR) return lastOut
  lastS = sessions
  lastR = runs
  const have = new Set(sessions.map((s) => s.id))
  const groups = new Map<string, Run[]>()
  for (const r of Object.values(runs)) {
    const k = runSessionKey(r)
    if (have.has(k)) continue
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  const extra: Session[] = []
  for (const [k, g] of groups) {
    g.sort((a, b) => a.created - b.created)
    const first = g[0]
    const last = g[g.length - 1]
    // Only sessions that began here get a placeholder row; a follow-up to a
    // session the archive lost track of is not listed.
    if (!first.is_new) continue
    extra.push({
      id: k,
      nid: last.native_id,
      agent: first.agent,
      machine: first.machine,
      title: first.title || clip(first.prompt, 60),
      forkOf: first.fork_of,
      forkKind: first.fork_kind,
      forkOrd: first.fork_ord,
      first: clip(first.prompt, 160),
      cwd: first.cwd,
      started: new Date(first.created).toISOString(),
      ended: new Date(last.ended || last.created).toISOString(),
      n: 0,
      nu: g.length,
      entry: 'hub',
      synthetic: true,
    })
  }
  lastOut = extra.length ? [...extra, ...sessions] : sessions
  return lastOut
}

/** `run:<id>` routes point at a brand-new session until it reports its real id. */
export function resolveKey(key: string, runs: Record<string, Run>): string {
  if (key.startsWith('run:')) {
    const r = runs[key.slice(4)]
    if (r?.session_id) return r.session_id
  }
  return key
}

export function runsOf(id: string, runs: Record<string, Run>): Run[] {
  const out: Run[] = []
  for (const r of Object.values(runs)) if (runSessionKey(r) === id) out.push(r)
  out.sort((a, b) => a.created - b.created)
  return out
}

/** Sessions with a run in flight, and those waiting for a permission answer. */
export function liveIndex(runs: Record<string, Run>): Map<string, 'running' | 'permission'> {
  const m = new Map<string, 'running' | 'permission'>()
  for (const r of Object.values(runs)) {
    if (['done', 'error', 'stopped', 'lost'].includes(r.status)) continue
    const k = runSessionKey(r)
    m.set(k, r.status === 'permission' ? 'permission' : m.get(k) === 'permission' ? 'permission' : 'running')
  }
  return m
}
