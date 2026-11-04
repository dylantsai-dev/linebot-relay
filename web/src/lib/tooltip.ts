// One floating tooltip for every element with a data-tip attribute (icon buttons, pills…).
// Delegated, so it works in scroll containers and teleported menus without clipping.
export function installTooltips() {
  const tip = document.createElement('div')
  tip.className = 'tooltip'; tip.setAttribute('role', 'tooltip'); document.body.append(tip)
  let current: HTMLElement | null = null, timer = 0
  const hide = () => { clearTimeout(timer); current = null; tip.classList.remove('show') }
  function show(el: HTMLElement) {
    const text = el.dataset.tip
    if (!text) return hide()
    current = el; tip.textContent = text
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (current !== el || !el.isConnected) return
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight
      let top = r.top - h - 8, below = false
      if (top < 6) { top = r.bottom + 8; below = true }
      const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6))
      tip.style.left = `${left}px`; tip.style.top = `${top}px`; tip.classList.toggle('below', below); tip.classList.add('show')
    }, 380)
  }
  const find = (t: EventTarget | null) => (t instanceof Element ? (t.closest('[data-tip]') as HTMLElement | null) : null)
  document.addEventListener('pointerover', e => { if ((e as PointerEvent).pointerType === 'touch') return; const el = find(e.target); if (el !== current) el ? show(el) : hide() })
  document.addEventListener('focusin', e => { const el = find(e.target); if (el && (el as HTMLElement).matches(':focus-visible')) show(el); else hide() })
  for (const ev of ['pointerdown', 'scroll', 'keydown', 'focusout']) document.addEventListener(ev, hide, true)
}
