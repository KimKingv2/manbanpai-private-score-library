import { useEffect, useState } from 'react'
import FingerstylePdfMp3Test from './FingerstylePdfMp3Test'

type AuthCheckPayload = {
  authenticated?: boolean
  isAdmin?: boolean
  is_admin?: boolean
  admin?: boolean
  role?: string
  userRole?: string
  user_role?: string
  permissions?: string[]
  user?: { role?: string; isAdmin?: boolean; is_admin?: boolean }
  session?: { role?: string; isAdmin?: boolean; is_admin?: boolean; user?: { role?: string } }
}

function confirmsAdmin(value: AuthCheckPayload): boolean {
  if (value.isAdmin === true || value.is_admin === true || value.admin === true) return true
  const roles = [value.role, value.userRole, value.user_role, value.user?.role, value.session?.role, value.session?.user?.role]
  if (roles.some(role => typeof role === 'string' && role.toLowerCase() === 'admin')) return true
  if (value.user?.isAdmin === true || value.user?.is_admin === true || value.session?.isAdmin === true || value.session?.is_admin === true) return true
  return Array.isArray(value.permissions) && value.permissions.some(permission => String(permission).toLowerCase() === 'admin')
}

export default function FingerstyleDemoRoute() {
  const [state, setState] = useState<'checking' | 'allowed' | 'denied'>('checking')

  useEffect(() => {
    let cancelled = false
    void fetch('/api/auth/check', { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as AuthCheckPayload
      })
      .then(payload => {
        if (!cancelled) setState(payload.authenticated && confirmsAdmin(payload) ? 'allowed' : 'denied')
      })
      .catch(() => { if (!cancelled) setState('denied') })
    return () => { cancelled = true }
  }, [])

  if (state === 'checking') return <main style={{ minHeight: '100vh', padding: 28, background: '#0b1017', color: '#edf2f8', fontFamily: 'system-ui,sans-serif' }}>正在確認管理員權限…</main>
  if (state === 'denied') return <main style={{ minHeight: '100vh', padding: 28, background: '#0b1017', color: '#edf2f8', fontFamily: 'system-ui,sans-serif' }}><h2>吉他指彈測試入口</h2><p>未能從 /api/auth/check 確認管理員身分。請以管理員登入，並確認回應包含 role: "admin" 或 isAdmin: true。</p><a href={window.location.pathname} style={{ color: '#d9b779' }}>← 返回曲庫</a></main>

  return <>
    <a href={window.location.pathname} style={{ position: 'fixed', zIndex: 20000, top: 10, left: 12, padding: '7px 10px', borderRadius: 8, background: 'rgba(11,16,23,.9)', border: '1px solid rgba(186,202,221,.22)', color: '#d9b779', textDecoration: 'none', font: '12px system-ui' }}>← 返回曲庫</a>
    <FingerstylePdfMp3Test
      isAdmin
      pdfUrl="/fingerstyle-pdf-mp3-test/fingerstyle.pdf"
      xmlUrl="/fingerstyle-pdf-mp3-test/fingerstyle.musicxml"
      midiUrl="/fingerstyle-pdf-mp3-test/fingerstyle.mid"
      mp3Url="/fingerstyle-pdf-mp3-test/fingerstyle.mp3"
    />
  </>
}
