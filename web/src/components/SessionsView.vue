<script setup lang="ts">
import { ref } from 'vue'
import { state, keyPattern, createSession, deleteSession, toast, isAdmin } from '../store'
import SessionList from './SessionList.vue'
import ChatView from './ChatView.vue'

const newDialog = ref<HTMLDialogElement>(), deleteDialog = ref<HTMLDialogElement>(), keyInput = ref<HTMLInputElement>()
const newKey = ref(''), newId = ref(''), deleting = ref(false), toDelete = ref('')
const idPattern = /^[A-Za-z0-9-]{8,64}$/
function openNew() { newKey.value = ''; newId.value = ''; newDialog.value?.showModal(); setTimeout(() => keyInput.value?.focus()) }
function create() {
  if (!keyPattern.test(newKey.value) || (newId.value && !idPattern.test(newId.value))) return
  newDialog.value?.close()
  createSession(newKey.value, newId.value || null)
}
function openDelete() { toDelete.value = state.selected; deleteDialog.value?.showModal() }
async function confirmDelete() {
  deleting.value = true
  try { await deleteSession(toDelete.value); deleteDialog.value?.close(); toast('会话已删除', true) }
  catch (e) { toast((e as Error).message) }
  finally { deleting.value = false }
}
</script>
<template>
  <div class="workspace">
    <Transition name="fade"><div v-if="state.drawer" class="backdrop only-mobile" @click="state.drawer = false" /></Transition>
    <SessionList @create="openNew" />
    <ChatView @delete="openDelete" />

    <dialog ref="newDialog" class="dialog" @click.self="newDialog?.close()">
      <form @submit.prevent="create">
        <h2>新建会话</h2>
        <label class="field-label" for="new-key">会话 key</label>
        <input id="new-key" ref="keyInput" v-model.trim="newKey" class="input mono" maxlength="128" autocomplete="off" placeholder="例如 line:U123">
        <small class="field-hint" :class="{ error: newKey && !keyPattern.test(newKey) }">1–128 个字符，仅限 A–Z a–z 0–9 _ . : -</small>
        <template v-if="isAdmin">
          <label class="field-label" for="new-id">Codex 会话 ID <span class="muted">（可选）</span></label>
          <input id="new-id" v-model.trim="newId" class="input mono" autocomplete="off" placeholder="绑定已有会话">
          <small class="field-hint" :class="{ error: newId && !idPattern.test(newId) }">8–64 位字母、数字、连字符。发送第一条消息后才会保存到服务端。</small>
        </template>
        <small v-else class="field-hint">发送第一条消息后创建，并自动授权给你。</small>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="newDialog?.close()">取消</button>
          <button class="btn primary" :disabled="!keyPattern.test(newKey) || (!!newId && !idPattern.test(newId))">创建</button>
        </div>
      </form>
    </dialog>

    <dialog ref="deleteDialog" class="dialog" @click.self="deleteDialog?.close()">
      <h2>删除会话</h2>
      <p class="mono del-key">{{ toDelete }}</p>
      <p class="muted">只删除会话映射和消息历史，Codex 文件和工作目录会保留。此操作无法撤销。</p>
      <div class="dialog-actions">
        <button class="btn" @click="deleteDialog?.close()">取消</button>
        <button class="btn danger-solid" :disabled="deleting" @click="confirmDelete">{{ deleting ? '删除中…' : '删除' }}</button>
      </div>
    </dialog>
  </div>
</template>
