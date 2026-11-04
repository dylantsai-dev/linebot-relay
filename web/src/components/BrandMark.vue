<script setup lang="ts">
// The app mark is src/brand/mark.svg (also served as favicon.svg), inlined: swap that one file and the tab icon and the
// header/login logo change together. Its embedded <style> (fixed colours + prefers-color-scheme) is
// stripped here so the inline copy follows the console's own light/dark theme via CSS variables.
import raw from '../brand/mark.svg?raw'

defineProps<{ size?: number }>()
const markup = raw
  .replace(/<style[\s\S]*?<\/style>/, '')
  .replace(/\swidth="[^"]*"\s+height="[^"]*"/, ' width="100%" height="100%" aria-hidden="true" focusable="false"')
</script>

<template>
  <span class="brand-logo" :style="{ width: (size || 22) + 'px', height: (size || 22) + 'px' }" v-html="markup" />
</template>
