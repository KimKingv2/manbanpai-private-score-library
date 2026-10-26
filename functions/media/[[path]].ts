import type { CloudEnv } from '../_lib/auth'
interface Env extends CloudEnv {}
export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status:405, headers:{Allow:'GET, HEAD'} })
  const rawPath = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '')
  const key = rawPath.split('/').map(segment => decodeURIComponent(segment)).join('/')
  if (!key.startsWith('audio/') || key.includes('..') || key.includes('\\')) return new Response('Bad path', { status:400 })
  try {
    const object = await env.DATA.get(key, request.headers.has('Range') ? { range: request.headers } : undefined)
    if (!object) return new Response('Audio asset not found', { status:404 })
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('ETag', object.httpEtag)
    headers.set('Accept-Ranges','bytes')
    headers.set('Cache-Control','private, max-age=31536000, immutable')
    headers.set('X-Content-Type-Options','nosniff')
    const range = (object as any).range
    let status = 200
    if (range && typeof range.offset === 'number' && typeof range.length === 'number') {
      status = 206
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`)
    }
    headers.set('Content-Length', String(range?.length ?? object.size))
    return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
  } catch (error) {
    console.error('[慢半拍 media]', key, error)
    return new Response('Audio service error', { status:500 })
  }
}
