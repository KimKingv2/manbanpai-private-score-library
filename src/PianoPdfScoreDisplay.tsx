import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

;(pdfjsLib as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type PianoChordLabel = {
  id: string
  measureIndex: number
  /** Normalized analysis position retained for the label data; visible badges align to the measure-end barline. */
  position: number
  text: string
  /** Optional two-line compact badge, used to keep one chord/degree label per measure. */
  symbol?: string
  roman?: string
  title?: string
}

type Props = {
  fileUrl: string
  measureCount: number
  /** MusicXML measure number attributes in written order, used to anchor PDF geometry. */
  measureNumbers?: string[]
  /** Exact measure-array indices where MusicXML requests a new system or page. */
  systemStartIndices?: number[]
  cursorMeasureIndex: number
  cursorProgress: number
  /** Normalized notated event times within the active measure. */
  cursorAnchorTimes: number[]
  /** Normalized MusicXML engraved x positions paired with cursorAnchorTimes. */
  cursorAnchorPositions: number[]
  zoom: number
  autoFollow: boolean
  showMappingDebug?: boolean
  chordLabels?: PianoChordLabel[]
  onMeasureClick: (measureIndex: number) => void
}

type TextItemLike = {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

type MeasureLabel = { number: number; x: number; top: number; fontSize: number }
type LabelRow = { pageIndex: number; width: number; height: number; top: number; labels: MeasureLabel[] }
type MeasureBox = {
  measureIndex: number
  printedNumber: number
  /** Actual MusicXML measure-number attribute. This differs from index + 1 for pickups. */
  xmlNumber?: string
  xStart: number
  xEnd: number
  yTop: number
  yBottom: number
}
type PageModel = { pageNumber: number; page: any; width: number; height: number; boxes: MeasureBox[] }

function normalizeMeasureNumberLabel(value: string | number) {
  const trimmed = String(value ?? '').trim()
  const exact = trimmed.match(/^\d+$/)
  if (exact) return String(Number(trimmed))
  const anyNumber = trimmed.match(/\d+/)
  return anyNumber ? String(Number(anyNumber[0])) : trimmed
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Resolve the playback cursor through MusicXML event anchors instead of spreading time
 * uniformly across every bar. This mirrors the anchor-based guitar cursor, using MusicXML's
 * engraving coordinates because piano noteheads are not selectable PDF text glyphs.
 */
type PianoCursorAnchorPoint = { time: number; position: number }
type PianoCursorAnchorCache = WeakMap<MeasureBox, WeakMap<number[], WeakMap<number[], PianoCursorAnchorPoint[]>>>
const pianoCursorAnchorCache: PianoCursorAnchorCache = new WeakMap()

function getCachedPianoCursorAnchorPoints(
  box: MeasureBox,
  rawAnchorTimes: number[],
  rawAnchorPositions: number[],
): PianoCursorAnchorPoint[] {
  let byTimes = pianoCursorAnchorCache.get(box)
  if (!byTimes) {
    byTimes = new WeakMap<number[], WeakMap<number[], PianoCursorAnchorPoint[]>>()
    pianoCursorAnchorCache.set(box, byTimes)
  }
  let byPositions = byTimes.get(rawAnchorTimes)
  if (!byPositions) {
    byPositions = new WeakMap<number[], PianoCursorAnchorPoint[]>()
    byTimes.set(rawAnchorTimes, byPositions)
  }
  let points = byPositions.get(rawAnchorPositions)
  if (!points) {
    const count = Math.min(rawAnchorTimes.length, rawAnchorPositions.length)
    points = []
    let previousTime = 0
    let previousPosition = 0
    for (let index = 0; index < count; index++) {
      const rawTime = rawAnchorTimes[index]
      const rawPosition = rawAnchorPositions[index]
      if (!Number.isFinite(rawTime) || !Number.isFinite(rawPosition)) continue
      const time = clamp(Math.max(previousTime, rawTime), 0, 0.999)
      const position = clamp(Math.max(previousPosition, rawPosition), 0, 0.999)
      points.push({ time, position })
      previousTime = time
      previousPosition = position
    }
    if (points.length) points.push({ time: 1, position: 1 })
    byPositions.set(rawAnchorPositions, points)
  }
  return points
}

function resolveCursorX(
  box: MeasureBox,
  progressValue: number,
  rawAnchorTimes: number[],
  rawAnchorPositions: number[],
): number {
  const progress = clamp(Number.isFinite(progressValue) ? progressValue : 0, 0, 1)
  const width = Math.max(0, box.xEnd - box.xStart)
  if (!rawAnchorTimes.length || !rawAnchorPositions.length || width <= 0) {
    return box.xStart + width * progress
  }

  const points = getCachedPianoCursorAnchorPoints(box, rawAnchorTimes, rawAnchorPositions)
  if (!points.length) return box.xStart + width * progress
  if (progress <= points[0].time) return box.xStart + width * points[0].position

  // The anchor polyline is cached; this hot path only performs numeric interpolation.
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index]
    const right = points[index + 1]
    if (progress <= right.time) {
      const span = right.time - left.time
      const blend = span > 0.00001 ? (progress - left.time) / span : 1
      const position = left.position + (right.position - left.position) * clamp(blend, 0, 1)
      return box.xStart + width * position
    }
  }
  return box.xEnd
}

function labelLooksLikeMeasureRow(labels: MeasureLabel[]) {
  if (!labels.length) return false
  if (labels.length === 1) return labels[0].x < 170
  let increasingPairs = 0
  let distinctPairs = 0
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].number !== labels[i - 1].number) distinctPairs++
    if (labels[i].number > labels[i - 1].number) increasingPairs++
  }
  return distinctPairs > 0 && increasingPairs / distinctPairs >= 0.7 && labels.some((item, index) => index > 0 && item.x - labels[index - 1].x >= 18)
}

function median(values: number[], fallback: number) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (!sorted.length) return fallback
  return sorted[Math.floor(sorted.length / 2)]
}

function distributeRowMeasures(
  row: LabelRow,
  rowIndex: number,
  rows: LabelRow[],
  measureCount: number,
  pageMarginRight = 28,
  defaultMeasuresPerSystem = 4,
): MeasureBox[] {
  const labels = [...row.labels].sort((a, b) => a.x - b.x)
  if (!labels.length) return []

  const nextRow = rows.slice(rowIndex + 1).find(item => item.pageIndex !== row.pageIndex || item.top > row.top + 12)
  const nextNumber = nextRow?.labels[0]?.number
  const startNumber = labels[0].number
  let inferredCount = nextNumber && nextNumber > startNumber && nextNumber - startNumber <= 16
    ? nextNumber - startNumber
    : defaultMeasuresPerSystem
  inferredCount = clamp(inferredCount, 1, 16)

  const nextRowTop = nextRow && nextRow.pageIndex === row.pageIndex ? nextRow.top : row.top + 124
  const systemHeight = clamp(nextRowTop - row.top - 7, 82, 155)
  const yTop = clamp(row.top + 2, 0, row.height - 8)
  const yBottom = clamp(row.top + systemHeight, yTop + 20, row.height)
  const boxes: MeasureBox[] = []
  const pageEnd = row.width - pageMarginRight

  // A single label at the left edge usually means this export numbers only the first
  // measure of each system. Split that system into the count inferred from the next label.
  if (labels.length === 1) {
    const label = labels[0]
    const count = inferredCount
    const left = clamp(label.x - 3, 0, row.width)
    const right = Math.max(left + count * 16, pageEnd)
    const barWidth = (right - left) / count
    for (let slot = 0; slot < count; slot++) {
      const measureNumber = label.number + slot
      if (measureNumber < 0 || measureNumber > measureCount) continue
      boxes.push({
        measureIndex: measureNumber - 1,
        printedNumber: measureNumber,
        xStart: left + slot * barWidth,
        xEnd: left + (slot + 1) * barWidth,
        yTop,
        yBottom,
      })
    }
    return boxes
  }

  // Multiple numbers on one system can either label every bar or label every few bars.
  // Interpolate only between known printed numbers and use the next system number to
  // estimate the final interval. This is a first-pass click/playhead map, not notehead OCR.
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index]
    const nextLabel = labels[index + 1]
    const expectedEndNumber = nextLabel?.number ?? (nextNumber && nextNumber > label.number ? nextNumber : label.number + 1)
    const slotCount = clamp(expectedEndNumber - label.number, 1, 16)
    const left = clamp(label.x - 3, 0, row.width)
    const right = nextLabel ? Math.max(left + 16, nextLabel.x - 3) : pageEnd
    const barWidth = (right - left) / slotCount
    for (let slot = 0; slot < slotCount; slot++) {
      const measureNumber = label.number + slot
      if (measureNumber < 0 || measureNumber > measureCount) continue
      boxes.push({
        measureIndex: measureNumber - 1,
        printedNumber: measureNumber,
        xStart: left + slot * barWidth,
        xEnd: left + (slot + 1) * barWidth,
        yTop,
        yBottom,
      })
    }
  }
  return boxes
}


type RasterStaff = { lineYs: number[]; top: number; bottom: number; left: number; right: number; coverage: number }
type RasterSystem = { pageIndex: number; pageWidth: number; pageHeight: number; xStart: number; xEnd: number; yTop: number; yBottom: number; barXs: number[]; boxes: MeasureBox[] }

function isDarkPixel(data: Uint8ClampedArray, width: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width) return false
  const i = (y * width + x) * 4
  return (data[i] + data[i + 1] + data[i + 2]) / 3 < 158
}

function extractHorizontalLineRuns(data: Uint8ClampedArray, width: number, height: number) {
  const x0 = Math.round(width * 0.035)
  const x1 = Math.round(width * 0.965)
  const minimum = Math.round((x1 - x0) * 0.19)
  const active: Array<{ y: number; coverage: number }> = []
  for (let y = 0; y < height; y++) {
    let dark = 0
    for (let x = x0; x < x1; x++) if (isDarkPixel(data, width, x, y)) dark++
    if (dark >= minimum) active.push({ y, coverage: dark / (x1 - x0) })
  }
  const runs: Array<{ y: number; coverage: number }> = []
  let group: Array<{ y: number; coverage: number }> = []
  const flush = () => {
    if (!group.length) return
    runs.push({
      y: group.reduce((sum, item) => sum + item.y, 0) / group.length,
      coverage: Math.max(...group.map(item => item.coverage)),
    })
    group = []
  }
  for (const item of active) {
    if (group.length && item.y - group[group.length - 1].y > 2) flush()
    group.push(item)
  }
  flush()
  return runs
}

function detectStaffGroups(data: Uint8ClampedArray, width: number, rasterScale: number): RasterStaff[] {
  // Canvas ImageData stores four bytes per pixel; derive the raster height from the buffer.
  // The previous build referenced an undeclared `height` here and crashed during PDF analysis.
  const height = Math.floor(data.length / Math.max(1, width * 4))
  const lines = extractHorizontalLineRuns(data, width, height)
  const staffGroups: RasterStaff[] = []
  let i = 0
  while (i <= lines.length - 5) {
    const five = lines.slice(i, i + 5)
    const gaps = five.slice(1).map((line, index) => line.y - five[index].y)
    const typicalGap = median(gaps, 0)
    const regular = typicalGap >= 2.6 * rasterScale && typicalGap <= 7.5 * rasterScale && gaps.every(gap => gap >= typicalGap * 0.62 && gap <= typicalGap * 1.42)
    const strongLines = five.every(line => line.coverage >= 0.18)
    if (!regular || !strongLines) {
      i++
      continue
    }
    // Staff-line extent: require at least three of the five horizontal lines to be inked at x.
    let left = width
    let right = 0
    const ys = five.map(line => Math.round(line.y))
    for (let x = 0; x < width; x++) {
      let lineHits = 0
      for (const y of ys) {
        if ([-1, 0, 1].some(dy => isDarkPixel(data, width, x, y + dy))) lineHits++
      }
      if (lineHits >= 3) {
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
    if (right - left >= width * 0.32) {
      staffGroups.push({
        lineYs: ys.map(y => y / rasterScale),
        top: ys[0] / rasterScale,
        bottom: ys[4] / rasterScale,
        left: left / rasterScale,
        right: right / rasterScale,
        coverage: five.reduce((sum, line) => sum + line.coverage, 0) / five.length,
      })
      i += 5
    } else {
      i++
    }
  }
  return staffGroups
}

function longestVerticalRun(data: Uint8ClampedArray, width: number, height: number, x: number, yTop: number, yBottom: number): number {
  let best = 0
  let run = 0
  const start = clamp(Math.floor(yTop), 0, height - 1)
  const end = clamp(Math.ceil(yBottom), 0, height - 1)
  for (let y = start; y <= end; y++) {
    const dark = [-1, 0, 1].some(dx => isDarkPixel(data, width, x + dx, y))
    run = dark ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

function detectSystemBarXs(
  data: Uint8ClampedArray,
  rasterWidth: number,
  rasterHeight: number,
  rasterScale: number,
  upper: RasterStaff,
  lower: RasterStaff,
): number[] {
  // A real piano grand-staff barline normally continues from the top staff through
  // the inter-staff gap to the bottom staff. Requiring two separate vertical runs
  // mistakenly accepts aligned note stems and misses barlines when the estimated
  // staff bands are slightly too short. Score the entire grand-staff height instead.
  // Important: yTop/yBottom below are already raster coordinates. Passing them back
  // through `/ rasterScale` sampled only the wrong upper part of the system, allowing
  // note stems to masquerade as barlines and forcing the boundary fitter to redistribute
  // the entire row. Keep x and y in the same raster coordinate space during pixel scans.
  const xStart = Math.max(0, Math.floor(Math.min(upper.left, lower.left) * rasterScale))
  const xEnd = Math.min(rasterWidth - 1, Math.ceil(Math.max(upper.right, lower.right) * rasterScale))
  const yTop = Math.min(upper.top, lower.top) * rasterScale
  const yBottom = Math.max(upper.bottom, lower.bottom) * rasterScale
  const fullHeight = Math.max(1, yBottom - yTop)
  const threshold = Math.max(20 * rasterScale, fullHeight * 0.52)
  const candidates: Array<{ x: number; score: number }> = []
  for (let x = xStart; x <= xEnd; x++) {
    const run = Math.max(...[-3, -2, -1, 0, 1, 2, 3].map(dx =>
      longestVerticalRun(data, rasterWidth, rasterHeight, x + dx, yTop, yBottom),
    ))
    if (run >= threshold) candidates.push({ x, score: run / threshold })
  }
  if (!candidates.length) return []
  const clusters: Array<Array<{ x: number; score: number }>> = []
  for (const candidate of candidates) {
    const last = clusters[clusters.length - 1]
    if (last && candidate.x - last[last.length - 1].x <= 5 * rasterScale) last.push(candidate)
    else clusters.push([candidate])
  }
  const xs = clusters.map(cluster => {
    // Candidate generation uses a +/- 3 px neighbourhood to tolerate antialiasing.
    // Averaging those expanded candidates biases the result toward the scan window's
    // edges. Re-measure the exact columns within this cluster and use the centre of the
    // strongest true vertical run. This usually improves barline placement by 1-3 PDF px
    // without making detection more brittle on slightly antialiased exports.
    const refineStart = Math.max(xStart, cluster[0].x - 4 * rasterScale)
    const refineEnd = Math.min(rasterWidth - 1, cluster[cluster.length - 1].x + 4 * rasterScale)
    const exactRuns: Array<{ x: number; run: number }> = []
    for (let x = refineStart; x <= refineEnd; x++) {
      const run = longestVerticalRun(data, rasterWidth, rasterHeight, x, yTop, yBottom)
      if (run >= threshold) exactRuns.push({ x, run })
    }
    if (exactRuns.length) {
      const bestRun = Math.max(...exactRuns.map(point => point.run))
      // Ignore antialias columns with materially shorter vertical continuity; average only
      // the strongest core columns so the result lands on the printed stroke itself.
      const core = exactRuns.filter(point => point.run >= bestRun - Math.max(1, rasterScale * 0.35))
      return core.reduce((sum, point) => sum + point.x, 0) / core.length / rasterScale
    }
    // Conservative fallback for a line whose dark stroke is fragmented by the renderer.
    const weighted = cluster.reduce((sum, point) => sum + point.x * point.score, 0)
    const weights = cluster.reduce((sum, point) => sum + point.score, 0)
    return (weighted / Math.max(0.001, weights)) / rasterScale
  })
  const deduped: number[] = []
  for (const x of xs) {
    if (!deduped.length || x - deduped[deduped.length - 1] >= 8) deduped.push(x)
  }
  return deduped
}

async function detectPianoSystems(
  page: any,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  systemLabelRows?: LabelRow[],
  includeUnnumberedOpeningSystem = false,
): Promise<RasterSystem[]> {
  const rasterScale = 1.5
  const viewport = page.getViewport({ scale: rasterScale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) return []
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  let task: any = null
  try {
    task = page.render({ canvasContext: context, viewport })
    await task.promise
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const staffs = detectStaffGroups(image.data, canvas.width, rasterScale)
    const systems: RasterSystem[] = []
    // Pair consecutive detected staves by plausible grand-staff spacing instead of blindly
    // taking entries 0+1, 2+3, ... . If a short/incomplete opening staff is missed, blind pairing
    // shifts every following system and can make playback measure 1 appear on page 2.
    let staffIndex = 0
    while (staffIndex + 1 < staffs.length) {
      const upper = staffs[staffIndex]
      let lowerIndex = -1
      let bestSeparation = Number.POSITIVE_INFINITY
      for (let candidateIndex = staffIndex + 1; candidateIndex < staffs.length; candidateIndex++) {
        const candidate = staffs[candidateIndex]
        const separation = candidate.top - upper.bottom
        if (separation < 5) continue
        if (separation > 72) break
        const overlap = Math.min(upper.right, candidate.right) - Math.max(upper.left, candidate.left)
        const minimumOverlap = Math.min(upper.right - upper.left, candidate.right - candidate.left) * 0.56
        if (overlap < Math.max(80, minimumOverlap)) continue
        if (separation < bestSeparation) {
          bestSeparation = separation
          lowerIndex = candidateIndex
        }
      }
      if (lowerIndex < 0) {
        staffIndex++
        continue
      }
      const lower = staffs[lowerIndex]
      const bars = detectSystemBarXs(image.data, canvas.width, canvas.height, rasterScale, upper, lower)
      const left = Math.min(upper.left, lower.left)
      const right = Math.max(upper.right, lower.right)
      if (right - left >= 120) {
        // A system's first left boundary may be implicit, especially for a pickup measure.
        // Internal/right boundaries come from the actual barline pixels shared by both staves.
        const innerBars = bars.filter(x => x > left + 10 && x < right - 3)
        const boundaries = [left, ...innerBars]
        const lastBar = bars.filter(x => x >= right - 16).sort((a, b) => b - a)[0]
        boundaries.push(lastBar ?? right)
        const clean: number[] = []
        for (const x of boundaries) {
          if (!clean.length || x - clean[clean.length - 1] >= 8) clean.push(x)
        }
        const boxes: MeasureBox[] = []
        for (let boundaryIndex = 0; boundaryIndex < clean.length - 1; boundaryIndex++) {
          const xStart = clean[boundaryIndex]
          const xEnd = clean[boundaryIndex + 1]
          if (xEnd - xStart < 12) continue
          boxes.push({
            measureIndex: -1,
            printedNumber: -1,
            xStart,
            xEnd,
            yTop: Math.max(0, upper.top - 7),
            yBottom: Math.min(pageHeight, lower.bottom + 7),
          })
        }
        if (boxes.length) systems.push({
          pageIndex,
          pageWidth,
          pageHeight,
          xStart: left,
          xEnd: right,
          yTop: Math.max(0, upper.top - 7),
          yBottom: Math.min(pageHeight, lower.bottom + 7),
          barXs: clean,
          boxes,
        })
      }
      staffIndex = lowerIndex + 1
    }
    // When MusicXML carries its original MuseScore line breaks, trust those labels to
    // determine the number and order of systems. Global staff-line detection can miss a
    // whole row when beams/ledger lines alter raster coverage, which previously shifted
    // several later systems. For labelled rows, scan the two staff bands locally instead.
    if (systemLabelRows) {
      // Keep the reliable label-relative scan as the source of barline candidates, but use
      // detected staff extents when a real system is confidently aligned to the label row.
      // This adapts to different page margins without trusting global barline candidates that
      // can miss a short pickup boundary. The pixel detector below remains local to each row.
      const claimedStaffGeometry = new Set<number>()
      const makeLabelledSystem = (labelTop: number, opening = false): RasterSystem => {
        const nominalLeft = opening ? Math.min(pageWidth - 100, 62) : Math.min(pageWidth - 100, 36.7)
        const nominalRight = Math.max(nominalLeft + 120, pageWidth - 42.3)
        const targetSystemY = labelTop + (opening ? 8 : 5)
        const geometryMatch = systems
          .map((system, index) => ({ system, index, distance: Math.abs(system.yTop - targetSystemY) }))
          .filter(item => !claimedStaffGeometry.has(item.index) && item.distance <= 24)
          .sort((a, b) => a.distance - b.distance)[0]
        if (geometryMatch) claimedStaffGeometry.add(geometryMatch.index)
        const staffLeft = geometryMatch?.system.xStart ?? nominalLeft
        const staffRight = geometryMatch?.system.xEnd ?? nominalRight
        // The opening system uses a taller title/tempo block; subsequent systems have
        // the printed measure number immediately above the staff. These are fallback bands;
        // matching detected system geometry still supplies the horizontal staff extents.
        const upper: RasterStaff = {
          lineYs: [],
          top: labelTop + (opening ? 16 : 13),
          bottom: labelTop + (opening ? 36 : 35),
          left: staffLeft,
          right: staffRight,
          coverage: 1,
        }
        const lower: RasterStaff = {
          lineYs: [],
          top: labelTop + (opening ? 57 : 56),
          bottom: labelTop + (opening ? 77 : 76),
          left: staffLeft,
          right: staffRight,
          coverage: 1,
        }
        const bars = detectSystemBarXs(image.data, canvas.width, canvas.height, rasterScale, upper, lower)
        // The left boundary of a system's first measure is different from an internal
        // measure boundary: after a line break, the first measure begins at the system's
        // left edge, so estimating it at +8.7% of the page clips the measure's left side.
        // The unnumbered opening system is the exception: its first real barline is printed
        // after the clef/key/time signature area, so locate that initial barline locally.
        const openingMeasureEstimate = Math.min(staffRight - 24, staffLeft + pageWidth * 0.042)
        const leftWindowStart = staffLeft + pageWidth * 0.018
        const leftWindowEnd = staffLeft + pageWidth * 0.14
        const nearestStartLine = bars
          .filter(x => x > leftWindowStart && x < leftWindowEnd)
          .sort((a, b) => Math.abs(a - openingMeasureEstimate) - Math.abs(b - openingMeasureEstimate))[0]
        const snapTolerance = Math.max(9, pageWidth * 0.03)
        const measureLeft = opening
          ? (nearestStartLine !== undefined && Math.abs(nearestStartLine - openingMeasureEstimate) <= snapTolerance
              ? nearestStartLine
              : openingMeasureEstimate)
          : staffLeft
        const endTolerance = Math.max(8, pageWidth * 0.02)
        const detectedEnd = bars.filter(x => x >= staffRight - endTolerance).sort((a, b) => b - a)[0]
        const measureRight = detectedEnd ?? staffRight
        const innerBars = bars.filter(x => x > measureLeft + 7 && x < measureRight - 7)
        const boundaries = [measureLeft, ...innerBars, measureRight]
        const clean: number[] = []
        for (const x of boundaries) {
          if (!clean.length || x - clean[clean.length - 1] >= 8) clean.push(x)
        }
        const yTop = Math.max(0, upper.top - 8)
        const yBottom = Math.min(pageHeight, lower.bottom + 7)
        const boxes: MeasureBox[] = []
        for (let index = 0; index < clean.length - 1; index++) {
          if (clean[index + 1] - clean[index] < 12) continue
          boxes.push({
            measureIndex: -1,
            printedNumber: -1,
            xStart: clean[index],
            xEnd: clean[index + 1],
            yTop,
            yBottom,
          })
        }
        return {
          pageIndex,
          pageWidth,
          pageHeight,
          xStart: measureLeft,
          xEnd: measureRight,
          yTop,
          yBottom,
          barXs: clean,
          boxes,
        }
      }

      const labelledSystems = systemLabelRows.map(row => makeLabelledSystem(row.top))
      if (includeUnnumberedOpeningSystem) {
        const firstLabelTop = systemLabelRows[0]?.top
        const leading = Number.isFinite(firstLabelTop)
          ? systems
            .filter(system => system.yTop < (firstLabelTop as number) - 15)
            .sort((a, b) => b.yTop - a.yTop)[0]
          : undefined
        // The opening system has no printed system-start label; estimate its vertical slot
        // from neighbouring systems, then use the same adaptive raster geometry when available.
        if (Number.isFinite(firstLabelTop)) {
          const spacings = systemLabelRows.slice(1).map((row, index) => row.top - systemLabelRows[index].top)
          const inferredSpacing = median(spacings, 112)
          labelledSystems.unshift(makeLabelledSystem((firstLabelTop as number) - inferredSpacing, true))
        } else if (leading) {
          labelledSystems.unshift(leading)
        }
      }
      return labelledSystems.sort((a, b) => a.yTop - b.yTop)
    }

    return systems
  } finally {
    try { task?.cancel?.() } catch { /* rendering has completed */ }
    canvas.width = 0
    canvas.height = 0
  }
}

function PianoPage({
  model,
  scale,
  cursorMeasureIndex,
  cursorProgress,
  cursorAnchorTimes,
  cursorAnchorPositions,
  showMappingDebug,
  chordLabels = [],
  onMeasureClick,
}: {
  model: PageModel
  scale: number
  cursorMeasureIndex: number
  cursorProgress: number
  cursorAnchorTimes: number[]
  cursorAnchorPositions: number[]
  showMappingDebug: boolean
  chordLabels: PianoChordLabel[]
  onMeasureClick: (measureIndex: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<any>(null)
  useEffect(() => {
    let disposed = false
    const canvas = canvasRef.current
    if (!canvas) return
    const viewport = model.page.getViewport({ scale })
    // Render above CSS resolution even on standard-DPI displays, so the notation stays crisp when zoomed.
    const outputScale = Math.min(3, Math.max(2, window.devicePixelRatio || 1))
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    try {
      renderTaskRef.current = model.page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
      })
      void renderTaskRef.current.promise.catch((error: unknown) => {
        if (!disposed && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
          console.error('[慢半拍鋼琴 PDF] page render failed', error)
        }
      })
    } catch (error) {
      console.error('[慢半拍鋼琴 PDF] unable to start render', error)
    }
    return () => {
      disposed = true
      try { renderTaskRef.current?.cancel?.() } catch { /* render already complete */ }
    }
  }, [model.page, scale])

  const activeBox = model.boxes.find(box => box.measureIndex === cursorMeasureIndex)
  const cursorRowY = activeBox?.yTop ?? null
  const previousCursorRowYRef = useRef<number | null>(null)
  const smoothCursorInSameRow = cursorRowY !== null &&
    previousCursorRowYRef.current !== null &&
    Math.abs(previousCursorRowYRef.current - cursorRowY) < 3
  useEffect(() => {
    previousCursorRowYRef.current = cursorRowY
  }, [cursorRowY])
  const [hoveredMeasureIndex, setHoveredMeasureIndex] = useState<number | null>(null)
  const cursorX = activeBox
    ? resolveCursorX(activeBox, cursorProgress, cursorAnchorTimes, cursorAnchorPositions)
    : 0
  const width = model.width * scale
  const height = model.height * scale

  // The previous transparent buttons only covered an estimated rectangle derived from the
  // printed bar number; on some piano exports this missed the actual staff area. Handle clicks
  // once at page level instead: choose the closest mapped system vertically, then its measure
  // by horizontal position. This makes most of the visible staff system an active seek surface.
  const measureAtPoint = (clientX: number, clientY: number): MeasureBox | null => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || !model.boxes.length || rect.width <= 0 || rect.height <= 0) return null
    const x = (clientX - rect.left) / scale
    const y = (clientY - rect.top) / scale
    const verticalDistance = (box: MeasureBox) => y < box.yTop ? box.yTop - y : y > box.yBottom ? y - box.yBottom : 0
    const closestVertical = Math.min(...model.boxes.map(verticalDistance))
    // Ignore page title/margin clicks that are far away from any system.
    if (closestVertical > 58) return null
    const rowAnchor = model.boxes.reduce((best, box) => verticalDistance(box) < verticalDistance(best) ? box : best, model.boxes[0])
    const row = model.boxes.filter(box => Math.abs(box.yTop - rowAnchor.yTop) <= 3 && Math.abs(box.yBottom - rowAnchor.yBottom) <= 8)
    const candidates = row.length ? row : [rowAnchor]
    // Do not assign the nearest measure for arbitrary whitespace: that creates hover boxes
    // that visibly spill across a printed barline. Accept only the box bounded by the measured
    // barlines, with a 2.5 pt tolerance for antialiasing and mouse precision.
    const exact = candidates.find(box => x >= box.xStart - 2.5 && x <= box.xEnd + 2.5)
    return exact ?? null
  }
  const onPageClick = (event: MouseEvent<HTMLDivElement>) => {
    const box = measureAtPoint(event.clientX, event.clientY)
    if (box) onMeasureClick(box.measureIndex)
  }
  const onPageMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const box = measureAtPoint(event.clientX, event.clientY)
    setHoveredMeasureIndex(box?.measureIndex ?? null)
  }
  const hoveredBox = model.boxes.find(box => box.measureIndex === hoveredMeasureIndex)

  return (
    <div
      className="piano-pdf-page"
      data-piano-pdf-page={model.pageNumber}
      onClick={onPageClick}
      onMouseMove={onPageMouseMove}
      onMouseLeave={() => setHoveredMeasureIndex(null)}
          title={hoveredBox ? `PDF 小節 ${hoveredBox.printedNumber} · MusicXML ${hoveredBox.xmlNumber ?? hoveredBox.measureIndex + 1} · 點擊跳轉播放` : undefined}
      style={{ width, height, position: 'relative', flex: '0 0 auto', background: '#fff', boxShadow: '0 7px 26px rgba(0,0,0,.26)', margin: '0 auto', cursor: hoveredBox ? 'pointer' : 'default', touchAction: 'manipulation' }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width, height, background: '#fff', imageRendering: 'auto' }} />
      {model.boxes.map(box => (
        <div
          key={`${model.pageNumber}-${box.measureIndex}`}
          data-pdf-measure-index={box.measureIndex}
          aria-hidden="true"
          style={{
            position: 'absolute', zIndex: 2, pointerEvents: 'none',
            left: box.xStart * scale, top: box.yTop * scale,
            width: Math.max(8, (box.xEnd - box.xStart) * scale),
            height: Math.max(12, (box.yBottom - box.yTop) * scale),
            borderRadius: 2,
            background: hoveredMeasureIndex === box.measureIndex ? 'rgba(211,166,78,0.075)' : 'transparent',
            boxShadow: hoveredMeasureIndex === box.measureIndex ? 'inset 1px 0 rgba(211,166,78,.78), inset -1px 0 rgba(211,166,78,.78)' : 'none',
          }}
        />
      ))}
      {showMappingDebug && model.boxes.map(box => (
        <div
          key={`xml-map-${model.pageNumber}-${box.measureIndex}`}
          aria-hidden="true"
          title={`此區域對應 MusicXML 小節 ${box.xmlNumber ?? box.measureIndex + 1}`}
          style={{
            position: 'absolute', zIndex: 5, pointerEvents: 'none',
            left: Math.min(width - 46, Math.max(0, (box.xStart + box.xEnd) / 2 * scale - 20)),
            top: Math.max(1, box.yTop * scale + 2),
            minWidth: 40, padding: '2px 4px', boxSizing: 'border-box',
            borderRadius: 4, border: '1px solid rgba(20,35,50,.45)',
            background: 'rgba(11,16,23,.82)', color: '#f5d99f',
            font: '10px/1.2 system-ui, sans-serif', textAlign: 'center',
          }}
        >
          XML {box.xmlNumber ?? box.measureIndex + 1}
        </div>
      ))}
      {chordLabels.filter(label => model.boxes.some(box => box.measureIndex === label.measureIndex)).map(label => {
        const box = model.boxes.find(item => item.measureIndex === label.measureIndex)
        if (!box) return null
        const combined = Boolean(label.symbol || label.roman)
        const availableWidth = Math.max(32, (box.xEnd - box.xStart - 10) * scale)
        return <div key={label.id} title={label.title} aria-hidden="true" style={{
          position: 'absolute', zIndex: 6, pointerEvents: 'none',
          // Match the fingerstyle badge: right-align it just before this measure's ending barline.
          left: box.xEnd * scale - 3,
          top: Math.max(0, (box.yTop - 18) * scale),
          transform: 'translateX(-100%)',
          maxWidth: availableWidth, boxSizing: 'border-box',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          padding: '2px 5px', borderRadius: 5,
          border: '1px solid rgba(161,129,65,.6)', background: 'rgba(255,250,233,.94)',
          color: '#44371f', font: `750 ${Math.max(8, 8.6 * scale)}px/1.1 system-ui, sans-serif`,
          boxShadow: '0 1px 3px rgba(0,0,0,.15)',
        }}>
          {combined ? <>
            {label.symbol && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 800 }}>{label.symbol}</span>}
            {label.roman && <span style={{ flexShrink: 0, color: '#7c6230', fontSize: Math.max(7, 7.4 * scale), fontWeight: 650 }}>{label.roman}</span>}
          </> : <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label.text}</span>}
        </div>
      })}
      {activeBox && (
        <div aria-hidden="true" style={{
          position: 'absolute', zIndex: 4, pointerEvents: 'none',
          left: 0, top: activeBox.yTop * scale,
          transform: `translate3d(${cursorX * scale}px, 0, 0)`,
          transition: smoothCursorInSameRow ? 'transform 82ms linear' : 'none',
          willChange: 'transform',
          width: 2, height: (activeBox.yBottom - activeBox.yTop) * scale,
          background: '#d3a64e', opacity: 0.94,
          boxShadow: '0 0 .5px rgba(111,77,22,.9), 0 0 5px rgba(211,166,78,.3)',
        }} />
      )}
    </div>
  )
}

// During MP3 playback cursorProgress changes many times per second. Only the page that
// contains the active measure needs to update its cursor line; other PDF canvases, hover
// layers, and debug labels remain mounted and skip those unrelated renders.
const MemoizedPianoPage = memo(PianoPage, (previous, next) => {
  if (
    previous.model !== next.model ||
    previous.scale !== next.scale ||
    previous.showMappingDebug !== next.showMappingDebug ||
    previous.chordLabels !== next.chordLabels ||
    previous.cursorAnchorTimes !== next.cursorAnchorTimes ||
    previous.cursorAnchorPositions !== next.cursorAnchorPositions ||
    previous.onMeasureClick !== next.onMeasureClick
  ) return false

  const previouslyActive = previous.cursorMeasureIndex >= 0 &&
    previous.model.boxes.some(box => box.measureIndex === previous.cursorMeasureIndex)
  const currentlyActive = next.cursorMeasureIndex >= 0 &&
    next.model.boxes.some(box => box.measureIndex === next.cursorMeasureIndex)

  if (!previouslyActive && !currentlyActive) return true
  return previous.cursorMeasureIndex === next.cursorMeasureIndex && previous.cursorProgress === next.cursorProgress
})

export default function PianoPdfScoreDisplay({
  fileUrl,
  measureCount,
  measureNumbers = [],
  systemStartIndices = [],
  cursorMeasureIndex,
  cursorProgress,
  cursorAnchorTimes,
  cursorAnchorPositions,
  zoom,
  autoFollow,
  showMappingDebug = false,
  chordLabels = [],
  onMeasureClick,
}: Props) {
  // PDF box geometry remains untouched; only the cursor's horizontal timing map uses note anchors.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(900)
  const [pageViewMode, setPageViewMode] = useState<'single' | 'double'>('single')
  const [pages, setPages] = useState<PageModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detectedCount, setDetectedCount] = useState(0)
  const [anchorCount, setAnchorCount] = useState(0)
  const [mappingMode, setMappingMode] = useState('')

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const update = () => setContainerWidth(Math.max(320, node.clientWidth || window.innerWidth - 32))
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
    setDetectedCount(0)
    setAnchorCount(0)
    setMappingMode('')

    const xmlSystemStarts = [...new Set(systemStartIndices
      .filter(index => Number.isInteger(index) && index >= 0 && index < measureCount))]
      .sort((a, b) => a - b)
    const hasXmlSystemLayout = xmlSystemStarts.length > 1
    const expectedPrintedStartNumbers = new Set(xmlSystemStarts
      .filter(index => index > 0)
      .map(index => normalizeMeasureNumberLabel(measureNumbers[index] ?? String(index + 1))))

    void (async () => {
      try {
        loadingTask = (pdfjsLib as any).getDocument({ url: fileUrl, withCredentials: true, disableRange: true, disableStream: true })
        const pdf = await loadingTask.promise
        const pageInfo: Array<{ pageNumber: number; page: any; width: number; height: number }> = []
        const pageLabelRows: LabelRow[][] = []
        const pageRasterSystems: RasterSystem[][] = []

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber)
          if (cancelled) return
          const viewport = page.getViewport({ scale: 1 })
          const textContent = await page.getTextContent()
          const labels: MeasureLabel[] = []
          for (const item of (textContent.items ?? []) as TextItemLike[]) {
            const raw = String(item.str ?? '').trim().replace(/[.。]$/, '')
            if (!/^\d{1,3}$/.test(raw) || !item.transform || item.transform.length < 6) continue
            const number = Number(raw)
            if (!Number.isInteger(number) || number < 0 || number > measureCount) continue
            const fontSize = Math.hypot(Number(item.transform[0]) || 0, Number(item.transform[1]) || 0)
            if (fontSize < 4.4 || fontSize > 13.5) continue
            const [x, baselineY] = viewport.convertToViewportPoint(Number(item.transform[4]), Number(item.transform[5]))
            const itemHeight = Number(item.height) > 0 ? Number(item.height) : fontSize * 1.2
            const top = baselineY - itemHeight
            // MuseScore puts the page number in the upper margin on pages 2+. It can
            // look exactly like a measure number (e.g. page "2"), so don't feed it into
            // system anchoring. In this export the first real system label starts below 54pt.
            if (top < 54 || top > viewport.height - 12 || x < 10 || x > viewport.width - 10) continue
            labels.push({ number, x, top, fontSize })
          }
          const sorted = labels.sort((a, b) => a.top - b.top || a.x - b.x)
          const rowGroups: LabelRow[] = []
          for (const label of sorted) {
            let row = rowGroups.find(candidate => Math.abs(candidate.top - label.top) <= 8)
            if (!row) {
              row = { pageIndex: pageNumber - 1, width: viewport.width, height: viewport.height, top: label.top, labels: [] }
              rowGroups.push(row)
            }
            row.labels.push(label)
          }
          const plausibleRows = rowGroups
            .map(row => ({ ...row, labels: row.labels.sort((a, b) => a.x - b.x) }))
            .filter(row => labelLooksLikeMeasureRow(row.labels) && (
              !hasXmlSystemLayout || expectedPrintedStartNumbers.has(normalizeMeasureNumberLabel(row.labels[0]?.number ?? ''))
            ))
          pageInfo.push({ pageNumber, page, width: viewport.width, height: viewport.height })
          pageLabelRows.push(plausibleRows)
          // Detect the visible piano grand-staff systems and actual vertical barlines from
          // the rendered PDF. This makes the first unnumbered pickup system clickable and
          // aligns hover/highlight rectangles to the printed barlines instead of equal-width guesses.
          const rasterSystems = await detectPianoSystems(
            page,
            pageNumber - 1,
            viewport.width,
            viewport.height,
            hasXmlSystemLayout ? plausibleRows : undefined,
            hasXmlSystemLayout && pageNumber === 1,
          )
          pageRasterSystems.push(rasterSystems)
        }

        // Build one ordered record per detected grand-staff system. If both exports contain
        // matching MuseScore system-break metadata, those exact XML indices win over all
        // raster estimates. Otherwise the compatibility fallback anchors the sequence to
        // PDF measure numbers and partitions the XML sequence between adjacent anchors.
        type SystemRecord = {
          pageIndex: number
          systemIndex: number
          system: RasterSystem
          key: string
          printedStartNumber: number | null
          anchorIndex: number | null
          startIndex: number
          measureCount: number
          rawGeometryCount: number
          repaired: boolean
        }
        const systemRecords: SystemRecord[] = []
        for (let pageIndex = 0; pageIndex < pageRasterSystems.length; pageIndex++) {
          const systems = pageRasterSystems[pageIndex]
          for (let systemIndex = 0; systemIndex < systems.length; systemIndex++) {
            const system = systems[systemIndex]
            const systemWidth = Math.max(1, system.xEnd - system.xStart)
            // Measure numbers usually sit just left of the first bar or above its first box.
            // Keep the vertical search narrow; a wide search was reusing the previous/next
            // system's label and generated backwards/overlapping XML ranges.
            const rowCandidates = (pageLabelRows[pageIndex] ?? [])
              .map(row => ({ row, distance: Math.abs(row.top - system.yTop) }))
              .filter(item => item.distance <= 32)
              .sort((a, b) => a.distance - b.distance)
            let printedStartNumber: number | null = null
            if (rowCandidates.length) {
              const row = rowCandidates[0].row
              const leftWindow = Math.max(28, Math.min(82, systemWidth * 0.16))
              const leftLabels = row.labels
                .filter(label => label.x >= system.xStart - 35 && label.x <= system.xStart + leftWindow)
                .sort((a, b) => Math.abs(a.x - system.xStart) - Math.abs(b.x - system.xStart))
              // When labels occur above every measure, only the one nearest the system's
              // left edge is the system-start anchor. Never use the whole row as independent
              // anchors, because false raster boundaries can associate later numbers wrongly.
              if (leftLabels.length) printedStartNumber = leftLabels[0].number
            }
            systemRecords.push({
              pageIndex,
              systemIndex,
              system,
              key: `${pageIndex}:${systemIndex}`,
              printedStartNumber,
              anchorIndex: null,
              startIndex: 0,
              measureCount: 0,
              rawGeometryCount: system.boxes.length,
              repaired: false,
            })
          }
        }

        const normalizeMeasureNumber = normalizeMeasureNumberLabel
        const matchingMeasureIndices = (number: number): number[] => {
          const target = String(number)
          const matches: number[] = []
          for (let index = 0; index < measureNumbers.length; index++) {
            if (normalizeMeasureNumber(measureNumbers[index] ?? String(index + 1)) === target) matches.push(index)
          }
          return matches
        }

        // For MuseScore PDF + MusicXML exports, the MusicXML <print new-system/new-page>
        // markers and the printed system-start numbers are the authoritative layout map.
        // Every system gets a non-overlapping interval [start, nextStart). No interpolation
        // is permitted between unrelated rows, and pickup measure "0" remains array index 0.
        const exactLayoutAvailable = hasXmlSystemLayout &&
          systemRecords.length === xmlSystemStarts.length &&
          pageLabelRows.flat().length === xmlSystemStarts.length - 1

        if (exactLayoutAvailable) {
          for (let index = 0; index < systemRecords.length; index++) {
            const record = systemRecords[index]
            const startIndex = xmlSystemStarts[index]
            const endIndex = xmlSystemStarts[index + 1] ?? measureCount
            record.startIndex = startIndex
            record.measureCount = Math.max(0, endIndex - startIndex)
            record.anchorIndex = startIndex
            const rawNumber = measureNumbers[startIndex] ?? String(startIndex + 1)
            const parsedNumber = Number(rawNumber)
            record.printedStartNumber = Number.isFinite(parsedNumber) ? parsedNumber : null
          }
        } else {
          // Compatibility fallback for PDFs whose page layout was not exported in MusicXML.
          // It is intentionally not used for the supplied MuseScore export when its anchors
          // are complete, because independent row estimation caused the prior overlap bug.
          let lastAnchorIndex = -1
          for (const record of systemRecords) {
            if (record.printedStartNumber === null) continue
            const matches = matchingMeasureIndices(record.printedStartNumber)
            let resolved = matches.find(index => index > lastAnchorIndex)
            const fallback = record.printedStartNumber - 1
            if (resolved === undefined && fallback > lastAnchorIndex && fallback >= 0 && fallback < measureCount) {
              resolved = fallback
            }
            if (resolved === undefined || resolved < 0 || resolved >= measureCount) continue
            record.anchorIndex = resolved
            lastAnchorIndex = resolved
          }

          const allocateCounts = (total: number, records: SystemRecord[]): number[] => {
            if (!records.length || total <= 0) return records.map(() => 0)
            const weights = records.map(record => Math.max(1, record.system.xEnd - record.system.xStart))
            const sum = weights.reduce((a, b) => a + b, 0)
            const raw = weights.map(weight => total * weight / sum)
            const counts = raw.map(value => Math.floor(value))
            const remaining = total - counts.reduce((a, b) => a + b, 0)
            const order = raw.map((value, index) => ({ index, fraction: value - counts[index] }))
              .sort((a, b) => b.fraction - a.fraction)
            for (let i = 0; i < remaining; i++) counts[order[i % order.length].index]++
            return counts
          }

          const anchorPositions = systemRecords
            .map((record, index) => ({ index, anchorIndex: record.anchorIndex }))
            .filter(item => item.anchorIndex !== null) as Array<{ index: number; anchorIndex: number }>
          if (!anchorPositions.length) {
            const counts = allocateCounts(measureCount, systemRecords)
            let next = 0
            systemRecords.forEach((record, index) => {
              record.startIndex = next
              record.measureCount = counts[index]
              next += counts[index]
            })
          } else {
            const first = anchorPositions[0]
            if (first.index > 0 && first.anchorIndex > 0) {
              const prefix = systemRecords.slice(0, first.index)
              const counts = allocateCounts(first.anchorIndex, prefix)
              let next = 0
              prefix.forEach((record, index) => {
                record.startIndex = next
                record.measureCount = counts[index]
                next += counts[index]
              })
            }
            systemRecords[first.index].startIndex = first.anchorIndex

            for (let anchorPosition = 0; anchorPosition < anchorPositions.length - 1; anchorPosition++) {
              const leftAnchor = anchorPositions[anchorPosition]
              const rightAnchor = anchorPositions[anchorPosition + 1]
              const segment = systemRecords.slice(leftAnchor.index, rightAnchor.index)
              const span = Math.max(0, rightAnchor.anchorIndex - leftAnchor.anchorIndex)
              const counts = allocateCounts(span, segment)
              let next = leftAnchor.anchorIndex
              segment.forEach((record, index) => {
                record.startIndex = next
                record.measureCount = counts[index]
                next += counts[index]
              })
              systemRecords[rightAnchor.index].startIndex = rightAnchor.anchorIndex
            }

            const last = anchorPositions[anchorPositions.length - 1]
            const tail = systemRecords.slice(last.index)
            const tailCounts = allocateCounts(Math.max(0, measureCount - last.anchorIndex), tail)
            let next = last.anchorIndex
            tail.forEach((record, index) => {
              record.startIndex = next
              record.measureCount = tailCounts[index]
              next += tailCounts[index]
            })
          }
        }

        // Choose exactly the required number of bar intervals from the detected vertical lines.
        // If line detection returned too many candidates, a small dynamic program picks the
        // subset whose widths are most consistent with this system. If too few exist, use a
        // per-system even-width fallback rather than stealing measures from the next system.
        const fitSystemBoundaries = (system: RasterSystem, count: number): number[] => {
          const left = system.xStart
          const right = system.xEnd
          if (count <= 0 || right <= left) return []
          if (count === 1) return [left, right]
          const candidates = [left]
          const innerCandidates = system.barXs
            .filter(x => x > left + 7 && x < right - 7)
            .sort((a, b) => a - b)
          for (const x of innerCandidates) {
            if (x - candidates[candidates.length - 1] >= 7 && right - x >= 7) candidates.push(x)
          }
          // Preserve both endpoints even when a detected barline sits very close to the edge.
          candidates.push(right)
          if (candidates.length === count + 1) return candidates
          if (candidates.length < count + 1) {
            // Preserve every confidently detected barline. Insert evenly spaced estimated
            // boundaries only inside a gap that has too few detected lines, rather than
            // replacing the entire system with equal-width measures.
            const slots = Array(Math.max(0, candidates.length - 1)).fill(1) as number[]
            let missing = count - slots.length
            while (missing > 0 && slots.length > 0) {
              let bestGap = 0
              let bestWidth = -1
              for (let gap = 0; gap < slots.length; gap++) {
                const width = (candidates[gap + 1] - candidates[gap]) / slots[gap]
                if (width > bestWidth) { bestWidth = width; bestGap = gap }
              }
              slots[bestGap]++
              missing--
            }
            const repaired = [left]
            for (let gap = 0; gap < slots.length; gap++) {
              const a = candidates[gap]
              const b = candidates[gap + 1]
              for (let part = 1; part <= slots[gap]; part++) repaired.push(a + (b - a) * part / slots[gap])
            }
            return repaired.slice(0, count + 1)
          }
          const average = (right - left) / count
          const n = candidates.length
          const dp: number[][] = Array.from({ length: count + 1 }, () => Array(n).fill(Number.POSITIVE_INFINITY))
          const previous: number[][] = Array.from({ length: count + 1 }, () => Array(n).fill(-1))
          dp[0][0] = 0
          for (let segments = 1; segments <= count; segments++) {
            const minJ = segments
            const maxJ = n - 1 - (count - segments)
            for (let j = minJ; j <= maxJ; j++) {
              for (let i = segments - 1; i < j; i++) {
                if (!Number.isFinite(dp[segments - 1][i])) continue
                const width = candidates[j] - candidates[i]
                if (width < 10) continue
                const ratio = width / Math.max(1, average)
                let cost = Math.log(ratio) ** 2
                if (ratio < 0.48) cost += 1.5
                if (ratio > 2.1) cost += 1.0
                const proposed = dp[segments - 1][i] + cost
                if (proposed < dp[segments][j]) {
                  dp[segments][j] = proposed
                  previous[segments][j] = i
                }
              }
            }
          }
          if (!Number.isFinite(dp[count][n - 1])) {
            return Array.from({ length: count + 1 }, (_, index) => left + (right - left) * index / count)
          }
          const selected = Array(count + 1).fill(0)
          let cursor = n - 1
          for (let segments = count; segments >= 1; segments--) {
            selected[segments] = candidates[cursor]
            cursor = previous[segments][cursor]
          }
          selected[0] = left
          selected[count] = right
          return selected
        }

        const builtBoxesByPage = new Map<number, MeasureBox[]>()
        let geometryMismatchCount = 0
        let unanchoredSystemCount = 0
        for (const record of systemRecords) {
          if (record.anchorIndex === null) unanchoredSystemCount++
          const count = Math.max(0, Math.min(record.measureCount, measureCount - record.startIndex))
          const availableInnerCandidates = record.system.barXs
            .filter(x => x > record.system.xStart + 7 && x < record.system.xEnd - 7).length
          if (exactLayoutAvailable) {
            if (count > 1 && availableInnerCandidates !== count - 1) geometryMismatchCount++
            record.repaired = count > 1 && availableInnerCandidates !== count - 1
          } else {
            if (Math.abs(record.rawGeometryCount - count) > 1 || availableInnerCandidates !== count - 1) geometryMismatchCount++
            record.repaired = record.rawGeometryCount !== count || availableInnerCandidates !== count - 1
          }
          if (count <= 0) continue
          const boundaries = fitSystemBoundaries(record.system, count)
          const list = builtBoxesByPage.get(record.pageIndex) ?? []
          for (let offset = 0; offset < count; offset++) {
            const xStart = boundaries[offset]
            const xEnd = boundaries[offset + 1]
            if (!(xEnd > xStart)) continue
            const measureIndex = record.startIndex + offset
            const xmlNumber = String(measureNumbers[measureIndex] ?? measureIndex + 1)
            const numericXmlNumber = Number(xmlNumber)
            list.push({
              measureIndex,
              printedNumber: Number.isFinite(numericXmlNumber) ? numericXmlNumber : measureIndex + 1,
              xmlNumber,
              xStart,
              xEnd,
              yTop: record.system.yTop,
              yBottom: record.system.yBottom,
            })
          }
          builtBoxesByPage.set(record.pageIndex, list)
        }
        const labelAnchorCount = systemRecords.filter(record => record.anchorIndex !== null).length

        const rasterCount = systemRecords.reduce((sum, record) => sum + record.rawGeometryCount, 0)
        const geometrySource = systemRecords.length > 0 ? 'raster+labels' : 'labels'
        const built: PageModel[] = pageInfo.map(page => ({
          ...page,
          boxes: (builtBoxesByPage.get(page.pageNumber - 1) ?? []).sort((a, b) => a.measureIndex - b.measureIndex),
        }))
        const mapped = built.reduce((sum, page) => sum + page.boxes.length, 0)
        if (!cancelled) {
          setPages(built)
          setDetectedCount(mapped)
          setAnchorCount(labelAnchorCount)
          if (!mapped) {
            setError('PDF 已載入，但未能識別鋼琴大譜表與小節線。原譜仍可查看；本次無法可靠建立小節點擊區。')
            setMappingMode('未檢測到大譜表／小節線')
          } else if (exactLayoutAvailable) {
            setMappingMode(`MusicXML 原始斷行錨定 · ${xmlSystemStarts.length} 個系統 · 小節編號連續分配`)
            if (mapped !== measureCount) {
              setError(`已從 MusicXML 的原始系統斷行標記建立 PDF 對照，但只生成 ${mapped}/${measureCount} 個小節區。這通常代表某一行缺少可用的橫向邊界，請查看逐頁摘要。`)
            } else if (geometryMismatchCount > 0) {
              setError(`已根據同一份 MuseScore 導出的 MusicXML 斷行標記，連續映射 ${mapped}/${measureCount} 個小節，沒有跨譜行重複分配。${geometryMismatchCount} 行的豎線候選不足，該行內部位置使用等寬近似；這只影響小節內橫向高亮位置，不會改變小節編號。`)
            }
          } else if (geometrySource === 'raster+labels') {
            setMappingMode(`按系統順序約束映射 · 起始編號錨點 ${labelAnchorCount} · 局部校正 ${geometryMismatchCount} 行`)
            if (mapped < measureCount || geometryMismatchCount > 0 || unanchoredSystemCount > 0) setError(`已將 PDF 系統按閱讀順序切分，避免 XML 小節跨譜行重複。原始偵測到 ${rasterCount} 個幾何區，系統起始小節錨點 ${labelAnchorCount} 個，建立 ${mapped}/${measureCount} 個區域；${geometryMismatchCount} 行的幾何分段數與 XML 預期數不一致，${unanchoredSystemCount} 行沒有直接編號錨點，已在局部採用邊界篩選／等寬補齊。這些行仍需對照原譜核驗。`)
          } else if (mapped < measureCount) {
            setMappingMode(`系統順序估算 · 起始編號錨點 ${labelAnchorCount}`)
            setError(`已建立 ${mapped}/${measureCount} 個小節區，但 PDF 標號錨點不足，無法保證頁碼和小節序號完全一致。首行弱起小節可能需要檢查。`)
          } else {
            setMappingMode(`系統順序估算 · 起始編號錨點 ${labelAnchorCount}`)
            setError(`映射區域已按 XML 順序建立，但目前只有 ${labelAnchorCount} 個系統起始編號錨點；請先檢查黑金 XML 編號是否逐行連續，再測試播放高亮。`)
          }
          setLoading(false)
        }
      } catch (loadError) {
        if (cancelled) return
        console.error('[慢半拍鋼琴 PDF] load failed', loadError)
        setError(loadError instanceof Error ? loadError.message : '無法載入鋼琴 PDF 原譜。')
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      try { void loadingTask?.destroy?.() } catch { /* ignore teardown races */ }
    }
  }, [fileUrl, measureCount, measureNumbers.join('|'), systemStartIndices.join('|')])

  useEffect(() => {
    if (!autoFollow || loading || cursorMeasureIndex < 0 || typeof window === 'undefined') return

    // Wait one frame so the newly highlighted row has finished laying out, then place
    // the whole measure/system row at the vertical center of the viewport.
    const frameId = window.requestAnimationFrame(() => {
      const node = containerRef.current?.querySelector<HTMLElement>(`[data-pdf-measure-index="${cursorMeasureIndex}"]`)
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

  const cursorIsMapped = useMemo(() => pages.some(page => page.boxes.some(box => box.measureIndex === cursorMeasureIndex)), [pages, cursorMeasureIndex])
  const mappingSummary = useMemo(() => pages.map(page => {
    const rows: Array<{ y: number; boxes: MeasureBox[] }> = []
    for (const box of [...page.boxes].sort((a, b) => a.yTop - b.yTop || a.xStart - b.xStart)) {
      let row = rows.find(item => Math.abs(item.y - box.yTop) <= 10)
      if (!row) { row = { y: box.yTop, boxes: [] }; rows.push(row) }
      row.boxes.push(box)
    }
    const rowText = rows.map((row, index) => {
      const indices = row.boxes.map(box => box.measureIndex).filter(Number.isFinite).sort((a, b) => a - b)
      const orderedBoxes = [...row.boxes].sort((a, b) => a.measureIndex - b.measureIndex)
      const firstXmlNumber = orderedBoxes[0]?.xmlNumber ?? String(indices[0] + 1)
      const lastXmlNumber = orderedBoxes[orderedBoxes.length - 1]?.xmlNumber ?? String(indices[indices.length - 1] + 1)
      return indices.length
        ? `S${index + 1} XML ${firstXmlNumber}–${lastXmlNumber}（${row.boxes.length}區）`
        : `S${index + 1} 無對應區`
    })
    return rowText.length ? `P${page.pageNumber}: ${rowText.join(' / ')}` : `P${page.pageNumber}: 無對應區`
  }).join(' · '), [pages])
  const widestPageWidth = pages.length ? Math.max(...pages.map(page => page.width)) : 1
  const pagesPerSpread = pageViewMode === 'double' ? 2 : 1
  const spreadWidth = widestPageWidth * pagesPerSpread + (pagesPerSpread - 1) * 14
  const fitScale = pages.length && containerWidth > 0
    ? Math.min(1.65, Math.max(0.24, (containerWidth - 10) / spreadWidth))
    : 1
  const scale = fitScale * clamp(zoom / 100, 0.5, 1.75)

  return (
    <section aria-label="鋼琴 PDF 原譜與 MIDI 小節同步" style={{ width: '100%', boxSizing: 'border-box', margin: '8px 0 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, color: '#9aa8b7', fontSize: 11, lineHeight: 1.5, margin: '0 0 10px' }}>
        <span>鋼琴雙五線譜 · 原始 PDF · MIDI 播放時鐘 · PDF/XML 小節對照</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div role="group" aria-label="鋼琴譜頁面顯示方式" style={{ display: 'inline-flex', gap: 3, padding: 2, border: '1px solid rgba(217,183,121,.28)', borderRadius: 7, background: 'rgba(255,255,255,.025)' }}>
            {([{ value: 'single', label: '單頁' }, { value: 'double', label: '雙頁' }] as const).map(option => (
              <button key={option.value} type="button" onClick={() => setPageViewMode(option.value)} aria-pressed={pageViewMode === option.value} style={{
                border: pageViewMode === option.value ? '1px solid rgba(217,183,121,.55)' : '1px solid transparent',
                borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 10.5, lineHeight: 1.35,
                background: pageViewMode === option.value ? 'rgba(217,183,121,.17)' : 'transparent',
                color: pageViewMode === option.value ? '#f1d99b' : '#9aa8b7',
              }}>{option.label}</button>
            ))}
          </div>
          <span>{loading ? '正在讀取 PDF…' : `頁數 ${pages.length} · 小節定位 ${detectedCount}/${measureCount} · 系統錨點 ${anchorCount} · ${mappingMode}`}</span>
        </div>
      </div>
      {showMappingDebug && !loading && <div style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(217,183,121,.2)', background: 'rgba(217,183,121,.05)', color: '#d9c59d', fontSize: 10.5, lineHeight: 1.6, overflowWrap: 'anywhere' }}>逐頁／逐譜行映射：{mappingSummary || '尚未建立'}。黑金標記顯示 MusicXML 原始小節編號（含弱起小節 0），播放跳轉仍使用 XML 陣列索引；行與行之間優先按源 XML 的斷行標記鎖定。</div>}
      {error && <div role="status" style={{ margin: '0 0 10px', padding: '9px 11px', borderRadius: 8, background: 'rgba(226,186,114,.08)', color: '#e2ba72', fontSize: 11.5, lineHeight: 1.55 }}>{error}</div>}
      {loading && <div style={{ padding: 20, textAlign: 'center', color: '#b7c4d3' }}>正在載入鋼琴原譜…</div>}
      <div ref={containerRef} className="piano-pdf-pages" style={{
        width: '100%', boxSizing: 'border-box',
        display: pageViewMode === 'double' ? 'grid' : 'flex',
        gridTemplateColumns: pageViewMode === 'double' ? 'repeat(2, minmax(0, 1fr))' : undefined,
        flexDirection: pageViewMode === 'single' ? 'column' : undefined,
        justifyItems: pageViewMode === 'double' ? 'center' : undefined,
        alignItems: 'center', gap: pageViewMode === 'double' ? 14 : 20,
        overflow: 'visible',
      }}>
        {pages.map(page => <MemoizedPianoPage key={page.pageNumber} model={page} scale={scale} cursorMeasureIndex={cursorMeasureIndex} cursorProgress={cursorProgress} cursorAnchorTimes={cursorAnchorTimes} cursorAnchorPositions={cursorAnchorPositions} showMappingDebug={showMappingDebug} chordLabels={chordLabels} onMeasureClick={onMeasureClick} />)}
      </div>
      {!loading && mappedNotEnough(detectedCount, measureCount) && (
        <p style={{ margin: '9px 2px 0', color: '#9aa8b7', fontSize: 11, lineHeight: 1.55 }}>
          首輪鋼琴模式使用小節編號建立點擊區，進度線在小節區域內以時間比例移動。尚未自動識別五線譜符頭的精確像素位置，因此暫不標記為逐符頭精準對齊。
        </p>
      )}
      {!cursorIsMapped && !loading && detectedCount > 0 && <p style={{ margin: '8px 2px 0', color: '#9aa8b7', fontSize: 11 }}>目前播放位置尚未匹配到 PDF 小節；原譜頁面不會被修改。</p>}
      <style>{`.piano-pdf-page canvas { display:block; } .piano-pdf-page { -webkit-tap-highlight-color: transparent; }`}</style>
    </section>
  )
}

function mappedNotEnough(detectedCount: number, measureCount: number) {
  return detectedCount < measureCount
}
