// Small stroke icons, drawn inline so the page needs no icon font.
const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  pin: 'M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7',
  terminal: 'M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h3',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  folder: 'M3 7h6l2 2h10v10H3z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.500 5.6 12 3z',
  check: 'M5 12.5l4.5 4.5L19 7.500',
  x: 'M6 6l12 12M18 6L6 18',
  right: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  send: 'M12 19V5M5.500 11.500L12 5l6.500 6.500',
  stop: 'M7 7h10v10H7z',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400',
  moon: 'M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  list: 'M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  logout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
  eyeoff: 'M3 3l18 18M10.500 6.200A9.500 9.500 0 0 1 21 12a10 10 0 0 1-2.400 3.300M6.500 7.500A10 10 0 0 0 3 12a9.500 9.500 0 0 0 12 5.500M10 10a3 3 0 0 0 4 4',
  eye: 'M3 12c2-4.500 5-7 9-7s7 2.500 9 7c-2 4.500-5 7-9 7s-7-2.500-9-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  machine: 'M4 5h16v11H4zM9 20h6M12 16v4',
  question: 'M9.500 9a2.500 2.500 0 1 1 3.500 2.300c-.700.400-1 1-1 1.700M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  shield: 'M12 3l8 3v6c0 4.500-3.200 7.800-8 9-4.800-1.200-8-4.500-8-9V6z',
  sub: 'M6 4v8a4 4 0 0 0 4 4h8M14 12l4 4-4 4',
  todo: 'M4 6l1.500 1.500L8 5M4 12l1.500 1.500L8 11M4 18l1.500 1.500L8 17M11 6h9M11 12h9M11 18h9',
  spark: 'M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800z',
  refresh: 'M20 11a8 8 0 0 0-14.500-4M4 4v4h4M4 13a8 8 0 0 0 14.500 4M20 20v-4h-4',
  back: 'M15 6l-6 6 6 6',
}

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const d = P[name] || P.dots
  return (
    <svg
      className={'ic' + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="运行中" />
}

/** A small coloured tag for the agent, instead of brand logos. */
export function AgentTag({ agent }: { agent: string }) {
  const c = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'other'
  const t = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent
  return <span className={`agent-tag ${c}`}>{t}</span>
}
