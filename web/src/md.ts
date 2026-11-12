// Markdown → safe HTML, with highlighted code blocks.
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const langs: Record<string, any> = {
  bash, cpp, css, diff, dockerfile, go, ini, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml,
}
for (const k in langs) hljs.registerLanguage(k, langs[k])
const alias: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', js: 'javascript', jsx: 'javascript', ts: 'typescript',
  tsx: 'typescript', py: 'python', yml: 'yaml', html: 'xml', toml: 'ini', c: 'cpp', 'c++': 'cpp', golang: 'go',
  md: 'markdown', rs: 'rust', jsonl: 'json', patch: 'diff',
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function highlight(code: string, lang?: string): string {
  const l = (lang || '').toLowerCase().split(/[\s,{]/)[0]
  const name = langs[l] ? l : alias[l]
  if (name && code.length < 60_000) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
    } catch {
      /* fall through */
    }
  }
  return esc(code)
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code(token: any) {
      const text: string = token.text ?? ''
      const lang: string = (token.lang || '').trim()
      return (
        `<div class="codeblock"><div class="codehead"><span>${esc(lang || '代码')}</span>` +
        `<button type="button" class="copybtn" data-copy>复制</button></div>` +
        `<pre><code class="hljs">${highlight(text, lang)}</code></pre></div>`
      )
    },
  },
})

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const cache = new Map<string, string>()

export function renderMarkdown(src: string): string {
  const hit = cache.get(src)
  if (hit !== undefined) return hit
  let html: string
  try {
    html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string, {
      ADD_ATTR: ['target', 'data-copy'],
      FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'script'],
    })
  } catch {
    html = `<p>${esc(src)}</p>`
  }
  if (cache.size > 600) cache.clear()
  cache.set(src, html)
  return html
}

/** Search snippets arrive with <mark> around matches; keep only those tags. */
export function snippetHtml(s: string): string {
  return esc(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>')
}

export { esc }
