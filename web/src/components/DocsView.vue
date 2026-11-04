<script setup lang="ts">
import { publicOrigin, shellQuote, webhookCurl } from '../lib/curl'
import { copy } from '../lib/clipboard'
import Icon from './Icon.vue'
const o = publicOrigin()
const json = (body: object) => `curl ${shellQuote(`${o}/webhook`)} \\\n  -H 'Authorization: Bearer <TOKEN>' \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(JSON.stringify(body))}`
const examples: [string, string, string][] = [
  ['同步调用', '等待 Codex 回复后返回', json({ session: 'my-session', message: '你好' })],
  ['回调模式', '立即返回 202，完成后 POST 到回调地址', json({ session: 'my-session', message: '你好', callback_url: 'https://example.com/callback' })],
  ['绑定已有 Codex 会话', '把 key 指向一个已存在的会话', json({ session: 'my-session', message: '继续', codex_session_id: 'existing-session-id' })],
  ['查询会话映射', 'GET /sessions', `curl ${shellQuote(`${o}/sessions`)} \\\n  -H 'Authorization: Bearer <TOKEN>'`],
  ['上传文件（multipart）', '可重复 -F file=@…', webhookCurl('my-session', 'file')],
  ['JSON Base64 附件', 'files: name / content_base64 / mime', `curl ${shellQuote(`${o}/webhook`)} \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H ${shellQuote('Content-Type: application/json')} \\\n  -d ${shellQuote(JSON.stringify({ session: 'my-session', files: [{ name: 'hello.txt', content_base64: 'aGVsbG8=', mime: 'text/plain' }] }))}`],
  ['远程文件 URL', '仅公网 HTTP/HTTPS', `curl ${shellQuote(`${o}/webhook`)} \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H ${shellQuote('Content-Type: application/json')} \\\n  -d ${shellQuote(JSON.stringify({ session: 'my-session', file_urls: ['https://example.com/report.txt'] }))}`],
]
const fields: [string, string][] = [
  ['session', '必填。1–128 个字符，仅限字母、数字和 _ . : -，同一个 key 固定对应同一个 Codex 会话。'],
  ['message', '有附件时可省略，默认“请查看附件。”。无附件 JSON 上限 1 MiB。'],
  ['codex_session_id', '可选。把 key 绑定到已有的 Codex 会话 ID（8–64 位字母、数字、连字符）。'],
  ['callback_url', '可选。HTTP/HTTPS 回调地址；带上后立即返回 202，完成后 POST 结果。'],
  ['files / file', '可选。JSON 的 files（name、content_base64、mime）或 multipart 的 file / files 字段。'],
  ['file_urls', '可选。公网 HTTP/HTTPS 文件地址数组，超时 30 秒，最多 3 次跳转。'],
]
</script>
<template>
  <div class="page">
    <article class="docs">
      <h1>调用说明</h1>
      <p class="lead">所有接口使用 Bearer Token 认证，把 <code>&lt;TOKEN&gt;</code> 换成你的访问密钥。</p>
      <div class="endpoint"><span class="badge">POST</span><code>{{ o }}/webhook</code></div>

      <h2>示例</h2>
      <div v-for="[title, sub, code] in examples" :key="title" class="example">
        <div class="example-head"><span class="example-title">{{ title }}</span><span class="example-sub">{{ sub }}</span><button class="btn ghost icon-only sm" title="复制" :aria-label="`复制 ${title}`" @click="copy(code)"><Icon name="copy" :size="13" /></button></div>
        <pre class="code">{{ code }}</pre>
      </div>

      <h2>请求字段</h2>
      <div class="table-card"><table class="table fields"><thead><tr><th>字段</th><th>说明</th></tr></thead>
        <tbody><tr v-for="[f, d] in fields" :key="f"><td><code>{{ f }}</code></td><td>{{ d }}</td></tr></tbody></table></div>

      <h2>响应</h2>
      <pre class="code">同步：{"session":"my-session","codex_session_id":"…","reply":"你好"}
异步受理：{"accepted":true,"session":"my-session"}
成功回调：{"session":"…","codex_session_id":"…","reply":"…"}
失败回调：{"session":"…","error":"…"}</pre>

      <h2>附件</h2>
      <p>支持 multipart 的 file / files、JSON files（name、content_base64、mime）和 file_urls。默认最多 5 个文件，每个 20 MiB；超限返回 413。远程文件仅支持公网 HTTP/HTTPS，超时 30 秒，最多 3 次跳转。含附件请求上限约 141 MiB。控制台里可以点回形针、拖入或粘贴图片。</p>

      <h2>运行规则</h2>
      <ul>
        <li>同一个 key 的消息严格按顺序执行；全局并发 2；单条消息超时 10 分钟（返回 504）。</li>
        <li>回调超时 15 秒，不自动重试。</li>
        <li>Codex App 正在执行时发送的消息会并入当前回合；需要审批的操作要在 App 里点击确认。</li>
        <li>冒号在工作目录和历史文件名中会映射为下划线。删除会话只删除映射和消息历史，Codex 文件和工作目录保留。</li>
      </ul>
    </article>
  </div>
</template>
