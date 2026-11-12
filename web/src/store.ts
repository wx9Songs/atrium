// One small global store: the session list, hub notes (pin/rename/hide),
// machines, runs and their live events. Kept fresh by server-sent events.
import { useSyncExternalStore } from 'react'
import { api, Machine, Meta, Run, RunEvent, Session, setUnauthorizedHandler, TermEvent } from './api'
import { t } from './i18n'

export type State = {
  authed: boolean | null
  version: string
  loginHint: string
  loaded: boolean
  loadError: string
  connected: boolean
  sessions: Session[]
  meta: Record<string, Meta>
  runs: Record<string, Run>
  machines: Machine[]
  events: Record<string, RunEvent[]>
}

let state: State = {
  authed: null,
  version: '',
  loginHint: '',
  loaded: false,
  loadError: '',
  connected: false,
  sessions: [],
  meta: {},
  runs: {},
  machines: [],
  events: {},
}

const listeners = new Set<() => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Select a top-level slice; selectors must return a stable reference. */
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state))
}

export function getState() {
  return state
}

setUnauthorizedHandler(() => {
  if (state.authed !== false) set({ authed: false })
})

export const TERMINAL = new Set(['done', 'error', 'stopped', 'lost'])
export const isTerminal = (r: Run) => TERMINAL.has(r.status)

// ---------- boot / sign-in ----------

export async function boot() {
  try {
    const m = location.hash.match(/login=([A-Za-z0-9_-]+)/)
    if (m) {
      history.replaceState(null, '', location.pathname + location.search)
      try {
        await api.login(m[1])
      } catch (e: any) {
        set({ loadError: e.message || t('登录失败', 'Sign-in failed') })
      }
    }
    const a = await api.auth()
    set({ authed: a.authed, version: a.version, loginHint: a.login_hint || '' })
    if (a.authed) {
      await refreshSessions()
      connect()
    }
  } catch (e: any) {
    set({ authed: false, loadError: e.message || t('连不上服务器', 'Cannot reach the server') })
  }
}

export async function signIn(code: string) {
  await api.login(code.trim())
  set({ authed: true, loadError: '' })
  await refreshSessions()
  connect()
}

export async function signOut() {
  try {
    await api.logout()
  } catch {
    /* ignore */
  }
  es?.close()
  es = null
  set({ authed: false, loaded: false })
}

// ---------- data ----------

let refreshing: Promise<void> | null = null

export function refreshSessions(fresh = false): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const d = await api.sessions(fresh)
      const runs: Record<string, Run> = {}
      for (const r of d.runs) runs[r.id] = r
      // keep runs we already know that the server no longer lists as recent
      for (const id in state.runs) if (!runs[id] && state.events[id]) runs[id] = state.runs[id]
      set({ sessions: d.sessions, meta: d.meta || {}, runs, machines: d.machines, loaded: true, loadError: '' })
      for (const r of d.runs) if (!isTerminal(r)) ensureEvents(r.id)
    } catch (e: any) {
      set({ loadError: e.message || t('加载失败', 'Could not load'), loaded: true })
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

const loadingEvents = new Set<string>()

export async function ensureEvents(runId: string, force = false) {
  if (loadingEvents.has(runId)) return
  if (state.events[runId] && !force) return
  loadingEvents.add(runId)
  try {
    const d = await api.runEvents(runId, 0)
    set({ events: { ...state.events, [runId]: d.events }, runs: { ...state.runs, [d.run.id]: d.run } })
  } catch {
    /* will retry on the next event */
  } finally {
    loadingEvents.delete(runId)
  }
}

export function setMachines(machines: Machine[]) {
  set({ machines })
}

export function putRun(run: Run) {
  set({ runs: { ...state.runs, [run.id]: run }, events: state.events[run.id] ? state.events : { ...state.events, [run.id]: [] } })
}

export async function setMeta(id: string, patch: Meta) {
  const prev = state.meta[id] || {}
  set({ meta: { ...state.meta, [id]: { ...prev, ...patch } } })
  try {
    await api.setMeta(id, patch)
  } catch {
    set({ meta: { ...state.meta, [id]: prev } })
  }
}

// ---------- terminal ----------
// Terminal output does not go through the store (it would re-render the page
// for every keystroke echoed back): each open terminal listens for its own.

const termListeners = new Map<string, Set<(e: TermEvent) => void>>()

export function onTerm(id: string, fn: (e: TermEvent) => void) {
  let set = termListeners.get(id)
  if (!set) termListeners.set(id, (set = new Set()))
  set.add(fn)
  return () => { set!.delete(fn) }
}

// ---------- desktop app bridge ----------
// Inside the Atrium desktop app the page can hand events to the native side
// (notifications, dock badge). In a normal browser this does nothing.

const nativeBridge = (window as any).webkit?.messageHandlers?.atrium as { postMessage: (m: unknown) => void } | undefined

export const inApp = !!nativeBridge || localStorage.getItem('atrium.fakeapp') === '1'

export function tellNative(msg: Record<string, unknown>) {
  try {
    nativeBridge?.postMessage(msg)
  } catch {
    /* not in the app */
  }
}

function runTitle(r: Run): string {
  const s = state.sessions.find((x) => x.id === r.session_id)
  const t = (s && (state.meta[s.id]?.title || s.title)) || r.prompt
  return t.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function tellNativeAboutRun(prev: Run | undefined, next: Run) {
  if (!nativeBridge) return
  const key = next.session_id || `run:${next.id}`
  if (next.status === 'permission' && prev?.status !== 'permission') {
    tellNative({ type: 'attention', kind: 'permission', title: runTitle(next), detail: next.perm?.description || next.perm?.tool_name || '', session: key })
  } else if (isTerminal(next) && prev && !isTerminal(prev)) {
    tellNative({ type: 'attention', kind: next.status, title: runTitle(next), detail: next.error || '', session: key })
  }
  let waiting = next.status === 'permission' ? 1 : 0
  for (const id in state.runs) if (id !== next.id && state.runs[id].status === 'permission') waiting++
  tellNative({ type: 'badge', count: waiting })
}

// ---------- live updates ----------

let es: EventSource | null = null
let everConnected = false
let sessionsTimer: number | undefined

function scheduleSessionsRefresh(delay = 400) {
  window.clearTimeout(sessionsTimer)
  sessionsTimer = window.setTimeout(() => refreshSessions(), delay)
}

function connect() {
  if (es) return
  es = new EventSource('/api/events')
  es.addEventListener('hello', () => {
    set({ connected: true })
    if (everConnected) {
      // we may have missed events while disconnected
      refreshSessions().then(() => {
        for (const id in state.events) if (state.runs[id] && !isTerminal(state.runs[id])) ensureEvents(id, true)
      })
    }
    everConnected = true
  })
  es.addEventListener('run', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { run: Run; event?: RunEvent }
    const known = !!state.runs[d.run.id]
    tellNativeAboutRun(state.runs[d.run.id], d.run)
    const runs = { ...state.runs, [d.run.id]: d.run }
    const list = state.events[d.run.id]
    if (d.event) {
      if (!list) {
        set({ runs })
        ensureEvents(d.run.id)
      } else if (list.length === 0 || d.event.seq === list[list.length - 1].seq + 1) {
        set({ runs, events: { ...state.events, [d.run.id]: [...list, d.event] } })
      } else if (d.event.seq > list[list.length - 1].seq + 1) {
        set({ runs })
        ensureEvents(d.run.id, true)
      } else {
        set({ runs })
      }
    } else {
      set({ runs, events: list ? state.events : { ...state.events, [d.run.id]: [] } })
    }
    if (!known || isTerminal(d.run)) scheduleSessionsRefresh(isTerminal(d.run) ? 2500 : 400)
  })
  es.addEventListener('term', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as TermEvent
    termListeners.get(d.id)?.forEach((fn) => fn(d))
  })
  es.addEventListener('sessions', () => scheduleSessionsRefresh())
  es.addEventListener('machines', (e) => set({ machines: JSON.parse((e as MessageEvent).data) }))
  es.addEventListener('meta', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { id: string; meta: Meta }
    set({ meta: { ...state.meta, [d.id]: d.meta } })
  })
  es.onerror = () => {
    if (state.connected) set({ connected: false })
    // EventSource retries on its own; check whether the sign-in is still valid.
    api.auth().then((a) => {
      if (!a.authed) {
        es?.close()
        es = null
        set({ authed: false })
      }
    }).catch(() => {})
  }
}

// When the tab becomes visible again, make sure the list is current.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.authed) refreshSessions()
})

/**
 * Where the start page should open next: set by "new session here" on a machine
 * or a folder in the sidebar, and used once by the start page. With no folder
 * (cwd ''), the start page opens its folder menu so one can be picked or typed.
 */
export const startAt = { machine: '', cwd: '' }
export function startIn(machine: string, cwd: string) {
  startAt.machine = machine
  startAt.cwd = cwd
  window.dispatchEvent(new Event('atrium:start-at'))
}
