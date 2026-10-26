import { clearSessionCookie, getSession, makeSessionCookie, passwordMatches, cleanGuestName, type CloudEnv } from '../_lib/auth'
interface Env extends CloudEnv {}
type Score = { id:string; title:string; artist?:string; coverUrl?:string; keySignature?:string; timeSignature?:string; tempoBpm?:string; measureCount?:string; fileUrl:string; type:'piano'|'guitar-vocal'|'guitar-fingerstyle'; category?:string; favorite?:boolean; updatedAt?:number; sourceFileName?:string }
const json = (body: unknown, status = 200, extra: Record<string,string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } })
const now = () => Date.now()
const fromRow = (row: any): Score => ({ id:row.id, title:row.title, artist:row.artist||'', coverUrl:row.cover_url||'', keySignature:row.key_signature||'', timeSignature:row.time_signature||'', tempoBpm:row.tempo_bpm||'', measureCount:row.measure_count||'', fileUrl:row.file_url, type:row.type, category:row.category||'未分類', favorite:!!row.favorite, updatedAt:Number(row.updated_at)||now(), sourceFileName:row.source_file_name||'' })
async function upsertScore(db: D1Database, score: Score) {
  if (!score || typeof score.id !== 'string' || typeof score.title !== 'string' || typeof score.fileUrl !== 'string' || !['piano','guitar-vocal','guitar-fingerstyle'].includes(score.type)) throw new Error('曲目資料格式不正確。')
  await db.prepare(`INSERT INTO scores (id,title,artist,cover_url,key_signature,time_signature,tempo_bpm,measure_count,file_url,type,category,favorite,updated_at,source_file_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,cover_url=excluded.cover_url,key_signature=excluded.key_signature,time_signature=excluded.time_signature,tempo_bpm=excluded.tempo_bpm,measure_count=excluded.measure_count,file_url=excluded.file_url,type=excluded.type,category=excluded.category,favorite=excluded.favorite,updated_at=excluded.updated_at,source_file_name=excluded.source_file_name`)
    .bind(score.id, score.title, score.artist||'', score.coverUrl||'', score.keySignature||'', score.timeSignature||'', score.tempoBpm||'', score.measureCount||'', score.fileUrl, score.type, score.category||'未分類', score.favorite?1:0, score.updatedAt||now(), score.sourceFileName||'').run()
}
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const method = request.method.toUpperCase()
  try {
    if (parts[0] === 'auth' && parts[1] === 'check' && method === 'GET') {
      const session = await getSession(request, env)
      return json({ authenticated: !!session, role: session?.role ?? null, name: session?.name ?? null })
    }
    if (parts[0] === 'auth' && parts[1] === 'login' && method === 'POST') {
      if (!env.SESSION_SECRET) return json({ error: '請先設定 SESSION_SECRET。' }, 500)
      let body: { mode?: string; password?: string; name?: string }
      try { body = await request.json() as { mode?: string; password?: string; name?: string } }
      catch { return json({ error: '登入資料格式不正確。' }, 400) }
      if (body.mode === 'admin') {
        if (!env.APP_PASSWORD) return json({ error: '尚未設定管理者密碼 APP_PASSWORD。' }, 500)
        if (!await passwordMatches(String(body.password || ''), env.APP_PASSWORD)) return json({ error: '管理者密碼不正確。' }, 401)
        return json({ ok:true, role:'admin', name:'Kim' }, 200, { 'Set-Cookie': await makeSessionCookie(env, 'admin', 'Kim') })
      }
      if (body.mode === 'guest') {
        const name = cleanGuestName(body.name)
        if (!name) return json({ error: '請輸入姓名。' }, 400)
        if (name.length > 32) return json({ error: '姓名最多 32 個字元。' }, 400)
        return json({ ok:true, role:'guest', name }, 200, { 'Set-Cookie': await makeSessionCookie(env, 'guest', name) })
      }
      return json({ error: '請選擇管理者或朋友登入方式。' }, 400)
    }
    if (parts[0] === 'auth' && parts[1] === 'logout' && method === 'POST') return json({ ok:true }, 200, { 'Set-Cookie': clearSessionCookie() })

    if (parts[0] === 'health' && method === 'GET') {
      await env.DB.prepare('SELECT 1').first()
      return json({ ok:true, database:'ok', storage:'bound' })
    }
    if (parts[0] === 'scores' && parts.length === 1 && method === 'GET') {
      const result = await env.DB.prepare('SELECT * FROM scores ORDER BY favorite DESC, title COLLATE NOCASE ASC').all()
      return json((result.results||[]).map(fromRow))
    }
    if (parts[0] === 'scores' && parts[1] === 'bulk' && method === 'PUT') {
      const scores = await request.json() as Score[]
      if (!Array.isArray(scores) || scores.length > 5000) return json({ error:'曲庫格式不正確或曲目過多。' }, 400)
      const unique = new Map<string,Score>()
      for (const item of scores) unique.set(item.id, item)
      for (const score of unique.values()) await upsertScore(env.DB, score)
      return json({ ok:true, saved:unique.size })
    }
    if (parts[0] === 'scores' && parts.length === 1 && method === 'POST') {
      const score = await request.json() as Score
      await upsertScore(env.DB, score)
      return json({ ok:true, id:score.id }, 201)
    }
    if (parts[0] === 'scores' && parts[1] && parts.length === 2 && method === 'PUT') {
      const score = { ...(await request.json() as Score), id:parts[1] }
      await upsertScore(env.DB, score)
      return json({ ok:true })
    }
    if (parts[0] === 'scores' && parts[1] && parts.length === 2 && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM scores WHERE id=?').bind(parts[1]).run()
      return json({ ok:true })
    }

    if (parts[0] === 'files' && parts[1] && parts.length === 2 && method === 'PUT') {
      const body = await request.json() as { id?:string; name?:string; text?:string; mimeType?:string }
      if (typeof body.text !== 'string' || body.text.length > 80 * 1024 * 1024) return json({ error:'MusicXML 內容缺失或超過 80 MB。' }, 400)
      const id = parts[1]
      const name = String(body.name||`${id}.musicxml`).slice(0,255)
      const mime = String(body.mimeType||'application/vnd.recordare.musicxml+xml').slice(0,150)
      const objectKey = `scores/${id}.musicxml`
      const bytes = new TextEncoder().encode(body.text)
      await env.DATA.put(objectKey, bytes, { httpMetadata:{ contentType:mime, cacheControl:'private, no-cache' } })
      await env.DB.prepare(`INSERT INTO score_files(id,name,mime_type,object_key,size_bytes,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mime_type=excluded.mime_type,object_key=excluded.object_key,size_bytes=excluded.size_bytes`)
        .bind(id,name,mime,objectKey,bytes.byteLength,now()).run()
      return json({ ok:true, id, name, fileUrl:`/api/files/${encodeURIComponent(id)}` }, 201)
    }
    if (parts[0] === 'files' && parts[1] && parts.length === 2 && method === 'GET') {
      const meta = await env.DB.prepare('SELECT * FROM score_files WHERE id=?').bind(parts[1]).first<any>()
      if (!meta) return json({ error:'找不到曲譜檔案。' }, 404)
      const object = await env.DATA.get(meta.object_key)
      if (!object) return json({ error:'雲端曲譜物件不存在。' }, 404)
      if (url.searchParams.get('format') === 'json') {
        return json({ id:meta.id, name:meta.name, mimeType:meta.mime_type, text:await object.text() })
      }
      const headers = new Headers()
      object.writeHttpMetadata(headers)
      headers.set('ETag', object.httpEtag)
      headers.set('Cache-Control', 'private, no-cache')
      headers.set('X-Content-Type-Options','nosniff')
      return new Response(object.body, { headers })
    }
    if (parts[0] === 'files' && parts[1] && parts.length === 2 && method === 'DELETE') {
      const meta = await env.DB.prepare('SELECT object_key FROM score_files WHERE id=?').bind(parts[1]).first<{object_key:string}>()
      if (meta) await env.DATA.delete(meta.object_key)
      await env.DB.prepare('DELETE FROM score_files WHERE id=?').bind(parts[1]).run()
      return json({ ok:true })
    }

    if (parts[0] === 'state' && parts.length === 1 && method === 'GET') {
      const key = url.searchParams.get('key') || ''
      if (!key || key.length > 2048) return json({ error:'state key 缺失或過長。' }, 400)
      const session = await getSession(request, env)
      const storageKey = session?.role === 'guest' ? `guest:${encodeURIComponent(session.name.toLocaleLowerCase())}:${key}` : key
      const row = await env.DB.prepare('SELECT value_json FROM app_state WHERE state_key=?').bind(storageKey).first<{value_json:string}>()
      return json(row ? { found:true, value:JSON.parse(row.value_json) } : { found:false, value:null })
    }
    if (parts[0] === 'state' && parts.length === 1 && method === 'PUT') {
      const key = url.searchParams.get('key') || ''
      if (!key || key.length > 2048) return json({ error:'state key 缺失或過長。' }, 400)
      const session = await getSession(request, env)
      const storageKey = session?.role === 'guest' ? `guest:${encodeURIComponent(session.name.toLocaleLowerCase())}:${key}` : key
      const body = await request.json() as { value:unknown }
      const valueJson = JSON.stringify(body.value ?? null)
      if (valueJson.length > 500_000) return json({ error:'狀態資料不能超過 500 KB。' }, 413)
      await env.DB.prepare('INSERT INTO app_state(state_key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').bind(storageKey,valueJson,now()).run()
      return json({ ok:true })
    }
    return json({ error:'找不到 API 路由。' }, 404)
  } catch (error) {
    console.error('[慢半拍 cloud API]', error)
    return json({ error:error instanceof Error ? error.message : '雲端 API 發生錯誤。' }, 500)
  }
}
