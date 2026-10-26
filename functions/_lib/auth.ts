export type CloudRole = 'admin' | 'guest'
export interface CloudSession { role: CloudRole; name: string; exp: number }
export interface CloudEnv { DB: D1Database; DATA: R2Bucket; APP_PASSWORD: string; SESSION_SECRET: string }
const COOKIE_NAME = 'manbanpai_session'
const SESSION_SECONDS = 60 * 60 * 24 * 7
const enc = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let raw = ''
  for (const value of bytes) raw += String.fromCharCode(value)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}
async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))))
}
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}
function readCookie(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))
  if (!match) return null
  try { return decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) } catch { return null }
}
export async function getSession(request: Request, env: CloudEnv): Promise<CloudSession | null> {
  const value = readCookie(request)
  if (!value || !env.SESSION_SECRET) return null
  const [payloadText, signature, extra] = value.split('.')
  if (!payloadText || !signature || extra !== undefined) return null
  try {
    const expected = await sign(`manbanpai-session:${payloadText}`, env.SESSION_SECRET)
    if (!constantTimeEqual(signature, expected)) return null
    const decoded = new TextDecoder().decode(fromBase64Url(payloadText))
    const payload = JSON.parse(decoded) as Partial<CloudSession>
    if (!Number.isSafeInteger(payload.exp) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null
    if (payload.role !== 'admin' && payload.role !== 'guest') return null
    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 64) return null
    return { role: payload.role, name: payload.name, exp: Number(payload.exp) }
  } catch { return null }
}
export async function isAuthenticated(request: Request, env: CloudEnv): Promise<boolean> {
  return (await getSession(request, env)) !== null
}

const FRIEND_NOTICES_STATE_KEY = 'friend-notices:config'
const DEFAULT_ALLOWED_GUEST_NAMES = ['月桑']

/** Check the friend allowlist stored alongside the per-friend note settings. */
export async function isGuestNameAllowed(db: D1Database, candidate: string): Promise<boolean> {
  const requestedName = candidate.trim().toLocaleLowerCase()
  if (!requestedName) return false

  const row = await db.prepare('SELECT value_json FROM app_state WHERE state_key = ?')
    .bind(FRIEND_NOTICES_STATE_KEY)
    .first<{ value_json: string }>()

  // On a fresh database, preserve the one built-in friend entry until the admin saves a list.
  if (!row?.value_json) {
    return DEFAULT_ALLOWED_GUEST_NAMES.some(name => name.toLocaleLowerCase() === requestedName)
  }

  try {
    const stored = JSON.parse(String(row.value_json)) as { notices?: unknown }
    if (!Array.isArray(stored.notices)) return false
    return stored.notices.some(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const record = item as Record<string, unknown>
      return record.accessEnabled !== false && typeof record.name === 'string' &&
        record.name.trim().toLocaleLowerCase() === requestedName
    })
  } catch {
    return false
  }
}
export async function makeSessionCookie(env: CloudEnv, role: CloudRole, name: string): Promise<string> {
  const payload: CloudSession = { role, name, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }
  const payloadText = toBase64Url(enc.encode(JSON.stringify(payload)))
  const signature = await sign(`manbanpai-session:${payloadText}`, env.SESSION_SECRET)
  const token = `${payloadText}.${signature}`
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}
export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  if (!candidate || !expected) return false
  return constantTimeEqual(candidate, expected)
}
export function cleanGuestName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ').slice(0, 32)
}
