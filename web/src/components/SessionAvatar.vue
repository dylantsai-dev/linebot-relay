<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Session } from '../lib/types'
import { sessionName } from '../store'

// A session's picture: the uploaded image, else the first character of its name on a quiet gray disc.
const props = withDefaults(defineProps<{ session?: Session | null; name?: string; src?: string | null; size?: number }>(), { size: 20 })
const broken = ref(false)
const url = computed(() => (props.src !== undefined ? props.src : props.session?.avatar_url) || '')
watch(url, () => { broken.value = false })
const letter = computed(() => [...(props.name || sessionName(props.session))][0]?.toUpperCase() || '·')
</script>
<template>
  <span class="s-avatar" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.46)}px` }" aria-hidden="true">
    <img v-if="url && !broken" :src="url" alt="" draggable="false" @error="broken = true">
    <span v-else>{{ letter }}</span>
  </span>
</template>
