import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// marked (GFM) -> raw HTML escaped -> DOMPurify allow-list. Same policy as the legacy console.
const escHtml = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const md = new Marked({ gfm: true, breaks: true, async: false, renderer: { html(token) { return escHtml(token.text ?? token.raw ?? '') } } })

const purify = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span', 'img'],
  ALLOWED_ATTR: ['href', 'title', 'align', 'type', 'checked', 'disabled', 'start', 'src', 'alt'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // /api/media/ is the relay's signed image endpoint (same origin); data: only for raster images.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/api\/media\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
  ADD_URI_SAFE_ATTR: ['align', 'type', 'start'],
  RETURN_DOM_FRAGMENT: true as const,
}
DOMPurify.addHook('afterSanitizeAttributes', node => {
  const el = node as Element
  if (el.tagName === 'A' && el.hasAttribute('href')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow') }
  if (el.tagName === 'IMG') {
    const src = el.getAttribute('src') || ''
    if (!src || !isImageSrc(src)) { el.replaceWith(document.createTextNode(el.getAttribute('alt') || '')); return }
    el.setAttribute('loading', 'lazy'); el.setAttribute('decoding', 'async'); el.setAttribute('referrerpolicy', 'no-referrer')
    el.classList.add('md-img')
  }
  if (el.tagName === 'A' && /^data:/i.test(el.getAttribute('href') || '')) el.removeAttribute('href')
  if (el.tagName === 'INPUT') { if (el.getAttribute('type') !== 'checkbox') { el.remove(); return } el.setAttribute('disabled', '') }
  if (el.hasAttribute?.('align')) {
    const a = el.getAttribute('align') || ''
    el.removeAttribute('align')
    if (/^(left|right|center)$/.test(a)) (el as HTMLElement).style.textAlign = a
  }
})

export function isImageSrc(src: string): boolean { return /^(?:https:\/\/|\/api\/media\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(src) }

const escapeText = (text: string) => `<p style="white-space:pre-wrap">${escHtml(text)}</p>`
const cache = new Map<string, string>()

// `live` text changes on every delta: skip the cache so it does not fill with partial strings.
export function renderMarkdown(text: string, live = false): string {
  const hit = live ? undefined : cache.get(text)
  if (hit !== undefined) return hit
  let html: string
  try {
    const frag = DOMPurify.sanitize(md.parse(String(text)) as string, purify) as DocumentFragment
    frag.querySelectorAll('table').forEach(t => { const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.append(t) })
    frag.querySelectorAll('pre').forEach(pre => { const w = document.createElement('div'); w.className = 'code-block'; pre.replaceWith(w); w.append(pre) })
    const box = document.createElement('div'); box.append(frag); html = box.innerHTML
  } catch { html = escapeText(text) }
  if (live) return html
  if (cache.size > 800) cache.clear()
  cache.set(text, html)
  return html
}

// Split streaming markdown into top-level blocks (blank-line separated, code fences kept whole).
// Finished blocks render once (cached) so their DOM is never replaced; only the tail block changes.
export function splitBlocks(text: string): string[] {
  const out: string[] = []
  let cur: string[] = [], fence = ''
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = '' }
    if (!fence && !m && line.trim() === '' && cur.length) { out.push(cur.join('\n')); cur = []; continue }
    cur.push(line)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out.filter(b => b.trim())
}
