import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ManbanpaiThemeToggle, useManbanpaiTheme } from './ManbanpaiTheme'
import FingerstylePdfScoreDisplay from './FingerstylePdfScoreDisplay'
import PlaybackControlBar from './PlaybackControlBar'
import ScoreHeaderControls from './ScoreHeaderControls'
import GuitarSettingsPanel from './GuitarSettingsPanel'
import { analyseMusicXmlTheory, applyTheoryChordCorrections, theoryPitchClassFromName, type ScoreTheoryAnalysis, type TheoryMeasureInfo } from './FingerstyleTheoryAnalysis'

function usePdfPageAnchoredTheoryHud(
  rootRef: { current: HTMLDivElement | null },
  pageSelector: string,
  enabled: boolean,
  expanded: boolean,
) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return
    let frame = 0
    const update = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const page = root.querySelector<HTMLElement>(pageSelector)
        const hud = root.querySelector<HTMLElement>('.score-room-current-theory-hud')
        if (!page || !hud) return
        const pageRect = page.getBoundingClientRect()
        const rootRect = root.getBoundingClientRect()
        if (pageRect.width <= 0 || pageRect.height <= 0 || rootRect.height <= 0) {
          hud.style.visibility = 'hidden'
          hud.style.pointerEvents = 'none'
          return
        }

        const inset = 8
        const isCompact = hud.dataset.compact === 'true'
        const widthLimit = Math.max(0, pageRect.width - inset * 2)
        const pageTop = Math.max(8, pageRect.top + inset)

        // Anchor the card's border inside the actual white PDF page, not the full-width reader wrapper.
        hud.style.position = 'fixed'
        hud.style.left = `${pageRect.left + inset}px`
        hud.style.right = 'auto'
        hud.style.top = `${pageTop}px`
        hud.style.bottom = 'auto'
        hud.style.transform = 'none'
        hud.style.margin = '0'
        hud.style.gridArea = 'auto'
        hud.style.justifySelf = 'auto'
        hud.style.alignSelf = 'auto'
        hud.style.zIndex = '1190'
        hud.style.boxSizing = 'border-box'
        if (isCompact) {
          // Paused: size to the two-line summary's content, capped to keep the HUD compact.
          hud.style.maxWidth = `${Math.min(270, widthLimit)}px`
          hud.style.width = 'max-content'
        } else {
          // Playing: expand to the full current-measure summary.
          hud.style.maxWidth = `${widthLimit}px`
          hud.style.width = `${Math.min(390, widthLimit)}px`
        }
        hud.style.maxHeight = 'none'
        hud.style.overflow = 'hidden'
        hud.style.overflowY = 'hidden'

        const cardRect = hud.getBoundingClientRect()
        // When close to the end of the score, keep the card within the reader's full scroll range.
        const top = Math.min(pageTop, rootRect.bottom - cardRect.height - inset)
        const left = Math.max(pageRect.left + inset, Math.min(pageRect.right - cardRect.width - inset, pageRect.left + inset))
        hud.style.left = `${left}px`
        hud.style.top = `${top}px`
        const visible = rootRect.bottom > 0 && rootRect.top < window.innerHeight && top + cardRect.height > 0 && top < window.innerHeight
        hud.style.visibility = visible ? 'visible' : 'hidden'
        hud.style.pointerEvents = visible ? 'auto' : 'none'
      })
    }

    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (resizeObserver) resizeObserver.observe(root)
    update()
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      if (frame) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
    }
  }, [rootRef, pageSelector, enabled, expanded])
}

type XmlNoteEvent = {
  onsetQuarter: number
  /** All notated pitches at this onset, used for score-position anchors. */
  pitches: number[]
  /** Only pitches that should create a fresh attack; tie continuations are excluded. */
  matchPitches: number[]
}

type MeasureInfo = {
  index: number
  printedNumber: string
  durationQuarter: number
  tempo: number
  durationSeconds: number
  /** Distinct MusicXML attacks with pitches, including chord tones at a shared onset. */
  noteOnsetsQuarter: number[]
  noteEvents: XmlNoteEvent[]
}

type ScheduledMeasure = {
  occurrence: number
  measureIndex: number
  printedNumber: string
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  /** Per-note normalized times from matched MIDI note-on events. */
  noteAnchorTimes: number[]
  matchedNoteEvents: number
}

type ParsedScore = {
  measures: MeasureInfo[]
  playbackOrder: number[]
  repeatDescription: string
  theoreticalDurationSeconds: number
  meter: string
}

/**
 * Load the local test MusicXML robustly. Windows can hide file extensions, so users may
 * have placed `fingerstyle.xml` even though the demo route's primary name is `.musicxml`.
 * Pages dev may also return the SPA index.html with HTTP 200 for a missing static file;
 * detect that explicitly instead of surfacing the misleading generic XML parse error.
 */
async function fetchFingerstyleMusicXml(xmlUrl: string): Promise<{ text: string; url: string }> {
  const candidates = [xmlUrl]
  if (/\.musicxml(?=([?#]|$))/i.test(xmlUrl)) candidates.push(xmlUrl.replace(/\.musicxml(?=([?#]|$))/i, '.xml'))
  else if (/\.xml(?=([?#]|$))/i.test(xmlUrl)) candidates.push(xmlUrl.replace(/\.xml(?=([?#]|$))/i, '.musicxml'))
  const uniqueCandidates = [...new Set(candidates)]
  const failures: string[] = []

  for (const candidate of uniqueCandidates) {
    let response: Response
    try {
      response = await fetch(candidate, { cache: 'no-store', credentials: 'same-origin' })
    } catch (error) {
      failures.push(`${candidate}（讀取失敗：${error instanceof Error ? error.message : '網路錯誤'}）`)
      continue
    }
    if (!response.ok) {
      failures.push(`${candidate}（HTTP ${response.status}）`)
      continue
    }
    const text = await response.text()
    const trimmed = text.replace(/^\uFEFF/, '').trimStart()
    const contentType = response.headers.get('content-type') ?? ''
    if (/text\/html/i.test(contentType) || /^<!doctype\s+html|^<html(?:\s|>)/i.test(trimmed)) {
      failures.push(`${candidate}（伺服器回傳 HTML 而非 XML，通常代表該路徑下找不到檔案）`)
      continue
    }
    const parsed = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ''), 'application/xml')
    const parseError = parsed.querySelector('parsererror')
    if (parseError || parsed.documentElement?.localName?.toLowerCase() === 'parsererror') {
      const detail = (parseError?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 180)
      failures.push(`${candidate}（XML 語法錯誤${detail ? `：${detail}` : ''}）`)
      continue
    }
    const rootName = parsed.documentElement?.localName?.toLowerCase() ?? ''
    if (rootName !== 'score-partwise' && rootName !== 'score-timewise') {
      failures.push(`${candidate}（根節點是「${rootName || '空白'}」，不是 score-partwise/score-timewise MusicXML）`)
      continue
    }
    return { text, url: candidate }
  }

  throw new Error(
    `無法載入有效的指彈 MusicXML。已檢查：${failures.join('；')}。請確認文件實際位於專案的 public\fingerstyle-pdf-mp3-test\ 資料夾，檔名是 fingerstyle.musicxml 或 fingerstyle.xml。若 Windows 隱藏副檔名，請開啟「檢視 → 顯示 → 副檔名」，確認不是 fingerstyle.musicxml.xml。`
  )
}

type MidiOnsetGroup = {
  tick: number
  seconds: number
  pitches: number[]
}

type MidiNoteTrack = {
  trackIndex: number
  name: string
  onsets: MidiOnsetGroup[]
}

type MidiTiming = {
  durationSeconds: number
  ppq: number | null
  tempoEvents: number
  tracks: number
  noteTracks: MidiNoteTrack[]
}

type PlaybackXmlEvent = {
  sequenceIndex: number
  occurrence: number
  measureIndex: number
  onsetQuarter: number
  pitches: number[]
}

type MidiEventMatch = {
  midiEventIndex: number
  seconds: number
  similarity: number
}

type MidiAlignment = {
  xmlEvents: PlaybackXmlEvent[]
  matchedByXmlIndex: Array<MidiEventMatch | null>
  trackLabel: string
  pitchShift: number
  matchedCount: number
  strongMatchCount: number
  coveragePct: number
  strongCoveragePct: number
  score: number
}

function cursorKeyAtTime(schedule: ScheduledMeasure[], time: number): string {
  if (!schedule.length) return ''

  // Schedules are ordered by playback time. Binary search avoids scanning every bar
  // on every display refresh while audio continues playing.
  let low = 0
  let high = schedule.length - 1
  let item: ScheduledMeasure | undefined
  while (low <= high) {
    const middle = (low + high) >>> 1
    const candidate = schedule[middle]
    if (time < candidate.startSeconds) {
      high = middle - 1
    } else if (time >= candidate.endSeconds) {
      low = middle + 1
    } else {
      item = candidate
      break
    }
  }

  if (!item) {
    item = time >= schedule[schedule.length - 1].endSeconds
      ? schedule[schedule.length - 1]
      : schedule[0]
  }
  return `${item.occurrence}:${item.measureIndex}`
}

function getFingerstyleTheoryCorrectionsKey(pdfUrl: string, xmlUrl: string): string {
  return `manbanpai:fingerstyle-pdf-mp3-theory-corrections:v1:${pdfUrl}|${xmlUrl}`
}
type TheoryDisplayMode = 'none' | 'chordNames' | 'bassLine' | 'nonChordHints' | 'melodyContour'

function theoryCorrectionKey(sourceIndex: number, onsetQuarter: number): string {
  return `${sourceIndex}:${Math.round(onsetQuarter * 10000) / 10000}`
}

const nightColors = {
  bg: '#0b1017',
  panel: '#111923',
  panelSoft: '#182331',
  line: 'rgba(217,183,121,.32)',
  gold: '#d9b779',
  text: '#edf2f8',
  muted: '#b7c4d3',
  soft: '#8f9eae',
  warn: '#e2ba72',
}

const dayColors = {
  bg: '#f3f0e8',
  panel: '#fffdf7',
  panelSoft: '#f2ede3',
  line: 'rgba(141,106,50,.28)',
  gold: '#8d6a32',
  text: '#2c3331',
  muted: '#5f6965',
  soft: '#78817b',
  warn: '#986b31',
}


function directChildren(node: Element, localName: string): Element[] {
  return Array.from(node.children).filter(child => child.localName === localName)
}

function firstChild(node: Element, localName: string): Element | null {
  return directChildren(node, localName)[0] ?? null
}

function descendants(node: Element, localName: string): Element[] {
  return Array.from(node.getElementsByTagName('*')).filter(child => child.localName === localName)
}

function textOf(node: Element | null | undefined): string {
  return node?.textContent?.trim() ?? ''
}

function readTempoInMeasure(measure: Element, priorTempo: number): number {
  let tempo = priorTempo
  for (const direction of directChildren(measure, 'direction')) {
    for (const sound of directChildren(direction, 'sound')) {
      const value = Number(sound.getAttribute('tempo'))
      if (Number.isFinite(value) && value > 0) tempo = value
    }
    for (const metronome of descendants(direction, 'metronome')) {
      const perMinute = Number(textOf(firstChild(metronome, 'per-minute')))
      const beatUnit = textOf(firstChild(metronome, 'beat-unit'))
      if (Number.isFinite(perMinute) && perMinute > 0) {
        // MusicXML sound tempo is quarter-notes per minute. Convert common non-quarter metronome units.
        const quarterUnits: Record<string, number> = {
          maxima: 8, long: 4, breve: 2, whole: 4, half: 2,
          quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625,
        }
        tempo = perMinute * (quarterUnits[beatUnit] ?? 1)
      }
    }
  }
  return tempo
}

function measureDurationInQuarters(measure: Element, initialDivisions: number): number {
  let divisions = initialDivisions
  const attributes = directChildren(measure, 'attributes')
  for (const item of attributes) {
    const value = Number(textOf(firstChild(item, 'divisions')))
    if (Number.isFinite(value) && value > 0) divisions = value
  }

  let cursor = 0
  let maxEnd = 0
  // In MusicXML, a note with <chord/> shares the onset of the preceding
  // non-chord note. Do not add its duration after the cursor has already
  // advanced, or measures with chord tones are incorrectly made longer.
  let lastNoteOnset = 0
  for (const child of Array.from(measure.children)) {
    if (child.localName === 'attributes') {
      const value = Number(textOf(firstChild(child, 'divisions')))
      if (Number.isFinite(value) && value > 0) divisions = value
      continue
    }
    if (child.localName === 'note') {
      const grace = firstChild(child, 'grace') !== null
      const chord = firstChild(child, 'chord') !== null
      const durationUnits = Number(textOf(firstChild(child, 'duration')))
      const durationQuarter = Number.isFinite(durationUnits) && durationUnits > 0
        ? durationUnits / Math.max(1, divisions)
        : 0

      if (grace) {
        // Grace notes don't advance the rhythmic cursor.
        continue
      }

      if (chord) {
        // Chord members begin at the preceding principal note's onset.
        maxEnd = Math.max(maxEnd, lastNoteOnset + durationQuarter)
      } else {
        lastNoteOnset = cursor
        maxEnd = Math.max(maxEnd, lastNoteOnset + durationQuarter)
        cursor += durationQuarter
      }
      continue
    }
    if (child.localName === 'backup' || child.localName === 'forward') {
      const durationUnits = Number(textOf(firstChild(child, 'duration')))
      const amount = Number.isFinite(durationUnits) && durationUnits > 0
        ? durationUnits / Math.max(1, divisions)
        : 0
      if (child.localName === 'backup') cursor = Math.max(0, cursor - amount)
      else cursor += amount
      lastNoteOnset = cursor
      maxEnd = Math.max(maxEnd, cursor)
    }
  }

  // Preserve empty/implicit measures with a sensible fallback; this demo song is in 4/4.
  if (maxEnd > 0) return maxEnd
  const time = attributes.map(item => firstChild(item, 'time')).find(Boolean) ?? null
  const beats = Number(textOf(time ? firstChild(time, 'beats') : null))
  const beatType = Number(textOf(time ? firstChild(time, 'beat-type') : null))
  if (beats > 0 && beatType > 0) return beats * (4 / beatType)
  return 4
}

function xmlPitchToMidi(note: Element): number | null {
  const pitch = firstChild(note, 'pitch')
  if (!pitch) return null
  const step = textOf(firstChild(pitch, 'step')).toUpperCase()
  const octave = Number(textOf(firstChild(pitch, 'octave')))
  const alter = Number(textOf(firstChild(pitch, 'alter')) || '0')
  const semitone: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  if (!(step in semitone) || !Number.isFinite(octave) || !Number.isFinite(alter)) return null
  const value = (octave + 1) * 12 + semitone[step] + alter
  return value >= 0 && value <= 127 ? value : null
}

function measureNoteEventsInQuarters(measure: Element, initialDivisions: number): XmlNoteEvent[] {
  let divisions = initialDivisions
  let cursorQuarter = 0
  let lastNoteOnsetQuarter = 0
  const byOnset = new Map<string, { pitches: Set<number>; matchPitches: Set<number> }>()

  for (const child of Array.from(measure.children)) {
    if (child.localName === 'attributes') {
      const value = Number(textOf(firstChild(child, 'divisions')))
      if (Number.isFinite(value) && value > 0) divisions = value
      continue
    }
    if (child.localName === 'note') {
      if (firstChild(child, 'grace')) continue
      if (firstChild(child, 'rest')) {
        const units = Number(textOf(firstChild(child, 'duration')))
        const durationQuarter = Number.isFinite(units) && units > 0 ? units / Math.max(1, divisions) : 0
        if (!firstChild(child, 'chord')) {
          lastNoteOnsetQuarter = cursorQuarter
          cursorQuarter += durationQuarter
        }
        continue
      }

      const chord = firstChild(child, 'chord') !== null
      const units = Number(textOf(firstChild(child, 'duration')))
      const durationQuarter = Number.isFinite(units) && units > 0 ? units / Math.max(1, divisions) : 0
      const onsetQuarter = chord ? lastNoteOnsetQuarter : cursorQuarter
      if (!chord) {
        lastNoteOnsetQuarter = onsetQuarter
        cursorQuarter += durationQuarter
      }
      const pitch = xmlPitchToMidi(child)
      if (pitch !== null) {
        const key = onsetQuarter.toFixed(6)
        const group = byOnset.get(key) ?? { pitches: new Set<number>(), matchPitches: new Set<number>() }
        group.pitches.add(pitch)
        const tieContinuation = directChildren(child, 'tie').some(tie => tie.getAttribute('type') === 'stop') ||
          descendants(child, 'tied').some(tie => tie.getAttribute('type') === 'stop')
        if (!tieContinuation) group.matchPitches.add(pitch)
        byOnset.set(key, group)
      }
      continue
    }
    if (child.localName === 'backup' || child.localName === 'forward') {
      const units = Number(textOf(firstChild(child, 'duration')))
      const amountQuarter = Number.isFinite(units) && units > 0 ? units / Math.max(1, divisions) : 0
      if (child.localName === 'backup') cursorQuarter = Math.max(0, cursorQuarter - amountQuarter)
      else cursorQuarter += amountQuarter
      lastNoteOnsetQuarter = cursorQuarter
    }
  }

  return Array.from(byOnset.entries())
    .map(([key, group]) => ({
      onsetQuarter: Number(key),
      pitches: [...group.pitches].sort((a, b) => a - b),
      matchPitches: [...group.matchPitches].sort((a, b) => a - b),
    }))
    .filter(event => Number.isFinite(event.onsetQuarter))
    .sort((a, b) => a.onsetQuarter - b.onsetQuarter)
}

function findEndingRanges(measures: Element[]) {
  const ranges: Array<{ number: string; start: number; end: number }> = []
  let open: { number: string; start: number } | null = null
  measures.forEach((measure, index) => {
    for (const barline of directChildren(measure, 'barline')) {
      for (const ending of directChildren(barline, 'ending')) {
        const type = ending.getAttribute('type') ?? ''
        const number = ending.getAttribute('number') ?? ''
        if (type === 'start') open = { number, start: index }
        else if ((type === 'stop' || type === 'discontinue') && open) {
          ranges.push({ number: open.number, start: open.start, end: index })
          open = null
        }
      }
    }
  })
  return ranges
}

function expandPlaybackOrder(measures: Element[]): { order: number[]; description: string } {
  const forwards: number[] = []
  const backwards: Array<{ index: number; times: number }> = []
  measures.forEach((measure, index) => {
    for (const barline of directChildren(measure, 'barline')) {
      for (const repeat of directChildren(barline, 'repeat')) {
        const direction = repeat.getAttribute('direction')
        const times = Math.max(2, Number(repeat.getAttribute('times')) || 2)
        if (direction === 'forward') forwards.push(index)
        if (direction === 'backward') backwards.push({ index, times })
      }
    }
  })

  const start = forwards[0]
  const back = backwards[0]
  if (start === undefined || !back || back.index <= start) {
    return { order: measures.map((_, index) => index), description: '未檢出可展開的反覆段，使用 XML 書寫順序' }
  }

  const endings = findEndingRanges(measures)
  const firstEnding = endings.find(range => /(^|[,\s])1([,\s]|$)/.test(range.number) && range.start >= start && range.start <= back.index)
  const secondEnding = endings.find(range => /(^|[,\s])2([,\s]|$)/.test(range.number) && range.start > back.index)
  const prefix = measures.map((_, index) => index).filter(index => index < start)
  const firstPass = measures.map((_, index) => index).filter(index => index >= start && index <= back.index)

  if (firstEnding && secondEnding) {
    const secondPreEnding = measures.map((_, index) => index).filter(index => index >= start && index < firstEnding.start)
    const secondEndingPass = measures.map((_, index) => index).filter(index => index >= secondEnding.start && index <= secondEnding.end)
    const suffixStart = Math.max(back.index, secondEnding.end) + 1
    const suffix = measures.map((_, index) => index).filter(index => index >= suffixStart)
    return {
      order: [...prefix, ...firstPass, ...secondPreEnding, ...secondEndingPass, ...suffix],
      description: `已展開反覆段及第一／第二結尾：${measures.length} 個書寫小節 → ${prefix.length + firstPass.length + secondPreEnding.length + secondEndingPass.length + suffix.length} 次演奏小節`,
    }
  }

  const repeatPasses = Math.min(back.times, 4)
  const after = measures.map((_, index) => index).filter(index => index > back.index)
  return {
    order: [...prefix, ...Array.from({ length: repeatPasses }, () => measures.map((_, index) => index).filter(index => index >= start && index <= back.index)).flat(), ...after],
    description: `已將第 ${start + 1} 至 ${back.index + 1} 小節展開反覆 ${repeatPasses} 次`,
  }
}

function parseMusicXml(xmlText: string): ParsedScore {
  const document = new DOMParser().parseFromString(xmlText.replace(/^\uFEFF/, ''), 'application/xml')
  const parseError = document.querySelector('parsererror') ?? descendants(document.documentElement, 'parsererror')[0]
  if (parseError || document.documentElement.localName === 'parsererror') {
    const detail = (parseError?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 260)
    throw new Error(`MusicXML XML 語法解析失敗：${detail || '瀏覽器無法解析此檔案內容。請確認檔案是未損壞的 MusicXML/XML，而不是 ZIP/MXL 或 HTML 網頁。'}`)
  }
  const rootName = document.documentElement.localName.toLowerCase()
  if (rootName === 'html' || rootName === 'body') {
    throw new Error('讀取到的是 HTML 網頁，不是 MusicXML。請確認測試檔案已放在 public/fingerstyle-pdf-mp3-test/，且網址未被主站首頁回退頁取代。')
  }
  const part = descendants(document.documentElement, 'part')[0]
  if (!part) throw new Error('MusicXML 中沒有找到 part。')
  const xmlMeasures = directChildren(part, 'measure')
  if (!xmlMeasures.length) throw new Error('MusicXML 中沒有找到小節。')
  const firstTime = descendants(document.documentElement, 'time')[0] ?? null
  const meterBeats = firstTime ? directChildren(firstTime, 'beats').map(node => textOf(node)).filter(Boolean).join('+') : ''
  const meterBeatType = firstTime ? textOf(firstChild(firstTime, 'beat-type')) : ''
  const meter = meterBeats && meterBeatType ? `${meterBeats}/${meterBeatType}` : '4/4'

  let divisions = 1
  let tempo = 120
  const measures: MeasureInfo[] = xmlMeasures.map((measure, index) => {
    for (const attributes of directChildren(measure, 'attributes')) {
      const value = Number(textOf(firstChild(attributes, 'divisions')))
      if (Number.isFinite(value) && value > 0) divisions = value
    }
    tempo = readTempoInMeasure(measure, tempo)
    const durationQuarter = measureDurationInQuarters(measure, divisions)
    const noteEvents = measureNoteEventsInQuarters(measure, divisions)
    const noteOnsetsQuarter = noteEvents.map(event => event.onsetQuarter)
    return {
      index,
      printedNumber: measure.getAttribute('number') || String(index + 1),
      durationQuarter,
      tempo,
      durationSeconds: durationQuarter * 60 / Math.max(1, tempo),
      noteOnsetsQuarter,
      noteEvents,
    }
  })
  const { order, description } = expandPlaybackOrder(xmlMeasures)
  const theoreticalDurationSeconds = order.reduce((sum, measureIndex) => sum + (measures[measureIndex]?.durationSeconds ?? 0), 0)
  return { measures, playbackOrder: order, repeatDescription: description, theoreticalDurationSeconds, meter }
}

function readAscii(bytes: Uint8Array, start: number, length: number) {
  let result = ''
  for (let index = start; index < start + length && index < bytes.length; index++) result += String.fromCharCode(bytes[index])
  return result
}

function readUInt32(bytes: Uint8Array, offset: number) {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0
}

function readVLQ(bytes: Uint8Array, cursor: { offset: number }) {
  let value = 0
  let count = 0
  while (cursor.offset < bytes.length && count < 4) {
    const byte = bytes[cursor.offset++]
    value = (value << 7) | (byte & 0x7f)
    count++
    if ((byte & 0x80) === 0) break
  }
  return value
}

function secondsAtTick(tick: number, ppq: number, tempoEvents: Array<{ tick: number; microsecondsPerQuarter: number }>) {
  const sorted = [...tempoEvents].sort((a, b) => a.tick - b.tick)
  let previousTick = 0
  let tempo = 500000
  let seconds = 0
  for (const event of sorted) {
    if (event.tick > tick) break
    if (event.tick > previousTick) seconds += (event.tick - previousTick) * tempo / ppq / 1_000_000
    previousTick = event.tick
    tempo = event.microsecondsPerQuarter
  }
  if (tick > previousTick) seconds += (tick - previousTick) * tempo / ppq / 1_000_000
  return seconds
}

function parseMidiTiming(buffer: ArrayBuffer): MidiTiming {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 14 || readAscii(bytes, 0, 4) !== 'MThd') throw new Error('不是標準 MIDI（SMF）檔案。')
  const headerLength = readUInt32(bytes, 4)
  if (headerLength < 6 || 8 + headerLength > bytes.length) throw new Error('MIDI 檔案標頭不完整。')
  const view = new DataView(buffer)
  const tracks = view.getUint16(10, false)
  const rawDivision = view.getUint16(12, false)
  if ((rawDivision & 0x8000) !== 0 || rawDivision === 0) {
    throw new Error('這份 MIDI 使用 SMPTE 或無效時間格，暫時無法用 PPQ 換算。')
  }
  const ppq = rawDivision
  const tempoEvents: Array<{ tick: number; microsecondsPerQuarter: number }> = [{ tick: 0, microsecondsPerQuarter: 500000 }]
  const rawTracks: Array<{ trackIndex: number; name: string; notes: Array<{ tick: number; pitch: number; channel: number }> }> = []
  const allNotes: Array<{ tick: number; pitch: number; channel: number }> = []
  let maxTick = 0
  let offset = 8 + headerLength

  for (let trackIndex = 0; trackIndex < tracks && offset + 8 <= bytes.length; trackIndex++) {
    const chunkId = readAscii(bytes, offset, 4)
    const chunkLength = readUInt32(bytes, offset + 4)
    const trackStart = offset + 8
    const trackEnd = Math.min(bytes.length, trackStart + chunkLength)
    offset = trackEnd
    if (chunkId !== 'MTrk') continue

    const cursor = { offset: trackStart }
    let absoluteTick = 0
    let runningStatus = 0
    let trackName = `音軌 ${trackIndex + 1}`
    const trackNotes: Array<{ tick: number; pitch: number; channel: number }> = []

    while (cursor.offset < trackEnd) {
      absoluteTick += readVLQ(bytes, cursor)
      maxTick = Math.max(maxTick, absoluteTick)
      if (cursor.offset >= trackEnd) break
      let status = bytes[cursor.offset]
      if (status >= 0x80) {
        cursor.offset++
        if (status < 0xf0) runningStatus = status
      } else {
        status = runningStatus
        if (!status) break
      }

      if (status === 0xff) {
        if (cursor.offset >= trackEnd) break
        const metaType = bytes[cursor.offset++]
        const length = readVLQ(bytes, cursor)
        const dataEnd = Math.min(trackEnd, cursor.offset + length)
        if (metaType === 0x03 && length > 0 && cursor.offset < trackEnd) {
          const nameBytes = bytes.subarray(cursor.offset, dataEnd)
          const decoded = new TextDecoder().decode(nameBytes).replace(/\0/g, '').trim()
          if (decoded) trackName = decoded
        }
        if (metaType === 0x51 && length === 3 && cursor.offset + 3 <= trackEnd) {
          const tempo = (bytes[cursor.offset] << 16) | (bytes[cursor.offset + 1] << 8) | bytes[cursor.offset + 2]
          if (tempo > 0) tempoEvents.push({ tick: absoluteTick, microsecondsPerQuarter: tempo })
        }
        cursor.offset = dataEnd
        if (metaType === 0x2f) break
      } else if (status === 0xf0 || status === 0xf7) {
        const length = readVLQ(bytes, cursor)
        cursor.offset = Math.min(trackEnd, cursor.offset + length)
      } else if (status >= 0x80 && status <= 0xef) {
        const command = status & 0xf0
        const channel = status & 0x0f
        const dataBytes = command === 0xc0 || command === 0xd0 ? 1 : 2
        if (cursor.offset + dataBytes > trackEnd) break
        const data1 = bytes[cursor.offset++]
        const data2 = dataBytes === 2 ? bytes[cursor.offset++] : 0
        // Note-on with velocity > 0 is the actual attack. MIDI channel 10 percussion is not
        // used for the guitar pitch match, but the other pitched channels are retained.
        if (command === 0x90 && data2 > 0 && channel !== 9 && data1 <= 127) {
          const note = { tick: absoluteTick, pitch: data1, channel }
          trackNotes.push(note)
          allNotes.push(note)
        }
      } else {
        // Unsupported system status: stop this track rather than risk desynchronizing the byte cursor.
        break
      }
    }

    rawTracks.push({ trackIndex, name: trackName, notes: trackNotes })
  }

  // A Guitar Pro strum may be exported as several MIDI note-on events a few milliseconds apart,
  // while MusicXML represents the same strummed chord as one simultaneous chord onset. Group a
  // short same-channel sweep into one onset, using the FIRST string attack as the event time.
  // 50 ms stays below a typical 16th-note spacing in this song and avoids collapsing its rapid
  // written subdivisions into one event. Repeated pitches at different ticks start a new group.
  const STRUM_CLUSTER_WINDOW_SECONDS = 0.05
  const groupNotes = (notes: Array<{ tick: number; pitch: number; channel: number }>): MidiOnsetGroup[] => {
    type OnsetCluster = {
      tick: number
      seconds: number
      pitches: Set<number>
      channels: Set<number>
    }
    const sortedNotes = [...notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
    const grouped: OnsetCluster[] = []

    for (const note of sortedNotes) {
      const seconds = secondsAtTick(note.tick, ppq, tempoEvents)
      let cluster: OnsetCluster | undefined

      // Search only recent clusters; events are sorted by tick, so older ones can be skipped.
      for (let index = grouped.length - 1; index >= 0; index--) {
        const candidate = grouped[index]
        const age = seconds - candidate.seconds
        if (age > STRUM_CLUSTER_WINDOW_SECONDS) break
        const sameTick = candidate.tick === note.tick
        const sameChannel = candidate.channels.has(note.channel)
        if (!sameTick && !sameChannel) continue

        if (candidate.pitches.has(note.pitch)) {
          // Duplicate same-pitch events at the exact same tick don't add a new chord tone;
          // but a repeated pitch a little later is a genuine fresh attack, not part of the sweep.
          if (sameTick) cluster = candidate
          continue
        }
        cluster = candidate
        break
      }

      if (cluster) {
        cluster.pitches.add(note.pitch)
        cluster.channels.add(note.channel)
      } else {
        grouped.push({
          tick: note.tick,
          seconds,
          pitches: new Set([note.pitch]),
          channels: new Set([note.channel]),
        })
      }
    }

    return grouped
      .sort((a, b) => a.tick - b.tick)
      .map(cluster => ({
        // Keep the earliest string attack as the score's strum-onset time.
        tick: cluster.tick,
        seconds: cluster.seconds,
        pitches: [...cluster.pitches].sort((a, b) => a - b),
      }))
  }

  const noteTracks: MidiNoteTrack[] = rawTracks
    .map(track => ({ trackIndex: track.trackIndex, name: track.name, onsets: groupNotes(track.notes) }))
    .filter(track => track.onsets.length > 0)
  if (noteTracks.length > 1) {
    noteTracks.push({ trackIndex: -1, name: '合併全部旋律音軌', onsets: groupNotes(allNotes) })
  }

  return {
    durationSeconds: secondsAtTick(maxTick, ppq, tempoEvents),
    ppq,
    tempoEvents: tempoEvents.length,
    tracks,
    noteTracks,
  }
}

function buildPlaybackXmlEvents(parsed: ParsedScore): PlaybackXmlEvent[] {
  const events: PlaybackXmlEvent[] = []
  parsed.playbackOrder.forEach((measureIndex, occurrence) => {
    const measure = parsed.measures[measureIndex]
    if (!measure) return
    for (const event of measure.noteEvents) {
      // A pure tie continuation sustains an existing note but does not create a new MIDI attack.
      // The fingerstyle PDF usually has no new TAB fret-number column at that point either.
      // Keeping this empty-pitch event as a cursor anchor makes later printed fret columns drift
      // (notably measures 8 and 9, where the tied noteheads were being counted as fresh anchors).
      if (event.matchPitches.length === 0) continue
      events.push({
        sequenceIndex: events.length,
        occurrence,
        measureIndex,
        onsetQuarter: event.onsetQuarter,
        pitches: event.matchPitches,
      })
    }
  })
  return events
}

function pitchSetSimilarity(xmlPitches: number[], midiPitches: number[], shift: number): number {
  // Event pitch lists are already deduplicated. Avoid allocating Sets inside the O(n × m)
  // dynamic-programming loop so a full song can be aligned without blocking the UI for long.
  if (!xmlPitches.length || !midiPitches.length) return 0
  let intersection = 0
  for (const pitch of xmlPitches) {
    const shifted = pitch + shift
    if (shifted >= 0 && shifted <= 127 && midiPitches.includes(shifted)) intersection++
  }
  return (2 * intersection) / (xmlPitches.length + midiPitches.length)
}

function eventPairScore(similarity: number): number {
  if (similarity < 0.32) return -3.0
  return similarity * 4.8 - 1.25
}

function alignEventSequences(
  xmlEvents: PlaybackXmlEvent[],
  midiOnsets: MidiOnsetGroup[],
  pitchShift: number,
): { score: number; matches: Array<{ xmlIndex: number; midiIndex: number; similarity: number }>; strongMatchCount: number } {
  const n = xmlEvents.length
  const m = midiOnsets.length
  if (!n || !m) return { score: -Infinity, matches: [], strongMatchCount: 0 }

  const columns = m + 1
  const scores = new Float32Array((n + 1) * columns)
  const trace = new Uint8Array((n + 1) * columns)
  const gapPenalty = 1.18

  for (let i = 1; i <= n; i++) {
    scores[i * columns] = -i * gapPenalty
    trace[i * columns] = 1 // XML event without a MIDI match
  }
  for (let j = 1; j <= m; j++) {
    scores[j] = -j * gapPenalty
    trace[j] = 2 // extra MIDI event
  }

  const similarities = new Float32Array(n * m)
  for (let i = 1; i <= n; i++) {
    const row = i * columns
    const previousRow = (i - 1) * columns
    for (let j = 1; j <= m; j++) {
      const sim = pitchSetSimilarity(xmlEvents[i - 1].pitches, midiOnsets[j - 1].pitches, pitchShift)
      similarities[(i - 1) * m + (j - 1)] = sim
      const diagonal = scores[previousRow + j - 1] + eventPairScore(sim)
      const up = scores[previousRow + j] - gapPenalty
      const left = scores[row + j - 1] - gapPenalty
      const cell = row + j
      if (diagonal >= up && diagonal >= left) {
        scores[cell] = diagonal
        trace[cell] = 0
      } else if (up >= left) {
        scores[cell] = up
        trace[cell] = 1
      } else {
        scores[cell] = left
        trace[cell] = 2
      }
    }
  }

  const matches: Array<{ xmlIndex: number; midiIndex: number; similarity: number }> = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const direction = trace[i * columns + j]
    if (i > 0 && j > 0 && direction === 0) {
      const similarity = similarities[(i - 1) * m + (j - 1)]
      if (similarity >= 0.32) matches.push({ xmlIndex: i - 1, midiIndex: j - 1, similarity })
      i--
      j--
    } else if (i > 0 && (j === 0 || direction === 1)) {
      i--
    } else if (j > 0) {
      j--
    } else {
      break
    }
  }
  matches.reverse()
  return {
    score: scores[n * columns + m],
    matches,
    strongMatchCount: matches.filter(match => match.similarity >= 0.75).length,
  }
}

function buildMidiAlignment(parsed: ParsedScore, midiTiming: MidiTiming): MidiAlignment | null {
  const xmlEvents = buildPlaybackXmlEvents(parsed)
  if (!xmlEvents.length || !midiTiming.noteTracks.length) return null

  const pitchShifts = [0, -12, 12, -24, 24]
  let best: { track: MidiNoteTrack; shift: number; result: ReturnType<typeof alignEventSequences>; adjustedScore: number } | null = null
  for (const track of midiTiming.noteTracks) {
    for (const shift of pitchShifts) {
      const result = alignEventSequences(xmlEvents, track.onsets, shift)
      if (!result.matches.length) continue
      // Prefer a good full-sequence alignment, with a small tie-breaker favoring fewer transpositions.
      const adjustedScore = result.score + result.strongMatchCount * 0.004 - Math.abs(shift) * 0.0001
      if (!best || adjustedScore > best.adjustedScore) best = { track, shift, result, adjustedScore }
    }
  }
  if (!best) return null

  const matchedByXmlIndex: Array<MidiEventMatch | null> = Array.from({ length: xmlEvents.length }, () => null)
  for (const match of best.result.matches) {
    const midiEvent = best.track.onsets[match.midiIndex]
    if (!midiEvent) continue
    matchedByXmlIndex[match.xmlIndex] = {
      midiEventIndex: match.midiIndex,
      seconds: midiEvent.seconds,
      similarity: match.similarity,
    }
  }
  const matchedCount = best.result.matches.length
  const strongMatchCount = best.result.strongMatchCount
  return {
    xmlEvents,
    matchedByXmlIndex,
    trackLabel: best.track.name,
    pitchShift: best.shift,
    matchedCount,
    strongMatchCount,
    coveragePct: 100 * matchedCount / Math.max(1, xmlEvents.length),
    strongCoveragePct: 100 * strongMatchCount / Math.max(1, xmlEvents.length),
    score: best.result.score,
  }
}

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  const tenths = Math.floor((safe % 1) * 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export type FingerstylePdfMp3TestProps = {
  isAdmin?: boolean
  pdfUrl: string
  xmlUrl: string
  midiUrl: string
  mp3Url: string
}

export default function FingerstylePdfMp3Test(props: FingerstylePdfMp3TestProps) {

  const theme = useManbanpaiTheme()
  const colors = theme === 'day' ? dayColors : nightColors
  const { pdfUrl, xmlUrl, midiUrl, mp3Url } = props
  if (!pdfUrl || !xmlUrl || !midiUrl || !mp3Url) {
    return <main className="manbanpai-reader-page" style={{ minHeight: '100vh', padding: 28, background: colors.bg, color: colors.text, fontFamily: 'system-ui,sans-serif' }}>
      <h1>吉他指彈譜</h1><p>這份曲譜需要同時綁定 PDF、MusicXML、MIDI 與 MP3。MP3 是實際播放音源，MIDI 用於演奏時間軸與音符對位，MusicXML 用於小節／音符結構和樂理分析。請在曲庫管理中補齊四個對應附件後再開啟。</p></main>
  }
  return <FingerstylePdfMp3TestReady {...props} pdfUrl={pdfUrl} xmlUrl={xmlUrl} midiUrl={midiUrl} mp3Url={mp3Url} colors={colors} />
}

function FingerstylePdfMp3TestReady({
  isAdmin = false,
  pdfUrl,
  xmlUrl,
  midiUrl,
  mp3Url,
  colors,
}: FingerstylePdfMp3TestProps & { pdfUrl: string; xmlUrl: string; midiUrl: string; mp3Url: string; colors: typeof nightColors }) {
  const theme = useManbanpaiTheme()

  // This child component renders the title, controls and PDF, so it needs its own theme-derived palette.

  const theoryCorrectionsStorageKey = getFingerstyleTheoryCorrectionsKey(pdfUrl, xmlUrl)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const scheduleRef = useRef<ScheduledMeasure[]>([])
  const lastPublishedCursorKeyRef = useRef('')
  const lastPublishedAtRef = useRef(0)
  const [parsed, setParsed] = useState<ParsedScore | null>(null)
  const [musicXmlText, setMusicXmlText] = useState('')
  const [midiTiming, setMidiTiming] = useState<MidiTiming | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const currentTimeRef = useRef(0)
  currentTimeRef.current = currentTime
  const [audioDuration, setAudioDuration] = useState(0)
  const [mp3Ready, setMp3Ready] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [mp3Offset, setMp3Offset] = useState(0)
  const [loopStart, setLoopStart] = useState<number | null>(null)
  const [loopEnd, setLoopEnd] = useState<number | null>(null)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const loopRef = useRef<{ start: number | null; end: number | null; enabled: boolean }>({ start: null, end: null, enabled: false })
  const [autoFollow, setAutoFollow] = useState(true)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('正在讀取指彈 PDF、MusicXML 與 MIDI…')
  const [error, setError] = useState('')
  const [midiError, setMidiError] = useState('')
  const [theoryAnalysis, setTheoryAnalysis] = useState<ScoreTheoryAnalysis | null>(null)
  const [theoryError, setTheoryError] = useState('')
  const [showTheoryPanel, setShowTheoryPanel] = useState(false)
  const scoreWithCurrentMeasureRef = useRef<HTMLDivElement | null>(null)
  const [selectedTheoryMeasureIndex, setSelectedTheoryMeasureIndex] = useState(0)
  // Separate the card's real selection/playback highlight from the default measure used by the details pane.
  const [theoryCardHighlightMeasureIndex, setTheoryCardHighlightMeasureIndex] = useState<number | null>(null)
  const [theoryDisplayMode, setTheoryDisplayMode] = useState<TheoryDisplayMode>('chordNames')
  const [theoryCorrections, setTheoryCorrections] = useState<Record<string, string>>({})
  const [theoryCorrectionsLoadedForKey, setTheoryCorrectionsLoadedForKey] = useState('')
  const [theoryCorrectionCloudReady, setTheoryCorrectionCloudReady] = useState(false)

  useEffect(() => {
    loopRef.current = { start: loopStart, end: loopEnd, enabled: loopEnabled }
  }, [loopStart, loopEnd, loopEnabled])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setTheoryCardHighlightMeasureIndex(null)
      setError('')
      setMidiError('')
      try {
        const xmlResource = await fetchFingerstyleMusicXml(xmlUrl)
        const xmlText = xmlResource.text
        const score = parseMusicXml(xmlText)
        if (cancelled) return
        setMusicXmlText(xmlText)
        setParsed(score)

        try {
          const analysis = analyseMusicXmlTheory(xmlText)
          if (!cancelled) {
            setTheoryAnalysis(analysis)
            setSelectedTheoryMeasureIndex(analysis.measures[0]?.sourceIndex ?? 0)
            setTheoryError('')
          }
        } catch (analysisLoadError) {
          if (!cancelled) setTheoryError(analysisLoadError instanceof Error ? analysisLoadError.message : '樂理分析未能完成。')
        }

        const midiResponse = await fetch(midiUrl, { cache: 'no-store', credentials: 'same-origin' })
        if (!midiResponse.ok) throw new Error(`MIDI 必需檔案讀取失敗（HTTP ${midiResponse.status}）。`)
        const midi = parseMidiTiming(await midiResponse.arrayBuffer())
        if (!midi.noteTracks.length || !midi.noteTracks.some(track => track.onsets.length > 0)) {
          throw new Error('MIDI 必需檔案中沒有可用音符事件，無法校準指彈譜的時間軸。')
        }
        if (!cancelled) setMidiTiming(midi)
        if (!cancelled) {
          setStatus(`MusicXML 已解析 ${score.measures.length} 個書寫小節（${xmlResource.url.endsWith('.xml') ? 'XML 檔' : 'MusicXML 檔'}）；MP3 負責聲音與播放時鐘，MIDI 負責演奏時間與音符匹配；${score.repeatDescription}。`)
          setLoading(false)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : '載入譜面時間資料失敗。'
          if (/MIDI/i.test(message)) setMidiError(message)
          setError(message)
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [xmlUrl, midiUrl])

  const midiAlignment = useMemo<MidiAlignment | null>(() => {
    if (!parsed || !midiTiming) return null
    return buildMidiAlignment(parsed, midiTiming)
  }, [parsed, midiTiming])

  const displayTheoryAnalysis = useMemo<ScoreTheoryAnalysis | null>(() => {
    if (!theoryAnalysis) return null
    return applyTheoryChordCorrections(theoryAnalysis, theoryCorrections)
  }, [theoryAnalysis, theoryCorrections])

  const selectedTheoryMeasure = useMemo<TheoryMeasureInfo | null>(() => {
    if (!displayTheoryAnalysis?.measures.length) return null
    return displayTheoryAnalysis.measures.find(item => item.sourceIndex === selectedTheoryMeasureIndex)
      ?? displayTheoryAnalysis.measures[Math.max(0, Math.min(displayTheoryAnalysis.measures.length - 1, selectedTheoryMeasureIndex))]
      ?? null
  }, [displayTheoryAnalysis, selectedTheoryMeasureIndex])

  const theoryLabels = useMemo(() => {
    if (!displayTheoryAnalysis || theoryDisplayMode === 'none') return [] as Array<{ measureIndex: number; label: string; detail?: string; title?: string }>
    const measures = displayTheoryAnalysis.measures
    return measures.map((measure, index) => {
      const chord = measure.primaryChord
      const nextBass = measures.slice(index + 1).find(candidate => candidate.bassMidi !== null)
      const bassArrow = !nextBass || measure.bassMidi === null ? ''
        : nextBass.bassMidi! > measure.bassMidi ? '↗'
        : nextBass.bassMidi! < measure.bassMidi ? '↘' : '→'
      let label = chord?.symbol ?? ''
      let detail = chord?.roman ?? ''
      let title = `第 ${measure.printedNumber} 小節 · ${chord?.symbol ?? '未確定'} · ${chord?.roman ?? '級數未確定'}`
      if (theoryDisplayMode === 'bassLine') {
        label = measure.bassMidi !== null && measure.bassName ? `${measure.bassName}${bassArrow}` : ''
        detail = '低音'
        title = `第 ${measure.printedNumber} 小節 · 低音 ${measure.bassName || '未知'}${nextBass ? ` · 下一低音 ${nextBass.bassName}` : ''}`
      } else if (theoryDisplayMode === 'nonChordHints') {
        const hints = measure.nonChordHints ?? []
        label = hints.length ? hints.slice(0, 2).map(hint => `${hint.noteName}·${hint.label}`).join('、') : ''
        detail = hints.length ? `${hints.length} 項` : '非和弦音'
        title = `第 ${measure.printedNumber} 小節 · ${hints.length ? hints.map(hint => `${hint.noteName}（${hint.label}）`).join('、') : '沒有非和弦音候選'}`
      } else if (theoryDisplayMode === 'melodyContour') {
        label = measure.melodyTrend && measure.melodyTrend !== '旋律資訊不足' ? measure.melodyTrend : ''
        detail = '旋律'
        title = `第 ${measure.printedNumber} 小節 · ${measure.melodyContour || '旋律資訊不足'} · ${measure.melodyRange || ''}`
      }
      if (theoryDisplayMode === 'chordNames' && chord?.confidence) {
        title += ` · ${chord.confidence}`
      }
      return { measureIndex: measure.sourceIndex, label, detail, title }
    })
  }, [displayTheoryAnalysis, theoryDisplayMode])

  useEffect(() => {
    let cancelled = false
    setTheoryCorrectionsLoadedForKey('')
    setTheoryCorrectionCloudReady(false)
    void (async () => {
      try {
        const response = await fetch(`/api/state?key=${encodeURIComponent(theoryCorrectionsStorageKey)}`, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as { value?: unknown; found?: boolean }
        let rawValue: unknown = payload.value
        if (!payload.found) {
          try {
            const localRaw = window.localStorage.getItem(theoryCorrectionsStorageKey)
            if (localRaw) {
              const localValue: unknown = JSON.parse(localRaw)
              if (localValue && typeof localValue === 'object' && !Array.isArray(localValue)) {
                rawValue = localValue
                if (isAdmin) await fetch(`/api/state?key=${encodeURIComponent(theoryCorrectionsStorageKey)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: localValue }) })
              }
            }
          } catch { /* Legacy local corrections are optional. */ }
        }
        const loaded: Record<string, string> = {}
        if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
          for (const [id, value] of Object.entries(rawValue as Record<string, unknown>)) if (typeof value === 'string') loaded[id] = value
        }
        if (!cancelled) {
          setTheoryCorrections(loaded)
          setTheoryCorrectionsLoadedForKey(theoryCorrectionsStorageKey)
          setTheoryCorrectionCloudReady(true)
        }
      } catch (loadError) {
        let localCorrections: Record<string, string> = {}
        try {
          const localRaw = window.localStorage.getItem(theoryCorrectionsStorageKey)
          const value = localRaw ? JSON.parse(localRaw) : null
          if (value && typeof value === 'object' && !Array.isArray(value)) localCorrections = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        } catch { /* Ignore invalid local data. */ }
        if (!cancelled) {
          setTheoryCorrections(localCorrections)
          setTheoryCorrectionsLoadedForKey(theoryCorrectionsStorageKey)
          setTheoryCorrectionCloudReady(false)
        }
        console.warn('[慢半拍指彈] 雲端和弦校正不可用，暫用本機副本：', loadError)
      }
    })()
    return () => { cancelled = true }
  }, [theoryCorrectionsStorageKey, isAdmin])

  useEffect(() => {
    if (theoryCorrectionsLoadedForKey !== theoryCorrectionsStorageKey) return
    try { window.localStorage.setItem(theoryCorrectionsStorageKey, JSON.stringify(theoryCorrections)) }
    catch (storageError) { console.warn('[慢半拍指彈] 無法儲存本地和弦校正：', storageError) }
    if (!isAdmin || !theoryCorrectionCloudReady) return
    void fetch(`/api/state?key=${encodeURIComponent(theoryCorrectionsStorageKey)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: theoryCorrections }) })
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`) })
      .catch(saveError => console.warn('[慢半拍指彈] 雲端和弦校正儲存失敗：', saveError))
  }, [theoryCorrections, theoryCorrectionsStorageKey, theoryCorrectionsLoadedForKey, isAdmin, theoryCorrectionCloudReady])

  const handleTheoryLabelClick = useCallback((measureIndex: number) => {
    setSelectedTheoryMeasureIndex(measureIndex)
    setShowTheoryPanel(true)
  }, [])

  const updateTheoryCorrection = useCallback((sourceIndex: number, onsetQuarter: number, candidateKey: string) => {
    const key = theoryCorrectionKey(sourceIndex, onsetQuarter)
    setTheoryCorrections(previous => {
      const next = { ...previous }
      if (!candidateKey) delete next[key]
      else next[key] = candidateKey
      return next
    })
  }, [])

  const schedule = useMemo<ScheduledMeasure[]>(() => {
    if (!parsed) return []
    const totalTheoretical = parsed.playbackOrder.reduce(
      (sum, measureIndex) => sum + (parsed.measures[measureIndex]?.durationSeconds ?? 0), 0,
    )
    if (totalTheoretical <= 0) return []

    const targetDuration = audioDuration > 0
      ? audioDuration
      : (midiTiming?.durationSeconds || totalTheoretical)
    const fallbackScale = targetDuration / totalTheoretical
    const midiScale = midiTiming && midiTiming.durationSeconds > 0
      ? targetDuration / midiTiming.durationSeconds
      : fallbackScale
    const useMidiAlignment = Boolean(midiAlignment && midiAlignment.coveragePct >= 40)
    const expandedEvents = midiAlignment?.xmlEvents ?? []
    const matches = midiAlignment?.matchedByXmlIndex ?? []

    const contexts = parsed.playbackOrder.map((measureIndex, occurrence) => {
      const measure = parsed.measures[measureIndex]
      const events = expandedEvents.filter(event => event.occurrence === occurrence)
      const mapped = events.flatMap(event => {
        const match = matches[event.sequenceIndex]
        return match ? [{ q: event.onsetQuarter, rawSeconds: match.seconds, similarity: match.similarity }] : []
      })
      const nominalSpq = 60 / Math.max(1, measure.tempo)
      let secondsPerQuarter = nominalSpq
      let startCandidate: number | null = null

      if (useMidiAlignment && mapped.length) {
        if (mapped.length >= 2) {
          const meanQ = mapped.reduce((sum, point) => sum + point.q, 0) / mapped.length
          const meanT = mapped.reduce((sum, point) => sum + point.rawSeconds, 0) / mapped.length
          let varianceQ = 0
          let covariance = 0
          for (const point of mapped) {
            varianceQ += (point.q - meanQ) ** 2
            covariance += (point.q - meanQ) * (point.rawSeconds - meanT)
          }
          if (varianceQ > 0.0001) secondsPerQuarter = covariance / varianceQ
        }
        // Avoid a bad handful of pitch matches from creating a wildly stretched measure.
        if (!Number.isFinite(secondsPerQuarter) || secondsPerQuarter < nominalSpq * 0.4 || secondsPerQuarter > nominalSpq * 2.5) {
          secondsPerQuarter = nominalSpq
        }
        const estimatedStartRaw = mapped.reduce(
          (sum, point) => sum + point.rawSeconds - point.q * secondsPerQuarter,
          0,
        ) / mapped.length
        if (Number.isFinite(estimatedStartRaw)) startCandidate = Math.max(0, estimatedStartRaw * midiScale + mp3Offset)
      }

      return {
        occurrence,
        measureIndex,
        measure,
        events,
        mapped,
        startCandidate,
        estimatedDuration: Math.max(0.04, measure.durationQuarter * secondsPerQuarter * (useMidiAlignment ? midiScale : fallbackScale)),
        fallbackDuration: Math.max(0.04, measure.durationSeconds * fallbackScale),
      }
    })

    const starts: number[] = []
    for (let index = 0; index < contexts.length; index++) {
      const context = contexts[index]
      if (index === 0) {
        starts.push(useMidiAlignment && context.startCandidate !== null ? context.startCandidate : 0)
        continue
      }
      const previousStart = starts[index - 1]
      const previousDuration = contexts[index - 1].estimatedDuration
      const predicted = previousStart + (useMidiAlignment ? previousDuration : contexts[index - 1].fallbackDuration)
      const candidate = useMidiAlignment ? context.startCandidate : null
      if (candidate !== null && Number.isFinite(candidate)) {
        const delta = candidate - previousStart
        const plausible = delta > Math.max(0.04, previousDuration * 0.3) && delta < previousDuration * 2.4
        starts.push(plausible ? candidate : predicted)
      } else {
        starts.push(predicted)
      }
    }

    return contexts.map((context, index) => {
      const startSeconds = Math.max(0, starts[index])
      const nextStart = index + 1 < starts.length ? starts[index + 1] : targetDuration
      const fallbackEnd = startSeconds + (useMidiAlignment ? context.estimatedDuration : context.fallbackDuration)
      const endSeconds = Number.isFinite(nextStart) && nextStart > startSeconds + 0.025
        ? nextStart
        : Math.max(startSeconds + 0.04, Math.min(targetDuration || fallbackEnd, fallbackEnd))
      const durationSeconds = Math.max(0.04, endSeconds - startSeconds)
      const normalizedTimes = context.events.map(event => {
        const match = matches[event.sequenceIndex]
        const theoretical = context.measure.durationQuarter > 0
          ? event.onsetQuarter / context.measure.durationQuarter
          : 0
        if (useMidiAlignment && match) {
          const eventTime = match.seconds * midiScale + mp3Offset
          const withinBar = eventTime >= startSeconds - 0.15 && eventTime <= endSeconds + 0.15
          if (withinBar) return Math.max(0, Math.min(0.999, (eventTime - startSeconds) / durationSeconds))
        }
        return Math.max(0, Math.min(0.999, theoretical))
      })
      let previousTime = 0
      for (let timeIndex = 0; timeIndex < normalizedTimes.length; timeIndex++) {
        normalizedTimes[timeIndex] = Math.max(previousTime, normalizedTimes[timeIndex])
        normalizedTimes[timeIndex] = Math.min(0.999, normalizedTimes[timeIndex])
        previousTime = normalizedTimes[timeIndex]
      }
      return {
        occurrence: context.occurrence,
        measureIndex: context.measureIndex,
        printedNumber: context.measure.printedNumber,
        startSeconds,
        endSeconds,
        durationSeconds,
        noteAnchorTimes: normalizedTimes,
        matchedNoteEvents: context.mapped.length,
      }
    })
  }, [parsed, midiTiming, midiAlignment, audioDuration, mp3Offset])

  // The animation clock resolves against the latest schedule without restarting its RAF loop.
  scheduleRef.current = schedule

  const cursor = useMemo(() => {
    if (!schedule.length) return { measureIndex: -1, progress: 0, occurrence: -1 }
    const time = Math.max(0, Math.min(currentTime, audioDuration || Number.POSITIVE_INFINITY))
    let item = schedule.find(entry => time >= entry.startSeconds && time < entry.endSeconds)
    if (!item && time >= schedule[schedule.length - 1].endSeconds) item = schedule[schedule.length - 1]
    if (!item) item = schedule[0]
    const progress = item.durationSeconds > 0
      ? Math.max(0, Math.min(1, (time - item.startSeconds) / item.durationSeconds))
      : 0
    return { measureIndex: item.measureIndex, progress, occurrence: item.occurrence }
  }, [schedule, currentTime, audioDuration])

  // Read the audio clock on each animation frame, but publish React state only about 12 times per second.
  // CSS interpolates the cursor between updates to reduce work during scrolling.
  useEffect(() => {
    let frameId = 0
    let lastPlayingState: boolean | null = null
    let lastIdleRefresh = 0
    let lastPublishedTime = Number.NEGATIVE_INFINITY
    const publishClock = (time: number, now: number) => {
      lastPublishedTime = time
      lastPublishedCursorKeyRef.current = cursorKeyAtTime(scheduleRef.current, time)
      lastPublishedAtRef.current = now
      setCurrentTime(time)
    }
    const tick = (now: number) => {
      const audio = audioRef.current
      if (audio) {
        let time = Math.max(0, Number(audio.currentTime) || 0)
        const isPlaying = !audio.paused && !audio.ended
        const loop = loopRef.current
        let timeJumped = false
        if (isPlaying && loop.enabled && loop.start !== null && loop.end !== null && loop.end > loop.start + 0.2 && time >= loop.end) {
          try {
            audio.currentTime = loop.start
            time = loop.start
            timeJumped = true
          } catch { /* Browser may be refreshing media metadata. */ }
        }
        const cursorKey = cursorKeyAtTime(scheduleRef.current, time)
        const boundaryChanged = cursorKey !== lastPublishedCursorKeyRef.current
        if (isPlaying) {
          if (timeJumped || boundaryChanged || now - lastPublishedAtRef.current >= 1000 / 12) publishClock(time, now)
          if (lastPlayingState !== true) {
            setPlaying(true)
            lastPlayingState = true
          }
        } else {
          if (timeJumped || boundaryChanged || Math.abs(time - lastPublishedTime) > 0.004) publishClock(time, now)
          if (now - lastIdleRefresh >= 100) {
            if (lastPlayingState !== false) {
              setPlaying(false)
              lastPlayingState = false
            }
            lastIdleRefresh = now
          }
        }
      }
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [])

  const reportAudioError = useCallback(() => {
    const audio = audioRef.current
    const code = audio?.error?.code
    const detail = code ? `（媒體錯誤代碼 ${code}）` : ''
    setMp3Ready(false)
    setError(`吉他指彈 MP3 無法載入或解碼${detail}。請確認曲庫綁定的 MP3 URL 可由瀏覽器直接讀取。`)
  }, [])

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return
    try {
      if (audio.paused) {
        await audio.play()
        setPlaying(true)
      } else {
        audio.pause()
        setPlaying(false)
      }
    } catch (playError) {
      setError(`播放失敗：${playError instanceof Error ? playError.message : String(playError)}`)
    }
  }, [])

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    try { audio.currentTime = 0 } catch { /* wait until metadata if needed */ }
    setCurrentTime(0)
    setPlaying(false)
  }, [])

  const replayFromStart = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !mp3Ready) return
    try {
      audio.pause()
      audio.currentTime = 0
      setCurrentTime(0)
      await audio.play()
      setPlaying(true)
      setStatus('已從開頭重新播放 MP3。')
    } catch (playError) {
      setError(`重播失敗：${playError instanceof Error ? playError.message : String(playError)}`)
    }
  }, [mp3Ready])

  const seekToTime = useCallback(async (nextTime: number): Promise<boolean> => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(nextTime)) return false

    // A click can arrive while the browser has created the audio element but has not
    // completed media metadata loading yet. Do not pretend that a timeout means seeking
    // succeeded: wait for metadata, then verify the actual currentTime after seeked.
    const metadataReady = (): boolean =>
      audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
      Number.isFinite(audio.duration) && audio.duration > 0

    if (!metadataReady()) {
      await new Promise<void>(resolve => {
        let finished = false
        const timeoutId = window.setTimeout(finish, 6500)
        const cleanup = () => {
          window.clearTimeout(timeoutId)
          audio.removeEventListener('loadedmetadata', checkReady)
          audio.removeEventListener('durationchange', checkReady)
          audio.removeEventListener('canplay', checkReady)
          audio.removeEventListener('error', finish)
        }
        function finish() {
          if (finished) return
          finished = true
          cleanup()
          resolve()
        }
        function checkReady() {
          if (metadataReady()) finish()
        }
        audio.addEventListener('loadedmetadata', checkReady)
        audio.addEventListener('durationchange', checkReady)
        audio.addEventListener('canplay', checkReady)
        audio.addEventListener('error', finish)
        checkReady()
      })
    }

    if (!metadataReady() || audio.error) {
      setStatus(`MP3 尚未完成媒體資訊載入，無法跳轉。readyState=${audio.readyState}、networkState=${audio.networkState}${audio.error?.code ? `、媒體錯誤=${audio.error.code}` : ''}。請確認 MP3 URL 能正常讀取後再試。`)
      return false
    }

    // Keep the target a little before the exact duration, because seeking to duration
    // itself can be rejected by some browser/MP3 combinations.
    const duration = audio.duration
    const target = Math.max(0, Math.min(Math.max(0, duration - 0.035), nextTime))
    const reachedTarget = () =>
      Number.isFinite(audio.currentTime) &&
      Math.abs(audio.currentTime - target) <= 0.25 &&
      !audio.seeking

    if (reachedTarget()) {
      setCurrentTime(audio.currentTime)
      return true
    }

    const attemptSeek = (): Promise<boolean> => new Promise(resolve => {
      let finished = false
      const cleanup = () => {
        window.clearTimeout(timeoutId)
        audio.removeEventListener('seeked', checkTarget)
        audio.removeEventListener('timeupdate', checkTarget)
        audio.removeEventListener('loadeddata', checkTarget)
        audio.removeEventListener('canplay', checkTarget)
        audio.removeEventListener('progress', checkTarget)
        audio.removeEventListener('durationchange', checkTarget)
        audio.removeEventListener('error', onError)
      }
      const finish = (success: boolean) => {
        if (finished) return
        finished = true
        cleanup()
        setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0)
        resolve(success)
      }
      const checkTarget = () => {
        if (reachedTarget()) finish(true)
      }
      const onError = () => finish(false)
      const timeoutId = window.setTimeout(() => finish(reachedTarget()), 4200)
      audio.addEventListener('seeked', checkTarget)
      audio.addEventListener('timeupdate', checkTarget)
      audio.addEventListener('loadeddata', checkTarget)
      audio.addEventListener('canplay', checkTarget)
      audio.addEventListener('progress', checkTarget)
      audio.addEventListener('durationchange', checkTarget)
      audio.addEventListener('error', onError)
      try {
        audio.currentTime = target
        setCurrentTime(target)
        // Some media elements settle the target synchronously; others emit seeked later.
        checkTarget()
      } catch {
        finish(false)
      }
    })

    // Retry once after the browser has had a chance to refresh its seekable ranges.
    // This handles delayed MP3 range/metadata availability without ever playing from 0.
    let success = await attemptSeek()
    if (!success && !audio.error) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 160))
      try { audio.currentTime = target } catch { /* surfaced in the diagnostic below */ }
      success = await attemptSeek()
    }

    setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0)
    if (!success) {
      let seekable = '無可用 seekable range'
      try {
        if (audio.seekable.length) {
          seekable = Array.from({ length: audio.seekable.length }, (_, index) =>
            `${audio.seekable.start(index).toFixed(2)}–${audio.seekable.end(index).toFixed(2)}s`,
          ).join(', ')
        }
      } catch { /* media metadata can change while reading ranges */ }
      setStatus(`MP3 跳轉未確認成功：目標 ${formatTime(target)}、實際 ${formatTime(audio.currentTime || 0)}、readyState=${audio.readyState}、networkState=${audio.networkState}、可跳轉區間=${seekable}。請稍後再點一次；若持續發生，將這行狀態文字發給我。`)
    }
    return success
  }, [])

  const seekBySeconds = useCallback((delta: number) => {
    const audio = audioRef.current
    if (!audio) return
    void seekToTime((Number(audio.currentTime) || 0) + delta)
  }, [seekToTime])

  const markLoopStart = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !mp3Ready) return
    const value = Math.max(0, Number(audio.currentTime) || 0)
    setLoopStart(value)
    setLoopEnd(null)
    setLoopEnabled(false)
    setStatus(`已標記 A 點：${formatTime(value)}。播放到想要的結束位置後，再按「標記 B」。`)
  }, [mp3Ready])

  const markLoopEnd = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !mp3Ready) return
    if (loopStart === null) {
      setStatus('請先按「標記 A」設定循環起點。')
      return
    }
    const value = Math.max(0, Number(audio.currentTime) || 0)
    if (value <= loopStart + 0.2) {
      setStatus('B 點必須比 A 點至少晚 0.2 秒，請把播放位置往後移再標記。')
      return
    }
    setLoopEnd(value)
    setLoopEnabled(true)
    setStatus(`A/B 循環已啟用：${formatTime(loopStart)} → ${formatTime(value)}。`)
  }, [mp3Ready, loopStart])

  const clearLoop = useCallback(() => {
    setLoopStart(null)
    setLoopEnd(null)
    setLoopEnabled(false)
    setStatus('A/B 循環已清除。')
  }, [])

  const onMeasureClick = useCallback(async (measureIndex: number) => {
    setSelectedTheoryMeasureIndex(measureIndex)
    if (!midiTiming || !mp3Ready) {
      setStatus('指彈播放需要 MIDI 時間參考與 MP3 音源都就緒；目前尚未允許跳轉播放。')
      return
    }
    const matching = schedule.filter(entry => entry.measureIndex === measureIndex)
    if (!matching.length) {
      setStatus(`找不到 PDF 第 ${measureIndex + 1} 小節的播放時間。`)
      return
    }
    // If this bar appears again later due to a repeat, prefer the next occurrence still ahead of the playhead.
    const occurrence = matching.find(entry => entry.endSeconds > currentTimeRef.current + 0.2) ?? matching[0]
    const audio = audioRef.current
    if (!audio) {
      setStatus(`已定位第 ${measureIndex + 1} 小節，但 MP3 尚未就緒。`)
      return
    }

    audio.pause()
    setPlaying(false)
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number.POSITIVE_INFINITY
    const expectedTarget = Math.max(0, Math.min(duration, occurrence.startSeconds))
    const seekSucceeded = await seekToTime(expectedTarget)
    const actualTarget = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    if (!seekSucceeded || Math.abs(actualTarget - expectedTarget) > 0.35) {
      // Keep the reader usable so the user can retry. Crucially, do not call play() when
      // the browser stayed at the old position; report the concrete media state instead.
      const seekableCount = (() => { try { return audio.seekable.length } catch { return 0 } })()
      setStatus(`小節跳轉尚未完成：PDF 第 ${measureIndex + 1} 小節，目標 ${formatTime(expectedTarget)}，音訊實際位置 ${formatTime(actualTarget)}；readyState=${audio.readyState}、networkState=${audio.networkState}、seekable ranges=${seekableCount}。已保持暫停，請稍後再試。`)
      return
    }
    try {
      await audio.play()
      setPlaying(true)
      setCurrentTime(audio.currentTime || expectedTarget)
      setStatus(`已跳至 PDF 第 ${measureIndex + 1} 小節 · 演奏順序第 ${occurrence.occurrence + 1} 次 · 目標音訊時間 ${formatTime(expectedTarget)}。`)
    } catch (playError) {
      setStatus(`已定位第 ${measureIndex + 1} 小節，目標音訊時間 ${formatTime(expectedTarget)}。`)
      setError(`小節位置已設定，但播放啟動失敗：${playError instanceof Error ? playError.message : String(playError)}`)
    }
  }, [schedule, seekToTime, midiTiming, mp3Ready])

  const currentTheoryHud = useMemo(() => {
    if (!displayTheoryAnalysis?.measures.length) return null
    const measureIndex = playing && cursor.measureIndex >= 0 ? cursor.measureIndex : selectedTheoryMeasureIndex
    const measure = displayTheoryAnalysis.measures.find(item => item.sourceIndex === measureIndex)
    if (!measure) return null
    const measureMeta = parsed?.measures.find(item => item.index === measureIndex)
    const withinMeasureQuarter = playing && cursor.measureIndex === measureIndex && measureMeta
      ? cursor.progress * measureMeta.durationQuarter
      : 0
    let activeChord = measure.chords[0] ?? measure.primaryChord
    for (const chord of measure.chords) {
      if (chord.onsetQuarter <= withinMeasureQuarter + 0.035) activeChord = chord
      else break
    }
    const octaveNotes = measure.notes
      .filter(note => !note.isGrace && note.onsetQuarter <= withinMeasureQuarter + 0.04 && note.onsetQuarter + Math.max(0.06, note.durationQuarter) > withinMeasureQuarter - 0.04)
      .sort((a, b) => a.midi - b.midi)
      .map(note => note.name)
      .filter((name, index, all) => all.indexOf(name) === index)
      .slice(0, 10)
    const nearbyHints = measure.nonChordHints.filter(hint => Math.abs(hint.onsetQuarter - withinMeasureQuarter) <= 0.35)
    return {
      measure,
      activeChord,
      chordSequence: measure.chords.map(chord => chord.symbol).filter((value, index, all) => index === 0 || value !== all[index - 1]).join(' → '),
      octaveNotes,
      bassName: measure.bassName || '低音資訊不足',
      roman: activeChord?.roman || measure.primaryChord?.roman || '級數未確定',
      nonChordText: nearbyHints.length
        ? nearbyHints.map(hint => `${hint.noteName}（${hint.label}）`).join('、')
        : '暫無候選音',
    }
  }, [displayTheoryAnalysis, playing, cursor.measureIndex, cursor.progress, selectedTheoryMeasureIndex, parsed])

  usePdfPageAnchoredTheoryHud(scoreWithCurrentMeasureRef, '.manbanpai-pdf-page', Boolean(currentTheoryHud && !loading && !error && !theoryError), playing)

  useEffect(() => {
    if (playing && cursor.measureIndex >= 0) {
      setSelectedTheoryMeasureIndex(previous => previous === cursor.measureIndex ? previous : cursor.measureIndex)
      setTheoryCardHighlightMeasureIndex(cursor.measureIndex)
    }
  }, [playing, cursor.measureIndex])

  const cursorAnchorTimes = useMemo(() => {
    if (cursor.occurrence < 0) return []
    return schedule[cursor.occurrence]?.noteAnchorTimes ?? []
  }, [schedule, cursor.occurrence])

  const actualDuration = audioDuration || parsed?.theoreticalDurationSeconds || 0
  const playbackReady = Boolean(parsed && midiTiming && mp3Ready && !loading && !error)
  const timingDifference = midiTiming && audioDuration > 0
    ? Math.abs(midiTiming.durationSeconds - audioDuration)
    : 0
  const timingDifferencePct = midiTiming && audioDuration > 0
    ? (timingDifference / Math.max(midiTiming.durationSeconds, audioDuration, 0.01)) * 100
    : 0

  return (
    <main className="manbanpai-reader-page" style={{ minHeight: '100vh', background: colors.bg, color: colors.text, padding: '12px 16px 36px', boxSizing: 'border-box', fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' }}>
      <audio
            ref={audioRef}
            src={mp3Url}
            preload="metadata"
            onLoadedMetadata={event => {
              const audio = event.currentTarget
              setAudioDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
              setCurrentTime(audio.currentTime || 0)
              setMp3Ready(true)
            }}
            onCanPlay={() => setMp3Ready(true)}
            onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime || 0)}
            onSeeking={event => setCurrentTime(event.currentTarget.currentTime || 0)}
            onSeeked={event => setCurrentTime(event.currentTarget.currentTime || 0)}
            onEnded={event => {
              setPlaying(false)
              setCurrentTime(event.currentTarget.duration || 0)
            }}
            onError={reportAudioError}
           style={{ display: 'none' }} />
<section style={{ width: 'min(1180px, 100%)', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 5 }}>
          <div style={{ minWidth: 0, flex: '1 1 520px' }}>
          <div style={{ color: colors.gold, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>GUITAR FINGERSTYLE · PDF + MP3</div>
          <h1 style={{ margin: '7px 0 5px', fontSize: 25, lineHeight: 1.25 }}>慢半拍譜間 · 吉他指彈譜</h1>
          <p style={{ color: colors.muted, lineHeight: 1.65, margin: 0, maxWidth: 980 }}>
            本閱讀器專供「吉他指彈譜」：PDF 顯示原始五線譜＋六線 TAB；MP3 是唯一實際發聲來源並提供播放時鐘；MIDI 必需，用於對照 MusicXML 的演奏順序與起音時間；MusicXML 必需，用於小節／音符結構、五線譜與 TAB 的對位參考及樂理分析。此模組與既有「吉他彈唱譜」核心分開，不會覆蓋或改寫彈唱邏輯。
          </p>
          </div>
          <ManbanpaiThemeToggle />
        </div>
        <GuitarSettingsPanel xmlText={musicXmlText} />
        <ScoreHeaderControls
          currentTime={currentTime} duration={actualDuration} playing={playing} ready={playbackReady}
          rate={rate} zoom={zoom} theoryOpen={showTheoryPanel}
          onTogglePlay={() => void togglePlayback()} onReplay={() => void replayFromStart()}
          onRateChange={value => { setRate(value); if (audioRef.current) audioRef.current.playbackRate = value }}
          onToggleTheory={() => setShowTheoryPanel(value => !value)} onZoomChange={setZoom}
        />

        {isAdmin && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, margin: '12px 0 14px' }}>
          <div style={{ border: `1px solid ${colors.line}`, borderRadius: 12, background: colors.panel, padding: 14 }}>
            <div style={{ fontSize: 11, color: colors.soft, marginBottom: 5 }}>播放狀態</div>
            <div style={{ fontSize: 14, lineHeight: 1.55, overflowWrap: 'anywhere' }}>{status}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: colors.soft }}>
              {loading ? '正在讀取 XML…' : parsed ? `XML：${parsed.measures.length} 小節 · 展開後 ${parsed.playbackOrder.length} 次小節` : 'XML 尚未完成讀取'}
            </div>
          </div>
          <div style={{ border: `1px solid ${colors.line}`, borderRadius: 12, background: colors.panel, padding: 14 }}>
            <div style={{ fontSize: 11, color: colors.soft, marginBottom: 5 }}>時間軸檢查</div>
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              <div>MP3 時長：<strong>{audioDuration ? formatTime(audioDuration) : '讀取中…'}</strong></div>
              <div>MIDI 時長：<strong>{midiTiming ? formatTime(midiTiming.durationSeconds) : (midiError || '讀取中…')}</strong></div>
              <div>小節映射：<strong>{schedule.length ? `${schedule.length} 次演奏位置` : '準備中…'}</strong></div>
              <div>聲音來源：<strong>{mp3Ready ? 'MP3 音源' : 'MP3 尚未就緒'}</strong> · MIDI：<strong>{midiTiming ? '必需時間參考已讀取' : '必需檔案未就緒'}</strong></div>
              <div>同起音合併：<strong>50 ms</strong>（同一指彈和弦／同時起音事件合併為對位組）</div>
              {midiAlignment && (
                <div>MIDI/XML 起音匹配：<strong>{midiAlignment.matchedCount}/{midiAlignment.xmlEvents.length}</strong>（{midiAlignment.coveragePct.toFixed(0)}%）</div>
              )}
              {midiAlignment && (
                <div>高相似匹配：<strong>{midiAlignment.strongMatchCount}/{midiAlignment.xmlEvents.length}</strong>（{midiAlignment.strongCoveragePct.toFixed(0)}%）</div>
              )}
              {midiAlignment && (
                <div>匹配音軌：<strong>{midiAlignment.trackLabel}</strong> · 音高校正 <strong>{midiAlignment.pitchShift > 0 ? '+' : ''}{midiAlignment.pitchShift}</strong> 半音</div>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginTop: 8, color: colors.muted, fontSize: 11.5 }}>
              <label htmlFor="fingerstyle-mp3-offset">MP3／MIDI 對位偏移 {mp3Offset >= 0 ? '+' : ''}{mp3Offset.toFixed(2)} 秒</label>
              <input id="fingerstyle-mp3-offset" aria-label="吉他指彈 MP3 與 MIDI 對位偏移" type="range" min={-0.3} max={0.3} step={0.01} value={mp3Offset} onChange={event => setMp3Offset(Number(event.target.value))} style={{ width: 135, accentColor: colors.gold }} disabled={!midiTiming || !mp3Ready} />
              <button type="button" onClick={() => setMp3Offset(0)} style={buttonStyle(colors)}>重設為 0.00 秒</button>
            </div>
            {midiTiming && audioDuration > 0 && (
              <div style={{ marginTop: 5, color: timingDifferencePct > 8 ? colors.warn : colors.soft, fontSize: 11.5 }}>
                MIDI 與 MP3 時長差 {formatTime(timingDifference)}（約 {timingDifferencePct.toFixed(1)}%）
                {timingDifferencePct > 8 ? '，需留意兩份匯出檔是否包含相同反覆段／速度。' : '，整體時長相近。'}
              </div>
            )}
            {midiAlignment && (midiAlignment.coveragePct < 70 || midiAlignment.strongCoveragePct < 60) && (
              <div style={{ marginTop: 6, color: colors.warn, fontSize: 11.5 }}>
                MIDI/XML 高相似匹配率偏低；未匹配或僅部分相似的音符會退回 XML 節奏估算，不能視為逐音符精確對齊。
              </div>
            )}
            {!midiAlignment && midiTiming && parsed && (
              <div style={{ marginTop: 6, color: colors.warn, fontSize: 11.5 }}>
                MIDI 已載入，但尚未找到足夠音符對應；本次播放將以 MIDI 時長與 MusicXML 節奏建立小節時間軸，逐音符定位精度可能受限。
              </div>
            )}
            {midiError && <div style={{ marginTop: 6, color: colors.warn, fontSize: 11.5 }}>MIDI 必需檔案校驗失敗：{midiError}。請修復 MIDI 附件後重新載入。</div>}
          </div>
        </div>}

        {error && <div role="alert" style={{ border: '1px solid rgba(226,186,114,.5)', background: 'rgba(226,186,114,.09)', color: colors.warn, padding: 11, borderRadius: 10, margin: '0 0 12px', lineHeight: 1.5 }}>{error}</div>}



        {loading && <div style={{ color: colors.muted, padding: 10 }}>正在分析 MusicXML 小節時值與反覆記號…</div>}
        {parsed && (
          <div ref={scoreWithCurrentMeasureRef} className="score-room-score-with-current-measure" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignItems: 'start', position: 'relative' }}>
            <div style={{ gridArea: '1 / 1', minWidth: 0 }}>
              <FingerstylePdfScoreDisplay
                          fileUrl={pdfUrl}
                          measureCount={parsed.measures.length}
                          cursorMeasureIndex={cursor.measureIndex}
                          cursorProgress={cursor.progress}
                          cursorAnchorTimes={cursorAnchorTimes}
                          zoom={zoom}
                          autoFollow={autoFollow}
                          onMeasureClick={onMeasureClick}
                          theoryLabels={theoryLabels}
                          selectedTheoryMeasureIndex={selectedTheoryMeasureIndex}
                          onTheoryLabelClick={handleTheoryLabelClick}
                        />
            </div>
            {currentTheoryHud && !loading && !error && !theoryError && (
                      <>
                        <style>{`
                          .score-room-theory-panel .score-room-theory-measure-card:focus { outline: none; }
                          .score-room-theory-panel .score-room-theory-measure-card:focus-visible { outline: 2px solid rgba(153,101,17,.82); outline-offset: -3px; }
                          @media (max-width: 760px) {
                            .score-room-theory-panel { left: 12px !important; right: 12px !important; top: 62px !important; bottom: 12px !important; width: auto !important; }
                          }
                        `}</style>
                        <aside
                    className="score-room-current-theory-hud"
                    data-compact={playing ? 'false' : 'true'}
                    lang="zh-TW"
                    aria-label="目前小節樂理摘要"
                    style={{
                      position: 'sticky', zIndex: 1190, gridArea: '1 / 1', justifySelf: 'start', alignSelf: 'start', top: 12,
                      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 3,
                      width: playing ? 'min(390px, calc(100vw - 24px))' : 'fit-content', maxWidth: playing ? 'calc(100vw - 24px)' : 'min(270px, calc(100vw - 24px))', minWidth: 0,
                      boxSizing: 'border-box', padding: '6px 9px', borderRadius: 10, overflow: 'hidden',
                      border: theme === 'day' ? '1px solid rgba(148,126,79,.70)' : '1px solid rgba(217,183,121,.62)',
                      background: theme === 'day' ? 'rgba(255,252,244,.17)' : 'rgba(17,24,33,.32)',
                      color: theme === 'day' ? '#303844' : '#e9edf2',
                      boxShadow: theme === 'day' ? '0 8px 28px rgba(63,53,36,.18), inset 0 1px 0 rgba(255,255,255,.92), inset 0 -1px 0 rgba(145,113,54,.16)' : '0 8px 28px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.20), inset 0 -1px 0 rgba(255,255,255,.06)',
                      backdropFilter: 'blur(40px) saturate(200%)', WebkitBackdropFilter: 'blur(40px) saturate(200%)',
                      fontFamily: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif',
                    }}
                  >
                    {playing ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0, lineHeight: 1.25 }}>
                          <strong style={{ color: theme === 'day' ? '#6f511a' : '#f1d99b', fontSize: 12, fontWeight: 850, whiteSpace: 'nowrap' }}>當前小節：{currentTheoryHud.measure.printedNumber}</strong>
                          <span style={{ color: theme === 'day' ? '#68717d' : '#9ba8b5', fontSize: 9, whiteSpace: 'nowrap' }}>播放中</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, .9fr) minmax(0, .9fr) minmax(0, 1.35fr) minmax(0, .65fr) minmax(0, 1.4fr)', alignItems: 'baseline', columnGap: 5, width: '100%', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: 1.2, paddingBottom: 1 }}>
                          <div title={currentTheoryHud.activeChord?.symbol ?? '未確定'} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9 }}>和弦</span>
                            <strong style={{ color: theme === 'day' ? '#75520e' : '#f1d99b', fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.activeChord?.symbol ?? '未確定'}</strong>
                          </div>
                          <div title={currentTheoryHud.roman} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9 }}>級數</span>
                            <strong style={{ color: theme === 'day' ? '#775e25' : '#d8c18e', fontSize: 10.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.roman}</strong>
                          </div>
                          <div title={currentTheoryHud.octaveNotes.length ? currentTheoryHud.octaveNotes.join(' · ') : (currentTheoryHud.activeChord?.toneNames?.join(' · ') || '音高資訊不足')} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>構成音</span>
                            <span style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.octaveNotes.length ? currentTheoryHud.octaveNotes.join(' · ') : (currentTheoryHud.activeChord?.toneNames?.join(' · ') || '音高資訊不足')}</span>
                          </div>
                          <div title={currentTheoryHud.bassName} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9 }}>低音</span>
                            <strong style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.bassName}</strong>
                          </div>
                          <div title={currentTheoryHud.nonChordText} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>非和弦候選</span>
                            <span style={{ color: currentTheoryHud.nonChordText === '暫無候選音' ? (theme === 'day' ? '#737d88' : '#8f9ca8') : (theme === 'day' ? '#815a18' : '#e5c489'), fontSize: 9.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.nonChordText}</span>
                          </div>
                        </div>
                      </>
                    ) : (
<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3, width: 'max-content', maxWidth: '100%', minWidth: 0, lineHeight: 1.2 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: 'max-content', maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap' }}>
                          <div title={`${currentTheoryHud.activeChord?.symbol ?? '未確定'} / ${currentTheoryHud.roman}`} style={{ display: 'flex', alignItems: 'baseline', gap: 3, flex: '0 0 auto', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>和弦</span>
                            <strong style={{ color: theme === 'day' ? '#75520e' : '#f1d99b', fontSize: 10.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.activeChord?.symbol ?? '未確定'}</strong>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>/</span>
                            <strong style={{ color: theme === 'day' ? '#775e25' : '#d8c18e', fontSize: 10, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.roman}</strong>
                          </div>
                          <div title={currentTheoryHud.octaveNotes.length ? currentTheoryHud.octaveNotes.join(' · ') : (currentTheoryHud.activeChord?.toneNames?.join(' · ') || '音高資訊不足')} style={{ display: 'flex', alignItems: 'baseline', gap: 3, flex: '0 1 auto', minWidth: 0, maxWidth: 150, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>構成音</span>
                            <span style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.octaveNotes.length ? currentTheoryHud.octaveNotes.join(' · ') : (currentTheoryHud.activeChord?.toneNames?.join(' · ') || '音高資訊不足')}</span>
                          </div>
                        </div>
                        <div title={currentTheoryHud.bassName} style={{ display: 'flex', alignItems: 'baseline', gap: 3, width: 'max-content', maxWidth: '100%', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                          <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>低音</span>
                          <strong style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, minWidth: 0, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTheoryHud.bassName}</strong>
                        </div>
                      </div>
                    )}
</aside>
                      </>
                    )}
          </div>
        )}        {!loading && !error && (
          <aside
            className="score-room-theory-panel"
            lang="zh-TW"
            role="dialog"
            aria-label="樂理分析面板"
            aria-modal="false"
            aria-hidden={!showTheoryPanel}
            style={{
              position: 'fixed', zIndex: 1200, right: 16, top: 82, bottom: 18,
              width: 'min(430px, calc(100vw - 24px))', minHeight: 180,
              boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden',
              borderRadius: 16, border: '1px solid rgba(217,183,121,.60)',
              background: 'rgba(17,24,33,.48)', color: '#e9edf2',
              boxShadow: '0 22px 60px rgba(0,0,0,.44), inset 0 1px 0 rgba(255,255,255,.13), inset 0 -1px 0 rgba(255,255,255,.045)',
              backdropFilter: 'blur(40px) saturate(190%)', WebkitBackdropFilter: 'blur(40px) saturate(190%)',
              backgroundClip: 'padding-box', isolation: 'isolate',
              opacity: showTheoryPanel ? 1 : 0,
              // Keep the glass panel stationary during its fade to avoid a transient bright edge.
              transform: 'none',
              visibility: showTheoryPanel ? 'visible' : 'hidden',
              pointerEvents: showTheoryPanel ? 'auto' : 'none',
              transition: showTheoryPanel
                ? 'opacity .2s ease, visibility 0s linear 0s'
                : 'opacity .18s ease, visibility 0s linear .18s',
              willChange: 'opacity',
              fontFamily: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif',
            }}
          >
            <div style={{ flexShrink: 0, padding: '14px 16px 11px', borderBottom: '1px solid rgba(255,255,255,.17)', background: 'rgba(17,24,33,.30)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#f1d99b' }}>樂理分析</div>
                  <div style={{ marginTop: 4, fontSize: 11, color: '#aab4c0', lineHeight: 1.5 }}>MusicXML 音高、節奏、調性與和弦標記分析</div>
                </div>
                <button type="button" onClick={() => setShowTheoryPanel(false)} aria-label="隱藏樂理分析面板" title="隱藏面板；可透過播放工具列重新開啟" style={{ border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, height: 30, padding: '0 9px', background: 'rgba(255,255,255,.05)', color: '#e9edf2', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>隱藏面板</button>
              </div>
              {displayTheoryAnalysis && (
                <div aria-label="樂理分析模式" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', marginTop: 11 }}>
                  {([
                    ['chordNames', '和弦/級數'],
                    ['bassLine', '低音與走向'],
                    ['nonChordHints', '非和弦音候選'],
                    ['melodyContour', '旋律輪廓'],
                    ['none', '不顯示'],
                  ] as Array<[TheoryDisplayMode, string]>).map(([mode, label]) => (
                    <label key={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: theoryDisplayMode === mode ? '#f1d99b' : '#d1d8df', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      <input type="radio" name="pdf-score-annotation-mode" checked={theoryDisplayMode === mode} onChange={() => setTheoryDisplayMode(mode)} style={{ accentColor: '#d9b779', margin: 0 }} />{label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {theoryError && <div role="alert" style={{ padding: 12, borderRadius: 10, background: 'rgba(170,72,62,.14)', border: '1px solid rgba(231,126,110,.28)', color: '#f2b9ad', fontSize: 12, lineHeight: 1.65 }}>{theoryError}</div>}
              {!theoryAnalysis && !theoryError && <div style={{ padding: '22px 6px', textAlign: 'center', fontSize: 12, color: '#d9c69f' }}>正在讀取音符並分析和聲…</div>}
              {displayTheoryAnalysis && selectedTheoryMeasure && (() => {
                const analysisView = displayTheoryAnalysis
                const orderedMeasures = analysisView.measures
                const selected = selectedTheoryMeasure
                const bassRoute = orderedMeasures.filter(item => item.bassMidi !== null)
                const chordSequence = orderedMeasures.filter(item => item.primaryChord)
                const voiceLeadingPairs = chordSequence.slice(0, -1).map((measure, index) => ({ from: measure, to: chordSequence[index + 1] }))
                  .filter(pair => pair.to.sourceIndex > pair.from.sourceIndex)
                  .slice(0, 12)
                const modeCaption = theoryDisplayMode === 'none' ? '不顯示'
                  : theoryDisplayMode === 'chordNames' ? '和弦 / 級數'
                  : theoryDisplayMode === 'bassLine' ? '低音'
                  : theoryDisplayMode === 'nonChordHints' ? '非和弦音'
                  : '旋律輪廓'
                return (
                  <>
                    <div style={{ padding: 12, borderRadius: 12, background: 'linear-gradient(135deg,rgba(217,183,121,.13),rgba(255,255,255,.025))', border: '1px solid rgba(217,183,121,.22)' }}>
                      <div style={{ fontWeight: 750, fontSize: 14, color: '#f3e5c9', lineHeight: 1.5 }}>{analysisView.title}</div>
                      {analysisView.composer && <div style={{ fontSize: 11, color: '#aeb8c2', marginTop: 3 }}>{analysisView.composer}</div>}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, marginTop: 11 }}>
                        {[
                          ['調性', analysisView.keyName],
                          ['拍號', analysisView.meter],
                          ['速度', analysisView.tempo ? `${Math.round(analysisView.tempo)} BPM` : '未標註'],
                          ['小節數', String(analysisView.measures.length)],
                        ].map(([label, value]) => <div key={label} style={{ padding: '8px 9px', borderRadius: 9, background: 'rgba(0,0,0,.18)' }}><div style={{ fontSize: 10, color: '#98a4b0' }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, fontWeight: 750, color: '#f1d99b' }}>{value}</div></div>)}
                      </div>
                      <div style={{ marginTop: 8, color: '#929eaa', fontSize: 10, lineHeight: 1.5 }}>{analysisView.keySource}</div>
                    </div>

                    <section>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: '#e9edf2' }}>和弦進行</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <div style={{ fontSize: 10, color: '#87929e' }}>逐小節對照；點擊卡片定位並播放</div>
                          {Object.keys(theoryCorrections).length > 0 && <button type="button" onClick={() => { if (window.confirm('清除目前樂譜的所有人工和弦校正？')) setTheoryCorrections({}) }} style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 6, background: 'rgba(255,255,255,.04)', color: '#c0c8d1', padding: '4px 6px', fontSize: 9.5, cursor: 'pointer' }}>清除人工校正</button>}
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6 }}>
                        {orderedMeasures.map(measure => {
                          const chord = measure.primaryChord
                          // Use the committed theory-card selection only. Avoid highlighting a stale cursor
                          // (often the first measure) while an asynchronous seek is being committed.
                          const active = theoryCardHighlightMeasureIndex !== null && measure.sourceIndex === theoryCardHighlightMeasureIndex
                          const nextBass = orderedMeasures.find(item => item.sourceIndex > measure.sourceIndex && item.bassMidi !== null)
                          const bassArrow = !nextBass || measure.bassMidi === null ? '' : nextBass.bassMidi! > measure.bassMidi ? ' ↗' : nextBass.bassMidi! < measure.bassMidi ? ' ↘' : ' →'
                          const hints = measure.nonChordHints ?? []
                          let primary = chord?.symbol ?? '—'
                          let secondary = chord?.roman ?? '未確定'
                          if (theoryDisplayMode === 'bassLine') { primary = `${measure.bassName || '低音未確定'}${bassArrow}`; secondary = nextBass ? `下一小節：${nextBass.bassName}` : '後續低音不足' }
                          else if (theoryDisplayMode === 'nonChordHints') { primary = hints.length ? hints.slice(0, 2).map(hint => `${hint.noteName}·${hint.label}`).join('、') : '無候選'; secondary = hints.length ? `${hints.length} 個非和弦音候選` : '本小節沒有候選提示' }
                          else if (theoryDisplayMode === 'melodyContour') { primary = measure.melodyContour || '旋律資訊不足'; secondary = measure.melodyTrend || measure.melodyRange || '走向資訊不足' }
                          return <button className="score-room-theory-measure-card" key={`${measure.sourceIndex}-${measure.printedNumber}`} type="button" onClick={() => { setSelectedTheoryMeasureIndex(measure.sourceIndex); setTheoryCardHighlightMeasureIndex(measure.sourceIndex); setAutoFollow(true); void onMeasureClick(measure.sourceIndex) }} title={`選擇第 ${measure.printedNumber} 小節：${primary}`} aria-pressed={active} style={{ minWidth: 0, minHeight: 82, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, textAlign: 'left', padding: '8px 9px', borderRadius: 9, border: active ? (theme === 'day' ? '2px solid #7D4F0B' : '1px solid rgba(217,183,121,.96)') : `1px solid ${theme === 'day' ? 'rgba(134,111,63,.52)' : 'rgba(255,255,255,.15)'}`, background: active ? (theme === 'day' ? '#F8D890' : 'rgba(217,183,121,.30)') : (theme === 'day' ? 'rgba(255,253,247,.22)' : 'rgba(255,255,255,.065)'), boxShadow: active && theme === 'day' ? 'inset 0 0 0 1px #FFF6DC, inset 0 1px 0 rgba(255,255,255,.96), inset 0 -3px 0 rgba(125,79,11,.48)' : theme === 'day' ? '0 5px 22px rgba(0,0,0,.20), inset 0 1px 0 rgba(255,255,255,.76), inset 0 -1px 0 rgba(255,255,255,.16), 0 0 18px rgba(255,255,255,.055)' : (active ? 'inset 0 0 0 1px rgba(217,183,121,.18)' : undefined), color: theme === 'day' ? '#343d49' : '#e9edf2', cursor: 'pointer' }}>
                            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, width: '100%', fontSize: 9.5, color: active && theme === 'day' ? '#634b20' : (theme === 'day' ? '#707987' : '#9ba6b1') }}><span>小節 {measure.printedNumber}</span><span style={{ color: active && theme === 'day' ? '#68480c' : (theme === 'day' ? '#866d3b' : '#c0a66e') }}>{modeCaption}</span></span>
                            <strong style={{ display: 'block', width: '100%', fontSize: theoryDisplayMode === 'melodyContour' ? 10.5 : 13, lineHeight: 1.4, color: primary && primary !== '—' && primary !== '無候選' ? (theme === 'day' ? (active ? '#4c330a' : '#805d12') : '#f1d99b') : (theme === 'day' ? '#707987' : '#a7b0ba'), overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{primary}</strong>
                            <span style={{ display: 'block', width: '100%', fontSize: 9.5, lineHeight: 1.4, color: active && theme === 'day' ? '#554422' : (theme === 'day' ? '#67717d' : '#aab4bf'), overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{secondary}</span>
                            {(theoryDisplayMode === 'chordNames') && chord && <span style={{ fontSize: 9, lineHeight: 1.35, color: active && theme === 'day' ? '#5c4b2b' : (theme === 'day' ? '#77818c' : '#9ba6b1'), overflowWrap: 'anywhere' }}>{measure.harmonicFunction || ''}</span>}
                          </button>})}
                      </div>
                    </section>

                    <section style={{ borderTop: '1px solid rgba(255,255,255,.09)', paddingTop: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                        <div><div style={{ color: '#8f9ca8', fontSize: 10 }}>目前分析小節</div><div style={{ color: '#f1d99b', fontSize: 16, fontWeight: 850, marginTop: 3 }}>第 {selected.printedNumber} 小節</div></div>
                        <button type="button" onClick={() => void onMeasureClick(selected.sourceIndex)} style={{ border: '1px solid rgba(217,183,121,.44)', borderRadius: 8, background: 'rgba(217,183,121,.12)', color: '#f1d99b', padding: '6px 9px', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>▶ 從這裡播放</button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 7, marginBottom: 9 }}>
                        {[
                          ['低音', selected.bassName || '—'], ['旋律首尾', selected.melodyTrend || '資訊不足'], ['節拍', selected.meter], ['和聲功能', selected.harmonicFunction || '未確定'],
                        ].map(([label, value]) => <div key={label} style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.035)' }}><div style={{ color: '#93a0ad', fontSize: 10 }}>{label}</div><div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 3, overflowWrap: 'anywhere' }}>{value}</div></div>)}
                      </div>
                      <div style={{ padding: 11, borderRadius: 10, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.07)' }}>
                        <div style={{ fontSize: 10, color: '#93a0ad' }}>本小節和弦</div>
                        {selected.chords.length ? selected.chords.map((chord, index) => {
                          const correctionKey = theoryCorrectionKey(selected.sourceIndex, chord.onsetQuarter)
                          const activeCorrection = theoryCorrections[correctionKey] ?? ''
                          return <div key={`${chord.onsetQuarter}-${chord.symbol}-${index}`} style={{ padding: '9px 0', borderBottom: index < selected.chords.length - 1 ? '1px solid rgba(255,255,255,.07)' : 'none' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><strong style={{ color: '#f1d99b', fontSize: 15 }}>{chord.symbol}</strong><span style={{ color: '#b9c4ce', fontSize: 10.5 }}>{chord.roman} · {chord.confidence}</span></div>
                            <div style={{ color: '#aab4c0', fontSize: 10.5, marginTop: 5 }}>{chord.qualityLabel} · 起始位置 {Number(chord.onsetQuarter.toFixed(2))} 個四分音符 · 來源：{chord.evidenceSource ?? '音符推斷'}</div>
                            {chord.toneNames.length > 0 && <div style={{ color: '#e2e8ef', fontSize: 11, marginTop: 5 }}>構成音：{chord.toneNames.join(' · ')}</div>}
                            {chord.actualNotes.length > 0 && <div style={{ color: '#aab4c0', fontSize: 10, marginTop: 4 }}>分析視窗音符：{chord.actualNotes.join('、')} · 低音參考：{chord.bassName}</div>}
                            {chord.alternatives?.length ? <div style={{ color: '#e2ba72', fontSize: 10, marginTop: 5 }}>其他候選：{chord.alternatives.join(' / ')}</div> : null}
                            {chord.evidenceSummary?.length ? <div style={{ marginTop: 7, color: '#9ba8b5', fontSize: 10, lineHeight: 1.55 }}>{chord.evidenceSummary.map((reason, r) => <div key={`${reason}-${r}`}>• {reason}</div>)}</div> : null}
                            {chord.candidateDetails && chord.candidateDetails.length > 1 && chord.evidenceSource !== '原譜和弦標記' && <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8, color: '#9ba8b5', fontSize: 10 }}><span>人工校正（僅保存在本機）</span><select value={activeCorrection} onChange={event => updateTheoryCorrection(selected.sourceIndex, chord.onsetQuarter, event.target.value)} style={{ border: '1px solid rgba(217,183,121,.28)', borderRadius: 7, padding: '7px 8px', color: '#e9edf2', background: '#182331' }}><option value="">使用自動結果：{chord.automaticSymbol ?? chord.symbol}</option>{chord.candidateDetails.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.symbol} · {candidate.qualityLabel} · 評分 {candidate.score.toFixed(2)}</option>)}</select></label>}
                          </div>
                        }) : <div style={{ color: '#8794a0', fontSize: 11, padding: 8 }}>本小節沒有足夠的和弦證據，不能可靠地給出和弦名稱。</div>}
                      </div>
                      {selected.cadenceHint && <div style={{ marginTop: 8, padding: 9, borderRadius: 8, background: 'rgba(217,183,121,.07)', color: '#dbcaa7', fontSize: 10.5, lineHeight: 1.55 }}><strong>終止式提示：</strong>{selected.cadenceHint}</div>}
                      {selected.nonChordHints.length > 0 && <div style={{ marginTop: 9 }}><div style={{ fontSize: 11.5, fontWeight: 800, color: '#e9edf2', marginBottom: 6 }}>非和弦音候選</div>{selected.nonChordHints.slice(0, 6).map((hint, index) => <div key={`${hint.noteName}-${hint.onsetQuarter}-${index}`} style={{ padding: 8, borderRadius: 8, background: 'rgba(217,183,121,.06)', borderLeft: '2px solid rgba(217,183,121,.55)', marginBottom: 6 }}><div style={{ color: '#f1d99b', fontSize: 10.5, fontWeight: 700 }}>{hint.noteName} · {hint.label} · 第 {Number(hint.onsetQuarter.toFixed(2))} 拍位</div><div style={{ color: '#aeb8c3', fontSize: 10, lineHeight: 1.55, marginTop: 3 }}>{hint.explanation}</div></div>)}</div>}
                      <div style={{ padding: 11, marginTop: 8, borderRadius: 10, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.07)' }}>
                        <div style={{ fontSize: 10, color: '#93a0ad' }}>旋律輪廓</div><div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 4 }}>{selected.melodyContour}</div>
                        <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 9 }}>首尾走向</div><div style={{ color: '#cbd5df', fontSize: 11, marginTop: 4 }}>{selected.melodyTrend}</div>
                        <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 9 }}>旋律音域</div><div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 4 }}>{selected.melodyRange}</div>
                        {selected.melodyIntervals.length > 0 && <div style={{ marginTop: 10 }}><div style={{ fontSize: 10, color: '#93a0ad', marginBottom: 6 }}>旋律音程（前 8 個）</div><div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{selected.melodyIntervals.slice(0, 8).map((interval, index) => <div key={`${interval.fromName}-${interval.toName}-${index}`} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '5px 7px', borderRadius: 7, background: 'rgba(255,255,255,.035)' }}><span style={{ fontSize: 10.5, color: '#cbd5df' }}>{interval.fromName} → {interval.toName}</span><span style={{ fontSize: 10, color: '#f1d99b', textAlign: 'right' }}>{interval.label}</span></div>)}</div>{selected.melodyIntervals.length > 8 && <div style={{ fontSize: 10, color: '#8794a0', marginTop: 5 }}>本小節共有 {selected.melodyIntervals.length} 個音程轉換，以上顯示前 8 個。</div>}</div>}
                        <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 11 }}>節奏型概覽</div><div style={{ color: '#cbd5df', fontSize: 10.5, lineHeight: 1.65, marginTop: 4 }}>{selected.rhythmSummary}</div>
                        {selected.rhythmPattern.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>{selected.rhythmPattern.map((pattern, index) => <span key={`${pattern}-${index}`} style={{ border: '1px solid rgba(217,183,121,.17)', borderRadius: 6, padding: '4px 6px', background: 'rgba(217,183,121,.07)', color: '#dfd1b1', fontSize: 9.5 }}>{pattern}</span>)}</div>}
                        <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 10 }}>本小節低音</div><div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 4 }}>{selected.bassName}</div>
                      </div>
                    </section>

                    <section style={{ borderTop: '1px solid rgba(255,255,255,.09)', paddingTop: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>低音走向</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {bassRoute.map((measure, index) => {
                          const next = bassRoute[index + 1]
                          const trend = !next || measure.bassMidi === null || next.bassMidi === null ? '' : next.bassMidi > measure.bassMidi ? '↗' : next.bassMidi < measure.bassMidi ? '↘' : '→'
                          return <button key={measure.sourceIndex} type="button" onClick={() => { setSelectedTheoryMeasureIndex(measure.sourceIndex); void onMeasureClick(measure.sourceIndex) }} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 7, padding: '5px 7px', border: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.045)', color: '#cbd3dc', fontSize: 10.5, cursor: 'pointer' }}>小節 {measure.printedNumber}: {measure.bassName} {trend}</button>
                        })}
                      </div>
                    </section>

                    <section style={{ borderTop: '1px solid rgba(255,255,255,.09)', paddingTop: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>和弦連接與聲部進行</div>
                      <div style={{ fontSize: 10, lineHeight: 1.55, color: '#8794a0', marginBottom: 8 }}>以下為和弦音集合與根音/低音移動的簡化分析，不等同於逐聲部的嚴格對位判斷。</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {voiceLeadingPairs.map(({ from, to }) => {
                          const fromChord = from.primaryChord!
                          const toChord = to.primaryChord!
                          const fromPcs = new Set(fromChord.toneNames.map(theoryPitchClassFromName).filter((value): value is number => value !== null))
                          const shared = toChord.toneNames.filter(name => { const pc = theoryPitchClassFromName(name); return pc !== null && fromPcs.has(pc) })
                          const rootDeltaRaw = (toChord.rootPc - fromChord.rootPc + 12) % 12
                          const rootDelta = rootDeltaRaw > 6 ? rootDeltaRaw - 12 : rootDeltaRaw
                          const rootMotion = rootDelta === 0 ? '根音保持' : rootDelta > 0 ? `根音上行 ${rootDelta} 半音` : `根音下行 ${Math.abs(rootDelta)} 半音`
                          const bassDelta = from.bassMidi !== null && to.bassMidi !== null ? to.bassMidi - from.bassMidi : null
                          const bassMotion = bassDelta === null ? '' : bassDelta === 0 ? '低音保持' : bassDelta > 0 ? `低音上行 ${bassDelta} 半音` : `低音下行 ${Math.abs(bassDelta)} 半音`
                          return <button key={`${from.sourceIndex}-${to.sourceIndex}`} type="button" onClick={() => { setSelectedTheoryMeasureIndex(from.sourceIndex); void onMeasureClick(from.sourceIndex) }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4, textAlign: 'left', padding: '9px 10px', borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.035)', color: '#d6dde5', cursor: 'pointer' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><strong style={{ color: '#f1d99b', fontSize: 11 }}>小節 {from.printedNumber}: {fromChord.symbol} → {to.printedNumber}: {toChord.symbol}</strong><span style={{ color: '#a6b1bc', fontSize: 10 }}>{rootMotion}</span></div>
                            <div style={{ color: '#c4ced8', fontSize: 10.5 }}>共同音：{shared.length ? [...new Set(shared)].join(' · ') : '未發現同名共同音'}{bassMotion ? `  ·  ${bassMotion}` : ''}</div>
                          </button>
                        })}
                      </div>
                    </section>

                    <div style={{ padding: 9, borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', color: '#85919d', fontSize: 10, lineHeight: 1.6 }}>
                      分析範圍：調性、和弦構成音、羅馬數字級數、和聲功能、常見終止式候選、部分旋律非和弦音、旋律音程/輪廓/音域、基礎節奏型及低音線。規則分析屬於學習線索；復調、複雜節奏與自動推斷候選仍需人工復核。人工校正只保存在本機瀏覽器，不呼叫雲端 API。
                    </div>
                  </>
                )
              })()}
            </div>
          </aside>
        )}

        {!showTheoryPanel && !loading && !error && (
          <button
            type="button"
            onClick={() => setShowTheoryPanel(true)}
            aria-label="顯示樂理分析面板"
            aria-expanded={false}
            title="顯示樂理分析面板"
            style={{
              position: 'fixed', zIndex: 1001, right: 0, top: '43%', transform: 'translateY(-50%)',
              writingMode: 'vertical-rl', textOrientation: 'mixed',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              minHeight: 116, padding: '13px 9px', borderRadius: '12px 0 0 12px',
              border: '1px solid rgba(227,201,151,.68)', borderRight: 0,
              background: 'rgba(17,24,33,.52)', color: '#f1d99b',
              fontSize: 12, fontWeight: 750, cursor: 'pointer', letterSpacing: .4,
              boxShadow: '0 12px 32px rgba(0,0,0,.36), inset 0 1px 0 rgba(255,255,255,.18)',
              backdropFilter: 'blur(36px) saturate(190%)', WebkitBackdropFilter: 'blur(36px) saturate(190%)',
            }}
          >♫ 樂理分析</button>
        )}

        <p style={{ color: colors.soft, fontSize: 11, lineHeight: 1.65, marginTop: 12 }}>
          MIDI 事件校準候選版：從 MIDI 解析音符起音、tick 和 tempo，按音高集合與順序對齊 MusicXML 的音符事件，使用匹配到的實際 MIDI 時間驅動每小節錨點；PDF.js 仍按可提取的吉他品格數字建立橫向位置。未匹配事件退回 XML 時值估算，匹配率會顯示在上方。這是單曲本地實驗，尚未證明可適配所有 MIDI/PDF 匯出。
        </p>
        <PlaybackControlBar
          label="吉他指彈 MP3" currentTime={currentTime} duration={actualDuration} playing={playing} ready={playbackReady}
          scoreTempo={parsed?.measures[cursor.measureIndex]?.tempo ?? parsed?.measures[0]?.tempo ?? 80} meter={parsed?.meter ?? '4/4'}
          rate={rate} autoFollow={autoFollow} onTogglePlay={() => void togglePlayback()}
          onStop={stopPlayback} zoom={zoom} onZoomChange={setZoom} theoryOpen={showTheoryPanel} onToggleTheory={() => setShowTheoryPanel(value => !value)}
          onSeek={time => { void seekToTime(time) }} onSkip={seekBySeconds}
          onRateChange={value => { setRate(value); if (audioRef.current) audioRef.current.playbackRate = value }}
          onAutoFollowChange={setAutoFollow} loopStart={loopStart} loopEnd={loopEnd} loopEnabled={loopEnabled}
          onMarkLoopStart={markLoopStart} onMarkLoopEnd={markLoopEnd} onClearLoop={clearLoop}
        />
      </section>
    </main>
  )
}

function buttonStyle(colors: typeof nightColors): CSSProperties {
  return {
    border: `1px solid ${colors.line}`,
    borderRadius: 9,
    padding: '9px 13px',
    color: colors.text,
    background: colors.panelSoft,
    cursor: 'pointer',
    fontWeight: 600,
  }
}

function selectStyle(colors: typeof nightColors): CSSProperties {
  return {
    border: `1px solid ${colors.line}`,
    borderRadius: 8,
    padding: '7px 8px',
    color: colors.text,
    background: colors.panelSoft,
  }
}
