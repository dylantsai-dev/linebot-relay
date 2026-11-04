<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { state, allSessions, selectSession, refreshSessions, canCreate } from '../store'
import { shortTime, time } from '../lib/format'
import { copy } from '../lib/clipboard'
import Icon from './Icon.vue'
import CopyMenu from './CopyMenu.vue'

const emit = defineEmits<{ create: [] }>()
const query = ref(''), searchInput = ref<HTMLInputElement>()
function slash(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable && state.tab === 'sessions') { e.preventDefault(); state.drawer = true; searchInput.value?.focus() }
  if (e.key === 'Escape' && state.drawer) state.drawer = false
}
onMounted(() => document.addEventListener('keydown', slash))
onBeforeUnmount(() => document.removeEventListener('keydown', slash))
const visible = computed(() => { const q = query.value.trim().toLowerCase(); return allSessions.value.filter(s => `${s.key} ${s.codex_session_id || ''}`.toLowerCase().includes(q)) })
const menuAnchor = ref<HTMLElement | null>(null), menuKey = ref('')
function openMenu(e: MouseEvent, key: string) {
  const el = e.currentTarget as HTMLElement
  if (menuAnchor.value === el) { closeMenu(false); return }
  menuAnchor.value = el; menuKey.value = key
}
function closeMenu(focus: boolean) { const a = menuAnchor.value; menuAnchor.value = null; if (focus) a?.focus({ preventScroll: true }) }
const statusText = (s: { status: string; queued: number }) => s.status === 'running' ? `运行中${s.queued ? ` +${s.queued}` : ''}` : s.status === 'queued' ? `排队 ${s.queued || 1}` : ''
const retry = () => refreshSessions().catch(e => (state.sessionsError = e.message))
</script>
<template>
  <aside class="sidebar" :class="{ open: state.drawer }" aria-label="会话列表">
    <div class="sidebar-top">
      <button class="btn ghost icon-only only-mobile" aria-label="关闭会话列表" @click="state.drawer = false"><Icon name="x" /></button>
      <label class="search">
        <Icon name="search" :size="14" />
        <input ref="searchInput" v-model="query" class="input" placeholder="搜索 key / Codex ID" aria-label="搜索会话">
        <kbd v-if="!query" class="kbd">/</kbd>
      </label>
    </div>
    <div class="sidebar-actions" :class="{ single: !canCreate }">
      <button class="btn sm" title="复制 Webhook" aria-haspopup="menu" :aria-expanded="!!menuAnchor && menuKey === state.selected" @click="openMenu($event, state.selected)"><Icon name="copy" :size="13" />复制 Webhook</button>
      <button v-if="canCreate" class="btn sm primary" title="新建会话" @click="emit('create')"><Icon name="plus" :size="13" />新建</button>
    </div>
    <div class="list-head"><span>会话</span><span class="count">{{ visible.length }}</span></div>
    <div class="session-list">
      <template v-if="!state.sessionsLoaded && !state.sessionsError">
        <div v-for="i in 4" :key="i" class="skeleton-row"><span class="sk w60" /><span class="sk w40" /></div>
      </template>
      <div v-else-if="state.sessionsError && !allSessions.length" class="state-box error">
        <Icon name="alert" /><span>{{ state.sessionsError }}</span><button class="btn sm" @click="retry">重试</button>
      </div>
      <TransitionGroup v-else name="list" tag="div" class="session-items">
        <div v-for="s in visible" :key="s.key" class="session-row" :class="{ selected: state.selected === s.key }">
          <button type="button" class="session" :aria-pressed="state.selected === s.key" @click="selectSession(s.key)">
            <span class="s-line">
              <span class="dot" :class="s.status" :title="s.status === 'running' ? '运行中' : s.status === 'queued' ? '排队中' : '空闲'" />
              <span class="s-key">{{ s.key }}</span>
              <span v-if="statusText(s)" class="s-status">{{ statusText(s) }}</span>
              <span v-else-if="s.draft" class="s-status">草稿</span>
              <span v-else class="s-time">{{ shortTime(s.updated_at) }}</span>
            </span>
            <span class="s-sub" :title="`${s.codex_session_id || '未绑定'} · ${time(s.updated_at)}`">
              <span class="mono">{{ s.codex_session_id ? s.codex_session_id.slice(0, 8) : '未绑定' }}</span>
              <span>· {{ s.messages }} 条</span>
            </span>
          </button>
          <div class="row-actions">
            <button v-if="s.codex_session_id" type="button" class="mini" title="复制 Codex ID" :aria-label="`复制 ${s.key} 的 Codex ID`" @click="copy(s.codex_session_id)"><Icon name="copy" :size="13" /></button>
            <button type="button" class="mini" title="复制 Webhook" :aria-label="`复制 ${s.key} 的 Webhook`" aria-haspopup="menu" @click="openMenu($event, s.key)"><Icon name="link" :size="13" /></button>
          </div>
        </div>
      </TransitionGroup>
      <div v-if="state.sessionsLoaded && !visible.length" class="state-box">
        <Icon name="chat" :size="18" />
        <span>{{ allSessions.length ? '没有匹配的会话' : canCreate ? '还没有会话' : '还没有分配给你的会话' }}</span>
        <button v-if="!allSessions.length && canCreate" class="btn sm" @click="emit('create')">新建会话</button>
      </div>
    </div>
    <CopyMenu :anchor="menuAnchor" :session-key="menuKey" @close="closeMenu" />
  </aside>
</template>
