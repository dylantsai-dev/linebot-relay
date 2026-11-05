<script setup lang="ts">
// Admin-only: assign one session to one or more ordinary users (shared access).
import { ref, computed, nextTick } from 'vue'
import { fetchSessionUsers, setSessionUsers, toast } from '../store'
import type { Session, User } from '../lib/types'
import Icon from './Icon.vue'

const dialog = ref<HTMLDialogElement>()
const session = ref<Session | null>(null)
const candidates = ref<User[]>([])
const selected = ref(new Set<number>())
const query = ref(''), busy = ref(false), loading = ref(false), error = ref('')
const searchInput = ref<HTMLInputElement>()

function clearRowActionFocus() {
  const el = document.activeElement as HTMLElement | null
  if (el?.closest?.('.row-actions, .row-del, .session-row')) el.blur()
}
async function open(s: Session) {
  session.value = s
  query.value = ''; error.value = ''; selected.value = new Set()
  candidates.value = []
  clearRowActionFocus()
  dialog.value?.showModal()
  loading.value = true
  try {
    const data = await fetchSessionUsers(s.key)
    candidates.value = data.users
    selected.value = new Set(data.assigned)
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false; void nextTick(() => searchInput.value?.focus()) }
}
function onClose() { clearRowActionFocus() }
defineExpose({ open })

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return candidates.value.filter(u => {
    const hay = `${u.username} ${u.display_name || ''}`.toLowerCase()
    return !q || hay.includes(q)
  })
})
const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every(u => selected.value.has(u.id)))
function toggle(id: number) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}
function setAll(on: boolean) {
  const next = new Set(selected.value)
  for (const u of filtered.value) on ? next.add(u.id) : next.delete(u.id)
  selected.value = next
}

async function save() {
  const s = session.value
  if (!s) return
  busy.value = true; error.value = ''
  try {
    await setSessionUsers(s.key, [...selected.value])
    toast(selected.value.size ? `已分配给 ${selected.value.size} 个用户` : '已取消全部分配', true)
    dialog.value?.close()
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="dialog wide" @close="onClose" @click.self="dialog?.close()">
    <form class="user-form" @submit.prevent="save">
      <div class="dialog-head">
        <h2><span class="title-icon"><Icon name="users" :size="16" /></span>分配给用户</h2>
        <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="dialog?.close()"><Icon name="x" :size="15" /></button>
      </div>
      <p class="muted">把会话 <b>{{ session?.name || session?.key }}</b> 共享给多个普通用户。被分配的人可以查看和发消息；模型和批准模式仍仅管理员可见。</p>
      <div class="grant-head">
        <label class="field-label">普通用户</label>
        <span class="grant-count mono">{{ selected.size }} / {{ candidates.length }}</span>
      </div>
      <div class="grant-box">
        <div class="grant-tools">
          <label class="search">
            <Icon name="search" :size="14" />
            <input ref="searchInput" v-model="query" class="input" placeholder="搜索用户" aria-label="搜索用户">
          </label>
          <button type="button" class="btn sm" :disabled="!filtered.length || loading" @click="setAll(!allChecked)">{{ allChecked ? '全不选' : '全选' }}</button>
        </div>
        <div class="grant-list">
          <div v-if="loading" class="state-box"><span class="spinner sm" />加载中…</div>
          <label v-for="u in filtered" :key="u.id" class="grant-row" :class="{ on: selected.has(u.id), off: u.disabled }">
            <input type="checkbox" :checked="selected.has(u.id)" @change="toggle(u.id)">
            <span class="user-avatar sm" :class="{ 'has-img': !!u.avatar_url }">
              <img v-if="u.avatar_url" :src="u.avatar_url" alt="" referrerpolicy="no-referrer" />
              <template v-else>{{ (u.display_name || u.username).slice(0, 1).toUpperCase() }}</template>
            </span>
            <span class="grant-key">{{ u.display_name || u.username }}</span>
            <span v-if="u.display_name && u.display_name !== u.username" class="grant-meta">@{{ u.username }}</span>
            <span v-if="u.disabled" class="badge off-badge">已停用</span>
          </label>
          <div v-if="!loading && !filtered.length" class="state-box">{{ candidates.length ? '没有匹配的用户' : '还没有普通用户，请先在「用户」页创建。' }}</div>
        </div>
      </div>
      <p class="login-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" @click="dialog?.close()">取消</button>
        <button class="btn primary" :disabled="busy || loading"><span v-if="busy" class="spinner sm inv" />{{ busy ? '保存中…' : '保存分配' }}</button>
      </div>
    </form>
  </dialog>
</template>
