// Types and HTTP helpers for the hub API.

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
}

export type Meta = { pinned?: boolean; title?: string; hidden?: boolean }

export type Machine = {
  name: string
  label: string
  runner: boolean
  online: boolean
  last_seen?: number
  info?: any
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
  is_new: boolean
  status: string
  error?: string
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
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, '连不上服务器，请检查网络或隧道')
  }
  if (res.status === 401 && !path.startsWith('/api/login')) {
    onUnauthorized()
    throw new ApiError(401, '登录已失效')
  }
  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `请求失败（${res.status}）`)
  return data as T
}

const enc = encodeURIComponent

export const api = {
  auth: () => req<{ authed: boolean; version: string; login_hint?: string }>('/api/auth'),
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
}
