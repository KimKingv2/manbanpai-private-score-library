import {useEffect, useState, Component, type ErrorInfo, type ReactNode} from 'react'
import ScoreLibrary from './ScoreLibrary'
import ScoreReader from './ScoreReader'
import CloudAuthGate, { useCloudSession } from './CloudAuthGate'
import PianoPdfMp3Test from './PianoPdfMp3Test'
import GuitarVocalPdfMp3Reader from './GuitarVocalPdfMp3Reader'
import FingerstylePdfMp3Test from './FingerstylePdfMp3Test'

type LibraryScoreType = 'piano' | 'guitar-vocal' | 'guitar-fingerstyle'
type ScoreSummary = {
  id: string
  title: string
  fileUrl: string
  type: LibraryScoreType
  pdfFileUrl?: string
  musicXmlUrl?: string
  midiFileUrl?: string
  mp3FileUrl?: string
  sourceFileName?: string
  pdfSourceFileName?: string
  midiSourceFileName?: string
  mp3SourceFileName?: string
}
type ScoreAssetInfo = { url:string; fileName:string; mimeType?:string; sizeBytes?:number; uploadedAt?:number }
type ScoreAssetsMap = Record<string, Partial<Record<'pdf'|'mp3'|'midi', ScoreAssetInfo>>>

function typeLabelForReader(type: LibraryScoreType): string {
  return type === 'piano' ? '鋼琴譜' : type === 'guitar-vocal' ? '吉他彈唱譜' : '吉他指彈譜'
}

class ReaderRenderErrorBoundary extends Component<
  { children: ReactNode; label: string; showDetails: boolean },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[慢半拍] ' + this.props.label + '閱讀器發生 React 錯誤', error, info.componentStack)
  }

  render() {
    const error = this.state.error
    if (!error) return this.props.children
    return <main style={{ minHeight: '100vh', boxSizing: 'border-box', padding: '64px 24px 28px', background: '#0b1017', color: '#edf2f8', fontFamily: 'system-ui,sans-serif' }}>
      <a href={window.location.pathname} style={{ position: 'fixed', zIndex: 20000, top: 10, left: 12, padding: '7px 10px', borderRadius: 8, background: 'rgba(11,16,23,.92)', border: '1px solid rgba(186,202,221,.22)', color: '#d9b779', textDecoration: 'none', font: '12px system-ui' }}>← 返回曲庫</a>
      <section style={{ maxWidth: 760, margin: '24px auto', padding: 24, border: '1px solid rgba(217,183,121,.26)', borderRadius: 16, background: '#111923' }}>
        <h1 style={{ margin: '0 0 10px', fontSize: 22 }}>{this.props.label}載入發生程式錯誤</h1>
        <p style={{ lineHeight: 1.8, color: '#b7c4d3' }}>已攔截閱讀器的渲染錯誤。請複製下方錯誤內容，以便精準修復。</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '55vh', overflow: 'auto', padding: 12, borderRadius: 8, background: '#070b10', color: '#ffd5a0', fontSize: 12 }}>{error.message}{this.props.showDetails && error.stack ? '\n\n' + error.stack : ''}</pre>
      </section>
    </main>
  }
}

function ReaderRoute({ scoreId, isAdmin, useLegacyVocalReader }: { scoreId:string; isAdmin:boolean; useLegacyVocalReader:boolean }) {
  const [score, setScore] = useState<ScoreSummary | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [scoreResponse, assetResponse] = await Promise.all([
          fetch('/api/scores', { credentials:'same-origin', cache:'no-store' }),
          fetch('/api/score-assets-map', { credentials:'same-origin', cache:'no-store' }).catch(() => null),
        ])
        if (!scoreResponse.ok) throw new Error(`無法讀取雲端曲庫（HTTP ${scoreResponse.status}）。`)
        const list = await scoreResponse.json() as ScoreSummary[]
        const match = list.find(item => item.id === scoreId)
        if (!match) throw new Error('找不到這份曲譜，可能已被管理者移除。')
        let assets: ScoreAssetsMap = {}
        if (assetResponse?.ok) {
          try { assets = await assetResponse.json() as ScoreAssetsMap } catch { assets = {} }
        }
        const itemAssets = assets[scoreId] ?? {}
        const next: ScoreSummary = {
          ...match,
          pdfFileUrl: itemAssets.pdf?.url || match.pdfFileUrl || '',
          pdfSourceFileName: itemAssets.pdf?.fileName || match.pdfSourceFileName || '',
          mp3FileUrl: itemAssets.mp3?.url || match.mp3FileUrl || '',
          mp3SourceFileName: itemAssets.mp3?.fileName || match.mp3SourceFileName || '',
          midiFileUrl: itemAssets.midi?.url || match.midiFileUrl || '',
          midiSourceFileName: itemAssets.midi?.fileName || match.midiSourceFileName || '',
        }
        if (!cancelled) setScore(next)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '讀取曲譜失敗。')
      }
    })()
    return () => { cancelled = true }
  }, [scoreId])

  if (error) return <main style={readerPageStyle}><p>{error}</p></main>
  if (!score) return <main style={readerPageStyle}>正在載入曲譜…</main>

  const xmlUrl = score.musicXmlUrl || score.fileUrl
  const pdfUrl = score.pdfFileUrl || ''
  const mp3Url = score.mp3FileUrl || ''
  const midiUrl = score.midiFileUrl || ''
  const missingRequiredAssets = [
    (!xmlUrl || xmlUrl === '/scores/' || xmlUrl === '/scores') && 'MusicXML',
    !pdfUrl && 'PDF',
    !mp3Url && 'MP3',
    !midiUrl && 'MIDI',
  ].filter(Boolean) as string[]

  if (missingRequiredAssets.length) {
    return <main style={readerPageStyle}>
      <section style={noticePanelStyle}>
        <h1 style={{ margin:'0 0 10px', fontSize:24 }}>{typeLabelForReader(score.type)}尚未備齊四件套</h1>
        <p style={{ lineHeight:1.8, color:'#b7c4d3' }}>三類曲譜都必須有 MusicXML、PDF、MP3、MIDI：PDF 顯示譜面，MP3 是實際播放音源，MIDI 用於時間對位，MusicXML 提供音符與小節結構。</p>
        <p style={{ color:'#f1d99b', fontWeight:700 }}>目前缺少：{missingRequiredAssets.join('、')}</p>
        <p style={{ lineHeight:1.8, color:'#8f9eae', fontSize:12 }}>{isAdmin ? '請在曲庫管理中編輯這份曲譜並補齊檔案後再開啟。' : '請聯絡管理員補齊檔案後再開啟。'}</p>
      </section>
    </main>
  }

  if (score.type === 'guitar-fingerstyle') return <ReaderRenderErrorBoundary label="吉他指彈譜" showDetails={isAdmin}><FingerstylePdfMp3Test isAdmin={isAdmin} pdfUrl={pdfUrl} xmlUrl={xmlUrl} midiUrl={midiUrl} mp3Url={mp3Url} /></ReaderRenderErrorBoundary>
  if (score.type === 'piano') return <ReaderRenderErrorBoundary label="鋼琴譜" showDetails={isAdmin}><PianoPdfMp3Test isAdmin={isAdmin} pdfUrl={pdfUrl} xmlUrl={xmlUrl} midiUrl={midiUrl} mp3Url={mp3Url} /></ReaderRenderErrorBoundary>
  if (useLegacyVocalReader) return <ScoreReader fileUrl={xmlUrl} scoreType="guitar-vocal" />
  return <GuitarVocalPdfMp3Reader isAdmin={isAdmin} pdfUrl={pdfUrl} xmlUrl={xmlUrl} midiUrl={midiUrl} mp3Url={mp3Url} />
}

const readerPageStyle: React.CSSProperties = { minHeight:'100vh', boxSizing:'border-box', padding:'24px 24px 28px', background:'#0b1017', color:'#edf2f8', fontFamily:'system-ui,sans-serif' }
const noticePanelStyle: React.CSSProperties = { maxWidth:640, margin:'24px auto', padding:24, border:'1px solid rgba(217,183,121,.26)', borderRadius:16, background:'#111923' }

function DemoRoute({ kind }: { kind:'piano'|'guitar-vocal'|'guitar-fingerstyle' }) {
  if (kind === 'piano') return <PianoPdfMp3Test isAdmin />
  if (kind === 'guitar-fingerstyle') return <FingerstylePdfMp3Test isAdmin pdfUrl="/fingerstyle-pdf-mp3-test/fingerstyle.pdf" xmlUrl="/fingerstyle-pdf-mp3-test/fingerstyle.musicxml" midiUrl="/fingerstyle-pdf-mp3-test/fingerstyle.mid" mp3Url="/fingerstyle-pdf-mp3-test/fingerstyle.mp3" />
  return <main style={readerPageStyle}><section style={noticePanelStyle}><h2>請從曲庫測試吉他彈唱譜</h2><p>此舊測試網址所需的單曲示範素材未包含在本補丁中。請先匯入完整的 MusicXML、PDF、MP3、MIDI 四件套，再從曲庫開啟曲目。</p></section></main>
}

function AppContent() {
  const { role } = useCloudSession()
  const isAdmin = role === 'admin'
  const params = new URLSearchParams(window.location.search)
  const scoreId = params.get('scoreRoomId')
  const useLegacyVocalReader = params.get('legacyVocalReader') === '1'
  const demo = params.get('pianoPdfMp3Demo') === '1' ? 'piano'
    : params.get('pdfMp3Demo') === '1' ? 'guitar-vocal'
    : params.get('fingerstyleDemo') === '1' ? 'guitar-fingerstyle'
    : null

  if (demo) {
    if (!isAdmin) return <main style={readerPageStyle}><h2>此測試入口僅供管理員使用</h2></main>
    return <DemoRoute kind={demo} />
  }
  return scoreId ? <ReaderRoute scoreId={scoreId} isAdmin={isAdmin} useLegacyVocalReader={useLegacyVocalReader} /> : <ScoreLibrary />
}

export default function App() {
  return <CloudAuthGate><AppContent /></CloudAuthGate>
}
