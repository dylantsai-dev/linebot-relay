<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { state, keyPattern, createUser, updateUser, toast } from '../store'
import type { User } from '../lib/types'
import { shortTime } from '../lib/format'
import Icon from './Icon.vue'

const dialog = ref<HTMLDialogElement>(), nameInput = ref<HTMLInputElement>()
const editing = ref<User | null>(null)
const username = ref(''), password = ref(''), role = ref<'admin' | 'user'>('user'), disabled = ref(false)
const granted = ref(new Set<string>()), query = ref(''), busy = ref(false), error = ref('')
const isSelf = computed(() => !!editing.value && editing.value.id === state.me?.user?.id)

function open(user: User | null) {
  editing.value = user
  username.value = user?.username || ''; password.value = ''
  role.value = user?.role || 'user'; disabled.value = !!user?.disabled
  granted.value = new Set(user?.sessions || []); query.value = ''; error.value = ''
  dialog.value?.showModal()
  void nextTick(() => nameInput.value?.focus())
}
defineExpose({ open })

interface Row { key: string; id: string | null; updated?: string; missing: boolean }
const rows = computed<Row[]>(() => {
  const known = new Map(state.sessions.map(s => [s.key, s]))
  const list: Row[] = state.sessions.map(s => ({ key: s.key, id: s.codex_session_id, updated: s.updated_at, missing: false }))
  for (const key of granted.value) if (!known.has(key)) list.push({ key, id: null, missing: true })
  return list
})
const filtered = computed(() => { const q = query.value.trim().toLowerCase(); return rows.value.filter(r => `${r.key} ${r.id || ''}`.toLowerCase().includes(q)) })
const customKey = computed(() => { const q = query.value.trim(); return keyPattern.test(q) && !rows.value.some(r => r.key === q) ? q : '' })
const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every(r => granted.value.has(r.key)))
function toggle(key: string) { const next = new Set(granted.value); next.has(key) ? next.delete(key) : next.add(key); granted.value = next }
function setAll(on: boolean) { const next = new Set(granted.value); for (const r of filtered.value) on ? next.add(r.key) : next.delete(r.key); granted.value = next }
function addCustom() { if (customKey.value) { toggle(customKey.value); query.value = '' } }

async function save() {
  busy.value = true; error.value = ''
  const sessions = [...granted.value]
  try {
    if (editing.value) {
      await updateUser(editing.value.id, { username: username.value.trim(), role: role.value, disabled: disabled.value, sessions })
      toast('已保存', true)
    } else {
      await createUser({ username: username.value.trim(), password: password.value, role: role.value, sessions })
      toast(`已创建用户 ${username.value.trim()}`, true)
    }
    dialog.value?.close()
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
const valid = computed(() => /^[\p{L}\p{N}_.@-]{2,32}$/u.test(username.value.trim()) && (editing.value || password.value.length >= 8))
</script>
<template>
  <dialog ref="dialog" class="dialog wide" @click.self="dialog?.close()">
    <form class="user-form" @submit.prevent="save">
      <div class="dialog-head">
        <h2>{{ editing ? `编辑用户` : '新建用户' }}</h2>
        <button type="button" class="btn ghost icon-only sm" aria-label="关闭" @click="dialog?.close()"><Icon name="x" :size="14" /></button>
      </div>
      <div class="user-form-grid">
        <div>
          <label class="field-label" for="u-name">用户名</label>
          <input id="u-name" ref="nameInput" v-model="username" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32" required>
        </div>
        <div v-if="!editing">
          <label class="field-label" for="u-pw">初始密码</label>
          <input id="u-pw" v-model="password" class="input" type="password" autocomplete="new-password" minlength="8" required>
        </div>
      </div>
      <label class="field-label">角色</label>
      <div class="segmented" role="radiogroup" aria-label="角色">
        <button type="button" role="radio" :aria-checked="role === 'user'" :class="{ on: role === 'user' }" :disabled="isSelf" @click="role = 'user'">普通用户</button>
        <button type="button" role="radio" :aria-checked="role === 'admin'" :class="{ on: role === 'admin' }" @click="role = 'admin'">管理员</button>
      </div>
      <div v-if="editing" class="user-flags">
        <label v-if="editing" class="check"><input v-model="disabled" type="checkbox" :disabled="isSelf"><span>停用账号 <span class="muted">（立即退出所有设备）</span></span></label>
      </div>

      <div class="grant-head">
        <label class="field-label">可见会话</label>
        <span class="grant-count mono">{{ role === 'admin' ? '全部' : `${granted.size} / ${rows.length}` }}</span>
      </div>
      <div v-if="role === 'admin'" class="grant-admin"><Icon name="shield" :size="14" />管理员可以查看、新建和删除全部会话，无需单独授权。</div>
      <div v-else class="grant-box">
        <div class="grant-tools">
          <label class="search">
            <Icon name="search" :size="14" />
            <input v-model="query" class="input" placeholder="搜索或输入新会话 key" aria-label="搜索会话" @keydown.enter.prevent="addCustom">
          </label>
          <button type="button" class="btn sm" :disabled="!filtered.length" @click="setAll(!allChecked)">{{ allChecked ? '全不选' : '全选' }}</button>
        </div>
        <div class="grant-list">
          <button v-if="customKey" type="button" class="grant-row add" @click="addCustom"><Icon name="plus" :size="13" /><span>授权 <b class="mono">{{ customKey }}</b>（尚未创建）</span></button>
          <label v-for="r in filtered" :key="r.key" class="grant-row" :class="{ on: granted.has(r.key) }">
            <input type="checkbox" :checked="granted.has(r.key)" @change="toggle(r.key)">
            <span class="grant-key">{{ r.key }}</span>
            <span v-if="r.missing" class="badge">未创建</span>
            <span v-else class="grant-meta mono">{{ r.id ? r.id.slice(0, 8) : '未绑定' }}</span>
            <span v-if="r.updated" class="grant-time">{{ shortTime(r.updated) }}</span>
          </label>
          <div v-if="!filtered.length && !customKey" class="state-box">{{ rows.length ? '没有匹配的会话' : '还没有会话' }}</div>
        </div>
      </div>
      <p class="login-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" @click="dialog?.close()">取消</button>
        <button class="btn primary" :disabled="busy || !valid">{{ busy ? '保存中…' : editing ? '保存' : '创建' }}</button>
      </div>
    </form>
  </dialog>
</template>
