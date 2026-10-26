import { getSession, isGuestNameAllowed, type CloudEnv } from '../../../_lib/auth'
interface Env extends CloudEnv {}
type AssetKind = 'pdf'|'mp3'|'midi'
const json = (body: unknown, status = 200, extra: Record<string,string> = {}) => new Response(JSON.stringify(body), { status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra} })
const now = () => Date.now()
const isAssetKind = (value: string): value is AssetKind => value === 'pdf' || value === 'mp3' || value === 'midi'
type AssetMetadata = { fileName:string; mimeType:string; sizeBytes:number; uploadedAt:number }
type AssetIndex = Partial<Record<AssetKind,AssetMetadata>>

export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  let scoreId = ''
  let kindText = ''
  try { scoreId = decodeURIComponent(String(params.scoreId || '')); kindText = decodeURIComponent(String(params.kind || '')) } catch { return json({error:'附件路徑格式不正確。'},400) }
  const method = request.method.toUpperCase()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scoreId) || !isAssetKind(kindText)) return json({error:'附件路徑格式不正確。'},400)
  const kind = kindText
  const objectKey = `score-assets/${scoreId}/${kind}`
  const stateKey = `score-asset:${scoreId}`
  const session = await getSession(request, env)
  if (!session) return json({error:'請先登入才能存取曲譜附件。'},401)
  if (session.role === 'guest' && !await isGuestNameAllowed(env.DB, session.name)) return json({error:'此名稱已關閉訪問。'},403)
  if ((method === 'PUT' || method === 'DELETE') && session.role !== 'admin') return json({error:'只有管理員可以上傳或刪除曲譜附件。'},403)

  try {
    const row = await env.DB.prepare('SELECT value_json FROM app_state WHERE state_key=?').bind(stateKey).first<{value_json:string}>()
    let index: AssetIndex = {}
    try { if (row?.value_json) index = JSON.parse(row.value_json) as AssetIndex } catch { index = {} }

    if (method === 'PUT') {
      const limits: Record<AssetKind,number> = { pdf:50*1024*1024, mp3:100*1024*1024, midi:10*1024*1024 }
      const name = String(new URL(request.url).searchParams.get('name') || `${scoreId}.${kind === 'midi' ? 'mid' : kind}`).slice(0,255)
      const validExtension = kind === 'pdf' ? /\.pdf$/i.test(name) : kind === 'mp3' ? /\.(mp3|mpga)$/i.test(name) : /\.(mid|midi)$/i.test(name)
      if (!validExtension) return json({error:kind === 'pdf' ? '請選擇 PDF 檔案。' : kind === 'mp3' ? '請選擇 MP3 檔案。' : '請選擇 MIDI（.mid / .midi）檔案。'},400)
      const declaredSize = Number(request.headers.get('Content-Length') || 0)
      if (declaredSize > limits[kind]) return json({error:`檔案超過大小限制（${Math.round(limits[kind]/1024/1024)} MB）。`},413)
      const bytes = await request.arrayBuffer()
      if (!bytes.byteLength) return json({error:'上傳檔案是空的。'},400)
      if (bytes.byteLength > limits[kind]) return json({error:`檔案超過大小限制（${Math.round(limits[kind]/1024/1024)} MB）。`},413)
      const defaultMime = kind === 'pdf' ? 'application/pdf' : kind === 'mp3' ? 'audio/mpeg' : 'audio/midi'
      const suppliedMime = (request.headers.get('Content-Type') || defaultMime).split(';')[0].slice(0,100)
      const mimeType = kind === 'pdf' ? 'application/pdf' : kind === 'mp3' ? 'audio/mpeg' : suppliedMime
      await env.DATA.put(objectKey,bytes,{httpMetadata:{contentType:mimeType,cacheControl:'private, no-cache'},customMetadata:{fileName:name}})
      const metadata: AssetMetadata = {fileName:name,mimeType,sizeBytes:bytes.byteLength,uploadedAt:now()}
      index[kind] = metadata
      await env.DB.prepare('INSERT INTO app_state(state_key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').bind(stateKey,JSON.stringify(index),now()).run()
      return json({ok:true,asset:{...metadata,url:`/api/score-assets/${encodeURIComponent(scoreId)}/${kind}`}},201)
    }

    if (method === 'DELETE') {
      await env.DATA.delete(objectKey)
      delete index[kind]
      if (Object.keys(index).length) {
        await env.DB.prepare('UPDATE app_state SET value_json=?,updated_at=? WHERE state_key=?').bind(JSON.stringify(index),now(),stateKey).run()
      } else {
        await env.DB.prepare('DELETE FROM app_state WHERE state_key=?').bind(stateKey).run()
      }
      return json({ok:true})
    }

    if (method === 'GET' || method === 'HEAD') {
      const metadata = index[kind]
      if (!metadata) return json({error:'找不到這份曲譜的附件。'},404)
      const object = await env.DATA.get(objectKey,request.headers.has('Range') ? {range:request.headers} : undefined)
      if (!object) return json({error:'雲端附件不存在。'},404)
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('ETag',object.httpEtag)
      headers.set('Accept-Ranges','bytes')
      headers.set('Cache-Control','private, no-cache')
      headers.set('X-Content-Type-Options','nosniff')
      headers.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(String(metadata.fileName || `${scoreId}.${kind}`))}`)
      const range = (object as any).range
      let status = 200
      if (range && typeof range.offset === 'number' && typeof range.length === 'number') {
        status = 206
        headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`)
      }
      headers.set('Content-Length',String(range?.length ?? object.size))
      return new Response(method === 'HEAD' ? null : object.body,{status,headers})
    }
    return json({error:'不支援此附件操作。'},405,{Allow:'GET, HEAD, PUT, DELETE'})
  } catch (error) {
    console.error('[慢半拍 score-assets]',scoreId,kind,error)
    return json({error:error instanceof Error ? error.message : '附件儲存服務發生錯誤。'},500)
  }
}
