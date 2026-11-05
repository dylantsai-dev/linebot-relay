<script setup lang="ts">
// Review card for text selected on an assistant reply — 「加到 Agent.md」persists it as project guidance.
import { computed } from 'vue'
import Icon from './Icon.vue'

export interface AnnotationItem {
  id: string
  text: string
  messageId?: string | null
  startOffset?: number | null
  endOffset?: number | null
}

const props = defineProps<{
  items: AnnotationItem[]
  submitting?: boolean
}>()
const emit = defineEmits<{ add: []; dismiss: []; remove: [id: string] }>()

const count = computed(() => props.items.length)
const label = computed(() => `${count.value} 条注释`)
</script>
<template>
  <div class="anno-card" role="dialog" aria-label="回复批注">
    <button type="button" class="anno-close" aria-label="关闭" data-tip="关闭" @click="emit('dismiss')"><Icon name="x" :size="14" /></button>
    <ol class="anno-list">
      <li v-for="(item, i) in items" :key="item.id" class="anno-item">
        <div class="anno-label">{{ i + 1 }}. 所选文本：</div>
        <div class="anno-text">{{ item.text }}</div>
        <button v-if="items.length > 1" type="button" class="anno-remove" aria-label="移除这条注释" @click="emit('remove', item.id)"><Icon name="x" :size="12" /></button>
      </li>
    </ol>
    <div class="anno-badge"><Icon name="chat" :size="12" />{{ label }}</div>
    <button type="button" class="anno-action" :disabled="!count || submitting" @click="emit('add')">
      <Icon v-if="submitting" name="loader" :size="14" class="spin" />
      {{ submitting ? '正在写入…' : '加到 Agent.md' }}
    </button>
  </div>
</template>
