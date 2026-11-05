<script setup lang="ts">
import { computed, reactive, watchEffect } from 'vue'
import type { Attachment } from '../lib/types'
import { attachmentBlob, toast } from '../store'
import { fileSize } from '../lib/format'
import Icon from './Icon.vue'
import ImageStack from './ImageStack.vue'

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
const signedFile = (file: Attachment) => (file.url && /^\/api\/media\/[^?]+\?.*\bt=f\b/.test(file.url) ? file.url : '')
const fileIcon = (name?: string) => (/\.(zip|tar|gz|tgz|7z|rar)$/i.test(name || '') ? 'file-archive' : /\.(js|ts|py|go|rs|json|ya?ml|sh|html|css|vue|c|cpp|java)$/i.test(name || '') ? 'file-code' : 'file-text')
async function download(file: Attachment) {
  try {
    const url = signedFile(file) || file.preview || (file.path ? await attachmentBlob(file.path) : '')
    if (!url) throw new Error('没有可下载的附件路径')
    const a = document.createElement('a'); a.href = url; a.download = file.name || 'attachment'; document.body.append(a); a.click(); a.remove()
  } catch (e) { toast((e as Error).message) }
}

const imageEntries = computed(() => props.files
  .map((file, i) => ({ file, i }))
  .filter(({ file }) => file.kind === 'image'))
const otherEntries = computed(() => props.files
  .map((file, i) => ({ file, i }))
  .filter(({ file }) => file.kind !== 'image'))
const stackImages = computed(() => imageEntries.value
  .filter(({ i }) => !!urls[i])
  .map(({ file, i }) => ({ src: urls[i], alt: file.name || '图片', title: file.name })))
const pendingImages = computed(() => imageEntries.value.filter(({ i }) => !urls[i]))
</script>
<template>
  <div class="attachments">
    <ImageStack v-if="stackImages.length" :images="stackImages" />
    <template v-for="({ file, i }) in pendingImages" :key="'pending-' + i">
      <span class="att-placeholder">{{ failed[i] ? `${file.name || '图片'}（读取失败）` : file.name || '图片' }}</span>
    </template>
    <template v-for="({ file, i }) in otherEntries" :key="'file-' + i">
      <a v-if="signedFile(file)" class="chip" :href="signedFile(file)" :download="file.name || 'attachment'" :title="`下载 ${file.name || '附件'}`">
        <span class="chip-icon"><Icon :name="fileIcon(file.name)" :size="15" /></span><span class="chip-text"><span class="chip-name">{{ file.name || '附件' }}</span><span class="chip-size">{{ fileSize(file.size) }}</span></span><Icon name="download" :size="14" class="chip-dl" />
      </a>
      <button v-else type="button" class="chip" :disabled="!file.path && !file.preview" @click="download(file)">
        <span class="chip-icon"><Icon :name="fileIcon(file.name)" :size="15" /></span><span class="chip-text"><span class="chip-name">{{ file.name || '附件' }}</span><span class="chip-size">{{ fileSize(file.size) }}</span></span><Icon name="download" :size="14" class="chip-dl" />
      </button>
    </template>
  </div>
</template>
