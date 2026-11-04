// Copied snippets use the public relay origin (in dev, the real server instead of localhost).
export const publicOrigin = () => (import.meta.env.VITE_PUBLIC_ORIGIN || location.origin).replace(/\/$/, '')
export const webhookUrl = () => `${publicOrigin()}/webhook`
export const shellQuote = (value: unknown) => `'${String(value).replace(/'/g, `'\\''`)}'`

export type CurlKind = 'json' | 'file'
/** Only pass a real token when the user explicitly picked the "含 Token" option. */
export function webhookCurl(key: string, kind: CurlKind = 'json', token?: string) {
  const auth = token ? shellQuote(`Authorization: Bearer ${token}`) : '"Authorization: Bearer $TOKEN"'
  const lines = [`curl ${shellQuote(webhookUrl())}`, `-H ${auth}`]
  if (kind === 'file') lines.push(`-F ${shellQuote(`session=${key}`)}`, `-F ${shellQuote('message=请查看附件。')}`, `-F ${shellQuote('file=@/path/to/file.png')}`)
  else lines.push(`-H ${shellQuote('Content-Type: application/json')}`, `-d ${shellQuote(JSON.stringify({ session: key, message: '你好' }))}`)
  return lines.join(' \\\n  ')
}
