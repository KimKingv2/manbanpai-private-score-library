import { getSession, isGuestNameAllowed, type CloudEnv } from '../../_lib/auth'
interface Env extends CloudEnv {}
type SharedCoverMetadata = { fileName:string; mimeType:string; sizeBytes:number; uploadedAt:number }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'} })

export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return json({error:'此封面路由只供讀取。'},405)
  let id = ''
  try { id = decodeURIComponent(String(params.coverId || '')) } catch { return json({error:'封面路徑格式不正確。'},400) }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return json({error:'封面路徑格式不正確。'},400)
  const session = await getSession(request, env)
  if (!session) return json({error:'請先登入才能讀取封面圖片。'},401)
  if (session.role === 'guest' && !await isGuestNameAllowed(env.DB, session.name)) return json({error:'此名稱已關閉訪問。'},403)

  try {
    const row = await env.DB.prepare('SELECT value_json FROM app_state WHERE state_key=?').bind('shared-cover:' + id).first<{value_json:string}>()
    if (!row?.value_json) return json({error:'找不到這張雲端封面。'},404)
    let metadata: SharedCoverMetadata
    try { metadata = JSON.parse(row.value_json) as SharedCoverMetadata } catch { return json({error:'封面資料格式不正確。'},500) }
    const object = await env.DATA.get('shared-covers/' + id)
    if (!object) return json({error:'雲端封面圖片不存在。'},404)
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('ETag',object.httpEtag)
    headers.set('Cache-Control','private, no-cache')
    headers.set('X-Content-Type-Options','nosniff')
    headers.set('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(String(metadata.fileName || (id + '.jpg'))))
    headers.set('Content-Length',String(object.size))
    return new Response(method === 'HEAD' ? null : object.body,{status:200,headers})
  } catch (error) {
    console.error('[慢半拍 shared cover image]',id,error)
    return json({error:error instanceof Error ? error.message : '讀取雲端封面失敗。'},500)
  }
}
