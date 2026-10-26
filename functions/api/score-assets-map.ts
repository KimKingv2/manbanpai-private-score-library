import { getSession, type CloudEnv } from '../_lib/auth'
interface Env extends CloudEnv {}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' } })

/** Read-only attachment index shared by all signed-in users. Binary data remains in private R2. */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error:'此路由只供讀取附件索引。' },405)
  const session = await getSession(request, env)
  if (!session) return json({ error:'請先登入才能讀取曲譜附件索引。' },401)
  try {
    const result = await env.DB.prepare("SELECT state_key,value_json FROM app_state WHERE state_key LIKE 'score-asset:%'").all<any>()
    const map: Record<string, Record<string, any>> = {}
    for (const row of result.results || []) {
      const scoreId = String(row.state_key || '').slice('score-asset:'.length)
      if (!scoreId) continue
      try {
        const stored = JSON.parse(String(row.value_json || '{}')) as Record<string, any>
        const assets: Record<string, any> = {}
        for (const kind of ['pdf','mp3','midi']) {
          const item = stored[kind]
          if (!item || typeof item.fileName !== 'string') continue
          assets[kind] = { ...item, url:`/api/score-assets/${encodeURIComponent(scoreId)}/${kind}` }
        }
        if (Object.keys(assets).length) map[scoreId] = assets
      } catch { /* ignore malformed attachment metadata without blocking the score library */ }
    }
    return request.method === 'HEAD'
      ? new Response(null,{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})
      : json(map)
  } catch (error) {
    console.error('[慢半拍 score-assets-map]',error)
    return json({ error:'無法讀取曲譜附件索引。' },500)
  }
}
