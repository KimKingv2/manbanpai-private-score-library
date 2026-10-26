import { memo, useEffect, useMemo, useRef, useState } from 'react';import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

;(pdfjsLib as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type PdfMeasureBox = {
  measureIndex: number
  printedNumber: string
  xStart: number
  xEnd: number
  yTop: number
  yBottom: number
  /** Horizontal centers of selectable fret digits, in PDF points and chronological left-to-right order. */
  noteXs: number[]
}

type PdfTheoryLabel = {
  measureIndex: number
  label: string
  detail?: string
  title?: string
}

type PdfNumericItem = {
  text: string
  xStart: number
  xCenter: number
  top: number
  bottom: number
  fontSize: number
}

type PdfPageModel = {
  pageNumber: number
  page: any
  width: number
  height: number
  measureBoxes: PdfMeasureBox[]
}

type Props = {
  fileUrl: string
  measureCount: number
  cursorMeasureIndex: number
  cursorProgress: number
  /** Per-onset times normalized to 0..1; based on matched MIDI time where available, with XML timing fallback. */
  cursorAnchorTimes: number[]
  zoom: number
  autoFollow: boolean
  onMeasureClick: (measureIndex: number) => void
  /** One generated chord/degree (or alternate theory mode) label per MusicXML measure. */
  theoryLabels?: PdfTheoryLabel[]
  selectedTheoryMeasureIndex?: number
  onTheoryLabelClick?: (measureIndex: number) => void
}

type TextItemLike = {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  fontName?: string
}

type LabelCandidate = {
  printedNumber: number
  x: number
  width: number
  top: number
  bottom: number
  fontSize: number
}

function monotonicSample(source: number[], targetCount: number): number[] {
  const values = [...new Set(source.filter(Number.isFinite).map(value => Math.max(0, Math.min(0.999, value))))].sort((a, b) => a - b)
  if (!values.length || targetCount <= 0) return []
  if (values.length === targetCount) return values
  if (targetCount === 1) return [values[0]]
  if (values.length === 1) return Array.from({ length: targetCount }, (_, index) => values[0] + (0.999 - values[0]) * index / (targetCount - 1))
  return Array.from({ length: targetCount }, (_, index) => {
    const sourcePosition = index * (values.length - 1) / (targetCount - 1)
    const lower = Math.floor(sourcePosition)
    const upper = Math.min(values.length - 1, lower + 1)
    const blend = sourcePosition - lower
    return values[lower] * (1 - blend) + values[upper] * blend
  })
}

type CursorEventTimeCache = WeakMap<PdfMeasureBox, WeakMap<number[], Map<number, number[]>>>
const cursorEventTimeCache: CursorEventTimeCache = new WeakMap()

function getCachedCursorEventTimes(box: PdfMeasureBox, rawAnchorTimes: number[], targetCount: number): number[] {
  let byAnchorArray = cursorEventTimeCache.get(box)
  if (!byAnchorArray) {
    byAnchorArray = new WeakMap<number[], Map<number, number[]>>()
    cursorEventTimeCache.set(box, byAnchorArray)
  }
  let byCount = byAnchorArray.get(rawAnchorTimes)
  if (!byCount) {
    byCount = new Map<number, number[]>()
    byAnchorArray.set(rawAnchorTimes, byCount)
  }
  let cached = byCount.get(targetCount)
  if (!cached) {
    cached = monotonicSample(rawAnchorTimes, targetCount)
    byCount.set(targetCount, cached)
  }
  return cached
}

function resolveCursorX(box: PdfMeasureBox, progressValue: number, rawAnchorTimes: number[]): number {
  const progress = Math.max(0, Math.min(1, Number.isFinite(progressValue) ? progressValue : 0))
  const noteXs = box.noteXs ?? []
  if (!noteXs.length) return box.xStart + (box.xEnd - box.xStart) * progress

  // Cache the expensive sort/resampling by immutable measure + anchor-array identity.
  // The playhead updates many times per second, but these inputs change only at a measure boundary.
  if (!rawAnchorTimes.length) {
    const first = noteXs[0]
    const end = Math.max(first, box.xEnd)
    return first + (end - first) * progress
  }

  const eventTimes = getCachedCursorEventTimes(box, rawAnchorTimes, noteXs.length)
  const endX = Math.max(noteXs[noteXs.length - 1], box.xEnd)
  const firstTime = eventTimes[0] ?? 0
  if (progress <= firstTime) return noteXs[0]

  // Iterate without constructing a new points array on every playback frame.
  for (let index = 0; index < noteXs.length; index++) {
    const leftTime = eventTimes[index] ?? 0
    const leftX = noteXs[index]
    const rightTime = index + 1 < noteXs.length ? (eventTimes[index + 1] ?? 0) : 1
    const rightX = index + 1 < noteXs.length ? noteXs[index + 1] : endX
    if (progress <= rightTime) {
      const span = rightTime - leftTime
      const amount = span > 0.00001 ? (progress - leftTime) / span : 1
      return leftX + (rightX - leftX) * Math.max(0, Math.min(1, amount))
    }
  }
  return endX
}

function PdfPageCanvas({
  model,
  scale,
  cursorMeasureIndex,
  cursorProgress,
  cursorAnchorTimes,
  hoveredMeasureIndex,
  onMeasureClick,
  onMeasureHover,
  theoryLabels,
  selectedTheoryMeasureIndex,
  onTheoryLabelClick,
}: {
  model: PdfPageModel
  scale: number
  cursorMeasureIndex: number
  cursorProgress: number
  cursorAnchorTimes: number[]
  hoveredMeasureIndex: number
  onMeasureClick: (measureIndex: number) => void
  onMeasureHover: (measureIndex: number) => void
  theoryLabels: PdfTheoryLabel[]
  selectedTheoryMeasureIndex: number
  onTheoryLabelClick?: (measureIndex: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<any>(null)

  useEffect(() => {
    let disposed = false
    const canvas = canvasRef.current
    if (!canvas) return
    const viewport = model.page.getViewport({ scale })
    const outputScale = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return

    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)

    try {
      renderTaskRef.current = model.page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      })
      void renderTaskRef.current.promise.catch((error: unknown) => {
        if (!disposed && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
          console.error('[慢半拍 PDF] page render failed', error)
        }
      })
    } catch (error) {
      console.error('[慢半拍 PDF] unable to start page render', error)
    }

    return () => {
      disposed = true
      try { renderTaskRef.current?.cancel?.() } catch { /* ignore a completed render */ }
    }
  }, [model.page, scale])

  const activeBox = model.measureBoxes.find(box => box.measureIndex === cursorMeasureIndex)
  const cursorRowY = activeBox?.yTop ?? null
  const previousCursorRowYRef = useRef<number | null>(null)
  const smoothCursorInSameRow = cursorRowY !== null &&
    previousCursorRowYRef.current !== null &&
    Math.abs(previousCursorRowYRef.current - cursorRowY) < 3
  useEffect(() => {
    previousCursorRowYRef.current = cursorRowY
  }, [cursorRowY])
  const pageWidth = model.width * scale
  const pageHeight = model.height * scale
  const cursorX = activeBox ? resolveCursorX(activeBox, cursorProgress, cursorAnchorTimes) : 0

  return (
    <div
      className="manbanpai-pdf-page"
      data-pdf-page={model.pageNumber}
      style={{ width: pageWidth, height: pageHeight, position: 'relative', flex: '0 0 auto' }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: pageWidth, height: pageHeight, background: '#fff' }} />
      {model.measureBoxes.filter(box => box.measureIndex === hoveredMeasureIndex).map(box => (
        <div
          key={`hover-${model.pageNumber}-${box.measureIndex}`}
          aria-hidden="true"
          style={{
            position: 'absolute', zIndex: 1, pointerEvents: 'none', boxSizing: 'border-box',
            left: box.xStart * scale,
            top: box.yTop * scale,
            width: Math.max(10, (box.xEnd - box.xStart) * scale),
            height: Math.max(10, (box.yBottom - box.yTop) * scale),
            border: '1px solid rgba(177,132,48,.58)',
            borderRadius: 3,
            background: 'rgba(232,197,111,.20)',
            boxShadow: 'inset 0 0 0 1px rgba(255,250,220,.18)',
          }}
        />
      ))}
      {model.measureBoxes.map(box => (
        <button
          key={`${model.pageNumber}-${box.measureIndex}`}
          type="button"
          className="manbanpai-pdf-measure-zone"
          data-pdf-measure-index={box.measureIndex}
          aria-label={`從 PDF 原譜第 ${box.printedNumber} 小節開始播放`}
          title={`點擊從第 ${box.printedNumber} 小節開始播放`}
          onClick={() => onMeasureClick(box.measureIndex)}
          onMouseEnter={() => onMeasureHover(box.measureIndex)}
          onMouseLeave={() => onMeasureHover(-1)}
          onFocus={() => onMeasureHover(box.measureIndex)}
          onBlur={() => onMeasureHover(-1)}
          style={{
            position: 'absolute', zIndex: 2,
            left: box.xStart * scale, top: box.yTop * scale,
            width: Math.max(10, (box.xEnd - box.xStart) * scale),
            height: Math.max(10, (box.yBottom - box.yTop) * scale),
            border: 0, margin: 0, padding: 0, borderRadius: 2,
            background: 'transparent', color: 'transparent',
            cursor: 'pointer', outline: 'none',
          }}
        />
      ))}
      {theoryLabels.map(label => {
        const box = model.measureBoxes.find(candidate => candidate.measureIndex === label.measureIndex)
        if (!box || !label.label) return null
        const availableWidth = Math.max(32, (box.xEnd - box.xStart - 10) * scale)
        const selected = selectedTheoryMeasureIndex === label.measureIndex
        return (
          <button
            key={`theory-${model.pageNumber}-${label.measureIndex}`}
            type="button"
            data-pdf-theory-measure-index={label.measureIndex}
            title={label.title ?? `第 ${box.printedNumber} 小節：${label.label}${label.detail ? ` · ${label.detail}` : ''}。點擊查看樂理分析`}
            aria-label={`查看第 ${box.printedNumber} 小節樂理分析：${label.label}`}
            aria-pressed={selected}
            onClick={event => { event.stopPropagation(); onTheoryLabelClick?.(label.measureIndex) }}
            style={{
              position: 'absolute', zIndex: 6,
              // Anchor the badge just to the left of this measure's ending barline.
              left: box.xEnd * scale - 3,
              top: Math.max(0, (box.yTop - 18) * scale),
              transform: 'translateX(-100%)',
              maxWidth: availableWidth,
              boxSizing: 'border-box',
              display: 'inline-flex', alignItems: 'center', gap: 4,
              border: `1px solid ${selected ? '#c39a4e' : 'rgba(161,129,65,.6)'}`,
              borderRadius: 5, padding: '2px 5px',
              background: selected ? 'rgba(244,222,170,.98)' : 'rgba(255,250,233,.94)',
              color: '#44371f', cursor: 'pointer',
              fontFamily: 'system-ui, sans-serif', fontSize: Math.max(8, 8.6 * scale),
              lineHeight: 1.1, fontWeight: 750, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
              boxShadow: '0 1px 3px rgba(0,0,0,.15)',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label.label}</span>
            {label.detail && <span style={{ flexShrink: 0, color: '#7c6230', fontSize: Math.max(7, 7.4 * scale), fontWeight: 650 }}>{label.detail}</span>}
          </button>
        )
      })}
      {activeBox && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', zIndex: 4, pointerEvents: 'none',
            left: 0,
            top: activeBox.yTop * scale,
            width: 2,
            height: (activeBox.yBottom - activeBox.yTop) * scale,
            transform: `translate3d(${cursorX * scale}px, 0, 0)`,
            transition: smoothCursorInSameRow ? 'transform 82ms linear' : 'none',
            willChange: 'transform',
            background: '#d3a64e',
            boxShadow: '0 0 0.5px rgba(111,77,22,.9), 0 0 5px rgba(211,166,78,.32)',
            opacity: 0.95,
          }}
        />
      )}
    </div>
  )
}

const MemoizedPdfPageCanvas = memo(PdfPageCanvas, (previous, next) => {
  if (
    previous.model !== next.model ||
    previous.scale !== next.scale ||
    previous.onMeasureClick !== next.onMeasureClick ||
    previous.onMeasureHover !== next.onMeasureHover ||
    previous.theoryLabels !== next.theoryLabels ||
    previous.selectedTheoryMeasureIndex !== next.selectedTheoryMeasureIndex ||
    previous.onTheoryLabelClick !== next.onTheoryLabelClick
  ) return false

  const previousHasCursor = previous.cursorMeasureIndex >= 0 &&
    previous.model.measureBoxes.some(box => box.measureIndex === previous.cursorMeasureIndex)
  const nextHasCursor = next.cursorMeasureIndex >= 0 &&
    next.model.measureBoxes.some(box => box.measureIndex === next.cursorMeasureIndex)
  const previousHasHover = previous.hoveredMeasureIndex >= 0 &&
    previous.model.measureBoxes.some(box => box.measureIndex === previous.hoveredMeasureIndex)
  const nextHasHover = next.hoveredMeasureIndex >= 0 &&
    next.model.measureBoxes.some(box => box.measureIndex === next.hoveredMeasureIndex)

  if (previous.hoveredMeasureIndex !== next.hoveredMeasureIndex && (previousHasHover || nextHasHover)) return false
  if (!previousHasCursor && !nextHasCursor) return true
  return previous.cursorMeasureIndex === next.cursorMeasureIndex &&
    previous.cursorProgress === next.cursorProgress &&
    previous.cursorAnchorTimes === next.cursorAnchorTimes
})

export default function PdfScoreDisplay({
  fileUrl,
  measureCount,
  cursorMeasureIndex,
  cursorProgress,
  cursorAnchorTimes,
  zoom,
  autoFollow,
  onMeasureClick,
  theoryLabels = [],
  selectedTheoryMeasureIndex = -1,
  onTheoryLabelClick,
}: Props) {
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const [viewerWidth, setViewerWidth] = useState(840)
  const [pageViewMode, setPageViewMode] = useState<'single' | 'double'>('single')
  const [pages, setPages] = useState<PdfPageModel[]>([])
  const [hoveredMeasureIndex, setHoveredMeasureIndex] = useState(-1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mappingCount, setMappingCount] = useState(0)

  useEffect(() => {
    const node = viewerRef.current
    if (!node) return
    const update = () => setViewerWidth(Math.max(320, node.clientWidth || window.innerWidth - 56))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    let loadingTask: any = null
    setLoading(true)
    setError('')
    setPages([])
    setMappingCount(0)

    void (async () => {
      try {
        loadingTask = (pdfjsLib as any).getDocument({
          url: fileUrl,
          withCredentials: true,
          disableRange: true,
          disableStream: true,
        })
        const pdf = await loadingTask.promise
        const rawPages: Omit<PdfPageModel, 'measureBoxes'>[] = []
        const pageNumericItems: PdfNumericItem[][] = []
        const pageLabels: Array<{ pageIndex: number; width: number; height: number; label: LabelCandidate }[]> = []

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber)
          if (cancelled) return
          const viewport = page.getViewport({ scale: 1 })
          const textContent = await page.getTextContent()
          const items = (textContent.items ?? []) as TextItemLike[]
          const labels: LabelCandidate[] = []
          const numericItems: PdfNumericItem[] = []

          for (const item of items) {
            const raw = String(item.str ?? '').trim()
            const transform = item.transform
            if (!transform || transform.length < 6) continue
            const fontSize = Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0)
            const [textX] = viewport.convertToViewportPoint(Number(transform[4]), Number(transform[5]))
            const [, baselineY] = viewport.convertToViewportPoint(Number(transform[4]), Number(transform[5]))
            const itemHeight = Number(item.height) > 0 ? Number(item.height) : fontSize * 1.25
            const top = baselineY - itemHeight

            // Fret digits are usually 7 pt in this export; measure labels are 6 pt.
            // Keep selectable numbers on the page so each printed bar can locate its actual note columns.
            if (/^\d{1,2}$/.test(raw) && fontSize >= 6.5 && fontSize <= 7.5) {
              const textWidth = Number(item.width) > 0 ? Number(item.width) : fontSize * 0.6
              numericItems.push({
                text: raw,
                xStart: textX,
                xCenter: textX + textWidth / 2,
                top,
                bottom: baselineY,
                fontSize,
              })
            }

            if (!/^\d{1,3}$/.test(raw)) continue
            const printedNumber = Number(raw)
            if (!Number.isInteger(printedNumber) || printedNumber < 1 || printedNumber > measureCount) continue
            if (fontSize < 5.35 || fontSize > 6.55) continue
            labels.push({ printedNumber, x: textX, width: Number(item.width) > 0 ? Number(item.width) : fontSize * 0.6, top, bottom: baselineY, fontSize })
          }

          rawPages.push({ pageNumber, page, width: viewport.width, height: viewport.height })
          pageNumericItems.push(numericItems)
          pageLabels.push(labels.map(label => ({ pageIndex: pageNumber - 1, width: viewport.width, height: viewport.height, label })))
        }

        const labelRows: Array<{ pageIndex: number; width: number; height: number; labels: LabelCandidate[] }> = []
        for (let pageIndex = 0; pageIndex < pageLabels.length; pageIndex++) {
          const groups = pageLabels[pageIndex].sort((a, b) => a.label.top - b.label.top || a.label.x - b.label.x)
          const rows: typeof labelRows = []
          for (const entry of groups) {
            let row = rows.find(candidate => candidate.pageIndex === entry.pageIndex && Math.abs(candidate.labels[0]?.top - entry.label.top) <= 3.2)
            if (!row) {
              row = { pageIndex: entry.pageIndex, width: entry.width, height: entry.height, labels: [] }
              rows.push(row)
            }
            row.labels.push(entry.label)
          }
          for (const row of rows) {
            row.labels.sort((a, b) => a.x - b.x)
            if (row.labels.length >= 2 && row.labels.some((label, index) => index > 0 && label.x - row.labels[index - 1].x > 35)) labelRows.push(row)
          }
        }
        labelRows.sort((a, b) => a.pageIndex - b.pageIndex || a.labels[0].top - b.labels[0].top)

        const byPrintedNumber = new Map<number, { pageIndex: number; width: number; height: number; label: LabelCandidate }>()
        for (const row of labelRows) {
          for (const label of row.labels) {
            if (!byPrintedNumber.has(label.printedNumber)) {
              byPrintedNumber.set(label.printedNumber, { pageIndex: row.pageIndex, width: row.width, height: row.height, label })
            }
          }
        }
        const sequential = Array.from({ length: measureCount }, (_, index) => byPrintedNumber.has(index + 1)).every(Boolean)
        const anchors = sequential
          ? Array.from({ length: measureCount }, (_, index) => ({ measureIndex: index, printedNumber: index + 1, ...byPrintedNumber.get(index + 1)! }))
          : labelRows.flatMap(row => row.labels.map(label => ({ measureIndex: -1, printedNumber: label.printedNumber, pageIndex: row.pageIndex, width: row.width, height: row.height, label })))
            .sort((a, b) => a.pageIndex - b.pageIndex || a.label.top - b.label.top || a.label.x - b.label.x)
            .slice(0, measureCount)
            .map((item, index) => ({ ...item, measureIndex: index }))

        const boxesByPage = new Map<number, PdfMeasureBox[]>()
        for (const anchor of anchors) {
          const siblings = anchors
            .filter(item => item.pageIndex === anchor.pageIndex && Math.abs(item.label.top - anchor.label.top) <= 3.2)
            .sort((a, b) => a.label.x - b.label.x)
          const siblingIndex = siblings.findIndex(item => item.measureIndex === anchor.measureIndex)
          const next = siblings[siblingIndex + 1]
          // Guitar Pro prints each measure number centered on its barline.
          // Use the label center instead of its left edge minus a fixed offset,
          // which made every internal measure zone drift a few points to the left.
          const anchorBarX = anchor.label.x + anchor.label.width / 2
          const nextBarX = next ? next.label.x + next.label.width / 2 : anchor.width - 28.1
          // The first measure in each system has no preceding printed bar number;
          // start at the first playable note column, preserving the current layout.
          const xStart = Math.max(0, anchor.label.x < 55 ? 48 : anchorBarX)
          const xEnd = Math.max(xStart + 24, nextBarX)
          const yTop = Math.max(0, anchor.label.top + 3.5)
          const yBottom = Math.min(anchor.height, anchor.label.top + 45)
          const numericItems = (pageNumericItems[anchor.pageIndex] ?? []).filter(item =>
            item.xStart >= xStart - 1.5 && item.xStart <= xEnd + 1.5 &&
            item.top >= yTop - 1.5 && item.bottom <= yBottom + 1.5
          ).sort((a, b) => a.xStart - b.xStart || a.top - b.top)
          const columns: Array<{ lastStart: number; centers: number[] }> = []
          for (const item of numericItems) {
            let column = columns.find(candidate => Math.abs(candidate.lastStart - item.xStart) <= 2.5)
            if (!column) {
              column = { lastStart: item.xStart, centers: [] }
              columns.push(column)
            }
            column.lastStart = item.xStart
            column.centers.push(item.xCenter)
          }
          const noteXs = columns
            .map(column => column.centers.reduce((sum, value) => sum + value, 0) / column.centers.length)
            .sort((a, b) => a - b)

          const box: PdfMeasureBox = {
            measureIndex: anchor.measureIndex,
            printedNumber: String(anchor.printedNumber),
            xStart,
            xEnd,
            yTop,
            yBottom,
            noteXs,
          }
          const current = boxesByPage.get(anchor.pageIndex) ?? []
          current.push(box)
          boxesByPage.set(anchor.pageIndex, current)
        }

        const built = rawPages.map(page => ({ ...page, measureBoxes: (boxesByPage.get(page.pageNumber - 1) ?? []).sort((a, b) => a.measureIndex - b.measureIndex) }))
        const mapped = built.reduce((sum, page) => sum + page.measureBoxes.length, 0)
        if (!cancelled) {
          setPages(built)
          setMappingCount(mapped)
          setLoading(false)
          if (mapped === 0) setError('PDF 已載入，但沒有辨識到可用的小節編號。仍可查看原譜，播放游標暫時無法精確定位。')
        }
      } catch (loadError) {
        if (cancelled) return
        console.error('[慢半拍 PDF] load failed', loadError)
        setError(loadError instanceof Error ? loadError.message : '無法載入 PDF 原譜。')
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      try { void loadingTask?.destroy?.() } catch { /* ignore teardown races */ }
    }
  }, [fileUrl, measureCount])

  useEffect(() => {
    if (!autoFollow || loading || cursorMeasureIndex < 0 || typeof window === 'undefined') return

    // Wait one frame so the newly highlighted row has finished laying out, then place
    // the whole measure/system row at the vertical center of the viewport.
    const frameId = window.requestAnimationFrame(() => {
      const node = viewerRef.current?.querySelector<HTMLElement>(`[data-pdf-measure-index="${cursorMeasureIndex}"]`)
      if (!node) return
      const rect = node.getBoundingClientRect()
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800
      const absoluteCenter = window.scrollY + rect.top + rect.height / 2
      const requestedTop = absoluteCenter - viewportHeight / 2
      const maxScrollTop = Math.max(0, document.documentElement.scrollHeight - viewportHeight)
      const targetTop = Math.min(maxScrollTop, Math.max(0, requestedTop))
      if (Math.abs(targetTop - window.scrollY) > 2) window.scrollTo({ top: targetTop, behavior: 'auto' })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [autoFollow, cursorMeasureIndex, loading])

  const cursorIsMapped = useMemo(() => pages.some(page => page.measureBoxes.some(box => box.measureIndex === cursorMeasureIndex)), [pages, cursorMeasureIndex])
  const activeMeasureBox = pages.flatMap(page => page.measureBoxes).find(box => box.measureIndex === cursorMeasureIndex)
  const anchorModeLabel = activeMeasureBox
    ? activeMeasureBox.noteXs.length === 0
      ? '未識別品格數字 · 使用小節線性模式'
      : activeMeasureBox.noteXs.length === cursorAnchorTimes.length
        ? `PDF 音符列 ${activeMeasureBox.noteXs.length} 組 · MIDI/XML 起點 ${cursorAnchorTimes.length} 個 · 逐點映射`
        : `PDF 音符列 ${activeMeasureBox.noteXs.length} 組 · MIDI/XML 起點 ${cursorAnchorTimes.length} 個 · 按序近似映射`
    : ''
  const widestPageWidth = pages.length ? Math.max(...pages.map(page => page.width)) : 1
  const pagesPerSpread = pageViewMode === 'double' ? 2 : 1
  const spreadWidth = widestPageWidth * pagesPerSpread + (pagesPerSpread - 1) * 14
  const fitScale = pages.length && viewerWidth > 0 ? Math.min(1.6, Math.max(0.24, (viewerWidth - 18) / spreadWidth)) : 1
  const scale = fitScale * Math.max(0.5, Math.min(2, zoom / 100))

  return (
    <section aria-label="PDF 原譜閱讀與 XML 播放同步" style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0 0' }}>
      <style>{`
        .manbanpai-pdf-scroll { display:flex; flex-direction:column; align-items:center; gap:18px; width:100%; max-height:none; overflow:visible; padding:8px 0 24px; box-sizing:border-box; background:transparent; border:0; border-radius:0; }
        .manbanpai-pdf-scroll[data-page-view="double"] { display:grid; grid-template-columns:repeat(2, minmax(0, max-content)); justify-content:center; align-items:start; gap:14px; }
        .manbanpai-pdf-page { background:#fff; box-shadow:0 8px 28px rgba(0,0,0,.22); }
        /* These buttons are invisible click targets over the PDF. Explicitly isolate them from global/day-theme button styles. */
        .manbanpai-pdf-scroll .manbanpai-pdf-measure-zone,
        .manbanpai-pdf-scroll .manbanpai-pdf-measure-zone:hover,
        .manbanpai-pdf-scroll .manbanpai-pdf-measure-zone:active {
          appearance:none !important; -webkit-appearance:none !important;
          background:transparent !important; background-color:transparent !important; background-image:none !important;
          border:0 !important; box-shadow:none !important; filter:none !important; opacity:1 !important;
        }
        .manbanpai-pdf-scroll .manbanpai-pdf-measure-zone::before,
        .manbanpai-pdf-scroll .manbanpai-pdf-measure-zone::after { content:none !important; display:none !important; }
        .manbanpai-pdf-measure-zone:focus-visible { outline:2px solid #d3a64e !important; outline-offset:-2px; }
        @media (max-width:680px) { .manbanpai-pdf-scroll { padding:6px 0 16px; } .manbanpai-pdf-scroll[data-page-view="double"] { gap:6px; } }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', margin: '0 0 8px', color: '#8b8777', fontSize: 10.5 }}>
        <span>PDF 原譜顯示 · MIDI 音符起音時間驅動 · XML 建立音符順序 · 不重新繪製原譜</span>
        <div role="group" aria-label="吉他彈唱譜頁面顯示方式" style={{ display: 'inline-flex', gap: 3, padding: 2, border: '1px solid rgba(217,183,121,.28)', borderRadius: 7, background: 'rgba(255,255,255,.025)' }}>
          {([{ value: 'single', label: '單頁' }, { value: 'double', label: '雙頁' }] as const).map(option => (
            <button key={option.value} type="button" onClick={() => setPageViewMode(option.value)} aria-pressed={pageViewMode === option.value} style={{
              border: pageViewMode === option.value ? '1px solid rgba(217,183,121,.55)' : '1px solid transparent',
              borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 10.5, lineHeight: 1.35,
              background: pageViewMode === option.value ? 'rgba(217,183,121,.17)' : 'transparent',
              color: pageViewMode === option.value ? '#f1d99b' : '#9aa8b7',
            }}>{option.label}</button>
          ))}
        </div>
        <span>{loading ? '正在讀取 PDF…' : `頁數 ${pages.length} · 小節定位 ${mappingCount}/${measureCount} · 依 MIDI 起音時間在原譜音符列間插值`}</span>
        {!loading && anchorModeLabel && <span style={{ color: '#a99a7a' }}>{anchorModeLabel}</span>}
      </div>
      {error && <p role="status" style={{ margin: '0 0 9px', color: '#9c7333', fontSize: 11, lineHeight: 1.5 }}>{error}</p>}
      {loading && <div style={{ padding: 22, textAlign: 'center', color: '#7a766b', background: '#f5f3ec', borderRadius: 8 }}>正在載入原始 PDF 頁面…</div>}
      <div ref={viewerRef} className="manbanpai-pdf-scroll" data-page-view={pageViewMode}>
        {pages.map(page => (
          <MemoizedPdfPageCanvas
            key={page.pageNumber}
            model={page}
            scale={scale}
            cursorMeasureIndex={cursorMeasureIndex}
            cursorProgress={cursorProgress}
            cursorAnchorTimes={cursorAnchorTimes}
            hoveredMeasureIndex={hoveredMeasureIndex}
            onMeasureClick={onMeasureClick}
            onMeasureHover={setHoveredMeasureIndex}
            theoryLabels={theoryLabels}
            selectedTheoryMeasureIndex={selectedTheoryMeasureIndex}
            onTheoryLabelClick={onTheoryLabelClick}
          />
        ))}
      </div>
      {!loading && mappingCount > 0 && mappingCount < measureCount && (
        <p style={{ margin: '8px 2px 0', color: '#8b8777', fontSize: 10.5, lineHeight: 1.5 }}>
          已定位部分小節；若某些 PDF 沒有可提取的文字小節編號，仍會完整顯示原頁，但那些小節需要額外校準。
        </p>
      )}
      {!cursorIsMapped && !loading && mappingCount > 0 && (
        <p style={{ margin: '8px 2px 0', color: '#8b8777', fontSize: 10.5 }}>目前播放位置尚未匹配到 PDF 小節；原譜頁面不會被修改。</p>
      )}
    </section>
  )
}
