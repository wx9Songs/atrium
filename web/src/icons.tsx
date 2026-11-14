// Small stroke icons, drawn inline so the page needs no icon font.
import { t } from './i18n'
import logoUrl from './logo.png'
import { agentName } from './util'
const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  clip: 'M20.500 11.500l-8.300 8.300a5.300 5.300 0 0 1-7.500-7.500l8.600-8.600a3.600 3.600 0 0 1 5.100 5.100l-8.600 8.600a1.900 1.900 0 0 1-2.700-2.700l7.900-7.900',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  pin: 'M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7',
  terminal: 'M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h3',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  image: 'M4 5h16v14H4zM4 15.500l4.500-4.500 4 4 2.500-2.500 5 5M15.500 9.500h.01',
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
  // a rack server: two units, each with its light
  server: 'M4 4.500h16v6.500H4zM4 13h16v6.500H4zM7.500 7.750h.01M7.500 16.250h.01',
  question: 'M9.500 9a2.500 2.500 0 1 1 3.500 2.300c-.700.400-1 1-1 1.700M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  shield: 'M12 3l8 3v6c0 4.500-3.200 7.800-8 9-4.800-1.200-8-4.500-8-9V6z',
  sub: 'M6 4v8a4 4 0 0 0 4 4h8M14 12l4 4-4 4',
  todo: 'M4 6l1.500 1.500L8 5M4 12l1.500 1.500L8 11M4 18l1.500 1.500L8 17M11 6h9M11 12h9M11 18h9',
  spark: 'M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800z',
  refresh: 'M20 11a8 8 0 0 0-14.500-4M4 4v4h4M4 13a8 8 0 0 0 14.500 4M20 20v-4h-4',
  back: 'M15 6l-6 6 6 6',
  // sidebar toggle: a window with its left column marked
  sidebar: 'M4 5h16v14H4zM9.500 5v14',
  // a second column on the right: the side panel
  panel: 'M4 5h16v14H4zM14.500 5v14',
  // fork: one line splitting in two
  branch: 'M7 4v9M7 13a4 4 0 0 0 4 4h6M7 13V20M14 14l3 3-3 3M5 4h4',
  // side chat: two overlapping bubbles
  sidechat: 'M4 5h11v8H9l-3 3v-3H4zM15 9h5v8h-2v3l-3-3h-4v-1',
  retry: 'M19 12a7 7 0 1 1-2.050-4.950M19 5v4h-4',
  filter: 'M4 6h16M7 12h10M10 18h4',
  chip: 'M8 8h8v8H8zM10 4v4M14 4v4M10 16v4M14 16v4M4 10h4M4 14h4M16 10h4M16 14h4',
  think: 'M4.500 17a8 8 0 1 1 15 0M12 14l3.500-4.500M12 14h.010',
  slash: 'M15 5L9 19',
  keyboard: 'M3 7h18v10H3zM7 10.500h.01M10.500 10.500h.01M14 10.500h.01M17.500 10.500h.01M7.500 13.500h9',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  external: 'M14 5h5v5M19 5l-8 8M11 6H5v13h13v-6',
  // widen / narrow the side panel: arrows pushing a divider
  widen: 'M20 5v14M15 12H4M8 8l-4 4 4 4',
  narrow: 'M20 5v14M4 12h11M11 8l4 4-4 4',
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
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label={t('运行中', 'running')} />
}

/**
 * The Atrium mark: a ribbon folded into a ring of rooms around an open court,
 * with a small sunlit square in the middle. It is the same artwork as the app
 * icon; app/make-icon.swift writes logo.png from it (see the --flat option).
 */
export function Logo({ size = 22 }: { size?: number }) {
  return <img className="logo" src={logoUrl} width={size} height={size} alt="" draggable={false} />
}

// The agents' own marks, so a row says at a glance whose session it is. They
// are the vendors' trademarks, used here only to name their products.
const CLAUDE_MARK = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
const OPENAI_MARK = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

/** The agent's mark: Claude's burst, OpenAI's knot for Codex, a plain diamond for anything else. */
export function AgentIcon({ agent, size = 14 }: { agent: string; size?: number }) {
  const d = agent === 'claude' ? CLAUDE_MARK : agent === 'codex' ? OPENAI_MARK : 'M12 3l9 9-9 9-9-9z'
  const c = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'other'
  return (
    <svg className={'agent-ic ' + c} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label={agentName(agent)}>
      <path d={d} />
    </svg>
  )
}

/** The agent's mark and name (`bare`: the mark alone). */
export function AgentTag({ agent, bare }: { agent: string; bare?: boolean }) {
  const c = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'other'
  return (
    <span className={`agent-tag ${c}`}>
      <AgentIcon agent={agent} size={bare ? 13 : 14} />
      {!bare && agentName(agent)}
    </span>
  )
}
