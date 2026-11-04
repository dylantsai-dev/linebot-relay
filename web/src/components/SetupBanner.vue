<script setup lang="ts">
import { ref } from 'vue'
import { state, setupAdmin, toast } from '../store'
import Icon from './Icon.vue'
const dialog = ref<HTMLDialogElement>()
const username = ref(''), password = ref(''), confirm = ref(''), busy = ref(false), error = ref('')
function open() { username.value = password.value = confirm.value = error.value = ''; dialog.value?.showModal() }
async function submit() {
  if (password.value !== confirm.value) { error.value = '两次输入的密码不一致'; return }
  busy.value = true; error.value = ''
  try { await setupAdmin(username.value.trim(), password.value); dialog.value?.close(); toast(`已创建管理员 ${username.value.trim()}，并已切换到该账号`, true) }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <div v-if="state.me?.needs_setup && state.me.auth === 'token'" class="setup-banner">
    <span class="title-icon sm"><Icon name="shield" :size="14" /></span>
    <span>尚未创建管理员账号。创建后即可用用户名密码登录，并为其他用户分配可见会话。</span>
    <button class="btn sm primary" @click="open">创建管理员</button>
    <dialog ref="dialog" class="dialog" @click.self="dialog?.close()">
      <form @submit.prevent="submit">
        <div class="dialog-head">
          <h2><span class="title-icon"><Icon name="shield" :size="16" /></span>创建管理员</h2>
          <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="dialog?.close()"><Icon name="x" :size="15" /></button>
        </div>
        <p class="muted">管理员可以看到全部会话并管理用户。访问令牌仍然保留全部权限。</p>
        <label class="field-label" for="setup-user">用户名</label>
        <input id="setup-user" v-model="username" class="input" autocomplete="username" autocapitalize="off" spellcheck="false" required>
        <label class="field-label" for="setup-pw">密码</label>
        <input id="setup-pw" v-model="password" class="input" type="password" autocomplete="new-password" minlength="8" required>
        <label class="field-label" for="setup-confirm">确认密码</label>
        <input id="setup-confirm" v-model="confirm" class="input" type="password" autocomplete="new-password" required>
        <small class="field-hint" :class="{ error: !!error }">{{ error || '用户名 2–32 位；密码至少 8 位' }}</small>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="dialog?.close()">取消</button>
          <button class="btn primary" :disabled="busy || !username.trim() || password.length < 8"><span v-if="busy" class="spinner sm inv" />{{ busy ? '创建中…' : '创建并登录' }}</button>
        </div>
      </form>
    </dialog>
  </div>
</template>
