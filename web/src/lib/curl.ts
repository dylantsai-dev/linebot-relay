// Copied snippets use the public relay origin (in dev, the real server instead of localhost).
export const publicOrigin = () => (import.meta.env.VITE_PUBLIC_ORIGIN || location.origin).replace(/\/$/, '')
export const shellQuote = (value: unknown) => `'${String(value).replace(/'/g, `'\\''`)}'`

export type CurlKind = 'json' | 'file'
/** Each session has its own webhook URL and key, so the body never names a session. */
export function hookCurl(url = '$HOOK_URL', key?: string, kind: CurlKind = 'json', body: object = { message: '你好' }) {
  const auth = key ? shellQuote(`Authorization: Bearer ${key}`) : '"Authorization: Bearer $HOOK_KEY"'
  const lines = [`curl ${url.startsWith('$') ? `"${url}"` : shellQuote(url)}`, `-H ${auth}`]
  if (kind === 'file') lines.push(`-F ${shellQuote('message=请查看附件。')}`, `-F ${shellQuote('file=@/path/to/file.png')}`)
  else lines.push(`-H ${shellQuote('Content-Type: application/json')}`, `-d ${shellQuote(JSON.stringify(body))}`)
  return lines.join(' \\\n  ')
}
