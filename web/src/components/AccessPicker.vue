<script setup lang="ts">
// Admin-only composer pill: how this session's turns are approved (sandbox + approval policy).
import { ref, computed, onBeforeUnmount, nextTick } from 'vue'
import { setSessionTuning, toast } from '../store'
import type { Session, ApprovalMode } from '../lib/types'
import Icon from './Icon.vue'

const props = defineProps<{ session: Session }>()
const MODES: { id: ApprovalMode; name: string; title: string; desc: string; icon: string }[] = [
  { id: 'ask', name: '请求批准', title: '请求批准', desc: '编辑外部文件和使用互联网时始终询问', icon: 'hand' },
  { id: 'assist', name: '帮我批准', title: '帮我批准', desc: '仅对检测到的风险操作请求批准', icon: 'shield' },
  { id: 'full', name: '完全访问', title: '完全访问权限', desc: '可不受限制地访问互联网和你电脑上的任何文件', icon: 'shield-alert' },
]
const open = ref(false)
const mobile = ref(false)
const root = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const mode = computed<ApprovalMode>(() => props.session.approval_mode || 'ask')
const current = computed(() => MODES.find(m => m.id === mode.value) || MODES[0])

function place() {
  mobile.value = window.matchMedia('(max-width: 720px)').matches
  if (mobile.value || !root.value) { menuStyle.value = {}; return }
  const r = root.value.getBoundingClientRect()
  const width = Math.min(340, window.innerWidth - 16)
  const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8)
  // The composer sits at the bottom: open upward like the App, downward only when there is no room.
  const h = menuEl.value?.offsetHeight || 230
  const top = r.top - 6 - h >= 8 ? r.top - 6 - h : r.bottom + 6
  menuStyle.value = { position: 'fixed', top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, width: `${width}px` }
}
function onOutside(e: Event) { const t = e.target as Node; if (root.value?.contains(t) || menuEl.value?.contains(t)) return; close() }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
function close() {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', place)
}
async function toggle() {
  if (open.value) return close()
  open.value = true
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', place)
  place(); await nextTick(); place()
}
async function choose(id: ApprovalMode) {
  close()
  if (id === mode.value) return
  try { await setSessionTuning(props.session.key, { approval_mode: id === 'ask' ? null : id }, `已切换为「${MODES.find(m => m.id === id)!.name}」`) } catch (e: any) { toast(e.message) }
}
onBeforeUnmount(close)
</script>

<template>
  <div ref="root" class="access-picker">
    <button type="button" class="access-btn" :class="[mode, { open }]" :data-tip="open ? undefined : '批准模式 · 仅管理员'" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
      <Icon :name="current.icon" :size="14" /><span>{{ current.name }}</span>
    </button>
    <Teleport to="body">
      <div v-if="open" class="model-layer" :class="{ sheet: mobile }" @click.self="close">
        <div ref="menuEl" class="model-menu access-menu" :class="{ sheet: mobile }" role="menu" aria-label="批准模式" :style="menuStyle">
          <div v-if="mobile" class="model-grab" aria-hidden="true" />
          <div class="model-scroll">
            <div class="access-head">应如何批准操作？</div>
            <button v-for="m in MODES" :key="m.id" class="model-item access-item" :class="m.id" role="menuitemradio" :aria-checked="mode === m.id" @click="choose(m.id)">
              <Icon :name="m.icon" :size="16" class="model-ico" />
              <span class="model-text"><span>{{ m.title }}</span><small>{{ m.desc }}</small></span>
              <Icon v-if="mode === m.id" name="check" :size="14" class="model-check" />
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
