// Attachments. A file added to a message is saved on the machine the session
// runs on, and the message ends with a short list of the saved paths, which
// is how the agent finds them. The page shows that list as chips.

const MARK = '[Attached files: read them at these paths]'
const TRAILER = /(?:^|\n+)\[Attached files[^\]\n]*\]\n((?:- [^\n]+(?:\n|$))+)\s*$/

/** The message as it is sent: the text, then the attachments' paths. */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text
  return (text ? text + '\n\n' : '') + MARK + '\n' + paths.map((p) => '- ' + p).join('\n')
}

/** The text of a message and the attachments it names. */
export function splitAttachments(message: string): { text: string; files: string[] } {
  const m = TRAILER.exec(message)
  if (!m) return { text: message, files: [] }
  return {
    text: message.slice(0, m.index).trimEnd(),
    files: m[1].split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean),
  }
}

export const baseName = (path: string) => path.split(/[\\/]/).pop() || path

/** A message as a title wants it: its text, or failing that the names of its attachments. */
export function plainMessage(message: string): string {
  const { text, files } = splitAttachments(message)
  return text || files.map(baseName).join(', ') || message
}

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i.test(name)

export const MAX_ATTACH_SIZE = 25 << 20
export const MAX_ATTACH_COUNT = 10

// Pictures uploaded from this page, by saved path, so the transcript can show
// them at once. They live only as long as the page; after that the hub's copy is shown.
const previews = new Map<string, string>()
export const rememberPreview = (path: string, url: string) => { previews.set(path, url) }
export const previewOf = (path: string) => previews.get(path)

/** Where the hub serves its copy of an attached picture (it keeps them for a month), if the path is one. */
export function pictureURL(path: string): string | undefined {
  const m = /[\\/]atrium[\\/]uploads[\\/](\d{8}-\d{6}-[0-9a-f]{8})[\\/]([^\\/]+\.(?:png|jpe?g|gif|webp))$/i.exec(path)
  return m ? `/api/attachment/${m[1]}/${encodeURIComponent(m[2])}` : undefined
}

export function fileSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1 << 20) return Math.round(n / 1024) + ' KB'
  return (n / (1 << 20)).toFixed(1) + ' MB'
}

/** A name for a pasted file that has none worth keeping ("image.png" from a screenshot). */
export function pastedName(file: File, n: number): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '')
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `pasted-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${n ? '-' + (n + 1) : ''}.${ext}`
}
