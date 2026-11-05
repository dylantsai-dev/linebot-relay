<script setup lang="ts">
import { hookCurl } from '../lib/curl'
import { copy } from '../lib/clipboard'
import Icon from './Icon.vue'
const examples: [string, string, string][] = [
  ['同步调用', '等待回复后返回', hookCurl()],
  ['引导当前回合', 'mode: steer', hookCurl(undefined, undefined, 'json', { message: '先只改前端', mode: 'steer' })],
  ['回调模式', '立即返回 202，完成后 POST 到回调地址', hookCurl(undefined, undefined, 'json', { message: '你好', callback_url: 'https://example.com/callback' })],
  ['上传文件（multipart）', '可重复 -F file=@…', hookCurl(undefined, undefined, 'file')],
  ['JSON Base64 附件', 'files: name / content_base64 / mime', hookCurl(undefined, undefined, 'json', { files: [{ name: 'hello.txt', content_base64: 'aGVsbG8=', mime: 'text/plain' }] })],
  ['远程文件 URL', '仅公网 HTTP/HTTPS', hookCurl(undefined, undefined, 'json', { file_urls: ['https://example.com/report.txt'] })],
]
const fields: [string, string][] = [
  ['message', '有附件时可省略，默认“请查看附件。”。无附件 JSON 上限 1 MiB。'],
  ['mode', '可选。queue（默认，排队）或 steer（引导正在运行的回合；没有运行中的回合时排到队首）。'],
  ['callback_url', '可选。HTTP/HTTPS 回调地址；带上后立即返回 202，完成后 POST 结果。'],
  ['files / file', '可选。JSON 的 files（name、content_base64、mime）或 multipart 的 file / files 字段。'],
  ['file_urls', '可选。公网 HTTP/HTTPS 文件地址数组，超时 30 秒，最多 3 次跳转。'],
]
</script>
<template>
  <div class="page">
    <article class="docs">
      <h1><span class="title-icon"><Icon name="docs" :size="18" /></span>调用说明</h1>
      <p class="lead">每个会话都有自己的 Webhook 地址和密钥，只能向这一个会话投递消息。管理员在会话顶栏或侧栏的 <Icon name="webhook" :size="13" /> 里查看和复制，也可以重置密钥。</p>
      <div class="endpoints">
        <div class="endpoint"><span class="badge app">POST</span><code>$HOOK_URL</code><span class="muted">会话自己的地址，形如 /hook/&lt;ID&gt;</span></div>
        <div class="endpoint"><span class="badge">标头</span><code>Authorization: Bearer $HOOK_KEY</code><span class="muted">会话自己的密钥（dbk_ 开头）</span><button class="btn ghost icon-only sm" data-tip="复制标头" aria-label="复制标头" @click="copy('Authorization: Bearer $HOOK_KEY')"><Icon name="copy" :size="13" /></button></div>
      </div>
      <p class="muted">旧的共享地址 /webhook 已停用（返回 410）。密钥重置后旧密钥立即失效，地址不变。</p>

      <h2><span class="title-icon sm"><Icon name="terminal" :size="15" /></span>示例</h2>
      <div v-for="[title, sub, code] in examples" :key="title" class="example">
        <div class="example-head"><span class="example-title">{{ title }}</span><span class="example-sub">{{ sub }}</span><button class="btn ghost icon-only sm" data-tip="复制命令" :aria-label="`复制 ${title}`" @click="copy(code)"><Icon name="copy" :size="13" /></button></div>
        <pre class="code">{{ code }}</pre>
      </div>

      <h2><span class="title-icon sm"><Icon name="braces" :size="15" /></span>请求字段</h2>
      <div class="table-card"><table class="table fields"><thead><tr><th>字段</th><th>说明</th></tr></thead>
        <tbody><tr v-for="[f, d] in fields" :key="f"><td><code>{{ f }}</code></td><td>{{ d }}</td></tr></tbody></table></div>

      <h2><span class="title-icon sm"><Icon name="enter" :size="15" /></span>响应</h2>
      <pre class="code">同步：{"session":"my-session","reply":"你好"}
异步受理：{"accepted":true,"session":"my-session","id":"…","mode":"queue"}
成功回调：{"session":"…","reply":"…"}
失败回调：{"session":"…","error":"…"}</pre>

      <h2><span class="title-icon sm"><Icon name="paperclip" :size="15" /></span>附件</h2>
      <p>支持任意类型文件：multipart 的 file / files、JSON files（name、content_base64、mime）和 file_urls。默认每条消息最多 10 个文件，单个 ≤ 50 MiB，合计 ≤ 100 MiB；超限返回 413。图片（png / jpeg / gif / webp）直接交给三代目看图，其他文件保存后把绝对路径写进消息，小文本文件会内联。远程文件仅支持公网 HTTP/HTTPS，超时 30 秒，最多 3 次跳转。控制台里可以点 + 号、拖入或粘贴文件。</p>

      <h2><span class="title-icon sm"><Icon name="settings" :size="15" /></span>运行规则</h2>
      <ul>
        <li>同一个 key 的消息严格按顺序执行；全局并发 2；单条消息超时 10 分钟（返回 504）。</li>
        <li>回调超时 15 秒，不自动重试。</li>
        <li>会话正在运行时，新消息默认<b>排队</b>，当前回合结束后依次发送，发送前可在控制台撤回；选择<b>引导</b>会通过 turn/steer 插入正在运行的回合。控制台可随时停止当前回合。</li>
        <li>需要审批的操作要在 ディランボット 三代目 后台确认。</li>
        <li>冒号在工作目录和历史文件名中会映射为下划线。删除会话只删除映射和消息历史，对话文件和工作目录保留。</li>
      </ul>
    </article>
  </div>
</template>
