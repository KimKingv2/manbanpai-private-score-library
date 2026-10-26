import { getSession, isGuestNameAllowed, type CloudEnv } from '../_lib/auth'

interface Env extends CloudEnv {}

type FriendNotice = {
  id: string
  name: string
  label: string
  title: string
  message: string
  delayMs: number
  accessEnabled: boolean
  enabled: boolean
}

const STATE_KEY = 'friend-notices:config'
const MAX_NOTICES = 100
const MAX_DELAY_MS = 30_000
const now = () => Date.now()

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  },
})

const DEFAULT_NOTICES: FriendNotice[] = [{
  id: 'notice-yuesang',
  name: '月桑',
  label: 'A LITTLE NOTE FROM KIM',
  title: '来自Kim的小紙條',
  message: [
    '哔哔哔哔哔哔哔哔！',
    '检测到超超超超超级VIP月桑登录！！！',
    '希望你今天也能在喜歡的旋律裡，找到一點屬於自己的時間。',
    '祝你每天都心情愉快！',
    '要开心呀！！！',
  ].join('\n'),
  delayMs: 1000,
  accessEnabled: true,
  enabled: true,
}]

function asText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanNotice(value: unknown, index = 0): FriendNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = asText(raw.name, 32)
  const title = asText(raw.title, 120)
  const message = typeof raw.message === 'string' ? raw.message.slice(0, 4000) : ''
  const accessEnabled = raw.accessEnabled !== false
  const enabled = raw.enabled !== false
  if (!name || (enabled && (!title || !message.trim()))) return null
  const rawDelay = Number(raw.delayMs)
  const delayMs = Number.isFinite(rawDelay) ? Math.max(0, Math.min(MAX_DELAY_MS, Math.round(rawDelay))) : 1000
  return {
    id: asText(raw.id, 120) || `friend-notice-${index + 1}`,
    name,
    label: asText(raw.label, 80),
    title: title || '給你的一則小紙條',
    message,
    delayMs,
    accessEnabled,
    enabled,
  }
}

async function readNotices(env: Env): Promise<FriendNotice[]> {
  const row = await env.DB.prepare('SELECT value_json FROM app_state WHERE state_key = ?')
    .bind(STATE_KEY)
    .first<{ value_json: string }>()
  if (!row?.value_json) return DEFAULT_NOTICES.map(notice => ({ ...notice }))
  try {
    const stored = JSON.parse(String(row.value_json)) as { notices?: unknown }
    if (!stored || !Array.isArray(stored.notices)) return []
    return stored.notices
      .map((item, index) => cleanNotice(item, index))
      .filter((item): item is FriendNotice => item !== null)
  } catch {
    console.error('[慢半拍 friend-notices] Saved config is not valid JSON.')
    return []
  }
}

function validateIncomingNotices(input: unknown): { notices?: FriendNotice[]; error?: string } {
  if (!Array.isArray(input)) return { error: '公告設定格式不正確，請重新載入後再試。' }
  if (input.length > MAX_NOTICES) return { error: `最多可以設定 ${MAX_NOTICES} 則朋友公告。` }

  const notices: FriendNotice[] = []
  const seenNames = new Set<string>()
  const seenIds = new Set<string>()

  for (let index = 0; index < input.length; index++) {
    const raw = input[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `第 ${index + 1} 則公告格式不正確。` }
    }
    const record = raw as Record<string, unknown>
    const notice = cleanNotice(record, index)
    if (!notice) {
      return { error: `第 ${index + 1} 位朋友請填寫登入名稱；若要顯示小紙條，還需要填寫標題與內容。` }
    }
    const nameKey = notice.name.toLocaleLowerCase()
    if (seenNames.has(nameKey)) return { error: `觸發名字「${notice.name}」重複了；每個名字請只設定一則公告。` }
    if (seenIds.has(notice.id)) return { error: `第 ${index + 1} 則公告的識別碼重複了，請重新載入設定再試。` }
    seenNames.add(nameKey)
    seenIds.add(notice.id)
    notices.push(notice)
  }
  return { notices }
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'PUT') {
    return json({ error: '不支援此公告設定操作。' }, 405)
  }

  const session = await getSession(request, env)
  if (!session) return json({ error: '請先登入才能使用朋友公告。' }, 401)
  if (session.role === 'guest' && !await isGuestNameAllowed(env.DB, session.name)) {
    return json({ error: '此名稱已關閉訪問，請聯絡 Kim。' }, 403)
  }
  try {
    if (method === 'GET') {
      const url = new URL(request.url)
      const wantsManagement = url.searchParams.get('manage') === '1'
      const notices = await readNotices(env)

      if (wantsManagement) {
        if (session.role !== 'admin') return json({ error: '只有管理員可以管理朋友公告。' }, 403)
        return json({ notices })
      }

      // A normal signed-in visitor receives only the notice matching the name they entered.
      // As requested for this private friend group, the display name is not treated as strong identity proof.
      const requestedName = (session.role === 'guest' ? session.name : (url.searchParams.get('name') || '')).trim().toLocaleLowerCase()
      const notice = requestedName
        ? notices.find(item => item.accessEnabled && item.enabled && item.name.trim().toLocaleLowerCase() === requestedName) ?? null
        : null
      return json({ notice })
    }

    if (session.role !== 'admin') return json({ error: '只有管理員可以修改朋友公告。' }, 403)

    const contentLength = Number(request.headers.get('Content-Length') || 0)
    if (contentLength > 128 * 1024) return json({ error: '公告設定內容過大。' }, 413)
    const body = await request.json().catch(() => null) as { notices?: unknown } | null
    const validated = validateIncomingNotices(body?.notices)
    if (validated.error || !validated.notices) return json({ error: validated.error || '公告設定格式不正確。' }, 400)

    const valueJson = JSON.stringify({ version: 1, notices: validated.notices })
    await env.DB.prepare(
      'INSERT INTO app_state(state_key, value_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at',
    ).bind(STATE_KEY, valueJson, now()).run()

    return json({ ok: true, notices: validated.notices })
  } catch (error) {
    console.error('[慢半拍 friend-notices]', error)
    return json({ error: error instanceof Error ? error.message : '公告設定服務發生錯誤。' }, 500)
  }
}
