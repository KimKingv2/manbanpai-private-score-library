import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ManbanpaiThemeToggle, useManbanpaiTheme } from './ManbanpaiTheme'
import PianoPdfScoreDisplay, { type PianoChordLabel } from './PianoPdfScoreDisplay'
import PlaybackControlBar from './PlaybackControlBar'
import ScoreHeaderControls from './ScoreHeaderControls'
import { analyseMusicXmlTheory, applyTheoryChordCorrections, theoryCorrectionId, theoryCorrectionStorageKey, type ScoreTheoryAnalysis } from './PianoMusicTheory'

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
  /** Engraved horizontal position from MusicXML, normalized by the written measure width. */
  layoutPosition: number
}

type RawXmlNoteEvent = {
  onsetQuarter: number
  pitches: number[]
  matchPitches: number[]
  layoutX: number | null
}

type MeasureInfo = {
  index: number
  printedNumber: string
  startsSystem: boolean
  durationQuarter: number
  tempo: number
  meter: string
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
  /** Per-note horizontal positions from MusicXML layout, normalized to the PDF measure box. */
  noteAnchorPositions: number[]
  matchedNoteEvents: number
}

type ParsedScore = {
  measures: MeasureInfo[]
  playbackOrder: number[]
  repeatDescription: string
  theoreticalDurationSeconds: number
  meter: string
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

const PDF_URL = '/piano-pdf-mp3-test/piano.pdf'
const XML_URL = '/piano-pdf-mp3-test/piano.musicxml'
const MIDI_URL = '/piano-pdf-mp3-test/piano.mid'
const MP3_URL = '/piano-pdf-mp3-test/piano.mp3'

export type PianoPdfMp3TestProps = {
  isAdmin?: boolean
  pdfUrl?: string
  xmlUrl?: string
  midiUrl?: string
  mp3Url?: string
}
type TheoryViewMode = 'none' | 'chordNames' | 'bassLine' | 'nonChordHints' | 'melodyContour'

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

function measureNoteEventsInQuarters(measure: Element, initialDivisions: number): RawXmlNoteEvent[] {
  let divisions = initialDivisions
  let cursorQuarter = 0
  let lastNoteOnsetQuarter = 0
  const byOnset = new Map<string, { pitches: Set<number>; matchPitches: Set<number>; layoutXs: number[] }>()

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
        const group = byOnset.get(key) ?? { pitches: new Set<number>(), matchPitches: new Set<number>(), layoutXs: [] }
        group.pitches.add(pitch)
        const defaultX = Number(child.getAttribute('default-x'))
        if (child.hasAttribute('default-x') && Number.isFinite(defaultX)) group.layoutXs.push(defaultX)
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
      layoutX: group.layoutXs.length ? group.layoutXs.reduce((sum, value) => sum + value, 0) / group.layoutXs.length : null,
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
  const document = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parseError = descendants(document.documentElement, 'parsererror')[0]
  if (parseError || document.documentElement.localName === 'parsererror') {
    throw new Error('MusicXML 格式無法解析。')
  }
  // Piano exporters may store the grand staff as one part with two staves or as separate
  // right-/left-hand parts. Use the first part as the measure/repeat skeleton and merge all
  // parts' notes at the same notated onset for better MIDI event matching.
  const parts = descendants(document.documentElement, 'part').filter(item => directChildren(item, 'measure').length > 0)
  if (!parts.length) throw new Error('MusicXML 中沒有找到 part。')
  const xmlMeasures = directChildren(parts[0], 'measure')
  if (!xmlMeasures.length) throw new Error('MusicXML 中沒有找到小節。')
  const firstTime = descendants(document.documentElement, 'time')[0] ?? null
  const meterBeats = firstTime ? directChildren(firstTime, 'beats').map(node => textOf(node)).filter(Boolean).join('+') : ''
  const meterBeatType = firstTime ? textOf(firstChild(firstTime, 'beat-type')) : ''
  const meter = meterBeats && meterBeatType ? `${meterBeats}/${meterBeatType}` : '4/4'

  const divisionsByPart = parts.map(() => 1)
  const meterByPart = parts.map(() => ({ beats: '4', beatType: 4 }))
  let tempo = 120
  const measures: MeasureInfo[] = xmlMeasures.map((primaryMeasure, index) => {
    let durationQuarter = 0
    const merged = new Map<string, { pitches: Set<number>; matchPitches: Set<number>; layoutXs: number[] }>()
    let measureLayoutWidth = Number(primaryMeasure.getAttribute('width'))
    if (!Number.isFinite(measureLayoutWidth) || measureLayoutWidth <= 0) measureLayoutWidth = 0
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const partMeasure = directChildren(parts[partIndex], 'measure')[index]
      if (!partMeasure) continue
      for (const attributes of directChildren(partMeasure, 'attributes')) {
        const value = Number(textOf(firstChild(attributes, 'divisions')))
        if (Number.isFinite(value) && value > 0) divisionsByPart[partIndex] = value
        const time = firstChild(attributes, 'time')
        if (time) {
          const beats = textOf(firstChild(time, 'beats'))
          const beatType = Number(textOf(firstChild(time, 'beat-type')))
          if (beats && Number.isFinite(beatType) && beatType > 0) meterByPart[partIndex] = { beats, beatType }
        }
      }
      tempo = readTempoInMeasure(partMeasure, tempo)
      durationQuarter = Math.max(durationQuarter, measureDurationInQuarters(partMeasure, divisionsByPart[partIndex]))
      for (const event of measureNoteEventsInQuarters(partMeasure, divisionsByPart[partIndex])) {
        const key = event.onsetQuarter.toFixed(6)
        const group = merged.get(key) ?? { pitches: new Set<number>(), matchPitches: new Set<number>(), layoutXs: [] }
        event.pitches.forEach(pitch => group.pitches.add(pitch))
        event.matchPitches.forEach(pitch => group.matchPitches.add(pitch))
        if (event.layoutX !== null && Number.isFinite(event.layoutX)) group.layoutXs.push(event.layoutX)
        if (event.layoutX !== null && Number.isFinite(event.layoutX)) measureLayoutWidth = Math.max(measureLayoutWidth, event.layoutX + 24)
        merged.set(key, group)
      }
    }
    if (!(measureLayoutWidth > 0)) measureLayoutWidth = Math.max(1, durationQuarter * 60)
    const startsSystem = index === 0 || directChildren(primaryMeasure, 'print').some(print =>
      print.getAttribute('new-system') === 'yes' || print.getAttribute('new-page') === 'yes')
    // For a system-start measure, MusicXML default-x includes the left indentation for
    // clef/key/time signatures (often around 87 pt rather than 12.5 pt). The corresponding
    // PDF first-measure box begins at the visual system/staff left edge, before that indentation,
    // so cursor anchors must stay in the same coordinate frame. Subtracting the indentation
    // moved the first note cursor too far left into the clef area even though the measure range
    // was correct. Keep original X coordinates and the full measure width for anchor mapping.
    const measureLocalWidth = Math.max(1, measureLayoutWidth)
    const noteEvents: XmlNoteEvent[] = [...merged.entries()]
      .map(([key, group]) => {
        const onsetQuarter = Number(key)
        const layoutX = group.layoutXs.length
          ? group.layoutXs.reduce((sum, value) => sum + value, 0) / group.layoutXs.length
          : null
        const measureLocalX = layoutX !== null && Number.isFinite(layoutX) ? layoutX : null
        const fallbackPosition = durationQuarter > 0 ? onsetQuarter / durationQuarter : 0
        const layoutPosition = measureLocalX !== null && Number.isFinite(measureLocalX)
          ? Math.max(0, Math.min(1, measureLocalX / measureLocalWidth))
          : Math.max(0, Math.min(1, fallbackPosition))
        return {
          onsetQuarter,
          pitches: [...group.pitches].sort((a, b) => a - b),
          matchPitches: [...group.matchPitches].sort((a, b) => a - b),
          layoutPosition,
        }
      })
      .sort((a, b) => a.onsetQuarter - b.onsetQuarter)
    // Keep timing and engraving anchors in the same chronological order, even if an exporter
    // emits slightly inconsistent horizontal coordinates for simultaneous piano voices.
    let previousPosition = 0
    for (const event of noteEvents) {
      event.layoutPosition = Math.max(previousPosition, event.layoutPosition)
      previousPosition = event.layoutPosition
    }
    const noteOnsetsQuarter = noteEvents.map(event => event.onsetQuarter)
    return {
      index,
      printedNumber: primaryMeasure.getAttribute('number') || String(index + 1),
      startsSystem,
      durationQuarter,
      tempo,
      meter: `${meterByPart[0].beats}/${meterByPart[0].beatType}`,
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
        // excluded here as percussion; all pitched piano channels are retained.
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

  // Piano differs from guitar strums: group only note-ons on the exact same MIDI tick. This
  // preserves short ornaments and rapid notes while combining simultaneous chord tones.
  const PIANO_ONSET_GROUP_WINDOW_SECONDS = 0
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
        if (age > PIANO_ONSET_GROUP_WINDOW_SECONDS) break
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
        // Keep the shared exact-tick onset for the simultaneous piano chord.
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

function cursorKeyAtTime(schedule: ScheduledMeasure[], time: number): string {
  if (!schedule.length) return '-1'

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

export default function PianoPdfMp3Test({ isAdmin = false, pdfUrl = PDF_URL, xmlUrl = XML_URL, midiUrl = MIDI_URL, mp3Url = MP3_URL }: PianoPdfMp3TestProps) {

  const theme = useManbanpaiTheme()
  const colors = theme === 'day' ? dayColors : nightColors
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const scheduleRef = useRef<ScheduledMeasure[]>([])
  const currentTimeRef = useRef(0)
  const lastPublishedTimeRef = useRef(Number.NEGATIVE_INFINITY)
  const lastPublishedCursorKeyRef = useRef('')
  const lastPublishedAtRef = useRef(0)
  const [parsed, setParsed] = useState<ParsedScore | null>(null)
  const [midiTiming, setMidiTiming] = useState<MidiTiming | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [mp3Ready, setMp3Ready] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [zoom, setZoom] = useState(100)
  // Default to zero alignment offset. Any fine tuning is an administrator-only diagnostic tool.
  const [mp3Offset, setMp3Offset] = useState(0)
  const [loopStart, setLoopStart] = useState<number | null>(null)
  const [loopEnd, setLoopEnd] = useState<number | null>(null)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const loopRef = useRef<{ start: number | null; end: number | null; enabled: boolean }>({ start: null, end: null, enabled: false })
  const [autoFollow, setAutoFollow] = useState(true)
  const [showMappingDebug, setShowMappingDebug] = useState(false)
  const [adminToolsOpen, setAdminToolsOpen] = useState(false)
  const [theoryPanelOpen, setTheoryPanelOpen] = useState(false)
  const scoreWithCurrentMeasureRef = useRef<HTMLDivElement | null>(null)
  const [theoryMode, setTheoryMode] = useState<TheoryViewMode>('none')
  const [theoryAnalysis, setTheoryAnalysis] = useState<ScoreTheoryAnalysis | null>(null)
  const [theoryError, setTheoryError] = useState('')
  const [theoryCorrections, setTheoryCorrections] = useState<Record<string, string>>({})
  const [theoryCorrectionsLoadedForUrl, setTheoryCorrectionsLoadedForUrl] = useState('')
  const [theoryCorrectionCloudReady, setTheoryCorrectionCloudReady] = useState(false)
  // Used only by the theory measure-card highlight; null means no card has been selected/played yet.
  const [theoryCardHighlightMeasureIndex, setTheoryCardHighlightMeasureIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('正在讀取 MusicXML、MIDI 參考時間軸與 MP3…')
  const [error, setError] = useState('')
  const [midiError, setMidiError] = useState('')
  const [mp3Error, setMp3Error] = useState('')
  currentTimeRef.current = currentTime

  useEffect(() => () => {
    try { audioRef.current?.pause() } catch { /* no-op during unmount */ }
  }, [])

  useEffect(() => {
    loopRef.current = { start: loopStart, end: loopEnd, enabled: loopEnabled }
  }, [loopStart, loopEnd, loopEnabled])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setTheoryCardHighlightMeasureIndex(null)
      setTheoryAnalysis(null)
      setTheoryError('')
      setError('')
      setMidiError('')
      try {
        const xmlResponse = await fetch(xmlUrl, { cache: 'no-store', credentials: 'same-origin' })
        if (!xmlResponse.ok) throw new Error(`無法讀取 MusicXML（HTTP ${xmlResponse.status}）。`)
        const xmlText = await xmlResponse.text()
        const score = parseMusicXml(xmlText)
        if (cancelled) return
        setParsed(score)
        try {
          setTheoryAnalysis(analyseMusicXmlTheory(xmlText))
          setTheoryError('')
        } catch (analysisError) {
          setTheoryAnalysis(null)
          setTheoryError(analysisError instanceof Error ? analysisError.message : '樂理分析失敗。')
        }

        try {
          const midiResponse = await fetch(midiUrl, { cache: 'no-store', credentials: 'same-origin' })
          if (!midiResponse.ok) throw new Error(`MIDI 參考檔讀取失敗（HTTP ${midiResponse.status}）。`)
          const midiBinary = await midiResponse.arrayBuffer()
          const midi = parseMidiTiming(midiBinary)
          if (!cancelled) setMidiTiming(midi)
        } catch (midiLoadError) {
          if (!cancelled) setMidiError(midiLoadError instanceof Error ? midiLoadError.message : String(midiLoadError))
        }
        if (!cancelled) {
          setStatus(`MusicXML 已解析 ${score.measures.length} 個書寫小節；聲音直接播放 piano.mp3，MIDI 僅用於校準 XML 的演奏時間。`)
          setLoading(false)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : '載入譜面時間資料失敗。')
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [xmlUrl, midiUrl])

  useEffect(() => {
    let cancelled = false
    const key = theoryCorrectionStorageKey(xmlUrl)
    setTheoryCorrectionsLoadedForUrl('')
    setTheoryCorrectionCloudReady(false)
    void (async () => {
      try {
        const response = await fetch(`/api/state?key=${encodeURIComponent(key)}`, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as { value?: unknown; found?: boolean }
        let rawValue: unknown = payload.value
        if (!payload.found) {
          try {
            const localRaw = window.localStorage.getItem(key)
            if (localRaw) {
              const parsedLocal: unknown = JSON.parse(localRaw)
              if (parsedLocal && typeof parsedLocal === 'object' && !Array.isArray(parsedLocal)) {
                rawValue = parsedLocal
                if (isAdmin) await fetch(`/api/state?key=${encodeURIComponent(key)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: parsedLocal }) })
              }
            }
          } catch { /* legacy local corrections are optional */ }
        }
        const loaded: Record<string, string> = {}
        if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
          for (const [id, value] of Object.entries(rawValue as Record<string, unknown>)) if (typeof value === 'string') loaded[id] = value
        }
        if (!cancelled) {
          setTheoryCorrections(loaded)
          setTheoryCorrectionsLoadedForUrl(xmlUrl)
          setTheoryCorrectionCloudReady(true)
        }
      } catch (loadError) {
        let localCorrections: Record<string, string> = {}
        try {
          const localRaw = window.localStorage.getItem(key)
          const value = localRaw ? JSON.parse(localRaw) : null
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            localCorrections = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          }
        } catch { /* ignore invalid local data */ }
        if (!cancelled) {
          setTheoryCorrections(localCorrections)
          setTheoryCorrectionsLoadedForUrl(xmlUrl)
          setTheoryCorrectionCloudReady(false)
        }
        console.warn('[慢半拍] 雲端和弦修正讀取失敗，暫用本機副本：', loadError)
      }
    })()
    return () => { cancelled = true }
  }, [xmlUrl, isAdmin])

  useEffect(() => {
    if (theoryCorrectionsLoadedForUrl !== xmlUrl) return
    const key = theoryCorrectionStorageKey(xmlUrl)
    try { window.localStorage.setItem(key, JSON.stringify(theoryCorrections)) } catch { /* local persistence is optional */ }
    if (!isAdmin || !theoryCorrectionCloudReady) return
    void fetch(`/api/state?key=${encodeURIComponent(key)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: theoryCorrections }) })
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`) })
      .catch(saveError => console.warn('[慢半拍] 雲端和弦修正儲存失敗：', saveError))
  }, [xmlUrl, isAdmin, theoryCorrections, theoryCorrectionsLoadedForUrl, theoryCorrectionCloudReady])

  const displayedTheoryAnalysis = useMemo(() => theoryAnalysis ? applyTheoryChordCorrections(theoryAnalysis, theoryCorrectionsLoadedForUrl === xmlUrl ? theoryCorrections : {}) : null, [theoryAnalysis, theoryCorrections, theoryCorrectionsLoadedForUrl, xmlUrl])

  const midiAlignment = useMemo<MidiAlignment | null>(() => {
    if (!parsed || !midiTiming) return null
    return buildMidiAlignment(parsed, midiTiming)
  }, [parsed, midiTiming])

  const schedule = useMemo<ScheduledMeasure[]>(() => {
    if (!parsed) return []
    const totalTheoretical = parsed.playbackOrder.reduce(
      (sum, measureIndex) => sum + (parsed.measures[measureIndex]?.durationSeconds ?? 0), 0,
    )
    if (totalTheoretical <= 0) return []

    // Keep the musical timeline tied to MIDI/XML. Do not stretch it to the MP3 container
    // duration, because the MP3 has an extra release/reverb tail after the final note.
    const referenceDuration = midiTiming?.durationSeconds || audioDuration || totalTheoretical
    const fallbackScale = referenceDuration / totalTheoretical
    const midiScale = midiTiming && midiTiming.durationSeconds > 0 ? 1 : fallbackScale
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
        if (!Number.isFinite(secondsPerQuarter) || secondsPerQuarter < nominalSpq * 0.4 || secondsPerQuarter > nominalSpq * 2.5) {
          secondsPerQuarter = nominalSpq
        }
        const estimatedStartRaw = mapped.reduce(
          (sum, point) => sum + point.rawSeconds - point.q * secondsPerQuarter,
          0,
        ) / mapped.length
        if (Number.isFinite(estimatedStartRaw)) {
          // Translate the MIDI/XML reference onto the MP3's playback clock using one fixed
          // offset. Do not scale the timeline to the MP3 duration (the file has a release tail).
          startCandidate = Math.max(0, estimatedStartRaw * midiScale + mp3Offset)
        }
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
        starts.push(useMidiAlignment && context.startCandidate !== null
          ? context.startCandidate
          : Math.max(0, mp3Offset))
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
      const hasNextMeasure = index + 1 < starts.length
      const nextStart = hasNextMeasure ? starts[index + 1] : Number.NaN
      const fallbackEnd = startSeconds + (useMidiAlignment ? context.estimatedDuration : context.fallbackDuration)
      const endSeconds = hasNextMeasure && Number.isFinite(nextStart) && nextStart > startSeconds + 0.025
        ? nextStart
        : Math.max(startSeconds + 0.04, fallbackEnd)
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
        noteAnchorPositions: context.measure.noteEvents.map(event => event.layoutPosition),
        matchedNoteEvents: context.mapped.length,
      }
    })
  }, [parsed, midiTiming, midiAlignment, audioDuration, mp3Offset])

  // Keep the latest timeline available to the animation clock without restarting its RAF loop.
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

  // Only mark a theory card after playback actually enters a measure or the user picks a card.
  useEffect(() => {
    if (playing && cursor.measureIndex >= 0) {
      setTheoryCardHighlightMeasureIndex(cursor.measureIndex)
    }
  }, [playing, cursor.measureIndex])

  useEffect(() => {
    let frameId = 0
    let lastPlayingState: boolean | null = null
    let lastIdleRefresh = 0
    let lastKnownDuration = Number.NaN
    const publishClock = (time: number, now: number) => {
      lastPublishedTimeRef.current = time
      lastPublishedCursorKeyRef.current = cursorKeyAtTime(scheduleRef.current, time)
      lastPublishedAtRef.current = now
      setCurrentTime(time)
    }

    const tick = (now: number) => {
      const audio = audioRef.current
      if (audio) {
        let time = Math.max(0, Number(audio.currentTime) || 0)
        if (Number.isFinite(audio.duration) && audio.duration > 0 && Math.abs(audio.duration - lastKnownDuration) > 0.01) {
          lastKnownDuration = audio.duration
          setAudioDuration(audio.duration)
        }
        const isPlaying = !audio.paused && !audio.ended
        const loop = loopRef.current
        let timeJumped = false
        if (isPlaying && loop.enabled && loop.start !== null && loop.end !== null && loop.end > loop.start + 0.2 && time >= loop.end) {
          // Set the media clock first; the cursor must be resolved from the landed time,
          // never from the pre-loop frame. This also prevents A/B drift from accumulating.
          try {
            audio.currentTime = loop.start
            time = loop.start
            timeJumped = true
          } catch { /* media can reject a seek while metadata is being refreshed */ }
        }

        const currentCursorKey = cursorKeyAtTime(scheduleRef.current, time)
        const cursorBoundaryChanged = currentCursorKey !== lastPublishedCursorKeyRef.current
        if (isPlaying) {
          // Publish at about 12 FPS instead of re-rendering the entire player on every
          // display refresh. Measure/occurrence boundaries and loop jumps bypass the throttle,
          // so the next bar starts at its left edge without a stale-frame delay.
          if (timeJumped || cursorBoundaryChanged || now - lastPublishedAtRef.current >= 1000 / 12) {
            publishClock(time, now)
          }
          if (lastPlayingState !== true) {
            setPlaying(true)
            lastPlayingState = true
          }
        } else {
          // While paused, only publish if an external seek moved the media clock, the active
          // measure changed, or the normal idle check is due. Controls remain responsive.
          if (timeJumped || cursorBoundaryChanged || Math.abs(time - lastPublishedTimeRef.current) > 0.004) {
            publishClock(time, now)
          }
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

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !mp3Ready) {
      setStatus('MP3 尚未載入完成，請稍等片刻後重試。')
      return
    }
    try {
      if (!audio.paused) {
        audio.pause()
        setPlaying(false)
        setStatus(`MP3 已暫停於 ${formatTime(audio.currentTime)}。`)
      } else {
        await audio.play()
        setPlaying(true)
        setStatus('正在直接播放目前曲目的 MP3；游標讀取媒體實際播放時鐘，MIDI 僅供 XML 時間參考。')
      }
    } catch (playError) {
      setError(`MP3 播放失敗：${playError instanceof Error ? playError.message : String(playError)}`)
    }
  }, [mp3Ready])

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    try { audio.currentTime = 0 } catch { /* metadata may not be ready yet */ }
    setCurrentTime(0)
    setPlaying(false)
    setStatus('MP3 已停止並回到開頭。A/B 標記仍保留，可重新播放或清除。')
  }, [])

  const replayFromStart = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !mp3Ready) return
    try {
      audio.pause()
      audio.currentTime = 0
      currentTimeRef.current = 0
      setCurrentTime(0)
      await audio.play()
      setPlaying(true)
      setStatus('已從開頭重新播放 MP3。')
    } catch (playError) {
      setError(`重播失敗：${playError instanceof Error ? playError.message : String(playError)}`)
    }
  }, [mp3Ready])

  const seekToTime = useCallback(async (nextTime: number): Promise<void> => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(nextTime)) return
    const maxTime = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : nextTime
    const target = Math.max(0, Math.min(maxTime, nextTime))
    try { audio.currentTime = target } catch { return }
    setCurrentTime(target)
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    setCurrentTime(Math.max(0, Number(audio.currentTime) || target))
  }, [])


  const seekBySeconds = useCallback((delta: number) => {
    const audio = audioRef.current
    if (!audio) return
    const wasPlaying = !audio.paused && !audio.ended
    void seekToTime((Number(audio.currentTime) || 0) + delta)
    setStatus(`已${delta < 0 ? '後退' : '前進'} ${Math.abs(delta)} 秒。${wasPlaying ? '播放繼續。' : '目前為暫停狀態。'}`)
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
    const xmlMeasureLabel = parsed?.measures[measureIndex]?.printedNumber ?? String(measureIndex + 1)
    const matching = schedule.filter(entry => entry.measureIndex === measureIndex)
    if (!matching.length) {
      setStatus(`找不到 PDF 小節 ${xmlMeasureLabel}（MusicXML 編號）的 MP3 播放時間。`)
      return
    }
    const occurrence = matching.find(entry => entry.endSeconds > currentTimeRef.current + 0.2) ?? matching[0]
    const audio = audioRef.current
    if (!audio || !mp3Ready) {
      setStatus(`已定位 MusicXML 小節 ${xmlMeasureLabel}，但 MP3 尚未就緒。`)
      return
    }
    audio.pause()
    setPlaying(false)
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : occurrence.startSeconds
    const expectedTarget = Math.max(0, Math.min(duration, occurrence.startSeconds))
    // Seeking to a measure outside the currently marked loop should not immediately snap back
    // into that loop. Keep A/B active only when the destination lies inside its interval.
    if (loopEnabled && loopStart !== null && loopEnd !== null && (expectedTarget < loopStart || expectedTarget > loopEnd)) {
      setLoopEnabled(false)
    }
    await seekToTime(expectedTarget)
    const actualTarget = Math.max(0, Number(audio.currentTime) || 0)
    if (Math.abs(actualTarget - expectedTarget) > 0.35) {
      setStatus(`小節跳轉未完成：PDF/XML 小節 ${xmlMeasureLabel}，目標 ${formatTime(expectedTarget)}，MP3 實際位置 ${formatTime(actualTarget)}。`)
      setError('MP3 無法定位到目標時間，請確認 piano.mp3 可支援時間跳轉。')
      return
    }
    try {
      await audio.play()
      setPlaying(true)
      setCurrentTime(actualTarget)
      setStatus(`已跳至 PDF/XML 小節 ${xmlMeasureLabel} · 演奏順序第 ${occurrence.occurrence + 1} 次 · MP3 時間 ${formatTime(expectedTarget)}。`)
    } catch (playError) {
      setStatus(`已定位 MusicXML 小節 ${xmlMeasureLabel}，MP3 時間 ${formatTime(expectedTarget)}。`)
      setError(`已定位但 MP3 播放啟動失敗：${playError instanceof Error ? playError.message : String(playError)}`)
    }
  }, [schedule, seekToTime, mp3Ready, parsed, loopEnabled, loopStart, loopEnd])

  const seekToTheoryChord = useCallback(async (measureIndex: number, onsetQuarter: number) => {
    const matching = schedule.filter(entry => entry.measureIndex === measureIndex)
    if (!matching.length) return
    const occurrence = matching.find(entry => entry.endSeconds > currentTimeRef.current + 0.2) ?? matching[0]
    const measure = parsed?.measures[measureIndex]
    const events = measure?.noteEvents ?? []
    const eventIndex = events.length ? events.reduce((best, event, index) =>
      Math.abs(event.onsetQuarter - onsetQuarter) < Math.abs((events[best]?.onsetQuarter ?? Number.POSITIVE_INFINITY) - onsetQuarter) ? index : best, 0) : -1
    const normalizedTime = eventIndex >= 0 ? (occurrence.noteAnchorTimes[eventIndex] ?? 0) : 0
    await seekToTime(occurrence.startSeconds + occurrence.durationSeconds * normalizedTime)
  }, [schedule, parsed, seekToTime])

  const chordLabels = useMemo<PianoChordLabel[]>(() => {
    if (!displayedTheoryAnalysis || theoryMode === 'none' || !parsed) return []
    const labels: PianoChordLabel[] = []
    const getPosition = (measure: MeasureInfo, onsetQuarter: number) => {
      if (!measure.noteEvents.length) return measure.durationQuarter > 0 ? Math.max(0.03, Math.min(0.96, onsetQuarter / measure.durationQuarter)) : 0.08
      let nearest = measure.noteEvents[0]
      for (const event of measure.noteEvents) if (Math.abs(event.onsetQuarter - onsetQuarter) < Math.abs(nearest.onsetQuarter - onsetQuarter)) nearest = event
      return Math.max(0.025, Math.min(0.96, nearest.layoutPosition))
    }
    for (const theoryMeasure of displayedTheoryAnalysis.measures) {
      const scoreMeasure = parsed.measures[theoryMeasure.sourceIndex]
      if (!scoreMeasure) continue
      if (theoryMode === 'chordNames') {
        // Deliberately render one combined badge per measure, not one badge per chord onset.
        // That keeps labels tied to their own PDF measure and prevents overlapping chord names.
        const chord = theoryMeasure.chords[0]
        if (chord && (chord.symbol || chord.roman) && chord.symbol !== '—') {
          const allChords = theoryMeasure.chords.map(item => `${item.symbol} · ${item.roman}`).filter(Boolean)
          labels.push({
            id: `${theoryMeasure.sourceIndex}:harmony-summary`,
            measureIndex: theoryMeasure.sourceIndex,
            position: 0.5,
            text: `${chord.symbol} · ${chord.roman}`,
            symbol: chord.symbol,
            roman: chord.roman,
            title: `${allChords.join(' → ')} · ${chord.confidence}`,
          })
        }
      } else if (theoryMode === 'bassLine') {
        labels.push({ id: `${theoryMeasure.sourceIndex}:bass`, measureIndex: theoryMeasure.sourceIndex, position: 0.05, text: `低音 ${theoryMeasure.bassName}`, title: `${theoryMeasure.melodyTrend} · ${theoryMeasure.harmonicFunction}` })
      } else if (theoryMode === 'nonChordHints') {
        for (const hint of theoryMeasure.nonChordHints.slice(0, 4)) labels.push({ id: `${theoryMeasure.sourceIndex}:hint:${hint.onsetQuarter}`, measureIndex: theoryMeasure.sourceIndex, position: getPosition(scoreMeasure, hint.onsetQuarter), text: `${hint.noteName} ${hint.label}`, title: hint.explanation })
      } else if (theoryMode === 'melodyContour') {
        labels.push({ id: `${theoryMeasure.sourceIndex}:melody`, measureIndex: theoryMeasure.sourceIndex, position: 0.05, text: theoryMeasure.melodyContour || theoryMeasure.melodyTrend, title: theoryMeasure.melodyRange })
      }
    }
    return labels
  }, [displayedTheoryAnalysis, theoryMode, parsed])

  // MANBANPAI_PIANO_MEASURE_GRID_METRONOME_V3: downbeats are anchored to each actual scheduled measure occurrence.
  const metronomeBeatGrid = useMemo<Array<{ time: number; beatSeconds: number; accent: boolean }>>(() => {
    if (!parsed || schedule.length === 0) return []
    const grid: Array<{ time: number; beatSeconds: number; accent: boolean }> = []
    for (const occurrence of schedule) {
      const measure = parsed.measures[occurrence.measureIndex]
      if (!measure || !Number.isFinite(occurrence.startSeconds) || !Number.isFinite(occurrence.durationSeconds) || occurrence.durationSeconds <= 0) continue
      const [beatsRaw = '4', beatTypeRaw = '4'] = (measure.meter || '4/4').split('/')
      const numerator = beatsRaw.split('+').reduce((sum, value) => sum + (Number(value.trim()) || 0), 0) || 4
      const denominator = Number(beatTypeRaw) || 4
      const compound = denominator === 8 && numerator >= 6 && numerator % 3 === 0
      const beatQuarterLength = compound ? 1.5 : 4 / denominator
      const nominalBeatCount = compound ? numerator / 3 : numerator
      const measureQuarterLength = measure.durationQuarter > 0 ? measure.durationQuarter : nominalBeatCount * beatQuarterLength
      const beatCount = Math.max(1, Math.min(32, Math.round(measureQuarterLength / beatQuarterLength)))
      const beatSeconds = occurrence.durationSeconds / beatCount
      if (!Number.isFinite(beatSeconds) || beatSeconds <= 0) continue
      for (let beat = 0; beat < beatCount; beat++) {
        grid.push({
          time: Math.max(0, occurrence.startSeconds + beat * beatSeconds),
          beatSeconds,
          accent: beat === 0,
        })
      }
    }
    grid.sort((a, b) => a.time - b.time)
    const deduplicated: typeof grid = []
    for (const beat of grid) {
      const previous = deduplicated[deduplicated.length - 1]
      if (previous && Math.abs(previous.time - beat.time) < 0.012) {
        if (beat.accent && !previous.accent) deduplicated[deduplicated.length - 1] = { ...beat, time: previous.time }
        continue
      }
      deduplicated.push(beat)
    }
    return deduplicated
  }, [parsed, schedule])

  const cursorAnchorTimes = useMemo(() => {
    if (cursor.occurrence < 0) return []
    return schedule[cursor.occurrence]?.noteAnchorTimes ?? []
  }, [schedule, cursor.occurrence])
  const cursorAnchorPositions = useMemo(() => {
    if (cursor.occurrence < 0) return []
    return schedule[cursor.occurrence]?.noteAnchorPositions ?? []
  }, [schedule, cursor.occurrence])

  const currentPianoTheoryHud = useMemo(() => {
    const analysis = displayedTheoryAnalysis
    if (!analysis?.measures.length) return null
    const measure = analysis.measures.find(item => item.sourceIndex === cursor.measureIndex) ?? analysis.measures[0]
    if (!measure) return null
    const measureMeta = parsed?.measures.find(item => item.index === measure.sourceIndex)
    const withinMeasureQuarter = playing && cursor.measureIndex === measure.sourceIndex && measureMeta
      ? cursor.progress * measureMeta.durationQuarter
      : 0
    const chords = measure.chords ?? []
    let activeChord = chords[0] ?? null
    for (const chord of chords) {
      if (chord.onsetQuarter <= withinMeasureQuarter + 0.035) activeChord = chord
      else break
    }
    const nearbyHints = (measure.nonChordHints ?? []).filter(hint => Math.abs(hint.onsetQuarter - withinMeasureQuarter) <= 0.35)
    const toneNames = Array.from(new Set(activeChord?.toneNames ?? [])).slice(0, 10)
    return {
      measure,
      activeChord,
      chordSequence: chords.map(chord => chord.symbol).filter((value, index, all) => index === 0 || value !== all[index - 1]).join(' → '),
      toneNames,
      bassName: measure.bassName || activeChord?.bassName || '低音資訊不足',
      roman: activeChord?.roman || '級數未確定',
      nonChordText: nearbyHints.length ? nearbyHints.map(hint => `${hint.noteName}（${hint.label}）`).join('、') : '暫無候選音',
    }
  }, [displayedTheoryAnalysis, cursor.measureIndex, cursor.progress, playing, parsed])

  usePdfPageAnchoredTheoryHud(scoreWithCurrentMeasureRef, '.piano-pdf-page', Boolean(currentPianoTheoryHud && !loading && !error && !theoryError), playing)

  const actualDuration = audioDuration || midiTiming?.durationSeconds || parsed?.theoreticalDurationSeconds || 0

  return (
    <main className="manbanpai-reader-page" style={{ minHeight: '100vh', background: colors.bg, color: colors.text, padding: '12px 16px 36px', boxSizing: 'border-box', fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' }}>
      <audio
        ref={audioRef}
        src={mp3Url}
        preload="auto"
        onLoadedMetadata={event => {
          const duration = Number(event.currentTarget.duration)
          if (Number.isFinite(duration) && duration > 0) setAudioDuration(duration)
          setMp3Ready(true)
          setMp3Error('')
          setStatus('MP3 已就緒，進度線會跟隨媒體實際播放時間。')
        }}
        onCanPlay={() => setMp3Ready(true)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setMp3Ready(false)
          setMp3Error(`無法載入 ${mp3Url}。請確認此曲譜已配置可讀取的 MP3 音源 URL。`)
        }}
        style={{ display: 'none' }}
      />
<section style={{ width: 'min(1180px, 100%)', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 5 }}>
          <div style={{ minWidth: 0, flex: '1 1 520px' }}>
            <div style={{ color: colors.gold, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' }}>PIANO · PDF + MP3</div>
            <h1 style={{ margin: '7px 0 5px', fontSize: 25, lineHeight: 1.25 }}>慢半拍譜間 · 鋼琴譜</h1>
            <p style={{ color: colors.muted, lineHeight: 1.65, margin: 0, maxWidth: 980 }}>
              本閱讀器專供「鋼琴譜」：PDF 顯示原始鋼琴大譜表；MP3 是唯一實際發聲來源並提供播放時鐘；MIDI 必需，用於對照 MusicXML 的演奏順序與起音時間；MusicXML 必需，用於小節／音符結構、雙手聲部對位參考及樂理分析。此模組與兩類吉他譜閱讀核心分開，不會覆蓋或改寫吉他譜邏輯。
            </p>
          </div>
          <div className="mb-reader-header-actions">
            <ManbanpaiThemeToggle />
            {isAdmin && <button type="button" onClick={() => setAdminToolsOpen(value => !value)} style={{ ...buttonStyle(colors), borderColor: colors.gold, color: colors.gold }}>{adminToolsOpen ? '收起測試／調試工具' : '⚙ 測試／調試工具'}</button>}
          </div>
        </div>
        <ScoreHeaderControls
          currentTime={currentTime} duration={actualDuration} playing={playing} ready={mp3Ready}
          rate={rate} zoom={zoom} theoryOpen={theoryPanelOpen}
          onTogglePlay={() => void togglePlayback()} onReplay={() => void replayFromStart()}
          onRateChange={value => { setRate(value); if (audioRef.current) audioRef.current.playbackRate = value }}
          onToggleTheory={() => setTheoryPanelOpen(value => !value)} onZoomChange={setZoom}
        />

        {isAdmin && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, margin: '12px 0 14px' }}>
          <div style={{ border: `1px solid ${colors.line}`, borderRadius: 12, background: colors.panel, padding: 14 }}>
            <div style={{ fontSize: 11, color: colors.soft, marginBottom: 5 }}>播放狀態</div>
            <div style={{ fontSize: 14, lineHeight: 1.55, overflowWrap: 'anywhere' }}>{status}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: colors.soft }}>
              {loading ? '正在讀取 XML…' : parsed ? `XML：${parsed.measures.length} 個書寫小節 · 展開後 ${parsed.playbackOrder.length} 次小節` : 'XML 尚未完成讀取'}
            </div>
          </div>
          <div style={{ border: `1px solid ${colors.line}`, borderRadius: 12, background: colors.panel, padding: 14 }}>
            <div style={{ fontSize: 11, color: colors.soft, marginBottom: 5 }}>時間軸檢查</div>
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              <div>MP3 檔案時長：<strong>{mp3Ready ? formatTime(audioDuration) : '讀取中…'}</strong></div>
              <div>MIDI 參考時長：<strong>{midiTiming ? formatTime(midiTiming.durationSeconds) : '讀取中…'}</strong></div>
              <div>當前發聲來源：<strong>{mp3Ready ? 'MP3 音軌' : 'MP3 尚未就緒'}</strong></div>
              <div>小節映射：<strong>{schedule.length ? `${schedule.length} 次演奏位置` : '準備中…'}</strong></div>
              <div>MP3 / MIDI 時長差：<strong>{midiTiming && audioDuration ? `${(audioDuration - midiTiming.durationSeconds).toFixed(2)} 秒（含音源尾音）` : '計算中…'}</strong></div>
              {midiAlignment && <div>MIDI/XML 起音匹配：<strong>{midiAlignment.matchedCount}/{midiAlignment.xmlEvents.length}</strong>（{midiAlignment.coveragePct.toFixed(0)}%）</div>}
              {midiAlignment && <div>高相似匹配：<strong>{midiAlignment.strongMatchCount}/{midiAlignment.xmlEvents.length}</strong>（{midiAlignment.strongCoveragePct.toFixed(0)}%）</div>}
              {midiAlignment && <div>匹配音軌：<strong>{midiAlignment.trackLabel}</strong> · 音高校正 <strong>{midiAlignment.pitchShift > 0 ? '+' : ''}{midiAlignment.pitchShift}</strong> 半音</div>}
            </div>
            {midiAlignment && (midiAlignment.coveragePct < 70 || midiAlignment.strongCoveragePct < 60) && (
              <div style={{ marginTop: 6, color: colors.warn, fontSize: 11.5 }}>
                MIDI/XML 高相似匹配率偏低；未匹配音符的時間仍會退回 XML 節奏估算。
              </div>
            )}
            {midiError && <div style={{ marginTop: 6, color: colors.warn, fontSize: 11.5 }}>MIDI 時間參考未完成：{midiError}。</div>}
            {mp3Error && <div style={{ marginTop: 6, color: colors.warn, fontSize: 11.5 }}>{mp3Error}</div>}
          </div>
        </div>}

        {error && <div role="alert" style={{ border: '1px solid rgba(226,186,114,.5)', background: 'rgba(226,186,114,.09)', color: colors.warn, padding: 11, borderRadius: 10, margin: '0 0 12px', lineHeight: 1.5 }}>{error}</div>}


        {isAdmin && adminToolsOpen && <section style={{ border: `1px solid ${colors.line}`, borderRadius: 12, background: colors.panel, padding: 13, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: colors.gold, marginBottom: 9 }}>管理員測試工具</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
            <label style={{ display: 'flex', gap: 7, alignItems: 'center', color: colors.muted, fontSize: 12 }}>
              對位偏移 {mp3Offset >= 0 ? '+' : ''}{mp3Offset.toFixed(2)} 秒
              <input aria-label="MP3 與 XML 固定對位偏移" type="range" min={-0.30} max={0.30} step={0.01} value={mp3Offset} onChange={event => setMp3Offset(Number(event.target.value))} style={{ width: 140, accentColor: colors.gold }} disabled={!mp3Ready} />
              <button type="button" onClick={() => setMp3Offset(0)} style={buttonStyle(colors)}>重設為 0.00 秒</button>
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: colors.muted, fontSize: 12 }}>
              <input type="checkbox" checked={showMappingDebug} onChange={event => setShowMappingDebug(event.target.checked)} />顯示 XML 小節編號／映射診斷
            </label>
          </div>
          <div style={{ marginTop: 8, color: colors.soft, fontSize: 11, lineHeight: 1.6 }}>目前預設偏移為 0.00 秒。只有在不同曲目明確出現固定起音差時，才需要調整此值。</div>
        </section>}

        {!loading && !error && <>
          <style>{`
            @media (max-width: 760px) {
              .score-room-theory-panel { left: 12px !important; right: 12px !important; top: 62px !important; bottom: 12px !important; width: auto !important; }
              .score-room-piano-measure-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
            }
            @media (max-width: 420px) {
              .score-room-piano-measure-grid { grid-template-columns: minmax(0, 1fr) !important; }
            }
            .score-room-theory-panel .score-room-theory-measure-card:focus { outline: none; }
            .score-room-theory-panel .score-room-theory-measure-card:focus-visible { outline: 2px solid rgba(153,101,17,.82); outline-offset: -3px; }
          `}</style>
          <aside
            className="score-room-theory-panel"
            lang="zh-TW"
            role="dialog"
            aria-label="鋼琴樂理分析面板"
            aria-modal="false"
            aria-hidden={!theoryPanelOpen}
            style={{
              position: 'fixed', zIndex: 1200, right: 16, top: 82, bottom: 18,
              width: 'min(430px, calc(100vw - 24px))', minHeight: 180,
              boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden',
              borderRadius: 16, border: '1px solid rgba(217,183,121,.60)',
              background: 'rgba(17,24,33,.48)', color: '#e9edf2',
              boxShadow: '0 22px 60px rgba(0,0,0,.44), inset 0 1px 0 rgba(255,255,255,.13), inset 0 -1px 0 rgba(255,255,255,.045)',
              backdropFilter: 'blur(40px) saturate(190%)', WebkitBackdropFilter: 'blur(40px) saturate(190%)',
              backgroundClip: 'padding-box', isolation: 'isolate',
              opacity: theoryPanelOpen ? 1 : 0,
              // Keep the glass panel stationary during its fade to avoid a transient bright edge.
              transform: 'none',
              visibility: theoryPanelOpen ? 'visible' : 'hidden',
              pointerEvents: theoryPanelOpen ? 'auto' : 'none',
              transition: theoryPanelOpen
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
                <button type="button" onClick={() => setTheoryPanelOpen(false)} aria-label="隱藏樂理分析面板" title="隱藏面板；可透過播放工具列重新開啟" style={{ border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, height: 30, padding: '0 9px', background: 'rgba(255,255,255,.05)', color: '#e9edf2', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>隱藏面板</button>
              </div>
              {displayedTheoryAnalysis && (
                <div aria-label="樂理分析模式" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', marginTop: 11 }}>
                  {([
                    ['chordNames', '和弦/級數'],
                    ['bassLine', '低音與走向'],
                    ['nonChordHints', '非和弦音候選'],
                    ['melodyContour', '旋律輪廓'],
                    ['none', '不顯示'],
                  ] as Array<[TheoryViewMode, string]>).map(([mode, label]) => (
                    <label key={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: theoryMode === mode ? '#f1d99b' : '#d1d8df', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      <input type="radio" name="piano-score-annotation-mode" checked={theoryMode === mode} onChange={() => setTheoryMode(mode)} style={{ accentColor: '#d9b779', margin: 0 }} />{label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {theoryError && <div role="alert" style={{ padding: 12, borderRadius: 10, background: 'rgba(170,72,62,.14)', border: '1px solid rgba(231,126,110,.28)', color: '#f2b9ad', fontSize: 12, lineHeight: 1.65 }}>{theoryError}</div>}
              {!displayedTheoryAnalysis && !theoryError && <div style={{ padding: '22px 6px', textAlign: 'center', fontSize: 12, color: '#d9c69f' }}>正在讀取音符並分析和聲…</div>}
              {displayedTheoryAnalysis && (() => {
                const analysisView = displayedTheoryAnalysis
                const orderedMeasures = analysisView.measures
                const selectedMeasure = orderedMeasures.find(measure => measure.sourceIndex === cursor.measureIndex) ?? orderedMeasures[0]
                const modeCaption = theoryMode === 'none' ? '不顯示'
                  : theoryMode === 'chordNames' ? '和弦 / 級數'
                  : theoryMode === 'bassLine' ? '低音'
                  : theoryMode === 'nonChordHints' ? '非和弦音'
                  : '旋律輪廓'
                return (
                  <>
                    <div style={{ padding: 12, borderRadius: 12, background: 'linear-gradient(135deg,rgba(217,183,121,.13),rgba(255,255,255,.025))', border: '1px solid rgba(217,183,121,.22)' }}>
                      <div style={{ fontWeight: 750, fontSize: 14, color: '#f3e5c9', lineHeight: 1.5 }}>鋼琴樂理分析</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, marginTop: 11 }}>
                        {[
                          ['調性', analysisView.keyName],
                          ['拍號', analysisView.meter],
                          ['速度', analysisView.tempo ? `${Math.round(analysisView.tempo)} BPM` : '未標註'],
                          ['小節數', String(analysisView.measures.length)],
                        ].map(([label, value]) => <div key={label} style={{ padding: '8px 9px', borderRadius: 9, background: 'rgba(0,0,0,.18)' }}><div style={{ fontSize: 10, color: '#98a4b0' }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, fontWeight: 750, color: '#f1d99b', overflowWrap: 'anywhere' }}>{value}</div></div>)}
                      </div>
                      <div style={{ marginTop: 8, color: '#929eaa', fontSize: 10, lineHeight: 1.5 }}>{analysisView.keySource}</div>
                    </div>

                    <section>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: '#e9edf2' }}>和弦進行</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <div style={{ fontSize: 10, color: '#87929e' }}>逐小節對照；點擊卡片定位並播放</div>
                          {isAdmin && Object.keys(theoryCorrections).length > 0 && <button type="button" onClick={() => { if (window.confirm('清除目前樂譜的所有人工和弦校正？')) setTheoryCorrections({}) }} style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 6, background: 'rgba(255,255,255,.04)', color: '#c0c8d1', padding: '4px 6px', fontSize: 9.5, cursor: 'pointer' }}>清除人工校正</button>}
                        </div>
                      </div>
                      <div className="score-room-piano-measure-grid" aria-label="鋼琴逐小節樂理分析卡片" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6 }}>
                        {orderedMeasures.map(measure => {
                          const chord = measure.chords[0]
                          // Use the committed theory-card selection only. The playback cursor can briefly
                          // still point at measure 0 while an asynchronous seek is being committed.
                          const active = theoryCardHighlightMeasureIndex !== null && measure.sourceIndex === theoryCardHighlightMeasureIndex
                          const hints = measure.nonChordHints ?? []
                          let primary = chord?.symbol ?? '—'
                          let secondary = chord?.roman || chord?.qualityLabel || '尚無可靠和弦'
                          if (theoryMode === 'bassLine') { primary = measure.bassName || '低音未確定'; secondary = measure.melodyTrend || measure.harmonicFunction || '低音走向資訊不足' }
                          else if (theoryMode === 'nonChordHints') { primary = hints.length ? hints.slice(0, 2).map(hint => `${hint.noteName}·${hint.label}`).join('、') : '無候選'; secondary = hints.length ? `${hints.length} 個非和弦音候選` : '本小節沒有候選提示' }
                          else if (theoryMode === 'melodyContour') { primary = measure.melodyContour || '旋律資訊不足'; secondary = measure.melodyTrend || measure.melodyRange || '走向資訊不足' }
                          const chordSummary = measure.chords.length > 1 ? `另有 ${measure.chords.length - 1} 個和弦` : (chord?.confidence || '音符推斷')
                          return <button className="score-room-theory-measure-card" key={`${measure.sourceIndex}-${measure.printedNumber}`} type="button" onClick={() => { setTheoryCardHighlightMeasureIndex(measure.sourceIndex); setAutoFollow(true); void onMeasureClick(measure.sourceIndex) }} title={`選擇第 ${measure.printedNumber} 小節並開始播放：${primary}`} aria-pressed={active} style={{ minWidth: 0, minHeight: 86, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, textAlign: 'left', padding: '8px 9px', borderRadius: 9, border: active ? (theme === 'day' ? '2px solid #7D4F0B' : '1px solid rgba(217,183,121,.96)') : `1px solid ${theme === 'day' ? 'rgba(134,111,63,.52)' : 'rgba(255,255,255,.15)'}`, background: active ? (theme === 'day' ? '#F8D890' : 'rgba(217,183,121,.30)') : (theme === 'day' ? 'rgba(255,253,247,.22)' : 'rgba(255,255,255,.065)'), boxShadow: active && theme === 'day' ? 'inset 0 0 0 1px #FFF6DC, inset 0 1px 0 rgba(255,255,255,.96), inset 0 -3px 0 rgba(125,79,11,.48)' : theme === 'day' ? '0 5px 22px rgba(0,0,0,.20), inset 0 1px 0 rgba(255,255,255,.76), inset 0 -1px 0 rgba(255,255,255,.16), 0 0 18px rgba(255,255,255,.055)' : (active ? 'inset 0 0 0 1px rgba(217,183,121,.18)' : undefined), color: theme === 'day' ? '#343d49' : '#e9edf2', cursor: 'pointer' }}>
                            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, width: '100%', fontSize: 9.5, color: active && theme === 'day' ? '#634b20' : (theme === 'day' ? '#707987' : '#9ba6b1') }}><span>小節 {measure.printedNumber}</span><span style={{ color: active && theme === 'day' ? '#68480c' : (theme === 'day' ? '#866d3b' : '#c0a66e') }}>{modeCaption}</span></span>
                            <strong style={{ display: 'block', width: '100%', fontSize: theoryMode === 'melodyContour' ? 10.5 : 13, lineHeight: 1.4, color: primary && primary !== '—' && primary !== '無候選' ? (theme === 'day' ? (active ? '#4c330a' : '#805d12') : '#f1d99b') : (theme === 'day' ? '#707987' : '#a7b0ba'), overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{primary}</strong>
                            <span style={{ display: 'block', width: '100%', fontSize: 9.5, lineHeight: 1.4, color: active && theme === 'day' ? '#554422' : (theme === 'day' ? '#67717d' : '#aab4bf'), overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{secondary}</span>
                            <span style={{ display: 'block', width: '100%', fontSize: 9, lineHeight: 1.35, color: active && theme === 'day' ? '#5c4b2b' : (theme === 'day' ? '#77818c' : '#9ba6b1'), overflowWrap: 'anywhere' }}>{theoryMode === 'chordNames' || theoryMode === 'none' ? chordSummary : `低音：${measure.bassName || '—'}`}</span>
                          </button>
                        })}
                      </div>
                    </section>

                    {selectedMeasure && <section style={{ borderTop: '1px solid rgba(255,255,255,.09)', paddingTop: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: '#e9edf2' }}>目前小節詳情 · 第 {selectedMeasure.printedNumber} 小節</div>
                        <div style={{ fontSize: 10, color: '#87929e' }}>{selectedMeasure.meter}</div>
                      </div>
                      {selectedMeasure.chords.length ? selectedMeasure.chords.map((chord, chordIndex) => {
                        const correctionId = theoryCorrectionId(selectedMeasure.sourceIndex, chord.onsetQuarter)
                        const selectedCandidate = theoryCorrections[correctionId] ?? ''
                        return <div key={`${correctionId}-${chordIndex}`} style={{ padding: 10, marginBottom: 7, borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.035)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}><strong style={{ color: '#f1d99b', fontSize: 15 }}>{chord.symbol}</strong><span style={{ color: '#aab4bf', fontSize: 10 }}>{chord.roman || '級數未定'} · {chord.confidence}</span></div>
                          <div style={{ color: '#d4dbe3', fontSize: 11, lineHeight: 1.55, marginTop: 4 }}>{chord.qualityLabel} · 音組：{chord.toneNames.join('、') || '—'} · 低音：{chord.bassName || selectedMeasure.bassName || '—'}</div>
                          {chord.evidenceSummary?.length ? <div style={{ color: '#9ba8b5', fontSize: 10.5, lineHeight: 1.5, marginTop: 4 }}>{chord.evidenceSummary.slice(0, 2).join('；')}</div> : null}
                          <button type="button" onClick={() => void seekToTheoryChord(selectedMeasure.sourceIndex, chord.onsetQuarter)} style={{ border: '1px solid rgba(217,183,121,.3)', borderRadius: 7, background: 'rgba(217,183,121,.09)', color: '#f1d99b', padding: '5px 8px', fontSize: 10.5, cursor: 'pointer', marginTop: 7 }}>定位此和弦</button>
                          {isAdmin && chord.candidateDetails?.length ? <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: '#9ba8b5', fontSize: 10.5, marginTop: 7 }}>人工校正候選
                            <select value={selectedCandidate} onChange={event => setTheoryCorrections(previous => { const next = { ...previous }; if (event.target.value) next[correctionId] = event.target.value; else delete next[correctionId]; return next })} style={{ width: '100%', minWidth: 0, border: '1px solid rgba(217,183,121,.28)', borderRadius: 7, padding: '7px 8px', color: '#e9edf2', background: '#182331' }}>
                              <option value="">使用自動判斷</option>{chord.candidateDetails.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.symbol} · {candidate.qualityLabel} · {candidate.score.toFixed(1)}</option>)}
                            </select>
                          </label> : null}
                        </div>
                      }) : <div style={{ color: '#8794a0', fontSize: 11, padding: 8 }}>本小節沒有足夠的和弦證據，不能可靠地給出和弦名稱。</div>}
                      <div style={{ marginTop: 6, padding: 10, borderRadius: 9, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.07)', color: '#c4ced8', fontSize: 10.5, lineHeight: 1.55 }}>
                        <div>低音：{selectedMeasure.bassName || '未確定'}</div>
                        <div style={{ marginTop: 4 }}>旋律走向：{selectedMeasure.melodyTrend || '資訊不足'}</div>
                        <div style={{ marginTop: 4 }}>和聲功能：{selectedMeasure.harmonicFunction || '未確定'}{selectedMeasure.cadenceHint ? ` · ${selectedMeasure.cadenceHint}` : ''}</div>
                        {theoryMode === 'nonChordHints' && selectedMeasure.nonChordHints.length > 0 && <div style={{ marginTop: 5 }}>非和弦音候選：{selectedMeasure.nonChordHints.map(hint => `${hint.noteName} ${hint.label}`).join('；')}</div>}
                        {theoryMode === 'melodyContour' && <div style={{ marginTop: 5 }}>旋律輪廓：{selectedMeasure.melodyContour} · 音域：{selectedMeasure.melodyRange}</div>}
                      </div>
                    </section>}
                    <div style={{ padding: 9, borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', color: '#85919d', fontSize: 10, lineHeight: 1.6 }}>
                      分析範圍：和弦構成音、調性、拍號、速度、低音線、非和弦音候選與旋律輪廓。自動分析適合作為學習參考；複雜和聲仍建議人工核對。
                    </div>
                  </>
                )
              })()}
              {isAdmin && <div style={{ color: '#87929e', fontSize: 10.5 }}>{theoryCorrectionCloudReady ? '人工校正已連接雲端儲存。' : '雲端校正介面尚未確認可用，變更暫存於本機。'}</div>}
            </div>
          </aside>
        </>}

        {!theoryPanelOpen && !loading && !error && <button
          type="button"
          onClick={() => setTheoryPanelOpen(true)}
          aria-label="顯示樂理分析面板"
          aria-expanded={false}
          title="顯示樂理分析面板"
          style={{
            position: 'fixed', zIndex: 1001, right: 0, top: '43%', transform: 'translateY(-50%)',
            writingMode: 'vertical-rl', textOrientation: 'mixed',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            minHeight: 116, padding: '13px 9px', borderRadius: '12px 0 0 12px',
            border: '1px solid rgba(227,201,151,.68)', borderRight: 0,
            background: theme === 'day' ? 'rgba(255,252,244,.52)' : 'rgba(17,24,33,.52)', color: theme === 'day' ? '#806329' : '#f1d99b',
            fontSize: 12, fontWeight: 750, cursor: 'pointer', letterSpacing: .4,
            boxShadow: '0 12px 32px rgba(0,0,0,.36), inset 0 1px 0 rgba(255,255,255,.18)',
            backdropFilter: 'blur(36px) saturate(190%)', WebkitBackdropFilter: 'blur(36px) saturate(190%)',
          }}
        >♫ 樂理分析</button>}

        {loading && <div style={{ color: colors.muted, padding: 10 }}>正在分析鋼琴 MusicXML 小節時值與反覆記號…</div>}
        {parsed && (
          <div ref={scoreWithCurrentMeasureRef} className="score-room-score-with-current-measure" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignItems: 'start', position: 'relative' }}>
            <div style={{ gridArea: '1 / 1', minWidth: 0 }}>
              <PianoPdfScoreDisplay
                          fileUrl={pdfUrl}
                          measureCount={parsed.measures.length}
                          measureNumbers={parsed.measures.map(measure => measure.printedNumber)}
                          systemStartIndices={parsed.measures.filter(measure => measure.startsSystem).map(measure => measure.index)}
                          cursorMeasureIndex={cursor.measureIndex}
                          cursorProgress={cursor.progress}
                          cursorAnchorTimes={cursorAnchorTimes}
                          cursorAnchorPositions={cursorAnchorPositions}
                          zoom={zoom}
                          autoFollow={autoFollow}
                          showMappingDebug={isAdmin && adminToolsOpen && showMappingDebug}
                          chordLabels={chordLabels}
                          onMeasureClick={onMeasureClick}
                        />
            </div>
            {currentPianoTheoryHud && !loading && !error && !theoryError && (
              <>
                <style>{`
                  @media (max-width: 760px) {
                    .score-room-current-theory-hud[data-compact="false"] { overflow: hidden !important; overflow-y: hidden !important; }
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
                          <strong style={{ color: theme === 'day' ? '#6f511a' : '#f1d99b', fontSize: 12, fontWeight: 850, whiteSpace: 'nowrap' }}>當前小節：{currentPianoTheoryHud.measure.printedNumber}</strong>
                          <span style={{ color: theme === 'day' ? '#68717d' : '#9ba8b5', fontSize: 9, whiteSpace: 'nowrap' }}>播放中</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, .9fr) minmax(0, .9fr) minmax(0, 1.35fr) minmax(0, .65fr) minmax(0, 1.4fr)', alignItems: 'baseline', columnGap: 5, width: '100%', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', lineHeight: 1.2, paddingBottom: 1 }}>
                          <div title={currentPianoTheoryHud.activeChord?.symbol ?? '未確定'} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9 }}>和弦</span>
                            <strong style={{ color: theme === 'day' ? '#75520e' : '#f1d99b', fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.activeChord?.symbol ?? '未確定'}</strong>
                          </div>
                          <div title={currentPianoTheoryHud.roman} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9 }}>級數</span>
                            <strong style={{ color: theme === 'day' ? '#775e25' : '#d8c18e', fontSize: 10.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.roman}</strong>
                          </div>
                          <div title={currentPianoTheoryHud.toneNames.length ? currentPianoTheoryHud.toneNames.join(' · ') : '音高資訊不足'} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>構成音</span>
                            <span style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.toneNames.length ? currentPianoTheoryHud.toneNames.join(' · ') : '音高資訊不足'}</span>
                          </div>
                          <div title={currentPianoTheoryHud.bassName} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9 }}>低音</span>
                            <strong style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.bassName}</strong>
                          </div>
                          <div title={currentPianoTheoryHud.nonChordText} style={{ display: 'flex', gap: 3, alignItems: 'baseline', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>非和弦候選</span>
                            <span style={{ color: currentPianoTheoryHud.nonChordText === '暫無候選音' ? (theme === 'day' ? '#737d88' : '#8f9ca8') : (theme === 'day' ? '#815a18' : '#e5c489'), fontSize: 9.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.nonChordText}</span>
                          </div>
                        </div>
                      </>
                    ) : (
<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3, width: 'max-content', maxWidth: '100%', minWidth: 0, lineHeight: 1.2 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, width: 'max-content', maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap' }}>
                          <div title={`${currentPianoTheoryHud.activeChord?.symbol ?? '未確定'} / ${currentPianoTheoryHud.roman}`} style={{ display: 'flex', alignItems: 'baseline', gap: 3, flex: '0 0 auto', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>和弦</span>
                            <strong style={{ color: theme === 'day' ? '#75520e' : '#f1d99b', fontSize: 10.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.activeChord?.symbol ?? '未確定'}</strong>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>/</span>
                            <strong style={{ color: theme === 'day' ? '#775e25' : '#d8c18e', fontSize: 10, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.roman}</strong>
                          </div>
                          <div title={currentPianoTheoryHud.toneNames.length ? currentPianoTheoryHud.toneNames.join(' · ') : '音高資訊不足'} style={{ display: 'flex', alignItems: 'baseline', gap: 3, flex: '0 1 auto', minWidth: 0, maxWidth: 150, overflow: 'hidden' }}>
                            <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>構成音</span>
                            <span style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, fontWeight: 650, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.toneNames.length ? currentPianoTheoryHud.toneNames.join(' · ') : '音高資訊不足'}</span>
                          </div>
                        </div>
                        <div title={currentPianoTheoryHud.bassName} style={{ display: 'flex', alignItems: 'baseline', gap: 3, width: 'max-content', maxWidth: '100%', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                          <span style={{ color: theme === 'day' ? '#707987' : '#9ba8b5', fontSize: 9, flexShrink: 0 }}>低音</span>
                          <strong style={{ color: theme === 'day' ? '#343d49' : '#e7edf2', fontSize: 9.5, minWidth: 0, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPianoTheoryHud.bassName}</strong>
                        </div>
                      </div>
                    )}
</aside>
              </>
            )}
          </div>
        )}

        <p style={{ color: colors.soft, fontSize: 11, lineHeight: 1.65, marginTop: 12 }}>鋼琴 PDF 小節、播放進度與樂理標註會依目前讀取的 MusicXML 對應。分析結果為音符推斷與原譜標記的輔助資訊，複雜和聲仍建議對照原譜確認。</p>
        <PlaybackControlBar
          label="鋼琴 MP3" metronomeBeatGrid={metronomeBeatGrid} currentTime={currentTime} duration={actualDuration} playing={playing} ready={mp3Ready}
          scoreTempo={parsed?.measures[cursor.measureIndex]?.tempo ?? parsed?.measures[0]?.tempo ?? 80} meter={parsed?.meter ?? '4/4'}
          rate={rate} autoFollow={autoFollow} onTogglePlay={() => void togglePlayback()}
          onStop={stopPlayback} zoom={zoom} onZoomChange={setZoom} theoryOpen={theoryPanelOpen} onToggleTheory={() => setTheoryPanelOpen(value => !value)}
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
