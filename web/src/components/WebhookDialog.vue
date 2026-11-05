<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Session } from '../lib/types'
import { sessionWebhook, rotateWebhook, sessionName, toast, type SessionWebhook } from '../store'
import { copy } from '../lib/clipboard'
import { publicOrigin, hookCurl } from '../lib/curl'
import Icon from './Icon.vue'
import SessionAvatar from './SessionAvatar.vue'

// Admin: this session's own webhook. Anyone holding the URL + key can post into this one session only.
const dialog = ref<HTMLDialogElement>()
const session = ref<Session | null>(null), hook = ref<SessionWebhook | null>(null)
const loading = ref(false), error = ref(''), reveal = ref(false), confirming = ref(false), rotating = ref(false)

/** Drop focus from sidebar row mini-buttons so :focus / sticky hover cannot pin the floating toolbar after close. */
function clearRowActionFocus() {
  const el = document.activeElement as HTMLElement | null
  if (el?.closest?.('.row-actions, .row-del, .session-row')) el.blur()
}

async function open(s: Session) {
  session.value = s; hook.value = null; error.value = ''; reveal.value = false; confirming.value = false
  clearRowActionFocus()
  dialog.value?.showModal()
  loading.value = true
  try { hook.value = await sessionWebhook(s.key) } catch (e) { error.value = (e as Error).message } finally { loading.value = false }
}
function onClose() { clearRowActionFocus() }
defineExpose({ open })

const url = computed(() => (hook.value ? publicOrigin() + hook.value.path : ''))
const masked = (k: string) => `${k.slice(0, 4)}${'•'.repeat(20)}${k.slice(-4)}`
const shownKey = computed(() => (hook.value ? (reveal.value ? hook.value.secret : masked(hook.value.secret)) : ''))
const header = computed(() => `Authorization: Bearer ${shownKey.value}`)

async function rotate() {
  if (!session.value) return
  rotating.value = true
  try { hook.value = await rotateWebhook(session.value.key); confirming.value = false; toast('已重置，旧密钥已失效', true) }
  catch (e) { error.value = (e as Error).message } finally { rotating.value = false }
}
</script>
<template>
  <dialog ref="dialog" class="dialog wide" @close="onClose" @click.self="dialog?.close()">
    <div class="dialog-head">
      <h2><span class="title-icon"><Icon name="webhook" :size="17" /></span>Webhook</h2>
      <button type="button" class="btn ghost icon-only sm" aria-label="关闭" data-tip="关闭 (Esc)" @click="dialog?.close()"><Icon name="x" :size="15" /></button>
    </div>
    <p class="dialog-sub wh-sub"><SessionAvatar :session="session" :name="sessionName(session)" :src="session?.avatar_url" :size="16" /><span>向 <b>{{ sessionName(session) }}</b> 发送 HTTP 请求即可投递消息。地址和密钥只属于这个会话。</span></p>

    <div v-if="session?.paused" class="wh-paused"><Icon name="pause" :size="14" />这个会话已暂停接收，Webhook 请求会返回 423「该会话已暂停接收」。</div>
    <div v-if="loading" class="wh-rows" aria-busy="true">
      <div v-for="l in ['POST 到', '密钥', '标头']" :key="l" class="wh-row"><span class="wh-label">{{ l }}</span><div class="wh-box"><span class="wh-bar wh-skel" /></div></div>
      <div class="wh-row"><span class="wh-label">正文</span><div class="wh-box plain"><span class="wh-val mono">{"message": "你好"}</span><span class="wh-note">可选 mode、callback_url、files</span></div></div>
    </div>
    <div v-else-if="hook" class="wh-rows">
      <div class="wh-row">
        <span class="wh-label">POST 到</span>
        <div class="wh-box"><span class="wh-val mono">{{ url }}</span><button type="button" class="btn ghost icon-only sm" data-tip="复制地址" aria-label="复制地址" @click="copy(url)"><Icon name="copy" :size="13" /></button></div>
      </div>
      <div class="wh-row">
        <span class="wh-label">密钥</span>
        <div class="wh-box">
          <span class="wh-val mono">{{ shownKey }}</span>
          <button type="button" class="btn ghost icon-only sm" :data-tip="reveal ? '隐藏' : '显示'" :aria-label="reveal ? '隐藏密钥' : '显示密钥'" @click="reveal = !reveal"><Icon :name="reveal ? 'eye-off' : 'eye'" :size="13" /></button>
          <button type="button" class="btn ghost icon-only sm" data-tip="复制密钥" aria-label="复制密钥" @click="copy(hook.secret, '已复制密钥，注意保密')"><Icon name="copy" :size="13" /></button>
        </div>
      </div>
      <div class="wh-row">
        <span class="wh-label">标头</span>
        <div class="wh-box"><span class="wh-val mono">{{ header }}</span><button type="button" class="btn ghost icon-only sm" data-tip="复制标头" aria-label="复制标头" @click="copy(`Authorization: Bearer ${hook.secret}`, '已复制标头，注意保密')"><Icon name="copy" :size="13" /></button></div>
      </div>
      <div class="wh-row">
        <span class="wh-label">正文</span>
        <div class="wh-box plain"><span class="wh-val mono">{"message": "你好"}</span><span class="wh-note">可选 mode、callback_url、files</span></div>
      </div>
    </div>
    <span v-if="error" class="field-hint error">{{ error }}</span>

    <div class="dialog-actions wh-actions">
      <template v-if="!confirming">
        <button type="button" class="btn ghost sm danger-hover" :disabled="!hook" @click="confirming = true"><Icon name="refresh" :size="13" />重置密钥</button>
        <span class="spacer" />
        <button type="button" class="btn sm" :disabled="!hook" @click="copy(hookCurl(url, hook!.secret), '已复制 curl（含密钥）')"><Icon name="terminal" :size="13" />复制 curl</button>
        <button type="button" class="btn primary sm" @click="dialog?.close()">完成</button>
      </template>
      <template v-else>
        <span class="wh-warn"><Icon name="alert" :size="14" />旧密钥会立即失效，正在使用它的系统需要换成新密钥。</span>
        <span class="spacer" />
        <button type="button" class="btn ghost sm" @click="confirming = false">取消</button>
        <button type="button" class="btn danger-solid sm" :disabled="rotating" @click="rotate">{{ rotating ? '重置中…' : '确认重置' }}</button>
      </template>
    </div>
  </dialog>
</template>
