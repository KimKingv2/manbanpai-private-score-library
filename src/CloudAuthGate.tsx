import { createContext, useContext, useEffect, useState, type ReactNode, type FormEvent } from 'react'

export type CloudRole = 'admin' | 'guest'
export type CloudSessionInfo = { role: CloudRole; name: string }
type CloudAuthContextValue = CloudSessionInfo & { logout: () => Promise<void> }
const CloudAuthContext = createContext<CloudAuthContextValue | null>(null)
export function useCloudSession(): CloudAuthContextValue {
  const value = useContext(CloudAuthContext)
  if (!value) throw new Error('useCloudSession 必須在 CloudAuthGate 內使用。')
  return value
}
type Props = { children: ReactNode }
type AuthStatus = 'checking' | 'signed-out' | 'signed-in'

/** Read an API response without hiding empty/non-JSON server replies behind a JSON.parse error. */
async function readJsonResponse<T>(response: Response, endpoint: string): Promise<T> {
  const raw = await response.text()
  if (!raw.trim()) {
    throw new Error(`${endpoint} 回應內容為空（HTTP ${response.status}）。請確認目前網站已部署 Pages Functions，且 /api 路由存在。`)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    const contentType = response.headers.get('content-type') || '未提供'
    const preview = raw.trim().replace(/\s+/g, ' ').slice(0, 140)
    throw new Error(`${endpoint} 回應不是有效 JSON（HTTP ${response.status}；Content-Type：${contentType}）。回應片段：${preview}`)
  }
}

export default function CloudAuthGate({ children }: Props) {
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [session, setSession] = useState<CloudSessionInfo | null>(null)
  const [mode, setMode] = useState<'guest' | 'admin'>('guest')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function checkSession() {
    try {
      const response = await fetch('/api/auth/check', { credentials: 'same-origin', cache: 'no-store' })
      const data = await readJsonResponse<{ authenticated?: boolean; role?: CloudRole | null; name?: string | null; error?: string }>(response, 'GET /api/auth/check')
      if (!response.ok) throw new Error(data.error || `登入狀態檢查失敗（HTTP ${response.status}）。`)
      if (data.authenticated && (data.role === 'admin' || data.role === 'guest') && data.name) {
        setSession({ role: data.role, name: data.name })
        setStatus('signed-in')
      } else {
        setSession(null)
        setStatus('signed-out')
      }
    } catch (error) {
      setStatus('signed-out')
      setError(error instanceof Error ? error.message : '無法連線至雲端服務，請確認 Pages Functions 與 D1／R2 綁定已部署。')
    }
  }
  useEffect(() => { void checkSession() }, [])

  async function login(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const body = mode === 'admin' ? { mode, password } : { mode, name }
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await readJsonResponse<{ error?: string; role?: CloudRole; name?: string }>(response, 'POST /api/auth/login')
      if (!response.ok) throw new Error(data.error || `登入失敗（HTTP ${response.status}）。`)
      if (!data.role || !data.name) throw new Error('登入回應不完整，請重新嘗試。')
      setSession({ role: data.role, name: data.name })
      setPassword('')
      setStatus('signed-in')
    } catch (error) {
      setError(error instanceof Error ? error.message : '登入失敗。')
    } finally { setBusy(false) }
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }) } finally {
      setSession(null); setStatus('signed-out'); setMode('guest'); setPassword(''); setError('')
    }
  }

  if (status === 'checking') return <main style={baseStyle}><section style={panelStyle}>正在連線至慢半拍系列雲端…</section></main>
  if (status === 'signed-out') return <main style={baseStyle}><form onSubmit={login} style={panelStyle}>
    <div style={{ fontSize: 26, letterSpacing: 1.2, color: '#f3f5f8', fontWeight: 760 }}>慢半拍譜間</div>
    <div style={{ marginTop: 7, color: '#d9b779', fontSize: 14, fontWeight: 700, letterSpacing: 1.1 }}>KIM Scoreroom</div>
    <p style={{ margin: '6px 0 22px', color: '#a6b2c1', fontSize: 12 }}>私人雲端樂譜庫 · 鋼琴 · 吉他彈唱 · 吉他指彈</p>
    <div style={modeWrapStyle} role="group" aria-label="選擇登入方式">
      <button type="button" onClick={() => { setMode('guest'); setError('') }} aria-pressed={mode === 'guest'} style={modeButtonStyle(mode === 'guest')}>朋友登入</button>
      <button type="button" onClick={() => { setMode('admin'); setError('') }} aria-pressed={mode === 'admin'} style={modeButtonStyle(mode === 'admin')}>Kim 管理者登入</button>
    </div>
    {mode === 'guest' ? <>
      <label htmlFor="scorecloud-name" style={labelStyle}>姓名</label>
      <input id="scorecloud-name" type="text" autoComplete="name" maxLength={32} value={name} onChange={e => setName(e.target.value)} required placeholder="請輸入你的姓名" style={inputStyle} />
      <p style={{ color: '#a6b2c1', fontSize: 12, lineHeight: 1.7, margin: '10px 0 0' }}>歡迎來到慢半拍譜間。<br /><br />
這裡收藏著Kim喜愛的樂譜，也留著一些想與你们分享的旋律。願在忙碌的日子裡，我们都能偶爾放慢腳步，翻開一頁樂譜，彈一段喜歡的旋律，找回屬於自己的節奏。<br /><br />
願常有音樂相伴。<br />：）</p>
    </> : <>
      <label htmlFor="scorecloud-password" style={labelStyle}>管理者密碼</label>
      <input id="scorecloud-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required style={inputStyle} />
      <p style={{ color: '#a6b2c1', fontSize: 12, lineHeight: 1.7, margin: '10px 0 0' }}>只有通過管理者密碼驗證的工作階段，才能管理雲端曲庫。</p>
    </>}
    {error && <p role="alert" style={{ color: '#ffb4a9', lineHeight: 1.6 }}>{error}</p>}
    <button disabled={busy} style={buttonStyle}>{busy ? '正在登入…' : mode === 'admin' ? '登入管理模式' : '🎶別敲門了，自己人！'}</button>
  </form></main>
  if (!session) return null
  return <CloudAuthContext.Provider value={{ ...session, logout }}>{children}</CloudAuthContext.Provider>
}

const baseStyle: React.CSSProperties = { minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#0b1017', color: '#edf2f8', padding: 20, fontFamily: 'Inter, system-ui, sans-serif' }
const panelStyle: React.CSSProperties = { width: 'min(100%, 420px)', boxSizing: 'border-box', background: '#111923', border: '1px solid rgba(186,202,221,.18)', borderRadius: 18, padding: 28 }
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#0b1017', border: '1px solid #384859', color: '#fff', padding: '12px 14px', borderRadius: 10, fontSize: 16 }
const buttonStyle: React.CSSProperties = { marginTop: 18, width: '100%', border: 0, borderRadius: 10, padding: '12px 16px', background: '#d9b779', color: '#15110a', fontWeight: 700, cursor: 'pointer' }
const labelStyle: React.CSSProperties = { display: 'block', margin: '18px 0 6px', fontSize: 13, fontWeight: 700 }
const modeWrapStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 4, borderRadius: 11, background: '#0b1017', border: '1px solid #273545' }
const modeButtonStyle = (active: boolean): React.CSSProperties => ({ border: active ? '1px solid #d9b779' : '1px solid transparent', borderRadius: 8, padding: '9px 7px', background: active ? '#443a27' : 'transparent', color: active ? '#f1d99b' : '#a6b2c1', fontWeight: 700, cursor: 'pointer', fontSize: 12 })
