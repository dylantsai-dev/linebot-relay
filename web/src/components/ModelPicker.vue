<script setup lang="ts">
import { ref, computed, onBeforeUnmount, nextTick, watch } from 'vue'
import { models, fetchModels, setSessionTuning, toast } from '../store'
import type { Session, ModelInfo } from '../lib/types'
import Icon from './Icon.vue'

const props = defineProps<{ session: Session; editable: boolean }>()
const open = ref(false)
const loading = ref(false)
const error = ref('')
const root = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const mobile = ref(false)
const EFFORT: Record<string, string> = { none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超强' }
const TIER: Record<string, string> = { fast: '快速', flex: '经济', priority: '快速', default: '常速', standard: '常速' }
const effortName = (id?: string | null) => id ? EFFORT[id] || id : ''
const tierName = (id?: string | null, m?: ModelInfo) => id ? TIER[id] || m?.serviceTiers.find(t => t.id === id)?.name || id : ''
const tierTip = (t: { id: string; description?: string }) => {
  if (t.id === 'priority' || t.id === 'fast') return t.description || '更高速度，使用额度更高'
  return t.description || undefined
}
const fallback = computed(() => models.value.find(m => m.isDefault))
const current = computed(() => models.value.find(m => m.id === props.session.model) || (!props.session.model ? fallback.value : undefined))
const label = computed(() => {
  const id = props.session.model
  const name = !id ? '默认' : models.value.find(m => m.id === id)?.displayName || id
  const speed = props.session.service_tier ? tierName(props.session.service_tier, current.value) : (current.value?.serviceTiers.length ? '常速' : '')
  const extra = [effortName(props.session.effort), speed].filter(Boolean)
  return extra.length ? `${name} · ${extra.join(' · ')}` : name
})

function syncMobile() { mobile.value = window.matchMedia('(max-width: 720px)').matches }
function placeMenu() {
  if (mobile.value || !root.value) { menuStyle.value = {}; return }
  const r = root.value.getBoundingClientRect()
  const width = Math.min(320, window.innerWidth - 16)
  let left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
  let top = r.bottom + 6
  const maxH = Math.min(560, window.innerHeight - 24)
  if (top + Math.min(420, maxH) > window.innerHeight - 8) {
    top = Math.max(8, r.top - 6 - Math.min(420, maxH))
  }
  menuStyle.value = {
    position: 'fixed',
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    width: `${width}px`,
    maxHeight: `${maxH}px`,
  }
}
function onOutside(e: Event) {
  const t = e.target as Node
  if (root.value?.contains(t) || menuEl.value?.contains(t)) return
  close()
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
function onResize() { syncMobile(); if (open.value) placeMenu() }
function lockScroll(on: boolean) {
  if (!mobile.value) return
  document.documentElement.style.overflow = on ? 'hidden' : ''
}
function close() {
  if (!open.value) return
  open.value = false
  lockScroll(false)
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
}
async function toggle() {
  if (open.value) return close()
  syncMobile()
  open.value = true
  error.value = ''
  lockScroll(true)
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  await nextTick()
  placeMenu()
  loading.value = !models.value.length
  try { await fetchModels() } catch (e: any) { error.value = e.message || '获取模型失败' } finally { loading.value = false }
  await nextTick(); placeMenu()
}
async function patch(p: Record<string, string | null>, note: string) {
  try { await setSessionTuning(props.session.key, p, note) } catch (e: any) { toast(e.message) }
}
function chooseModel(id: string | null) {
  if ((props.session.model || null) === id) return
  const next = id ? models.value.find(m => m.id === id) : fallback.value
  const p: Record<string, string | null> = { model: id }
  if (props.session.effort && !next?.supportedReasoningEfforts.some(e => e.id === props.session.effort)) p.effort = null
  if (props.session.service_tier && !next?.serviceTiers.some(t => t.id === props.session.service_tier)) p.service_tier = null
  patch(p, '模型已切换')
}
const chooseEffort = (id: string | null) => { if ((props.session.effort || null) !== id) patch({ effort: id }, '思考深度已更新') }
const chooseTier = (id: string | null) => { if ((props.session.service_tier || null) !== id) patch({ service_tier: id }, '速度已更新') }
watch(open, v => { if (!v) lockScroll(false) })
onBeforeUnmount(close)
</script>

<template>
  <div v-if="editable" ref="root" class="model-picker">
    <button class="model-btn" :class="{ open }" :data-tip="open ? undefined : '模型、思考深度和速度'" aria-haspopup="dialog" :aria-expanded="open" @click="toggle">
      <Icon name="sparkles" :size="13" /><span class="model-name">{{ label }}</span><Icon name="chevron" :size="12" />
    </button>
    <Teleport to="body">
      <div v-if="open" class="model-layer" :class="{ sheet: mobile }" @click.self="close">
        <div ref="menuEl" class="model-menu" :class="{ sheet: mobile }" role="dialog" aria-label="模型设置" :style="menuStyle">
          <div v-if="mobile" class="model-grab" aria-hidden="true" />
          <div class="model-scroll">
            <div class="model-head"><Icon name="cpu" :size="13" />模型</div>
            <button class="model-item" role="menuitemradio" :aria-checked="!session.model" @click="chooseModel(null)">
              <Icon name="reset" :size="14" class="model-ico" /><span class="model-text"><span>默认</span><small>跟随后台默认设置</small></span><Icon v-if="!session.model" name="check" :size="14" class="model-check" />
            </button>
            <div v-if="loading" class="model-note">加载中…</div>
            <div v-else-if="error" class="model-note err">{{ error }}</div>
            <template v-else>
              <button v-for="m in models" :key="m.id" class="model-item" role="menuitemradio" :aria-checked="session.model === m.id" @click="chooseModel(m.id)">
                <Icon name="box" :size="14" class="model-ico" />
                <span class="model-text"><span>{{ m.displayName }}<em v-if="m.isDefault"> · 默认</em></span><small v-if="m.description">{{ m.description }}</small></span>
                <Icon v-if="session.model === m.id" name="check" :size="14" class="model-check" />
              </button>
              <template v-if="current?.supportedReasoningEfforts.length">
                <div class="model-sep" /><div class="model-head"><Icon name="brain" :size="13" />思考深度</div>
                <div class="model-chips">
                  <button class="model-chip" :class="{ on: !session.effort }" @click="chooseEffort(null)">默认<em v-if="current.defaultReasoningEffort">（{{ effortName(current.defaultReasoningEffort) }}）</em></button>
                  <button v-for="e in current.supportedReasoningEfforts" :key="e.id" class="model-chip" :class="{ on: session.effort === e.id }" :data-tip="e.description || undefined" @click="chooseEffort(e.id)">{{ effortName(e.id) }}</button>
                </div>
              </template>
              <template v-if="current?.serviceTiers.length">
                <div class="model-sep" /><div class="model-head"><Icon name="zap" :size="13" />速度</div>
                <div class="model-chips">
                  <button class="model-chip" :class="{ on: !session.service_tier }" data-tip="默认速度，常规使用额度" @click="chooseTier(null)">常速</button>
                  <button v-for="t in current.serviceTiers" :key="t.id" class="model-chip" :class="{ on: session.service_tier === t.id }" :data-tip="tierTip(t)" @click="chooseTier(t.id)">{{ tierName(t.id, current) }}</button>
                </div>
              </template>
            </template>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
  <span v-else-if="session.model || session.effort || session.service_tier" class="model-btn static" data-tip="这个会话的模型设置"><Icon name="sparkles" :size="13" /><span class="model-name">{{ [session.model || '默认', effortName(session.effort), session.service_tier ? tierName(session.service_tier) : ''].filter(Boolean).join(' · ') }}</span></span>
</template>
