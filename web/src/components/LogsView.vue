<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { logs, refreshLogs, isAdmin } from '../store'
import { time, duration, uptime } from '../lib/format'
import Icon from './Icon.vue'
onMounted(() => { if (!logs.loaded) void refreshLogs() })
const cards = computed(() => {
  const s = logs.stats
  if (!s) return []
  const rate = s.today.calls ? Math.round(((s.today.calls - s.today.failures) / s.today.calls) * 100) : null
  return [
    { icon: 'activity', label: '今日调用', value: String(s.today.calls), sub: rate === null ? '—' : `成功率 ${rate}%` },
    { icon: 'alert', label: '今日失败', value: String(s.today.failures), sub: s.today.failures ? '需要关注' : '无异常', warn: s.today.failures > 0 },
    { icon: 'clock', label: '平均耗时', value: duration(s.today.avg_duration_ms), sub: '今日' },
    { icon: 'chat', label: '会话', value: String(s.total_sessions), sub: '已绑定' },
    { icon: 'queue', label: '运行 / 排队', value: `${s.running} / ${s.queued}`, sub: `已运行 ${uptime(s.uptime_s)}` },
  ]
})
const week = computed(() => logs.usage?.week || null)
const other = computed(() => {
  const u = logs.usage
  if (!u?.week) return null
  const alt = [u.primary, u.secondary].find(w => w && w !== u.week)
  return alt || null
})
const planLabel = computed(() => {
  const plan = logs.usage?.plan
  if (!plan) return null
  const map: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', promax: 'Pro Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', edu_plus: 'Edu Plus', edu_pro: 'Edu Pro' }
  return map[plan] || plan
})
function resetText(iso: string | null) {
  if (!iso) return '重置时间未知'
  return `重置于 ${time(iso)}`
}
</script>
<template>
  <div class="page">
    <div class="page-inner">
      <div class="page-head">
        <div><h1><span class="title-icon"><Icon name="logs" :size="18" /></span>日志</h1><p class="muted">最近 100 次 Webhook 与控制台调用，时间为台北时间。<template v-if="!isAdmin">仅显示你有权访问的会话。</template></p></div>
      </div>

      <div v-if="isAdmin" class="usage-card">
        <div class="usage-head">
          <span class="stat-label"><Icon name="activity" :size="13" />每周用量</span>
          <span v-if="planLabel" class="usage-plan">{{ planLabel }}</span>
          <span class="spacer" />
          <span v-if="week" class="usage-pct mono">{{ week.used_percent }}%</span>
        </div>
        <template v-if="week">
          <div class="usage-bar" role="progressbar" :aria-valuenow="week.used_percent" aria-valuemin="0" aria-valuemax="100" :aria-label="`${week.label}已用 ${week.used_percent}%`">
            <span class="usage-fill" :class="{ warn: week.used_percent >= 80, hot: week.used_percent >= 95 }" :style="{ width: `${week.used_percent}%` }" />
          </div>
          <div class="usage-meta">
            <span>{{ week.label }}已用 {{ week.used_percent }}%</span>
            <span class="dim">{{ resetText(week.resets_at) }}</span>
          </div>
          <div v-if="other" class="usage-secondary">
            <span>{{ other.label }} {{ other.used_percent }}%</span>
            <span class="dim">{{ resetText(other.resets_at) }}</span>
          </div>
        </template>
        <div v-else-if="logs.usageError" class="usage-empty warn">{{ logs.usageError }}</div>
        <div v-else-if="logs.loading && !logs.usage" class="usage-empty"><span class="sk w60" /><span class="sk w40" /></div>
        <div v-else class="usage-empty">暂无用量数据</div>
      </div>

      <div class="stats">
        <template v-if="cards.length">
          <div v-for="c in cards" :key="c.label" class="stat"><span class="stat-label"><Icon :name="c.icon" :size="13" />{{ c.label }}</span><strong :class="{ warn: c.warn }">{{ c.value }}</strong><span class="stat-sub">{{ c.sub }}</span></div>
        </template>
        <template v-else><div v-for="i in 5" :key="i" class="stat"><span class="sk w40" /><span class="sk w60 tall" /></div></template>
      </div>
      <div class="toolbar">
        <h2><span class="title-icon sm"><Icon name="stats" :size="15" /></span>最近调用</h2>
        <span class="spacer" />
        <label class="check"><input v-model="logs.auto" type="checkbox"> 自动刷新</label>
        <button class="btn ghost icon-only" :class="{ spinning: logs.loading }" data-tip="立即刷新" aria-label="刷新" @click="refreshLogs"><Icon name="refresh" /></button>
      </div>
      <div v-if="logs.error" class="banner error"><Icon name="alert" :size="14" />{{ logs.error }}</div>
      <div class="table-card">
        <div class="table-scroll">
          <table class="table">
            <thead><tr><th>时间（台北）</th><th>会话</th><th>来源</th><th>耗时</th><th>结果</th><th>错误</th></tr></thead>
            <tbody>
              <tr v-for="row in logs.requests" :key="row.request_id">
                <td class="mono">{{ time(row.time) }}</td>
                <td class="mono">{{ row.session || '—' }}</td>
                <td><span class="badge">{{ row.source || '—' }}</span></td>
                <td class="mono dim">{{ duration(row.duration_ms) }}</td>
                <td><span class="result"><span class="dot" :class="row.ok ? 'ok' : 'fail'" />{{ row.ok ? '成功' : `失败 ${row.status || ''}` }}</span></td>
                <td :class="row.error ? 'err' : 'dim'">{{ row.error || '' }}</td>
              </tr>
              <tr v-if="logs.loaded && !logs.requests.length"><td colspan="6"><div class="state-box"><div class="state-icon"><Icon name="inbox" :size="20" /></div><strong>还没有调用记录</strong><span>Webhook 或控制台发出的请求会出现在这里。</span></div></td></tr>
              <template v-if="!logs.loaded && !logs.error"><tr v-for="i in 6" :key="i"><td colspan="6"><span class="sk w90" /></td></tr></template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
