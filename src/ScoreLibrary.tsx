import { useEffect, useMemo, useRef, useState } from 'react'
// Library-owned type union: adding fingerstyle does not require modifying ScoreReader.tsx.
type ScoreType = 'piano' | 'guitar-vocal' | 'guitar-fingerstyle'
import { getCanonicalMusicXmlData } from './musicDataModel'
import { useCloudSession } from './CloudAuthGate'
import { ManbanpaiThemeToggle } from './ManbanpaiTheme'

type ScoreRecord = {
  id: string
  title: string
  artist?: string
  coverUrl?: string
  /** Optional catalog metadata; left blank unless the user has verified it. */
  keySignature?: string
  timeSignature?: string
  tempoBpm?: string
  measureCount?: string
  fileUrl: string
  type: ScoreType
  category: string
  favorite: boolean
  updatedAt: number
  /** Original filename when the MusicXML is stored in this browser's IndexedDB. */
  sourceFileName?: string
  pdfFileUrl?: string
  pdfSourceFileName?: string
  mp3FileUrl?: string
  mp3SourceFileName?: string
  midiFileUrl?: string
  midiSourceFileName?: string
}

type ScoreDraft = Omit<ScoreRecord, 'id' | 'updatedAt'>
type AssetKind = 'pdf' | 'mp3' | 'midi'
type StoredAssetInfo = { url: string; fileName: string; mimeType?: string; sizeBytes?: number; uploadedAt?: number }
type ScoreAssetsMap = Record<string, Partial<Record<AssetKind, StoredAssetInfo>>>
type TypeFilter = 'all' | ScoreType

const STORAGE_KEY = 'scoreroom.library.v1' // Legacy key used only for one-time cloud migration
const SCORE_FILE_DB = 'scoreroom.score-files.v1' // Legacy IndexedDB used only for one-time cloud migration
const SCORE_FILE_STORE = 'files'
const LEGACY_SCORE_FILE_PREFIX = 'scoredb://'
const SCORE_FILE_PREFIX = '/api/files/'
const CLOUD_MIGRATION_KEY = 'scoreroom.cloud-migration.v1'

type StoredScoreFile = { id: string; name: string; text: string; mimeType?: string }
type XmlMetadata = { title: string; artist: string; keySignature: string; timeSignature: string; tempoBpm: string; measureCount: string; partNames: string[] }

type FriendNotice = {
  id: string
  name: string
  label: string
  title: string
  message: string
  delayMs: number
  enabled: boolean
}

function openScoreFileDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('此瀏覽器不支援 IndexedDB，無法儲存匯入的樂譜檔案。')); return }
    const request = window.indexedDB.open(SCORE_FILE_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SCORE_FILE_STORE)) db.createObjectStore(SCORE_FILE_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('無法開啟樂譜檔案資料庫。'))
  })
}

async function getLocalStoredScoreFile(id: string): Promise<StoredScoreFile | null> {
  const db = await openScoreFileDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SCORE_FILE_STORE, 'readonly')
      const request = tx.objectStore(SCORE_FILE_STORE).get(id)
      request.onsuccess = () => resolve((request.result as StoredScoreFile | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('讀取舊版本機 MusicXML 失敗。'))
    })
  } finally { db.close() }
}

async function putStoredScoreFile(file: StoredScoreFile): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file),
  })
  if (!response.ok) throw new Error(`上傳雲端 MusicXML 失敗（HTTP ${response.status}）。`)
}

async function getStoredScoreFile(id: string): Promise<StoredScoreFile | null> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}?format=json`, { credentials: 'same-origin' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`讀取雲端 MusicXML 失敗（HTTP ${response.status}）。`)
  return await response.json() as StoredScoreFile
}

async function deleteStoredScoreFile(id: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' })
  if (!response.ok && response.status !== 404) throw new Error(`刪除雲端 MusicXML 失敗（HTTP ${response.status}）。`)
}

async function saveScoresToCloud(scores: ScoreRecord[]): Promise<void> {
  const response = await fetch('/api/scores/bulk', {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scores),
  })
  if (!response.ok) throw new Error(`儲存雲端曲庫失敗（HTTP ${response.status}）。`)
}

function removeMusicXmlExtension(name: string): string {
  return name.replace(/\.(musicxml|xml)$/i, '').trim() || '未命名樂譜'
}

function keyLabelFromFifths(fifths: number, mode: 'major' | 'minor'): string {
  const major = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯']
  const minor = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯']
  const index = Math.max(0, Math.min(14, Math.round(fifths) + 7))
  return `${(mode === 'minor' ? minor : major)[index]} ${mode === 'minor' ? '小調' : '大調'}`
}

function parseMusicXmlMetadata(xmlText: string, fallbackTitle: string): XmlMetadata {
  const model = getCanonicalMusicXmlData(xmlText)
  const xmlDocument = new DOMParser().parseFromString(xmlText, 'application/xml')
  const creators = Array.from(xmlDocument.getElementsByTagName('*')).filter((element) => element.localName === 'creator')
  const artistElement = creators.find((element) => element.getAttribute('type') === 'composer') ??
    creators.find((element) => element.getAttribute('type') === 'arranger') ??
    creators.find((element) => element.getAttribute('type') === 'artist') ?? creators[0]
  const title = model.title && model.title !== '未命名樂譜' ? model.title.trim() : removeMusicXmlExtension(fallbackTitle)
  const keySignature = model.explicitKey ? keyLabelFromFifths(model.explicitKey.fifths, model.explicitKey.mode) : ''
  const meter = model.firstMeter
  const beatText = meter ? (meter.beatGroups.length > 1 ? meter.beatGroups.join('+') : String(meter.beats)) : ''
  const timeSignature = meter && beatText ? `${beatText}/${meter.beatType}` : ''
  const count = model.parts[0]?.measureCount || model.measures.length
  return {
    title: title || removeMusicXmlExtension(fallbackTitle),
    artist: model.composer?.trim() || artistElement?.textContent?.trim() || '',
    keySignature,
    timeSignature,
    tempoBpm: model.firstTempo && Number.isFinite(model.firstTempo) ? String(Math.round(model.firstTempo * 100) / 100) : '',
    measureCount: count > 0 ? String(count) : '',
    partNames: model.partNames ?? [],
  }
}

/**
 * A fingerstyle score must actually carry standard notation and TAB together in the
 * same MusicXML part. A lone guitar/TAB file is kept in the existing accompaniment
 * category by default; this avoids reclassifying the library's established guitar
 * songs as fingerstyle merely because their file name contains "guitar" or "TAB".
 */
function musicXmlHasPairedStandardAndTabStaff(xmlText: string): boolean {
  if (!xmlText.trim() || typeof DOMParser === 'undefined') return false
  try {
    const document = new DOMParser().parseFromString(xmlText, 'application/xml')
    if (document.getElementsByTagName('parsererror').length) return false
    const parts = Array.from(document.getElementsByTagName('*')).filter((element) => element.localName === 'part')
    return parts.some((part) => {
      const signs = Array.from(part.getElementsByTagName('*'))
        .filter((element) => element.localName === 'clef')
        .map((clef) => Array.from(clef.children).find((child) => child.localName === 'sign')?.textContent?.trim().toUpperCase() ?? '')
      return signs.includes('TAB') && signs.some((sign) => ['G', 'F', 'C'].includes(sign))
    })
  } catch {
    return false
  }
}

function guessScoreType(fileName: string, partNames: string[], xmlText = ''): ScoreType {
  const hint = `${fileName} ${partNames.join(' ')}`.toLocaleLowerCase()
  const hasTabClef = /<(?:[\w.-]+:)?sign>\s*tab\s*<\/(?:[\w.-]+:)?sign>/i.test(xmlText)
  const hasGuitarEvidence = /guitar|吉他|六線|六线|\btab\b|六線譜|六线谱/.test(hint) || hasTabClef
  const hasVocalOrAccompanimentCue = /vocal|voice|sing(?:er|ing)?|lyrics|歌唱|彈唱|弹唱|伴奏/.test(hint) || (hasGuitarEvidence && /<(?:[\w.-]+:)?lyric(?:s)?\b/i.test(xmlText))
  const hasFingerstyleCue = /finger[\s_-]*style|指彈|指弹|獨奏|独奏/.test(hint)

  // Explicit singing/accompaniment cues win, preserving the established guitar-vocal route.
  if (hasVocalOrAccompanimentCue && hasGuitarEvidence) return 'guitar-vocal'
  if (hasFingerstyleCue) return 'guitar-fingerstyle'
  if (musicXmlHasPairedStandardAndTabStaff(xmlText)) return 'guitar-fingerstyle'
  // Conservative fallback: existing guitar/TAB files remain accompaniment unless the
  // paired five-line + TAB structure or a deliberate fingerstyle label identifies them.
  if (hasGuitarEvidence) return 'guitar-vocal'
  return 'piano'
}

const SCORE_TYPES: Array<{ value: ScoreType; label: string; short: string }> = [
  { value: 'piano', label: '鋼琴譜', short: '鋼琴譜' },
  { value: 'guitar-vocal', label: '吉他彈唱譜', short: '吉他彈唱譜' },
  { value: 'guitar-fingerstyle', label: '吉他指彈譜（五線譜＋六線譜）', short: '吉他指彈譜' },
]

async function readXmlForScoreClassification(score: ScoreRecord): Promise<{ text: string; name: string } | null> {
  const fileUrl = (score.fileUrl ?? '').trim()
  if (!fileUrl || fileUrl === '/scores/') return null
  try {
    if (fileUrl.startsWith(SCORE_FILE_PREFIX)) {
      const stored = await getStoredScoreFile(fileUrl.slice(SCORE_FILE_PREFIX.length))
      return stored ? { text: stored.text, name: stored.name || score.sourceFileName || score.title } : null
    }
    if (fileUrl.startsWith(LEGACY_SCORE_FILE_PREFIX)) {
      const stored = await getLocalStoredScoreFile(fileUrl.slice(LEGACY_SCORE_FILE_PREFIX.length))
      return stored ? { text: stored.text, name: stored.name || score.sourceFileName || score.title } : null
    }
    const response = await fetch(fileUrl, { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    return { text: await response.text(), name: score.sourceFileName || fileUrl.split('/').pop()?.split('?')[0] || score.title }
  } catch {
    // Cross-origin or unavailable legacy files are left untouched for manual review.
    return null
  }
}

/** Content-based correction for scores auto-labelled by the old guitar heuristic. */
async function migrateLegacyGuitarCategories(scores: ScoreRecord[]): Promise<{ scores: ScoreRecord[]; changed: number; unavailable: number }> {
  const next = [...scores]
  const candidateIndexes = next.map((score, index) => ({ score, index }))
    .filter(({ score }) => score.type === 'guitar-fingerstyle' &&
      !/finger[\s_-]*style|指彈|指弹|獨奏|独奏/i.test(`${score.sourceFileName ?? ''} ${score.title}`))
  let cursor = 0
  let changed = 0
  let unavailable = 0
  const worker = async () => {
    while (cursor < candidateIndexes.length) {
      const candidate = candidateIndexes[cursor++]
      const source = await readXmlForScoreClassification(candidate.score)
      if (!source) { unavailable++; continue }
      try {
        const metadata = parseMusicXmlMetadata(source.text, source.name)
        const inferred = guessScoreType(source.name || candidate.score.title, metadata.partNames, source.text)
        if (inferred !== 'guitar-fingerstyle') {
          next[candidate.index] = {
            ...candidate.score,
            type: 'guitar-vocal',
            updatedAt: Date.now(),
          }
          changed++
        }
      } catch {
        unavailable++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidateIndexes.length) }, () => worker()))
  return { scores: next, changed, unavailable }
}

const EMPTY_DRAFT: ScoreDraft = {
  title: '',
  artist: '',
  coverUrl: '',
  keySignature: '',
  timeSignature: '',
  tempoBpm: '',
  measureCount: '',
  fileUrl: '/scores/',
  type: 'piano',
  category: '未分類',
  favorite: false,
  sourceFileName: '',
  pdfFileUrl: '',
  pdfSourceFileName: '',
  mp3FileUrl: '',
  mp3SourceFileName: '',
  midiFileUrl: '',
  midiSourceFileName: '',
}

function typeLabel(type: ScoreType): string {
  return SCORE_TYPES.find((item) => item.value === type)?.label ?? '未分類'
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `score-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function parseStoredScores(raw: string | null): ScoreRecord[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ScoreRecord => {
      return Boolean(
        item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.fileUrl === 'string' &&
        ['piano', 'guitar-vocal', 'guitar-fingerstyle'].includes(item.type) &&
        typeof item.category === 'string' &&
        typeof item.favorite === 'boolean',
      )
    })
  } catch {
    return []
  }
}

const ASSET_KIND_CONFIG: Record<AssetKind, { label:string; accept:string; maxBytes:number; urlField:'pdfFileUrl'|'mp3FileUrl'|'midiFileUrl'; nameField:'pdfSourceFileName'|'mp3SourceFileName'|'midiSourceFileName' }> = {
  pdf: { label:'PDF 樂譜', accept:'.pdf,application/pdf', maxBytes:50*1024*1024, urlField:'pdfFileUrl', nameField:'pdfSourceFileName' },
  mp3: { label:'MP3 音源', accept:'.mp3,audio/mpeg', maxBytes:100*1024*1024, urlField:'mp3FileUrl', nameField:'mp3SourceFileName' },
  midi: { label:'MIDI 節奏檔', accept:'.mid,.midi,audio/midi,audio/x-midi', maxBytes:10*1024*1024, urlField:'midiFileUrl', nameField:'midiSourceFileName' },
}

function mergeAssetMapIntoScores(scores: ScoreRecord[], assetMap: ScoreAssetsMap): ScoreRecord[] {
  return scores.map(score => {
    const attached = assetMap[score.id] ?? {}
    return {
      ...score,
      pdfFileUrl: attached.pdf?.url ?? score.pdfFileUrl ?? '',
      pdfSourceFileName: attached.pdf?.fileName ?? score.pdfSourceFileName ?? '',
      mp3FileUrl: attached.mp3?.url ?? score.mp3FileUrl ?? '',
      mp3SourceFileName: attached.mp3?.fileName ?? score.mp3SourceFileName ?? '',
      midiFileUrl: attached.midi?.url ?? score.midiFileUrl ?? '',
      midiSourceFileName: attached.midi?.fileName ?? score.midiSourceFileName ?? '',
    }
  })
}

function assetFieldsFromMap(scoreId: string, assetMap: ScoreAssetsMap): Pick<ScoreRecord, 'pdfFileUrl'|'pdfSourceFileName'|'mp3FileUrl'|'mp3SourceFileName'|'midiFileUrl'|'midiSourceFileName'> {
  const map = assetMap[scoreId] ?? {}
  return {
    pdfFileUrl: map.pdf?.url ?? '', pdfSourceFileName: map.pdf?.fileName ?? '',
    mp3FileUrl: map.mp3?.url ?? '', mp3SourceFileName: map.mp3?.fileName ?? '',
    midiFileUrl: map.midi?.url ?? '', midiSourceFileName: map.midi?.fileName ?? '',
  }
}

async function loadScoreAssetsMap(): Promise<ScoreAssetsMap> {
  try {
    const response = await fetch('/api/score-assets-map', { credentials:'same-origin', cache:'no-store' })
    if (!response.ok) return {}
    const data = await response.json() as ScoreAssetsMap
    return data && typeof data === 'object' ? data : {}
  } catch { return {} }
}

export default function ScoreLibrary() {
  const { role, name, logout } = useCloudSession()
  const isAdmin = role === 'admin'
  const [specialNotice, setSpecialNotice] = useState<FriendNotice | null>(null)
  const [noticeManagerOpen, setNoticeManagerOpen] = useState(false)
  const [friendNotices, setFriendNotices] = useState<FriendNotice[]>([])
  const [noticeManagerLoading, setNoticeManagerLoading] = useState(false)
  const [noticeManagerSaving, setNoticeManagerSaving] = useState(false)
  const [noticeManagerError, setNoticeManagerError] = useState('')
  const [noticeManagerStatus, setNoticeManagerStatus] = useState('')
  const [scores, setScores] = useState<ScoreRecord[]>([])
  const [scoreAssetsMap, setScoreAssetsMap] = useState<ScoreAssetsMap>({})
  const [pendingAssetFiles, setPendingAssetFiles] = useState<Partial<Record<AssetKind, File>>>({})
  const [draftRecordId, setDraftRecordId] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [cloudReadyToSync, setCloudReadyToSync] = useState(false)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [favoritesOnly, setFavoritesOnly] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ScoreDraft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState('')
  const [libraryOperationMessage, setLibraryOperationMessage] = useState('')
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [batchTypePickerOpen, setBatchTypePickerOpen] = useState(false)
  const [batchImportType, setBatchImportType] = useState<ScoreType>('piano')
  const batchFilesInputRef = useRef<HTMLInputElement | null>(null)
  const backupInputRef = useRef<HTMLInputElement | null>(null)
  const singleFileInputRef = useRef<HTMLInputElement | null>(null)
  const pdfFileInputRef = useRef<HTMLInputElement | null>(null)
  const mp3FileInputRef = useRef<HTMLInputElement | null>(null)
  const midiFileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const previousLang = root.lang
    root.lang = 'zh-TW'
    return () => {
      if (root.lang === 'zh-TW') root.lang = previousLang
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/scores', { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`雲端曲庫讀取失敗（HTTP ${response.status}）。`)
        const cloudScores = parseStoredScores(await response.text())
        const loadedAssets = await loadScoreAssetsMap()
        let finalScores = mergeAssetMapIntoScores([...cloudScores], loadedAssets)
        let migrationNotes: string[] = []
        if (role === 'admin' && window.localStorage.getItem(CLOUD_MIGRATION_KEY) !== 'done') {
          const localScores = parseStoredScores(window.localStorage.getItem(STORAGE_KEY))
          const seen = new Set(finalScores.map(score => `${score.title.trim().toLocaleLowerCase()}|${(score.artist||'').trim().toLocaleLowerCase()}|${score.type}`))
          const additions: ScoreRecord[] = []
          for (const score of localScores) {
            const dedupe = `${score.title.trim().toLocaleLowerCase()}|${(score.artist||'').trim().toLocaleLowerCase()}|${score.type}`
            if (seen.has(dedupe)) continue
            let fileUrl = score.fileUrl
            let sourceFileName = score.sourceFileName ?? ''
            if (fileUrl.startsWith(LEGACY_SCORE_FILE_PREFIX)) {
              const oldId = fileUrl.slice(LEGACY_SCORE_FILE_PREFIX.length)
              const localFile = await getLocalStoredScoreFile(oldId)
              if (!localFile) { migrationNotes.push(`「${score.title}」本機 MusicXML 副本不存在，未遷移`); continue }
              await putStoredScoreFile({ ...localFile, id: oldId })
              fileUrl = `${SCORE_FILE_PREFIX}${oldId}`
              sourceFileName = localFile.name
            } else if (!fileUrl.startsWith(SCORE_FILE_PREFIX) && fileUrl && fileUrl !== '/scores/') {
              // Best-effort copy of same-origin or CORS-readable external XML URLs to R2.
              try {
                const fileResponse = await fetch(fileUrl, { credentials: 'same-origin' })
                if (!fileResponse.ok) throw new Error(`HTTP ${fileResponse.status}`)
                const text = await fileResponse.text()
                if (!/<score-partwise|<score-timewise/i.test(text)) throw new Error('內容不是可讀取的 MusicXML')
                const newId = createId()
                const guessedName = sourceFileName || fileUrl.split('/').pop()?.split('?')[0] || `${score.title}.musicxml`
                await putStoredScoreFile({ id:newId, name:guessedName, text, mimeType:'application/vnd.recordare.musicxml+xml' })
                fileUrl = `${SCORE_FILE_PREFIX}${newId}`
                sourceFileName = guessedName
              } catch (error) {
                migrationNotes.push(`「${score.title}」的外部 URL 無法由瀏覽器讀取，請下載後重新匯入`)
              }
            }
            additions.push({ ...score, fileUrl, sourceFileName })
            seen.add(dedupe)
          }
          if (additions.length) {
            await saveScoresToCloud(additions)
            finalScores = [...finalScores, ...additions]
          }
          window.localStorage.setItem(CLOUD_MIGRATION_KEY, 'done')
          if (localScores.length) migrationNotes.unshift(`本機遷移完成：新增 ${additions.length} 筆至雲端；本機副本仍保留。`)
        }
        // Run type correction after one-time local-to-cloud migration as well, so legacy
        // guitar records copied in this session receive the same three-way classification.
        if (role === 'admin') {
          const categoryMigration = await migrateLegacyGuitarCategories(finalScores)
          finalScores = categoryMigration.scores
          if (categoryMigration.changed > 0) {
            migrationNotes.push(`已按 MusicXML 結構整理 ${categoryMigration.changed} 份舊版吉他曲譜：原有單一六線譜歸入「吉他彈唱譜」，同時含五線譜與六線 TAB 的曲譜保留為「吉他指彈譜」。`)
          }
          if (categoryMigration.unavailable > 0) {
            migrationNotes.push(`${categoryMigration.unavailable} 份舊曲譜無法讀取原始 MusicXML，類型未自動更改；可在管理員編輯中手動確認。`)
          }
        }
        if (!cancelled) {
          setScoreAssetsMap(loadedAssets)
          setScores(finalScores)
          setCloudReadyToSync(role === 'admin')
          if (migrationNotes.length) setLibraryOperationMessage(migrationNotes.join('；'))
        }
      } catch (error) {
        console.error('[慢半拍] Could not initialize cloud library:', error)
        if (!cancelled) setLibraryOperationMessage(error instanceof Error ? error.message : '無法載入雲端曲庫。')
      } finally {
        if (!cancelled) setHasLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [role])

  useEffect(() => {
    if (role !== 'admin' || !hasLoaded || !cloudReadyToSync) return
    void saveScoresToCloud(scores).catch(error => {
      console.error('[慢半拍] Could not save the cloud score library:', error)
      setLibraryOperationMessage(error instanceof Error ? error.message : '儲存雲端曲庫失敗。')
    })
  }, [scores, hasLoaded, cloudReadyToSync, role])


  // 專屬公告從 Cloudflare D1 載入；每位朋友的名字、內容和延遲均可由管理員介面設定。
  useEffect(() => {
    let cancelled = false
    let noticeTimer: number | undefined
    setSpecialNotice(null)
    const currentName = (name ?? '').trim()
    if (isAdmin || !currentName) return

    void (async () => {
      try {
        const response = await fetch(`/api/friend-notices?name=${encodeURIComponent(currentName)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response.ok) return
        const payload = await response.json() as { notice?: FriendNotice | null }
        const notice = payload.notice
        if (cancelled || !notice || !notice.enabled) return
        const delayMs = Math.max(0, Math.min(30000, Number(notice.delayMs) || 0))
        noticeTimer = window.setTimeout(() => {
          if (!cancelled) setSpecialNotice(notice)
        }, delayMs)
      } catch (error) {
        console.warn('[慢半拍] 無法讀取朋友專屬公告：', error)
      }
    })()

    return () => {
      cancelled = true
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    }
  }, [isAdmin, name])

  const visibleScores = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return scores
      .filter((score) => typeFilter === 'all' || score.type === typeFilter)
      .filter((score) => !favoritesOnly || score.favorite)
      .filter((score) => {
        if (!normalizedQuery) return true
        return [score.title, score.artist ?? '', score.category, score.fileUrl, score.pdfSourceFileName ?? '', score.mp3SourceFileName ?? '', score.midiSourceFileName ?? '', score.keySignature ?? '', score.timeSignature ?? '', score.tempoBpm ?? '', score.measureCount ?? '']
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title, 'zh-TW'))
  }, [scores, query, typeFilter, favoritesOnly])

  function openScoreInNewTab(score: ScoreRecord) {
    // The library remains a catalogue only. A separate app URL mounts the full reader.
    const target = new URL(window.location.href)
    target.searchParams.set('scoreRoomId', score.id)
    window.open(target.toString(), '_blank', 'noopener,noreferrer')
  }

  function openNewScore() {
    setEditingId(null)
    setDraftRecordId(createId())
    setPendingAssetFiles({})
    setDraft({ ...EMPTY_DRAFT })
    setFormError('')
    setEditorOpen(true)
  }

  function openEditScore(score: ScoreRecord) {
    setEditingId(score.id)
    setDraftRecordId(score.id)
    setPendingAssetFiles({})
    setDraft({
      title: score.title,
      artist: score.artist ?? '',
      coverUrl: score.coverUrl ?? '',
      keySignature: score.keySignature ?? '',
      timeSignature: score.timeSignature ?? '',
      tempoBpm: score.tempoBpm ?? '',
      measureCount: score.measureCount ?? '',
      fileUrl: score.fileUrl,
      type: score.type,
      category: score.category,
      favorite: score.favorite,
      sourceFileName: score.sourceFileName ?? '',
      pdfFileUrl: score.pdfFileUrl ?? '', pdfSourceFileName: score.pdfSourceFileName ?? '',
      mp3FileUrl: score.mp3FileUrl ?? '', mp3SourceFileName: score.mp3SourceFileName ?? '',
      midiFileUrl: score.midiFileUrl ?? '', midiSourceFileName: score.midiSourceFileName ?? '',
    })
    setFormError('')
    setEditorOpen(true)
  }

  function applyMetadataToDraft(metadata: XmlMetadata, fallbackOnly = true) {
    setDraft((current) => ({
      ...current,
      title: fallbackOnly && current.title.trim() ? current.title : metadata.title,
      artist: fallbackOnly && (current.artist ?? '').trim() ? current.artist : metadata.artist,
      keySignature: fallbackOnly && (current.keySignature ?? '').trim() ? current.keySignature : metadata.keySignature,
      timeSignature: fallbackOnly && (current.timeSignature ?? '').trim() ? current.timeSignature : metadata.timeSignature,
      tempoBpm: fallbackOnly && (current.tempoBpm ?? '').trim() ? current.tempoBpm : metadata.tempoBpm,
      measureCount: fallbackOnly && (current.measureCount ?? '').trim() ? current.measureCount : metadata.measureCount,
    }))
  }

  async function handleSingleMusicXmlFile(file: File | undefined) {
    if (!file) return
    setFormError('')
    try {
      if (!/\.(musicxml|xml)$/i.test(file.name)) throw new Error('目前請選擇未壓縮的 .musicxml 或 .xml 檔案；.mxl 壓縮格式暫不支援。')
      const text = await file.text()
      const metadata = parseMusicXmlMetadata(text, file.name)
      const id = createId()
      await putStoredScoreFile({ id, name: file.name, text, mimeType: file.type || 'application/vnd.recordare.musicxml+xml' })
      applyMetadataToDraft(metadata, true)
      const suggestedType = guessScoreType(file.name, metadata.partNames, text)
      setDraft((current) => ({
        ...current,
        fileUrl: `${SCORE_FILE_PREFIX}${id}`,
        sourceFileName: file.name,
        // Keep the administrator's explicit type selection; XML classification is only a hint.
      }))
      setFormError(`已讀取「${file.name}」的 MusicXML 資料。自動分析建議為「${typeLabel(suggestedType)}」，請以你手動選擇的譜型為準。`)
    } catch (error) {
      setFormError(error instanceof Error ? `讀取失敗：${error.message}` : '讀取 MusicXML 失敗。')
    }
  }

  async function readMetadataFromDraftUrl() {
    const url = draft.fileUrl.trim()
    if (!url) { setFormError('請先選擇 MusicXML 檔案或填入可存取的 URL。'); return }
    setFormError('正在讀取 MusicXML…')
    try {
      let text = ''
      let fallback = url.split('/').pop()?.split('?')[0] || '未命名樂譜'
      if (url.startsWith(SCORE_FILE_PREFIX)) {
        const stored = await getStoredScoreFile(url.slice(SCORE_FILE_PREFIX.length))
        if (!stored) throw new Error('找不到已匯入的本機檔案，請重新選擇 MusicXML。')
        text = stored.text
        fallback = stored.name
      } else {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`讀取失敗（HTTP ${response.status}），請檢查路徑、網路或跨域設定。`)
        text = await response.text()
      }
      const metadata = parseMusicXmlMetadata(text, fallback)
      applyMetadataToDraft(metadata, true)
      setFormError('已讀取 XML 資料。樂譜類型可依五線譜／六線 TAB 的實際編排，在下方手動選擇。')
    } catch (error) {
      setFormError(error instanceof Error ? `自動讀取失敗：${error.message}` : '自動讀取 MusicXML 資料失敗。')
    }
  }

  async function handleBatchImport(fileList: FileList | null, selectedType: ScoreType) {
    const files = Array.from(fileList ?? [])
    if (!files.length) return
    setLibraryBusy(true)
    setLibraryOperationMessage('正在檢查同名四件套並上傳雲端…')

    type Bundle = { baseName: string; xml?: File; pdf?: File; mp3?: File; midi?: File; duplicates: string[] }
    const bundles = new Map<string, Bundle>()
    const unsupported: string[] = []
    const extensionKind = (name: string): 'xml' | AssetKind | null => {
      if (/\.(musicxml|xml)$/i.test(name)) return 'xml'
      if (/\.pdf$/i.test(name)) return 'pdf'
      if (/\.mp3$/i.test(name)) return 'mp3'
      if (/\.(mid|midi)$/i.test(name)) return 'midi'
      return null
    }
    for (const file of files) {
      const kind = extensionKind(file.name)
      if (!kind) { unsupported.push(`${file.name}：不支援的檔案類型`); continue }
      const withoutExtension = file.name.replace(/\.(musicxml|xml|pdf|mp3|mid|midi)$/i, '').trim()
      const key = withoutExtension.toLocaleLowerCase()
      if (!key) { unsupported.push(`${file.name}：檔名沒有有效主體`); continue }
      const bundle = bundles.get(key) ?? { baseName: withoutExtension, duplicates: [] }
      if (bundle[kind]) bundle.duplicates.push(kind === 'xml' ? 'MusicXML' : ASSET_KIND_CONFIG[kind].label)
      else bundle[kind] = file
      bundles.set(key, bundle)
    }

    const imported: ScoreRecord[] = []
    const importedAssets: ScoreAssetsMap = {}
    const failed: string[] = [...unsupported]
    try {
      for (const bundle of bundles.values()) {
        const missing = [!bundle.xml && 'MusicXML', !bundle.pdf && 'PDF', !bundle.mp3 && 'MP3', !bundle.midi && 'MIDI'].filter(Boolean) as string[]
        if (bundle.duplicates.length) {
          failed.push(`${bundle.baseName}：同名分組出現重複檔案（${[...new Set(bundle.duplicates)].join('、')}）`)
          continue
        }
        if (missing.length) {
          failed.push(`${bundle.baseName}：缺少 ${missing.join('、')}，未匯入`)
          continue
        }

        const scoreId = createId()
        let xmlId = ''
        try {
          const xmlFile = bundle.xml!
          const xmlText = await xmlFile.text()
          if (!/<(?:[\w.-]+:)?score-(?:partwise|timewise)\b/i.test(xmlText)) throw new Error('檔案內容不是有效的 MusicXML')
          const metadata = parseMusicXmlMetadata(xmlText, xmlFile.name)
          xmlId = createId()
          await putStoredScoreFile({ id:xmlId, name:xmlFile.name, text:xmlText, mimeType:xmlFile.type || 'application/vnd.recordare.musicxml+xml' })

          const uploaded: Partial<Record<AssetKind, StoredAssetInfo>> = {}
          uploaded.pdf = await uploadScoreAsset(scoreId, 'pdf', bundle.pdf!)
          uploaded.mp3 = await uploadScoreAsset(scoreId, 'mp3', bundle.mp3!)
          uploaded.midi = await uploadScoreAsset(scoreId, 'midi', bundle.midi!)
          importedAssets[scoreId] = uploaded
          imported.push({
            id:scoreId,
            title:metadata.title || removeMusicXmlExtension(xmlFile.name),
            artist:metadata.artist,
            coverUrl:'',
            keySignature:metadata.keySignature,
            timeSignature:metadata.timeSignature,
            tempoBpm:metadata.tempoBpm,
            measureCount:metadata.measureCount,
            fileUrl:`${SCORE_FILE_PREFIX}${xmlId}`,
            sourceFileName:xmlFile.name,
            pdfFileUrl:uploaded.pdf!.url, pdfSourceFileName:uploaded.pdf!.fileName,
            mp3FileUrl:uploaded.mp3!.url, mp3SourceFileName:uploaded.mp3!.fileName,
            midiFileUrl:uploaded.midi!.url, midiSourceFileName:uploaded.midi!.fileName,
            type:selectedType,
            category:'未分類', favorite:false, updatedAt:Date.now(),
          })
        } catch (error) {
          if (xmlId) { try { await deleteStoredScoreFile(xmlId) } catch { /* cleanup best effort */ } }
          for (const kind of ['pdf','mp3','midi'] as const) {
            try { await fetch(`/api/score-assets/${encodeURIComponent(scoreId)}/${kind}`, { method:'DELETE', credentials:'same-origin' }) } catch { /* cleanup best effort */ }
          }
          failed.push(`${bundle.baseName}：${error instanceof Error ? error.message : '上傳失敗'}`)
        }
      }
      if (imported.length) {
        setScores(current => [...current, ...imported])
        setScoreAssetsMap(current => ({ ...current, ...importedAssets }))
      }
      const message = `「${typeLabel(selectedType)}」四件套批次匯入完成：成功 ${imported.length} 份，未匯入 ${failed.length} 組。${failed.length ? '\n' + failed.slice(0, 8).join('\n') + (failed.length > 8 ? `\n另有 ${failed.length - 8} 組未匯入。` : '') : ''}`
      setLibraryOperationMessage(message)
      if (failed.length) window.alert(message)
    } catch (error) {
      setLibraryOperationMessage(error instanceof Error ? `批次匯入失敗：${error.message}` : '批次匯入失敗。')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function exportLibraryBackup() {
    setLibraryBusy(true)
    setLibraryOperationMessage('正在從雲端整理曲庫與原始檔案…')
    try {
      const embeddedFiles: Record<string, { name: string; text: string; mimeType?: string }> = {}
      for (const score of scores) {
        const isCloudFile = score.fileUrl.startsWith(SCORE_FILE_PREFIX)
        const isLegacyFile = score.fileUrl.startsWith(LEGACY_SCORE_FILE_PREFIX)
        if (!isCloudFile && !isLegacyFile) continue
        const id = score.fileUrl.slice((isCloudFile ? SCORE_FILE_PREFIX : LEGACY_SCORE_FILE_PREFIX).length)
        const stored = isCloudFile ? await getStoredScoreFile(id) : await getLocalStoredScoreFile(id)
        if (stored) embeddedFiles[id] = { name: stored.name, text: stored.text, mimeType: stored.mimeType }
      }
      const payload = {
        format: 'ScoreRoomLibraryBackup',
        version: 1,
        exportedAt: new Date().toISOString(),
        scores,
        embeddedFiles,
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
      const downloadUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = `慢半拍系列-曲庫備份-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
      setLibraryOperationMessage(`備份已匯出：${scores.length} 筆曲目，內含 ${Object.keys(embeddedFiles).length} 份 MusicXML。PDF／MP3／MIDI 二進位附件不在 JSON 備份內。`)
    } catch (error) {
      setLibraryOperationMessage(error instanceof Error ? `匯出失敗：${error.message}` : '匯出曲庫備份失敗。')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function handleBackupImport(file: File | undefined) {
    if (!file) return
    setLibraryBusy(true)
    setLibraryOperationMessage('正在讀取曲庫備份…')
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const sourceScores: unknown = Array.isArray(parsed) ? parsed : (parsed as any)?.scores
      const embeddedFiles: Record<string, { name?: string; text?: string; mimeType?: string } | string> =
        !Array.isArray(parsed) && parsed && typeof parsed === 'object' && (parsed as any).embeddedFiles && typeof (parsed as any).embeddedFiles === 'object'
          ? (parsed as any).embeddedFiles : {}
      if (!Array.isArray(sourceScores)) throw new Error('檔案不是有效的曲庫 JSON 備份。')
      const replaceExisting = window.confirm('如何匯入這份備份？\n\n「確定」：用備份取代目前整個曲庫。\n「取消」：合併到目前曲庫，已有相同曲名、藝術家及類型的項目會略過。')
      const existing = replaceExisting ? [] : scores
      const seen = new Set(existing.map((score) => `${score.title.trim().toLocaleLowerCase()}|${(score.artist ?? '').trim().toLocaleLowerCase()}|${score.type}`))
      const imported: ScoreRecord[] = []
      let skipped = 0
      for (const raw of sourceScores) {
        if (!raw || typeof raw !== 'object') { skipped++; continue }
        const item = raw as any
        if (typeof item.title !== 'string' || typeof item.fileUrl !== 'string' || !['piano', 'guitar-vocal', 'guitar-fingerstyle'].includes(item.type)) { skipped++; continue }
        const hasCompleteBundle = Boolean(item.fileUrl.trim() && item.fileUrl !== '/scores/' && item.fileUrl !== '/scores' &&
          typeof item.pdfFileUrl === 'string' && item.pdfFileUrl.trim() &&
          typeof item.mp3FileUrl === 'string' && item.mp3FileUrl.trim() &&
          typeof item.midiFileUrl === 'string' && item.midiFileUrl.trim())
        if (!hasCompleteBundle) { skipped++; continue }
        // For this site's private R2 attachment URLs, verify that all three binary assets still exist.
        let currentSiteAssetsExist = true
        for (const assetUrl of [item.pdfFileUrl, item.mp3FileUrl, item.midiFileUrl]) {
          if (typeof assetUrl === 'string' && assetUrl.startsWith('/api/score-assets/')) {
            try {
              const assetHead = await fetch(assetUrl, { method:'HEAD', credentials:'same-origin', cache:'no-store' })
              if (!assetHead.ok) { currentSiteAssetsExist = false; break }
            } catch { currentSiteAssetsExist = false; break }
          }
        }
        if (!currentSiteAssetsExist) { skipped++; continue }
        const normalizedTitle = item.title.trim() || '未命名樂譜'
        const normalizedArtist = typeof item.artist === 'string' ? item.artist : ''
        const dedupeKey = `${normalizedTitle.toLocaleLowerCase()}|${normalizedArtist.trim().toLocaleLowerCase()}|${item.type}`
        if (!replaceExisting && seen.has(dedupeKey)) { skipped++; continue }
        seen.add(dedupeKey)
        const newRecordId = createId()
        let fileUrl = item.fileUrl
        let sourceFileName = typeof item.sourceFileName === 'string' ? item.sourceFileName : ''
        if (fileUrl.startsWith(SCORE_FILE_PREFIX) || fileUrl.startsWith(LEGACY_SCORE_FILE_PREFIX)) {
          const originalFileId = fileUrl.startsWith(SCORE_FILE_PREFIX) ? fileUrl.slice(SCORE_FILE_PREFIX.length) : fileUrl.slice(LEGACY_SCORE_FILE_PREFIX.length)
          const embedded = embeddedFiles[originalFileId]
          const embeddedText = typeof embedded === 'string' ? embedded : embedded?.text
          if (typeof embeddedText === 'string') {
            const newFileId = createId()
            const embeddedName = typeof embedded === 'string' ? sourceFileName : (embedded.name || sourceFileName || `${normalizedTitle}.musicxml`)
            await putStoredScoreFile({ id: newFileId, name: embeddedName, text: embeddedText, mimeType: typeof embedded === 'string' ? undefined : embedded.mimeType })
            fileUrl = `${SCORE_FILE_PREFIX}${newFileId}`
            sourceFileName = embeddedName
          } else {
            skipped++
            continue
          }
        }
        imported.push({
          id: newRecordId,
          title: normalizedTitle,
          artist: normalizedArtist,
          coverUrl: typeof item.coverUrl === 'string' ? item.coverUrl : '',
          keySignature: typeof item.keySignature === 'string' ? item.keySignature : '',
          timeSignature: typeof item.timeSignature === 'string' ? item.timeSignature : '',
          tempoBpm: typeof item.tempoBpm === 'string' ? item.tempoBpm : String(item.tempoBpm ?? ''),
          measureCount: typeof item.measureCount === 'string' ? item.measureCount : String(item.measureCount ?? ''),
          fileUrl,
          sourceFileName,
          // Four-file references are retained; legacy JSON backups without the three binary attachments are skipped.
          pdfFileUrl:typeof item.pdfFileUrl === 'string' ? item.pdfFileUrl : '',
          pdfSourceFileName:typeof item.pdfSourceFileName === 'string' ? item.pdfSourceFileName : '',
          mp3FileUrl:typeof item.mp3FileUrl === 'string' ? item.mp3FileUrl : '',
          mp3SourceFileName:typeof item.mp3SourceFileName === 'string' ? item.mp3SourceFileName : '',
          midiFileUrl:typeof item.midiFileUrl === 'string' ? item.midiFileUrl : '',
          midiSourceFileName:typeof item.midiSourceFileName === 'string' ? item.midiSourceFileName : '',
          type: item.type,
          category: typeof item.category === 'string' ? item.category : '未分類',
          favorite: Boolean(item.favorite),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        })
      }
      if (replaceExisting && imported.length === 0) {
        throw new Error('這份備份沒有可還原的完整四件套曲目；為避免誤刪，原曲庫未更動。請使用包含 MusicXML、PDF、MP3、MIDI 參照的新版備份，或改用四件套批次匯入。')
      }
      if (replaceExisting) {
        const retainedIds = new Set(imported.map(score => score.id))
        for (const previous of scores) {
          if (retainedIds.has(previous.id)) continue
          try { await fetch(`/api/scores/${encodeURIComponent(previous.id)}`, { method:'DELETE', credentials:'same-origin' }) } catch { /* the subsequent API sync remains visible if it fails */ }
          if (previous.fileUrl.startsWith(SCORE_FILE_PREFIX)) {
            try { await deleteStoredScoreFile(previous.fileUrl.slice(SCORE_FILE_PREFIX.length)) } catch { /* report through normal cloud API logging */ }
          }
        }
      }
      setScores([...existing, ...imported])
      setLibraryOperationMessage(`備份匯入完成：匯入 ${imported.length} 筆，略過 ${skipped} 筆。`)
    } catch (error) {
      setLibraryOperationMessage(error instanceof Error ? `備份匯入失敗：${error.message}` : '備份匯入失敗。')
    } finally {
      setLibraryBusy(false)
    }
  }

  async function uploadScoreAsset(scoreId: string, kind: AssetKind, file: File): Promise<StoredAssetInfo> {
    const response = await fetch(`/api/score-assets/${encodeURIComponent(scoreId)}/${kind}?name=${encodeURIComponent(file.name)}`, {
      method:'PUT', credentials:'same-origin', headers:{ 'Content-Type': file.type || (kind === 'pdf' ? 'application/pdf' : kind === 'mp3' ? 'audio/mpeg' : 'audio/midi') }, body:file,
    })
    const payload = await response.json().catch(() => ({})) as { error?:string; asset?:StoredAssetInfo }
    if (!response.ok || !payload.asset?.url) throw new Error(payload.error || `上傳${ASSET_KIND_CONFIG[kind].label}失敗（HTTP ${response.status}）。`)
    return payload.asset
  }

  async function handleAssetFile(kind: AssetKind, file: File | undefined) {
    if (!file) return
    const config = ASSET_KIND_CONFIG[kind]
    const valid = kind === 'pdf' ? /\.pdf$/i.test(file.name)
      : kind === 'mp3' ? /\.(mp3|mpga)$/i.test(file.name)
      : /\.(mid|midi)$/i.test(file.name)
    if (!valid) { setFormError(`${config.label}格式不正確，請重新選擇。`); return }
    if (file.size > config.maxBytes) { setFormError(`${config.label}超過大小限制（${Math.round(config.maxBytes/1024/1024)} MB）。`); return }
    setPendingAssetFiles(current => ({ ...current, [kind]:file }))
    setFormError(`已選擇「${file.name}」，按「儲存」後才會上傳並綁定到這份曲譜。`)
  }

  async function saveDraft() {
    const title = draft.title.trim()
    const artist = (draft.artist ?? '').trim()
    const coverUrl = (draft.coverUrl ?? '').trim()
    const keySignature = (draft.keySignature ?? '').trim()
    const timeSignature = (draft.timeSignature ?? '').trim()
    const tempoBpm = (draft.tempoBpm ?? '').trim()
    const measureCount = (draft.measureCount ?? '').trim()
    const fileUrl = draft.fileUrl.trim()
    const category = draft.category.trim() || '未分類'
    if (!title) { setFormError('請填寫樂譜名稱。'); return }

    const scoreId = editingId || draftRecordId || createId()
    const usableXmlUrl = Boolean(fileUrl && fileUrl !== '/scores/' && fileUrl !== '/scores')
    const currentAssets = scoreAssetsMap[scoreId] ?? {}
    const hasAsset = (kind: AssetKind) => {
      const config = ASSET_KIND_CONFIG[kind]
      return Boolean(pendingAssetFiles[kind] || currentAssets[kind]?.url || String((draft as any)[config.urlField] ?? '').trim())
    }
    const missingRequired = [
      !usableXmlUrl && 'MusicXML',
      !hasAsset('pdf') && 'PDF',
      !hasAsset('mp3') && 'MP3',
      !hasAsset('midi') && 'MIDI',
    ].filter(Boolean) as string[]
    if (missingRequired.length) {
      setFormError(`三類曲譜都必須具備完整四件套：MusicXML、PDF、MP3、MIDI。尚缺：${missingRequired.join('、')}。請補齊後再儲存。`)
      return
    }
    setLibraryBusy(true)
    setFormError('正在驗證 MusicXML 並儲存曲目與附件…')
    try {
      let xmlText = ''
      if (fileUrl.startsWith(SCORE_FILE_PREFIX)) {
        const storedXml = await getStoredScoreFile(fileUrl.slice(SCORE_FILE_PREFIX.length))
        xmlText = storedXml?.text ?? ''
      } else if (fileUrl.startsWith(LEGACY_SCORE_FILE_PREFIX)) {
        const storedXml = await getLocalStoredScoreFile(fileUrl.slice(LEGACY_SCORE_FILE_PREFIX.length))
        xmlText = storedXml?.text ?? ''
      } else {
        const xmlResponse = await fetch(fileUrl, { credentials:'same-origin', cache:'no-store' })
        if (!xmlResponse.ok) throw new Error(`MusicXML 讀取失敗（HTTP ${xmlResponse.status}）。請重新選擇本機 MusicXML。`)
        xmlText = await xmlResponse.text()
      }
      if (!/<(?:[\w.-]+:)?score-(?:partwise|timewise)\b/i.test(xmlText)) {
        throw new Error('MusicXML 無法讀取或內容格式不正確。請重新選擇有效的 .musicxml / .xml 檔案。')
      }
      const nextAssets: Partial<Record<AssetKind, StoredAssetInfo>> = { ...(scoreAssetsMap[scoreId] ?? {}) }
      for (const kind of ['pdf','mp3','midi'] as const) {
        const file = pendingAssetFiles[kind]
        if (file) nextAssets[kind] = await uploadScoreAsset(scoreId, kind, file)
      }
      const nextAssetMap: ScoreAssetsMap = { ...scoreAssetsMap, [scoreId]:nextAssets }
      const assetFields = assetFieldsFromMap(scoreId, nextAssetMap)
      // Keep an existing URL if an asset was linked by URL rather than uploaded through this form.
      for (const kind of ['pdf','mp3','midi'] as const) {
        const config = ASSET_KIND_CONFIG[kind]
        const urlField = config.urlField
        const nameField = config.nameField
        if (!nextAssets[kind] && draft[urlField]) {
          ;(assetFields as any)[urlField] = draft[urlField]
          ;(assetFields as any)[nameField] = (draft as any)[nameField] || ''
        }
      }
      const created: ScoreRecord = {
        id:scoreId, ...draft, title, artist, coverUrl, keySignature, timeSignature, tempoBpm, measureCount,
        fileUrl, sourceFileName:draft.sourceFileName ?? '', category, updatedAt:Date.now(), ...assetFields,
      }
      setScoreAssetsMap(nextAssetMap)
      setScores(current => editingId ? current.map(score => score.id === scoreId ? created : score) : [...current, created])
      setPendingAssetFiles({})
      setEditorOpen(false)
      setFormError('')
      setLibraryOperationMessage(`已儲存「${title}」的完整四件套（MusicXML、PDF、MP3、MIDI）。`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '儲存曲目或附件失敗。')
    } finally { setLibraryBusy(false) }
  }

  function toggleFavorite(scoreId: string) {
    setScores((current) => current.map((score) => score.id === scoreId
      ? { ...score, favorite: !score.favorite, updatedAt: Date.now() }
      : score))
  }

  async function deleteScore(score: ScoreRecord) {
    if (!isAdmin || libraryBusy) return
    const confirmed = window.confirm(`確定要永久刪除「${score.title}」嗎？\n這會從雲端曲庫移除曲目，並嘗試刪除 MusicXML、PDF、MP3、MIDI 附件。此操作無法復原。`)
    if (!confirmed) return

    setLibraryBusy(true)
    setLibraryOperationMessage(`正在刪除「${score.title}」及其雲端附件…`)
    try {
      const deleteResponse = await fetch(`/api/scores/${encodeURIComponent(score.id)}`, {
        method: 'DELETE', credentials: 'same-origin',
      })
      if (!deleteResponse.ok) {
        const payload = await deleteResponse.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error || `曲目刪除 API 回應 HTTP ${deleteResponse.status}。`)
      }

      const cleanupTasks: Promise<unknown>[] = []
      if (score.fileUrl.startsWith(SCORE_FILE_PREFIX)) {
        cleanupTasks.push(deleteStoredScoreFile(score.fileUrl.slice(SCORE_FILE_PREFIX.length)))
      } else if (score.fileUrl.startsWith(LEGACY_SCORE_FILE_PREFIX)) {
        const localId = score.fileUrl.slice(LEGACY_SCORE_FILE_PREFIX.length)
        cleanupTasks.push((async () => {
          const db = await openScoreFileDb()
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(SCORE_FILE_STORE, 'readwrite')
              tx.objectStore(SCORE_FILE_STORE).delete(localId)
              tx.oncomplete = () => resolve()
              tx.onerror = () => reject(tx.error ?? new Error('清理舊版 MusicXML 失敗。'))
              tx.onabort = () => reject(tx.error ?? new Error('清理舊版 MusicXML 已取消。'))
            })
          } finally { db.close() }
        })())
      }
      for (const kind of ['pdf', 'mp3', 'midi'] as const) {
        cleanupTasks.push((async () => {
          const response = await fetch(`/api/score-assets/${encodeURIComponent(score.id)}/${kind}`, {
            method: 'DELETE', credentials: 'same-origin',
          })
          if (!response.ok && response.status !== 404) {
            const payload = await response.json().catch(() => ({})) as { error?: string }
            throw new Error(payload.error || `刪除 ${kind.toUpperCase()} 失敗（HTTP ${response.status}）。`)
          }
        })())
      }
      const cleanupResults = await Promise.allSettled(cleanupTasks)
      const cleanupFailures = cleanupResults.filter(result => result.status === 'rejected')
      const remaining = scores.filter(item => item.id !== score.id)
      // The DELETE endpoint removes the cloud record; the library's existing sync effect
      // then writes the updated catalogue without changing unrelated reader logic.
      setScores(remaining)
      setScoreAssetsMap(current => { const next = { ...current }; delete next[score.id]; return next })
      setLibraryOperationMessage(cleanupFailures.length
        ? `已從曲庫刪除「${score.title}」，但有 ${cleanupFailures.length} 項附件清理未完成。請查看開發者工具的網路錯誤，再確認 R2。`
        : `已成功刪除「${score.title}」及其曲譜附件。`)
      if (cleanupFailures.length) {
        console.warn('[慢半拍] Some score assets could not be cleaned up:', cleanupResults.filter(result => result.status === 'rejected'))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '刪除曲目失敗。'
      setLibraryOperationMessage(`刪除失敗：${message}`)
      window.alert(`刪除失敗，曲目已保留在目前清單中。\n${message}`)
    } finally {
      setLibraryBusy(false)
    }
  }

  async function openNoticeManager() {
    setNoticeManagerOpen(true)
    setNoticeManagerLoading(true)
    setNoticeManagerError('')
    setNoticeManagerStatus('')
    try {
      const response = await fetch('/api/friend-notices?manage=1', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { notices?: FriendNotice[]; error?: string }
      if (!response.ok) throw new Error(payload.error || `讀取公告設定失敗（HTTP ${response.status}）。`)
      setFriendNotices(Array.isArray(payload.notices) ? payload.notices : [])
    } catch (error) {
      setNoticeManagerError(error instanceof Error ? error.message : '讀取公告設定失敗。')
    } finally {
      setNoticeManagerLoading(false)
    }
  }

  function updateFriendNotice(id: string, patch: Partial<FriendNotice>) {
    setFriendNotices(current => current.map(notice => notice.id === id ? { ...notice, ...patch } : notice))
    setNoticeManagerStatus('')
  }

  function addFriendNotice() {
    setFriendNotices(current => [...current, {
      id: createId(),
      name: '',
      label: 'A LITTLE NOTE FROM KIM',
      title: '給你的一則小紙條',
      message: '',
      delayMs: 1000,
      enabled: true,
    }])
    setNoticeManagerError('')
    setNoticeManagerStatus('')
  }

  function removeFriendNotice(id: string) {
    setFriendNotices(current => current.filter(notice => notice.id !== id))
    setNoticeManagerStatus('')
  }

  async function saveFriendNoticeSettings() {
    setNoticeManagerSaving(true)
    setNoticeManagerError('')
    setNoticeManagerStatus('')
    try {
      const response = await fetch('/api/friend-notices', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notices: friendNotices }),
      })
      const payload = await response.json().catch(() => ({})) as { notices?: FriendNotice[]; error?: string }
      if (!response.ok) throw new Error(payload.error || `儲存公告設定失敗（HTTP ${response.status}）。`)
      setFriendNotices(Array.isArray(payload.notices) ? payload.notices : friendNotices)
      setNoticeManagerStatus('已儲存至 Cloudflare。這些設定會套用於之後的登入，不需要重新部署網站。')
    } catch (error) {
      setNoticeManagerError(error instanceof Error ? error.message : '儲存公告設定失敗。')
    } finally {
      setNoticeManagerSaving(false)
    }
  }

  return (
    <main className="score-library-page" lang="zh-TW">
      <style>{`
        .score-library-page {
          --sl-bg: #0b1017;
          --sl-panel: #111923;
          --sl-panel-2: #151f2b;
          --sl-panel-hover: #1a2735;
          --sl-line: rgba(186, 202, 221, .13);
          --sl-line-strong: rgba(186, 202, 221, .22);
          --sl-text: #edf2f8;
          --sl-muted: #8e9cad;
          --sl-muted-2: #667689;
          --sl-gold: #d9b779;
          --sl-gold-dark: #927443;
          color: var(--sl-text);
          min-height: 100vh;
          background:
            radial-gradient(ellipse at 12% -10%, rgba(46, 77, 108, .30), transparent 38%),
            radial-gradient(ellipse at 100% 0%, rgba(128, 96, 48, .10), transparent 30%),
            var(--sl-bg);
          padding: clamp(16px, 2.4vw, 34px);
          box-sizing: border-box;
          font-family: "Noto Sans TC", "Microsoft JhengHei", "PingFang TC", "Heiti TC", Inter, ui-sans-serif, system-ui, sans-serif;
          font-feature-settings: "locl" 1;
          color-scheme: dark;
        }
        .score-library-shell { max-width: 1660px; margin: 0 auto; }
        .score-library-header { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:22px; padding: 4px 2px 20px; border-bottom:1px solid var(--sl-line); }
        .score-library-title { margin:0; font-size:clamp(24px, 2.2vw, 31px); line-height:1.15; font-weight:760; letter-spacing:-.8px; color:#f3f5f8; display:flex; align-items:center; gap:12px; }
        .score-library-title::before { content:""; display:block; width:42px; height:42px; flex:0 0 42px; background:url('/logo-note.svg') center / contain no-repeat; filter:drop-shadow(0 3px 10px rgba(217,183,121,.16)); }
        .score-library-kim { margin:7px 0 0; color:var(--sl-gold); font-size:13px; font-weight:700; letter-spacing:1.1px; }
        .score-library-subtitle { color:var(--sl-muted); margin:5px 0 0; font-size:12px; letter-spacing:.1px; }
        .score-library-button { border:1px solid var(--sl-line-strong); background:linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); border-radius:10px; padding:10px 14px; color:#dbe4ef; font:inherit; font-size:12px; font-weight:650; cursor:pointer; transition:transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease; white-space:nowrap; }
        .score-library-button:hover { border-color:rgba(217,183,121,.65); background:rgba(217,183,121,.09); color:#fff5df; transform:translateY(-1px); }
        .score-library-button:active { transform:translateY(0); }
        .score-library-header-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; }
        .score-library-status { margin:0 15px 10px; padding:9px 11px; white-space:pre-wrap; border:1px solid rgba(217,183,121,.17); border-radius:9px; background:rgba(217,183,121,.045); color:#c6b58f; font-size:11px; line-height:1.65; }
        .score-library-file-row { display:flex; gap:8px; align-items:stretch; }
        .score-library-file-row .score-library-input { flex:1; min-width:0; }
        .score-library-file-status { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1px solid rgba(217,183,121,.23); border-radius:10px; background:rgba(217,183,121,.055); color:#ddc796; font-size:11px; }
        .score-library-file-status span { min-width:0; overflow-wrap:anywhere; }
        .score-library-button-primary { background:linear-gradient(135deg, #d9bd87, #b38d4e); color:#161a20; border-color:#d9bd87; box-shadow:0 5px 20px rgba(175,134,69,.18); }
        .score-library-button-primary:hover { color:#10151c; background:linear-gradient(135deg, #e8d2a6, #c5a163); border-color:#e8d2a6; box-shadow:0 7px 24px rgba(175,134,69,.25); }
        .score-library-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:20px; align-items:start; }
        .score-library-panel { background:linear-gradient(155deg, rgba(22,32,44,.98), rgba(15,23,33,.98)); border:1px solid var(--sl-line); border-radius:16px; overflow:hidden; box-shadow:0 16px 42px rgba(0,0,0,.15); }
        .score-library-controls { padding:15px; border-bottom:1px solid var(--sl-line); display:grid; gap:12px; background:rgba(255,255,255,.012); }
        .score-library-input,.score-library-select { width:100%; box-sizing:border-box; border:1px solid var(--sl-line-strong); border-radius:10px; padding:11px 12px; color:#edf2f8; background:#0d141d; font:inherit; font-size:12px; outline:none; transition:border-color .16s ease, box-shadow .16s ease, background .16s ease; }
        .score-library-input::placeholder { color:#66778a; }
        .score-library-input:focus,.score-library-select:focus { border-color:rgba(217,183,121,.72); box-shadow:0 0 0 3px rgba(217,183,121,.10); background:#101923; }
        .score-library-select option { background:#111923; color:#edf2f8; }
        .score-library-filters { display:flex; gap:7px; flex-wrap:wrap; }
        .score-library-chip { border:1px solid var(--sl-line); padding:7px 10px; border-radius:999px; background:rgba(255,255,255,.025); font:inherit; font-size:11px; font-weight:600; cursor:pointer; color:#a9b6c6; transition:all .16s ease; }
        .score-library-chip:hover { border-color:rgba(217,183,121,.42); color:#f0dfbf; background:rgba(217,183,121,.055); }
        .score-library-chip.active { background:rgba(217,183,121,.13); border-color:rgba(217,183,121,.48); color:#f0d7a5; box-shadow:inset 0 0 0 1px rgba(217,183,121,.045); }
        .score-library-list { display:flex; flex-direction:column; max-height:calc(100vh - 270px); min-height:170px; overflow:auto; padding:5px 10px 10px; scrollbar-width:thin; scrollbar-color:#354454 transparent; }
        .score-library-item { position:relative; width:100%; box-sizing:border-box; text-align:left; border:1px solid transparent; border-bottom-color:rgba(186,202,221,.075); background:transparent; padding:12px 10px; display:flex; align-items:center; gap:14px; cursor:pointer; color:inherit; transition:background .16s ease, border-color .16s ease, transform .16s ease; border-radius:12px; }
        .score-library-item:hover { background:rgba(255,255,255,.035); border-color:rgba(186,202,221,.10); }
        .score-library-cover { position:relative; display:flex; align-items:center; justify-content:center; width:86px; height:86px; flex:0 0 86px; overflow:hidden; border-radius:11px; border:1px solid rgba(217,183,121,.25); background:linear-gradient(145deg,#283a4e,#172330 62%,#413522); box-shadow:0 5px 16px rgba(0,0,0,.22), inset 0 0 0 1px rgba(255,255,255,.025); }
        .score-library-cover-art { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; overflow:hidden; background:radial-gradient(circle at 76% 15%,rgba(217,183,121,.24),transparent 31%),linear-gradient(150deg,#263a50,#121c28 70%); }
        .score-library-cover-art::before { content:""; position:absolute; width:66px; height:66px; border:1px solid rgba(217,183,121,.2); border-radius:50%; transform:translate(25px,-25px); }
        .score-library-cover-art::after { content:""; position:absolute; width:74px; height:74px; border:1px solid rgba(217,183,121,.1); border-radius:50%; transform:translate(-27px,30px); }
        .score-library-cover-glyph { position:relative; z-index:1; font-family:Georgia,serif; font-size:38px; font-weight:400; line-height:1; color:#dfc28b; text-shadow:0 2px 10px rgba(0,0,0,.4); }
        .score-library-cover-label { position:relative; z-index:1; font-size:8px; font-weight:750; letter-spacing:1.1px; color:rgba(235,218,184,.78); text-transform:uppercase; }
        .score-library-cover-art-guitar { background:radial-gradient(circle at 28% 72%,rgba(178,133,78,.25),transparent 32%),linear-gradient(145deg,#24362f,#101d1c 68%,#443523); }
        .score-library-cover-art-guitar .score-library-cover-glyph { color:#d8bd91; }
        .score-library-cover-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
        .score-library-item-copy { min-width:0; flex:1; align-self:center; }
        .score-library-open-indicator { font-size:10px; color:var(--sl-gold); white-space:nowrap; align-self:center; padding:4px 6px; border:1px solid rgba(217,183,121,.22); border-radius:7px; }
        .score-library-item-copy { min-width:0; flex:1; }
        .score-library-item-title { font-size:13px; font-weight:680; line-height:1.5; overflow-wrap:anywhere; color:#e7edf5; }
        .score-library-item.active .score-library-item-title { color:#fff1d3; }
        .score-library-item-artist { margin-top:3px; color:#aab7c7; font-size:11px; line-height:1.45; overflow-wrap:anywhere; }
        .score-library-item-meta { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:8px; font-size:10px; color:var(--sl-muted); line-height:1.5; }
        .score-library-meta-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 7px; border:1px solid rgba(186,202,221,.12); border-radius:999px; background:rgba(255,255,255,.025); color:#aebaca; }
        .score-library-meta-chip-type { border-color:rgba(217,183,121,.24); background:rgba(217,183,121,.07); color:#d7c092; }
        .score-library-meta-chip-music { border-color:rgba(129,166,195,.2); background:rgba(129,166,195,.055); color:#b4c7d8; }
        .score-library-field-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 12px; }
        .score-library-attachment-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
        .score-library-attachment { min-width:0; padding:10px; border:1px solid var(--sl-line); border-radius:11px; background:rgba(255,255,255,.018); display:grid; gap:8px; align-content:start; }
        .score-library-attachment-head { display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:11px; font-weight:700; color:#d8e1eb; }
        .score-library-attachment-state { color:#8795a6; font-size:10px; font-weight:600; white-space:nowrap; }
        .score-library-attachment-state.attached { color:#a7d4b0; }
        .score-library-field-grid .score-library-field { min-width:0; }
        .score-library-item-actions { display:flex; align-items:center; gap:7px; flex-shrink:0; align-self:center; }
        .score-library-edit { border:1px solid rgba(186,202,221,.12); border-radius:7px; padding:4px 7px; color:#8e9cad; background:rgba(255,255,255,.02); font:inherit; font-size:10px; cursor:pointer; white-space:nowrap; }
        .score-library-edit:hover { border-color:rgba(217,183,121,.45); color:#f0d7a5; background:rgba(217,183,121,.06); }
        .score-library-delete { border:1px solid rgba(235,123,123,.24); border-radius:7px; padding:4px 7px; color:#e79a9a; background:rgba(235,123,123,.035); font:inherit; font-size:10px; cursor:pointer; white-space:nowrap; }
        .score-library-delete:hover { border-color:rgba(255,125,125,.65); color:#ffd0d0; background:rgba(235,90,90,.12); }
        .score-library-delete:disabled { opacity:.45; cursor:not-allowed; }
        .score-library-star { border:0; background:transparent; color:#718195; padding:0 3px; cursor:pointer; font-size:17px; flex-shrink:0; transition:color .15s ease, transform .15s ease; }
        .score-library-star:hover { color:var(--sl-gold); transform:scale(1.1); }
        .score-library-reader-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:18px 20px; background:linear-gradient(145deg, #151f2b, #101720); border:1px solid var(--sl-line); border-radius:16px; margin-bottom:13px; box-shadow:0 12px 32px rgba(0,0,0,.12); }
        .score-library-reader-title { margin:0; font-size:19px; line-height:1.35; font-weight:740; letter-spacing:-.3px; color:#f3f5f8; overflow-wrap:anywhere; }
        .score-library-reader-meta { margin-top:7px; font-size:11px; line-height:1.7; color:var(--sl-muted); overflow-wrap:anywhere; }
        .score-library-empty { text-align:center; color:var(--sl-muted); padding:38px 22px; font-size:12px; line-height:1.9; }
        .score-library-empty strong { display:block; color:#e6edf5; font-size:15px; font-weight:700; margin-bottom:7px; }
        .score-library-modal-backdrop { position:fixed; inset:0; z-index:1000; background:rgba(2,5,9,.76); backdrop-filter:blur(9px); display:flex; justify-content:center; align-items:center; padding:18px; }
        .score-library-modal { background:linear-gradient(150deg, #172230, #101720); color:var(--sl-text); border:1px solid var(--sl-line-strong); border-radius:18px; padding:24px; width:min(540px,100%); box-sizing:border-box; box-shadow:0 28px 90px rgba(0,0,0,.48); }
        .score-library-modal h2 { margin:0 0 7px; font-size:20px; letter-spacing:-.35px; }
        .score-library-modal p { margin:0 0 20px; color:var(--sl-muted); font-size:12px; line-height:1.75; }
        .score-library-field { display:grid; gap:7px; margin-bottom:15px; }
        .score-library-field label { font-size:11px; font-weight:700; letter-spacing:.15px; color:#cbd5e1; }
        .score-library-checkbox { display:flex; align-items:center; gap:9px; font-size:12px; color:#cbd5e1; margin:8px 0 15px; }
        .score-library-checkbox input { accent-color:#d9b779; }
        .score-library-error { color:#ff9f98; font-size:12px; margin:-3px 0 12px; }
        .score-library-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
        .score-library-special-notice { position:fixed; top:18px; right:18px; z-index:1200; width:min(360px, calc(100vw - 36px)); box-sizing:border-box; padding:15px 16px 16px; border:1px solid rgba(217,183,121,.38); border-radius:14px; color:var(--sl-text); background:linear-gradient(150deg, rgba(27,39,53,.97), rgba(15,23,33,.97)); box-shadow:0 18px 48px rgba(0,0,0,.38), 0 0 0 1px rgba(255,255,255,.025) inset; backdrop-filter:blur(14px); animation:score-library-notice-in .22s ease-out both; }
        .score-library-special-notice-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:8px; }
        .score-library-special-notice-title { margin:2px 0 0; color:#f0d7a5; font-size:14px; font-weight:750; line-height:1.5; letter-spacing:.1px; }
        .score-library-special-notice-label { display:block; color:#d9b779; font-size:9px; font-weight:750; letter-spacing:1.15px; margin-bottom:3px; }
        .score-library-special-notice-close { display:flex; flex:0 0 28px; align-items:center; justify-content:center; width:28px; height:28px; border:1px solid rgba(186,202,221,.17); border-radius:8px; background:rgba(255,255,255,.035); color:#b8c4d2; font:inherit; font-size:19px; line-height:1; cursor:pointer; transition:background .15s ease, border-color .15s ease, color .15s ease; }
        .score-library-special-notice-close:hover { border-color:rgba(217,183,121,.55); background:rgba(217,183,121,.09); color:#fff2d8; }
        .score-library-special-notice-body { margin:0; padding-right:7px; color:#c6d0dc; font-size:12px; line-height:1.8; overflow-wrap:anywhere; }
        @keyframes score-library-notice-in { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        @media (prefers-reduced-motion: reduce) { .score-library-special-notice { animation:none; } }
        .score-library-notice-manager-modal { width:min(760px,100%); max-height:86vh; overflow:auto; }
        .score-library-notice-manager-list { display:grid; gap:12px; max-height:55vh; overflow:auto; padding:2px 2px 8px; }
        .score-library-notice-editor { min-width:0; margin:0; padding:14px; border:1px solid var(--sl-line-strong); border-radius:12px; background:rgba(255,255,255,.018); }
        .score-library-notice-editor-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; color:#f0d7a5; font-size:12px; }
        .score-library-notice-editor-actions { display:flex; align-items:center; gap:10px; }
        .score-library-notice-manager-modal .score-library-field-grid { gap:0 12px; }
        .score-library-notice-manager-modal .score-library-modal-actions { flex-wrap:wrap; }
        .score-library-notice-manager-modal .score-library-status { margin:8px 0; }
        .score-library-special-notice { position:fixed; top:18px; right:18px; z-index:1200; width:min(360px, calc(100vw - 36px)); box-sizing:border-box; padding:15px 16px 16px; border:1px solid rgba(217,183,121,.38); border-radius:14px; color:var(--sl-text); background:linear-gradient(150deg, rgba(27,39,53,.97), rgba(15,23,33,.97)); box-shadow:0 18px 48px rgba(0,0,0,.38), 0 0 0 1px rgba(255,255,255,.025) inset; backdrop-filter:blur(14px); animation:score-library-notice-in .22s ease-out both; }
        .score-library-special-notice-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:8px; }
        .score-library-special-notice-title { margin:2px 0 0; color:#f0d7a5; font-size:14px; font-weight:750; line-height:1.5; letter-spacing:.1px; }
        .score-library-special-notice-label { display:block; color:#d9b779; font-size:9px; font-weight:750; letter-spacing:1.15px; margin-bottom:3px; }
        .score-library-special-notice-close { display:flex; flex:0 0 28px; align-items:center; justify-content:center; width:28px; height:28px; border:1px solid rgba(186,202,221,.17); border-radius:8px; background:rgba(255,255,255,.035); color:#b8c4d2; font:inherit; font-size:19px; line-height:1; cursor:pointer; transition:background .15s ease, border-color .15s ease, color .15s ease; }
        .score-library-special-notice-close:hover { border-color:rgba(217,183,121,.55); background:rgba(217,183,121,.09); color:#fff2d8; }
        .score-library-special-notice-body { margin:0; padding-right:7px; color:#c6d0dc; font-size:12px; line-height:1.8; overflow-wrap:anywhere; white-space:normal; }
        @keyframes score-library-notice-in { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        @media (prefers-reduced-motion: reduce) { .score-library-special-notice { animation:none; } }
        .score-library-path-hint { font-size:10px; color:#8493a4; line-height:1.7; }
        .score-library-page button:focus-visible { outline:2px solid var(--sl-gold); outline-offset:3px; }
        @media (max-width: 800px) { .score-library-page {padding:14px;} .score-library-header {align-items:flex-start;} .score-library-title {font-size:24px;} .score-library-title::before { width:36px; height:36px; flex-basis:36px; } .score-library-layout {grid-template-columns:minmax(0,1fr);} .score-library-list {max-height:calc(100vh - 240px); min-height:170px;} .score-library-reader-head {padding:15px;} }
        @media (max-width: 480px) { .score-library-header-actions { width:100%; justify-content:flex-start; } .score-library-header-actions .score-library-button { width:100%; } .score-library-file-row { flex-direction:column; } .score-library-field-grid,.score-library-attachment-grid { grid-template-columns:minmax(0,1fr); } .score-library-header {flex-direction:column;} .score-library-header .score-library-button {width:100%;} .score-library-reader-head {flex-direction:column;} .score-library-modal {padding:19px;} .score-library-item {gap:10px; padding:10px 6px;} .score-library-cover {width:66px;height:66px;flex-basis:66px;border-radius:9px;} .score-library-cover-glyph {font-size:30px;} .score-library-open-indicator {font-size:9px;padding:4px 5px;} .score-library-item-meta {margin-top:6px;} .score-library-special-notice { top:10px; right:10px; width:min(360px, calc(100vw - 20px)); padding:13px 13px 14px; } .score-library-notice-manager-modal { max-height:90vh; padding:16px; } .score-library-notice-manager-modal .score-library-field-grid { grid-template-columns:minmax(0,1fr); } .score-library-notice-editor { padding:10px; } }
      `}</style>

      <div className="score-library-shell">
        <header className="score-library-header">
          <div>
            <h1 className="score-library-title">慢半拍譜間</h1>
            <p className="score-library-kim">KIM Scoreroom</p>
            <p className="score-library-subtitle">私人雲端樂譜庫 · 鋼琴 · 吉他彈唱 · 吉他指彈</p>
          </div>
          <div className="score-library-header-actions">
            {isAdmin ? <>
              <button type="button" className="score-library-button" disabled={libraryBusy} onClick={() => setBatchTypePickerOpen(true)}>批次匯入四件套</button>
              <button type="button" className="score-library-button" disabled={libraryBusy} onClick={exportLibraryBackup}>匯出備份</button>
              <button type="button" className="score-library-button" disabled={libraryBusy} onClick={() => backupInputRef.current?.click()}>匯入備份</button>
              <button type="button" className="score-library-button" onClick={() => { void openNoticeManager() }}>朋友公告設定</button>
              <button type="button" className="score-library-button score-library-button-primary" onClick={openNewScore}>＋ 新增樂譜</button>
            </> : <span className="score-library-meta-chip">歡迎！{name}，從第一個音符開始，今天也慢慢來。</span>}
            <ManbanpaiThemeToggle />
            <button type="button" className="score-library-button" onClick={() => { void logout() }}>登出</button>
          </div>
        </header>
        <input ref={batchFilesInputRef} type="file" accept=".musicxml,.xml,.pdf,.mp3,.mid,.midi,application/xml,text/xml,application/pdf,audio/mpeg,audio/midi" multiple hidden onChange={(event) => { void handleBatchImport(event.currentTarget.files, batchImportType); event.currentTarget.value = '' }} />
        <input ref={backupInputRef} type="file" accept=".json,application/json" hidden onChange={(event) => { void handleBackupImport(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
        <input ref={singleFileInputRef} type="file" accept=".musicxml,.xml,application/xml,text/xml" hidden onChange={(event) => { void handleSingleMusicXmlFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
        <input ref={pdfFileInputRef} type="file" accept={ASSET_KIND_CONFIG.pdf.accept} hidden onChange={(event) => { void handleAssetFile('pdf', event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
        <input ref={mp3FileInputRef} type="file" accept={ASSET_KIND_CONFIG.mp3.accept} hidden onChange={(event) => { void handleAssetFile('mp3', event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
        <input ref={midiFileInputRef} type="file" accept={ASSET_KIND_CONFIG.midi.accept} hidden onChange={(event) => { void handleAssetFile('midi', event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />

        <div className="score-library-layout">
          <aside className="score-library-panel">
            <div className="score-library-controls">
              <input
                className="score-library-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜尋曲名、藝術家、調性、分類或檔案路徑…"
                aria-label="搜尋樂譜"
              />
              <div className="score-library-filters" aria-label="樂譜類型篩選">
                <button
                  type="button"
                  className={`score-library-chip ${typeFilter === 'all' && !favoritesOnly ? 'active' : ''}`}
                  aria-pressed={typeFilter === 'all' && !favoritesOnly}
                  onClick={() => {
                    setTypeFilter('all')
                    setFavoritesOnly(false)
                  }}
                >全部 {scores.length}</button>
                <button
                  type="button"
                  className={`score-library-chip ${favoritesOnly ? 'active' : ''}`}
                  aria-pressed={favoritesOnly}
                  onClick={() => {
                    setTypeFilter('all')
                    setFavoritesOnly(true)
                  }}
                >★ 收藏</button>
                {SCORE_TYPES.map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    className={`score-library-chip ${typeFilter === type.value && !favoritesOnly ? 'active' : ''}`}
                    aria-pressed={typeFilter === type.value && !favoritesOnly}
                    onClick={() => {
                      setTypeFilter(type.value)
                      setFavoritesOnly(false)
                    }}
                  >{type.short}</button>
                ))}
              </div>
            </div>
            {libraryOperationMessage && <div className="score-library-status" role="status">{libraryOperationMessage}</div>}

            {!hasLoaded ? (
              <div className="score-library-empty">正在讀取樂譜清單…</div>
            ) : visibleScores.length === 0 ? (
              <div className="score-library-empty">
                <strong>{scores.length === 0 ? '樂譜庫目前是空的' : '找不到符合條件的樂譜'}</strong>
                {scores.length === 0
                  ? '點選「新增樂譜」選擇 MusicXML、PDF、MP3、MIDI 四份檔案；也可批次選取四份檔案，系統會依相同主檔名配對。缺少任一檔案的曲目不會建立。'
                  : '請嘗試其他關鍵字或類型篩選。'}
              </div>
            ) : (
              <div className="score-library-list">
                {visibleScores.map((score) => (
                  <div
                    key={score.id}
                    className="score-library-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => openScoreInNewTab(score)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openScoreInNewTab(score)
                      }
                    }}
                  >
                    <div className="score-library-cover" aria-hidden="true">
                      <div className={`score-library-cover-art ${score.type !== 'piano' ? 'score-library-cover-art-guitar' : ''}`}>
                        <span className="score-library-cover-glyph">{score.type === 'piano' ? '𝄞' : '♪'}</span>
                        <span className="score-library-cover-label">{score.type === 'piano' ? 'PIANO SCORE' : score.type === 'guitar-vocal' ? 'GUITAR VOCAL' : 'FINGERSTYLE'}</span>
                      </div>
                      {score.coverUrl?.trim() && (
                        <img
                          className="score-library-cover-img"
                          src={score.coverUrl}
                          alt=""
                          loading="lazy"
                          onError={(event) => { event.currentTarget.style.display = 'none' }}
                        />
                      )}
                    </div>
                    <div className="score-library-item-copy">
                      <div className="score-library-item-title">{score.title}</div>
                      <div className="score-library-item-artist">{score.artist?.trim() || '藝術家尚未填寫'}</div>
                      <div className="score-library-item-meta">
                        <span className="score-library-meta-chip score-library-meta-chip-type">{typeLabel(score.type)}</span>
                        <span className="score-library-meta-chip">{score.category || '未分類'}</span>
                        {score.keySignature?.trim() && <span className="score-library-meta-chip score-library-meta-chip-music">調性 · {score.keySignature.trim()}</span>}
                        {score.timeSignature?.trim() && <span className="score-library-meta-chip score-library-meta-chip-music">拍號 · {score.timeSignature.trim()}</span>}
                        {score.tempoBpm?.trim() && <span className="score-library-meta-chip score-library-meta-chip-music">♩ {score.tempoBpm.trim()} BPM</span>}
                        {score.measureCount?.trim() && <span className="score-library-meta-chip score-library-meta-chip-music">{score.measureCount.trim()} 小節</span>}
                        {(score.fileUrl.toLocaleLowerCase().includes('musicxml') || /\.(musicxml|xml)$/i.test(score.sourceFileName ?? '')) && <span className="score-library-meta-chip">MusicXML</span>}
                        {score.pdfFileUrl && <span className="score-library-meta-chip">PDF</span>}
                        {score.mp3FileUrl && <span className="score-library-meta-chip">MP3</span>}
                        {score.midiFileUrl && <span className="score-library-meta-chip">MIDI</span>}
                        {(!score.fileUrl || score.fileUrl === '/scores/' || score.fileUrl === '/scores' || !score.pdfFileUrl || !score.mp3FileUrl || !score.midiFileUrl) && <span className="score-library-meta-chip" title="此曲目尚未具備完整四件套，請管理員編輯補齊">素材未齊</span>}
                      </div>
                    </div>
                    <div className="score-library-item-actions">
                      {isAdmin && <>
                      <button
                        type="button"
                        className="score-library-edit"
                        title={`編輯 ${score.title} 的資訊`}
                        aria-label={`編輯 ${score.title} 的資訊`}
                        onClick={(event) => {
                          event.stopPropagation()
                          openEditScore(score)
                        }}
                      >編輯</button>
                      <button
                        type="button"
                        className="score-library-delete"
                        title={`刪除 ${score.title}`}
                        aria-label={`刪除 ${score.title}`}
                        disabled={libraryBusy}
                        onClick={(event) => {
                          event.stopPropagation()
                          void deleteScore(score)
                        }}
                      >刪除</button>
                      <button
                        type="button"
                        className="score-library-star"
                        title={score.favorite ? '取消收藏' : '收藏'}
                        aria-label={score.favorite ? `取消收藏 ${score.title}` : `收藏 ${score.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleFavorite(score.id)
                        }}
                      >{score.favorite ? '★' : '☆'}</button>
                      </>}
                      <span className="score-library-open-indicator">開啟 ↗</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>

        </div>
      </div>

      {editorOpen && (
        <div className="score-library-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setEditorOpen(false)
        }}>
          <section className="score-library-modal" role="dialog" aria-modal="true" aria-labelledby="score-editor-title">
            <h2 id="score-editor-title">{editingId ? '編輯樂譜資訊' : '新增樂譜'}</h2>
            <p>所有類型的曲譜都必須備齊四份檔案：MusicXML 提供音符與小節結構、PDF 顯示譜面、MP3 是實際播放音源、MIDI 用於時間對位。缺少任何一份都不能儲存。</p>

            <div className="score-library-field">
              <label htmlFor="score-type">樂譜類型</label>
              <select id="score-type" className="score-library-select" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as ScoreType }))}>
                {SCORE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
              <span className="score-library-path-hint">三類彼此獨立。舊有單一吉他六線譜預設歸「吉他彈唱譜」；同一聲部同時包含一般五線譜與六線 TAB 時，系統會優先辨識為「吉他指彈譜」。匯入後可在此手動調整。</span>
            </div>

            <div className="score-library-field">
              <label htmlFor="score-title">樂譜名稱</label>
              <input id="score-title" className="score-library-input" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="例如：小幸運" autoFocus />
            </div>
            <div className="score-library-field">
              <label htmlFor="score-artist">藝術家 / 編曲者</label>
              <input id="score-artist" className="score-library-input" value={draft.artist ?? ''} onChange={(event) => setDraft((current) => ({ ...current, artist: event.target.value }))} placeholder="例如：周杰倫、久石讓、自己改編" />
            </div>
            <div className="score-library-field-grid">
              <div className="score-library-field">
                <label htmlFor="score-key-signature">調性（選填）</label>
                <input id="score-key-signature" className="score-library-input" value={draft.keySignature ?? ''} onChange={(event) => setDraft((current) => ({ ...current, keySignature: event.target.value }))} placeholder="例如：C 大調、A 小調、G♭ 大調" />
              </div>
              <div className="score-library-field">
                <label htmlFor="score-time-signature">拍號（選填）</label>
                <input id="score-time-signature" className="score-library-input" value={draft.timeSignature ?? ''} onChange={(event) => setDraft((current) => ({ ...current, timeSignature: event.target.value }))} placeholder="例如：4/4、3/4、6/8" />
              </div>
              <div className="score-library-field">
                <label htmlFor="score-tempo-bpm">速度 BPM（選填）</label>
                <input id="score-tempo-bpm" type="number" min="1" max="400" className="score-library-input" value={draft.tempoBpm ?? ''} onChange={(event) => setDraft((current) => ({ ...current, tempoBpm: event.target.value }))} placeholder="例如：92" />
              </div>
              <div className="score-library-field">
                <label htmlFor="score-measure-count">小節數（選填）</label>
                <input id="score-measure-count" type="number" min="1" className="score-library-input" value={draft.measureCount ?? ''} onChange={(event) => setDraft((current) => ({ ...current, measureCount: event.target.value }))} placeholder="例如：64" />
              </div>
            </div>
            <div className="score-library-field">
              <label htmlFor="score-cover-url">封面圖片路徑 / URL（選填）</label>
              <input id="score-cover-url" className="score-library-input" value={draft.coverUrl ?? ''} onChange={(event) => setDraft((current) => ({ ...current, coverUrl: event.target.value }))} placeholder="例如：/covers/小幸運.jpg 或圖片網址" />
              <span className="score-library-path-hint">留白時會使用內建的深色音樂封面。封面可填入圖片 URL；若希望圖片也完全存放於自己的雲端，後續整合時再遷移至 R2。建議使用正方形圖片。</span>
            </div>
            <div className="score-library-field">
              <label>MusicXML 檔案（必填）</label>
              <button type="button" className="score-library-button" style={{ justifySelf: 'start' }} onClick={() => singleFileInputRef.current?.click()}>{draft.fileUrl.startsWith(SCORE_FILE_PREFIX) ? '更換 MusicXML 檔案（上傳到雲端）' : '選擇 MusicXML 檔案（上傳到雲端）'}</button>
              {draft.fileUrl.startsWith(SCORE_FILE_PREFIX) ? (
                <div className="score-library-file-status">
                  <span>已附加：{draft.sourceFileName || 'MusicXML 檔案'}（儲存於雲端）</span>
                  <button type="button" className="score-library-edit" onClick={() => setDraft((current) => ({ ...current, fileUrl: '/scores/', sourceFileName: '' }))}>改用 URL</button>
                </div>
              ) : (
                <>
                  <div className="score-library-file-row">
                    <input id="score-file-url" className="score-library-input" value={draft.fileUrl} onChange={(event) => setDraft((current) => ({ ...current, fileUrl: event.target.value, sourceFileName: '' }))} placeholder="/scores/小幸運.musicxml 或完整 URL" />
                    <button type="button" className="score-library-button" onClick={() => void readMetadataFromDraftUrl()}>自動讀取資料</button>
                  </div>
                  <span className="score-library-path-hint">可選擇本機 .musicxml / .xml 檔案，或填入瀏覽器可存取的檔案 URL。暫不支援壓縮的 .mxl。</span>
                </>
              )}
            </div>
            <div className="score-library-field">
              <label>同步／伴隨檔案（從電腦選擇）</label>
              <div className="score-library-attachment-grid">
                {(['pdf','mp3','midi'] as const).map(kind => {
                  const config = ASSET_KIND_CONFIG[kind]
                  const selected = pendingAssetFiles[kind]
                  const currentName = (draft as any)[config.nameField] as string | undefined
                  const currentUrl = (draft as any)[config.urlField] as string | undefined
                  const inputRef = kind === 'pdf' ? pdfFileInputRef : kind === 'mp3' ? mp3FileInputRef : midiFileInputRef
                  return <div className="score-library-attachment" key={kind}>
                    <div className="score-library-attachment-head">
                      <span>{config.label} · 必填</span>
                      <span className={`score-library-attachment-state ${selected || currentUrl ? 'attached' : ''}`}>{selected ? '待上傳' : currentUrl ? '已附加' : '未附加'}</span>
                    </div>
                    <button type="button" className="score-library-button" disabled={libraryBusy} onClick={() => inputRef.current?.click()}>{selected ? '更換選擇' : currentUrl ? '更換附件' : `選擇${config.label}`}</button>
                    <div className="score-library-path-hint">{selected ? selected.name : currentUrl ? (currentName || '附件已上傳') : kind === 'pdf' ? '原始 PDF 樂譜' : kind === 'mp3' ? '實際播放音源' : '音符起音／時間對位'}</div>
                  </div>
                })}
              </div>
              <span className="score-library-path-hint">三類曲譜一律要求四件套。PDF 負責顯示譜面，MP3 負責播放，MIDI 負責時間對位，MusicXML 提供音符／小節結構。</span>
            </div>

            <div className="score-library-field">
              <label htmlFor="score-category">自訂分類 / 標籤</label>
              <input id="score-category" className="score-library-input" value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} placeholder="例如：流行、動漫、古典、練習曲" />
            </div>
            <label className="score-library-checkbox">
              <input type="checkbox" checked={draft.favorite} onChange={(event) => setDraft((current) => ({ ...current, favorite: event.target.checked }))} /> 加入收藏
            </label>
            {formError && <div className="score-library-error" style={formError.startsWith('已讀取') ? { color: '#a7d4b0' } : undefined}>{formError}</div>}
            <div className="score-library-modal-actions">
              <button type="button" className="score-library-button" onClick={() => setEditorOpen(false)}>取消</button>
              <button type="button" className="score-library-button score-library-button-primary" disabled={libraryBusy} onClick={() => { void saveDraft() }}>{libraryBusy ? '正在儲存…' : '儲存'}</button>
            </div>
          </section>
        </div>
      )}

      {batchTypePickerOpen && (
        <div className="score-library-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setBatchTypePickerOpen(false)
        }}>
          <section className="score-library-modal" role="dialog" aria-modal="true" aria-labelledby="batch-import-title">
            <h2 id="batch-import-title">批次匯入四件套</h2>
            <p>請先手動選擇這一批曲譜的類型，再選取檔案。所選類型會套用到本次選取的所有曲目；若包含不同類型，請分批匯入。</p>
            <div className="score-library-field">
              <label htmlFor="batch-score-type">本批曲譜類型</label>
              <select id="batch-score-type" className="score-library-select" value={batchImportType} onChange={(event) => setBatchImportType(event.target.value as ScoreType)}>
                {SCORE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </div>
            <div className="score-library-modal-actions">
              <button type="button" className="score-library-button" onClick={() => setBatchTypePickerOpen(false)}>取消</button>
              <button type="button" className="score-library-button score-library-button-primary" disabled={libraryBusy} onClick={() => {
                setBatchTypePickerOpen(false)
                batchFilesInputRef.current?.click()
              }}>選擇檔案</button>
            </div>
          </section>
        </div>
      )}

      {noticeManagerOpen && isAdmin && (
        <div
          className="score-library-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !noticeManagerSaving) setNoticeManagerOpen(false)
          }}
        >
          <section
            className="score-library-modal score-library-notice-manager-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="friend-notice-manager-title"
          >
            <h2 id="friend-notice-manager-title">朋友專屬公告設定</h2>
            <p>公告設定會儲存在 Cloudflare 的現有 D1 資料庫。以後新增朋友、改文案、調整延遲或停用公告，都可以在這裡完成，不必修改程式碼或重新部署。</p>

            {noticeManagerLoading ? (
              <div className="score-library-empty">正在讀取雲端公告設定…</div>
            ) : (
              <div className="score-library-notice-manager-list">
                {friendNotices.length === 0 && (
                  <div className="score-library-empty">目前沒有專屬公告。按「新增朋友公告」即可建立第一則。</div>
                )}
                {friendNotices.map((notice, index) => (
                  <fieldset className="score-library-notice-editor" key={notice.id}>
                    <div className="score-library-notice-editor-head">
                      <strong>公告 {index + 1}</strong>
                      <div className="score-library-notice-editor-actions">
                        <label className="score-library-checkbox" style={{ margin: 0 }}>
                          <input
                            type="checkbox"
                            checked={notice.enabled}
                            onChange={(event) => updateFriendNotice(notice.id, { enabled: event.target.checked })}
                          />
                          啟用
                        </label>
                        <button
                          type="button"
                          className="score-library-delete"
                          onClick={() => removeFriendNotice(notice.id)}
                        >刪除</button>
                      </div>
                    </div>
                    <div className="score-library-field-grid">
                      <div className="score-library-field">
                        <label htmlFor={`notice-name-${notice.id}`}>觸發名字</label>
                        <input
                          id={`notice-name-${notice.id}`}
                          className="score-library-input"
                          value={notice.name}
                          onChange={(event) => updateFriendNotice(notice.id, { name: event.target.value })}
                          placeholder="例如：月桑"
                          maxLength={80}
                        />
                      </div>
                      <div className="score-library-field">
                        <label htmlFor={`notice-delay-${notice.id}`}>登入後延遲（毫秒）</label>
                        <input
                          id={`notice-delay-${notice.id}`}
                          className="score-library-input"
                          type="number"
                          min={0}
                          max={30000}
                          step={100}
                          value={notice.delayMs}
                          onChange={(event) => updateFriendNotice(notice.id, { delayMs: Number(event.target.value) })}
                        />
                        <span className="score-library-path-hint">1000 毫秒 = 1 秒</span>
                      </div>
                      <div className="score-library-field">
                        <label htmlFor={`notice-label-${notice.id}`}>上方小標（選填）</label>
                        <input
                          id={`notice-label-${notice.id}`}
                          className="score-library-input"
                          value={notice.label}
                          onChange={(event) => updateFriendNotice(notice.id, { label: event.target.value })}
                          placeholder="A LITTLE NOTE FROM KIM"
                          maxLength={80}
                        />
                      </div>
                      <div className="score-library-field">
                        <label htmlFor={`notice-title-${notice.id}`}>公告標題</label>
                        <input
                          id={`notice-title-${notice.id}`}
                          className="score-library-input"
                          value={notice.title}
                          onChange={(event) => updateFriendNotice(notice.id, { title: event.target.value })}
                          placeholder="來自 Kim 的小紙條"
                          maxLength={120}
                        />
                      </div>
                    </div>
                    <div className="score-library-field">
                      <label htmlFor={`notice-message-${notice.id}`}>公告內容（每行顯示一行）</label>
                      <textarea
                        id={`notice-message-${notice.id}`}
                        className="score-library-input"
                        value={notice.message}
                        onChange={(event) => updateFriendNotice(notice.id, { message: event.target.value })}
                        placeholder="輸入要給這位朋友的小紙條…"
                        rows={5}
                        maxLength={4000}
                        style={{ resize: 'vertical', lineHeight: 1.7 }}
                      />
                    </div>
                  </fieldset>
                ))}
              </div>
            )}

            {noticeManagerError && <div className="score-library-error" role="alert">{noticeManagerError}</div>}
            {noticeManagerStatus && <div className="score-library-status" role="status">{noticeManagerStatus}</div>}
            <div className="score-library-modal-actions">
              <button
                type="button"
                className="score-library-button"
                disabled={noticeManagerSaving}
                onClick={() => setNoticeManagerOpen(false)}
              >關閉</button>
              <button
                type="button"
                className="score-library-button"
                disabled={noticeManagerLoading || noticeManagerSaving}
                onClick={addFriendNotice}
              >＋ 新增朋友公告</button>
              <button
                type="button"
                className="score-library-button score-library-button-primary"
                disabled={noticeManagerLoading || noticeManagerSaving}
                onClick={() => { void saveFriendNoticeSettings() }}
              >{noticeManagerSaving ? '正在儲存…' : '儲存到雲端'}</button>
            </div>
          </section>
        </div>
      )}

      {/* 指定朋友專屬非阻塞通知：只覆蓋通知卡片本身，不遮罩整頁。 */}
      {specialNotice && !isAdmin && (
        <aside
          className="score-library-special-notice"
          role="status"
          aria-live="polite"
          aria-labelledby="special-notice-title"
        >
          <div className="score-library-special-notice-head">
            <div>
              <span className="score-library-special-notice-label">{specialNotice.label}</span>
              <h2 id="special-notice-title" className="score-library-special-notice-title">
                {specialNotice.title}
              </h2>
            </div>
            <button
              type="button"
              className="score-library-special-notice-close"
              aria-label="關閉專屬公告"
              title="關閉公告"
              onClick={() => setSpecialNotice(null)}
            >
              ×
            </button>
          </div>
          <p className="score-library-special-notice-body">
            {specialNotice.message.split(/\r?\n/).map((line, index, lines) => (
              <span key={`${specialNotice.id}-line-${index}`}>
                {line}{index < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        </aside>
      )}

    </main>
  )
}
