<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { isAdmin, webhookToken, toast } from '../store'
import { copy } from '../lib/clipboard'
import { webhookUrl, webhookCurl } from '../lib/curl'
import Icon from './Icon.vue'

const props = defineProps<{ anchor: HTMLElement | null; sessionKey: string }>()
const emit = defineEmits<{ close: [focusAnchor: boolean] }>()
const menu = ref<HTMLElement>()
const pos = ref({ left: 0, top: 0 })

const items = () => [
  { label: 'Webhook 地址', hint: 'URL', icon: 'link', disabled: false, value: () => webhookUrl() },
  { label: 'curl（JSON）', hint: '$TOKEN', icon: 'terminal', disabled: !props.sessionKey, value: () => webhookCurl(props.sessionKey) },
  { label: 'curl（文件）', hint: 'multipart', icon: 'paperclip', disabled: !props.sessionKey, value: () => webhookCurl(props.sessionKey, 'file') },
  // The only option that ever puts the real token on the clipboard.
  // Admins only: non-admin accounts never receive the WEBHOOK_TOKEN.
  ...(isAdmin.value ? [{ label: 'curl（含 Token）', hint: '真实密钥', icon: 'key', disabled: !props.sessionKey, danger: true, value: async () => webhookCurl(props.sessionKey, 'json', (await webhookToken()) || undefined) }] : []),
] as { label: string; hint: string; icon: string; disabled: boolean; danger?: boolean; value: () => string | Promise<string> }[]

function place() {
  if (!props.anchor || !menu.value) return
  const rect = props.anchor.getBoundingClientRect(), m = menu.value
  pos.value = { left: Math.max(8, Math.min(rect.left, innerWidth - m.offsetWidth - 8)), top: Math.min(rect.bottom + 4, innerHeight - m.offsetHeight - 8) }
}
watch(() => props.anchor, async a => { if (!a) return; if (isAdmin.value) void webhookToken().catch(() => {}); await nextTick(); place(); menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, { immediate: true })

async function pick(item: ReturnType<typeof items>[number]) {
  emit('close', true)
  try { await copy(await item.value(), item.danger ? '已复制（含真实 Token，注意保密）' : '已复制') }
  catch (e) { toast((e as Error).message) }
}
function onKey(e: KeyboardEvent) {
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  if (e.key === 'Escape') { e.preventDefault(); emit('close', true) }
  else if (e.key === 'Tab') emit('close', false)
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault()
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }
}
function outside(e: PointerEvent) { const t = e.target as Node; if (props.anchor && menu.value && !menu.value.contains(t) && !props.anchor.contains(t)) emit('close', false) }
const resize = () => emit('close', false)
onMounted(() => { document.addEventListener('pointerdown', outside); addEventListener('resize', resize) })
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outside); removeEventListener('resize', resize) })
</script>
<template>
  <Teleport to="body">
    <Transition name="pop">
      <div v-if="anchor" ref="menu" class="menu" role="menu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }" @keydown="onKey">
        <div class="menu-title">{{ sessionKey ? `复制 · ${sessionKey}` : '复制 Webhook' }}</div>
        <button v-for="item in items()" :key="item.label" type="button" role="menuitem" class="menu-item" :class="{ danger: item.danger }" :disabled="item.disabled" @click="pick(item)">
          <Icon :name="item.icon" :size="14" /><span class="menu-label">{{ item.label }}</span><span class="menu-hint">{{ item.hint }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
