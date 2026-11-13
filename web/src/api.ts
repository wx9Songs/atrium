// Types and HTTP helpers for the hub API.
import { t, lang } from './i18n'

export type Session = {
  id: string
  nid: string
  agent: string
  machine: string
  title: string
  first?: string
  cwd?: string
  started?: string
  ended?: string
  n: number
  nu: number
  entry?: string
  branch?: string
  parent?: string
  /** Started here and not in the archive yet. */
  synthetic?: boolean
  /** For a synthetic session that is a fork: its parent and why (see Meta). */
  forkOf?: string
  forkKind?: ForkKind
  forkOrd?: number
}

/** branch: fork from the end or from a reply · edit: a rewritten message · retry: the same message again · side: a side chat */
export type ForkKind = 'branch' | 'edit' | 'retry' | 'side'

export type Meta = { pinned?: boolean; title?: string; hidden?: boolean; fork_of?: string; fork_kind?: ForkKind; fork_ts?: number }

export type SlashCmd = { name: string; description?: string; hint?: string }
/** A model as the agent's own CLI lists it; `efforts` are the reasoning levels it accepts. */
export type ModelOpt = { value: string; name?: string; description?: string; efforts?: string[]; default_effort?: string }
export type Caps = { commands?: SlashCmd[]; models?: ModelOpt[]; default_model?: string; default_effort?: string }

export type Machine = {
  name: string
  label: string
  runner: boolean
  online: boolean
  last_seen?: number
  info?: any
  /** Per agent: what its CLI on this machine offers. */
  caps?: Record<string, Caps>
}

export type ForkReq = {
  session_id: string
  kind: ForkKind
  before_ts?: string
  before_text?: string
  before_ord?: number
  title?: string
}

export type PermReq = {
  request_id: string
  tool_name: string
  input?: any
  description?: string
  suggestions?: any
  blocked_path?: string
}

export type Run = {
  id: string
  session_id: string
  native_id: string
  agent: string
  machine: string
  cwd: string
  prompt: string
  mode: string
  model?: string
  effort?: string
  is_new: boolean
  fork_of?: string
  fork_kind?: ForkKind
  fork_ord?: number
  title?: string
  status: string
  error?: string
  error_zh?: string
  created: number
  ended?: number
  started_ts?: number
  last_ts?: number
  perm?: PermReq
  seq: number
}

export type RunEvent = { seq: number; t: string; ts: number; data?: any }

export type Tool = {
  id?: string
  name: string
  cat?: string
  input: string
  inputLen?: number
  result?: string
  resultLen?: number
  status?: string
  /** Live tool calls carry the parsed input directly. */
  inputObj?: any
  running?: boolean
}

export type Msg = {
  ord: number
  role: string
  text: string
  thinking?: string
  ts?: string
  model?: string
  sys?: boolean
  src?: string
  compact?: boolean
  side?: boolean
  tools?: Tool[]
  key?: string
  live?: boolean
  error?: boolean
  /** In a forked session: copied from the parent rather than said here. */
  inherited?: boolean
}

export type SearchHit = {
  session_id: string
  title: string
  agent: string
  machine: string
  ord: number
  snippet: string
  ended?: string
}

export type Term = { id: string; machine: string; key: string; cwd: string; created: number; exited?: boolean; code?: number; error?: string; error_zh?: string }
/** Terminal output as it arrives: `off` is where this piece starts in the terminal's whole output. */
export type TermEvent = { id: string; off?: number; data?: string; exit?: boolean; code?: number; error?: string; error_zh?: string }

export type FsEntry = { name: string; dir?: boolean; size?: number; mtime?: number }
export type FsList = { path: string; parent: string; home: string; entries: FsEntry[]; more?: boolean }
export type FsFile = { path: string; size: number; mtime: number; content?: string; binary?: boolean; too_big?: boolean }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

async function req<T>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json', 'X-Atrium-Lang': lang } : { 'X-Atrium-Lang': lang },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, t('连不上服务器，请检查网络或隧道', 'Cannot reach the server. Check the network or the tunnel'))
  }
  if (res.status === 401 && !path.startsWith('/api/login')) {
    onUnauthorized()
    throw new ApiError(401, t('登录已失效', 'Signed out'))
  }
  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || t(`请求失败（${res.status}）`, `Request failed (${res.status})`))
  return data as T
}

const enc = encodeURIComponent

export const api = {
  auth: () => req<{ authed: boolean; version: string; login_hint?: string; mode?: string }>('/api/auth'),
  login: (code: string) => req<{ authed: boolean }>('/api/login', { method: 'POST', body: { code } }),
  logout: () => req('/api/logout', { method: 'POST', body: {} }),
  sessions: (fresh = false) =>
    req<{ sessions: Session[]; etag: string; meta: Record<string, Meta>; runs: Run[]; machines: Machine[] }>(
      '/api/sessions' + (fresh ? '?fresh=1' : ''),
    ),
  messages: (id: string, p: { before?: number; after?: number; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (p.before !== undefined) q.set('before', String(p.before))
    if (p.after !== undefined) q.set('after', String(p.after))
    q.set('limit', String(p.limit ?? 80))
    return req<{ messages: Msg[]; more: boolean; missing?: boolean }>(`/api/sessions/${enc(id)}/messages?${q}`)
  },
  tool: (id: string, ord: number, i: number) => req<Tool>(`/api/sessions/${enc(id)}/tool?ord=${ord}&i=${i}`),
  setMeta: (id: string, patch: Meta) => req<Meta>(`/api/sessions/${enc(id)}/meta`, { method: 'POST', body: patch }),
  search: (q: string) => req<{ hits: SearchHit[] }>(`/api/search?q=${enc(q)}`),
  runs: () => req<{ runs: Run[] }>('/api/runs'),
  runEvents: (id: string, after = 0) => req<{ run: Run; events: RunEvent[] }>(`/api/runs/${enc(id)}/events?after=${after}`),
  createRun: (body: {
    session_id?: string
    machine?: string
    agent?: string
    cwd?: string
    prompt: string
    mode?: string
    model?: string
    effort?: string
    fork?: ForkReq
  }) => req<{ run: Run }>('/api/runs', { method: 'POST', body }),
  permission: (
    runId: string,
    body: { request_id: string; behavior: 'allow' | 'deny'; message?: string; always?: boolean; input?: any },
  ) => req(`/api/runs/${enc(runId)}/permission`, { method: 'POST', body }),
  stop: (runId: string) => req<{ run: Run }>(`/api/runs/${enc(runId)}/stop`, { method: 'POST', body: {} }),
  ls: (machine: string, path: string) =>
    req<{ path: string; parent: string; home: string; entries: { name: string }[] }>('/api/ls', {
      method: 'POST',
      body: { machine, path },
    }),
  /** Have a machine's runner ask its agents again for their models and commands. */
  capsRefresh: (machine: string) => req<{ machines: Machine[] }>(`/api/machines/${enc(machine)}/caps`, { method: 'POST', body: {} }),
  terms: () => req<{ terms: Term[] }>('/api/terms'),
  termOpen: (body: { machine: string; key: string; cwd: string; cols: number; rows: number }) => req<{ term: Term }>('/api/terms', { method: 'POST', body }),
  /** The terminal and the output the hub still holds (base64), ending at byte offset `end`. */
  termGet: (id: string) => req<{ term: Term; data: string; end: number }>(`/api/terms/${enc(id)}`),
  termInput: (id: string, data: string) => req(`/api/terms/${enc(id)}/input`, { method: 'POST', body: { data } }),
  termResize: (id: string, cols: number, rows: number) => req(`/api/terms/${enc(id)}/resize`, { method: 'POST', body: { cols, rows } }),
  termClose: (id: string) => req(`/api/terms/${enc(id)}/close`, { method: 'POST', body: {} }),
  fsList: (machine: string, path: string) => req<FsList>('/api/fs/list', { method: 'POST', body: { machine, path } }),
  fsRead: (machine: string, path: string) => req<FsFile>('/api/fs/read', { method: 'POST', body: { machine, path } }),
  /** `mtime` is the version being edited; the save is refused if the file changed since. 0 overwrites. */
  fsWrite: (machine: string, path: string, content: string, mtime: number) =>
    req<{ path: string; size: number; mtime: number }>('/api/fs/write', { method: 'POST', body: { machine, path, content, mtime } }),
}
