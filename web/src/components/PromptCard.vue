<script setup lang="ts">
// An approval / question the running turn is waiting on (Codex-App style card in the message flow).
import { ref, reactive, computed } from 'vue'
import type { Prompt, PromptDecision } from '../lib/types'
import { answerPrompt } from '../store'
import Icon from './Icon.vue'

const props = defineProps<{ prompt: Prompt }>()
const submitting = ref<string>('')
const picked = reactive<Record<string, string>>({})
const typed = reactive<Record<string, string>>({})

const icon = computed(() => ({ command: 'terminal', file: 'file-code', input: 'help', permissions: 'shield-alert' })[props.prompt.kind] || 'shield')
const labels: Record<PromptDecision, string> = { accept: '允许', acceptForSession: '本会话允许', decline: '拒绝', cancel: '停止回合' }
const decisions = computed(() => (props.prompt.decisions || []).filter(d => d in labels))
const fileType: Record<string, string> = { add: '新增', delete: '删除', update: '修改' }

const answers = computed(() => {
  const out: Record<string, string> = {}
  for (const q of props.prompt.questions || []) {
    const value = (typed[q.id] || '').trim() || picked[q.id] || ''
    if (value) out[q.id] = value
  }
  return out
})
const complete = computed(() => (props.prompt.questions || []).every(q => answers.value[q.id]))

async function decide(decision: PromptDecision) {
  if (submitting.value) return
  submitting.value = decision
  const ok = await answerPrompt(props.prompt.id, { decision })
  if (!ok) submitting.value = ''
}
async function submit() {
  if (submitting.value || !complete.value) return
  submitting.value = 'submit'
  const ok = await answerPrompt(props.prompt.id, { answers: answers.value })
  if (!ok) submitting.value = ''
}
function pick(qid: string, label: string) { picked[qid] = picked[qid] === label ? '' : label; typed[qid] = '' }
</script>
<template>
  <div class="prompt-card" :class="`kind-${prompt.kind}`" role="group" :aria-label="prompt.title">
    <div class="prompt-head">
      <span class="prompt-ico"><Icon :name="icon" :size="15" /></span>
      <strong>{{ prompt.title }}</strong>
      <span class="prompt-wait"><span class="prompt-dot" />等待你的确认</span>
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

    <template v-if="prompt.kind === 'input'">
      <div v-for="q in prompt.questions" :key="q.id" class="prompt-q">
        <div v-if="q.header" class="prompt-q-head">{{ q.header }}</div>
        <div class="prompt-q-text">{{ q.question }}</div>
        <div v-if="q.options.length" class="prompt-chips">
          <button v-for="o in q.options" :key="o.label" type="button" class="prompt-chip" :class="{ on: picked[q.id] === o.label && !typed[q.id] }" :title="o.description || o.label" :disabled="!!submitting" @click="pick(q.id, o.label)">
            {{ o.label }}<span v-if="o.description" class="prompt-chip-sub">{{ o.description }}</span>
          </button>
        </div>
        <input v-if="q.isOther || !q.options.length" v-model="typed[q.id]" class="prompt-input" :type="q.isSecret ? 'password' : 'text'" :placeholder="q.options.length ? '或者输入其他回答…' : '输入回答…'" :disabled="!!submitting" @keydown.enter.prevent="submit">
      </div>
      <div class="prompt-actions">
        <button type="button" class="btn sm primary" :disabled="!complete || !!submitting" @click="submit"><Icon :name="submitting === 'submit' ? 'loader' : 'check'" :size="13" :class="{ spin: submitting === 'submit' }" />提交</button>
        <span class="spacer" />
        <button type="button" class="btn sm ghost" :disabled="!!submitting" @click="decide('cancel')"><Icon :name="submitting === 'cancel' ? 'loader' : 'stop'" :size="12" :class="{ spin: submitting === 'cancel' }" />停止回合</button>
      </div>
    </template>
    <div v-else class="prompt-actions">
      <button v-for="d in decisions" :key="d" type="button" class="btn sm" :class="{ primary: d === 'accept', ghost: d === 'cancel', 'prompt-stop': d === 'cancel' }" :disabled="!!submitting" @click="decide(d)">
        <Icon v-if="submitting === d" name="loader" :size="13" class="spin" />{{ labels[d] }}
      </button>
    </div>
  </div>
</template>
