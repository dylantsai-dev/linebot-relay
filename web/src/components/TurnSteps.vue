<script setup lang="ts">
import { ref } from 'vue'
import type { LiveItem } from '../lib/types'
import { renderMarkdown } from '../lib/markdown'
import Icon from './Icon.vue'

// The process of one turn, laid out the way Codex App does: commentary as plain prose,
// actions as quiet one-line rows (click a command to see its output).
const props = defineProps<{ steps: LiveItem[]; live?: boolean }>()
const openOut = ref(new Set<string>())
const toggle = (id: string) => { const s = new Set(openOut.value); s.has(id) ? s.delete(id) : s.add(id); openOut.value = s }
const running = (s: LiveItem) => props.live && !s.done && s.status !== 'completed' && s.status !== 'failed'
const failed = (s: LiveItem) => s.status === 'failed' || (s.exitCode != null && s.exitCode !== 0)
const verb = (s: LiveItem) => {
  const now = running(s)
  switch (s.kind) {
    case 'command': return now ? '正在运行' : '已运行'
    case 'file': return now ? '正在编辑' : '已编辑'
    case 'search': return now ? '正在搜索' : '已搜索'
    default: return now ? '正在调用' : '已调用'
  }
}
const icon = (k: string) => ({ command: 'terminal', file: 'file-code', search: 'search', tool: 'braces' } as Record<string, string>)[k] || 'braces'
</script>
<template>
  <div class="steps">
    <template v-for="s in steps" :key="s.id">
      <div v-if="s.kind === 'text'" class="step-text md" v-html="renderMarkdown(s.text || '', live)" />
      <div v-else class="step-row" :class="{ live: running(s), failed: failed(s) }">
        <button type="button" class="step-line" :disabled="!(s.kind === 'command' && s.output)" :aria-expanded="openOut.has(s.id)" @click="toggle(s.id)">
          <Icon :name="icon(s.kind)" :size="14" :stroke="1.6" />
          <span class="step-verb">{{ verb(s) }}</span>
          <span class="step-title">{{ s.title }}</span>
          <span v-if="failed(s) && s.exitCode != null" class="step-exit">退出 {{ s.exitCode }}</span>
        </button>
        <pre v-if="openOut.has(s.id) && s.output" class="step-out">{{ s.output.trimEnd() }}</pre>
      </div>
    </template>
  </div>
</template>
