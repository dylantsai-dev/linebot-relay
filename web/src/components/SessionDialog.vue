<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import type { Session } from '../lib/types'
import { renameSession, setSessionAvatar, toast } from '../store'
import Icon from './Icon.vue'
import SessionAvatar from './SessionAvatar.vue'

// Admin: rename a session and set its avatar. The image is cropped to a centered square and
// shrunk to 256px in the browser before upload; the server keeps it in its local avatars folder.
const dialog = ref<HTMLDialogElement>(), nameInput = ref<HTMLInputElement>(), fileInput = ref<HTMLInputElement>()
const session = ref<Session | null>(null)
const name = ref(''), preview = ref<string | null>(null), image = ref<Blob | null | undefined>(undefined)
const busy = ref(false), error = ref('')

function clearRowActionFocus() {
  const el = document.activeElement as HTMLElement | null
  if (el?.closest?.('.row-actions, .session-row')) el.blur()
}
function open(s: Session) {
  session.value = s; name.value = s.name || ''; error.value = ''
  if (preview.value?.startsWith('blob:')) URL.revokeObjectURL(preview.value)
  preview.value = s.avatar_url || null; image.value = undefined
  clearRowActionFocus()
  dialog.value?.showModal()
  void nextTick(() => nameInput.value?.focus())
}
function onClose() { clearRowActionFocus() }
defineExpose({ open })

async function squareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height), out = 256
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = out
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out)
  bitmap.close()
  return await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('图片处理失败'))), 'image/webp', 0.9))
}
async function pick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) { error.value = '请选择图片文件'; return }
  try {
    const blob = await squareImage(file)
    if (preview.value?.startsWith('blob:')) URL.revokeObjectURL(preview.value)
    image.value = blob; preview.value = URL.createObjectURL(blob); error.value = ''
  } catch { error.value = '无法读取这张图片' }
}
function clearAvatar() {
  if (preview.value?.startsWith('blob:')) URL.revokeObjectURL(preview.value)
  preview.value = null; image.value = null
}
const shownName = computed(() => name.value.trim() || session.value?.key || '')
const changed = computed(() => !!session.value && (name.value.trim() !== (session.value.name || '') || image.value !== undefined))

async function save() {
  const s = session.value
  if (!s || !changed.value) { dialog.value?.close(); return }
  busy.value = true; error.value = ''
  try {
    if (name.value.trim() !== (s.name || '')) await renameSession(s.key, name.value.trim())
    if (image.value !== undefined) await setSessionAvatar(s.key, image.value)
    toast('已保存', true)
    dialog.value?.close()
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="dialog" @close="onClose" @click.self="dialog?.close()">
    <form @submit.prevent="save">
      <div class="dialog-head">
        <h2>编辑会话</h2>
        <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="dialog?.close()"><Icon name="x" :size="15" /></button>
      </div>
      <div class="sd-avatar-row">
        <button type="button" class="sd-avatar" aria-label="更换头像" @click="fileInput?.click()">
          <SessionAvatar :session="session" :name="shownName" :src="preview" :size="64" />
          <span class="sd-avatar-hover"><Icon name="image" :size="18" :stroke="1.5" /></span>
        </button>
        <div class="sd-avatar-text">
          <div class="sd-avatar-actions">
            <button type="button" class="btn sm" @click="fileInput?.click()"><Icon name="upload" :size="13" />{{ preview ? '更换头像' : '上传头像' }}</button>
            <button v-if="preview" type="button" class="btn ghost sm" @click="clearAvatar">移除</button>
          </div>
          <span class="field-hint">PNG、JPG、GIF 或 WebP，会裁成正方形</span>
        </div>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden @change="pick">
      </div>
      <label class="field-label" for="sd-name">名称</label>
      <input id="sd-name" ref="nameInput" v-model="name" class="input" maxlength="60" :placeholder="session?.key" autocomplete="off">
      <span class="field-hint">只改显示名称，会话 Key <span class="mono">{{ session?.key }}</span> 和对话内容不变。留空则显示 Key。</span>
      <span v-if="error" class="field-hint error">{{ error }}</span>
      <div class="dialog-actions">
        <button type="button" class="btn ghost" @click="dialog?.close()">取消</button>
        <button type="submit" class="btn primary" :disabled="busy || !changed">{{ busy ? '保存中…' : '保存' }}</button>
      </div>
    </form>
  </dialog>
</template>
