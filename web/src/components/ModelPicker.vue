<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { models, fetchModels, setSessionModel, toast } from '../store'
import type { Session } from '../lib/types'
import Icon from './Icon.vue'

const props = defineProps<{ session: Session; editable: boolean }>()
const open = ref(false)
const loading = ref(false)
const error = ref('')
const root = ref<HTMLElement | null>(null)
const label = computed(() => {
  const id = props.session.model
  if (!id) return '默认'
  return models.value.find(m => m.id === id)?.displayName || id
})
function outside(e: MouseEvent) { if (root.value && !root.value.contains(e.target as Node)) close() }
function close() { open.value = false; document.removeEventListener('mousedown', outside) }
async function toggle() {
  if (open.value) return close()
  open.value = true; error.value = ''
  document.addEventListener('mousedown', outside)
  loading.value = !models.value.length
  try { await fetchModels() } catch (e: any) { error.value = e.message || '获取模型失败' } finally { loading.value = false }
}
async function choose(id: string | null) {
  close()
  if ((props.session.model || null) === id) return
  try { await setSessionModel(props.session.key, id) } catch (e: any) { toast(e.message) }
}
onBeforeUnmount(close)
</script>

<template>
  <div v-if="editable" ref="root" class="model-picker">
    <button class="model-btn" :class="{ open }" :data-tip="open ? undefined : '切换这个会话使用的模型'" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
      <Icon name="sparkles" :size="13" /><span class="model-name">{{ label }}</span><Icon name="chevron" :size="12" />
    </button>
    <div v-if="open" class="model-menu" role="menu">
      <div class="model-head">模型</div>
      <button class="model-item" role="menuitemradio" :aria-checked="!session.model" @click="choose(null)">
        <span class="model-text"><span>默认</span><small>跟随后台默认设置</small></span><Icon v-if="!session.model" name="check" :size="14" class="model-check" />
      </button>
      <div v-if="loading" class="model-note">加载中…</div>
      <div v-else-if="error" class="model-note err">{{ error }}</div>
      <button v-for="m in models" v-else :key="m.id" class="model-item" role="menuitemradio" :aria-checked="session.model === m.id" @click="choose(m.id)">
        <span class="model-text"><span>{{ m.displayName }}<em v-if="m.isDefault"> · 默认</em></span><small v-if="m.description">{{ m.description }}</small></span>
        <Icon v-if="session.model === m.id" name="check" :size="14" class="model-check" />
      </button>
    </div>
  </div>
  <span v-else-if="session.model" class="model-btn static" data-tip="这个会话使用的模型"><Icon name="sparkles" :size="13" /><span class="model-name">{{ session.model }}</span></span>
</template>
