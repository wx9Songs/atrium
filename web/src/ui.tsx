// Small shared pieces: popover menus, a persisted-state hook, a toast.
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

export function usePersisted<T>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? def : (JSON.parse(raw) as T)
    } catch {
      return def
    }
  })
  return [v, useCallback((nv: T) => { setV(nv); try { localStorage.setItem(key, JSON.stringify(nv)) } catch { /* private mode */ } }, [key])]
}

/**
 * A button with a popover under (or above) it. The popover closes on an
 * outside click, on Escape, and when an item inside calls `close`.
 */
export function Dropdown({
  button, children, up, align = 'left', className, wide, disabled, title, open: forced, onOpenChange,
}: {
  button: ReactNode
  children: (close: () => void) => ReactNode
  up?: boolean
  align?: 'left' | 'right'
  className?: string
  wide?: boolean
  disabled?: boolean
  title?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = useState(false)
  const open = forced ?? own
  const setOpen = useCallback((v: boolean) => { setOwn(v); onOpenChange?.(v) }, [onOpenChange])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true) }
  }, [open, setOpen])
  return (
    <div className={'dd' + (open ? ' open' : '')} ref={ref}>
      <button type="button" className={className} disabled={disabled} title={title} aria-expanded={open} onClick={() => setOpen(!open)}>{button}</button>
      {open && <div className={'menu' + (up ? ' up' : '') + (align === 'right' ? ' right' : '') + (wide ? ' wide' : '')} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function MenuItem({
  icon, label, sub, hint, checked, danger, disabled, onClick,
}: {
  icon?: string
  label: ReactNode
  sub?: ReactNode
  hint?: ReactNode
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" role="menuitem" className={'mi' + (danger ? ' danger' : '') + (sub ? ' two' : '')} disabled={disabled} onClick={onClick}>
      {icon !== undefined && <Icon name={icon} size={15} />}
      <span className="mi-main">
        <span className="mi-label">{label}</span>
        {sub && <span className="mi-sub">{sub}</span>}
      </span>
      {hint && <span className="mi-hint">{hint}</span>}
      {checked !== undefined && <Icon name="check" size={14} className={'mi-check' + (checked ? '' : ' off')} />}
    </button>
  )
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>
export const MenuSep = () => <div className="menu-sep" />

/** Two or three choices side by side. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => <button key={v} type="button" className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  )
}

/** One short message at the bottom of the window; the latest one wins. */
let showToast: (text: string) => void = () => {}
export const toast = (text: string) => showToast(text)

export function Toaster() {
  const [text, setText] = useState('')
  const timer = useRef<number>()
  useEffect(() => {
    showToast = (s) => {
      setText(s)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setText(''), Math.min(6000, 1600 + s.length * 45))
    }
    return () => { showToast = () => {} }
  }, [])
  return text ? <div className="toast" role="status">{text}</div> : null
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const kbd = (key: string, shift = false) => (isMac ? (shift ? '⇧' : '') + '⌘' + key : 'Ctrl ' + (shift ? 'Shift ' : '') + key)
