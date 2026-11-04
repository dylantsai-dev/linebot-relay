<script setup lang="ts">
import { reactive, watchEffect } from 'vue'
import type { Attachment } from '../lib/types'
import { attachmentBlob, toast, state } from '../store'
import { fileSize } from '../lib/format'
import Icon from './Icon.vue'

const props = defineProps<{ files: Attachment[] }>()
const urls = reactive<Record<number, string>>({}), failed = reactive<Record<number, boolean>>({})
const safeRemote = (url?: string) => /^(https:|\/api\/media\/|data:image\/(png|jpeg|gif|webp);)/i.test(url || '')
watchEffect(() => {
  props.files.forEach((file, i) => {
    if (file.kind !== 'image' || urls[i] || failed[i]) return
    if (file.preview) urls[i] = file.preview
    else if (file.url && /^\/api\/media\//.test(file.url)) urls[i] = file.url
    else if (file.path) attachmentBlob(file.path).then(u => (urls[i] = u)).catch(() => (failed[i] = true))
    else if (safeRemote(file.url)) urls[i] = file.url!
  })
})
async function download(file: Attachment) {
  try {
    const url = file.preview || (file.path ? await attachmentBlob(file.path) : '')
    if (!url) throw new Error('没有可下载的附件路径')
    const a = document.createElement('a'); a.href = url; a.download = file.name || 'attachment'; document.body.append(a); a.click(); a.remove()
  } catch (e) { toast((e as Error).message) }
}
</script>
<template>
  <div class="attachments">
    <template v-for="(file, i) in files" :key="i">
      <a v-if="file.kind === 'image'" class="att-image" :href="urls[i] || undefined" target="_blank" rel="noopener noreferrer" :title="file.name" @click="urls[i] && ($event.preventDefault(), state.lightbox = { src: urls[i], alt: file.name || '图片' })">
        <img v-if="urls[i]" :src="urls[i]" :alt="file.name || '图片'" loading="lazy" referrerpolicy="no-referrer">
        <span v-else class="att-placeholder">{{ failed[i] ? `${file.name || '图片'}（读取失败）` : file.name || '图片' }}</span>
      </a>
      <button v-else type="button" class="chip" :disabled="!file.path && !file.preview" @click="download(file)">
        <Icon name="file" :size="14" /><span class="chip-name">{{ file.name || '附件' }}</span><span class="chip-size">{{ fileSize(file.size) }}</span>
      </button>
    </template>
  </div>
</template>
