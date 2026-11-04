import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// marked (GFM) -> raw HTML escaped -> DOMPurify allow-list. Same policy as the legacy console.
const escHtml = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const md = new Marked({ gfm: true, breaks: true, async: false, renderer: { html(token) { return escHtml(token.text ?? token.raw ?? '') } } })

const purify = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span'],
  ALLOWED_ATTR: ['href', 'title', 'align', 'type', 'checked', 'disabled', 'start'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  ADD_URI_SAFE_ATTR: ['align', 'type', 'start'],
  RETURN_DOM_FRAGMENT: true as const,
}
DOMPurify.addHook('afterSanitizeAttributes', node => {
  const el = node as Element
  if (el.tagName === 'A' && el.hasAttribute('href')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow') }
  if (el.tagName === 'INPUT') { if (el.getAttribute('type') !== 'checkbox') { el.remove(); return } el.setAttribute('disabled', '') }
  if (el.hasAttribute?.('align')) {
    const a = el.getAttribute('align') || ''
    el.removeAttribute('align')
    if (/^(left|right|center)$/.test(a)) (el as HTMLElement).style.textAlign = a
  }
})

const escapeText = (text: string) => `<p style="white-space:pre-wrap">${escHtml(text)}</p>`
const cache = new Map<string, string>()

export function renderMarkdown(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  let html: string
  try {
    const frag = DOMPurify.sanitize(md.parse(String(text)) as string, purify) as DocumentFragment
    frag.querySelectorAll('table').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.append(t) })
    frag.querySelectorAll('pre').forEach(pre => { const w = document.createElement('div'); w.className = 'code-block'; pre.replaceWith(w); w.append(pre) })
    const box = document.createElement('div'); box.append(frag); html = box.innerHTML
  } catch { html = escapeText(text) }
  if (cache.size > 800) cache.clear()
  cache.set(text, html)
  return html
}
