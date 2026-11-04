// Copied snippets use the public relay origin (in dev, the real server instead of localhost).
export const publicOrigin = () => (import.meta.env.VITE_PUBLIC_ORIGIN || location.origin).replace(/\/$/, '')
export type WebhookRoute = '/webhook' | '/webhook/queue' | '/webhook/steer'
/** /webhook queues by default; /webhook/queue (排队) and /webhook/steer (引导) fix the mode by path. */
export const webhookUrl = (route: WebhookRoute = '/webhook') => `${publicOrigin()}${route}`
export const shellQuote = (value: unknown) => `'${String(value).replace(/'/g, `'\\''`)}'`

export type CurlKind = 'json' | 'file'
/** Only pass a real token when the user explicitly picked the "含 Token" option. */
export function webhookCurl(key: string, kind: CurlKind = 'json', token?: string, route: WebhookRoute = '/webhook') {
  const auth = token ? shellQuote(`Authorization: Bearer ${token}`) : '"Authorization: Bearer $TOKEN"'
  const lines = [`curl ${shellQuote(webhookUrl(route))}`, `-H ${auth}`]
  if (kind === 'file') lines.push(`-F ${shellQuote(`session=${key}`)}`, `-F ${shellQuote('message=请查看附件。')}`, `-F ${shellQuote('file=@/path/to/file.png')}`)
  else lines.push(`-H ${shellQuote('Content-Type: application/json')}`, `-d ${shellQuote(JSON.stringify({ session: key, message: '你好' }))}`)
  return lines.join(' \\\n  ')
}
