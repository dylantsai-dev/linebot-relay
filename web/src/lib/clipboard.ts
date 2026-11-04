import { toast } from '../store'
export async function copy(text: string, label = '已复制') {
  try {
    try { await navigator.clipboard.writeText(text) }
    catch {
      const field = document.createElement('textarea')
      field.value = text
      field.style.cssText = 'position:fixed;left:-10000px;top:0'
      document.body.append(field)
      const focus = document.activeElement as HTMLElement | null
      try { field.select(); if (!document.execCommand('copy')) throw new Error('copy') }
      finally { field.remove(); focus?.focus({ preventScroll: true }) }
    }
    toast(label, true)
  } catch { toast('复制失败，请手动选择复制') }
}
