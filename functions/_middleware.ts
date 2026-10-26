import { getSession, type CloudEnv } from './_lib/auth'
interface Env extends CloudEnv {}
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const path = url.pathname
  const method = context.request.method.toUpperCase()
  const publicAuthRoutes = new Set(['/api/auth/login', '/api/auth/check', '/api/auth/logout'])
  if (path.startsWith('/api/') || path.startsWith('/media/')) {
    if (!publicAuthRoutes.has(path)) {
      try {
        const session = await getSession(context.request, context.env)
        if (!session) return json({ error: '請先登入「慢半拍系列」。', code: 'AUTH_REQUIRED' }, 401)
        if (path.startsWith('/media/') && method !== 'GET' && method !== 'HEAD') return json({ error: '不允許的媒體請求。' }, 405)
        if (path.startsWith('/api/') && method !== 'GET' && method !== 'HEAD' && session.role !== 'admin') {
          // Guests may save their own chord-analysis corrections, namespaced by the API.
          if (!(path === '/api/state' && method === 'PUT' && session.role === 'guest')) {
            return json({ error: '訪客帳戶僅可瀏覽與播放，不能管理曲庫。', code: 'ADMIN_REQUIRED' }, 403)
          }
        }
      } catch (error) {
        console.error('[慢半拍] Auth middleware error:', error)
        return json({ error: '雲端登入服務尚未正確設定。' }, 500)
      }
    }
  }
  return context.next()
}
