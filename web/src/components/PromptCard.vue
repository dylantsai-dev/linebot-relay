<script setup lang="ts">
// An approval / question the running turn is waiting on (Codex-App style card in the message flow).
import { ref, reactive, computed, watch, nextTick } from 'vue'
import type { Prompt, PromptDecision } from '../lib/types'
import { answerPrompt } from '../store'
import Icon from './Icon.vue'

const props = defineProps<{ prompt: Prompt }>()
const submitting = ref<string>('')
const picked = reactive<Record<string, string>>({})
const typed = reactive<Record<string, string>>({})
const skipped = reactive<Record<string, boolean>>({})
const step = ref(0)
const reply = ref<HTMLTextAreaElement | null>(null)

const icon = computed(() => ({ command: 'terminal', file: 'file-code', input: 'help', permissions: 'shield-alert' })[props.prompt.kind] || 'shield')
const labels: Record<PromptDecision, string> = { accept: '允许', acceptForSession: '本会话允许', decline: '拒绝', cancel: '停止回合' }
const decisions = computed(() => (props.prompt.decisions || []).filter(d => d in labels))
const fileType: Record<string, string> = { add: '新增', delete: '删除', update: '修改' }

// Questions: one page per question (1 / N), reply box always open, 跳过 / 下一步 like the desktop App.
const questions = computed(() => props.prompt.questions || [])
const total = computed(() => questions.value.length)
const current = computed(() => questions.value[Math.min(step.value, Math.max(0, total.value - 1))])
const last = computed(() => step.value >= total.value - 1)
const answerOf = (qid: string) => (typed[qid] || '').trim() || picked[qid] || ''
const hasAnswer = computed(() => !!current.value && !!answerOf(current.value.id))
watch(() => props.prompt.id, () => { step.value = 0 })

async function decide(decision: PromptDecision) {
  if (submitting.value) return
  submitting.value = decision
  const ok = await answerPrompt(props.prompt.id, { decision })
  if (!ok) submitting.value = ''
}
async function submit() {
  if (submitting.value) return
  submitting.value = 'submit'
  const out: Record<string, string> = {}
  for (const q of questions.value) { const value = skipped[q.id] ? '' : answerOf(q.id); if (value) out[q.id] = value }
  const ok = await answerPrompt(props.prompt.id, { answers: out })
  if (!ok) submitting.value = ''
}
function focusReply() { void nextTick(() => { const el = reply.value; if (el) { grow(); el.focus({ preventScroll: true }) } }) }
function go(delta: number) { const next = step.value + delta; if (next >= 0 && next < total.value) { step.value = next; focusReply() } }
function advance(skip: boolean) {
  if (submitting.value || !current.value) return
  skipped[current.value.id] = skip
  if (last.value) void submit()
  else go(1)
}
// Closing skips everything that is left; the turn keeps going (stop it from the composer).
function dismiss() { for (const q of questions.value) if (!answerOf(q.id)) skipped[q.id] = true; void submit() }
function pick(qid: string, label: string) { picked[qid] = picked[qid] === label ? '' : label; skipped[qid] = false }
function grow() { const el = reply.value; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px` }
function onReplyKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (hasAnswer.value) advance(false)
}
</script>
<template>
  <div class="prompt-card" :class="`kind-${prompt.kind}`" role="group" :aria-label="prompt.title">
    <div class="prompt-head">
      <span class="prompt-ico"><Icon :name="icon" :size="15" /></span>
      <strong>{{ prompt.title }}</strong>
      <span v-if="prompt.kind !== 'input'" class="prompt-wait"><span class="prompt-dot" />等待你的确认</span>
      <span v-else class="prompt-nav">
        <template v-if="total > 1">
          <button type="button" class="prompt-nav-btn prev" aria-label="上一个问题" :disabled="step === 0 || !!submitting" @click="go(-1)"><Icon name="chevron" :size="14" /></button>
          <span class="prompt-count">{{ step + 1 }} / {{ total }}</span>
          <button type="button" class="prompt-nav-btn next" aria-label="下一个问题" :disabled="last || !!submitting" @click="go(1)"><Icon name="chevron" :size="14" /></button>
        </template>
        <button type="button" class="prompt-nav-btn" aria-label="全部跳过" data-tip="全部跳过" :disabled="!!submitting" @click="dismiss"><Icon name="x" :size="14" /></button>
      </span>
    </div>
    <p v-if="prompt.reason" class="prompt-reason">{{ prompt.reason }}</p>

    <pre v-if="prompt.command" class="prompt-code mono"><span class="prompt-sigil">$</span> {{ prompt.command }}</pre>
    <div v-if="prompt.cwd" class="prompt-meta mono" :title="prompt.cwd"><Icon name="file" :size="12" />{{ prompt.cwd }}</div>
    <ul v-if="prompt.files?.length" class="prompt-files">
      <li v-for="f in prompt.files" :key="f.path" class="mono"><span class="prompt-tag">{{ fileType[f.type] || '修改' }}</span>{{ f.path }}</li>
    </ul>
    <div v-if="prompt.grant_root" class="prompt-meta mono"><Icon name="lock" :size="12" />申请写入 {{ prompt.grant_root }}</div>
    <ul v-if="prompt.summary?.length" class="prompt-files">
      <li v-for="line in prompt.summary" :key="line" class="mono">{{ line }}</li>
    </ul>

    <template v-if="prompt.kind === 'input' && current">
      <div class="prompt-q" :key="current.id">
        <div v-if="current.header" class="prompt-q-head">{{ current.header }}</div>
        <div class="prompt-q-text">{{ current.question }}</div>
        <div v-if="current.options.length" class="prompt-opts" role="radiogroup" :aria-label="current.header || current.question">
          <button v-for="(o, i) in current.options" :key="o.label" type="button" role="radio" class="prompt-opt" :class="{ on: picked[current.id] === o.label && !typed[current.id]?.trim() }" :aria-checked="picked[current.id] === o.label" :disabled="!!submitting" @click="pick(current.id, o.label)">
            <span class="prompt-opt-n">{{ i + 1 }}</span>
            <span class="prompt-opt-text"><span class="prompt-opt-label">{{ o.label }}</span><span v-if="o.description" class="prompt-opt-sub">{{ o.description }}</span></span>
            <Icon v-if="picked[current.id] === o.label && !typed[current.id]?.trim()" name="check" :size="14" class="prompt-opt-check" />
          </button>
        </div>
        <div class="prompt-reply">
          <input v-if="current.isSecret" v-model="typed[current.id]" class="prompt-reply-box" type="password" :placeholder="current.options.length ? '或者输入其他回答…' : '回复…'" :disabled="!!submitting" autocomplete="off" @keydown="onReplyKey">
          <textarea v-else ref="reply" v-model="typed[current.id]" rows="1" class="prompt-reply-box" :placeholder="current.options.length ? '或者输入其他回答…' : '回复…'" :disabled="!!submitting" @input="grow" @keydown="onReplyKey" />
        </div>
      </div>
      <div class="prompt-actions end">
        <button type="button" class="btn sm pill ghost" :disabled="!!submitting" @click="advance(true)">跳过</button>
        <button type="button" class="btn sm pill primary" :disabled="!hasAnswer || !!submitting" @click="advance(false)">
          <Icon v-if="submitting === 'submit'" name="loader" :size="13" class="spin" />{{ last ? '提交' : '下一步' }}
        </button>
      </div>
    </template>
    <div v-else class="prompt-actions">
      <button v-for="d in decisions" :key="d" type="button" class="btn sm" :class="{ primary: d === 'accept', ghost: d === 'cancel', 'prompt-stop': d === 'cancel' }" :disabled="!!submitting" @click="decide(d)">
        <Icon v-if="submitting === d" name="loader" :size="13" class="spin" />{{ labels[d] }}
      </button>
    </div>
  </div>
</template>
