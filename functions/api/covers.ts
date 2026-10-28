import { getSession, isGuestNameAllowed, type CloudEnv } from '../_lib/auth'
interface Env extends CloudEnv {}
type SharedCoverMetadata = { fileName:string; mimeType:string; sizeBytes:number; uploadedAt:number; sha256:string }
const json = (body: unknown, status = 200, extra: Record<string,string> = {}) => new Response(JSON.stringify(body), { status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra} })
const now = () => Date.now()
const mimeByExtension: Record<string,string> = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif' }
const extensionOf = (name: string) => name.toLowerCase().split('.').pop() || ''
function validImageSignature(ext: string, bytes: Uint8Array): boolean {
  if (ext === 'jpg' || ext === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (ext === 'png') return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  if (ext === 'gif') return bytes.length >= 6 && String.fromCharCode(...bytes.slice(0,6)) .match(/^GIF8[79]a$/) !== null
  if (ext === 'webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP'
  return false
}
function toCover(id: string, metadata: SharedCoverMetadata) {
  return { id, ...metadata, url:'/api/covers/' + encodeURIComponent(id) }
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const method = request.method.toUpperCase()
  if (!['GET','HEAD','POST'].includes(method)) return json({error:'不支援此封面操作。'},405,{Allow:'GET, HEAD, POST'})
  const session = await getSession(request, env)
  if (!session) return json({error:'請先登入才能存取雲端封面庫。'},401)
  if (session.role === 'guest' && !await isGuestNameAllowed(env.DB, session.name)) return json({error:'此名稱已關閉訪問。'},403)
  if (method === 'POST' && session.role !== 'admin') return json({error:'只有管理員可以上傳雲端封面。'},403)

  try {
    if (method === 'GET' || method === 'HEAD') {
      const result = await env.DB.prepare("SELECT state_key,value_json FROM app_state WHERE state_key LIKE 'shared-cover:%'").all<{state_key:string;value_json:string}>()
      const covers: Array<{id:string;url:string;fileName:string;mimeType:string;sizeBytes:number;uploadedAt:number}> = []
      for (const row of result.results || []) {
        const id = String(row.state_key || '').slice('shared-cover:'.length)
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue
        try {
          const metadata = JSON.parse(String(row.value_json || '{}')) as SharedCoverMetadata
          if (!metadata || typeof metadata.fileName !== 'string' || typeof metadata.mimeType !== 'string') continue
          covers.push(toCover(id, { fileName:metadata.fileName, mimeType:metadata.mimeType, sizeBytes:Number(metadata.sizeBytes) || 0, uploadedAt:Number(metadata.uploadedAt) || 0, sha256:String(metadata.sha256 || '') }))
        } catch { /* Ignore malformed metadata rather than breaking the cover picker. */ }
      }
      covers.sort((a,b) => b.uploadedAt - a.uploadedAt || a.fileName.localeCompare(b.fileName))
      return method === 'HEAD' ? new Response(null,{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}) : json({covers})
    }

    const url = new URL(request.url)
    const id = String(url.searchParams.get('id') || '')
    const name = String(url.searchParams.get('name') || '').slice(0,255)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return json({error:'封面識別碼格式不正確。'},400)
    const ext = extensionOf(name)
    const mimeType = mimeByExtension[ext]
    if (!mimeType) return json({error:'請選擇 JPG、PNG、WebP 或 GIF 封面圖片。'},400)
    const maxBytes = 5 * 1024 * 1024
    const declaredSize = Number(request.headers.get('Content-Length') || 0)
    if (declaredSize > maxBytes) return json({error:'封面圖片超過 5 MB，請縮小圖片後重新選擇。'},413)
    const existing = await env.DB.prepare('SELECT state_key FROM app_state WHERE state_key=?').bind('shared-cover:' + id).first<{state_key:string}>()
    if (existing) return json({error:'封面識別碼已存在，請重新選擇圖片。'},409)
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (!bytes.byteLength) return json({error:'封面圖片是空的。'},400)
    if (bytes.byteLength > maxBytes) return json({error:'封面圖片超過 5 MB，請縮小圖片後重新選擇。'},413)
    if (!validImageSignature(ext, bytes)) return json({error:'圖片內容與副檔名不符，請選擇有效的 JPG、PNG、WebP 或 GIF 圖片。'},400)
    const digest = await crypto.subtle.digest('SHA-256',bytes as BufferSource)
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('')
    const existingCovers = await env.DB.prepare("SELECT state_key,value_json FROM app_state WHERE state_key LIKE 'shared-cover:%'").all<{state_key:string;value_json:string}>()
    for (const row of existingCovers.results || []) {
      const existingId = String(row.state_key || '').slice('shared-cover:'.length)
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(existingId)) continue
      try {
        const existingMetadata = JSON.parse(String(row.value_json || '{}')) as SharedCoverMetadata
        if (existingMetadata.sha256 === sha256) return json({ok:true,cover:toCover(existingId,existingMetadata),reused:true},200)
      } catch { /* Ignore malformed entries when checking for duplicate image bytes. */ }
    }

    const metadata: SharedCoverMetadata = {fileName:name || ('cover.' + ext),mimeType,sizeBytes:bytes.byteLength,uploadedAt:now(),sha256}
    const objectKey = 'shared-covers/' + id
    await env.DATA.put(objectKey,bytes,{httpMetadata:{contentType:mimeType,cacheControl:'private, no-cache'},customMetadata:{fileName:metadata.fileName}})
    try {
      await env.DB.prepare('INSERT INTO app_state(state_key,value_json,updated_at) VALUES(?,?,?)').bind('shared-cover:' + id,JSON.stringify(metadata),now()).run()
    } catch (error) {
      await env.DATA.delete(objectKey).catch(() => undefined)
      throw error
    }
    return json({ok:true,cover:toCover(id,metadata)},201)
  } catch (error) {
    console.error('[慢半拍 shared covers]',error)
    return json({error:error instanceof Error ? error.message : '雲端封面服務發生錯誤。'},500)
  }
}
