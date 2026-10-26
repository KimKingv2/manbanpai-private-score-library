// 慢半拍譜間 V8.3.3: restore explicit muted/percussive X-note rendering; keep V8.3.2 rhythm-stem geometry.
import { useEffect, useMemo, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'

const MANBANPAI_READER_BUILD = 'MANBANPAI_READER_BUILD_20261022_V8_3_4_MUTE'
const SCORE_ROOM_VERBOSE_DEBUG = false

// Fixed screen-space guide for custom TAB rhythm stems; change this centrally only.
const TAB_DURATION_STEM_GAP_SCREEN_PX = 7.2
const TAB_DURATION_STEM_EXTRA_LENGTH_SCREEN_PX = 0.0
const TAB_DURATION_DOT_EXTRA_RIGHT_PX = 1.0
import { getCanonicalMusicXmlData, validateCanonicalMusicXmlData, type CanonicalMusicXmlData } from './musicDataModel'

// ScoreRoom v80: compact fixed theory-mode row and combined chord/degree option

export type ScoreType = 'piano' | 'guitar-vocal' | 'guitar-fingerstyle'

type ScoreReaderProps = {
  fileUrl?: string
  /** Manually selected library type. If omitted, keep the v8 content-based fallback. */
  scoreType?: ScoreType
}

type ScoreAnnotationLayers = {
  chordNames: boolean
  romanNumerals: boolean
  bassLine: boolean
  nonChordHints: boolean
  melodyContour: boolean
}


type PlaybackTone = {
  midi: number
  durationSeconds: number
  /** Internal metadata used to merge MusicXML/OSMD tie chains into one piano attack. */
  sourceNote?: any
  rawDurationSeconds?: number
  /** Start shift relative to the owning score-time event, in seconds at notated tempo. */
  startOffsetSeconds?: number
  /** Grace-note entries must not be merged with the principal note of the same pitch. */
  isGrace?: boolean
  /** True for extra playback entries generated for ornaments rather than the principal attack. */
  isMainPlaybackEntry?: boolean
  /** Marks a note whose onset is staggered by a MusicXML/OSMD arpeggio marking. */
  isArpeggiated?: boolean
  suppressPlayback?: boolean
  /** Guitar TAB string for direction-aware strumming. */
  tabStringNumber?: number
  /** A legato guitar transition encoded by MusicXML technical markings. */
  guitarArticulation?: 'hammer-on' | 'pull-off'
  /** Previous pitch on the same string; used for a short sample-based legato glide. */
  guitarLegatoFromMidi?: number
  /** Direction-dependent string attack level for audible up/down strumming contrast. */
  guitarVelocityMultiplier?: number
  /** Original visible sweep direction, used for distinct steel-string EQ and attack. */
  guitarStrumDirection?: BrushDirection
}

type PlaybackTimelineEvent = {
  time: number
  notes: PlaybackTone[]
  /** Zero-based source-measure index, used for click-to-play navigation. */
  measureIndex: number
  /** Printed MusicXML measure number from the canonical source model, for diagnostics/UI. */
  printedMeasureNumber?: string
  /** XML measure number exposed by OSMD's source model, used to detect index mismatches. */
  sourceMeasureXmlNumber?: string
  /** Quarter-note position inside the source measure, used to place MusicXML directions. */
  positionQuarter: number
  /** Quarter-note tempo at this timeline event. */
  bpm: number
  /** MIDI-like expressive level derived from MusicXML dynamics, default mezzo-forte. */
  dynamicLevel: number
  /** True while the MusicXML damper pedal is engaged. */
  pedalDown: boolean
  /** Score-time of the next pedal release, if this event begins while the pedal is down. */
  pedalReleaseTime: number | null
}

type ScoreMeter = { beats: number; beatType: number }
type MetronomeBeat = {
  time: number
  accent: boolean
  secondaryAccent?: boolean
  subdivision?: boolean
  measureIndex: number
}


type ActivePlaybackVoice = {
  source: AudioScheduledSourceNode
  gain: GainNode
  /** AudioContext time at which this source is scheduled to begin. */
  scheduledStartTime: number
}

type SalamanderSampleKey = {
  midi: number
  file: string
}

/**
 * Salamander Grand Piano V3 samples, originally recorded by Alexander Holm.
 * The sample positions and filenames follow the public Tone.js Salamander example.
 */
// Source samples: Tone.js Salamander collection, recorded by Alexander Holm; CC BY 3.0.
const SALAMANDER_SAMPLE_BASE_URL = '/media/audio/salamander/'
const SALAMANDER_SAMPLE_KEYS: SalamanderSampleKey[] = [
  { midi: 21, file: 'A0.mp3' },
  { midi: 24, file: 'C1.mp3' },
  { midi: 27, file: 'Ds1.mp3' },
  { midi: 30, file: 'Fs1.mp3' },
  { midi: 33, file: 'A1.mp3' },
  { midi: 36, file: 'C2.mp3' },
  { midi: 39, file: 'Ds2.mp3' },
  { midi: 42, file: 'Fs2.mp3' },
  { midi: 45, file: 'A2.mp3' },
  { midi: 48, file: 'C3.mp3' },
  { midi: 51, file: 'Ds3.mp3' },
  { midi: 54, file: 'Fs3.mp3' },
  { midi: 57, file: 'A3.mp3' },
  { midi: 60, file: 'C4.mp3' },
  { midi: 63, file: 'Ds4.mp3' },
  { midi: 66, file: 'Fs4.mp3' },
  { midi: 69, file: 'A4.mp3' },
  { midi: 72, file: 'C5.mp3' },
  { midi: 75, file: 'Ds5.mp3' },
  { midi: 78, file: 'Fs5.mp3' },
  { midi: 81, file: 'A5.mp3' },
  { midi: 84, file: 'C6.mp3' },
  { midi: 87, file: 'Ds6.mp3' },
  { midi: 90, file: 'Fs6.mp3' },
  { midi: 93, file: 'A6.mp3' },
  { midi: 96, file: 'C7.mp3' },
  { midi: 99, file: 'Ds7.mp3' },
  { midi: 102, file: 'Fs7.mp3' },
  { midi: 105, file: 'A7.mp3' },
  { midi: 108, file: 'C8.mp3' },
]

function nearestSalamanderSampleKey(midi: number): SalamanderSampleKey {
  let nearest = SALAMANDER_SAMPLE_KEYS[0]
  let distance = Math.abs(midi - nearest.midi)
  for (const key of SALAMANDER_SAMPLE_KEYS.slice(1)) {
    const candidateDistance = Math.abs(midi - key.midi)
    if (candidateDistance < distance) {
      nearest = key
      distance = candidateDistance
    }
  }
  return nearest
}

/**
 * FluidR3 General MIDI guitar samples, served as self-contained base64 MP3 data URLs.
 * Instrument samples are CC BY 3.0; see the bundled integration notes for attribution.
 * All guitar score modes use steel-string acoustic guitar samples.
 */
const GUITAR_SOUNDFONT_BASE_URLS = [
  // Local hosting remains preferred when the site owner has copied the soundfont into public/.
  '/media/audio/FluidR3_GM/',
  // The V6 repair package did not include the large soundfont payload, so use browser-fetchable
  // FluidR3_GM mirrors as fallbacks instead of silently landing on the synthetic oscillator.
  'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/',
  'https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/',
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/',
] as const
type GuitarSoundfontInstrument = 'acoustic_guitar_steel'

function guitarSoundfontInstrumentForScore(_scoreType: ScoreType): GuitarSoundfontInstrument {
  // All guitar modes use steel-string acoustic guitar, per user preference.
  return 'acoustic_guitar_steel'
}

function midiFromSoundfontKey(noteName: string): number | null {
  const match = /^([A-G])([sb]?)(-?\d+)$/.exec(noteName)
  if (!match) return null
  const pitchClassByLetter: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const accidental = match[2] === 's' ? 1 : match[2] === 'b' ? -1 : 0
  const octave = Number(match[3])
  const midi = (octave + 1) * 12 + pitchClassByLetter[match[1]] + accidental
  return Number.isInteger(midi) && midi >= 0 && midi <= 127 ? midi : null
}

function fractionValue(value: any): number {
  const raw = value?.realValue ?? value?.RealValue ?? value
  const numberValue = Number(raw)
  return Number.isFinite(numberValue) ? numberValue : 0
}

/** Resolve a graphical or iterator measure to the canonical SourceMeasures index. */
/** Earliest lead-in note shift on an event, used to leave room before a grace-note group. */
function getEventPreRollSeconds(event: PlaybackTimelineEvent | undefined): number {
  if (!event) return 0
  return event.notes.reduce((max, tone) => {
    const offset = Number(tone.startOffsetSeconds ?? 0)
    return Number.isFinite(offset) && offset < 0 ? Math.max(max, -offset) : max
  }, 0)
}

/**
 * Resolve an OSMD graphical measure to the canonical SourceMeasures index.
 *
 * IMPORTANT: MeasureList's outer array index is a graphical slot, not a safe source
 * measure index. OSMD may insert ExtraGraphicalMeasure slots for mid-system clef/key/
 * time-signature changes; using that slot as a fallback shifts every later annotation.
 * This resolver deliberately returns -1 when a graphical measure cannot be mapped with
 * source identity, an explicitly exposed source index, or a unique XML measure number.
 */
function resolveGraphicalMeasureSourceIndex(osmd: any, graphicalMeasure: any): number {
  if (!graphicalMeasure || (graphicalMeasure.IsExtraGraphicalMeasure ?? graphicalMeasure.isExtraGraphicalMeasure)) {
    return -1
  }
  const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
  if (!Array.isArray(sourceMeasures) || sourceMeasures.length === 0) return -1

  const sourceMeasure = graphicalMeasure.parentSourceMeasure ?? graphicalMeasure.ParentSourceMeasure ??
    graphicalMeasure.sourceMeasure ?? graphicalMeasure.SourceMeasure ?? null
  if (sourceMeasure) {
    const identityIndex = sourceMeasures.indexOf(sourceMeasure)
    if (identityIndex >= 0) return identityIndex
  }

  const xmlKey = (measure: any): string | null => {
    const raw = measure?.MeasureNumberXML ?? measure?.measureNumberXML ?? measure?.measureNumberXml
    if (raw === undefined || raw === null || String(raw).trim() === '') return null
    return String(raw).trim()
  }
  const sourceXmlKey = xmlKey(sourceMeasure) ?? xmlKey(graphicalMeasure)

  // Use an explicitly exposed source/list index only after checking it against XML
  // identity whenever both sides expose that information.
  const rawIndexCandidates = [
    sourceMeasure?.measureListIndex, sourceMeasure?.MeasureListIndex,
    graphicalMeasure?.sourceMeasureIndex, graphicalMeasure?.SourceMeasureIndex,
    graphicalMeasure?.measureListIndex, graphicalMeasure?.MeasureListIndex,
  ]
  for (const raw of rawIndexCandidates) {
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0 || index >= sourceMeasures.length) continue
    const targetXmlKey = xmlKey(sourceMeasures[index])
    if (sourceXmlKey === null || targetXmlKey === null || sourceXmlKey === targetXmlKey) return index
  }

  if (sourceXmlKey !== null) {
    const matches: number[] = []
    sourceMeasures.forEach((measure, index) => {
      if (xmlKey(measure) === sourceXmlKey) matches.push(index)
    })
    if (matches.length === 1) return matches[0]
  }

  // Printed numbers can repeat or restart; accept only a unique exact string match.
  const printedKeyRaw = graphicalMeasure.MeasureNumber ?? graphicalMeasure.measureNumber ??
    sourceMeasure?.MeasureNumberPrinted ?? sourceMeasure?.MeasureNumber ?? sourceMeasure?.measureNumber
  if (printedKeyRaw !== undefined && printedKeyRaw !== null && String(printedKeyRaw).trim() !== '') {
    const printedKey = String(printedKeyRaw).trim()
    const matches: number[] = []
    sourceMeasures.forEach((measure, index) => {
      const candidate = measure?.MeasureNumberPrinted ?? measure?.MeasureNumberXML ?? measure?.MeasureNumber ?? measure?.measureNumber
      if (candidate !== undefined && candidate !== null && String(candidate).trim() === printedKey) matches.push(index)
    })
    if (matches.length === 1) return matches[0]
  }

  return -1
}

function resolveSourceMeasureIndex(osmd: any, sourceMeasure: any, fallbackIndex = -1): number {
  const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
  if (!Array.isArray(sourceMeasures) || sourceMeasures.length === 0) {
    return Number.isInteger(fallbackIndex) && fallbackIndex >= 0 ? fallbackIndex : -1
  }

  // Identity is the strongest signal: graphical measures and iterator entries normally
  // reference the same SourceMeasure instance.
  if (sourceMeasure) {
    const identityIndex = sourceMeasures.indexOf(sourceMeasure)
    if (identityIndex >= 0) return identityIndex
  }

  const readXmlNumber = (measure: any): number | null => {
    const raw = measure?.MeasureNumberXML ?? measure?.measureNumberXML
    if (raw === undefined || raw === null || String(raw).trim() === '') return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  const sourceXmlNumber = readXmlNumber(sourceMeasure)
  const rawIndex = Number(sourceMeasure?.measureListIndex ?? sourceMeasure?.MeasureListIndex)
  const validRawIndex = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < sourceMeasures.length

  // A stale/incompatible wrapper can expose a measureListIndex that does not match
  // its own XML measure number. Verify the index rather than trusting it blindly.
  if (validRawIndex) {
    const indexedXmlNumber = readXmlNumber(sourceMeasures[rawIndex])
    if (sourceXmlNumber === null || indexedXmlNumber === null || sourceXmlNumber === indexedXmlNumber) {
      return rawIndex
    }
  }

  // If the index and XML number conflict, prefer a unique XML-number match. This is
  // a recovery path for graphical wrappers that were recreated during re-render.
  if (sourceXmlNumber !== null) {
    const matches: number[] = []
    sourceMeasures.forEach((item, index) => {
      if (readXmlNumber(item) === sourceXmlNumber) matches.push(index)
    })
    if (matches.length === 1) return matches[0]
  }

  // Printed/XML measure numbers aren't guaranteed to be unique, so only use this
  // secondary match when it uniquely identifies a source measure.
  const rawNumberValue = sourceMeasure?.MeasureNumberPrinted ?? sourceMeasure?.MeasureNumber ?? sourceMeasure?.measureNumber
  if (rawNumberValue !== undefined && rawNumberValue !== null && String(rawNumberValue).trim() !== '') {
    const number = Number(rawNumberValue)
    if (Number.isFinite(number)) {
      const matches: number[] = []
      sourceMeasures.forEach((item, index) => {
        const candidate = Number(item?.MeasureNumberPrinted ?? item?.MeasureNumberXML ?? item?.MeasureNumber ?? item?.measureNumber)
        if (Number.isFinite(candidate) && candidate === number) matches.push(index)
      })
      if (matches.length === 1) return matches[0]
    }
  }

  return validRawIndex ? rawIndex :
    (Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < sourceMeasures.length ? fallbackIndex : -1)
}

/**
 * Build a timeline from OSMD's own voice-entry iterator. Timestamps are whole-note
 * fractions, so one unit is four quarter-note beats. This is intentionally a first
 * timeline: piano scores use Salamander audio samples; other score types retain the simple oscillator fallback.
 */
function extractPlaybackTimeline(osmd: any, scoreType?: ScoreType, canonicalData?: CanonicalMusicXmlData): PlaybackTimelineEvent[] {
  const cursor = osmd?.cursor
  if (!cursor?.Iterator) throw new Error('OSMD cursor is not ready')

  cursor.reset()
  const iterator = cursor.Iterator.clone()
  const events: PlaybackTimelineEvent[] = []
  let previousTimestamp: number | null = null
  let previousBpm = 80
  let elapsedSeconds = 0
  let steps = 0
  let positionMeasureIndex = -999
  let measureStartTimestamp = 0

  while (!iterator.EndReached && steps < 100000) {
    const timestamp = fractionValue(iterator.currentTimeStamp ?? iterator.CurrentTimeStamp)
    const measure = iterator.CurrentMeasure ?? iterator.currentMeasure
    const bpmCandidate = Number(
      iterator.CurrentBpm ?? iterator.currentBpm ?? measure?.TempoInBPM ?? 80,
    )
    const bpm = Number.isFinite(bpmCandidate) && bpmCandidate > 0 ? bpmCandidate : 80

    if (previousTimestamp !== null) {
      const delta = Math.max(0, timestamp - previousTimestamp)
      elapsedSeconds += delta * 240 / Math.max(30, previousBpm)
    }

    // Resolve measure before deriving its local beat offset. The MusicXML performance
    // marks are expressed in quarter-note positions within each source measure.
    const iteratorMeasureIndex = Number(iterator.CurrentMeasureIndex ?? iterator.currentMeasureIndex)
    const measureIndex = resolveSourceMeasureIndex(
      osmd,
      measure,
      Number.isInteger(iteratorMeasureIndex) ? iteratorMeasureIndex : -1,
    )
    if (measureIndex !== positionMeasureIndex) {
      positionMeasureIndex = measureIndex
      measureStartTimestamp = timestamp
    }
    const positionQuarter = Math.max(0, (timestamp - measureStartTimestamp) * 4)

    const tones: PlaybackTone[] = []
    const voiceEntries: any[] = iterator.CurrentVoiceEntries ?? iterator.currentVoiceEntries ?? []

    const entryNotes = (entry: any): any[] => {
      const value = entry?.Notes ?? entry?.notes ?? []
      return Array.isArray(value) ? value : []
    }
    const entryList = (entry: any, upper: string, lower: string): any[] => {
      const value = entry?.[upper] ?? entry?.[lower] ?? []
      return Array.isArray(value) ? value : []
    }
    const toneFromSourceNote = (
      note: any,
      options: { isGrace?: boolean; startOffsetSeconds?: number; isMainPlaybackEntry?: boolean; durationCapSeconds?: number } = {},
    ): PlaybackTone | null => {
      if (!note) return null
      const rest = typeof note?.isRest === 'function'
        ? note.isRest()
        : Boolean(note?.IsRest ?? note?.isRest)
      if (rest) return null

      // PlaybackNote.MidiKey is already MIDI. A source Note's halfTone is OSMD's
      // internal pitch and needs the historical +12 conversion used by this player.
      const playbackMidi = Number(note?.MidiKey ?? note?.midiKey)
      const rawHalfTone = note.halfTone ?? note.HalfTone ?? note.Pitch?.HalfTone
      const halfTone = Number(rawHalfTone)
      const midi = Number.isFinite(playbackMidi) ? playbackMidi : halfTone + 12
      if (!Number.isFinite(midi) || midi < 12 || midi > 119) return null

      const lengthValue = note?.Length ?? note?.length
      const noteLength = fractionValue(lengthValue)
      let durationSeconds = noteLength > 0
        ? Math.max(0.045, noteLength * 240 / bpm)
        : 60 / bpm
      if (options.durationCapSeconds !== undefined && Number.isFinite(options.durationCapSeconds)) {
        durationSeconds = Math.max(0.04, Math.min(durationSeconds, options.durationCapSeconds))
      }
      return {
        midi,
        durationSeconds,
        sourceNote: note?.ParentNote ?? note?.parentNote ?? note,
        rawDurationSeconds: durationSeconds,
        startOffsetSeconds: options.startOffsetSeconds,
        isGrace: options.isGrace ?? Boolean(note?.IsGraceNote ?? note?.isGraceNote),
        isMainPlaybackEntry: options.isMainPlaybackEntry,
      }
    }

    // Some OSMD builds expose a prepared PlaybackEntries timeline for a voice entry.
    // These include the principal note plus extra grace/ornament attacks (e.g. trills).
    // Use that richer representation when it is available, while retaining the fallback
    // below for OSMD versions that only expose source notes and grace-entry lists.
    for (const voiceEntry of voiceEntries) {
      const notes: any[] = entryNotes(voiceEntry)
      const playbackEntries = entryList(voiceEntry, 'PlaybackEntries', 'playbackEntries')
      const mainPlaybackEntry = voiceEntry?.MainPlaybackEntry ?? voiceEntry?.mainPlaybackEntry ?? playbackEntries[0]
      const hasOrnamentPlaybackEntries = playbackEntries.length > 1
      let usedPlaybackEntries = false

      if (hasOrnamentPlaybackEntries) {
        for (let playbackEntryIndex = 0; playbackEntryIndex < playbackEntries.length; playbackEntryIndex++) {
          const playbackEntry = playbackEntries[playbackEntryIndex]
          const playbackNotes = entryNotes(playbackEntry)
          const rawShift = fractionValue(playbackEntry?.TimestampShift ?? playbackEntry?.timestampShift)
          const offsetSeconds = rawShift * 240 / bpm
          const isMainEntry = playbackEntry === mainPlaybackEntry ||
            (!mainPlaybackEntry && playbackEntryIndex === 0) ||
            (Math.abs(rawShift) < 0.000001 && playbackEntryIndex === 0)
          let addedFromEntry = 0
          for (const playbackNote of playbackNotes) {
            const tone = toneFromSourceNote(playbackNote, {
              startOffsetSeconds: Math.abs(offsetSeconds) > 0.00001 ? offsetSeconds : undefined,
              isMainPlaybackEntry: isMainEntry,
              isGrace: Boolean(playbackNote?.ParentNote?.IsGraceNote ?? playbackNote?.parentNote?.IsGraceNote),
            })
            if (!tone) continue
            // Playback-note entries can supply their own parent note and MIDI key.
            // Keep a separate role flag so a trill attack is never merged into a tie chain.
            if (!isMainEntry) tone.isMainPlaybackEntry = false
            tones.push(tone)
            addedFromEntry++
          }
          if (addedFromEntry > 0) usedPlaybackEntries = true
        }
      }

      if (usedPlaybackEntries) continue

      const graceBefore = entryList(voiceEntry, 'GraceVoiceEntriesBefore', 'graceVoiceEntriesBefore')
      const graceAfter = entryList(voiceEntry, 'GraceVoiceEntriesAfter', 'graceVoiceEntriesAfter')
      const attachedGraceNotes = new Set<any>()
      for (const graceEntry of [...graceBefore, ...graceAfter]) {
        for (const graceNote of entryNotes(graceEntry)) attachedGraceNotes.add(graceNote)
      }

      const mainTones: PlaybackTone[] = []
      for (const note of notes) {
        const isGrace = Boolean(note?.IsGraceNote ?? note?.isGraceNote ?? voiceEntry?.IsGrace ?? voiceEntry?.isGrace)
        if (isGrace && attachedGraceNotes.has(note)) continue
        const tone = toneFromSourceNote(note, { isGrace })
        if (!tone) continue
        if (isGrace) {
          const graceStep = Math.min(0.11, Math.max(0.045, (60 / bpm) * 0.14))
          tone.startOffsetSeconds = -graceStep
          tone.isMainPlaybackEntry = false
          tone.durationSeconds = Math.min(tone.durationSeconds, graceStep * 1.25)
        } else {
          tone.isMainPlaybackEntry = true
          mainTones.push(tone)
        }
        tones.push(tone)
      }

      // When a build does not provide generated playback entries, construct a modest,
      // tempo-aware lead-in/after-note for OSMD's explicit grace-entry attachments.
      const quarterSeconds = 60 / bpm
      const maxMainDuration = mainTones.reduce((max, tone) => Math.max(max, tone.durationSeconds), quarterSeconds)
      const appendGraceEntries = (graceEntries: any[], placement: 'before' | 'after') => {
        const groups = graceEntries.map(entry => ({ entry, notes: entryNotes(entry).filter(note => {
          const rest = typeof note?.isRest === 'function' ? note.isRest() : Boolean(note?.IsRest ?? note?.isRest)
          return !rest && Number.isFinite(Number(note?.halfTone ?? note?.HalfTone ?? note?.Pitch?.HalfTone))
        }) })).filter(group => group.notes.length > 0)
        if (!groups.length) return
        const isSlashed = groups.some(group => Boolean(group.entry?.GraceNoteSlash ?? group.entry?.graceNoteSlash))
        const totalSpan = Math.min(0.18, Math.max(0.06, quarterSeconds * (isSlashed ? 0.16 : 0.23)))
        const step = totalSpan / groups.length
        const afterBase = placement === 'after'
          ? Math.min(0.14, Math.max(0.035, maxMainDuration * 0.68))
          : 0
        groups.forEach((group, groupIndex) => {
          const groupOffset = placement === 'before'
            ? -totalSpan + groupIndex * step
            : afterBase + groupIndex * step
          const graceDurationCap = Math.max(0.04, step * 1.22)
          for (const graceNote of group.notes) {
            const tone = toneFromSourceNote(graceNote, {
              isGrace: true,
              isMainPlaybackEntry: false,
              startOffsetSeconds: groupOffset,
              durationCapSeconds: graceDurationCap,
            })
            if (tone) tones.push(tone)
          }
        })
      }
      appendGraceEntries(graceBefore, 'before')
      appendGraceEntries(graceAfter, 'after')
    }

    // OSMD assigns an Arpeggio object to the notes participating in one marked chord.
    // Stagger only those attacks, preserving the note durations so the chord rolls and
    // then sustains instead of turning into a sequence of detached notes.
    const arpeggioGroups = new Map<any, PlaybackTone[]>()
    for (const tone of tones) {
      if (tone.isGrace || tone.isMainPlaybackEntry === false || !tone.sourceNote) continue
      const sourceNote: any = tone.sourceNote
      const arpeggio = sourceNote?.Arpeggio ?? sourceNote?.arpeggio ??
        sourceNote?.ParentVoiceEntry?.Arpeggio ?? sourceNote?.parentVoiceEntry?.arpeggio
      if (!arpeggio || (typeof arpeggio !== 'object' && typeof arpeggio !== 'function')) continue
      const group = arpeggioGroups.get(arpeggio) ?? []
      group.push(tone)
      arpeggioGroups.set(arpeggio, group)
    }
    for (const [arpeggio, group] of arpeggioGroups) {
      if (group.length < 2) continue
      const rawType = arpeggio?.type ?? arpeggio?.Type ?? ''
      const numericType = Number(rawType)
      const typeText = String(rawType).toLowerCase()
      const descending = [1, 3, 5].includes(numericType) || /down/.test(typeText)
      const ordered = [...group].sort((a, b) => descending ? b.midi - a.midi : a.midi - b.midi)
      const totalSpread = Math.min(0.18, Math.max(0.065, (60 / bpm) * 0.20))
      const step = totalSpread / Math.max(1, ordered.length - 1)
      ordered.forEach((tone, index) => {
        tone.startOffsetSeconds = index * step
        tone.isArpeggiated = true
      })
    }

    // Share the exact source-measure key used by graphical click targets. Keep the
    // renderer's XML number too, so the canonical pass can detect any off-by-one map.
    const sourceMeasureXmlNumberRaw = measure?.MeasureNumberXML ?? measure?.measureNumberXML
    const sourceMeasureXmlNumber = sourceMeasureXmlNumberRaw === undefined || sourceMeasureXmlNumberRaw === null
      ? undefined
      : String(sourceMeasureXmlNumberRaw).trim()
    events.push({
      time: elapsedSeconds,
      notes: tones,
      measureIndex,
      printedMeasureNumber: measureIndex >= 0 ? canonicalData?.measures[measureIndex]?.printedNumber : undefined,
      sourceMeasureXmlNumber: sourceMeasureXmlNumber || undefined,
      positionQuarter,
      bpm,
      dynamicLevel: 78,
      pedalDown: false,
      pedalReleaseTime: null,
    })
    previousTimestamp = timestamp
    previousBpm = bpm
    iterator.moveToNext()
    steps += 1
  }

  if (steps >= 100000) {
    console.warn('[ScoreRoom] Playback timeline reached its safety limit.')
  }

  // Salamander is a recorded piano sample, so a tie chain must create only one
  // attack. OSMD exposes NoteTie with all tied Note objects; use the timeline's
  // own timestamps to extend the first note through the last tied note, then
  // suppress later members of the same tie. This also respects local tempo
  // changes better than simply multiplying Tie.Duration by the first BPM.
  const scheduledBySourceNote = new Map<any, { event: PlaybackTimelineEvent; tone: PlaybackTone }>()
  for (const event of events) {
    for (const tone of event.notes) {
      if (tone.sourceNote && tone.isMainPlaybackEntry !== false) {
        scheduledBySourceNote.set(tone.sourceNote, { event, tone })
      }
    }
  }

  for (const event of events) {
    for (const tone of event.notes) {
      if (tone.isMainPlaybackEntry === false) continue
      const sourceNote = tone.sourceNote
      const tie: any = sourceNote?.NoteTie ?? sourceNote?.noteTie
      const tiedNotes: any[] = tie?.Notes ?? tie?.notes ?? []
      if (!sourceNote || !Array.isArray(tiedNotes) || tiedNotes.length < 2) continue

      const tieStartNote = tie?.StartNote ?? tie?.startNote ?? tiedNotes[0]
      const currentTieIndex = tiedNotes.indexOf(sourceNote)
      const isTieStart = sourceNote === tieStartNote || currentTieIndex === 0

      // The current note is tied from a previous note: don't retrigger it.
      if (!isTieStart && currentTieIndex > 0) {
        tone.suppressPlayback = true
        continue
      }
      if (!isTieStart) continue

      const startEntry = scheduledBySourceNote.get(tieStartNote) ?? scheduledBySourceNote.get(tiedNotes[0])
      if (!startEntry) continue
      let tieEndTime = startEntry.event.time + (startEntry.tone.rawDurationSeconds ?? startEntry.tone.durationSeconds)
      for (const tiedNote of tiedNotes) {
        const entry = scheduledBySourceNote.get(tiedNote)
        if (!entry) continue
        const memberDuration = entry.tone.rawDurationSeconds ?? entry.tone.durationSeconds
        tieEndTime = Math.max(tieEndTime, entry.event.time + memberDuration)
      }
      if (tieEndTime > startEntry.event.time) {
        startEntry.tone.durationSeconds = tieEndTime - startEntry.event.time
      }
    }
  }

  // Same-pitch unisons at the same onset should strike the key once, not stack two
  // identical Salamander samples and make that pitch unnaturally loud or doubled.
  // Keep the longer notated duration when the two voices use different lengths.
  for (const event of events) {
    const clean: PlaybackTone[] = []
    const indexByMidiAndOffset = new Map<string, number>()
    for (const tone of event.notes) {
      // Piano tie continuations can be removed now because the first sample is extended.
      // For guitar, keep suppressed tie members until MusicXML hammer-on/pull-off mapping runs:
      // some GP exporters represent the destination as both a tie continuation and a legato target.
      if (tone.suppressPlayback && scoreType === 'piano') continue
      const offset = Number(tone.startOffsetSeconds ?? 0)
      const timingKey = `${tone.midi}:${Math.round((Number.isFinite(offset) ? offset : 0) * 10000)}`
      const duplicateIndex = scoreType === 'piano' && tone.isMainPlaybackEntry !== false
        ? indexByMidiAndOffset.get(timingKey)
        : undefined
      if (duplicateIndex !== undefined) {
        clean[duplicateIndex].durationSeconds = Math.max(
          clean[duplicateIndex].durationSeconds,
          tone.durationSeconds,
        )
        continue
      }
      const cleanTone: PlaybackTone = {
        midi: tone.midi,
        durationSeconds: tone.durationSeconds,
        startOffsetSeconds: tone.startOffsetSeconds,
        isGrace: tone.isGrace,
        isMainPlaybackEntry: tone.isMainPlaybackEntry,
        isArpeggiated: tone.isArpeggiated,
        suppressPlayback: tone.suppressPlayback,
      }
      if (scoreType === 'piano' && tone.isMainPlaybackEntry !== false) {
        indexByMidiAndOffset.set(timingKey, clean.length)
      }
      clean.push(cleanTone)
    }
    event.notes = clean
  }

  cursor.reset()
  return events
}

/** Cross-check OSMD's renderer timeline against the canonical source-measure order. */
function validatePlaybackTimelineAgainstCanonicalModel(
  events: PlaybackTimelineEvent[],
  model: CanonicalMusicXmlData,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const invalidIndexes = events.filter(event => event.measureIndex < 0 || event.measureIndex >= model.measures.length)
  if (invalidIndexes.length > 0) errors.push(`${invalidIndexes.length} 個 OSMD 時間軸事件無法映射到標準源小節索引。`)
  const timelineMeasures = new Set(events.filter(event => event.measureIndex >= 0).map(event => event.measureIndex))
  const missing = model.measures.filter(measure => !timelineMeasures.has(measure.sourceIndex) && measure.notes.some(note => !note.isRest && note.midi !== null))
  if (missing.length > 0) warnings.push(`有 ${missing.length} 個含可演奏音符的源小節未出現在 OSMD 時間軸。`)
  for (const event of events) {
    if (event.measureIndex >= 0) {
      const canonicalMeasure = model.measures[event.measureIndex]
      event.printedMeasureNumber = canonicalMeasure?.printedNumber
      const normalizeMeasureLabel = (value: string) => {
        const numeric = Number(value)
        return value.trim() !== '' && Number.isFinite(numeric) ? `#${numeric}` : value.trim()
      }
      if (canonicalMeasure && event.sourceMeasureXmlNumber && normalizeMeasureLabel(event.sourceMeasureXmlNumber) !== normalizeMeasureLabel(canonicalMeasure.printedNumber)) {
        const uniqueMatches = model.measures.filter(measure => normalizeMeasureLabel(measure.printedNumber) === normalizeMeasureLabel(event.sourceMeasureXmlNumber!))
        const message = `OSMD 源小節編號 ${event.sourceMeasureXmlNumber} 對應內部索引 ${event.measureIndex + 1}（標準模型編號 ${canonicalMeasure.printedNumber}）。`
        if (uniqueMatches.length === 1 && uniqueMatches[0].sourceIndex !== event.measureIndex) errors.push(message)
        else warnings.push(`${message}顯示編號可能存在重復或格式差異。`)
      }
    }
  }
  return { errors, warnings }
}

/** Use the canonical model as the single source for measure-indexed time signatures. */
function parseMusicXmlMeterMap(xmlText: string): Map<number, ScoreMeter> {
  const result = new Map<number, ScoreMeter>()
  try {
    const model = getCanonicalMusicXmlData(xmlText)
    for (const measure of model.measures) {
      result.set(measure.sourceIndex, {
        beats: measure.meter.beats,
        beatType: measure.meter.beatType,
      })
    }
  } catch (error) {
    console.warn('[ScoreRoom] Could not parse time signature from canonical MusicXML model; using 4/4.', error)
  }
  if (result.size === 0) result.set(0, { beats: 4, beatType: 4 })
  return result
}

/**
 * Build a quarter/denominator-beat grid from the same source-measure timeline used by playback.
 * Beat timing is inferred from OSMD event timestamps and each event's current BPM. If a score
 * has unusual tempo changes inside a beat, the grid is intentionally treated as a practice aid,
 * not a source of authoritative timing.
 */
function buildMetronomeBeatTimeline(
  events: PlaybackTimelineEvent[],
  meters: Map<number, ScoreMeter>,
  subdivisionsPerBeat: 1 | 2 | 4 = 1,
): MetronomeBeat[] {
  const grouped = new Map<number, PlaybackTimelineEvent[]>()
  for (const event of events) {
    if (!Number.isInteger(event.measureIndex) || event.measureIndex < 0) continue
    const group = grouped.get(event.measureIndex) ?? []
    group.push(event)
    grouped.set(event.measureIndex, group)
  }
  const measures = [...grouped.entries()].map(([measureIndex, measureEvents]) => {
    const sorted = [...measureEvents].sort((a, b) => a.positionQuarter - b.positionQuarter || a.time - b.time)
    const first = sorted[0]
    const zeroAnchor = sorted.find(item => Math.abs(item.positionQuarter) < 0.015)
    const startTime = zeroAnchor
      ? zeroAnchor.time
      : first.time - first.positionQuarter * 60 / Math.max(30, first.bpm || 80)
    return { measureIndex, events: sorted, startTime, firstBpm: Math.max(30, first.bpm || 80) }
  }).sort((a, b) => a.measureIndex - b.measureIndex || a.startTime - b.startTime)

  const beats: MetronomeBeat[] = []
  measures.forEach((measure, measureOrder) => {
    const meter = meters.get(measure.measureIndex) ?? { beats: 4, beatType: 4 }
    const beatType = Number.isFinite(meter.beatType) && meter.beatType > 0 ? meter.beatType : 4
    const beatCount = Number.isFinite(meter.beats) && meter.beats > 0 ? Math.min(32, meter.beats) : 4
    const beatQuarterLength = 4 / beatType
    const nextMeasure = measures[measureOrder + 1]
    const nextMeasureStart = nextMeasure && nextMeasure.startTime > measure.startTime + 0.001
      ? nextMeasure.startTime
      : Number.POSITIVE_INFINITY

    const divisionCount: 1 | 2 | 4 = subdivisionsPerBeat === 4 ? 4 : subdivisionsPerBeat === 2 ? 2 : 1
    const compound = beatType === 8 && beatCount >= 6 && beatCount % 3 === 0
    for (let pulse = 0; pulse < beatCount * divisionCount; pulse++) {
      const beatNumber = Math.floor(pulse / divisionCount)
      const subdivisionIndex = pulse % divisionCount
      const quarterPosition = (beatNumber + subdivisionIndex / divisionCount) * beatQuarterLength
      const near = measure.events.find(item => Math.abs(item.positionQuarter - quarterPosition) < 0.015)
      const previous = [...measure.events].reverse().find(item => item.positionQuarter <= quarterPosition + 0.001)
      const bpm = Math.max(30, previous?.bpm ?? measure.firstBpm)
      const beatTime = near
        ? near.time
        : previous
          ? previous.time + (quarterPosition - previous.positionQuarter) * 60 / bpm
          : measure.startTime + quarterPosition * 60 / measure.firstBpm
      if (!Number.isFinite(beatTime) || beatTime < -0.001 || beatTime >= nextMeasureStart - 0.025) continue
      // Strong downbeat, secondary grouping accent (beat 3 in common time, or
      // compound-meter group starts), then ordinary beats. Subdivisions stay softer.
      const isSubdivision = subdivisionIndex > 0
      const accent = !isSubdivision && beatNumber === 0
      const secondaryAccent = !isSubdivision && (compound
        ? beatNumber > 0 && beatNumber % 3 === 0
        : beatCount >= 4 && beatNumber === 2)
      beats.push({
        time: Math.max(0, beatTime),
        accent,
        secondaryAccent,
        subdivision: isSubdivision,
        measureIndex: measure.measureIndex,
      })
    }
  })

  beats.sort((a, b) => a.time - b.time)
  const deduplicated: MetronomeBeat[] = []
  for (const beat of beats) {
    const previous = deduplicated[deduplicated.length - 1]
    if (previous && Math.abs(previous.time - beat.time) < 0.012) {
      const priority = (item: MetronomeBeat) => item.accent ? 3 : item.secondaryAccent ? 2 : item.subdivision ? 0 : 1
      if (priority(beat) > priority(previous)) deduplicated[deduplicated.length - 1] = { ...beat, time: previous.time }
      continue
    }
    deduplicated.push(beat)
  }
  return deduplicated
}

/**
 * Estimate each source measure's musical end in score-time seconds. Guitar playback uses
 * this boundary as a pedal-like sustain window: samples decay naturally through the bar,
 * then any remaining gain is released at the next barline. Prefer a zero-position event as the bar anchor;
 * when a measure begins with rests, extrapolate from its first event and local tempo.
 */
function buildMeasureEndTimeMap(
  events: PlaybackTimelineEvent[],
  meters: Map<number, ScoreMeter>,
): Map<number, number> {
  const groups = new Map<number, PlaybackTimelineEvent[]>()
  for (const event of events) {
    if (!Number.isInteger(event.measureIndex) || event.measureIndex < 0) continue
    const group = groups.get(event.measureIndex) ?? []
    group.push(event)
    groups.set(event.measureIndex, group)
  }

  const measures = [...groups.entries()].map(([measureIndex, measureEvents]) => {
    const ordered = [...measureEvents].sort((a, b) =>
      a.positionQuarter - b.positionQuarter || a.time - b.time,
    )
    const anchor = ordered.find(event => Math.abs(event.positionQuarter) < 0.015) ?? ordered[0]
    const bpm = Math.max(30, Number(anchor?.bpm) || 80)
    const position = Math.max(0, Number(anchor?.positionQuarter) || 0)
    const startTime = Math.max(0, (Number(anchor?.time) || 0) - position * 60 / bpm)
    return { measureIndex, startTime, bpm }
  }).sort((a, b) => a.startTime - b.startTime || a.measureIndex - b.measureIndex)

  const ends = new Map<number, number>()
  for (let index = 0; index < measures.length; index++) {
    const measure = measures[index]
    const next = measures[index + 1]
    let endTime: number
    if (next && next.startTime > measure.startTime + 0.03) {
      endTime = next.startTime
    } else {
      const meter = meters.get(measure.measureIndex) ?? { beats: 4, beatType: 4 }
      const beatCount = Number.isFinite(meter.beats) && meter.beats > 0 ? meter.beats : 4
      const beatType = Number.isFinite(meter.beatType) && meter.beatType > 0 ? meter.beatType : 4
      endTime = measure.startTime + (beatCount * 4 / beatType) * 60 / measure.bpm
    }
    ends.set(measure.measureIndex, Math.max(measure.startTime + 0.04, endTime))
  }
  return ends
}

function formatPlaybackTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

type ChordFrameNote = {
  stringNumber: number
  fret: number
  barre: string[]
  /** Explicitly muted string from a negative MusicXML frame fret. */
  muted: boolean
}

type ChordFrameData = {
  strings: number
  frets: number
  firstFret: number
  notes: ChordFrameNote[]
}


type BrushDirection = 'up' | 'down'

type GuitarLegatoArticulation = 'hammer-on' | 'pull-off'

type BrushFretNote = {
  stringNumber: number
  fret: number
  /** Pitched MIDI note from the same MusicXML note, for matching audio voices safely. */
  midi?: number
  /** Legato articulation applied to this destination note. */
  articulation?: GuitarLegatoArticulation
  /** Non-standard Guitar Pro percussion/technique tags such as slap, pop, tap or palm mute. */
  techniques?: string[]
  /** Explicit x/cross notehead or negative fret used for a muted/percussive TAB attack. */
  isPercussive?: boolean
}

type BrushNoteEvent = {
  direction: BrushDirection | null
  measureNumber: string
  /** Zero-based source-measure order, independent of displayed measure labels. */
  measureIndex: number
  /** Quarter-note onset within the measure, calculated from MusicXML divisions/backup/forward. */
  positionQuarter: number
  /** Exact event duration in quarter-note units, used for rhythmic measure grouping. */
  durationQuarter: number
  noteType: string
  /** MusicXML augmentation dots on the source note or chord. */
  dots: number
  fretNotes: BrushFretNote[]
  /** Custom guitar techniques which OSMD may not engrave (slap/pop/tap/golpe). */
  techniques: string[]
  /** String numbers attached to technique-only events, e.g. muted slide-ins/slide-outs. */
  techniqueStringNumbers: number[]
  /** Whole notes have no native staff stem, but still need a TAB duration stem. */
  hasNativeStem: boolean
}

// Anchored chord-symbol grammar: avoids treating lyric text like 'Amazing' as Am.
// Supports common MusicXML labels such as C, Am7, F#dim, G(11), D7(omit 5), and C/E.
const CHORD_SYMBOL_PATTERN = /^[A-G](?:#|b|♯|♭)?(?:(?:maj|min|m|dim|aug|sus|add|M|Δ|ø|°)?\d*)?(?:\([^)]*\))?(?:\/[A-G](?:#|b|♯|♭)?)?$/

function directChildren(element: Element, name: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.localName === name,
  )
}


type MusicXmlPerformanceMark = {
  kind: 'dynamic' | 'pedal' | 'wedge'
  measureIndex: number
  positionQuarter: number
  order: number
  value?: number
  action?: 'on' | 'off' | 'change'
  wedgeType?: 'crescendo' | 'diminuendo' | 'stop'
  number?: string
}

type MappedPerformanceMark = MusicXmlPerformanceMark & { time: number }

/** Read normalized dynamics, wedges and pedal marks from the canonical MusicXML model. */
function parseMusicXmlPerformanceMarks(xmlText: string): MusicXmlPerformanceMark[] {
  try {
    return getCanonicalMusicXmlData(xmlText).performanceMarks.map(mark => ({ ...mark }))
  } catch (error) {
    console.warn('[ScoreRoom] Could not read canonical MusicXML performance marks:', error)
    return []
  }
}

function applyMusicXmlPerformanceMarksToTimeline(
  events: PlaybackTimelineEvent[],
  xmlText: string,
): { dynamicsCount: number; pedalCount: number; wedgeCount: number; mappedCount: number } {
  for (const event of events) {
    event.dynamicLevel = 78
    event.pedalDown = false
    event.pedalReleaseTime = null
  }
  const marks = parseMusicXmlPerformanceMarks(xmlText)
  const mapped: MappedPerformanceMark[] = []
  for (const mark of marks) {
    const inMeasure = events.filter(event => event.measureIndex === mark.measureIndex)
    let target = inMeasure.find(event => event.positionQuarter >= mark.positionQuarter - 0.015)
    if (!target) target = events.find(event => event.measureIndex > mark.measureIndex)
    // A direction after the final playable event cannot affect any note; exclude it.
    if (target) mapped.push({ ...mark, time: target.time })
  }
  mapped.sort((a, b) => a.time - b.time || a.order - b.order)

  const dynamicMarks = mapped.filter((mark): mark is MappedPerformanceMark & { value: number } => mark.kind === 'dynamic' && typeof mark.value === 'number')
  const wedgeMarks = mapped.filter(mark => mark.kind === 'wedge')
  const wedgeStarts = new Map<string, MappedPerformanceMark>()
  const wedgeSpans: Array<{ start: number; end: number; type: 'crescendo' | 'diminuendo'; number: string }> = []
  for (const mark of wedgeMarks) {
    const number = mark.number || '1'
    if (mark.wedgeType === 'crescendo' || mark.wedgeType === 'diminuendo') {
      wedgeStarts.set(number, mark)
    } else if (mark.wedgeType === 'stop') {
      const start = wedgeStarts.get(number) ?? [...wedgeStarts.values()].sort((a, b) => a.time - b.time)[0]
      if (start && mark.time > start.time + 0.02 && start.wedgeType) {
        wedgeSpans.push({ start: start.time, end: mark.time, type: start.wedgeType as 'crescendo' | 'diminuendo', number })
        wedgeStarts.delete(number)
      }
    }
  }

  let dynamicIndex = 0
  let currentLevel = 78
  for (const event of events) {
    while (dynamicIndex < dynamicMarks.length && dynamicMarks[dynamicIndex].time <= event.time + 0.001) {
      currentLevel = dynamicMarks[dynamicIndex].value
      dynamicIndex += 1
    }
    let level = currentLevel
    const span = wedgeSpans.find(item => event.time >= item.start && event.time <= item.end)
    if (span) {
      const explicitEnd = dynamicMarks.find(mark => mark.time > span.start + 0.001 && mark.time <= span.end + 0.001)
      const priorDynamicMarks = dynamicMarks.filter(mark => mark.time <= span.start + 0.001)
      const startLevel = priorDynamicMarks.length > 0 ? priorDynamicMarks[priorDynamicMarks.length - 1].value : 78
      const endLevel = explicitEnd?.value ?? Math.max(22, Math.min(120, startLevel + (span.type === 'crescendo' ? 18 : -18)))
      const progress = Math.max(0, Math.min(1, (event.time - span.start) / Math.max(0.001, span.end - span.start)))
      level = startLevel + (endLevel - startLevel) * progress
    }
    event.dynamicLevel = Math.max(18, Math.min(120, Math.round(level)))
  }

  const pedalMarks = mapped.filter(mark => mark.kind === 'pedal' && mark.action).sort((a, b) => a.time - b.time || a.order - b.order)
  let pedalIndex = 0
  let pedalDown = false
  for (const event of events) {
    while (pedalIndex < pedalMarks.length && pedalMarks[pedalIndex].time <= event.time + 0.001) {
      const mark = pedalMarks[pedalIndex]
      if (mark.action === 'on') pedalDown = true
      else if (mark.action === 'off') pedalDown = false
      else if (mark.action === 'change') pedalDown = true
      pedalIndex += 1
    }
    event.pedalDown = pedalDown
    event.pedalReleaseTime = pedalDown
      ? (pedalMarks.find(mark => mark.action === 'off' && mark.time > event.time + 0.001)?.time ?? null)
      : null
  }

  return {
    dynamicsCount: marks.filter(mark => mark.kind === 'dynamic').length,
    pedalCount: marks.filter(mark => mark.kind === 'pedal').length,
    wedgeCount: marks.filter(mark => mark.kind === 'wedge').length,
    mappedCount: mapped.length,
  }
}

function dynamicGainMultiplier(dynamicLevel: number): number {
  const safeLevel = Math.max(18, Math.min(120, Number.isFinite(dynamicLevel) ? dynamicLevel : 78))
  return Math.max(0.22, Math.min(1.65, Math.pow(safeLevel / 78, 1.5)))
}

function theoryPitchClassFromName(name: string): number | null {
  const match = /^\s*([A-G])([#b♯♭𝄪𝄫]*)/.exec(name)
  if (!match) return null
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  let alter = 0
  for (const glyph of match[2]) {
    if (glyph === '#' || glyph === '♯') alter += 1
    else if (glyph === 'b' || glyph === '♭') alter -= 1
    else if (glyph === '𝄪') alter += 2
    else if (glyph === '𝄫') alter -= 2
  }
  return ((base[match[1]] + alter) % 12 + 12) % 12
}


type TheoryNoteInfo = {
  midi: number
  pitchClass: number
  step: string
  alter: number
  octave: number
  name: string
  onsetQuarter: number
  durationQuarter: number
  staff: string
  voice: string
  isGrace: boolean
  isTieContinuation: boolean
}

type TheoryRhythmEvent = {
  onsetQuarter: number
  durationQuarter: number
  isRest: boolean
  isGrace: boolean
  voice: string
}

type TheoryMelodyInterval = {
  fromName: string
  toName: string
  semitones: number
  direction: '上行' | '下行' | '重復音'
  label: string
}

type TheoryChordCandidate = {
  key: string
  symbol: string
  rootName: string
  rootPc: number
  quality: string
  qualityLabel: string
  roman: string
  toneNames: string[]
  score: number
  coverage: number
  coreComplete: boolean
  bassRelation: '根音匹配' | '和弦內低音' | '低音與候選結構不符'
  evidenceSummary: string[]
}

type TheoryChordInfo = {
  onsetQuarter: number
  symbol: string
  rootName: string
  rootPc: number
  quality: string
  qualityLabel: string
  roman: string
  toneNames: string[]
  actualNotes: string[]
  bassName: string
  confidence: '較明確' | '推測' | '樂譜標記' | '人工校正'
  evidenceSource?: '原譜和弦標記' | '局部音符推斷' | '整小節推斷' | '人工校正'
  evidenceSummary?: string[]
  matchingScore?: number
  scoreMargin?: number
  candidateDetails?: TheoryChordCandidate[]
  /** Original automatic result, retained when the learner applies a manual correction. */
  automaticSymbol?: string
  alternatives?: string[]
}

function theoryCorrectionStorageKey(fileUrl: string): string {
  return `scoreroom:theory-chord-corrections:v1:${fileUrl}`
}

function theoryCorrectionId(sourceIndex: number, onsetQuarter: number): string {
  return `${sourceIndex}:${Math.round(onsetQuarter * 10000) / 10000}`
}

type TheoryNonChordHint = {
  noteName: string
  onsetQuarter: number
  label: string
  explanation: string
}

type TheoryMeasureInfo = {
  sourceIndex: number
  printedNumber: string
  notes: TheoryNoteInfo[]
  chords: TheoryChordInfo[]
  primaryChord: TheoryChordInfo | null
  bassName: string
  bassMidi: number | null
  melodyTrend: string
  melodyContour: string
  melodyRange: string
  melodyIntervals: TheoryMelodyInterval[]
  rhythmSummary: string
  rhythmPattern: string[]
  keyName: string
  keySource: string
  keyTonicPc: number
  keyMode: 'major' | 'minor'
  harmonicFunction: string
  cadenceHint: string | null
  nonChordHints: TheoryNonChordHint[]
  meter: string
}

type ScoreTheoryAnalysis = {
  title: string
  composer: string
  keyName: string
  keySource: string
  meter: string
  tempo: number | null
  partNames: string[]
  measures: TheoryMeasureInfo[]
}

type ChordTemplate = {
  quality: string
  suffix: string
  label: string
  intervals: number[]
  romanSuffix: string
}

type TheoryExplicitHarmony = {
  onsetQuarter: number
  symbol: string
  rootPc: number
  quality: string
  rootName: string
  bassPc?: number
  bassName?: string
}

const THEORY_CHORD_TEMPLATES: ChordTemplate[] = [
  { quality: 'maj', suffix: '', label: '大三和弦', intervals: [0, 4, 7], romanSuffix: '' },
  { quality: 'min', suffix: 'm', label: '小三和弦', intervals: [0, 3, 7], romanSuffix: '' },
  { quality: 'dim', suffix: 'dim', label: '減三和弦', intervals: [0, 3, 6], romanSuffix: '°' },
  { quality: 'aug', suffix: 'aug', label: '增三和弦', intervals: [0, 4, 8], romanSuffix: '+' },
  { quality: 'sus2', suffix: 'sus2', label: '掛二和弦', intervals: [0, 2, 7], romanSuffix: 'sus2' },
  { quality: 'sus4', suffix: 'sus4', label: '掛四和弦', intervals: [0, 5, 7], romanSuffix: 'sus4' },
  { quality: '6', suffix: '6', label: '大六和弦', intervals: [0, 4, 7, 9], romanSuffix: '6' },
  { quality: 'm6', suffix: 'm6', label: '小六和弦', intervals: [0, 3, 7, 9], romanSuffix: '6' },
  { quality: '7', suffix: '7', label: '屬七和弦', intervals: [0, 4, 7, 10], romanSuffix: '7' },
  { quality: 'maj7', suffix: 'maj7', label: '大七和弦', intervals: [0, 4, 7, 11], romanSuffix: 'maj7' },
  { quality: 'min7', suffix: 'm7', label: '小七和弦', intervals: [0, 3, 7, 10], romanSuffix: '7' },
  { quality: 'minMaj7', suffix: 'm(maj7)', label: '小大七和弦', intervals: [0, 3, 7, 11], romanSuffix: 'maj7' },
  { quality: 'm7b5', suffix: 'm7♭5', label: '半減七和弦', intervals: [0, 3, 6, 10], romanSuffix: 'ø7' },
  { quality: 'dim7', suffix: 'dim7', label: '減七和弦', intervals: [0, 3, 6, 9], romanSuffix: '°7' },
  { quality: 'add9', suffix: 'add9', label: '加九和弦', intervals: [0, 2, 4, 7], romanSuffix: 'add9' },
  { quality: 'maj9', suffix: 'maj9', label: '大九和弦', intervals: [0, 2, 4, 7, 11], romanSuffix: 'maj9' },
  { quality: 'min9', suffix: 'm9', label: '小九和弦', intervals: [0, 2, 3, 7, 10], romanSuffix: '9' },
  { quality: '9', suffix: '9', label: '屬九和弦', intervals: [0, 2, 4, 7, 10], romanSuffix: '9' },
]

const THEORY_PC_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const THEORY_PC_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']
const THEORY_STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const THEORY_MAJOR_KEYS = ['C♭大調', 'G♭大調', 'D♭大調', 'A♭大調', 'E♭大調', 'B♭大調', 'F大調', 'C大調', 'G大調', 'D大調', 'A大調', 'E大調', 'B大調', 'F♯大調', 'C♯大調']
const THEORY_MINOR_KEYS = ['A♭小調', 'E♭小調', 'B♭小調', 'F小調', 'C小調', 'G小調', 'D小調', 'A小調', 'E小調', 'B小調', 'F♯小調', 'C♯小調', 'G♯小調', 'D♯小調', 'A♯小調']

function theoryPitchName(step: string, alter: number, octave?: number): string {
  const accidental = alter === -2 ? '𝄫' : alter === -1 ? '♭' : alter === 1 ? '♯' : alter === 2 ? '𝄪' : ''
  return `${step}${accidental}${octave === undefined ? '' : octave}`
}

function theoryPcName(pc: number, preferFlats: boolean): string {
  const safePc = ((Math.round(pc) % 12) + 12) % 12
  return (preferFlats ? THEORY_PC_FLAT : THEORY_PC_SHARP)[safePc]
}

function theoryKeyFromFifths(fifths: number, mode: string): { label: string; tonicPc: number; mode: 'major' | 'minor'; preferFlats: boolean } {
  const safeFifths = Math.max(-7, Math.min(7, Math.round(fifths)))
  const idx = safeFifths + 7
  const isMinor = mode.toLowerCase() === 'minor'
  const label = (isMinor ? THEORY_MINOR_KEYS : THEORY_MAJOR_KEYS)[idx]
  const tonicPc = isMinor
    ? (([8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10][idx]) ?? 0)
    : (([11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1][idx]) ?? 0)
  return { label, tonicPc, mode: isMinor ? 'minor' : 'major', preferFlats: safeFifths < 0 }
}

function theoryRomanNumeral(rootPc: number, quality: string, tonicPc: number, mode: 'major' | 'minor'): string {
  const scale = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]
  const degree = scale.indexOf(((rootPc - tonicPc + 12) % 12))
  if (degree < 0) return '非調內'
  const bases = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
  let base = bases[degree]
  if (quality === 'min' || quality === 'min7' || quality === 'minMaj7' || quality === 'm6' || quality === 'min9' || quality === 'm7b5' || quality === 'dim' || quality === 'dim7') {
    base = base.toLowerCase()
  }
  const template = THEORY_CHORD_TEMPLATES.find(item => item.quality === quality)
  return `${base}${template?.romanSuffix ?? ''}`
}

function theorySpellingForPitchClass(
  pitchClass: number,
  sourceNotes: TheoryNoteInfo[],
  preferFlats: boolean,
): { step: string; alter: number; name: string } {
  const normalizedPc = ((Math.round(pitchClass) % 12) + 12) % 12
  const weights = new Map<string, { step: string; alter: number; weight: number }>()
  for (const note of sourceNotes) {
    if (note.isGrace || note.pitchClass !== normalizedPc || !Number.isInteger(note.alter)) continue
    const key = `${note.step}:${note.alter}`
    const durationWeight = Math.max(0.2, Math.min(2, note.durationQuarter || 0.25))
    const registerWeight = (note.staff === '2' ? 1.18 : 1) * (note.midi < 60 ? 1.1 : 1)
    const spellingPreference = preferFlats && note.alter < 0 ? 0.12 : (!preferFlats && note.alter > 0 ? 0.08 : 0)
    const entry = weights.get(key) ?? { step: note.step, alter: note.alter, weight: 0 }
    entry.weight += durationWeight * registerWeight + spellingPreference
    weights.set(key, entry)
  }
  const best = [...weights.values()].sort((a, b) => b.weight - a.weight)[0]
  if (best) return { step: best.step, alter: best.alter, name: theoryPitchName(best.step, best.alter) }

  const fallback = theoryPcName(normalizedPc, preferFlats)
  const match = /^([A-G])([♯♭]*)$/.exec(fallback)!
  const alter = (match[2].match(/♯/g)?.length ?? 0) - (match[2].match(/♭/g)?.length ?? 0)
  return { step: match[1], alter, name: theoryPitchName(match[1], alter) }
}

function theoryChordToneNamesFromSpelling(
  rootPc: number,
  rootStep: string,
  intervals: number[],
): string[] {
  const letterNames = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
  const rootLetterIndex = Math.max(0, letterNames.indexOf(rootStep))
  const degreeForInterval: Record<number, number> = {
    0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4,
    7: 4, 8: 4, 9: 5, 10: 6, 11: 6,
  }
  return intervals.map(interval => {
    const degree = degreeForInterval[((interval % 12) + 12) % 12] ?? 0
    const step = letterNames[(rootLetterIndex + degree) % 7]
    const naturalPc = THEORY_STEP_PC[step]
    const targetPc = ((Math.round(rootPc + interval) % 12) + 12) % 12
    let alter = ((targetPc - naturalPc + 6) % 12 + 12) % 12 - 6
    // Spell intervals with the expected diatonic letter; in conventional triads this
    // resolves to at most double accidentals and avoids respelling Eb as D# in C minor.
    if (alter > 2) alter -= 12
    if (alter < -2) alter += 12
    return theoryPitchName(step, alter)
  })
}

function theoryChordForPitchEvidence(
  evidence: Map<number, number>,
  bassPc: number,
  key: { tonicPc: number; mode: 'major' | 'minor'; preferFlats: boolean },
  previous?: { rootPc: number; quality: string } | null,
  sourceNotes: TheoryNoteInfo[] = [],
  bassNameHint?: string,
): { rootPc: number; rootName: string; quality: string; symbol: string; label: string; toneNames: string[]; roman: string; confidence: '較明確' | '推測'; alternatives: string[]; matchingScore: number; scoreMargin: number; evidenceSummary: string[]; candidateDetails: TheoryChordCandidate[] } | null {
  const weights = new Map<number, number>()
  for (const [rawPc, rawWeight] of evidence.entries()) {
    const roundedPc = Math.round(rawPc)
    if (Math.abs(rawPc - roundedPc) > 0.001) continue // Equal-tempered templates cannot reliably label microtones.
    const pc = ((roundedPc % 12) + 12) % 12
    const weight = Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0
    if (weight > 0) weights.set(pc, Math.min(3.5, (weights.get(pc) ?? 0) + weight))
  }
  // A two-pitch dyad usually does not contain enough information to distinguish a chord
  // from an interval, a passing note, or an incomplete voicing. Prefer no answer over a
  // confidently misleading chord name.
  if (weights.size < 3) return null

  const totalWeight = Array.from(weights.values()).reduce((sum, value) => sum + value, 0) || 1
  const scale = key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]
  const diatonicQualities = key.mode === 'major'
    ? ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim']
    : ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj']

  const getThirdInterval = (quality: string): number => {
    if (quality === 'sus2') return 2
    if (quality === 'sus4') return 5
    if (['min', 'm6', 'min7', 'minMaj7', 'min9', 'm7b5', 'dim', 'dim7'].includes(quality)) return 3
    return 4
  }
  const getFifthInterval = (quality: string): number => {
    if (['dim', 'dim7', 'm7b5'].includes(quality)) return 6
    if (quality === 'aug') return 8
    return 7
  }
  const candidates: Array<{
    score: number
    rootPc: number
    template: ChordTemplate
    coverage: number
    coreComplete: boolean
    extraClasses: number
    extraWeight: number
    matchedWeight: number
    missingExtensions: number
  }> = []

  for (let rootPc = 0; rootPc < 12; rootPc++) {
    for (const template of THEORY_CHORD_TEMPLATES) {
      const chordPcs = new Set(template.intervals.map(interval => (rootPc + interval) % 12))
      const rootWeight = weights.get(rootPc) ?? 0
      const thirdPc = (rootPc + getThirdInterval(template.quality)) % 12
      const fifthPc = (rootPc + getFifthInterval(template.quality)) % 12
      const thirdWeight = weights.get(thirdPc) ?? 0
      const fifthWeight = weights.get(fifthPc) ?? 0
      const matchedWeight = Array.from(chordPcs).reduce((sum, pc) => sum + (weights.get(pc) ?? 0), 0)
      const extraEntries = Array.from(weights.entries()).filter(([pc]) => !chordPcs.has(pc))
      const extraWeight = extraEntries.reduce((sum, [, weight]) => sum + weight, 0)
      const extraClasses = extraEntries.length
      const rootPresent = rootWeight > 0.01
      const thirdPresent = thirdWeight > 0.01
      const fifthPresent = fifthWeight > 0.01
      const coverage = matchedWeight / totalWeight
      const corePcs = new Set([rootPc, thirdPc, fifthPc])
      const extensionIntervals = template.intervals.filter(interval => !corePcs.has((rootPc + interval) % 12))
      // Require an extension to have meaningful evidence relative to the triad tones.
      // A faint passing note should not create a false add9/7/9 label.
      const coreMeanWeight = (rootWeight + thirdWeight + fifthWeight) / 3
      const extensionPresenceThreshold = Math.max(0.38, coreMeanWeight * 0.24)
      const extensionWeights = extensionIntervals.map(interval => weights.get((rootPc + interval) % 12) ?? 0)
      const extensionWeight = extensionWeights.reduce((sum, weight) => sum + (weight >= extensionPresenceThreshold ? weight : 0), 0)
      const missingExtensions = extensionWeights.filter(weight => weight < extensionPresenceThreshold).length

      let score = 0
      score += rootPresent ? 2.0 : -0.65
      score += thirdPresent ? 1.75 : -0.80
      score += fifthPresent ? 1.05 : -0.36
      score += Math.min(0.85, extensionWeight * 0.43)
      score -= missingExtensions * 0.86
      score -= Math.min(1.75, extraWeight * 0.40)
      score += Math.min(0.40, matchedWeight * 0.035)

      if (bassPc === rootPc) score += 0.85
      else if (chordPcs.has(bassPc)) score += 0.18
      else score -= 0.50

      const degree = scale.indexOf((rootPc - key.tonicPc + 12) % 12)
      if (degree >= 0) {
        const expected = diatonicQualities[degree]
        if (template.quality === expected && extraWeight <= 0.65) score += 0.30
        else if (['maj', 'min', 'dim'].includes(template.quality) && extraWeight <= 0.65) score -= 0.08
      } else {
        score -= 0.10
      }
      // Continuity is only a tie-breaker. It must not make an unsupported chord persist
      // across a genuine change in bass or pitch evidence.
      if (previous?.rootPc === rootPc && previous.quality === template.quality) score += 0.12

      candidates.push({ score, rootPc, template, coverage, coreComplete: rootPresent && thirdPresent && fifthPresent, extraClasses, extraWeight, matchedWeight, missingExtensions })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best || best.score < 3.05) return null
  const distinctCandidates = candidates.filter((item, index, all) => all.findIndex(other => other.rootPc === item.rootPc && other.template.quality === item.template.quality) === index)
  const runnerUp = distinctCandidates.find(item => item.rootPc !== best.rootPc || item.template.quality !== best.template.quality)
  const margin = best.score - (runnerUp?.score ?? 0)
  const bestChordPcs = new Set(best.template.intervals.map(interval => (best.rootPc + interval) % 12))
  const bassMatchesRoot = bassPc === best.rootPc
  const bassIsChordTone = bestChordPcs.has(bassPc)
  // Confidence is intentionally conservative: the score is heuristic, not a probability.
  // Inferred labels are promoted only when core tones, overall coverage, bass and runner-up
  // separation agree. A high raw template score alone is not enough.
  const confidence: '較明確' | '推測' =
    best.coreComplete && best.missingExtensions === 0 && best.coverage >= 0.82 &&
    best.extraClasses <= 1 && best.extraWeight <= 0.48 && margin >= 0.82 &&
    best.score >= 3.8 && weights.size >= 3 && bassIsChordTone
      ? '較明確'
      : '推測'

  const rootSpelling = theorySpellingForPitchClass(best.rootPc, sourceNotes, key.preferFlats)
  const rootName = rootSpelling.name
  const toneNames = theoryChordToneNamesFromSpelling(best.rootPc, rootSpelling.step, best.template.intervals)
  const template = best.template
  const bassName = bassNameHint || theorySpellingForPitchClass(bassPc, sourceNotes, key.preferFlats).name
  const inversionSuffix = bassPc !== best.rootPc && template.intervals.some(interval => (best.rootPc + interval) % 12 === bassPc)
    ? `/${bassName}` : ''

  // Expose a small, ranked candidate set rather than only a single guess. Scores are
  // explainable template-fit values and must never be interpreted as probabilities.
  const candidateDetails: TheoryChordCandidate[] = distinctCandidates
    .filter(item => item.score >= best.score - 1.65 && item.score >= 2.65)
    .slice(0, 5)
    .map(item => {
      const spelling = theorySpellingForPitchClass(item.rootPc, sourceNotes, key.preferFlats)
      const itemTemplate = item.template
      const itemPcs = new Set(itemTemplate.intervals.map(interval => (item.rootPc + interval) % 12))
      const itemBassRelation: TheoryChordCandidate['bassRelation'] = bassPc === item.rootPc
        ? '根音匹配'
        : itemPcs.has(bassPc) ? '和弦內低音' : '低音與候選結構不符'
      const slash = bassPc !== item.rootPc && itemPcs.has(bassPc) ? `/${bassName}` : ''
      const itemToneNames = theoryChordToneNamesFromSpelling(item.rootPc, spelling.step, itemTemplate.intervals)
      const coreIntervalThird = getThirdInterval(itemTemplate.quality)
      const coreIntervalFifth = getFifthInterval(itemTemplate.quality)
      const supportedCoreCount = [item.rootPc, (item.rootPc + coreIntervalThird) % 12, (item.rootPc + coreIntervalFifth) % 12]
        .filter(pc => (weights.get(pc) ?? 0) > 0.01).length
      const evidenceSummary = [
        `核心結構音支援 ${supportedCoreCount}/3`,
        `目前音高類別覆蓋 ${Math.round(item.coverage * 100)}%`,
        `低音關係：${itemBassRelation}`,
        item.extraClasses > 0 ? `候選和弦外音類 ${item.extraClasses} 個（權重 ${item.extraWeight.toFixed(2)}）` : '未檢測到候選和弦外音類',
      ]
      return {
        key: `${item.rootPc}:${itemTemplate.quality}`,
        symbol: `${spelling.name}${itemTemplate.suffix}${slash}`,
        rootName: spelling.name,
        rootPc: item.rootPc,
        quality: itemTemplate.quality,
        qualityLabel: itemTemplate.label,
        roman: theoryRomanNumeral(item.rootPc, itemTemplate.quality, key.tonicPc, key.mode),
        toneNames: itemToneNames,
        score: Math.round(item.score * 100) / 100,
        coverage: item.coverage,
        coreComplete: item.coreComplete,
        bassRelation: itemBassRelation,
        evidenceSummary,
      }
    })

  const evidenceSummary = [
    `核心結構音支援 ${[best.rootPc, (best.rootPc + getThirdInterval(template.quality)) % 12, (best.rootPc + getFifthInterval(template.quality)) % 12].filter(pc => (weights.get(pc) ?? 0) > 0.01).length}/3`,
    `目前音高類別覆蓋 ${Math.round(best.coverage * 100)}%`,
    `低音關係：${bassMatchesRoot ? '根音匹配' : bassIsChordTone ? '低音屬於候選和弦構成音' : '低音與候選和弦結構不符'}`,
    `最佳與次佳候選分差 ${margin.toFixed(2)}（啟發式匹配分，不是概率）`,
  ]
  const alternatives = confidence === '推測'
    ? candidateDetails
        .filter(item => item.key !== `${best.rootPc}:${best.template.quality}` && best.score - item.score <= 0.88)
        .slice(0, 3)
        .map(item => item.symbol)
    : []

  return {
    rootPc: best.rootPc,
    rootName,
    quality: template.quality,
    symbol: `${rootName}${template.suffix}${inversionSuffix}`,
    label: template.label,
    toneNames,
    roman: theoryRomanNumeral(best.rootPc, template.quality, key.tonicPc, key.mode),
    confidence,
    alternatives: Array.from(new Set(alternatives)),
    matchingScore: Math.round(best.score * 100) / 100,
    scoreMargin: Math.round(margin * 100) / 100,
    evidenceSummary,
    candidateDetails,
  }
}

/**
 * Lightweight, deterministic MusicXML theory analysis. It uses source note timing,
 * pitches and key signatures; it never alters the playback timeline or OSMD engraving.
 */
/**
 * A conservative, explainable function label. This is a key-relative interpretation,
 * not an absolute fact when the score's key itself is estimated or modulating.
 */
function theoryHarmonicFunction(
  chord: TheoryChordInfo | null,
  tonicPc: number,
  mode: 'major' | 'minor',
): string {
  if (!chord) return '和弦證據不足'
  const degree = ((chord.rootPc - tonicPc + 12) % 12)
  let role = ''
  if (degree === 0) role = mode === 'major' ? '主功能 T（Ⅰ級）' : '主功能 T（ⅰ級）'
  else if (degree === 5) role = mode === 'major' ? '下屬功能 S（Ⅳ級）' : '下屬功能 S（ⅳ級）'
  else if (degree === 7) {
    const weakened = mode === 'minor' && ['min', 'min7'].includes(chord.quality)
    role = weakened ? '弱屬功能 D（小屬和弦）' : '屬功能 D（Ⅴ級）'
  } else if (degree === 2) role = mode === 'major' ? '下屬功能延伸（Ⅱ級）' : '下屬功能延伸（ⅱ級）'
  else if (degree === 9) role = '主功能替代（Ⅵ/ⅵ級）'
  else if (degree === 11 && ['dim', 'dim7', 'm7b5'].includes(chord.quality)) role = '屬功能傾向（導音減和弦）'
  else if (degree === 4) role = '中介功能候選（Ⅲ/ⅲ級）'
  else if (mode === 'minor' && degree === 8) role = '下屬色彩候選（Ⅵ級）'
  else if (degree === 10) role = '降Ⅶ級／調式和弦候選'
  else role = '非調內或借用和弦候選'
  // Keep the functional hint useful even when chord recognition is tentative, but
  // visibly downgrade it so learners do not mistake a derived function for a fact.
  return chord.confidence === '推測' ? `${role} · 候選` : role
}

function theoryCadenceHint(
  from: TheoryChordInfo | null,
  to: TheoryChordInfo | null,
  tonicPc: number,
  mode: 'major' | 'minor',
): string | null {
  if (!from || !to) return null
  // Only report common root-motion patterns as *candidates*. A true cadence also
  // depends on phrase boundaries, voice-leading, rhythm, and metrical emphasis.
  const fromDegree = (from.rootPc - tonicPc + 12) % 12
  const toDegree = (to.rootPc - tonicPc + 12) % 12
  const fromStrong = ['maj', '7', '9'].includes(from.quality)
  const tonicName = mode === 'major' ? 'Ⅰ' : 'ⅰ'
  const relativeMinor = mode === 'major' ? 9 : 8
  if (fromDegree === 7 && toDegree === 0) {
    return fromStrong
      ? `正格終止候選：Ⅴ → ${tonicName}（需結合樂句結尾確認）`
      : `弱屬和弦 → 主和弦候選（終止感可能較弱）`
  }
  if (fromDegree === 5 && toDegree === 0) {
    return `變格終止候選：Ⅳ → ${tonicName}（需結合樂句結尾確認）`
  }
  if (fromDegree === 7 && toDegree === relativeMinor) {
    return mode === 'major'
      ? '阻礙終止候選：Ⅴ → Ⅵ（需結合樂句結尾確認）'
      : '屬和弦轉向Ⅵ級候選（需結合調性與樂句確認）'
  }
  if (toDegree === 7 && fromDegree !== 7) {
    return '進行到屬和弦：可能形成半終止（須確認此處是否為樂句結尾）'
  }
  return null
}

/**
 * Identify only conspicuous, stepwise melody notes outside the local chord tones.
 * The result deliberately says "候選"; automated analysis cannot reliably distinguish
 * every passing tone, suspension, anticipation, or expressive dissonance from notation alone.
 */
function addTheoryLearningAnnotations(measures: TheoryMeasureInfo[]): void {
  for (const measure of measures) {
    measure.harmonicFunction = theoryHarmonicFunction(
      measure.primaryChord,
      measure.keyTonicPc,
      measure.keyMode,
    )
    measure.cadenceHint = null
    measure.nonChordHints = []
  }

  for (let i = 1; i < measures.length; i++) {
    const previous = measures[i - 1]
    const current = measures[i]
    const previousTail = previous.chords[previous.chords.length - 1] ?? previous.primaryChord
    const currentHead = current.chords[0] ?? current.primaryChord
    current.cadenceHint = theoryCadenceHint(
      previousTail,
      currentHead,
      current.keyTonicPc,
      current.keyMode,
    )
  }

  type MelodyPoint = { measure: TheoryMeasureInfo; note: TheoryNoteInfo }
  const melodyPoints: MelodyPoint[] = []
  for (const measure of measures) {
    const melodyNotes = measure.notes
      .filter(note => note.staff === '1' && !note.isGrace && !note.isTieContinuation)
      .sort((a, b) => a.onsetQuarter - b.onsetQuarter || b.midi - a.midi)
    // Collapse simultaneous notes into a single representative melody note (the highest
    // note at that onset), so chord tones from the same attack do not become fake neighbors.
    const byOnset = new Map<number, TheoryNoteInfo>()
    for (const note of melodyNotes) {
      const key = Math.round(note.onsetQuarter * 10000) / 10000
      const existing = byOnset.get(key)
      if (!existing || note.midi > existing.midi) byOnset.set(key, note)
    }
    for (const note of [...byOnset.values()].sort((a, b) => a.onsetQuarter - b.onsetQuarter)) {
      melodyPoints.push({ measure, note })
    }
  }

  const chordAtMelodyPoint = (point: MelodyPoint): TheoryChordInfo | null =>
    point.measure.chords.filter(chord => chord.onsetQuarter <= point.note.onsetQuarter + 0.0001).slice(-1)[0]
      ?? point.measure.primaryChord
  const chordPitchClasses = (chord: TheoryChordInfo | null): Set<number> => {
    if (!chord) return new Set<number>()
    const template = THEORY_CHORD_TEMPLATES.find(item => item.quality === chord.quality)
    const values = chord.toneNames.length
      ? chord.toneNames.map(theoryPitchClassFromName).filter((pc): pc is number => pc !== null)
      : template ? template.intervals.map(interval => (chord.rootPc + interval) % 12) : []
    return new Set(values)
  }

  for (let i = 1; i < melodyPoints.length - 1; i++) {
    const previous = melodyPoints[i - 1]
    const current = melodyPoints[i]
    const next = melodyPoints[i + 1]
    const measure = current.measure
    const note = current.note
    const previousNote = previous.note
    const nextNote = next.note
    // Keep this first version conservative: only infer melodic passing/neighbor
    // patterns whose three notes live in the same measure. Cross-bar patterns can be
    // analyzed later using each measure's actual rhythmic length.
    if (previous.measure.sourceIndex !== measure.sourceIndex || next.measure.sourceIndex !== measure.sourceIndex) continue
    const prevGap = note.onsetQuarter - previousNote.onsetQuarter
    const nextGap = nextNote.onsetQuarter - note.onsetQuarter
    if (prevGap > 2 || nextGap > 2) continue
    const previousChord = chordAtMelodyPoint(previous)
    const currentChord = chordAtMelodyPoint(current)
    const nextChord = chordAtMelodyPoint(next)
    if (!currentChord || !previousChord || !nextChord) continue
    const chordPcs = chordPitchClasses(currentChord)
    // A candidate passing/neighbor note should connect chord tones on each side;
    // otherwise an arbitrary scalar melody could be mislabelled as non-chord evidence.
    if (!chordPcs.size || chordPcs.has(note.pitchClass)) continue
    if (!chordPitchClasses(previousChord).has(previousNote.pitchClass)) continue
    if (!chordPitchClasses(nextChord).has(nextNote.pitchClass)) continue
    const incoming = note.midi - previousNote.midi
    const outgoing = nextNote.midi - note.midi
    const stepwise = Math.abs(incoming) <= 2 && Math.abs(outgoing) <= 2 && incoming !== 0 && outgoing !== 0
    const neighbor = previousNote.midi === nextNote.midi && Math.abs(incoming) <= 2 && incoming !== 0
    const passing = stepwise && Math.sign(incoming) === Math.sign(outgoing)
    if (!neighbor && !passing) continue
    const isConfidentChord = currentChord.confidence === '較明確' || currentChord.confidence === '樂譜標記' || currentChord.confidence === '人工校正'
    measure.nonChordHints.push({
      noteName: theoryPitchName(note.step, note.alter, note.octave),
      onsetQuarter: note.onsetQuarter,
      label: neighbor ? '鄰音候選' : '經過音候選',
      explanation: `${theoryPitchName(previousNote.step, previousNote.alter, previousNote.octave)} → ${theoryPitchName(note.step, note.alter, note.octave)} → ${theoryPitchName(nextNote.step, nextNote.alter, nextNote.octave)}；該音不在${currentChord.symbol}的目前構成音中${isConfidentChord ? '' : '，且目前和弦本身仍屬推測'}。請結合節拍重音、延留關係與聽感確認。`,
    })
  }
  for (const measure of measures) {
    // Prevent dense ornamental writing from overwhelming the learning panel.
    measure.nonChordHints = measure.nonChordHints.slice(0, 5)
  }
}

function theoryDurationLabel(durationQuarter: number): string {
  const options: Array<[number, string]> = [
    [4, '全音符'], [3, '附點二分音符'], [2, '二分音符'], [4 / 3, '二分三連音'],
    [1.5, '附點四分音符'], [1, '四分音符'], [2 / 3, '四分三連音'],
    [0.75, '附點八分音符'], [0.5, '八分音符'], [1 / 3, '八分三連音'],
    [0.375, '附點十六分音符'], [0.25, '十六分音符'], [0.125, '三十二分音符'],
    [0.0625, '六十四分音符'],
  ]
  const valid = options
    .map(([value, label]) => ({ value, label, difference: Math.abs(durationQuarter - value) }))
    .sort((a, b) => a.difference - b.difference)[0]
  if (valid && valid.difference <= 0.035) return valid.label
  const safe = Number.isFinite(durationQuarter) ? Math.max(0, durationQuarter) : 0
  return `${Number(safe.toFixed(2))} 拍`
}

function theoryDiatonicPosition(note: TheoryNoteInfo): number {
  const letters: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }
  return note.octave * 7 + (letters[note.step] ?? 0)
}

function theoryIntervalQuality(simpleNumber: number, semitones: number): string {
  const labels: Record<number, Record<number, string>> = {
    1: { 0: '純一度', 1: '增一度' },
    2: { 0: '減二度', 1: '小二度', 2: '大二度', 3: '增二度' },
    3: { 2: '減三度', 3: '小三度', 4: '大三度', 5: '增三度' },
    4: { 4: '減四度', 5: '純四度', 6: '增四度' },
    5: { 6: '減五度', 7: '純五度', 8: '增五度' },
    6: { 7: '減六度', 8: '小六度', 9: '大六度', 10: '增六度' },
    7: { 9: '減七度', 10: '小七度', 11: '大七度', 12: '增七度' },
  }
  return labels[simpleNumber]?.[semitones] ?? `${simpleNumber}度（變化音程）`
}

function theoryMelodicInterval(from: TheoryNoteInfo, to: TheoryNoteInfo): TheoryMelodyInterval {
  const midiDelta = Math.round(to.midi - from.midi)
  const semitones = Math.abs(midiDelta)
  const diatonicDelta = theoryDiatonicPosition(to) - theoryDiatonicPosition(from)
  const absDiatonic = Math.abs(diatonicDelta)
  const intervalNumber = absDiatonic + 1
  const octaveCount = Math.floor(absDiatonic / 7)
  const simpleNumber = (absDiatonic % 7) + 1
  const simpleSemitones = Math.max(0, semitones - octaveCount * 12)
  const simpleLabel = theoryIntervalQuality(simpleNumber, simpleSemitones)
  const intervalLabel = octaveCount > 0
    ? (simpleNumber === 1 && simpleLabel === '純一度'
      ? `${octaveCount === 1 ? '純八度' : `${octaveCount}個八度`}`
      : `${octaveCount === 1 ? '八度＋' : `${octaveCount}個八度＋`}${simpleLabel}`)
    : simpleLabel
  const direction: TheoryMelodyInterval['direction'] = midiDelta > 0 ? '上行' : midiDelta < 0 ? '下行' : '重復音'
  const label = midiDelta === 0
    ? '重復音（0半音）'
    : `${direction}${intervalLabel}（${semitones}半音）`
  return {
    fromName: theoryPitchName(from.step, from.alter, from.octave),
    toName: theoryPitchName(to.step, to.alter, to.octave),
    semitones,
    direction,
    label,
  }
}

function buildTheoryMelodyProfile(
  notes: TheoryNoteInfo[],
  rhythmEvents: TheoryRhythmEvent[],
): {
  melodyContour: string
  melodyRange: string
  melodyIntervals: TheoryMelodyInterval[]
  rhythmSummary: string
  rhythmPattern: string[]
} {
  const staffNotes = notes.filter(note => note.staff === '1' && !note.isGrace && !note.isTieContinuation)
  const voiceCounts = new Map<string, number>()
  for (const note of staffNotes) voiceCounts.set(note.voice, (voiceCounts.get(note.voice) ?? 0) + 1)
  const melodyVoice = [...voiceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const melodyNotes = staffNotes.filter(note => !melodyVoice || note.voice === melodyVoice)
  const byOnset = new Map<number, TheoryNoteInfo>()
  for (const note of melodyNotes) {
    const onsetKey = Math.round(note.onsetQuarter * 10000) / 10000
    const existing = byOnset.get(onsetKey)
    // Collapse simultaneous chord notes to the highest note in the selected voice.
    if (!existing || note.midi > existing.midi) byOnset.set(onsetKey, note)
  }
  const line = [...byOnset.values()].sort((a, b) => a.onsetQuarter - b.onsetQuarter || a.midi - b.midi)
  const intervals = line.slice(1).map((note, index) => theoryMelodicInterval(line[index], note))
  const ups = intervals.filter(interval => interval.direction === '上行').length
  const downs = intervals.filter(interval => interval.direction === '下行').length
  const repeated = intervals.filter(interval => interval.direction === '重復音').length
  const leaps = intervals.filter(interval => interval.semitones >= 5).length
  const melodyContour = line.length < 2
    ? (line.length === 1 ? '本小節只有一個可分析的旋律起音，無法統計方向。' : '旋律資訊不足，未能形成可靠的單線旋律。')
    : `共 ${line.length} 個旋律起音：上行 ${ups} 次、下行 ${downs} 次、重復音 ${repeated} 次；其中較明顯跳進 ${leaps} 次。`

  let melodyRange = '旋律音域資訊不足'
  if (line.length > 0) {
    const lowest = [...line].sort((a, b) => a.midi - b.midi)[0]
    const highest = [...line].sort((a, b) => b.midi - a.midi)[0]
    const span = Math.max(0, Math.round(highest.midi - lowest.midi))
    melodyRange = `${theoryPitchName(lowest.step, lowest.alter, lowest.octave)} – ${theoryPitchName(highest.step, highest.alter, highest.octave)}，跨度 ${span} 半音${span >= 12 ? `（約 ${(span / 12).toFixed(1)} 個八度）` : ''}`
  }

  // Build a compact, explainable rhythmic pattern from the principal upper-staff voice.
  // Notes/rests are read from MusicXML duration + voice data; chord-note heads are not
  // duplicated into separate attacks. This is a descriptive summary, not full quantization.
  const selectedRhythmVoice = melodyVoice ?? [...new Set(rhythmEvents.map(event => event.voice))][0]
  const events = rhythmEvents
    .filter(event => (!selectedRhythmVoice || event.voice === selectedRhythmVoice) && !event.isGrace && event.durationQuarter > 0)
    .sort((a, b) => a.onsetQuarter - b.onsetQuarter)
  const rhythmLabels = events.map(event => `${event.isRest ? '休止' : ''}${theoryDurationLabel(event.durationQuarter)}`)
  const rhythmPattern: string[] = []
  for (const label of rhythmLabels) {
    const previous = rhythmPattern[rhythmPattern.length - 1]
    if (previous && previous.startsWith(`${label} ×`)) {
      const match = / ×(\d+)$/.exec(previous)
      rhythmPattern[rhythmPattern.length - 1] = `${label} ×${Number(match?.[1] ?? 1) + 1}`
    } else if (previous === label) {
      rhythmPattern[rhythmPattern.length - 1] = `${label} ×2`
    } else {
      rhythmPattern.push(label)
    }
  }
  const mainValues = new Map<string, number>()
  for (const event of events) {
    const label = `${event.isRest ? '休止：' : ''}${theoryDurationLabel(event.durationQuarter)}`
    mainValues.set(label, (mainValues.get(label) ?? 0) + 1)
  }
  const mostCommon = [...mainValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, count]) => `${label}（${count}次）`)
  const rhythmSummary = events.length === 0
    ? '未能提取可靠的上聲部節奏事件。'
    : `提取 ${events.length} 個音符/休止事件；常見時值：${mostCommon.join('、') || '混合時值'}。未對切分、連音線與復合拍號作完整節奏型歸約。`
  return { melodyContour, melodyRange, melodyIntervals: intervals.slice(0, 16), rhythmSummary, rhythmPattern: rhythmPattern.slice(0, 12) }
}

function analyseMusicXmlTheory(xmlText: string): ScoreTheoryAnalysis {
  const canonical = getCanonicalMusicXmlData(xmlText)
  const explicitKeyFound = canonical.explicitKey
  const firstMeter = canonical.firstMeter
    ? `${canonical.firstMeter.beats}/${canonical.firstMeter.beatType}`
    : ''
  const firstTempo = canonical.firstTempo
  const pitchWeights = [...canonical.pitchClassWeights]
  const mutableMeasures = new Map<number, any>()

  // Theory analysis now consumes the same normalized measure/note data used by
  // the meter and performance-mark readers. This removes three independent parsers
  // that previously could disagree about divisions, backup/forward, chord notes or ties.
  for (const measure of canonical.measures) {
    const notes: TheoryNoteInfo[] = measure.notes
      .filter(note => !note.isRest && note.midi !== null && note.pitchClass !== null && note.step !== null && note.octave !== null)
      .map(note => ({
        midi: note.midi as number,
        pitchClass: note.pitchClass as number,
        step: note.step as string,
        alter: note.alter,
        octave: note.octave as number,
        name: note.name ?? theoryPitchName(note.step as string, note.alter, note.octave as number),
        onsetQuarter: note.onsetQuarter,
        durationQuarter: note.durationQuarter,
        staff: note.staff,
        voice: note.voice,
        isGrace: note.isGrace,
        isTieContinuation: note.tieStop,
      }))
    const rhythmEvents: TheoryRhythmEvent[] = measure.rhythmEvents.map(event => ({
      onsetQuarter: event.onsetQuarter,
      durationQuarter: event.durationQuarter,
      isRest: event.isRest,
      isGrace: event.isGrace,
      voice: event.voice,
    }))
    const explicitHarmonies: TheoryExplicitHarmony[] = measure.explicitHarmonies.map(item => ({
      onsetQuarter: item.onsetQuarter,
      symbol: item.symbol,
      rootPc: item.rootPc,
      quality: item.quality,
      rootName: item.rootName,
      bassPc: item.bassPc,
      bassName: item.bassName,
    }))
    mutableMeasures.set(measure.sourceIndex, {
      sourceIndex: measure.sourceIndex,
      printedNumber: measure.printedNumber,
      notes,
      rhythmEvents,
      explicitHarmonies,
      fifths: measure.fifths,
      mode: measure.mode,
      meter: `${measure.meter.beats}/${measure.meter.beatType}`,
    })
  }
  if (mutableMeasures.size === 0) throw new Error('沒有解析到小節資料。')

  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
  let estimatedKey = { tonicPc: 0, mode: 'major' as 'major' | 'minor', score: -Infinity }
  const keyProfiles: Array<{ tonicPc: number; mode: 'major' | 'minor'; score: number }> = []
  const observedMean = pitchWeights.reduce((sum, value) => sum + value, 0) / 12
  const observedCentered = pitchWeights.map(value => value - observedMean)
  const observedNorm = Math.sqrt(observedCentered.reduce((sum, value) => sum + value * value, 0))
  for (let tonicPc = 0; tonicPc < 12; tonicPc++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? majorProfile : minorProfile
      const profileMean = profile.reduce((sum, value) => sum + value, 0) / 12
      const profileCentered = profile.map(value => value - profileMean)
      const profileNorm = Math.sqrt(profileCentered.reduce((sum, value) => sum + value * value, 0))
      let covariance = 0
      for (let pc = 0; pc < 12; pc++) covariance += observedCentered[pc] * profileCentered[(pc - tonicPc + 12) % 12]
      const score = observedNorm > 0.0001 && profileNorm > 0.0001 ? covariance / (observedNorm * profileNorm) : -1
      keyProfiles.push({ tonicPc, mode, score })
      if (score > estimatedKey.score) estimatedKey = { tonicPc, mode, score }
    }
  }
  keyProfiles.sort((a, b) => b.score - a.score)
  const hasExplicitKey = explicitKeyFound !== null
  const baseKey = hasExplicitKey
    ? theoryKeyFromFifths(explicitKeyFound!.fifths, explicitKeyFound!.mode)
    : {
        tonicPc: estimatedKey.tonicPc, mode: estimatedKey.mode,
        label: `${theoryPcName(estimatedKey.tonicPc, [1, 3, 6, 8, 10].includes(estimatedKey.tonicPc))}${estimatedKey.mode === 'major' ? '大調' : '小調'}（自動估計）`,
        preferFlats: [1, 3, 6, 8, 10].includes(estimatedKey.tonicPc),
      }
  const estimatedKeyMargin = keyProfiles.length > 1 ? keyProfiles[0].score - keyProfiles[1].score : 0
  const keySource = hasExplicitKey
    ? '來自樂譜調號；若中途轉調，按各小節實際調號更新'
    : estimatedKey.score < 0.15 || estimatedKeyMargin < 0.035
      ? '僅按全曲音高分布估計，存在相近候選調性，建議人工確認'
      : '根據全曲音高分布估計；仍建議結合終止式和和弦進行確認'

  // Keep a light continuity prior across adjacent measures; it influences ties only,
  // never overrides clear pitch evidence or explicit source annotations.
  let previousMeasureHarmony: { rootPc: number; quality: string } | null = null
  const measures: TheoryMeasureInfo[] = Array.from(mutableMeasures.values()).sort((a, b) => a.sourceIndex - b.sourceIndex).map((measure: any) => {
    const measureKey = measure.fifths !== null
      ? theoryKeyFromFifths(measure.fifths, measure.mode)
      : baseKey
    const notes: TheoryNoteInfo[] = measure.notes.sort((a: TheoryNoteInfo, b: TheoryNoteInfo) => a.onsetQuarter - b.onsetQuarter || a.midi - b.midi)
    const chords: TheoryChordInfo[] = []
    let lastSymbol = ''
    let lastExplicit: TheoryExplicitHarmony | null = null
    let previousCandidate: { rootPc: number; quality: string } | null = previousMeasureHarmony
    const explicitHarmonies = (measure.explicitHarmonies as TheoryExplicitHarmony[]).sort((a, b) => a.onsetQuarter - b.onsetQuarter)
    const localMode = measureKey.mode
    const keyView = { tonicPc: measureKey.tonicPc, mode: localMode, preferFlats: measureKey.preferFlats }

    // Analyze harmonic windows (beats), not just the notes sounding at an exact onset.
    // This is important for piano arpeggios where the chord tones are deliberately staggered.
    const meterMatch = /^\s*(\d+)\s*\/\s*(\d+)/.exec(measure.meter || firstMeter || '4/4')
    const numerator = meterMatch ? Math.max(1, Number(meterMatch[1])) : 4
    const denominator = meterMatch ? Math.max(1, Number(meterMatch[2])) : 4
    const beatQuarter = denominator === 8 && numerator >= 6 && numerator % 3 === 0
      ? 1.5
      : 4 / denominator
    const maximumEnd = notes.reduce((end: number, note: TheoryNoteInfo) => Math.max(end, note.onsetQuarter + Math.max(note.durationQuarter, 0)), 0)
    const nominalMeasureLength = numerator * (4 / denominator)
    const analysisEnd = Math.max(maximumEnd, nominalMeasureLength)
    const pointSet = new Set<number>()
    const addPoint = (value: number) => {
      if (Number.isFinite(value) && value >= -0.0001 && value < analysisEnd - 0.0001) {
        pointSet.add(Math.round(Math.max(0, value) * 10000) / 10000)
      }
    }
    for (let time = 0; time < analysisEnd - 0.0001; time += Math.max(0.25, beatQuarter)) addPoint(time)
    // Respect explicit harmony changes and longer bass-note onsets, including syncopation.
    explicitHarmonies.forEach(item => addPoint(item.onsetQuarter))
    notes.filter(note => !note.isGrace && !note.isTieContinuation && note.staff === '2' && note.durationQuarter >= beatQuarter * 0.7)
      .forEach(note => addPoint(note.onsetQuarter))
    const analysisPoints = Array.from(pointSet).sort((a, b) => a - b)
    const contextWindow = Math.max(0.85, Math.min(1.5, beatQuarter))

    for (const onsetQuarter of analysisPoints) {
      const contextNotes = notes.filter(note => {
        if (note.isGrace) return false
        const noteEnd = note.onsetQuarter + Math.max(note.durationQuarter, 0.03)
        const soundingNow = note.onsetQuarter <= onsetQuarter + 0.0001 && noteEnd > onsetQuarter + 0.0001
        const beginsSoon = note.onsetQuarter > onsetQuarter + 0.0001 && note.onsetQuarter < onsetQuarter + contextWindow - 0.0001
        return soundingNow || beginsSoon
      })
      if (!contextNotes.length) continue

      const pitchEvidence = new Map<number, number>()
      for (const note of contextNotes) {
        const delta = Math.max(0, note.onsetQuarter - onsetQuarter)
        const noteEnd = note.onsetQuarter + Math.max(note.durationQuarter, 0.03)
        const soundingNow = note.onsetQuarter <= onsetQuarter + 0.0001 && noteEnd > onsetQuarter + 0.0001
        const proximityWeight = soundingNow ? 1 : Math.max(0.35, 0.92 - 0.55 * delta / contextWindow)
        const durationWeight = 0.72 + Math.min(2, Math.max(0, note.durationQuarter)) * 0.18
        const registerWeight = (note.staff === '2' ? 1.12 : 0.92) * (note.midi < 60 ? 1.08 : 1)
        const weight = proximityWeight * durationWeight * registerWeight
        pitchEvidence.set(note.pitchClass, Math.min(3.5, (pitchEvidence.get(note.pitchClass) ?? 0) + weight))
      }

      const activeNotes = notes.filter(note => !note.isGrace && note.onsetQuarter <= onsetQuarter + 0.0001 && note.onsetQuarter + Math.max(note.durationQuarter, 0.03) > onsetQuarter + 0.0001)
      const activeLowNotes = activeNotes.filter(note => note.midi < 60)
      const activeStaffTwo = activeNotes.filter(note => note.staff === '2')
      const contextLowNotes = contextNotes.filter(note => note.midi < 60)
      const contextStaffTwo = contextNotes.filter(note => note.staff === '2')
      // Prefer the most recently attacked active left-hand/bass note, choosing the
      // lowest pitch only among notes sharing that onset. This avoids carrying a held
      // bass note from the previous beat into every later chord decision.
      const bassCandidatesAtTime = activeStaffTwo.length ? activeStaffTwo : activeLowNotes.length ? activeLowNotes : contextStaffTwo.length ? contextStaffTwo : contextLowNotes.length ? contextLowNotes : contextNotes
      const latestBassOnset = bassCandidatesAtTime.length ? Math.max(...bassCandidatesAtTime.map(note => note.onsetQuarter)) : onsetQuarter
      const bassNote = bassCandidatesAtTime
        .filter(note => Math.abs(note.onsetQuarter - latestBassOnset) < 0.0001)
        .sort((a, b) => a.midi - b.midi)[0]
      const harmonyAtThisTime = explicitHarmonies.filter(item => item.onsetQuarter <= onsetQuarter + 0.0001).slice(-1)[0] ?? null
      if (harmonyAtThisTime) lastExplicit = harmonyAtThisTime
      const inferred = theoryChordForPitchEvidence(pitchEvidence, bassNote.pitchClass, keyView, previousCandidate, contextNotes, theoryPitchName(bassNote.step, bassNote.alter))
      let chord: TheoryChordInfo | null = null
      if (lastExplicit) {
        const template = THEORY_CHORD_TEMPLATES.find(item => item.quality === lastExplicit!.quality)
        const rootMatch = /^([A-G])([♯♭𝄪𝄫]*)/.exec(lastExplicit.rootName)
        const suffixToneNames = template && rootMatch ? theoryChordToneNamesFromSpelling(lastExplicit.rootPc, rootMatch[1], template.intervals) : []
        chord = {
          onsetQuarter,
          symbol: lastExplicit.symbol,
          rootName: lastExplicit.rootName,
          rootPc: lastExplicit.rootPc,
          quality: lastExplicit.quality,
          qualityLabel: '樂譜中標註的和弦',
          roman: lastExplicit.quality === 'unknown' ? '待分析' : theoryRomanNumeral(lastExplicit.rootPc, lastExplicit.quality, measureKey.tonicPc, localMode),
          toneNames: suffixToneNames,
          actualNotes: Array.from(new Set(contextNotes.map((note: TheoryNoteInfo) => note.name))).sort((a, b) => a.localeCompare(b, 'zh-TW')),
          bassName: lastExplicit.bassName ?? bassNote.name,
          confidence: '樂譜標記',
          evidenceSource: '原譜和弦標記',
          evidenceSummary: ['和弦名稱來自 MusicXML 原譜的 <harmony> 標記；這是源檔案中的標註，不代表已獨立驗證其與每個實際音符完全一致。'],
        }
      } else if (inferred) {
        chord = {
          onsetQuarter,
          symbol: inferred.symbol,
          rootName: inferred.rootName,
          rootPc: inferred.rootPc,
          quality: inferred.quality,
          qualityLabel: inferred.label,
          roman: inferred.roman,
          toneNames: inferred.toneNames,
          actualNotes: Array.from(new Set(contextNotes.map((note: TheoryNoteInfo) => note.name))).sort((a, b) => a.localeCompare(b, 'zh-TW')),
          bassName: bassNote.name,
          confidence: inferred.confidence,
          evidenceSource: '局部音符推斷',
          evidenceSummary: inferred.evidenceSummary,
          matchingScore: inferred.matchingScore,
          scoreMargin: inferred.scoreMargin,
          candidateDetails: inferred.candidateDetails,
          alternatives: inferred.alternatives,
        }
      }
      if (chord && chord.symbol !== lastSymbol) {
        chords.push(chord)
        lastSymbol = chord.symbol
      }
      if (chord && chord.confidence !== '樂譜標記') previousCandidate = { rootPc: chord.rootPc, quality: chord.quality }
    }

    // A final whole-measure fallback catches sustained or broken chords which never
    // produce a sufficiently rich local beat window. It is deliberately labelled as an inference.
    if (chords.length === 0 && notes.length >= 2) {
      const measureEvidence = new Map<number, number>()
      for (const note of notes) {
        if (note.isGrace || Math.abs(note.pitchClass - Math.round(note.pitchClass)) > 0.001) continue
        const weight = (0.6 + Math.min(3, Math.max(0, note.durationQuarter)) * 0.22) * (note.staff === '2' ? 1.08 : 1)
        const pc = ((Math.round(note.pitchClass) % 12) + 12) % 12
        measureEvidence.set(pc, Math.min(4, (measureEvidence.get(pc) ?? 0) + weight))
      }
      const realNotes = notes.filter(note => !note.isGrace)
      const fallbackBassPool = realNotes.filter(note => note.midi < 60).length ? realNotes.filter(note => note.midi < 60) : realNotes.filter(note => note.staff === '2').length ? realNotes.filter(note => note.staff === '2') : realNotes
      const firstBassOnset = fallbackBassPool.length ? Math.min(...fallbackBassPool.map(note => note.onsetQuarter)) : 0
      const measureBass = fallbackBassPool.filter(note => Math.abs(note.onsetQuarter - firstBassOnset) < 0.0001).sort((a, b) => a.midi - b.midi)[0]
      const fallback = measureBass ? theoryChordForPitchEvidence(measureEvidence, measureBass.pitchClass, keyView, null, realNotes, theoryPitchName(measureBass.step, measureBass.alter)) : null
      if (fallback) {
        chords.push({
          onsetQuarter: 0,
          symbol: fallback.symbol,
          rootName: fallback.rootName,
          rootPc: fallback.rootPc,
          quality: fallback.quality,
          qualityLabel: `${fallback.label}（按整小節推斷）`,
          roman: fallback.roman,
          toneNames: fallback.toneNames,
          actualNotes: Array.from(new Set(realNotes.map((note: TheoryNoteInfo) => note.name))).sort((a, b) => a.localeCompare(b, 'zh-TW')),
          bassName: measureBass.name,
          confidence: '推測',
          evidenceSource: '整小節推斷',
          evidenceSummary: fallback.evidenceSummary,
          matchingScore: fallback.matchingScore,
          scoreMargin: fallback.scoreMargin,
          candidateDetails: fallback.candidateDetails,
          alternatives: fallback.alternatives,
        })
      }
    }
    const tailChord = [...chords].reverse()[0]
    if (tailChord) previousMeasureHarmony = { rootPc: tailChord.rootPc, quality: tailChord.quality }

    const soundingNotes = notes.filter(note => !note.isGrace)
    const bassCandidates = soundingNotes.filter(note => note.midi < 60)
    const bassPool = bassCandidates.length ? bassCandidates : soundingNotes.filter(note => note.staff === '2').length ? soundingNotes.filter(note => note.staff === '2') : soundingNotes
    const firstBassOnset = bassPool.length ? Math.min(...bassPool.map(note => note.onsetQuarter)) : 0
    const bassNote = bassPool.filter(note => Math.abs(note.onsetQuarter - firstBassOnset) < 0.0001).sort((a, b) => a.midi - b.midi)[0]
    const melodyNotes = soundingNotes.filter(note => note.staff === '1' && !note.isGrace && !note.isTieContinuation).sort((a, b) => a.onsetQuarter - b.onsetQuarter || a.midi - b.midi)
    const firstMelodyOnset = melodyNotes.length ? melodyNotes[0].onsetQuarter : null
    const lastMelodyOnset = melodyNotes.length ? melodyNotes[melodyNotes.length - 1].onsetQuarter : null
    const firstMidi = firstMelodyOnset === null ? null : Math.max(...melodyNotes.filter(note => Math.abs(note.onsetQuarter - firstMelodyOnset) < 0.0001).map(note => note.midi))
    const lastMidi = lastMelodyOnset === null ? null : Math.max(...melodyNotes.filter(note => Math.abs(note.onsetQuarter - lastMelodyOnset) < 0.0001).map(note => note.midi))
    const delta = firstMidi === null || lastMidi === null ? null : lastMidi - firstMidi
    const melodyTrend = delta === null
      ? '旋律資訊不足'
      : delta > 0 ? `首尾上行 ${delta} 半音` : delta < 0 ? `首尾下行 ${Math.abs(delta)} 半音` : '首尾音相同'
    const melodyProfile = buildTheoryMelodyProfile(notes, measure.rhythmEvents ?? [])
    const primaryChord = chords[0] ?? null
    return {
      sourceIndex: measure.sourceIndex,
      printedNumber: measure.printedNumber,
      notes,
      chords,
      primaryChord,
      bassName: bassNote?.name ?? '—',
      bassMidi: bassNote?.midi ?? null,
      melodyTrend,
      melodyContour: melodyProfile.melodyContour,
      melodyRange: melodyProfile.melodyRange,
      melodyIntervals: melodyProfile.melodyIntervals,
      rhythmSummary: melodyProfile.rhythmSummary,
      rhythmPattern: melodyProfile.rhythmPattern,
      keyName: measureKey.label,
      keySource,
      keyTonicPc: measureKey.tonicPc,
      keyMode: localMode,
      harmonicFunction: '',
      cadenceHint: null,
      nonChordHints: [],
      meter: measure.meter || firstMeter || '未知',
    }
  })

  addTheoryLearningAnnotations(measures)

  const title = canonical.title
  const composer = canonical.composer
  const partNames = canonical.partNames

  return {
    title, composer, keyName: baseKey.label, keySource, meter: firstMeter || measures[0]?.meter || '未知',
    tempo: firstTempo, partNames, measures,
  }
}


type GuitarTuningString = {
  /** Physical guitar string number: 1 is the highest string; 6 is the low E string on a six-string guitar. */
  stringNumber: number
  lineNumber: number
  pitchLabel: string
}

type GuitarSetupInfo = {
  partName: string
  isTab: boolean
  capoValues: number[]
  tuning: GuitarTuningString[]
  hasTuningChanges: boolean
}

function musicXmlPitchLabel(step: string, alter: number, octave: number): string {
  const accidental = alter === -2 ? '♭♭'
    : alter === -1 ? '♭'
      : alter === 1 ? '♯'
        : alter === 2 ? '♯♯'
          : alter < 0 ? `${'♭'.repeat(Math.min(4, Math.abs(alter)))}`
            : alter > 0 ? `${'♯'.repeat(Math.min(4, alter))}`
              : ''
  return `${step.toUpperCase()}${accidental}${Number.isFinite(octave) ? octave : ''}`
}

/**
 * Read capo and open-string tuning from MusicXML staff-details. MusicXML staff-tuning
 * line numbers are counted from bottom to top, so line 1 is mapped to the lowest physical
 * string (e.g. string 6 on a six-string guitar). Missing tags stay explicitly unmarked;
 * this reader never guesses standard tuning or assumes no capo.
 */
async function readGuitarSetupInfo(fileUrl: string): Promise<GuitarSetupInfo | null> {
  const response = await fetch(fileUrl)
  if (!response.ok) throw new Error(`無法讀取吉他設定：HTTP ${response.status}`)
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml')
  if (xml.getElementsByTagName('parsererror').length > 0) throw new Error('MusicXML 格式解析失敗')

  const root = xml.documentElement
  const partList = directChildren(root, 'part-list')[0]
  const partNames = new Map<string, string>()
  if (partList) {
    for (const scorePart of directChildren(partList, 'score-part')) {
      const id = scorePart.getAttribute('id') ?? ''
      const name = directChildren(scorePart, 'part-name')[0]?.textContent?.trim()
        || directChildren(scorePart, 'part-abbreviation')[0]?.textContent?.trim()
        || id
      if (id) partNames.set(id, name)
    }
  }

  const parts = directChildren(root, 'part')
  if (parts.length === 0) return null
  const descendants = (element: Element, name: string): Element[] =>
    Array.from(element.getElementsByTagName('*')).filter(child => child.localName === name)

  const scoredParts = parts.map((part, index) => {
    const name = partNames.get(part.getAttribute('id') ?? '') || part.getAttribute('id') || `Part ${index + 1}`
    const details = descendants(part, 'staff-details')
    const tuningCount = details.reduce((sum, detail) => sum + directChildren(detail, 'staff-tuning').length, 0)
    const hasTabClef = descendants(part, 'clef').some(clef =>
      (directChildren(clef, 'sign')[0]?.textContent?.trim().toUpperCase() ?? '') === 'TAB',
    )
    const looksGuitar = /guitar|吉他|bass|貝斯|贝斯|ukulele|banjo|mandolin/i.test(name)
    const score = (tuningCount > 0 ? 100 + tuningCount : 0) + (hasTabClef ? 80 : 0) + (looksGuitar ? 20 : 0)
    return { part, name, details, tuningCount, hasTabClef, score }
  }).sort((a, b) => b.score - a.score)

  const selected = scoredParts[0]
  if (!selected || selected.score <= 0) return null

  const detailEntries = selected.details.map(detail => ({
    detail,
    staffNumber: detail.getAttribute('number') ?? '',
    tunings: directChildren(detail, 'staff-tuning'),
  }))
  const tuningDetails = detailEntries.filter(entry => entry.tunings.length > 0)
  tuningDetails.sort((a, b) => b.tunings.length - a.tunings.length)
  const chosenTuningDetail = tuningDetails[0]

  const readTuning = (detail: Element, tunings: Element[]): GuitarTuningString[] => {
    const lineNumbers = tunings.map(tuning => Number(tuning.getAttribute('line'))).filter(value => Number.isFinite(value) && value > 0)
    const parsedStaffLines = Number(directChildren(detail, 'staff-lines')[0]?.textContent)
    const staffLines = Number.isFinite(parsedStaffLines) && parsedStaffLines > 0
      ? parsedStaffLines
      : (lineNumbers.length ? Math.max(...lineNumbers) : tunings.length)
    return tunings.flatMap(tuning => {
      const lineNumber = Number(tuning.getAttribute('line'))
      const step = directChildren(tuning, 'tuning-step')[0]?.textContent?.trim()
      const octaveText = directChildren(tuning, 'tuning-octave')[0]?.textContent?.trim()
      if (!Number.isFinite(lineNumber) || lineNumber <= 0 || !step || !octaveText) return []
      const octave = Number(octaveText)
      if (!Number.isFinite(octave)) return []
      const alterText = directChildren(tuning, 'tuning-alter')[0]?.textContent?.trim()
      const alter = alterText ? Number(alterText) : 0
      const safeAlter = Number.isFinite(alter) ? alter : 0
      return [{
        stringNumber: Math.max(1, staffLines + 1 - lineNumber),
        lineNumber,
        pitchLabel: musicXmlPitchLabel(step, safeAlter, octave),
      }]
    }).sort((a, b) => b.stringNumber - a.stringNumber)
  }

  const tuning = chosenTuningDetail
    ? readTuning(chosenTuningDetail.detail, chosenTuningDetail.tunings)
    : []
  const tuningSignatures = new Set(
    tuningDetails
      .map(entry => readTuning(entry.detail, entry.tunings))
      .filter(entries => entries.length > 0)
      .map(entries => entries.map(entry => `${entry.stringNumber}:${entry.pitchLabel}`).join('|')),
  )

  // Capo belongs to a staff; prefer the same numbered staff as the detected TAB tuning.
  const selectedStaffNumber = chosenTuningDetail?.staffNumber ?? ''
  const capoDetails = detailEntries.filter(entry =>
    selectedStaffNumber ? (!entry.staffNumber || entry.staffNumber === selectedStaffNumber) : true,
  )
  const capoValues: number[] = []
  for (const entry of capoDetails) {
    for (const capoNode of directChildren(entry.detail, 'capo')) {
      const valueText = capoNode.textContent?.trim()
      if (!valueText) continue
      const value = Number(valueText)
      if (!Number.isFinite(value) || value < 0) continue
      if (!capoValues.includes(value)) capoValues.push(value)
    }
  }

  return {
    partName: selected.name,
    isTab: selected.hasTabClef || selected.tuningCount > 0,
    capoValues,
    tuning,
    hasTuningChanges: tuningSignatures.size > 1,
  }
}

/**
 * 讀取 MusicXML 中的吉他和弦指法圖。
 * 只讀取源檔案，不會修改檔案內容。
 */
async function readChordFrames(
  fileUrl: string,
): Promise<ChordFrameData[]> {
  const response = await fetch(fileUrl)

  if (!response.ok) {
    throw new Error(`無法讀取 MusicXML：HTTP ${response.status}`)
  }

  const xml = new DOMParser().parseFromString(
    await response.text(),
    'application/xml',
  )

  if (xml.getElementsByTagName('parsererror').length > 0) {
    throw new Error('MusicXML 格式解析失敗')
  }

  const harmonies = Array.from(
    xml.getElementsByTagName('*'),
  ).filter((element) => element.localName === 'harmony')

  return harmonies.flatMap((harmony) => {
    const frame = directChildren(harmony, 'frame')[0]
    if (!frame) return []

    const strings = Number(
      directChildren(frame, 'frame-strings')[0]?.textContent ?? 6,
    )

    const frets = Number(
      directChildren(frame, 'frame-frets')[0]?.textContent ?? 5,
    )

    const firstFret = Number(
      directChildren(frame, 'first-fret')[0]?.textContent ?? 1,
    )

    const notes = directChildren(frame, 'frame-note').map((note) => {
      const rawFret = Number(directChildren(note, 'fret')[0]?.textContent)
      const muted = Number.isFinite(rawFret) && rawFret < 0
      return {
        stringNumber: Number(directChildren(note, 'string')[0]?.textContent),
        fret: muted ? 0 : rawFret,
        muted,
        barre: directChildren(note, 'barre').map(
          (element) => element.getAttribute('type') ?? '',
        ),
      }
    })

    if (
      !Number.isFinite(strings) ||
      strings < 2 ||
      !Number.isFinite(frets) ||
      frets < 1
    ) {
      return []
    }

    return [
      {
        strings,
        frets,
        firstFret:
          Number.isFinite(firstFret) && firstFret >= 1
            ? firstFret
            : 1,
        notes: notes.filter(
          (note) =>
            Number.isFinite(note.stringNumber) &&
            note.stringNumber >= 1 &&
            note.stringNumber <= strings &&
            Number.isFinite(note.fret) &&
            (note.muted || note.fret >= 0),
        ),
      },
    ]
  })
}

/**
 * 讀取 MusicXML 中歌詞的原始文字，用於在 SVG 渲染後精准縮小歌詞，
 * 避免誤改和弦名稱、段落注釋或其他樂譜文字。
 */
async function readLyricsTexts(fileUrl: string): Promise<Set<string>> {
  const response = await fetch(fileUrl)

  if (!response.ok) {
    throw new Error(`無法讀取 MusicXML 歌詞：HTTP ${response.status}`)
  }

  const xml = new DOMParser().parseFromString(
    await response.text(),
    'application/xml',
  )

  if (xml.getElementsByTagName('parsererror').length > 0) {
    throw new Error('MusicXML 歌詞解析失敗')
  }

  const result = new Set<string>()
  const lyricNodes = Array.from(xml.getElementsByTagName('*')).filter(
    (element) => element.localName === 'lyric',
  )

  for (const lyric of lyricNodes) {
    for (const textNode of directChildren(lyric, 'text')) {
      const value = normalizeLyricText(textNode.textContent ?? '')
      if (value) result.add(value)
    }
  }

  return result
}

/**
 * Guitar Pro 將掃弦資訊寫入自定義 XML processing instruction：
 * <?GP <root><brush type="up"/></root>?>
 * 這不是普通 XML 元素，不能用 getElementsByTagName 查找。
 */
function readBrushDirection(note: Element): BrushDirection | null {
  const pending: Node[] = [note]

  while (pending.length > 0) {
    const current = pending.pop()!

    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === 7) {
        const instruction = child as ProcessingInstruction
        if (instruction.target.toUpperCase() === 'GP') {
          const match = instruction.data.match(
            /<brush\b[^>]*\btype\s*=\s*["'](up|down)["']/i,
          )
          if (match) {
            // Guitar Pro 的 brush type 與 ScoreRoom 需要顯示的箭頭方向相反，
            // 因此在讀取時統一翻轉一次，避免只在繪制端補丁造成語義混亂。
            return match[1].toLowerCase() === 'up' ? 'down' : 'up'
          }
        }
      }

      if (child.childNodes.length > 0) pending.push(child)
    }
  }

  return null
}

/**
 * Read a Guitar TAB string/fret and the corresponding pitch from one MusicXML note.
 * Keeping the pitch lets the playback engine stagger only the actual guitar chord tones,
 * rather than accidentally delaying a simultaneous vocal melody note.
 */
function readBrushFretNote(note: Element): BrushFretNote | null {
  const notations = directChildren(note, 'notations')[0]
  const technical =
    (notations ? directChildren(notations, 'technical')[0] : undefined) ??
    Array.from(note.getElementsByTagName('*')).find(element => element.localName === 'technical')
  const stringNode = technical
    ? Array.from(technical.getElementsByTagName('*')).find(element => element.localName === 'string')
    : undefined
  const fretNode = technical
    ? Array.from(technical.getElementsByTagName('*')).find(element => element.localName === 'fret')
    : undefined
  if (!stringNode) return null

  const stringNumber = Number(stringNode.textContent)
  if (!Number.isFinite(stringNumber) || stringNumber < 1 || stringNumber > 12) return null

  const fretText = (fretNode?.textContent ?? '').trim()
  const noteheadNode = directChildren(note, 'notehead')[0] ??
    Array.from(note.getElementsByTagName('*')).find(element => element.localName === 'notehead')
  const noteheadText = (noteheadNode?.textContent ?? '').trim().toLowerCase()
  const noteheadAttrs = noteheadNode
    ? Array.from(noteheadNode.attributes).map(attribute => `${attribute.name}=${attribute.value}`).join(' ').toLowerCase()
    : ''
  const isXNotehead = /^(?:x|×|cross|crossed|circle-x|x-circle)$/i.test(noteheadText) ||
    /(?:notehead\s*=\s*["']?(?:x|cross)|(?:^|\s)(?:x|cross)(?:\s|$))/i.test(noteheadAttrs) ||
    /^(?:x|×|cross|crossed)$/i.test(fretText)
  const parsedFret = fretText.length > 0 ? Number(fretText) : Number.NaN
  const isPercussive = isXNotehead || (Number.isFinite(parsedFret) && parsedFret < 0)
  if (!isPercussive && (!Number.isFinite(parsedFret) || parsedFret < 0)) return null
  const fret = isPercussive ? -1 : parsedFret

  const pitch = directChildren(note, 'pitch')[0]
  const step = pitch ? directChildren(pitch, 'step')[0]?.textContent?.trim().toUpperCase() : undefined
  const octave = pitch ? Number(directChildren(pitch, 'octave')[0]?.textContent) : Number.NaN
  const alterNode = pitch ? directChildren(pitch, 'alter')[0] : undefined
  const alter = alterNode ? Number(alterNode.textContent) : 0
  const pitchClass: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const midi = step && pitchClass[step] !== undefined && Number.isFinite(octave) && Number.isFinite(alter)
    ? (octave + 1) * 12 + pitchClass[step] + alter
    : NaN

  const techniques = readGuitarTechniqueLabels(note)
  return {
    stringNumber,
    fret,
    ...(isPercussive ? { isPercussive: true } : {}),
    ...(Number.isFinite(midi) ? { midi } : {}),
    ...(techniques.length ? { techniques } : {}),
  }
}

type GuitarLegatoMarker = { articulation: GuitarLegatoArticulation; markerType: string }

function readGuitarTechniqueStringNumber(note: Element): number | null {
  const notations = directChildren(note, 'notations')[0]
  const technical = notations ? directChildren(notations, 'technical')[0] : null
  const raw = technical ? Number(directChildren(technical, 'string')[0]?.textContent) : Number.NaN
  return Number.isInteger(raw) && raw >= 1 && raw <= 12 ? raw : null
}

function readGuitarLegatoMarkers(note: Element): GuitarLegatoMarker[] {
  const notations = directChildren(note, 'notations')[0]
  const technical = notations ? directChildren(notations, 'technical')[0] : null
  if (!technical) return []
  const markers: GuitarLegatoMarker[] = []
  for (const node of Array.from(technical.children)) {
    if (node.localName !== 'hammer-on' && node.localName !== 'pull-off') continue
    markers.push({
      articulation: node.localName === 'hammer-on' ? 'hammer-on' : 'pull-off',
      markerType: (node.getAttribute('type') || '').trim().toLowerCase(),
    })
  }
  return markers
}

/**
 * Read common Guitar Pro non-standard technical tags which OSMD may ignore visually.
 * MusicXML does not have a universal slap/pop element, so exporters often use
 * <other-technical> text. The result is presentation-only and never changes pitch data.
 */
function readGuitarTechniqueLabels(note: Element): string[] {
  const notations = directChildren(note, 'notations')[0]
  if (!notations) return []
  const labels = new Set<string>()
  // Different notation programs place these names under <technical>,
  // <articulations>/<other-articulation>, or exporter-specific children.
  // Stay inside this note's <notations> so lyric/part text cannot create false labels.
  const nodes = Array.from(notations.getElementsByTagName('*'))
  for (const node of nodes) {
    const kind = node.localName.toLowerCase()
    const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
    const attrs = Array.from(node.attributes).map(attribute => attribute.value.toLowerCase()).join(' ')
    const token = `${kind} ${value} ${attrs}`
    const allowsCompactToken = kind === 'other-technical' || kind === 'other-articulation' ||
      kind === 'technical' || kind === 'articulations'

    if (/(?:\bpalm[\s_-]*mute(?:d|s)?\b|\bpalm[\s_-]*muting\b|\bmuted[\s_-]*palm\b|\b(?:mute|muted|muting|damp|damped|damping)\b|\bdead[\s_-]*note\b|\bmuted[\s_-]*note\b|\bghost[\s_-]*note\b|\bpm\b|\bp\s*\.\s*m\s*\.?\b|掌根制音|悶音|闷音|手掌制音)/i.test(token) ||
        (allowsCompactToken && /^(?:pm|p\.m\.?|palm mute|palm muted|dead note|muted note|ghost note)$/i.test(value))) labels.add('PM')
    // MusicXML has dedicated technical tags for headless/tail-less slides. Keep their
    // direction so the overlay can draw a small slash touching the correct side of the fret.
    if (kind === 'slide-in-from-below') labels.add('SLIDE_IN_BELOW')
    else if (kind === 'slide-in-from-above') labels.add('SLIDE_IN_ABOVE')
    else if (kind === 'slide-out-of-below') labels.add('SLIDE_OUT_BELOW')
    else if (kind === 'slide-out-of-above') labels.add('SLIDE_OUT_ABOVE')
    // Some exporters use MusicXML's generic <slide type="start|stop"> instead of
    // slide-in-from/slide-out-of tags. Keep those marks visible as a neutral-direction slide.
    else if (kind === 'slide') {
      const endpoint = (node.getAttribute('type') || '').trim().toLowerCase()
      if (endpoint === 'start') labels.add('SLIDE_OUT_GENERIC')
      else if (endpoint === 'stop' || endpoint === 'end') labels.add('SLIDE_IN_GENERIC')
    }
    else if (/\b(dead[ -]?slap|slap|slapping|thumb[ -]?slap|slap[ -]?bass)\b/.test(token) || /拍弦|拍擊|拍击|打板/.test(token) || (allowsCompactToken && value === 's')) labels.add('S')
    else if (/\b(pop|popping)\b/.test(token) || (allowsCompactToken && value === 'p')) labels.add('P')
    else if (/\b(tap|tapping|tapped|finger[ -]?tap)\b/.test(token) || kind === 'tap' || (allowsCompactToken && value === 't')) labels.add('T')
    else if (/\b(golpe|finger golpe|thumb golpe|body percussion)\b/.test(token) || (allowsCompactToken && value === 'g')) labels.add('G')
  }
  return [...labels]
}

/**
 * Parse per-measure guitar note data for both engraving overlays and performance.
 * MusicXML durations are tracked in quarter-note units, including backup/forward and
 * changing divisions. A chord with <chord/> shares the preceding note's onset.
 */
async function readBrushNoteEvents(fileUrl: string): Promise<BrushNoteEvent[]> {
  const response = await fetch(fileUrl)
  if (!response.ok) throw new Error(`無法讀取 MusicXML 掃弦標記：HTTP ${response.status}`)
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml')
  if (xml.getElementsByTagName('parsererror').length > 0) throw new Error('MusicXML 掃弦標記解析失敗')

  const events: BrushNoteEvent[] = []
  const parts = directChildren(xml.documentElement, 'part')
  for (const part of parts) {
    const measures = directChildren(part, 'measure')
    let divisions = 1
    const pendingLegatoByString = new Map<number, GuitarLegatoArticulation>()

    for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
      const measure = measures[measureIndex]
      const measureNumber = measure.getAttribute('number') || String(measureIndex + 1)
      const measureEvents: BrushNoteEvent[] = []
      let cursorQuarter = 0
      let currentEventIndex: number | null = null

      for (const node of Array.from(measure.children)) {
        if (node.localName === 'attributes') {
          const rawDivisions = Number(directChildren(node, 'divisions')[0]?.textContent)
          if (Number.isFinite(rawDivisions) && rawDivisions > 0) divisions = rawDivisions
          continue
        }
        if (node.localName === 'backup' || node.localName === 'forward') {
          const amount = Number(directChildren(node, 'duration')[0]?.textContent)
          if (Number.isFinite(amount) && amount > 0) {
            const delta = amount / Math.max(1, divisions)
            cursorQuarter = node.localName === 'backup' ? Math.max(0, cursorQuarter - delta) : cursorQuarter + delta
          }
          currentEventIndex = null
          continue
        }
        if (node.localName !== 'note') continue

        const isChordTone = directChildren(node, 'chord').length > 0
        const durationUnits = Number(directChildren(node, 'duration')[0]?.textContent)
        const durationQuarter = Number.isFinite(durationUnits) && durationUnits > 0
          ? durationUnits / Math.max(1, divisions)
          : 0
        const onsetQuarter = cursorQuarter
        const rest = directChildren(node, 'rest').length > 0
        const hasPitch = directChildren(node, 'pitch').length > 0
        const direction = readBrushDirection(node)
        const fretNote = readBrushFretNote(node)
        const noteheadText = (directChildren(node, 'notehead')[0]?.textContent ?? '').trim().toLowerCase()
        const hasXNotehead = /^(?:x|×|cross|crossed|circle-x|x-circle)$/i.test(noteheadText)
        const techniqueStringNumber = readGuitarTechniqueStringNumber(node)
        const legatoMarkers = readGuitarLegatoMarkers(node)
        const techniques = readGuitarTechniqueLabels(node)
        // Some MusicXML exporters encode a muted hit only as an X notehead, without
        // a valid <technical><string>/<fret> pair. Preserve it as a visual mute/slap event.
        if (hasXNotehead && !fretNote?.isPercussive && !techniques.includes('PM')) techniques.push('PM')
        const dots = directChildren(node, 'dot').length

        if (fretNote) {
          const sameStringPending = pendingLegatoByString.get(fretNote.stringNumber)
          const stopMarker = legatoMarkers.find(marker => marker.markerType === 'stop' || marker.markerType === 'end')
          if (stopMarker) {
            fretNote.articulation = stopMarker.articulation
            pendingLegatoByString.delete(fretNote.stringNumber)
          } else if (sameStringPending) {
            // Some exporters only mark the source note with a start tag. Apply the
            // legato articulation to the next note on that string as a recovery path.
            fretNote.articulation = sameStringPending
            pendingLegatoByString.delete(fretNote.stringNumber)
          } else {
            const untypedMarker = legatoMarkers.find(marker => !marker.markerType)
            if (untypedMarker) fretNote.articulation = untypedMarker.articulation
          }
          const startMarker = legatoMarkers.find(marker => marker.markerType === 'start')
          if (startMarker) pendingLegatoByString.set(fretNote.stringNumber, startMarker.articulation)
        }

        if (isChordTone) {
          if (currentEventIndex !== null) {
            const event = measureEvents[currentEventIndex]
            if (event.direction === null && direction) event.direction = direction
            event.dots = Math.max(event.dots, dots)
            if (techniques.length) event.techniques = [...new Set([...event.techniques, ...techniques])]
            if (techniqueStringNumber !== null) event.techniqueStringNumbers = [...new Set([...event.techniqueStringNumbers, techniqueStringNumber])]
            if (fretNote) {
              const existing = event.fretNotes.find(item =>
                item.stringNumber === fretNote.stringNumber && item.fret === fretNote.fret,
              )
              if (existing) {
                if (existing.midi === undefined && fretNote.midi !== undefined) existing.midi = fretNote.midi
                if (!existing.articulation && fretNote.articulation) existing.articulation = fretNote.articulation
                if (fretNote.techniques?.length) existing.techniques = [...new Set([...(existing.techniques ?? []), ...fretNote.techniques])]
              } else event.fretNotes.push(fretNote)
            }
          }
          // Chord tones do not advance the MusicXML cursor.
          continue
        }

        currentEventIndex = null
        if (!rest && (hasPitch || fretNote || techniques.length > 0 || direction || legatoMarkers.length > 0 || hasXNotehead)) {
          const type = directChildren(node, 'type')[0]?.textContent?.trim().toLowerCase() ?? ''
          const stem = directChildren(node, 'stem')[0]?.textContent?.trim().toLowerCase() ?? ''
          const hasNativeStem = !['whole', 'breve', 'long'].includes(type) && stem !== 'none' && stem !== ''
          measureEvents.push({
            direction,
            measureNumber,
            measureIndex,
            positionQuarter: onsetQuarter,
            durationQuarter,
            noteType: type,
            dots,
            fretNotes: fretNote ? [fretNote] : [],
            techniques: [...new Set(techniques)],
            techniqueStringNumbers: techniqueStringNumber === null ? [] : [techniqueStringNumber],
            hasNativeStem,
          })
          currentEventIndex = measureEvents.length - 1
        }
        // Rests, non-TAB notes and regular pitched notes all advance the music cursor.
        cursorQuarter += durationQuarter
      }
      events.push(...measureEvents)
    }
  }
  return events
}

/**
 * Gently balance widths of measures that have the same rhythmic pattern.
 *
 * OSMD sizes measures according to more than rhythm (lyrics, accidentals, chord text,
 * and TAB digits also contribute), so repeated rhythms may come out with noticeably
 * different widths. After the first render, measure the actual graphical bar widths,
 * group measures by their exact onset/duration pattern, and apply one conservative
 * WidthFactor correction toward each group's median width. This is deliberately a
 * single pass with a limited correction so long lyrics or unusual notation can still
 * retain the extra room they need. It runs before custom overlays are drawn and never
 * edits drawBrushMarkers or any arrow coordinates.
 */
function balanceRepeatedRhythmMeasureWidths(
  osmd: any,
  container: HTMLElement,
  events: BrushNoteEvent[],
): boolean {
  const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
  const measureList: any[][] = osmd?.Graphic?.MeasureList ?? osmd?.graphic?.MeasureList ?? []
  if (sourceMeasures.length < 2 || !Array.isArray(measureList) || measureList.length === 0 || events.length === 0) {
    return false
  }

  const eventsByMeasure = new Map<number, BrushNoteEvent[]>()
  for (const event of events) {
    if (!Number.isInteger(event.measureIndex) || event.measureIndex < 0 || event.measureIndex >= sourceMeasures.length) continue
    const list = eventsByMeasure.get(event.measureIndex) ?? []
    list.push(event)
    eventsByMeasure.set(event.measureIndex, list)
  }

  const rhythmGroupBySignature = new Map<string, number[]>()
  for (const [measureIndex, measureEvents] of eventsByMeasure) {
    const ordered = [...measureEvents].sort((a, b) =>
      a.positionQuarter - b.positionQuarter || a.durationQuarter - b.durationQuarter || a.noteType.localeCompare(b.noteType),
    )
    // Ignore pitch, string, fret and strum direction: this groups by rhythmic layout,
    // so the same rhythm stays together even when the harmony changes.
    const signature = ordered.map(event => {
      const onset = Math.round(event.positionQuarter * 1000) / 1000
      const duration = Math.round(event.durationQuarter * 1000) / 1000
      return `${onset}:${duration}:${event.noteType || '?'}`
    }).join('|')
    if (!signature) continue
    const group = rhythmGroupBySignature.get(signature) ?? []
    group.push(measureIndex)
    rhythmGroupBySignature.set(signature, group)
  }

  const svgNamespace = 'http://www.w3.org/2000/svg'
  const widthsByMeasure = new Map<number, number[]>()
  const getMeasureGroup = (graphicalMeasure: any): SVGGraphicsElement | null => {
    const candidates = [
      graphicalMeasure?.VexFlowMeasure?.vfMeasure?.group,
      graphicalMeasure?.VexFlowMeasure?.vfMeasure?.getGroup?.(),
      graphicalMeasure?.VexFlowMeasure?.getGroup?.(),
      graphicalMeasure?.vfMeasure?.group,
      graphicalMeasure?.vfMeasure?.getGroup?.(),
      graphicalMeasure?.getGroup?.(),
    ]
    for (const candidate of candidates) {
      const element = candidate?.element ?? candidate?.el ?? candidate
      if (!element || element.namespaceURI !== svgNamespace || typeof element.getBoundingClientRect !== 'function' || !element.ownerSVGElement) continue
      const measureGroup = typeof element.closest === 'function'
        ? (element.matches?.('g.vf-measure') ? element : element.closest('g.vf-measure'))
        : null
      const normalized = measureGroup ?? element
      if (container.contains(normalized)) return normalized as SVGGraphicsElement
    }
    return null
  }

  for (const row of measureList) {
    if (!Array.isArray(row)) continue
    for (const graphicalMeasure of row) {
      const index = resolveGraphicalMeasureSourceIndex(osmd, graphicalMeasure)
      if (index < 0 || index >= sourceMeasures.length) continue
      const group = getMeasureGroup(graphicalMeasure)
      if (!group) continue
      const width = group.getBoundingClientRect().width
      if (!Number.isFinite(width) || width < 18) continue
      const values = widthsByMeasure.get(index) ?? []
      values.push(width)
      widthsByMeasure.set(index, values)
    }
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    if (!sorted.length) return 0
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  const normalizedWidths = new Map<number, number>()
  for (const [measureIndex, widths] of widthsByMeasure) normalizedWidths.set(measureIndex, median(widths))

  let changed = 0
  const debugGroups: Array<{ count: number; targetPx: number; adjusted: number }> = []
  for (const indices of rhythmGroupBySignature.values()) {
    const entries = [...new Set(indices)].flatMap(index => {
      const width = normalizedWidths.get(index)
      const measure = sourceMeasures[index]
      return width && measure ? [{ index, width, measure }] : []
    })
    if (entries.length < 2) continue
    const target = median(entries.map(entry => entry.width))
    const minWidth = Math.min(...entries.map(entry => entry.width))
    const maxWidth = Math.max(...entries.map(entry => entry.width))
    // Ignore small variations: they are usually natural engraving differences.
    if (target <= 0 || (maxWidth - minWidth) / target < 0.10) continue

    let groupAdjusted = 0
    for (const entry of entries) {
      const desiredRatio = target / entry.width
      const ratio = Math.max(0.88, Math.min(1.12, desiredRatio))
      if (Math.abs(ratio - 1) < 0.035) continue
      const existing = Number(entry.measure.WidthFactor)
      const baseFactor = Number.isFinite(existing) && existing > 0 ? existing : 1
      entry.measure.WidthFactor = Number((baseFactor * ratio).toFixed(4))
      changed++
      groupAdjusted++
    }
    if (groupAdjusted) debugGroups.push({ count: entries.length, targetPx: Number(target.toFixed(1)), adjusted: groupAdjusted })
  }

  if (changed > 0) {
    console.info('[ScoreRoom] Balanced repeated-rhythm measure widths with one conservative pass.', {
      adjustedMeasures: changed,
      groups: debugGroups,
    })
    return true
  }
  return false
}

/**
 * Apply string-aware guitar techniques to the shared OSMD playback timeline. The display
 * arrow direction and audio sweep use the same parsed direction so they remain consistent.
 */
function applyGuitarPerformanceToTimeline(
  timeline: PlaybackTimelineEvent[],
  brushEvents: BrushNoteEvent[],
): { strums: number; legatoNotes: number } {
  let strums = 0
  let legatoNotes = 0
  if (!timeline.length || !brushEvents.length) return { strums, legatoNotes }

  const candidatesByMeasure = new Map<number, Array<{ event: PlaybackTimelineEvent; index: number }>>()
  timeline.forEach((event, index) => {
    if (!Number.isInteger(event.measureIndex) || event.measureIndex < 0) return
    const list = candidatesByMeasure.get(event.measureIndex) ?? []
    list.push({ event, index })
    candidatesByMeasure.set(event.measureIndex, list)
  })

  const sortedBrushEvents = [...brushEvents].sort((a, b) =>
    a.measureIndex - b.measureIndex || a.positionQuarter - b.positionQuarter,
  )
  for (const brush of sortedBrushEvents) {
    if (!brush.fretNotes.length) continue
    const candidates = candidatesByMeasure.get(brush.measureIndex) ?? []
    if (!candidates.length) continue
    const fretMidis = new Set(brush.fretNotes.map(item => item.midi).filter((midi): midi is number => Number.isFinite(midi)))
    let best: { event: PlaybackTimelineEvent; index: number; distance: number; overlap: number } | null = null
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.event.positionQuarter - brush.positionQuarter)
      if (distance > 0.24) continue
      const overlap = fretMidis.size
        ? candidate.event.notes.filter(tone => fretMidis.has(Math.round(tone.midi))).length
        : 0
      if (!best || overlap > best.overlap || (overlap === best.overlap && distance < best.distance)) {
        best = { ...candidate, distance, overlap }
      }
    }
    const hasLegatoTarget = brush.fretNotes.some(item => Boolean(item.articulation) && Number.isFinite(item.midi))
    if (!best || (best.overlap === 0 && !hasLegatoTarget)) continue

    const tonesByMidi = new Map<number, PlaybackTone[]>()
    for (const tone of best.event.notes) {
      const midi = Math.round(tone.midi)
      if (!fretMidis.has(midi)) continue
      const list = tonesByMidi.get(midi) ?? []
      list.push(tone)
      tonesByMidi.set(midi, list)
    }

    const matchedFretNotes = brush.fretNotes.filter(item => item.midi !== undefined && tonesByMidi.has(Math.round(item.midi)))
    // The important h/p destination must remain audible. Some Guitar Pro exports put a
    // written-pitch octave/transposition on the TAB technical note that differs from OSMD's
    // PlaybackNote.MidiKey. If exact MIDI matching failed, use the closest tone at the same
    // event time, but only for an explicit hammer-on/pull-off marker and within two octaves.
    for (const fretNote of brush.fretNotes) {
      if (!fretNote.articulation || !Number.isFinite(fretNote.midi) || tonesByMidi.has(Math.round(fretNote.midi!))) continue
      const closestTarget = [...best.event.notes].sort((a, b) =>
        Math.abs(a.midi - fretNote.midi!) - Math.abs(b.midi - fretNote.midi!),
      )[0]
      if (closestTarget && Math.abs(closestTarget.midi - fretNote.midi!) <= 24) {
        tonesByMidi.set(Math.round(fretNote.midi!), [closestTarget])
        if (!matchedFretNotes.includes(fretNote)) matchedFretNotes.push(fretNote)
      }
    }
    for (const fretNote of matchedFretNotes) {
      const matchedTones = tonesByMidi.get(Math.round(fretNote.midi!)) ?? []
      for (const tone of matchedTones) {
        tone.tabStringNumber = fretNote.stringNumber
        // An explicit h/p target takes precedence over OSMD's tie-continuation suppression.
        // The target note is played from its own attack so a 0->2 hammer-on cannot disappear.
        if (fretNote.articulation) tone.suppressPlayback = false
      }
      if (fretNote.articulation) {
        let priorPitch: number | null = null
        // Find the immediately preceding playable note on this same string. The prior
        // graphical event has already been mapped because brushEvents are source-time sorted.
        for (let priorIndex = best.index - 1; priorIndex >= 0; priorIndex--) {
          const priorEvent = timeline[priorIndex]
          if (priorEvent.time >= best.event.time - 0.001) continue
          const priorTone = priorEvent.notes.find(item => item.tabStringNumber === fretNote.stringNumber)
          if (!priorTone) continue
          priorPitch = priorTone.midi
          // Keep the previous note alive through the transition rather than letting its
          // release envelope create a hole just before the hammer-on/pull-off destination.
          priorTone.durationSeconds += Math.min(0.095, Math.max(0.055, 60 / Math.max(30, best.event.bpm) * 0.13))
          break
        }
        for (const tone of matchedTones) {
          tone.guitarArticulation = fretNote.articulation
          if (priorPitch !== null && Number.isFinite(priorPitch)) tone.guitarLegatoFromMidi = priorPitch
          legatoNotes++
        }
      }
    }

    if (brush.direction && matchedFretNotes.length >= 2) {
      // TAB string 1 is the highest (treble) string; larger numbers are lower strings.
      // The audible sweep follows the displayed arrow, but up- and down-strokes intentionally
      // use different timing and attack profiles so their direction is perceptible by ear.
      const isUpstroke = brush.direction === 'up' // string 6 -> string 1 (bass to treble)
      const strumOrder = [...matchedFretNotes].sort((a, b) => isUpstroke
        ? b.stringNumber - a.stringNumber
        : a.stringNumber - b.stringNumber,
      )
      const beatSeconds = 60 / Math.max(30, best.event.bpm)
      // A strum should read as one fast brush, not a broken-chord arpeggio.
      // Keep the whole string sweep within roughly 22-55 ms at common tempos.
      const spanSeconds = isUpstroke
        ? Math.min(0.042, Math.max(0.022, beatSeconds * 0.055))
        : Math.min(0.055, Math.max(0.032, beatSeconds * 0.075))
      const stepSeconds = spanSeconds / Math.max(1, strumOrder.length - 1)
      strumOrder.forEach((fretNote, index) => {
        const matchedTones = tonesByMidi.get(Math.round(fretNote.midi!)) ?? []
        const progress = index / Math.max(1, strumOrder.length - 1)
        // Upstrokes are lighter and brighter toward the treble; downstrokes are firmer
        // with a fuller bass-string finish. A directional filter reinforces the difference.
        const velocity = isUpstroke
          ? 0.60 + progress * 0.48
          : 0.94 + progress * 0.40
        for (const tone of matchedTones) {
          tone.startOffsetSeconds = index * stepSeconds
          tone.guitarVelocityMultiplier = velocity
          tone.guitarStrumDirection = brush.direction ?? undefined
          tone.isArpeggiated = true
        }
      })
      strums++
    }
  }
  if (strums || legatoNotes) {
    const legatoGlides = timeline.reduce((sum, event) => sum + event.notes.filter(tone =>
      Boolean(tone.guitarArticulation) && Number.isFinite(tone.guitarLegatoFromMidi),
    ).length, 0)
    console.info('[ScoreRoom] Guitar articulation mapping:', { strums, legatoNotes, legatoGlides })
    if (legatoNotes > legatoGlides) {
      console.warn('[ScoreRoom] Some h/p targets were mapped without a previous-pitch glide; target note attacks are still preserved.')
    }
  }
  return { strums, legatoNotes }
}

/**
 * 獲取單個小節中 TAB 弦線的螢幕縱坐標。
 * 不固定為六弦：普通吉他、四/五弦貝斯及七/八弦樂器都從實際 SVG 結構推斷。
 */
function medianPositiveTabGap(values: number[], fallback = 12.5): number {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return fallback
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function getTabLineScreenScale(element: SVGGraphicsElement): number {
  try {
    const matrix = element.getScreenCTM()
    if (!matrix) return 1
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c
    const scale = Math.sqrt(Math.abs(determinant))
    return Number.isFinite(scale) && scale > 0.05 ? Math.min(12, Math.max(0.08, scale)) : 1
  } catch {
    return 1
  }
}

function isLikelyTabStringStroke(path: SVGPathElement): boolean {
  const styleStroke = (() => {
    try { return window.getComputedStyle(path).stroke || '' } catch { return '' }
  })()
  const attrStroke = (path.getAttribute('stroke') || '').trim().toLowerCase()
  const raw = ((attrStroke && attrStroke !== 'none' ? attrStroke : styleStroke) || '').trim().toLowerCase().replace(/\s+/g, '')
  if (raw === '#999999' || raw === '#999' || raw === '#999999ff') return true

  let rgb: number[] | null = null
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const value = hex[1]
    rgb = value.length === 3
      ? value.split('').map(char => parseInt(char + char, 16))
      : [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
  } else {
    const match = raw.match(/^rgba?\((\d+(?:\.\d+)?),?(\d+(?:\.\d+)?),?(\d+(?:\.\d+)?)/)
    if (match) rgb = [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  if (!rgb || rgb.some(value => !Number.isFinite(value))) return false
  // OSMD normally uses #999999 for TAB strings. Accept its equivalent computed RGB
  // form and small neutral-gray variations, but reject black glyphs/ledger lines.
  const max = Math.max(...rgb)
  const min = Math.min(...rgb)
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3
  return average >= 132 && average <= 177 && max - min <= 9
}

/**
 * Get the rendered TAB string-line Y coordinates using geometry instead of fixed
 * pixel assumptions. The width and de-duplication thresholds scale with the measure,
 * allowing narrow bars and zoomed/responsive layouts to retain the correct string map.
 */
function getTabStringLineYs(measureGroup: SVGGElement): number[] {
  const candidates: number[] = []
  const groupRect = measureGroup.getBoundingClientRect()
  const minLineWidth = Math.max(10, Math.min(40, groupRect.width * 0.22))
  const maxLineThickness = Math.max(3.2, Math.min(5.5, groupRect.width * 0.012))

  for (const path of Array.from(measureGroup.querySelectorAll<SVGPathElement>('path'))) {
    if (!isLikelyTabStringStroke(path)) continue
    try {
      const style = window.getComputedStyle(path)
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    } catch { /* geometry remains usable if computed styles are unavailable */ }

    let bounds: DOMRect
    try { bounds = path.getBoundingClientRect() } catch { continue }
    if (bounds.width < minLineWidth || bounds.height > maxLineThickness || bounds.height < 0) continue
    candidates.push(bounds.top + bounds.height / 2)
  }

  candidates.sort((a, b) => a - b)
  const unique: number[] = []
  const duplicateTolerance = Math.max(0.7, Math.min(2.5, groupRect.width * 0.01))
  for (const y of candidates) {
    if (unique.length === 0 || Math.abs(y - unique[unique.length - 1]) > duplicateTolerance) unique.push(y)
  }

  if (unique.length < 4) return unique

  // If a measure group contains more than one grey-line staff, split at gaps much
  // larger than normal string spacing and choose the longest plausible TAB staff.
  const allGaps = unique.slice(1).map((y, i) => y - unique[i]).filter(g => g > 0).sort((a, b) => a - b)
  const smallGapSample = allGaps.slice(0, Math.max(1, Math.ceil(allGaps.length * 0.65)))
  const typicalGap = medianPositiveTabGap(smallGapSample, groupRect.width * 0.03 || 2)
  const clusters: number[][] = []
  let cluster: number[] = []
  for (let i = 0; i < unique.length; i++) {
    if (i > 0 && unique[i] - unique[i - 1] > typicalGap * 2.4) {
      if (cluster.length > 0) clusters.push(cluster)
      cluster = []
    }
    cluster.push(unique[i])
  }
  if (cluster.length > 0) clusters.push(cluster)
  const plausible = clusters.filter(group => group.length >= 4 && group.length <= 12)
  if (plausible.length > 0) {
    plausible.sort((a, b) => b.length - a.length)
    return plausible[0]
  }
  clusters.sort((a, b) => b.length - a.length)
  return clusters[0]?.length >= 3 ? clusters[0] : unique.slice(0, 12)
}

/** Return true only when numeric SVG labels actually sit on the candidate TAB strings. */
function measureHasTabFretDigits(measureGroup: SVGGElement, tabLineYs: number[]): boolean {
  if (tabLineYs.length < 4) return false
  const gap = medianPositiveTabGap(tabLineYs.slice(1).map((y, index) => y - tabLineYs[index]))
  for (const element of Array.from(measureGroup.querySelectorAll<SVGTextElement>('text'))) {
    if (element.closest('[data-score-room-chord-frame]')) continue
    if (!/^\d{1,2}$/.test((element.textContent ?? '').trim())) continue
    try {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const centerY = rect.top + rect.height / 2
      if (tabLineYs.some(y => Math.abs(centerY - y) <= gap * 0.72)) return true
    } catch { /* Ignore labels without readable DOM geometry. */ }
  }
  return false
}

/**
 * 從實際含有 TAB 品位數字的小節取原生節奏符乾中位數長度。
 * 時值竪線長度統一使用該長度；其底端另按小節原生符乾基準對齊，避免落在不同弦位造成視覺長短錯亂。
 */
function getReferenceStemLengthScreen(
  svg: SVGSVGElement,
): number {
  const lengths: number[] = []
  const observedStringGaps: number[] = []

  // Sample stems only from measure groups that actually contain a plausible TAB staff.
  // This prevents a conventional five-line staff in a combined score from setting the
  // custom TAB rhythm-stem length for every measure.
  for (const measure of Array.from(svg.querySelectorAll<SVGGElement>('g.vf-measure'))) {
    const lines = getTabStringLineYs(measure)
    if (lines.length < 4 || !measureHasTabFretDigits(measure, lines)) continue
    const gap = medianPositiveTabGap(lines.slice(1).map((y, index) => y - lines[index]))
    observedStringGaps.push(gap)

    for (const stem of Array.from(measure.querySelectorAll<SVGGElement>('g.vf-stem'))) {
      let bounds: DOMRect
      try { bounds = stem.getBoundingClientRect() } catch { continue }
      if (
        bounds.height >= Math.max(2.5, gap * 1.15) &&
        bounds.height <= gap * 7.2 &&
        bounds.width <= Math.max(3.5, gap * 0.55)
      ) lengths.push(bounds.height)
    }
  }

  if (lengths.length > 0) return medianPositiveTabGap(lengths, 31)

  const fallbackGap = medianPositiveTabGap(observedStringGaps, 12.5)
  // A proportional fallback stays appropriate when a score has no usable native stems.
  return fallbackGap * 2.65
}

/**
 * 繪制 Guitar Pro 的 brush 上掃/下掃箭頭，以及 TAB 的半音符空心圈和四分/二分音符的節奏符乾連接。
 * TAB 數字代替傳統音符頭：四分音符為數字加竪乾，二分音符為數字加空心圈及竪乾。
 */
/**
 * 繪制 Guitar Pro 的 brush 上掃/下掃箭頭，以及 TAB 的半音符空心圈和四分/二分音符時值連接線。
 * 掃弦箭頭繼續使用已驗證正常的符乾定位；圈與連接線改為按實際 TAB 數字和弦號定位，
 * 避免 XML 音符數與 OSMD 符乾數不一致時發生整體錯位。
 */
/**
 * Prevent real TAB fret digits from colliding in densely engraved passages.
 * Only numeric SVG labels positioned on the detected TAB string lines are considered.
 * Original inline font styling is saved once and restored before every recalculation,
 * so repeated resize/zoom redraws never progressively shrink the digits.
 */
function adjustOverlappingTabFretNumbers(
  measureGroup: SVGGElement,
  tabLineYs: number[],
): number {
  const candidateTexts = Array.from(measureGroup.querySelectorAll<SVGTextElement>('text'))

  // Restore our own previous sizing adjustment first, leaving all other CSS unchanged,
  // even if a responsive render temporarily makes the TAB string-line detector uncertain.
  for (const element of candidateTexts) {
    if (element.getAttribute('data-score-room-tab-font-saved') !== 'true') continue
    const originalValue = element.getAttribute('data-score-room-tab-font-original-inline') ?? '__NONE__'
    const originalPriority = element.getAttribute('data-score-room-tab-font-original-priority') ?? ''
    if (originalValue === '__NONE__') element.style.removeProperty('font-size')
    else element.style.setProperty('font-size', originalValue, originalPriority)
  }
  if (tabLineYs.length < 4) return 0
  const gap = medianPositiveTabGap(tabLineYs.slice(1).map((y, index) => y - tabLineYs[index]))

  type FretText = { element: SVGTextElement; lineIndex: number; baseSize: number; factor: number }
  const entries: FretText[] = []
  const maxDistanceFromString = gap * 0.72

  for (const element of candidateTexts) {
    if (element.closest('[data-score-room-chord-frame], [data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem]')) continue
    if (!/^\d{1,2}$/.test((element.textContent ?? '').trim())) continue

    let rect: DOMRect
    try { rect = element.getBoundingClientRect() } catch { continue }
    if (rect.width <= 0 || rect.height <= 0) continue
    const centerY = rect.top + rect.height / 2
    let lineIndex = -1
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < tabLineYs.length; i++) {
      const distance = Math.abs(centerY - tabLineYs[i])
      if (distance < nearestDistance) { nearestDistance = distance; lineIndex = i }
    }
    if (lineIndex < 0 || nearestDistance > maxDistanceFromString) continue

    if (element.getAttribute('data-score-room-tab-font-saved') !== 'true') {
      const computedSize = Number.parseFloat(window.getComputedStyle(element).fontSize)
      if (!Number.isFinite(computedSize) || computedSize <= 0) continue
      element.setAttribute('data-score-room-tab-font-saved', 'true')
      element.setAttribute('data-score-room-tab-font-original-inline', element.style.getPropertyValue('font-size') || '__NONE__')
      element.setAttribute('data-score-room-tab-font-original-priority', element.style.getPropertyPriority('font-size'))
      element.setAttribute('data-score-room-tab-font-original-px', String(computedSize))
    }
    const baseSize = Number(element.getAttribute('data-score-room-tab-font-original-px'))
    if (!Number.isFinite(baseSize) || baseSize <= 0) continue
    entries.push({ element, lineIndex, baseSize, factor: 1 })
  }

  if (entries.length < 2) return 0
  const minimumScale = 0.74
  let adjusted = new Set<SVGTextElement>()

  // A few small passes are enough because only actually intersecting glyph boxes are
  // scaled. Keep the reduction conservative so fingerings remain easy to read.
  for (let pass = 0; pass < 4; pass++) {
    const rects = entries.map(entry => entry.element.getBoundingClientRect())
    const colliding = new Set<number>()
    for (let i = 0; i < entries.length; i++) {
      const a = rects[i]
      for (let j = i + 1; j < entries.length; j++) {
        const b = rects[j]
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (overlapX > 0.75 && overlapY > 0.75) {
          colliding.add(i)
          colliding.add(j)
        }
      }
    }
    if (colliding.size === 0) break

    let changed = false
    for (const index of colliding) {
      const entry = entries[index]
      const nextFactor = Math.max(minimumScale, entry.factor * 0.9)
      if (nextFactor >= entry.factor - 0.0001) continue
      entry.factor = nextFactor
      entry.element.style.setProperty('font-size', `${entry.baseSize * entry.factor}px`, 'important')
      adjusted.add(entry.element)
      changed = true
    }
    if (!changed) break
  }

  if (SCORE_ROOM_VERBOSE_DEBUG && adjusted.size > 0) {
    console.debug('[ScoreRoom] Adaptive TAB fret-number collision adjustment:', {
      measure: measureGroup.getAttribute('id') || 'unknown',
      adjustedDigits: adjusted.size,
      minimumScale: Number(Math.min(...entries.map(entry => entry.factor)).toFixed(2)),
    })
  }
  return adjusted.size
}

function drawBrushMarkers(
  container: HTMLElement,
  events: BrushNoteEvent[],
): void {
  const svg = container.querySelector('svg')
  if (!svg) return

  // Restore native stems hidden in the prior overlay pass before recalculating positions.
  // This makes the two-digit TAB fix reversible across zoom, resize and repeated redraws.
  svg.querySelectorAll<SVGGElement>('g[data-manbanpai-hidden-native-tab-stem="1"]').forEach(stem => {
    const attrOpacity = stem.getAttribute('data-manbanpai-native-stem-opacity') ?? '__NONE__'
    const styleOpacity = stem.getAttribute('data-manbanpai-native-stem-style-opacity') ?? '__NONE__'
    const stylePriority = stem.getAttribute('data-manbanpai-native-stem-style-priority') ?? ''
    if (attrOpacity === '__NONE__') stem.removeAttribute('opacity')
    else stem.setAttribute('opacity', attrOpacity)
    if (styleOpacity === '__NONE__') stem.style.removeProperty('opacity')
    else stem.style.setProperty('opacity', styleOpacity, stylePriority)
    stem.removeAttribute('data-manbanpai-hidden-native-tab-stem')
    stem.removeAttribute('data-manbanpai-native-stem-opacity')
    stem.removeAttribute('data-manbanpai-native-stem-style-opacity')
    stem.removeAttribute('data-manbanpai-native-stem-style-priority')
  })

  svg.querySelectorAll<SVGTextElement>('text[data-manbanpai-hidden-for-slap-x="1"]').forEach(textNode => {
    const originalOpacity = textNode.getAttribute('data-manbanpai-slap-original-opacity') ?? '__NONE__'
    const originalStyleOpacity = textNode.getAttribute('data-manbanpai-slap-original-style-opacity') ?? '__NONE__'
    const originalPriority = textNode.getAttribute('data-manbanpai-slap-original-style-priority') ?? ''
    if (originalOpacity === '__NONE__') textNode.removeAttribute('opacity')
    else textNode.setAttribute('opacity', originalOpacity)
    if (originalStyleOpacity === '__NONE__') textNode.style.removeProperty('opacity')
    else textNode.style.setProperty('opacity', originalStyleOpacity, originalPriority)
    textNode.removeAttribute('data-manbanpai-hidden-for-slap-x')
    textNode.removeAttribute('data-manbanpai-slap-original-opacity')
    textNode.removeAttribute('data-manbanpai-slap-original-style-opacity')
    textNode.removeAttribute('data-manbanpai-slap-original-style-priority')
  })

  // Local build fingerprint: check the actual score SVG while testing in localhost.
  svg.setAttribute('data-manbanpai-reader-build', MANBANPAI_READER_BUILD)
  if (!svg.hasAttribute('data-manbanpai-reader-build-logged')) {
    console.info(`[慢半拍] ${MANBANPAI_READER_BUILD}`)
    svg.setAttribute('data-manbanpai-reader-build-logged', 'true')
  }

  // Restore any temporary chord-label font adjustment before recalculating current bounds.
  svg.querySelectorAll<SVGTextElement>('text[data-manbanpai-chord-font-base-px]').forEach(label => {
    const originalValue = label.getAttribute('data-manbanpai-chord-font-original-inline') ?? '__NONE__'
    const originalPriority = label.getAttribute('data-manbanpai-chord-font-original-priority') ?? ''
    if (originalValue === '__NONE__') label.style.removeProperty('font-size')
    else label.style.setProperty('font-size', originalValue, originalPriority)
  })

  // Custom transforms are restored once by redrawScoreOverlays() before any SVG overlays are rebuilt.

  svg.querySelectorAll(
    '[data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem], [data-score-room-percussive-x]',
  ).forEach(element => element.remove())

  if (events.length === 0 || !events.some(event => event.fretNotes.length > 0 || event.techniques.length > 0)) return

  const measureGroups = Array.from(
    svg.querySelectorAll<SVGGElement>('g.vf-measure'),
  )
  if (measureGroups.length === 0) {
    console.warn('[ScoreRoom] Brush markers skipped: no rendered measure groups.')
    return
  }

  const eventsByMeasure = new Map<string, BrushNoteEvent[]>()
  for (const event of events) {
    const list = eventsByMeasure.get(event.measureNumber) ?? []
    list.push(event)
    eventsByMeasure.set(event.measureNumber, list)
  }

  const NS = 'http://www.w3.org/2000/svg'

  function addPath(
    group: SVGGElement,
    points: DOMPoint[],
    width = 1.25,
  ): void {
    if (points.length === 0) return
    const d = points.map((point, index) =>
      `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`,
    ).join(' ')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', '#24251f')
    path.setAttribute('stroke-width', String(width))
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    group.appendChild(path)
  }

  type TabFretHit = {
    element: SVGTextElement
    value: string
    stringNumber: number
    centerX: number
    centerY: number
    width: number
    height: number
  }

  type TabFretColumn = {
    x: number
    hits: TabFretHit[]
  }

  /**
   * 從目前小節的 SVG 文字裡找出真正位於六根 TAB 弦線上的數字，
   * 再按螢幕橫坐標聚合為每個發聲音符/和弦的一列。
   */
  function getTabFretColumns(
    measureGroup: SVGGElement,
    tabLineYs: number[],
  ): TabFretColumn[] {
    if (tabLineYs.length < 4) return []

    // IMPORTANT: all measurements below are in screen pixels. OSMD rebuilds the
    // engraving when zoom changes, so fixed pixel thresholds can merge columns at
    // 90% but split the same chord at 100%/110%. Derive the thresholds from the
    // actual spacing between the six TAB strings so event-to-column matching is
    // invariant across zoom levels.
    const stringGaps = tabLineYs
      .slice(1)
      .map((y, index) => y - tabLineYs[index])
      .filter(gap => Number.isFinite(gap) && gap > 0)
      .sort((a, b) => a - b)
    const medianStringGap = stringGaps.length === 0
      ? 12.5
      : stringGaps.length % 2 === 0
        ? (stringGaps[stringGaps.length / 2 - 1] + stringGaps[stringGaps.length / 2]) / 2
        : stringGaps[Math.floor(stringGaps.length / 2)]
    const maxDistanceFromStringLine = medianStringGap * 0.72
    // Same-onset TAB digits share a horizontal anchor. Use a conservative
    // clustering tolerance so closely spaced sixteenth-note attacks are not
    // merged into one column at 100%/110% zoom. The tolerance scales with the
    // actual line spacing, but neighboring events on the same string are never
    // allowed into a single column (see the grouping check below).
    const sameColumnTolerance = medianStringGap * 0.28

    const hits: TabFretHit[] = []

    for (const element of Array.from(
      measureGroup.querySelectorAll<SVGTextElement>('text'),
    )) {
      if (element.closest('[data-score-room-chord-frame]')) continue

      const value = (element.textContent ?? '').trim()
      if (!/^\d{1,2}$/.test(value)) continue

      let rect: DOMRect
      try {
        rect = element.getBoundingClientRect()
      } catch {
        continue
      }
      if (rect.width <= 0 || rect.height <= 0) continue

      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      let stringIndex = -1
      let nearestDistance = Number.POSITIVE_INFINITY

      for (let index = 0; index < tabLineYs.length; index++) {
        const distance = Math.abs(centerY - tabLineYs[index])
        if (distance < nearestDistance) {
          nearestDistance = distance
          stringIndex = index
        }
      }

      // 只接受靠近 TAB 弦線的數字，避免把小節號、歌詞里的數字或其他文字誤當作品位。
      if (stringIndex < 0 || nearestDistance > maxDistanceFromStringLine) continue

      hits.push({
        element,
        value,
        stringNumber: stringIndex + 1,
        centerX,
        centerY,
        width: rect.width,
        height: rect.height,
      })
    }

    hits.sort((a, b) => a.centerX - b.centerX)

    const columns: TabFretColumn[] = []
    for (const hit of hits) {
      const last = columns[columns.length - 1]
      const columnAlreadyHasThisString = Boolean(
        last?.hits.some(existing => existing.stringNumber === hit.stringNumber),
      )
      if (
        last &&
        !columnAlreadyHasThisString &&
        Math.abs(hit.centerX - last.x) <= sameColumnTolerance
      ) {
        last.hits.push(hit)
        last.x = last.hits.reduce((sum, item) => sum + item.centerX, 0) /
          last.hits.length
      } else {
        columns.push({ x: hit.centerX, hits: [hit] })
      }
    }

    return columns
  }

  function countEventMatches(
    event: BrushNoteEvent,
    column: TabFretColumn,
  ): number {
    let matches = 0
    for (const expected of event.fretNotes) {
      const found = column.hits.some(
        hit =>
          hit.stringNumber === expected.stringNumber &&
          (expected.isPercussive
            ? (/^(?:x|×)$/i.test(hit.value) || /^\d{1,2}$/.test(hit.value))
            : hit.value === String(expected.fret)),
      )
      if (found) matches++
    }
    return matches
  }

  function findEventColumnMatches(
    measureEvents: BrushNoteEvent[],
    columns: TabFretColumn[],
    preferOrderForAmbiguousMatches = false,
  ): Map<number, { column: TabFretColumn; hits: TabFretHit[] }> {
    const result = new Map<number, { column: TabFretColumn; hits: TabFretHit[] }>()
    const activeEvents = measureEvents
      .map((event, eventIndex) => ({ event, eventIndex }))
      .filter(({ event }) => event.fretNotes.length > 0)

    if (activeEvents.length === 0 || columns.length === 0) return result

    const hitsFor = (event: BrushNoteEvent, column: TabFretColumn) =>
      column.hits.filter(hit =>
        event.fretNotes.some(
          expected =>
            expected.stringNumber === hit.stringNumber &&
            (expected.isPercussive
              ? (/^(?:x|×)$/i.test(hit.value) || /^\d{1,2}$/.test(hit.value))
              : String(expected.fret) === hit.value),
        ),
      )

    // Equal counts can be paired in source order only when the fret signatures also
    // agree. If any same-index pair disagrees, use ordered fret-aware sequence alignment.
    if (activeEvents.length === columns.length && !preferOrderForAmbiguousMatches) {
      activeEvents.forEach(({ event, eventIndex }, columnIndex) => {
        const column = columns[columnIndex]
        const exactHits = hitsFor(event, column)
        // Keep the sequential pairing even if a transposed/altered fret label differs;
        // the column position is more reliable than searching for a repeated number.
        result.set(eventIndex, {
          column,
          hits: exactHits.length > 0 ? exactHits : column.hits,
        })
      })
      return result
    }

    // If OSMD omitted/combined some visible number columns, align the two ordered
    // sequences with dynamic programming. This permits a gap without shifting every
    // subsequent event, unlike the earlier greedy search-from-the-last-match approach.
    const n = activeEvents.length
    const m = columns.length
    const gapPenalty = 3.25
    const dp = Array.from({ length: n + 1 }, () =>
      Array<number>(m + 1).fill(Number.NEGATIVE_INFINITY),
    )
    const back = Array.from({ length: n + 1 }, () =>
      Array<'event' | 'column' | 'match' | null>(m + 1).fill(null),
    )
    dp[0][0] = 0
    for (let i = 1; i <= n; i++) {
      dp[i][0] = dp[i - 1][0] - gapPenalty
      back[i][0] = 'event'
    }
    for (let j = 1; j <= m; j++) {
      dp[0][j] = dp[0][j - 1] - gapPenalty
      back[0][j] = 'column'
    }

    for (let i = 1; i <= n; i++) {
      const event = activeEvents[i - 1].event
      for (let j = 1; j <= m; j++) {
        let best = dp[i - 1][j] - gapPenalty
        let action: 'event' | 'column' | 'match' = 'event'

        const skipColumn = dp[i][j - 1] - gapPenalty
        if (skipColumn > best) {
          best = skipColumn
          action = 'column'
        }

        const column = columns[j - 1]
        const exactHits = hitsFor(event, column)
        if (exactHits.length > 0) {
          const coverage = exactHits.length / Math.max(1, event.fretNotes.length)
          const extraHits = Math.max(0, column.hits.length - exactHits.length)
          // Repeated fret signatures can occur in many scores. Use normalized score
          // order only as a tie-breaker when explicitly requested by the data-driven
          // matcher below; exact string/fret matches remain the primary signal.
          const eventRank = n <= 1 ? 0.5 : (i - 1) / (n - 1)
          const columnRank = m <= 1 ? 0.5 : (j - 1) / (m - 1)
          const orderPenalty = preferOrderForAmbiguousMatches
            ? Math.abs(eventRank - columnRank) * 2.5
            : 0
          const matchScore =
            5 + coverage * 8 + exactHits.length * 1.25 -
            extraHits * 0.5 - orderPenalty
          const paired = dp[i - 1][j - 1] + matchScore
          if (paired >= best) {
            best = paired
            action = 'match'
          }
        }

        dp[i][j] = best
        back[i][j] = action
      }
    }

    let i = n
    let j = m
    while (i > 0 || j > 0) {
      const action = back[i][j]
      if (action === 'match' && i > 0 && j > 0) {
        const { event, eventIndex } = activeEvents[i - 1]
        const column = columns[j - 1]
        const exactHits = hitsFor(event, column)
        result.set(eventIndex, { column, hits: exactHits })
        i--
        j--
      } else if (action === 'event' && i > 0) {
        i--
      } else if (j > 0) {
        j--
      } else {
        break
      }
    }

    return result
  }

  function medianValue(values: number[]): number | null {
    if (values.length === 0) return null
    const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
    if (sorted.length === 0) return null
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]
  }

  /**
   * Build a page-wide reference offset from measures where native stems and TAB
   * columns can be paired reliably. Measures 36 and 43 had been using a separate
   * digit-width-based offset, which placed their arrows several pixels to the right
   * of the other measures. Recalculate this reference after each OSMD render so it
   * follows the current zoom and responsive layout.
   */
  function collectNativeArrowXOffsets(
    measureGroup: SVGGElement,
    measureEvents: BrushNoteEvent[],
  ): number[] {
    const lineYs = getTabStringLineYs(measureGroup)
    if (lineYs.length < 4) return []

    const columns = getTabFretColumns(measureGroup, lineYs)
    if (columns.length === 0) return []

    const matches = findEventColumnMatches(measureEvents, columns, false)
    const renderedStems = Array.from(
      measureGroup.querySelectorAll<SVGGElement>('g.vf-stem'),
    )
      .map((stem, originalIndex) => {
        const bounds = stem.getBoundingClientRect()
        return {
          originalIndex,
          bounds,
          centerX: (bounds.left + bounds.right) / 2,
        }
      })
      .filter(info => info.bounds.height >= 3)
      .sort((a, b) => a.centerX - b.centerX)

    const used = new Set<number>()
    const offsets: number[] = []
    let previousAssignedStemX = Number.NEGATIVE_INFINITY

    for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
      const event = measureEvents[eventIndex]
      const matched = matches.get(eventIndex)
      if (!event.direction || !event.hasNativeStem || !matched) continue

      const candidates = renderedStems.filter(info =>
        !used.has(info.originalIndex) &&
        info.centerX >= previousAssignedStemX - 2 &&
        info.centerX >= matched.column.x - 20,
      )

      let best: typeof renderedStems[number] | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const candidate of candidates) {
        const distance = Math.abs(candidate.centerX - matched.column.x)
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }

      if (best && bestDistance <= 18) {
        used.add(best.originalIndex)
        previousAssignedStemX = best.centerX
        offsets.push(best.bounds.right + 3.3 - matched.column.x)
      }
    }

    return offsets
  }

  /**
   * Collect native arrow-center Y positions relative to the top TAB string line.
   * The relative offset is stable across systems whose absolute page Y differs.
   */
  function collectNativeArrowYOffsets(
    measureGroup: SVGGElement,
    measureEvents: BrushNoteEvent[],
  ): number[] {
    const lineYs = getTabStringLineYs(measureGroup)
    if (lineYs.length < 4) return []

    const columns = getTabFretColumns(measureGroup, lineYs)
    if (columns.length === 0) return []

    const matches = findEventColumnMatches(measureEvents, columns, false)
    const renderedStems = Array.from(
      measureGroup.querySelectorAll<SVGGElement>('g.vf-stem'),
    )
      .map((stem, originalIndex) => {
        const bounds = stem.getBoundingClientRect()
        return {
          originalIndex,
          bounds,
          centerX: (bounds.left + bounds.right) / 2,
        }
      })
      .filter(info => info.bounds.height >= 3)
      .sort((a, b) => a.centerX - b.centerX)

    const used = new Set<number>()
    const offsets: number[] = []
    let previousAssignedStemX = Number.NEGATIVE_INFINITY

    for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
      const event = measureEvents[eventIndex]
      const matched = matches.get(eventIndex)
      if (!event.direction || !event.hasNativeStem || !matched) continue

      const candidates = renderedStems.filter(info =>
        !used.has(info.originalIndex) &&
        info.centerX >= previousAssignedStemX - 2 &&
        info.centerX >= matched.column.x - 20,
      )

      let best: typeof renderedStems[number] | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const candidate of candidates) {
        const distance = Math.abs(candidate.centerX - matched.column.x)
        if (distance < bestDistance) {
          best = candidate
          bestDistance = distance
        }
      }

      if (best && bestDistance <= 18) {
        used.add(best.originalIndex)
        previousAssignedStemX = best.centerX
        offsets.push(
          best.bounds.top + best.bounds.height * 0.52 - lineYs[0],
        )
      }
    }

    return offsets
  }

  // Build a generic reference calibration from measures whose native stems can be
  // matched to TAB events reliably. Sparse/missing stems are detected by coverage,
  // not by specific measure numbers, so the same code works for other imported scores.
  const globalNativeArrowXOffsets: number[] = []
  const globalNativeArrowYOffsets: number[] = []
  for (let measureIndex = 0; measureIndex < measureGroups.length; measureIndex++) {
    const measureGroup = measureGroups[measureIndex]
    const id = measureGroup.getAttribute('id') || String(measureIndex + 1)
    const measureEvents =
      eventsByMeasure.get(id) ?? eventsByMeasure.get(String(measureIndex + 1)) ?? []
    if (measureEvents.length === 0) continue

    const expectedNativeArrowEvents = measureEvents.filter(event =>
      Boolean(event.direction) && event.hasNativeStem && event.fretNotes.length > 0,
    ).length
    if (expectedNativeArrowEvents === 0) continue

    const xOffsets = collectNativeArrowXOffsets(measureGroup, measureEvents)
    const yOffsets = collectNativeArrowYOffsets(measureGroup, measureEvents)
    const minimumReliableSamples = Math.max(1, Math.ceil(expectedNativeArrowEvents * 0.65))

    // If OSMD omitted too many native stems, that measure must not influence the
    // page-wide reference; partial stem sequences can bias the offset away from center.
    if (xOffsets.length >= minimumReliableSamples) globalNativeArrowXOffsets.push(...xOffsets)
    if (yOffsets.length >= minimumReliableSamples) globalNativeArrowYOffsets.push(...yOffsets)
  }
  const globalNativeArrowXOffset = medianValue(globalNativeArrowXOffsets)
  const globalNativeArrowYOffset = medianValue(globalNativeArrowYOffsets)

  let arrowsDrawn = 0
  let halfHeadsDrawn = 0
  let durationStemsDrawn = 0
  let matchedDurationEvents = 0
  let measureCountMismatches = 0
  // Use one page-wide screen-space stem length for every custom duration stem.
  // Round once before drawing so note type/measure cannot alter the visible length.
  const referenceStemLength = Math.round((getReferenceStemLengthScreen(svg) + TAB_DURATION_STEM_EXTRA_LENGTH_SCREEN_PX) * 10) / 10
  const durationStemSegments: Array<{ x: number; topY: number; bottomY: number }> = []
  // Collect real TAB string gaps while each measure is in scope. The section-label
  // collision pass runs after the measure loop, so it must not reference the local
  // `tabLineYs` variable from that loop.
  const observedTabLineGaps: number[] = []

  for (let measureIndex = 0; measureIndex < measureGroups.length; measureIndex++) {
    const measureGroup = measureGroups[measureIndex]
    const id = measureGroup.getAttribute('id') || String(measureIndex + 1)
    const measureEvents =
      eventsByMeasure.get(id) ?? eventsByMeasure.get(String(measureIndex + 1)) ?? []
    if (measureEvents.length === 0) continue

    // Convert measured screen-space positions into this measure group's local
    // coordinate system, not the root SVG's coordinate system. Each measure is
    // translated/repositioned when OSMD reflows the systems; parenting overlays to
    // the measure and using its own CTM keeps arrows anchored through viewport changes.
    const measureScreenCtm = measureGroup.getScreenCTM()
    if (!measureScreenCtm) continue
    let measureInverse: DOMMatrix
    try {
      measureInverse = measureScreenCtm.inverse()
    } catch {
      continue
    }
    function toMeasurePoint(screenX: number, screenY: number): DOMPoint {
      const point = svg.createSVGPoint()
      point.x = screenX
      point.y = screenY
      return point.matrixTransform(measureInverse)
    }

    const stems = Array.from(
      measureGroup.querySelectorAll<SVGGElement>('g.vf-stem'),
    )
    const tabLineYs = getTabStringLineYs(measureGroup)
    for (let lineIndex = 1; lineIndex < tabLineYs.length; lineIndex++) {
      const gap = tabLineYs[lineIndex] - tabLineYs[lineIndex - 1]
      if (Number.isFinite(gap) && gap > 0) observedTabLineGaps.push(gap)
    }
    const tabLineGap = tabLineYs.length > 1
      ? (tabLineYs[tabLineYs.length - 1] - tabLineYs[0]) / (tabLineYs.length - 1)
      : 12.5
    // One common guide for every quarter/half duration stem in this rendered system:
    // all line tops and bottoms align above the six TAB strings, rather than varying
    // with the string occupied by each fret digit.
    const sharedTabStemEndY = tabLineYs.length >= 4
      ? tabLineYs[0] - TAB_DURATION_STEM_GAP_SCREEN_PX
      : Number.NaN
    const sharedTabStemStartY = sharedTabStemEndY - referenceStemLength

    const stemEvents = measureEvents.filter(event => event.hasNativeStem)
    if (stems.length !== stemEvents.length) {
      measureCountMismatches++
      console.warn('[ScoreRoom] Brush markers: native stem/event count differs; arrows are aligned by TAB column where possible.', {
        measure: id,
        xmlStemEvents: stemEvents.length,
        renderedStems: stems.length,
      })
    }

    // Align brush directions using the already-detected TAB number columns.
    // The old implementation paired XML events and rendered stems by array index;
    // a missing/extra rendered stem shifted every subsequent up/down arrow.
    const columns = tabLineYs.length >= 4
      ? getTabFretColumns(measureGroup, tabLineYs)
      : []
    const activeEvents = measureEvents.filter(event => event.fretNotes.length > 0)
    const preferOrderForAmbiguousMatches = activeEvents.length === columns.length &&
      activeEvents.some((event, index) => countEventMatches(event, columns[index]) === 0)
    const eventMatches = columns.length > 0
      ? findEventColumnMatches(
          measureEvents,
          columns,
          preferOrderForAmbiguousMatches,
        )
      : new Map<number, { column: TabFretColumn; hits: TabFretHit[] }>()

    // Arrow matching has a separate fallback from duration-circle matching. A few
    // Guitar Pro exports contain valid brush processing instructions on notes whose
    // fret labels did not match perfectly in the rendered SVG; do not silently drop
    // those arrows. Keep exact matches first, then fill only unmatched brush events
    // from the nearest unused column in score order.
    const arrowColumnMatches = new Map(eventMatches)

    // Do not remap every event linearly across a measure: rhythmic columns are not
    // evenly spaced. Fill unmatched brush events between their nearest matched neighbors.

    if (columns.length > 0) {
      const usedArrowColumns = new Set(
        Array.from(arrowColumnMatches.values()).map(match => match.column),
      )
      const missingBrushIndices = measureEvents
        .map((event, eventIndex) => ({ event, eventIndex }))
        .filter(({ event, eventIndex }) =>
          Boolean(event.direction) &&
          event.fretNotes.length > 0 &&
          !arrowColumnMatches.has(eventIndex),
        )
        .map(item => item.eventIndex)

      const averageColumnGap = columns.length > 1
        ? (columns[columns.length - 1].x - columns[0].x) / (columns.length - 1)
        : 0

      for (const eventIndex of missingBrushIndices) {
        let previous: { eventIndex: number; x: number } | null = null
        let next: { eventIndex: number; x: number } | null = null

        for (const [mappedEventIndex, match] of arrowColumnMatches) {
          if (mappedEventIndex < eventIndex &&
              (!previous || mappedEventIndex > previous.eventIndex)) {
            previous = { eventIndex: mappedEventIndex, x: match.column.x }
          } else if (mappedEventIndex > eventIndex &&
                     (!next || mappedEventIndex < next.eventIndex)) {
            next = { eventIndex: mappedEventIndex, x: match.column.x }
          }
        }

        let targetX: number
        if (previous && next) {
          const fraction = (eventIndex - previous.eventIndex) /
            (next.eventIndex - previous.eventIndex)
          targetX = previous.x + (next.x - previous.x) * fraction
        } else if (previous) {
          targetX = previous.x + averageColumnGap * (eventIndex - previous.eventIndex)
        } else if (next) {
          targetX = next.x - averageColumnGap * (next.eventIndex - eventIndex)
        } else {
          const positionRatio = measureEvents.length > 1
            ? eventIndex / (measureEvents.length - 1)
            : 0
          targetX = columns[0].x +
            (columns[columns.length - 1].x - columns[0].x) * positionRatio
        }

        const available = columns.filter(column => !usedArrowColumns.has(column))
        const preferred = available.filter(column =>
          (!previous || column.x > previous.x + 0.5) &&
          (!next || column.x < next.x - 0.5),
        )
        const choices = preferred.length > 0
          ? preferred
          : available.length > 0
            ? available
            : columns

        let selected = choices[0]
        for (const column of choices) {
          if (Math.abs(column.x - targetX) < Math.abs(selected.x - targetX)) {
            selected = column
          }
        }
        arrowColumnMatches.set(eventIndex, {
          column: selected,
          hits: selected.hits,
        })
        usedArrowColumns.add(selected)
      }
    }


    // Slide marks are appended after other markers in the current measure so a muted
    // notehead/X cannot paint over a simultaneous headless/tail-less slide.
    const deferredSlideMarkers: SVGGElement[] = []
    const drawTechniqueLabel = (eventIndex: number, technique: string, screenX: number, screenY: number, anchorHalfWidth = Math.max(1.6, tabLineGap * 0.18)) => {
      const markerId = `${id}-${eventIndex}-${technique}-${Math.round(screenX)}`
      if (technique.startsWith('SLIDE_')) {
        const group = document.createElementNS(NS, 'g')
        group.setAttribute('data-score-room-technique-marker', markerId)
        group.setAttribute('pointer-events', 'none')
        group.setAttribute('aria-hidden', 'true')
        // Keep the slash outside the note/mute glyph: slide-in approaches its left edge,
        // slide-out begins at its right edge. Generic <slide> markers use a neutral below line.
        const isIn = technique.startsWith('SLIDE_IN_')
        const isAbove = technique.endsWith('_ABOVE')
        const dx = Math.max(3.8, Math.min(5.8, tabLineGap * 0.42))
        const dy = Math.max(2.2, Math.min(3.8, tabLineGap * 0.28))
        const edgeGap = Math.max(1.0, anchorHalfWidth)
        const x1 = isIn ? screenX - edgeGap - dx : screenX + edgeGap
        const x2 = isIn ? screenX - edgeGap : screenX + edgeGap + dx
        const y1 = isAbove ? screenY - dy : screenY + dy
        const p1 = toMeasurePoint(x1, y1)
        const p2 = toMeasurePoint(x2, screenY)
        const d = `M${p1.x} ${p1.y} L${p2.x} ${p2.y}`
        const outline = document.createElementNS(NS, 'path')
        outline.setAttribute('d', d)
        outline.setAttribute('fill', 'none')
        outline.setAttribute('stroke', '#fffdf6')
        outline.setAttribute('stroke-width', '2.7')
        outline.setAttribute('stroke-linecap', 'round')
        group.appendChild(outline)
        const ink = document.createElementNS(NS, 'path')
        ink.setAttribute('d', d)
        ink.setAttribute('fill', 'none')
        ink.setAttribute('stroke', '#24251f')
        ink.setAttribute('stroke-width', '1.25')
        ink.setAttribute('stroke-linecap', 'round')
        group.appendChild(ink)
        deferredSlideMarkers.push(group)
        return
      }
      const point = toMeasurePoint(screenX, screenY)
      const label = document.createElementNS(NS, 'text')
      label.setAttribute('data-score-room-technique-marker', markerId)
      label.setAttribute('x', String(point.x))
      label.setAttribute('y', String(point.y))
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('font-size', String(Math.max(6, Math.min(8.5, tabLineGap * 0.52))))
      label.setAttribute('font-weight', '700')
      label.setAttribute('fill', '#24251f')
      label.setAttribute('stroke', '#fffdf6')
      label.setAttribute('stroke-width', '1.5')
      label.setAttribute('paint-order', 'stroke')
      label.setAttribute('pointer-events', 'none')
      label.setAttribute('aria-hidden', 'true')
      label.textContent = technique === 'S' ? '×' : technique
      measureGroup.appendChild(label)
    }

    const drawPercussiveX = (eventIndex: number, stringNumber: number, screenX: number, screenY: number) => {
      const point = toMeasurePoint(screenX, screenY)
      const label = document.createElementNS(NS, 'text')
      label.setAttribute('data-score-room-percussive-x', `${id}-${eventIndex}-${stringNumber}-${Math.round(screenX)}`)
      label.setAttribute('x', String(point.x))
      label.setAttribute('y', String(point.y + tabLineGap * 0.28))
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('dominant-baseline', 'central')
      label.setAttribute('font-family', 'Arial, sans-serif')
      label.setAttribute('font-size', String(Math.max(9.5, Math.min(13.5, tabLineGap * 0.92))))
      label.setAttribute('font-weight', '800')
      label.setAttribute('fill', '#24251f')
      label.setAttribute('stroke', '#fffdf6')
      label.setAttribute('stroke-width', '1.1')
      label.setAttribute('paint-order', 'stroke')
      label.setAttribute('pointer-events', 'none')
      label.setAttribute('aria-hidden', 'true')
      label.textContent = '×'
      measureGroup.appendChild(label)
    }

    const hideFretGlyphForSlap = (element: SVGTextElement) => {
      if (element.getAttribute('data-manbanpai-hidden-for-slap-x') === '1') return
      element.setAttribute('data-manbanpai-hidden-for-slap-x', '1')
      element.setAttribute('data-manbanpai-slap-original-opacity', element.hasAttribute('opacity') ? element.getAttribute('opacity') ?? '' : '__NONE__')
      element.setAttribute('data-manbanpai-slap-original-style-opacity', element.style.getPropertyValue('opacity') || '__NONE__')
      element.setAttribute('data-manbanpai-slap-original-style-priority', element.style.getPropertyPriority('opacity'))
      element.setAttribute('opacity', '0')
      element.style.setProperty('opacity', '0', 'important')
    }


    type RenderedStemInfo = {
      stem: SVGGElement
      originalIndex: number
      bounds: DOMRect
      centerX: number
    }

    const renderedStemInfos: RenderedStemInfo[] = stems
      .map((stem, originalIndex) => {
        const bounds = stem.getBoundingClientRect()
        return {
          stem,
          originalIndex,
          bounds,
          centerX: (bounds.left + bounds.right) / 2,
        }
      })
      .filter(info => info.bounds.height >= 3)
      .sort((a, b) => a.centerX - b.centerX)

    const stemForEvent = new Map<number, RenderedStemInfo>()
    const usedStemIndices = new Set<number>()
    let previousAssignedStemX = Number.NEGATIVE_INFINITY

    if (columns.length > 0 && eventMatches.size > 0) {
      // Match every event with a fret column, including events without a brush mark,
      // so an unmarked note still keeps the following brush marks in the right order.
      for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
        const event = measureEvents[eventIndex]
        const matched = arrowColumnMatches.get(eventIndex)
        if (!matched || !event.hasNativeStem) continue

        const candidates = renderedStemInfos.filter(info =>
          !usedStemIndices.has(info.originalIndex) &&
          info.centerX >= previousAssignedStemX - 2 &&
          info.centerX >= matched.column.x - 20,
        )

        let best: RenderedStemInfo | null = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const candidate of candidates) {
          const distance = Math.abs(candidate.centerX - matched.column.x)
          if (distance < bestDistance) {
            best = candidate
            bestDistance = distance
          }
        }

        // Native TAB stems normally align within a few pixels of the fret-number
        // column. If they do not, leave this event unmapped instead of shifting the
        // direction onto a neighboring note.
        if (best && bestDistance <= 18) {
          stemForEvent.set(eventIndex, best)
          usedStemIndices.add(best.originalIndex)
          previousAssignedStemX = best.centerX
        }
      }
    } else {
      // Fallback for scores where a usable TAB staff cannot be detected.
      let stemIndex = 0
      for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
        const event = measureEvents[eventIndex]
        if (!event.hasNativeStem || stemIndex >= renderedStemInfos.length) continue
        stemForEvent.set(eventIndex, renderedStemInfos[stemIndex])
        usedStemIndices.add(renderedStemInfos[stemIndex].originalIndex)
        stemIndex++
      }
    }

    // Keep all brush arrows on one horizontal guide within each measure.
    // Native stem centers and offsets are used only to calculate the shared guide;
    // individual events no longer receive different Y positions based on pitch.
    const nativeArrowCenters: number[] = []
    const nativeArrowXOffsets: number[] = []
    for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
      const event = measureEvents[eventIndex]
      const matched = arrowColumnMatches.get(eventIndex)
      const stemInfo = stemForEvent.get(eventIndex)
      if (!event.direction || !matched || !stemInfo) continue

      nativeArrowCenters.push(
        stemInfo.bounds.top + stemInfo.bounds.height * 0.52,
      )
      nativeArrowXOffsets.push(stemInfo.bounds.right + 3.3 - matched.column.x)
    }

    function median(values: number[]): number | null {
      if (values.length === 0) return null
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle]
    }

    // Choose a calibration per measure from actual evidence. A full local calibration
    // is used when enough native stems matched; otherwise use the robust page median.
    // This automatically handles sparse-stem measures in any imported Guitar Pro file.
    const tabGapValues = tabLineYs.slice(1)
      .map((y, index) => y - tabLineYs[index])
      .filter(gap => Number.isFinite(gap) && gap > 0)
      .sort((a, b) => a - b)
    const medianTabGap = tabGapValues.length === 0
      ? 12.5
      : tabGapValues.length % 2 === 0
        ? (tabGapValues[tabGapValues.length / 2 - 1] + tabGapValues[tabGapValues.length / 2]) / 2
        : tabGapValues[Math.floor(tabGapValues.length / 2)]

    const expectedNativeArrowEvents = measureEvents.filter(event =>
      Boolean(event.direction) && event.hasNativeStem && event.fretNotes.length > 0,
    ).length
    const localArrowXOffset = median(nativeArrowXOffsets)
    const localArrowYOffset = median(
      nativeArrowCenters.map(center => center - (tabLineYs[0] ?? center)),
    )
    const calibrationCoverage = expectedNativeArrowEvents === 0
      ? 1
      : nativeArrowXOffsets.length / expectedNativeArrowEvents
    const offsetOutlierTolerance = Math.max(2.5, medianTabGap * 0.35)
    const hasSparseNativeCalibration =
      expectedNativeArrowEvents > 0 && calibrationCoverage < 0.65
    const hasOutlierXOffset = localArrowXOffset !== null && globalNativeArrowXOffset !== null &&
      Math.abs(localArrowXOffset - globalNativeArrowXOffset) > offsetOutlierTolerance
    const globalXFallback = globalNativeArrowXOffset ?? (medianTabGap * 0.28)
    const globalYFallback = globalNativeArrowYOffset ?? (-1.5 * medianTabGap)
    const hasOutlierYOffset = localArrowYOffset !== null &&
      Math.abs(localArrowYOffset - globalYFallback) > offsetOutlierTolerance
    const useGlobalArrowCalibration =
      hasSparseNativeCalibration || hasOutlierXOffset || hasOutlierYOffset ||
      localArrowXOffset === null || localArrowYOffset === null

    const referenceArrowCenterY = tabLineYs.length >= 4
      ? tabLineYs[0] + (useGlobalArrowCalibration
          ? globalYFallback
          : (localArrowYOffset ?? globalYFallback))
      : Number.NaN
    const referenceArrowXOffset = useGlobalArrowCalibration
      ? globalXFallback
      : localArrowXOffset ?? globalXFallback

    if (SCORE_ROOM_VERBOSE_DEBUG && useGlobalArrowCalibration) {
      console.debug('[ScoreRoom] Using global arrow calibration for sparse/outlier measure:', {
        measure: id,
        expectedNativeArrowEvents,
        nativeArrowSamples: nativeArrowXOffsets.length,
        calibrationCoverage: Number(calibrationCoverage.toFixed(2)),
        localArrowXOffset: localArrowXOffset === null ? null : Number(localArrowXOffset.toFixed(2)),
        selectedArrowXOffset: Number(referenceArrowXOffset.toFixed(2)),
        localArrowYOffset: localArrowYOffset === null ? null : Number(localArrowYOffset.toFixed(2)),
        selectedArrowYOffset: Number((referenceArrowCenterY - (tabLineYs[0] ?? 0)).toFixed(2)),
      })
    }

    let arrowsFallbackToTab = 0
    let arrowsSkippedNoPosition = 0
    for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
      const event = measureEvents[eventIndex]
      if (!event.direction) continue

      const matched = arrowColumnMatches.get(eventIndex)
      const stemInfo = stemForEvent.get(eventIndex)
      let arrowX: number
      let centerY: number

      if (matched) {
        // One constant X offset for every note column prevents the first fallback arrow
        // from sitting at a different horizontal position than arrows with native stems.
        arrowX = matched.column.x + referenceArrowXOffset
        centerY = referenceArrowCenterY
        if (!stemInfo) arrowsFallbackToTab++
      } else if (stemInfo) {
        // Rare fallback if a rendered stem exists but its TAB number column was not matched.
        arrowX = stemInfo.bounds.right + 3.3
        centerY = referenceArrowCenterY
      } else {
        arrowsSkippedNoPosition++
        continue
      }

      if (!Number.isFinite(centerY)) {
        arrowsSkippedNoPosition++
        continue
      }

      const shaftTop = toMeasurePoint(arrowX, centerY - 4.2)
      const shaftBottom = toMeasurePoint(arrowX, centerY + 4.2)
      const isUp = event.direction === 'up'
      const tip = isUp ? shaftTop : shaftBottom
      const tail = isUp ? shaftBottom : shaftTop
      const wingY = isUp ? centerY - 1.7 : centerY + 1.7
      const wingLeft = toMeasurePoint(arrowX - 2.1, wingY)
      const wingRight = toMeasurePoint(arrowX + 2.1, wingY)

      const group = document.createElementNS(NS, 'g')
      group.setAttribute('data-score-room-brush-marker', `${id}-${eventIndex}-${event.direction}`)
      group.setAttribute('pointer-events', 'none')
      group.setAttribute('aria-hidden', 'true')
      addPath(group, [tail, tip])
      addPath(group, [wingLeft, tip, wingRight])
      measureGroup.appendChild(group)
      arrowsDrawn++
    }

    if (useGlobalArrowCalibration) {
      const finalArrowPositions = Array.from(
        measureGroup.querySelectorAll<SVGGElement>('[data-score-room-brush-marker]'),
      ).map(element => {
        const rect = element.getBoundingClientRect()
        return {
          marker: element.getAttribute('data-score-room-brush-marker'),
          screenX: Number(((rect.left + rect.right) / 2).toFixed(2)),
          screenY: Number(((rect.top + rect.bottom) / 2).toFixed(2)),
        }
      })
      if (SCORE_ROOM_VERBOSE_DEBUG) console.debug('[ScoreRoom] Final arrow screen positions (global calibration):', {
        measure: id,
        viewportWidth: window.innerWidth,
        svgWidth: Number(svg.getBoundingClientRect().width.toFixed(2)),
        measureWidth: Number(measureGroup.getBoundingClientRect().width.toFixed(2)),
        selectedArrowXOffset: Number(referenceArrowXOffset.toFixed(2)),
        referenceArrowCenterY: Number(referenceArrowCenterY.toFixed(2)),
        tabTopLineY: tabLineYs[0] ?? null,
        arrows: finalArrowPositions,
      })
    }

    // 圈和時值竪線按實際顯示的 TAB 數字定位。
    if (tabLineYs.length < 4) {
      console.warn('[ScoreRoom] TAB duration overlays skipped: could not identify at least four string lines.', {
        measure: id,
        detectedStringLines: tabLineYs.length,
      })
      continue
    }

    if (SCORE_ROOM_VERBOSE_DEBUG) console.debug('[ScoreRoom] Brush event alignment:', {
      measure: id,
      xmlEvents: measureEvents.length,
      tabColumns: columns.length,
      durationMatchedEvents: eventMatches.size,
      arrowMatchedEvents: arrowColumnMatches.size,
      brushArrowsFallbackToTab: arrowsFallbackToTab,
      brushArrowsSkippedNoPosition: arrowsSkippedNoPosition,
      tabStringSpacingPx: Number(
        (tabLineYs.slice(1).reduce((sum, y, index) => sum + (y - tabLineYs[index]), 0) /
          Math.max(1, tabLineYs.length - 1)).toFixed(2),
      ),
    })

    const estimateEventScreenX = (eventIndex: number): number => {
      const exact = eventMatches.get(eventIndex) ?? arrowColumnMatches.get(eventIndex)
      if (exact && Number.isFinite(exact.column.x)) return exact.column.x
      const rankedMatches = Array.from(eventMatches.entries())
        .filter(([, value]) => value.column && Number.isFinite(value.column.x))
        .sort((a, b) => a[0] - b[0])
      let previous: [number, { column: TabFretColumn; hits: TabFretHit[] }] | null = null
      let next: [number, { column: TabFretColumn; hits: TabFretHit[] }] | null = null
      for (const entry of rankedMatches) {
        if (entry[0] < eventIndex) previous = entry
        else if (entry[0] > eventIndex) { next = entry; break }
      }
      const progress = (index: number) => {
        const current = measureEvents[index]
        const total = Math.max(0.001, ...measureEvents.map(item => item.positionQuarter + item.durationQuarter))
        return current.positionQuarter / total
      }
      if (previous && next) {
        const a = progress(previous[0]), b = progress(next[0]), t = progress(eventIndex)
        const ratio = Math.abs(b - a) > 0.0001 ? (t - a) / (b - a) : (eventIndex - previous[0]) / (next[0] - previous[0])
        return previous[1].column.x + (next[1].column.x - previous[1].column.x) * ratio
      }
      const avgGap = columns.length > 1
        ? (columns[columns.length - 1].x - columns[0].x) / Math.max(1, columns.length - 1)
        : Math.max(8, measureGroup.getBoundingClientRect().width / Math.max(2, measureEvents.length + 1))
      if (previous) return previous[1].column.x + avgGap * (progress(eventIndex) - progress(previous[0])) * Math.max(1, measureEvents.length - 1)
      if (next) return next[1].column.x - avgGap * (progress(next[0]) - progress(eventIndex)) * Math.max(1, measureEvents.length - 1)
      const bounds = measureGroup.getBoundingClientRect()
      const ratio = measureEvents.length > 1 ? progress(eventIndex) : 0.5
      return bounds.left + Math.max(0, Math.min(1, ratio)) * bounds.width
    }

    for (let eventIndex = 0; eventIndex < measureEvents.length; eventIndex++) {
      const event = measureEvents[eventIndex]
      const matched = eventMatches.get(eventIndex) ?? arrowColumnMatches.get(eventIndex)
      const eventPercussiveNotes = event.fretNotes.filter(note => note.isPercussive)
      if (eventPercussiveNotes.length > 0) {
        const eventX = estimateEventScreenX(eventIndex)
        for (const percussiveNote of eventPercussiveNotes) {
          const stringY = tabLineYs[Math.min(tabLineYs.length - 1, Math.max(0, percussiveNote.stringNumber - 1))]
          const visibleXHit = matched?.column.hits.find(hit => hit.stringNumber === percussiveNote.stringNumber && /^(?:x|×)$/i.test(hit.value))
          const numericHit = matched?.column.hits.find(hit => hit.stringNumber === percussiveNote.stringNumber && /^\d{1,2}$/.test(hit.value))
          const displayX = visibleXHit?.centerX ?? numericHit?.centerX ?? eventX
          if (!visibleXHit && numericHit) hideFretGlyphForSlap(numericHit.element)
          drawPercussiveX(eventIndex, percussiveNote.stringNumber, displayX, stringY)
        }
      }
      if (!matched || matched.hits.length === 0) {
        // Technique-only notes (especially muted notes carrying slide-out or slide-in)
        // must not disappear just because there is no numeric fret digit to match.
        // Anchor to a simultaneous matched onset first, otherwise interpolate in score time.
        if (event.techniques.length > 0 && columns.length > 0 && tabLineYs.length >= 4) {
          const anchors = Array.from(eventMatches.entries())
            .filter(([index, item]) => item.hits.length > 0 && measureEvents[index])
            .map(([index, item]) => ({ index, time: measureEvents[index].positionQuarter, x: item.column.x, column: item.column }))
            .sort((a, b) => a.time - b.time || a.index - b.index)
          const sameOnset = anchors.filter(anchor => Math.abs(anchor.time - event.positionQuarter) < 0.0001)
          const before = [...anchors].filter(anchor => anchor.time < event.positionQuarter - 0.0001).pop()
          const after = anchors.find(anchor => anchor.time > event.positionQuarter + 0.0001)
          let targetX: number
          let anchorHalfWidth = Math.max(1.6, tabLineGap * 0.18)
          if (sameOnset.length > 0) {
            targetX = sameOnset.reduce((sum, anchor) => sum + anchor.x, 0) / sameOnset.length
            anchorHalfWidth = Math.max(...sameOnset.flatMap(anchor => anchor.column.hits.map(hit => hit.width / 2)), anchorHalfWidth)
          } else if (before && after) {
            const fraction = (event.positionQuarter - before.time) / Math.max(0.0001, after.time - before.time)
            targetX = before.x + (after.x - before.x) * fraction
          } else if (before) targetX = before.x
          else if (after) targetX = after.x
          else targetX = columns[Math.min(columns.length - 1, Math.max(0, Math.round(eventIndex / Math.max(1, measureEvents.length - 1) * (columns.length - 1))))].x

          const tags = [...new Set(event.techniques.map(tag => /^(?:PM|MUTE|MUTED|DAMP)$/i.test(tag) ? 'S' : tag))]
          tags.forEach((tag, index) => {
            const stringNumber = event.techniqueStringNumbers.find(value => value >= 1 && value <= tabLineYs.length)
            if (tag === 'S') {
              const targetNotes = event.fretNotes.length > 0
                ? event.fretNotes
                : [{ stringNumber: stringNumber ?? 1, fret: -1, isPercussive: true } as BrushFretNote]
              for (const targetNote of targetNotes) {
                const targetString = Math.min(tabLineYs.length, Math.max(1, targetNote.stringNumber))
                const stringY = tabLineYs[targetString - 1]
                const nearestHit = columns.flatMap(column => column.hits)
                  .filter(hit => hit.stringNumber === targetString && /^\d{1,2}$/.test(hit.value))
                  .sort((a, b) => Math.abs(a.centerX - targetX) - Math.abs(b.centerX - targetX))[0]
                const x = nearestHit?.centerX ?? targetX
                if (nearestHit) hideFretGlyphForSlap(nearestHit.element)
                drawPercussiveX(eventIndex, targetString, x, stringY)
              }
            } else {
              const tagY = tag.startsWith('SLIDE_')
                ? (stringNumber ? tabLineYs[stringNumber - 1] : tabLineYs[0])
                : tabLineYs[0] - tabLineGap * 0.55
              drawTechniqueLabel(eventIndex, tag, targetX, tagY, anchorHalfWidth)
            }
          })
        }
        continue
      }

      const matchedHits = matched.hits

      // 單音用圓圈；一個同時發聲的和弦，用橢圓包住這一列實際顯示的全部品位數字。
      // 若某個 chord 音符只與部分 XML 品位匹配，繪圈時仍查看該列所有數字，避免只圈住單個成員。
      const shapeHits = event.fretNotes.length > 1
        ? matched.column.hits
        : matchedHits
      if (shapeHits.length === 0) continue

      const techniqueTags = [...new Set([
        ...event.techniques,
        ...event.fretNotes.flatMap(note => note.techniques ?? []),
      ].map(tag => /^(?:PM|MUTE|MUTED|DAMP)$/i.test(tag) ? 'S' : tag))]
      if (techniqueTags.length > 0) {
        const anchorHit = event.fretNotes.length > 0
          ? matched.column.hits.find(hit => event.fretNotes.some(note => note.stringNumber === hit.stringNumber && (note.isPercussive ? /^(?:x|×)$/i.test(hit.value) : String(note.fret) === hit.value))) ?? shapeHits[0]
          : shapeHits[0]
        const techniqueStringNumber = event.techniqueStringNumbers.find(value => value >= 1 && value <= tabLineYs.length)
        techniqueTags.forEach((tag, index) => {
          if (tag === 'S') {
            const targets = event.fretNotes.length > 0
              ? event.fretNotes.map(note => ({
                  note,
                  hit: matched.column.hits.find(hit => hit.stringNumber === note.stringNumber && (note.isPercussive ? /^(?:x|×)$/i.test(hit.value) : String(note.fret) === hit.value)),
                })).filter(item => item.hit)
              : [{ note: null as any, hit: anchorHit }]
            for (const target of targets) {
              if (!target.hit) continue
              if (!target.note?.isPercussive && /^\d{1,2}$/.test(target.hit.value)) hideFretGlyphForSlap(target.hit.element)
              if (!target.note?.isPercussive) drawPercussiveX(eventIndex, target.hit.stringNumber, target.hit.centerX, target.hit.centerY)
            }
          } else {
            const tagY = tag.startsWith('SLIDE_')
              ? (techniqueStringNumber ? tabLineYs[techniqueStringNumber - 1] : anchorHit.centerY)
              : anchorHit.centerY - tabLineGap * 0.56
            drawTechniqueLabel(eventIndex, tag, anchorHit.centerX, tagY, anchorHit.width / 2 + 0.8)
          }
        })
      }

      const minX = Math.min(...shapeHits.map(hit => hit.centerX - hit.width / 2))
      const maxX = Math.max(...shapeHits.map(hit => hit.centerX + hit.width / 2))
      const minY = Math.min(...shapeHits.map(hit => hit.centerY - hit.height / 2))
      const maxY = Math.max(...shapeHits.map(hit => hit.centerY + hit.height / 2))
      // Single-digit stems align to the center of the matched TAB column. For two-digit
      // frets, keep the replacement just outside the glyph to avoid turning 11 into 111.
      const hasTwoDigitFret = shapeHits.some(hit => hit.value.length > 1)
      const shapeCenterX = (minX + maxX) / 2
      // Stem axes stay over the actual rhythmic column, including two-digit frets.
      // Since the replacement stem now lives wholly above the top TAB string, it no longer
      // needs to be shifted left of an '11' glyph to avoid looking like a third digit.
      const centerX = matched.column.x
      const centerY = (minY + maxY) / 2

      // Put augmentation dots next to the upper end of their stem. Quarter/half use the
      // custom stem; shorter values use the matched native stem. Whole notes remain stemless.
      if (event.dots > 0) {
        const dotRadiusScreen = Math.max(1.0, Math.min(1.55, tabLineGap * 0.105))
        const stemSideGap = Math.max(2.0, tabLineGap * 0.16) + TAB_DURATION_DOT_EXTRA_RIGHT_PX
        const nativeStem = stemForEvent.get(eventIndex)
        const customStemEvent = ['quarter', 'half', 'whole'].includes(event.noteType)
        const dotStemTopY = customStemEvent && Number.isFinite(sharedTabStemStartY)
          ? sharedTabStemStartY
          : (nativeStem?.bounds.top ?? centerY - Math.max(4, tabLineGap * 1.2))
        const dotAnchorX = customStemEvent || !Number.isFinite(nativeStem?.centerX)
          ? centerX
          : nativeStem!.centerX
        const dotScreenY = ['breve', 'long'].includes(event.noteType)
          ? centerY
          : dotStemTopY + Math.max(0.25, dotRadiusScreen * 0.2)
        for (let dotIndex = 0; dotIndex < Math.min(2, event.dots); dotIndex++) {
          const dotScreenX = dotAnchorX + stemSideGap + dotIndex * dotRadiusScreen * 2.45
          const dotCenter = toMeasurePoint(dotScreenX, dotScreenY)
          const dotRight = toMeasurePoint(dotScreenX + dotRadiusScreen, dotScreenY)
          const dotDown = toMeasurePoint(dotScreenX, dotScreenY + dotRadiusScreen)
          const dot = document.createElementNS(NS, 'circle')
          dot.setAttribute('data-score-room-dot-marker', `${id}-${eventIndex}-${dotIndex}`)
          dot.setAttribute('cx', String(dotCenter.x))
          dot.setAttribute('cy', String(dotCenter.y))
          dot.setAttribute('r', String((Math.abs(dotRight.x - dotCenter.x) + Math.abs(dotDown.y - dotCenter.y)) / 2))
          dot.setAttribute('fill', '#24251f')
          dot.setAttribute('pointer-events', 'none')
          dot.setAttribute('aria-hidden', 'true')
          measureGroup.appendChild(dot)
        }
      }

      // For half and whole notes, retain the top edge of the hollow circle/ellipse.
      let halfHeadTopScreen: number | null = null

      const isHollowDuration = ['half', 'whole', 'breve', 'long'].includes(event.noteType)
      if (isHollowDuration) {
        const isSingleNumber = event.fretNotes.length === 1 && shapeHits.length === 1
        const maxHitWidth = Math.max(...shapeHits.map(hit => hit.width))
        const maxHitHeight = Math.max(...shapeHits.map(hit => hit.height))
        const shape = document.createElementNS(NS, isSingleNumber ? 'circle' : 'ellipse')

        shape.setAttribute(
          'data-score-room-half-notehead',
          `${id}-${eventIndex}-${isSingleNumber ? 'single' : 'chord'}`,
        )
        shape.setAttribute('fill', 'none')
        shape.setAttribute('stroke', '#24251f')
        shape.setAttribute('stroke-width', '1.1')
        shape.setAttribute('pointer-events', 'none')
        shape.setAttribute('aria-hidden', 'true')

        if (isSingleNumber) {
          // 單個數字為圓：以數字寬高中的較大值為直徑基準，並留少量邊距。
          const radiusScreen = Math.max(maxHitWidth, maxHitHeight) / 2 + 0.7
          halfHeadTopScreen = centerY - radiusScreen
          const center = toMeasurePoint(shapeCenterX, centerY)
          const left = toMeasurePoint(shapeCenterX - radiusScreen, centerY)
          const right = toMeasurePoint(shapeCenterX + radiusScreen, centerY)
          const top = toMeasurePoint(shapeCenterX, centerY - radiusScreen)
          const bottom = toMeasurePoint(shapeCenterX, centerY + radiusScreen)
          const rx = Math.abs(right.x - left.x) / 2
          const ry = Math.abs(bottom.y - top.y) / 2
          shape.setAttribute('cx', String(center.x))
          shape.setAttribute('cy', String(center.y))
          shape.setAttribute('r', String((rx + ry) / 2))
        } else {
          // 多個數字為橢圓：橫向包住數字字寬，縱向包住弦間距。
          const ellipseRxScreen = Math.max(maxHitWidth / 2 + 0.9, (maxX - minX) / 2 + 0.9)
          const ellipseRyScreen = Math.max(maxHitHeight / 2 + 0.9, (maxY - minY) / 2 + 0.9)
          halfHeadTopScreen = centerY - ellipseRyScreen
          const center = toMeasurePoint(shapeCenterX, centerY)
          const left = toMeasurePoint(shapeCenterX - ellipseRxScreen, centerY)
          const right = toMeasurePoint(shapeCenterX + ellipseRxScreen, centerY)
          const top = toMeasurePoint(shapeCenterX, centerY - ellipseRyScreen)
          const bottom = toMeasurePoint(shapeCenterX, centerY + ellipseRyScreen)
          shape.setAttribute('cx', String(center.x))
          shape.setAttribute('cy', String(center.y))
          shape.setAttribute('rx', String(Math.abs(right.x - left.x) / 2))
          shape.setAttribute('ry', String(Math.abs(bottom.y - top.y) / 2))
        }

        measureGroup.appendChild(shape)
        halfHeadsDrawn++
      }

      // Whole, half and quarter TAB durations all use the same custom stem guide above
      // the six-line staff. Breve/long continue to use native engraving only.
      if (['breve', 'long'].includes(event.noteType)) continue
      if (!['quarter', 'half', 'whole'].includes(event.noteType)) continue

      // Whole/half/quarter duration lines share the same fixed start/end guide above the
      // six-line TAB staff, keeping their tips and ends parallel to one another and near
      // the native eighth-note stem height regardless of the fret string.
      const stemEndY = sharedTabStemEndY
      const stemStartY = sharedTabStemStartY
      if (
        !Number.isFinite(stemStartY) ||
        !Number.isFinite(stemEndY) ||
        stemEndY <= stemStartY + 1
      ) continue

      // Hide a native stem only if its visible box truly intersects a two-digit fret glyph.
      // Pairing by event index alone hid some unrelated stems and failed on isolated 11s.
      if (hasTwoDigitFret) {
        const twoDigitHits = shapeHits.filter(hit => hit.value.length > 1)
        for (const hit of twoDigitHits) {
          const glyphBounds = hit.element.getBoundingClientRect()
          for (const nativeStem of stems) {
            if (nativeStem.getAttribute('data-manbanpai-hidden-native-tab-stem') === '1') continue
            const stemBounds = nativeStem.getBoundingClientRect()
            if (stemBounds.width <= 0 || stemBounds.height <= 2) continue
            const overlapX = stemBounds.left < glyphBounds.right - 0.15 && stemBounds.right > glyphBounds.left + 0.15
            const overlapY = stemBounds.top < glyphBounds.bottom && stemBounds.bottom > glyphBounds.top
            if (!overlapX || !overlapY) continue
            nativeStem.setAttribute('data-manbanpai-hidden-native-tab-stem', '1')
            nativeStem.setAttribute('data-manbanpai-native-stem-opacity', nativeStem.hasAttribute('opacity') ? nativeStem.getAttribute('opacity') ?? '' : '__NONE__')
            nativeStem.setAttribute('data-manbanpai-native-stem-style-opacity', nativeStem.style.getPropertyValue('opacity') || '__NONE__')
            nativeStem.setAttribute('data-manbanpai-native-stem-style-priority', nativeStem.style.getPropertyPriority('opacity'))
            nativeStem.setAttribute('opacity', '0')
            nativeStem.style.setProperty('opacity', '0', 'important')
          }
        }
      }

      const durationGroup = document.createElementNS(NS, 'g')
      durationGroup.setAttribute(
        'data-score-room-duration-stem',
        `${id}-${eventIndex}-${event.noteType}`,
      )
      durationGroup.setAttribute('pointer-events', 'none')
      durationGroup.setAttribute('aria-hidden', 'true')
      addPath(
        durationGroup,
        [toMeasurePoint(centerX, stemStartY), toMeasurePoint(centerX, stemEndY)],
        1.5,
      )
      measureGroup.appendChild(durationGroup)
      durationStemSegments.push({
        x: centerX,
        topY: Math.min(stemStartY, stemEndY),
        bottomY: Math.max(stemStartY, stemEndY),
      })
      durationStemsDrawn++
      matchedDurationEvents++
    }
    // Draw slide slashes last in the measure so they remain visible next to/over a same-beat muted fret.
    deferredSlideMarkers.forEach(marker => measureGroup.appendChild(marker))
  }

  // 只在時值竪線實際穿過和弦名稱時，將名稱和其所在的 vf-text 組整體上移。
  // 若指法圖嵌套在同一組內，也隨和弦名稱一起移動。每次重繪前會恢復原變換。
  const chordLabels = Array.from(svg.querySelectorAll<SVGTextElement>('text')).filter(element => {
    if (element.closest('[data-score-room-chord-frame]')) return false
    const text = (element.textContent ?? '').trim()
    return (
      CHORD_SYMBOL_PATTERN.test(text) &&
      element.parentElement?.classList.contains('vf-text') &&
      element.parentElement?.parentElement?.classList.contains('staffline')
    )
  })

  // If two chord labels actually overlap on the same staff row, locally reduce their
  // font sizes. Do not translate whole staff rows or chord frames; source x/y and playback
  // cursor geometry therefore remain unchanged. Original font styles are restored above
  // before each redraw, so repeated zoom/redraw cannot shrink labels cumulatively.
  const chordFontEntries = chordLabels.map(label => {
    let base = Number(label.getAttribute('data-manbanpai-chord-font-base-px'))
    if (!Number.isFinite(base) || base <= 0) {
      base = Number.parseFloat(window.getComputedStyle(label).fontSize)
      if (!Number.isFinite(base) || base <= 0) return null
      label.setAttribute('data-manbanpai-chord-font-base-px', String(base))
      label.setAttribute('data-manbanpai-chord-font-original-inline', label.style.getPropertyValue('font-size') || '__NONE__')
      label.setAttribute('data-manbanpai-chord-font-original-priority', label.style.getPropertyPriority('font-size'))
    }
    return { label, row: label.parentElement?.parentElement ?? null, base, factor: 1 }
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  for (let pass = 0; pass < 7; pass++) {
    const bounds = chordFontEntries.map(entry => entry.label.getBoundingClientRect())
    const colliding = new Set<number>()
    for (let i = 0; i < chordFontEntries.length; i++) {
      for (let j = i + 1; j < chordFontEntries.length; j++) {
        if (chordFontEntries[i].row !== chordFontEntries[j].row) continue
        const a = bounds[i], b = bounds[j]
        if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 0.5) continue
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.75) {
          colliding.add(i); colliding.add(j)
        }
      }
    }
    if (colliding.size === 0) break
    let changed = false
    for (const index of colliding) {
      const entry = chordFontEntries[index]
      const next = Math.max(0.62, entry.factor * 0.88)
      if (next >= entry.factor - 0.0001) continue
      entry.factor = next
      entry.label.style.setProperty('font-size', `${entry.base * next}px`, 'important')
      changed = true
    }
    if (!changed) break
  }

  function moveElementUpByScreenY(element: SVGGraphicsElement, deltaY: number): void {
    moveScoreRoomElementByScreenY(element, deltaY)
  }

  // A chord label collision must move the whole chord row, not only one label.
  // Otherwise one or two chord letters can drift vertically and appear interleaved
  // with a duration stem while the remaining chord names stay on the original baseline.
  type ChordLabelPlacement = {
    label: SVGTextElement
    moveUnit: SVGGraphicsElement
  }
  type ChordLabelRow = {
    topY: number
    stringGap: number
    items: ChordLabelPlacement[]
  }
  const chordLabelRows: ChordLabelRow[] = []

  for (const label of chordLabels) {
    const measure = label.closest('g.vf-measure') as SVGGElement | null
    const stringYs = measure ? getTabStringLineYs(measure) : []
    const rowTopY = stringYs.length >= 4
      ? stringYs[0]
      : label.getBoundingClientRect().bottom
    const stringGap = stringYs.length >= 4
      ? (stringYs[stringYs.length - 1] - stringYs[0]) / (stringYs.length - 1)
      : 8
    const tolerance = Math.max(1.5, stringGap * 0.32)
    let row = chordLabelRows.find(candidate =>
      Math.abs(candidate.topY - rowTopY) <= Math.max(tolerance, candidate.stringGap * 0.32),
    )
    if (!row) {
      row = { topY: rowTopY, stringGap, items: [] }
      chordLabelRows.push(row)
    }

    const parent = label.parentElement
    const moveUnit =
      parent?.localName === 'g' &&
      parent.classList.contains('vf-text') &&
      Array.from(parent.children).some(child => child === label)
        ? parent as unknown as SVGGraphicsElement
        : label as unknown as SVGGraphicsElement

    row.items.push({ label, moveUnit })
  }

  for (const row of chordLabelRows) {
    const units = Array.from(new Set(row.items.map(item => item.moveUnit)))

    // Use one shared vertical offset for all chord labels on the same engraved row.
    // Re-measure after moving because each measure group has its own SVG transform.
    for (let attempt = 0; attempt < 3; attempt++) {
      let requiredUp = 0

      for (const item of row.items) {
        const bounds = getChordVisualBounds(item.label, item.moveUnit)
        const collisions = durationStemSegments.filter(segment =>
          segment.x >= bounds.left - 2.5 &&
          segment.x <= bounds.right + 2.5 &&
          segment.topY < bounds.bottom + 1 &&
          segment.bottomY > bounds.top - 1,
        )
        if (collisions.length === 0) continue

        const highestStemTop = Math.min(...collisions.map(segment => segment.topY))
        const deltaY = highestStemTop - bounds.bottom - 3
        if (deltaY < requiredUp) requiredUp = deltaY
      }

      if (requiredUp >= -0.5) break
      for (const unit of units) moveElementUpByScreenY(unit, requiredUp)
    }
  }

  // Move boxed section headings (e.g. “副歌”) together with their external border
  // when a custom TAB duration stem crosses them. This is run after all lines have
  // been placed, so it works whether chord-diagram display is on or off.
  const sectionPattern = /(前奏|間奏|间奏|尾奏|尾聲|尾声|引子|過門|过门|主歌|副歌|橋段|桥段|A段|B段|C段|Intro|Interlude|Outro|Verse|Chorus|Bridge)/i
  const sectionLabels = Array.from(svg.querySelectorAll<SVGTextElement>('text')).filter(element => {
    if (element.closest('[data-score-room-chord-frame]')) return false
    const text = (element.textContent ?? '')
      .replace(/\s+/g, '')
      .replace(/[：:，,。.!！?？]/g, '')
      .trim()
    return text.length > 0 && sectionPattern.test(text)
  })

  function annotationMoveUnit(label: SVGTextElement): SVGGraphicsElement {
    const parent = label.parentElement
    if (
      parent &&
      parent.localName === 'g' &&
      parent.querySelectorAll('text').length === 1
    ) {
      return parent as unknown as SVGGraphicsElement
    }
    return label as unknown as SVGGraphicsElement
  }

  function findExternalFrameShapes(
    label: SVGTextElement,
    moveUnit: SVGGraphicsElement,
  ): SVGGraphicsElement[] {
    return findSectionAnnotationFrameShapes(
      label,
      moveUnit,
      getSectionAnnotationLineGap(label, pageMedianTabLineGap),
    )
  }

  function elementBoundsWithFrames(
    moveUnit: SVGGraphicsElement,
    externalFrames: SVGGraphicsElement[],
  ): DOMRect {
    const rects = [moveUnit.getBoundingClientRect(), ...externalFrames.map(el => el.getBoundingClientRect())]
    const left = Math.min(...rects.map(rect => rect.left))
    const top = Math.min(...rects.map(rect => rect.top))
    const right = Math.max(...rects.map(rect => rect.right))
    const bottom = Math.max(...rects.map(rect => rect.bottom))
    return new DOMRect(left, top, right - left, bottom - top)
  }

  const sortedObservedTabLineGaps = [...observedTabLineGaps].sort((a, b) => a - b)
  const pageMedianTabLineGap = sortedObservedTabLineGaps.length === 0
    ? 12.5
    : sortedObservedTabLineGaps.length % 2 === 0
      ? (sortedObservedTabLineGaps[sortedObservedTabLineGaps.length / 2 - 1] +
        sortedObservedTabLineGaps[sortedObservedTabLineGaps.length / 2]) / 2
      : sortedObservedTabLineGaps[Math.floor(sortedObservedTabLineGaps.length / 2)]

  for (const label of sectionLabels) {
    const moveUnit = annotationMoveUnit(label)
    const externalFrames = findExternalFrameShapes(label, moveUnit)

    // Pick the closest TAB staff whose rendered measure overlaps this title horizontally.
    // If the title itself enters the six-string band, lift the title and its border together
    // before doing the existing stem/chord collision pass. The chosen band is fixed once per
    // label, preventing repeated upward drift through unrelated systems.
    const startBounds = elementBoundsWithFrames(moveUnit, externalFrames)
    const tabBandCandidates = measureGroups.map(measure => {
      const rect = measure.getBoundingClientRect()
      if (rect.width <= 0 || Math.min(startBounds.right, rect.right) - Math.max(startBounds.left, rect.left) <= 1) return null
      const lines = getTabStringLineYs(measure)
      if (lines.length < 4) return null
      const gaps = lines.slice(1).map((y, index) => y - lines[index]).filter(gap => gap > 0)
      const sortedGaps = [...gaps].sort((a, b) => a - b)
      const gap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : pageMedianTabLineGap
      const bandTop = lines[0]
      const bandBottom = lines[lines.length - 1]
      const overlaps = startBounds.bottom > bandTop - gap * 0.48 && startBounds.top < bandBottom + gap * 0.25
      const distance = overlaps ? 0 : Math.min(Math.abs(startBounds.bottom - bandTop), Math.abs(startBounds.top - bandBottom))
      const horizontalOverlap = Math.min(startBounds.right, rect.right) - Math.max(startBounds.left, rect.left)
      return { bandTop, bandBottom, gap, overlaps, distance, horizontalOverlap }
    }).filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => a.distance - b.distance || b.horizontalOverlap - a.horizontalOverlap)
    const closestBand = tabBandCandidates[0]
    if (closestBand) {
      // Reserve a wider safety band above the TAB staff for section labels and their boxes.
      // The narrower V8.1 clearance allowed some boxed annotations to sit on top of the score.
      const entersScoreClearanceZone =
        startBounds.bottom > closestBand.bandTop - closestBand.gap * 1.6 &&
        startBounds.top < closestBand.bandBottom + closestBand.gap * 0.25
      if (entersScoreClearanceZone) {
        const desiredBottom = closestBand.bandTop - Math.max(10, closestBand.gap * 1.4)
        const shiftUp = desiredBottom - startBounds.bottom
        if (shiftUp < -0.5) {
          moveElementUpByScreenY(moveUnit, shiftUp)
          for (const frame of externalFrames) moveElementUpByScreenY(frame, shiftUp)
        }
      }
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const bounds = elementBoundsWithFrames(moveUnit, externalFrames)
      const stemCollisions = durationStemSegments.filter(segment =>
        segment.x >= bounds.left - 2 &&
        segment.x <= bounds.right + 2 &&
        segment.topY < bounds.bottom + 1 &&
        segment.bottomY > bounds.top - 1,
      )

      const chordVisualBounds = chordLabels.map(chordLabel => {
        const chordUnit = chordLabel.parentElement as unknown as SVGGraphicsElement | null
        return getChordVisualBounds(chordLabel, chordUnit ?? undefined)
      })
      // Use the page's measured median string gap here: the per-measure `tabLineYs`
      // array is out of scope in this post-layout pass. This also scales naturally with zoom.
      const horizontalBand = Math.max(2, 0.35 * pageMedianTabLineGap)
      const chordCollisions = chordVisualBounds.filter(chordBounds =>
        bounds.left <= chordBounds.right + horizontalBand &&
        bounds.right >= chordBounds.left - horizontalBand &&
        bounds.bottom > chordBounds.top - 2 &&
        bounds.top < chordBounds.bottom + 2,
      )

      if (stemCollisions.length === 0 && chordCollisions.length === 0) break

      const highestStemTop = stemCollisions.length > 0
        ? Math.min(...stemCollisions.map(segment => segment.topY))
        : Number.POSITIVE_INFINITY
      const highestChordTop = chordCollisions.length > 0
        ? Math.min(...chordCollisions.map(chordBounds => chordBounds.top))
        : Number.POSITIVE_INFINITY
      const upperBoundary = Math.min(highestStemTop, highestChordTop)
      const deltaY = upperBoundary - bounds.bottom - 4
      if (!Number.isFinite(deltaY) || deltaY >= -0.5) break

      moveElementUpByScreenY(moveUnit, deltaY)
      for (const frame of externalFrames) {
        moveElementUpByScreenY(frame, deltaY)
      }
    }
  }

  if (SCORE_ROOM_VERBOSE_DEBUG) console.info('[ScoreRoom] Brush/duration overlays drawn:', {
    arrowsDrawn,
    halfHeadsDrawn,
    durationStemsDrawn,
    matchedDurationEvents,
    customLayoutElementsMoved: svg.querySelectorAll('[data-score-room-layout-original-transform]').length,
    measureCountMismatches,
  })
}
/**
 * Restore every custom layout translation before a fresh OSMD render or overlay pass.
 * All custom movement helpers share one original-transform marker, so multiple
 * collision passes compose from the same baseline instead of saving one another's
 * already-shifted transforms. Measurements are always re-read from getBoundingClientRect.
 */
function restoreScoreRoomLayoutTransforms(container: HTMLElement): void {
  const svg = container.querySelector('svg')
  if (!svg) return

  // Restore an expanded viewport before any redraw, then discard the temporary marker.
  // The next pass records the dimensions produced by that render, so zoom/resize cannot
  // accumulate old height corrections.
  const viewportMarkers = [
    ['data-score-room-original-viewbox', 'viewBox'],
    ['data-score-room-original-height-attr', 'height'],
    ['data-score-room-original-height-style', 'style-height'],
  ] as const
  for (const [marker, source] of viewportMarkers) {
    const original = svg.getAttribute(marker)
    if (original === null) continue
    if (source === 'style-height') {
      if (original === '__none__') svg.style.removeProperty('height')
      else svg.style.height = original
    } else if (original === '__none__') {
      svg.removeAttribute(source)
    } else {
      svg.setAttribute(source, original)
    }
    svg.removeAttribute(marker)
  }

  const selector = [
    '[data-score-room-layout-original-transform]',
    // Backward compatibility for DOM nodes left by older hot-reload versions.
    '[data-score-room-original-transform]',
    '[data-score-room-brush-original-transform]',
    '[data-score-room-row-clearance-original-transform]',
  ].join(',')

  for (const element of Array.from(svg.querySelectorAll<SVGGraphicsElement>(selector))) {
    const original =
      element.getAttribute('data-score-room-layout-original-transform') ??
      element.getAttribute('data-score-room-original-transform') ??
      element.getAttribute('data-score-room-brush-original-transform') ??
      element.getAttribute('data-score-room-row-clearance-original-transform')

    if (original === '__none__') element.removeAttribute('transform')
    else if (original !== null) element.setAttribute('transform', original)

    element.removeAttribute('data-score-room-layout-original-transform')
    element.removeAttribute('data-score-room-original-transform')
    element.removeAttribute('data-score-room-brush-original-transform')
    element.removeAttribute('data-score-room-row-clearance-original-transform')
  }
}

/** Move an SVG element by a screen-space vertical distance, preserving one canonical base transform. */
function moveScoreRoomElementByScreenY(
  element: SVGGraphicsElement,
  screenDeltaY: number,
): void {
  if (!Number.isFinite(screenDeltaY) || Math.abs(screenDeltaY) < 0.05) return

  const parent = element.parentElement as unknown as SVGGraphicsElement | null
  const parentMatrix = parent?.getScreenCTM()
  const ownerSvg = element.ownerSVGElement
  if (!parent || !parentMatrix || !ownerSvg) return

  try {
    const inverse = parentMatrix.inverse()
    const origin = ownerSvg.createSVGPoint()
    origin.x = 0
    origin.y = 0
    const shifted = ownerSvg.createSVGPoint()
    shifted.x = 0
    shifted.y = screenDeltaY
    const localOrigin = origin.matrixTransform(inverse)
    const localShifted = shifted.matrixTransform(inverse)
    const dx = localShifted.x - localOrigin.x
    const dy = localShifted.y - localOrigin.y

    if (!element.hasAttribute('data-score-room-layout-original-transform')) {
      element.setAttribute(
        'data-score-room-layout-original-transform',
        element.getAttribute('transform') ?? '__none__',
      )
    }

    const currentTransform = element.getAttribute('transform') ?? ''
    element.setAttribute(
      'transform',
      `translate(${dx}, ${dy}) ${currentTransform}`.trim(),
    )
  } catch {
    // If this element cannot be transformed, leave it untouched and preserve the score.
  }
}

function unionScreenRects(rects: DOMRect[]): DOMRect | null {
  const valid = rects.filter(rect =>
    Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) && Number.isFinite(rect.bottom) &&
    rect.right >= rect.left && rect.bottom >= rect.top,
  )
  if (valid.length === 0) return null
  const left = Math.min(...valid.map(rect => rect.left))
  const top = Math.min(...valid.map(rect => rect.top))
  const right = Math.max(...valid.map(rect => rect.right))
  const bottom = Math.max(...valid.map(rect => rect.bottom))
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Normalize the blank gap between consecutive rendered TAB systems.
 * OSMD's MinimumDistanceBetweenSystems is a minimum, not a fixed gap, so lyrics,
 * annotations, and accidentals can still make each gap different. This pass finds the
 * actual row wrapper and translates the whole system (not individual notes or text).
 */
/**
 * Align native measure-number labels to a consistent small gap above the piano's top staff.
 * OSMD places these labels against each measure's skyline. High notes or other objects can
 * push some labels much farther up than others, which looks like the numbers are floating.
 * This pass runs after each render/zoom and uses the rendered staff geometry, not fixed
 * measure-number IDs or a one-time pixel offset.
 */
function alignPianoMeasureNumbersToStaff(container: HTMLElement): void {
  const svg = container.querySelector('svg')
  if (!svg) return

  type StaffTarget = {
    left: number
    right: number
    topY: number
    lineGap: number
  }
  type RawStaffTarget = StaffTarget & { measure: SVGGElement }
  type StaffRow = { members: RawStaffTarget[]; topY: number; lineGap: number }

  const rawTargets: RawStaffTarget[] = []
  const measureGroups = Array.from(svg.querySelectorAll<SVGGElement>('g.vf-measure'))

  // First infer each measure's upper staff from its actual SVG lines. This local pass
  // may see ledger lines as candidates in very high passages, so its result is not used
  // as an independent label baseline. Measure positions are normalized by system row below.
  for (const measure of measureGroups) {
    const measureRect = measure.getBoundingClientRect()
    if (measureRect.width < 20 || measureRect.height <= 0) continue

    const candidateYs: number[] = []
    // Staff lines span most of the measure; ledger lines for high/low notes are
    // usually much shorter. Requiring a longer horizontal span prevents a ledger
    // line from being mistaken for the top staff line and shifting that row's
    // measure numbers up by one staff space.
    const minLineWidth = Math.max(24, measureRect.width * 0.55)
    for (const shape of Array.from(measure.querySelectorAll<SVGGraphicsElement>('path, line, polyline'))) {
      if (shape.closest('[data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem], [data-score-room-chord-frame]')) continue
      const rect = shape.getBoundingClientRect()
      if (rect.width < minLineWidth || rect.height > 3.5 || rect.height < 0) continue
      const style = window.getComputedStyle(shape)
      const stroke = (style.stroke || shape.getAttribute('stroke') || '').toLowerCase()
      if (!stroke || stroke === 'none' || stroke.includes('rgba(0, 0, 0, 0)')) continue
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue
      candidateYs.push(rect.top + rect.height / 2)
    }

    candidateYs.sort((a, b) => a - b)
    const ys: number[] = []
    for (const y of candidateYs) {
      if (ys.length === 0 || Math.abs(y - ys[ys.length - 1]) > 1.4) ys.push(y)
    }
    if (ys.length < 5) continue

    let best: { topY: number; lineGap: number; score: number } | null = null
    for (let i = 0; i <= ys.length - 5; i++) {
      const lines = ys.slice(i, i + 5)
      const gaps = lines.slice(1).map((y, index) => y - lines[index])
      if (gaps.some(gap => gap < 1.2 || gap > 14)) continue
      const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
      const deviation = Math.max(...gaps) - Math.min(...gaps)
      if (mean <= 0 || deviation > Math.max(1.8, mean * 0.42)) continue
      const score = deviation / mean + i * 0.0001
      if (!best || score < best.score) best = { topY: lines[0], lineGap: mean, score }
    }
    if (!best) continue
    rawTargets.push({
      measure,
      left: measureRect.left,
      right: measureRect.right,
      topY: best.topY,
      lineGap: best.lineGap,
    })
  }
  if (rawTargets.length === 0) return

  // Group measures into rendered systems. The tolerance is deliberately wider than one
  // staff space so a ledger-line outlier in a high melody cannot create a false baseline.
  const rows: StaffRow[] = []
  const median = (values: number[]): number => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) return 0
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  }
  for (const target of [...rawTargets].sort((a, b) => a.topY - b.topY || a.left - b.left)) {
    let bestRow: StaffRow | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const row of rows) {
      const tolerance = Math.max(15, (row.lineGap + target.lineGap) * 1.5)
      const distance = Math.abs(row.topY - target.topY)
      if (distance <= tolerance && distance < bestDistance) {
        bestRow = row
        bestDistance = distance
      }
    }
    if (!bestRow) {
      rows.push({ members: [target], topY: target.topY, lineGap: target.lineGap })
    } else {
      bestRow.members.push(target)
      bestRow.topY = median(bestRow.members.map(member => member.topY))
      bestRow.lineGap = median(bestRow.members.map(member => member.lineGap))
    }
  }
  rows.sort((a, b) => a.topY - b.topY)
  const normalizedTargets: StaffTarget[] = rawTargets.map(target => {
    let row = rows[0]
    let distance = Number.POSITIVE_INFINITY
    for (const candidate of rows) {
      const candidateDistance = Math.abs(candidate.topY - target.topY)
      if (candidateDistance < distance) {
        row = candidate
        distance = candidateDistance
      }
    }
    return { left: target.left, right: target.right, topY: row.topY, lineGap: row.lineGap }
  })

  const semanticLabels = Array.from(svg.querySelectorAll<SVGTextElement>('text.measure-number, .measure-number text'))
  const semanticSet = new Set(semanticLabels)
  const fallbackLabels = Array.from(svg.querySelectorAll<SVGTextElement>('text')).filter(label => {
    if (semanticSet.has(label)) return false
    if (!/^\d{1,4}$/.test((label.textContent ?? '').replace(/\s+/g, ' ').trim())) return false
    if (label.closest('g.vf-measure')) return false
    if (label.closest('.vf-text, .vf-tempo, .tempo, .credit, [data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem], [data-score-room-chord-frame]')) return false
    return true
  })
  const labels = Array.from(new Set([...semanticLabels, ...fallbackLabels])).filter(label => {
    const rect = label.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && /^\d{1,4}$/.test((label.textContent ?? '').trim())
  })

  type Placement = { label: SVGTextElement; target: StaffTarget; rect: DOMRect }
  const placements: Placement[] = []
  for (const label of labels) {
    const rect = label.getBoundingClientRect()
    let bestTarget: StaffTarget | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const target of normalizedTargets) {
      const gap = target.topY - rect.bottom
      if (gap < -1.5) continue
      const horizontalDistance = Math.abs(rect.left - target.left)
      const horizontalReach = Math.max(64, (target.right - target.left) * 0.55)
      if (horizontalDistance > horizontalReach) continue
      const score = gap + horizontalDistance * 0.16
      if (score < bestScore) {
        bestScore = score
        bestTarget = target
      }
    }
    if (bestTarget) placements.push({ label, target: bestTarget, rect })
  }
  if (!placements.length) return

  // Use the median of plausible native label-to-staff gaps rather than anchoring
  // every row to a particular printed number such as "2". A single label can be
  // displaced by a high note or an unusual first system; it must not set the offset
  // for the entire score.
  const observedGaps = placements
    .map(item => item.target.topY - item.rect.bottom)
    .filter(gap => Number.isFinite(gap) && gap >= 0.8 && gap <= 12)
  const typicalLineGap = median(placements.map(item => item.target.lineGap))
  const medianObservedGap = observedGaps.length ? median(observedGaps) : Number.NaN
  const desiredGap = Number.isFinite(medianObservedGap)
    ? Math.max(1.8, Math.min(5.2, medianObservedGap))
    : Math.max(2, Math.min(4.2, typicalLineGap * 0.48))

  let moved = 0
  for (const item of placements) {
    const currentGap = item.target.topY - item.label.getBoundingClientRect().bottom
    const deltaY = currentGap - desiredGap
    if (Number.isFinite(deltaY) && Math.abs(deltaY) > 0.7) {
      moveScoreRoomElementByScreenY(item.label, deltaY)
      moved++
    }
  }
  if (moved > 0) {
    console.info('[ScoreRoom] Aligned piano measure numbers to robust shared system-row baselines:', {
      labelsMatched: placements.length,
      labelsMoved: moved,
      systemRows: rows.length,
      targetGapPx: Number(desiredGap.toFixed(2)),
    })
  }
}

function applyUniformSystemRowSpacing(container: HTMLElement): void {
  const svg = container.querySelector('svg')
  if (!svg) return

  type TabMeasure = { element: SVGGElement; topY: number; lineGap: number; left: number }
  type TabRow = {
    measures: SVGGElement[]
    topY: number
    lineGap: number
    root: SVGGraphicsElement | null
  }

  const median = (values: number[]): number | null => {
    const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
    if (sorted.length === 0) return null
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]
  }

  const measures: TabMeasure[] = Array.from(svg.querySelectorAll<SVGGElement>('g.vf-measure'))
    .flatMap(element => {
      const ys = getTabStringLineYs(element)
      if (ys.length < 4) return []
      const gaps = ys.slice(1).map((y, index) => y - ys[index])
      const lineGap = median(gaps) ?? 8
      return [{
        element,
        topY: ys[0],
        lineGap,
        left: element.getBoundingClientRect().left,
      }]
    })
    .sort((a, b) => a.topY - b.topY || a.left - b.left)

  if (measures.length < 2) return

  const rows: TabRow[] = []
  for (const measure of measures) {
    const tolerance = Math.max(2.5, measure.lineGap * 0.4)
    let row = rows.find(candidate =>
      Math.abs(candidate.topY - measure.topY) <= Math.max(tolerance, candidate.lineGap * 0.4),
    )
    if (!row) {
      row = { measures: [], topY: measure.topY, lineGap: measure.lineGap, root: null }
      rows.push(row)
    }
    row.measures.push(measure.element)
    const count = row.measures.length
    row.topY += (measure.topY - row.topY) / count
    row.lineGap += (measure.lineGap - row.lineGap) / count
  }
  rows.sort((a, b) => a.topY - b.topY)
  if (rows.length < 2) return

  // Find the highest ancestor that contains exactly this row's TAB measures and no TAB
  // measure from another row. That normally is the OSMD system wrapper, including its
  // other staves, barlines, headings, and independent border paths.
  const rootsInUse = new Set<SVGGraphicsElement>()
  for (const row of rows) {
    const rowMeasureSet = new Set(row.measures)
    let ancestor: Element | null = row.measures[0].parentElement
    let selected: SVGGraphicsElement | null = null

    while (ancestor && ancestor !== svg) {
      if (ancestor instanceof SVGGraphicsElement) {
        const descendantTabMeasures = Array.from(ancestor.querySelectorAll<SVGGElement>('g.vf-measure'))
          .filter(measure => getTabStringLineYs(measure).length >= 4)
        if (
          descendantTabMeasures.length === row.measures.length &&
          descendantTabMeasures.every(measure => rowMeasureSet.has(measure))
        ) {
          selected = ancestor
        }
      }
      ancestor = ancestor.parentElement
    }

    if (selected && !rootsInUse.has(selected)) {
      row.root = selected
      rootsInUse.add(selected)
    }
  }

  const positionedRows = rows.flatMap(row => {
    if (!row.root) return []
    const bounds = row.root.getBoundingClientRect()
    if (!Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom) || bounds.height <= 0) return []
    return [{ root: row.root, row, lineGap: row.lineGap, bounds }]
  }).sort((a, b) => a.bounds.top - b.bounds.top)

  if (positionedRows.length < 2) {
    console.warn('[ScoreRoom] Fixed row spacing skipped: OSMD system wrappers could not be identified reliably.')
    return
  }

  // Recent OSMD versions mark true measure numbers with the dedicated CSS class.
  // Prefer that semantic marker so TAB fret digits are never mistaken for measure numbers.
  const nativeMeasureNumberLabels = Array.from(
    svg.querySelectorAll<SVGTextElement>('text.measure-number, .measure-number text'),
  ).filter(label => {
    const value = (label.textContent ?? '').trim()
    if (!/^\d{1,4}$/.test(value)) return false
    if (label.closest('[data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem], [data-score-room-chord-frame]')) return false
    const bounds = label.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0
  })

  // Some SVG exports are inconsistent: most bar numbers carry OSMD's semantic class,
  // while an isolated label (often the first number on a wrapped system, e.g. "4") does
  // not. Do not switch to the fallback only when *all* labels lack the class. Instead,
  // keep the semantic labels and also include unclassed numeric text that is detached from
  // a measure group. The spatial checks below decide whether such an orphan belongs to a
  // system. Fret numbers live inside g.vf-measure and are excluded here / by root ownership.
  const nativeMeasureNumberSet = new Set(nativeMeasureNumberLabels)
  const numericLabels = Array.from(new Set([
    ...nativeMeasureNumberLabels,
    ...Array.from(svg.querySelectorAll<SVGTextElement>('text')).filter(label => {
      if (nativeMeasureNumberSet.has(label)) return false
      const value = (label.textContent ?? '').trim()
      if (!/^\d{1,4}$/.test(value)) return false
      if (label.closest('g.vf-measure')) return false
      if (label.closest('[data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem], [data-score-room-chord-frame]')) return false
      const bounds = label.getBoundingClientRect()
      return bounds.width > 0 && bounds.height > 0
    }),
  ]))

  const detachedMeasureNumbersByRoot = new Map<SVGGraphicsElement, SVGTextElement[]>()
  for (const label of numericLabels) {
    // A label inside any system wrapper already follows that system when it is moved.
    if (positionedRows.some(row => row.root.contains(label))) continue

    const labelBounds = label.getBoundingClientRect()
    const labelCenterX = (labelBounds.left + labelBounds.right) / 2
    let bestRoot: SVGGraphicsElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (const row of positionedRows) {
      // Use the actual top TAB string as the vertical reference, not the bounding box
      // of the whole system wrapper. Lyrics/chord symbols can enlarge that wrapper above
      // the staff, and that extra height varies by system; from two-digit measure numbers
      // onward this could make a label attach to a neighboring row.
      const aboveTab = row.row.topY - labelBounds.bottom
      const maxVerticalDistance = Math.max(24, row.lineGap * 8)
      if (aboveTab < -2 || aboveTab > maxVerticalDistance) continue

      // OSMD anchors a measure number near its own measure's left edge. Only consider
      // the measured starts within this row, then use staff-relative vertical distance
      // as the primary signal so a label cannot drift to another row with a similar x.
      let closestMeasureStartDistance = Number.POSITIVE_INFINITY
      for (const measure of row.row.measures) {
        const measureBounds = measure.getBoundingClientRect()
        const deltaX = labelCenterX - measureBounds.left
        const leftReach = Math.max(16, row.lineGap * 2.2)
        const rightReach = Math.max(40, row.lineGap * 6.5)
        if (deltaX < -leftReach || deltaX > rightReach) continue
        const distanceToMeasureStart = Math.abs(deltaX)
        closestMeasureStartDistance = Math.min(
          closestMeasureStartDistance,
          distanceToMeasureStart,
        )
      }
      if (!Number.isFinite(closestMeasureStartDistance)) continue

      const score = aboveTab + closestMeasureStartDistance * 0.08
      if (score < bestDistance) {
        bestDistance = score
        bestRoot = row.root
      }
    }

    // Some labels (often a single number such as measure 4) sit farther above the
    // TAB staff than the strict match allows. Attach these orphans to the closest
    // system whose horizontal range contains the label, so the label follows zoom/layout.
    if (!bestRoot) {
      let fallbackScore = Number.POSITIVE_INFINITY
      for (const row of positionedRows) {
        const rootBounds = row.root.getBoundingClientRect()
        if (labelCenterX < rootBounds.left - 90 || labelCenterX > rootBounds.right + 90) continue
        const verticalDistance = Math.abs(labelBounds.bottom - row.row.topY)
        const verticalLimit = Math.max(150, row.lineGap * 20)
        if (verticalDistance > verticalLimit) continue
        const score = verticalDistance + Math.max(0, rootBounds.top - labelBounds.bottom) * 0.12
        if (score < fallbackScore) {
          fallbackScore = score
          bestRoot = row.root
        }
      }
    }

    if (bestRoot) {
      const labels = detachedMeasureNumbersByRoot.get(bestRoot) ?? []
      labels.push(label)
      detachedMeasureNumbersByRoot.set(bestRoot, labels)
    }
  }

  const currentGaps: number[] = []
  for (let index = 1; index < positionedRows.length; index++) {
    currentGaps.push(positionedRows[index].bounds.top - positionedRows[index - 1].bounds.bottom)
  }
  const typicalLineGap = median(positionedRows.map(row => row.lineGap)) ?? 8
  const normalGap = median(currentGaps.filter(gap =>
    Number.isFinite(gap) && gap >= typicalLineGap * 0.25 && gap <= typicalLineGap * 8,
  ))
  // Keep the score's normal visual density, but rule out an accidentally tiny or huge
  // outlier. Since lineGap is measured in screen coordinates, the result scales with zoom.
  const targetGap = Math.max(
    typicalLineGap * 1.15,
    Math.min(normalGap ?? typicalLineGap * 1.6, typicalLineGap * 3.2),
  )

  let previousBottom = positionedRows[0].root.getBoundingClientRect().bottom
  for (let index = 1; index < positionedRows.length; index++) {
    const row = positionedRows[index]
    const currentBounds = row.root.getBoundingClientRect()
    const desiredTop = previousBottom + targetGap
    const deltaY = desiredTop - currentBounds.top
    if (Number.isFinite(deltaY) && Math.abs(deltaY) > 0.65) {
      moveScoreRoomElementByScreenY(row.root, deltaY)
      // Keep any separately rendered measure-number labels attached to this system.
      for (const label of detachedMeasureNumbersByRoot.get(row.root) ?? []) {
        moveScoreRoomElementByScreenY(label, deltaY)
      }
    }
    const movedBounds = row.root.getBoundingClientRect()
    previousBottom = movedBounds.bottom
  }

  ensureScoreRoomSvgHeight(container)
}

/** Extend the SVG viewport if uniform spacing moved a lower system below the original canvas. */
function ensureScoreRoomSvgHeight(container: HTMLElement): void {
  const svg = container.querySelector('svg')
  if (!svg) return

  const svgRect = svg.getBoundingClientRect()
  if (svgRect.height <= 0) return

  const markerPairs = [
    ['data-score-room-original-viewbox', 'viewBox'],
    ['data-score-room-original-height-attr', 'height'],
    ['data-score-room-original-height-style', 'style-height'],
  ] as const
  for (const [marker, source] of markerPairs) {
    if (svg.hasAttribute(marker)) continue
    const value = source === 'style-height' ? svg.style.height : svg.getAttribute(source)
    svg.setAttribute(marker, value ?? '__none__')
  }

  const contentNodes = Array.from(svg.querySelectorAll<SVGGraphicsElement>(
    'g.vf-measure, text, [data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem], [data-score-room-chord-frame]',
  ))
  let contentBottom = svgRect.top
  for (const node of contentNodes) {
    const rect = node.getBoundingClientRect()
    if (Number.isFinite(rect.bottom)) contentBottom = Math.max(contentBottom, rect.bottom)
  }

  const overflowScreen = contentBottom - svgRect.bottom
  if (overflowScreen <= 1) return

  const viewBoxText = svg.getAttribute('viewBox')
  const viewBoxNumbers = viewBoxText?.trim().split(/[ ,]+/).map(Number) ?? []
  const hasValidViewBox = viewBoxNumbers.length === 4 && viewBoxNumbers.every(Number.isFinite) && viewBoxNumbers[3] > 0
  const heightText = svg.getAttribute('height') ?? ''
  const styleHeightText = svg.style.height
  const numericHeight = Number.parseFloat(heightText)
  const numericStyleHeight = Number.parseFloat(styleHeightText)
  const heightIsPercent = heightText.includes('%') || styleHeightText.includes('%')

  if (heightIsPercent) {
    svg.style.overflow = 'visible'
    return
  }

  const baseCoordinateHeight = hasValidViewBox
    ? viewBoxNumbers[3]
    : (Number.isFinite(numericHeight) && numericHeight > 0
      ? numericHeight
      : (Number.isFinite(numericStyleHeight) && numericStyleHeight > 0 ? numericStyleHeight : svgRect.height))
  const scaleY = svgRect.height / baseCoordinateHeight
  if (!Number.isFinite(scaleY) || scaleY <= 0) {
    svg.style.overflow = 'visible'
    return
  }
  const extraCoordinateHeight = overflowScreen / scaleY + 12 / scaleY

  if (hasValidViewBox) {
    svg.setAttribute('viewBox', [
      viewBoxNumbers[0], viewBoxNumbers[1], viewBoxNumbers[2], viewBoxNumbers[3] + extraCoordinateHeight,
    ].join(' '))
  }
  if (Number.isFinite(numericHeight) && numericHeight > 0) {
    const suffix = heightText.trim().endsWith('px') ? 'px' : ''
    svg.setAttribute('height', `${numericHeight + extraCoordinateHeight}${suffix}`)
  }
  if (Number.isFinite(numericStyleHeight) && numericStyleHeight > 0 && styleHeightText.trim().endsWith('px')) {
    svg.style.height = `${numericStyleHeight + overflowScreen + 12}px`
  }
  svg.style.overflow = 'visible'
}

/**
 * Visual bounds of a chord name plus its custom fretboard diagram, when present.
 * Collision decisions must use the whole visual package, not only the chord text.
 */
function getChordVisualBounds(
  label: SVGTextElement,
  moveUnit?: SVGGraphicsElement,
): DOMRect {
  const rects = [label.getBoundingClientRect()]
  const scope = moveUnit ?? label.parentElement as unknown as SVGGraphicsElement | null
  if (scope) {
    for (const diagram of Array.from(
      scope.querySelectorAll<SVGGraphicsElement>('[data-score-room-chord-frame]'),
    )) {
      rects.push(diagram.getBoundingClientRect())
    }
  }
  return unionScreenRects(rects) ?? label.getBoundingClientRect()
}

/**
 * Estimate the current on-screen spacing of the TAB strings near an annotation.
 * All tolerances for section frames derive from this value so they scale with zoom.
 */
function getSectionAnnotationLineGap(
  label: SVGTextElement,
  fallback = 8,
): number {
  const measure = label.closest('g.vf-measure') as SVGGElement | null
  if (!measure) return fallback
  const ys = getTabStringLineYs(measure)
  const gaps = ys.slice(1)
    .map((y, index) => y - ys[index])
    .filter(gap => Number.isFinite(gap) && gap > 0)
    .sort((a, b) => a - b)
  if (gaps.length === 0) return fallback
  const middle = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 0
    ? (gaps[middle - 1] + gaps[middle]) / 2
    : gaps[middle]
}

/**
 * Match only the real box around a section label such as “副歌”. Prefer a single
 * enclosing outline. If the exporter drew four independent edges, choose at most
 * one best candidate per side. This prevents staff lines or nearby notation from
 * being moved with the heading and prevents the border from splitting apart.
 */
function findSectionAnnotationFrameShapes(
  label: SVGTextElement,
  moveUnit: SVGGraphicsElement,
  lineGapInput: number,
): SVGGraphicsElement[] {
  const textBounds = label.getBoundingClientRect()
  const svg = label.ownerSVGElement
  if (!svg) return []

  const lineGap = Number.isFinite(lineGapInput) && lineGapInput > 0 ? lineGapInput : 8
  const tolerance = Math.max(1.1, lineGap * 0.55)
  const maxStroke = Math.max(1.2, lineGap * 0.29)
  const maxFrameExtraWidth = Math.max(textBounds.width * 0.8, lineGap * 7.8)
  const maxFrameExtraHeight = Math.max(textBounds.height * 0.6, lineGap * 2.8)
  const centerX = (textBounds.left + textBounds.right) / 2
  const centerY = (textBounds.top + textBounds.bottom) / 2

  const candidates = Array.from(svg.querySelectorAll<SVGGraphicsElement>(
    'rect, path, polygon, polyline, line, ellipse',
  )).filter(shape => {
    if (shape === moveUnit || moveUnit.contains(shape)) return false
    if (shape.closest('[data-score-room-chord-frame]')) return false
    if (shape.hasAttribute('data-score-room-brush-marker') ||
        shape.hasAttribute('data-score-room-duration-stem') ||
        shape.hasAttribute('data-score-room-half-notehead')) return false

    const ownClass = shape.getAttribute('class') ?? ''
    const parentClass = shape.parentElement?.getAttribute('class') ?? ''
    if (/(^|\s)(notehead|barline|stem|beam)(\s|$)/i.test(ownClass)) return false
    if (/(notehead|barline|stem|beam)(\s|$)/i.test(parentClass)) return false
    return true
  })

  const enclosing = candidates.flatMap(shape => {
    const bounds = shape.getBoundingClientRect()
    const extraLeft = textBounds.left - bounds.left
    const extraRight = bounds.right - textBounds.right
    const extraTop = textBounds.top - bounds.top
    const extraBottom = bounds.bottom - textBounds.bottom
    const widthExtra = bounds.width - textBounds.width
    const heightExtra = bounds.height - textBounds.height
    const centerDx = Math.abs((bounds.left + bounds.right) / 2 - centerX)
    const centerDy = Math.abs((bounds.top + bounds.bottom) / 2 - centerY)

    const tightEnclosure =
      extraLeft >= -tolerance && extraRight >= -tolerance &&
      extraTop >= -tolerance && extraBottom >= -tolerance &&
      widthExtra >= -tolerance && widthExtra <= maxFrameExtraWidth &&
      heightExtra >= -tolerance && heightExtra <= maxFrameExtraHeight &&
      centerDx <= maxFrameExtraWidth * 0.55 &&
      centerDy <= maxFrameExtraHeight * 0.55

    if (!tightEnclosure) return []
    const padding = Math.max(0, widthExtra) + Math.max(0, heightExtra)
    return [{ shape, padding }]
  }).sort((a, b) => a.padding - b.padding)

  if (enclosing.length > 0) return [enclosing[0].shape]

  const horizontal: Array<{ shape: SVGGraphicsElement; side: 'top' | 'bottom'; score: number }> = []
  const vertical: Array<{ shape: SVGGraphicsElement; side: 'left' | 'right'; score: number }> = []

  for (const shape of candidates) {
    const bounds = shape.getBoundingClientRect()
    const tag = shape.localName.toLowerCase()
    const lineLike = tag === 'line' || tag === 'polyline' || tag === 'path'
    if (!lineLike) continue

    if (
      bounds.height <= maxStroke &&
      bounds.width >= Math.max(textBounds.width * 0.72, lineGap * 1.8) &&
      bounds.width <= textBounds.width + lineGap * 7.8
    ) {
      const topDistance = Math.abs(bounds.bottom - textBounds.top)
      const bottomDistance = Math.abs(bounds.top - textBounds.bottom)
      const side = topDistance <= bottomDistance ? 'top' : 'bottom'
      const distance = Math.min(topDistance, bottomDistance)
      if (distance <= tolerance * 1.35) {
        horizontal.push({
          shape,
          side,
          score: distance + Math.abs(bounds.width - textBounds.width) * 0.025,
        })
      }
    }

    if (
      bounds.width <= maxStroke &&
      bounds.height >= Math.max(textBounds.height * 0.55, lineGap * 0.65) &&
      bounds.height <= textBounds.height + lineGap * 2.8
    ) {
      const leftDistance = Math.abs(bounds.right - textBounds.left)
      const rightDistance = Math.abs(bounds.left - textBounds.right)
      const side = leftDistance <= rightDistance ? 'left' : 'right'
      const distance = Math.min(leftDistance, rightDistance)
      if (distance <= tolerance * 1.35) {
        vertical.push({
          shape,
          side,
          score: distance + Math.abs(bounds.height - textBounds.height) * 0.025,
        })
      }
    }
  }

  const selected: SVGGraphicsElement[] = []
  for (const side of ['top', 'bottom'] as const) {
    const best = horizontal.filter(item => item.side === side)
      .sort((a, b) => a.score - b.score)[0]
    if (best) selected.push(best.shape)
  }
  for (const side of ['left', 'right'] as const) {
    const best = vertical.filter(item => item.side === side)
      .sort((a, b) => a.score - b.score)[0]
    if (best && !selected.includes(best.shape)) selected.push(best.shape)
  }
  return selected
}

function normalizeLyricText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, '').trim()
}

/**
 * LyricsHeight 用於 OSMD 排版；這裡再對匹配到的歌詞 SVG 文字做一次輕微縮放，
 * 作為視覺兜底，確保字號變化確實能顯示出來。保留原字號，避免縮放時反復變小。
 */
function applyLyricsFontScale(
  container: HTMLElement,
  lyricTexts: Set<string>,
  scale = 0.82,
): void {
  if (lyricTexts.size === 0) return

  const svg = container.querySelector('svg')
  if (!svg) return

  const sectionPattern =
    /(前奏|間奏|间奏|尾奏|尾聲|尾声|引子|過門|过门|主歌|副歌|橋段|桥段|A段|B段|C段|Intro|Interlude|Outro|Verse|Chorus|Bridge)/i

  for (const textElement of Array.from(svg.querySelectorAll<SVGTextElement>('text'))) {
    const content = (textElement.textContent ?? '').trim()
    const normalized = normalizeLyricText(content)

    if (!normalized || !lyricTexts.has(normalized)) continue
    if (CHORD_SYMBOL_PATTERN.test(content) || sectionPattern.test(content)) continue

    let originalSize = Number(
      textElement.getAttribute('data-score-room-original-lyrics-font-size'),
    )

    if (!Number.isFinite(originalSize) || originalSize <= 0) {
      // computedStyle 返回瀏覽器實際解析後的尺寸；優先使用它，
      // 避免把 SVG 內部單位的 font-size 數值誤當成 CSS 像素。
      const computedSize = Number.parseFloat(
        window.getComputedStyle(textElement).fontSize,
      )
      const attributeSize = Number.parseFloat(
        textElement.getAttribute('font-size') ?? '',
      )
      originalSize =
        Number.isFinite(computedSize) && computedSize > 0
          ? computedSize
          : attributeSize

      if (!Number.isFinite(originalSize) || originalSize <= 0) continue

      textElement.setAttribute(
        'data-score-room-original-lyrics-font-size',
        String(originalSize),
      )
    }

    textElement.style.setProperty(
      'font-size',
      `${originalSize * scale}px`,
      'important',
    )
  }
}


/**
 * Generic, zoom-aware collision pass for imported guitar TAB scores.
 *
 * Rules:
 * 1. Work in screen coordinates from actual SVG bounds, so zoom and responsive reflow
 *    are reflected automatically rather than estimated from hard-coded pixel multipliers.
 * 2. Chord names and their fretboard diagrams move as one visual unit, preserving the
 *    chord baseline within each engraved system.
 * 3. Same-system TAB ovals/circles and duration stems reserve space above their lyrics.
 * 4. Between systems, a chord row may move down only if it clears the staff and duration
 *    stems. If it cannot, the preceding lyric row may move up, but never through the TAB
 *    strings or an oval/circle. Every row is re-measured after movement.
 */
function applyLocalLyricsChordClearance(
  container: HTMLElement,
  lyricTexts: Set<string>,
  _zoomFactor = 1,
): void {
  if (lyricTexts.size === 0) return
  const svg = container.querySelector('svg')
  if (!svg) return

  const sectionPattern = /(前奏|間奏|间奏|尾奏|尾聲|尾声|引子|過門|过门|主歌|副歌|橋段|桥段|A段|B段|C段|Intro|Interlude|Outro|Verse|Chorus|Bridge)/i

  type LyricItem = {
    element: SVGTextElement
    unit: SVGGraphicsElement
  }
  type ChordItem = {
    element: SVGTextElement
    unit: SVGGraphicsElement
  }
  type SystemRow = {
    topY: number
    bottomY: number
    lineGap: number
    measures: SVGGElement[]
    lyrics: LyricItem[]
    chords: ChordItem[]
  }

  const measureInfo = Array.from(svg.querySelectorAll<SVGGElement>('g.vf-measure'))
    .map(measure => {
      const lines = getTabStringLineYs(measure)
      if (lines.length < 4) return null
      const bounds = measure.getBoundingClientRect()
      const gaps = lines.slice(1).map((y, i) => y - lines[i]).filter(g => g > 0)
      const lineGap = medianPositiveTabGap(gaps, 8)
      return {
        measure,
        left: bounds.left,
        topY: lines[0],
        bottomY: lines[lines.length - 1],
        lineGap,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.topY - b.topY || a.left - b.left)

  if (measureInfo.length < 1) return

  const rows: SystemRow[] = []
  for (const info of measureInfo) {
    const rowTolerance = Math.max(2.5, info.lineGap * 0.35)
    let row = rows.find(candidate =>
      Math.abs(candidate.topY - info.topY) <= Math.max(
        rowTolerance,
        candidate.lineGap * 0.35,
      ),
    )
    if (!row) {
      row = {
        topY: info.topY,
        bottomY: info.bottomY,
        lineGap: info.lineGap,
        measures: [],
        lyrics: [],
        chords: [],
      }
      rows.push(row)
    }
    row.measures.push(info.measure)
    const count = row.measures.length
    row.topY += (info.topY - row.topY) / count
    row.bottomY += (info.bottomY - row.bottomY) / count
    row.lineGap += (info.lineGap - row.lineGap) / count
  }
  rows.sort((a, b) => a.topY - b.topY)
  if (rows.length < 1) return

  // Map each rendered measure to its actual TAB system row. Lyrics/chord text normally
  // live inside the measure group; use that structural ownership first and only fall
  // back to nearest-Y assignment for exporters that render directions outside measures.
  const measureToRow = new Map<SVGGElement, SystemRow>()
  for (const row of rows) {
    for (const measure of row.measures) measureToRow.set(measure, row)
  }

  const textElements = Array.from(svg.querySelectorAll<SVGTextElement>('text'))
  const lyricCandidates = textElements.filter(element => {
    if (element.closest('[data-score-room-chord-frame]')) return false
    const content = (element.textContent ?? '').trim()
    const normalized = normalizeLyricText(content)
    if (!normalized || !lyricTexts.has(normalized)) return false
    const isChordLabel =
      element.parentElement?.classList.contains('vf-text') &&
      element.parentElement?.parentElement?.classList.contains('staffline')
    if (isChordLabel || sectionPattern.test(content)) return false
    return true
  })

  const chordCandidates = textElements.filter(element => {
    if (element.closest('[data-score-room-chord-frame]')) return false
    const content = (element.textContent ?? '').trim()
    return CHORD_SYMBOL_PATTERN.test(content) &&
      element.parentElement?.classList.contains('vf-text') &&
      element.parentElement?.parentElement?.classList.contains('staffline')
  })

  const getMoveUnit = (element: SVGTextElement): SVGGraphicsElement => {
    const parent = element.parentElement
    return parent?.getAttribute('class') === 'vf-text'
      ? parent as unknown as SVGGraphicsElement
      : element as unknown as SVGGraphicsElement
  }

  for (const element of lyricCandidates) {
    const bounds = element.getBoundingClientRect()
    const centerY = (bounds.top + bounds.bottom) / 2
    const owningMeasure = element.closest('g.vf-measure') as SVGGElement | null
    let bestRow: SystemRow | null = owningMeasure ? measureToRow.get(owningMeasure) ?? null : null
    if (!bestRow) {
      let bestDistance = Number.POSITIVE_INFINITY
      for (const row of rows) {
        const expectedLyricCenter = row.bottomY + row.lineGap * 1.35
        const distance = Math.abs(centerY - expectedLyricCenter)
        if (distance < bestDistance) {
          bestDistance = distance
          bestRow = row
        }
      }
    }
    if (bestRow) bestRow.lyrics.push({ element, unit: getMoveUnit(element) })
  }

  for (const element of chordCandidates) {
    const bounds = element.getBoundingClientRect()
    const owningMeasure = element.closest('g.vf-measure') as SVGGElement | null
    let bestRow: SystemRow | null = owningMeasure ? measureToRow.get(owningMeasure) ?? null : null
    if (!bestRow) {
      let bestDistance = Number.POSITIVE_INFINITY
      for (const row of rows) {
        const distance = Math.abs(bounds.bottom - row.topY)
        if (distance < bestDistance) {
          bestDistance = distance
          bestRow = row
        }
      }
    }
    if (bestRow) bestRow.chords.push({ element, unit: getMoveUnit(element) })
  }

  const visualBoundsForChord = (chord: ChordItem): DOMRect =>
    getChordVisualBounds(chord.element, chord.unit)

  const horizontalNear = (a: DOMRect, b: DOMRect, band: number): boolean =>
    a.left <= b.right + band && a.right >= b.left - band

  const durationStemEntries = Array.from(
    svg.querySelectorAll<SVGGraphicsElement>('[data-score-room-duration-stem]'),
  ).map(group => {
    const path = group.querySelector<SVGGraphicsElement>('path') ?? group
    const measure = group.closest('g.vf-measure') as SVGGElement | null
    return {
      rect: path.getBoundingClientRect(),
      row: measure ? measureToRow.get(measure) ?? null : null,
    }
  }).filter(entry => entry.rect.width >= 0 && entry.rect.height > 0)
  const durationStemRects = durationStemEntries.map(entry => entry.rect)
  const durationStemsByRow = new Map<SystemRow, DOMRect[]>()
  for (const entry of durationStemEntries) {
    if (!entry.row) continue
    const list = durationStemsByRow.get(entry.row) ?? []
    list.push(entry.rect)
    durationStemsByRow.set(entry.row, list)
  }

  const sameRowNoteheadRects = rows.map(row =>
    row.measures.flatMap(measure =>
      Array.from(measure.querySelectorAll<SVGGraphicsElement>(
        '[data-score-room-half-notehead], [data-score-room-duration-stem]',
      )).map(element => element.getBoundingClientRect()),
    ),
  )

  // Calculate the highest position that the lyrics may safely reach. This guard is
  // used later if the next chord row cannot move down because a native/custom stem is in the way.
  const minimumSafeLyricTop = (rowIndex: number, lyric: LyricItem): number => {
    const row = rows[rowIndex]
    const lyricBounds = lyric.element.getBoundingClientRect()
    const band = Math.max(2.5, row.lineGap * 0.5)
    // Keep lyric glyphs safely below the lowest TAB string even when a later
    // collision pass tries to lift them for chord clearance. 0.42 string gaps was too
    // small at 50–60% zoom and could pull lyrics into the staff lines.
    let floor = row.bottomY + Math.max(4, row.lineGap * 0.85)

    for (const overlay of sameRowNoteheadRects[rowIndex] ?? []) {
      if (!horizontalNear(lyricBounds, overlay, band)) continue
      if (overlay.top <= lyricBounds.bottom && overlay.bottom >= row.bottomY - row.lineGap * 0.25) {
        floor = Math.max(floor, overlay.bottom + Math.max(1.5, row.lineGap * 0.28))
      }
    }
    return floor
  }

  const applied: Array<{ phase: string; row: number; deltaY: number; items: number }> = []

  // Phase 1: keep each row's own lyrics clear of its custom TAB noteheads/length stems.
  // All lyrics in a system move together so their baseline stays aligned.
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (row.lyrics.length === 0) continue
    const gap = Math.max(2, row.lineGap * 0.58)
    const band = Math.max(3, row.lineGap * 0.78)
    let neededDown = 0

    for (const lyric of row.lyrics) {
      const lyricBounds = lyric.element.getBoundingClientRect()
      for (const overlay of sameRowNoteheadRects[rowIndex] ?? []) {
        if (!horizontalNear(lyricBounds, overlay, band)) continue
        // Only protect against overlays above/through the lyric. Lines below it should
        // not push the lyric farther down.
        if (overlay.top > lyricBounds.bottom) continue
        const overlapOrGap = overlay.bottom + gap - lyricBounds.top
        if (overlapOrGap > neededDown) neededDown = overlapOrGap
      }
    }

    if (neededDown > 0.75) {
      const units = Array.from(new Set(row.lyrics.map(item => item.unit)))
      for (const unit of units) moveScoreRoomElementByScreenY(unit, neededDown)
      applied.push({ phase: 'same-row-overlay-clearance', row: rowIndex + 1, deltaY: Number(neededDown.toFixed(2)), items: units.length })
    }
  }

  // Phase 2: preserve compact defaults, adding space only where the previous system's
  // lyrics approach the next system's chord package (chord label + its fretboard diagram).
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const previousRow = rows[rowIndex - 1]
    const currentRow = rows[rowIndex]
    if (previousRow.lyrics.length === 0 || currentRow.chords.length === 0) continue

    const gap = Math.max(4, Math.max(previousRow.lineGap, currentRow.lineGap) * 1.45)
    const band = Math.max(previousRow.lineGap, currentRow.lineGap) * 3.2
    let neededShift = 0

    for (const lyric of previousRow.lyrics) {
      const lyricBounds = lyric.element.getBoundingClientRect()
      for (const chord of currentRow.chords) {
        const chordBounds = visualBoundsForChord(chord)
        if (!horizontalNear(lyricBounds, chordBounds, band)) continue
        const verticalGap = chordBounds.top - lyricBounds.bottom
        if (verticalGap < gap) neededShift = Math.max(neededShift, gap - verticalGap)
      }
    }

    if (neededShift <= 0.75) continue

    // Limit the chord-row move so every chord package remains above the current TAB
    // staff, and so it cannot move into an intersecting duration stem.
    const chordBounds = currentRow.chords.map(visualBoundsForChord)
    const maxPackageBottom = Math.max(...chordBounds.map(bounds => bounds.bottom))
    let maxSafeShift = Math.max(
      0,
      currentRow.topY - Math.max(1.5, currentRow.lineGap * 0.28) - maxPackageBottom,
    )
    const stemGap = Math.max(1.5, currentRow.lineGap * 0.2)

    for (let chordIndex = 0; chordIndex < currentRow.chords.length; chordIndex++) {
      const bounds = chordBounds[chordIndex]
      for (const stem of durationStemsByRow.get(currentRow) ?? []) {
        if (!horizontalNear(bounds, stem, Math.max(1.5, currentRow.lineGap * 0.18))) continue
        if (stem.bottom <= bounds.top) continue // stem above package: moving down increases clearance
        if (stem.top < bounds.bottom && stem.bottom > bounds.top) {
          maxSafeShift = 0
          continue
        }
        if (stem.top >= bounds.bottom) {
          maxSafeShift = Math.min(
            maxSafeShift,
            Math.max(0, stem.top - bounds.bottom - stemGap),
          )
        }
      }
    }

    const shift = Math.min(neededShift, maxSafeShift)
    if (shift > 0.75) {
      const units = Array.from(new Set(currentRow.chords.map(chord => chord.unit)))
      for (const unit of units) moveScoreRoomElementByScreenY(unit, shift)
      applied.push({ phase: 'chord-row-clearance', row: rowIndex + 1, deltaY: Number(shift.toFixed(2)), items: units.length })
    }

    const remainingGap = Math.max(0, neededShift - shift)
    if (remainingGap > 0.75 && previousRow.lyrics.length > 0) {
      // If the chord package is boxed in by stems/staff, lift the lyric row only as far
      // as it can go without entering the TAB staff or crossing a half-note oval.
      const maxSafeLift = Math.min(...previousRow.lyrics.map(lyric => {
        const bounds = lyric.element.getBoundingClientRect()
        return Math.max(0, bounds.top - minimumSafeLyricTop(rowIndex - 1, lyric))
      }))
      const lift = Math.min(remainingGap, maxSafeLift)
      if (lift > 0.75) {
        const units = Array.from(new Set(previousRow.lyrics.map(lyric => lyric.unit)))
        for (const unit of units) moveScoreRoomElementByScreenY(unit, -lift)
        applied.push({ phase: 'lyric-row-clearance', row: rowIndex, deltaY: Number((-lift).toFixed(2)), items: units.length })
      }
    }
  }

  // Phase 3: final same-system chord/stem clearance AFTER inter-row spacing. The earlier
  // stem pass in drawBrushMarkers runs before Phase 2, but Phase 2 may move a chord package
  // down to create lyric clearance. Recheck against fresh DOMRects here so those two passes
  // cannot undo each other. Entire chord rows move together, preserving a single baseline.
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (row.chords.length === 0) continue
    const rowStems = durationStemsByRow.get(row) ?? []
    const units = Array.from(new Set(row.chords.map(chord => chord.unit)))
    const stemGap = Math.max(1.5, row.lineGap * 0.2)

    for (let attempt = 0; attempt < 4; attempt++) {
      let shiftUp = 0
      for (const chord of row.chords) {
        const bounds = visualBoundsForChord(chord)
        for (const stem of rowStems) {
          if (!horizontalNear(bounds, stem, Math.max(2, row.lineGap * 0.22))) continue
          const intersects = stem.top < bounds.bottom && stem.bottom > bounds.top
          if (!intersects) continue
          const candidate = stem.top - bounds.bottom - stemGap
          if (candidate < shiftUp) shiftUp = candidate
        }
      }
      if (shiftUp >= -0.5) break
      for (const unit of units) moveScoreRoomElementByScreenY(unit, shiftUp)
    }

    // If raising a chord row to clear its own stems made it crowd the prior lyric row,
    // lift the prior lyrics together, but never above the measured TAB/oval safe floor.
    if (rowIndex === 0) continue
    const previousRow = rows[rowIndex - 1]
    if (previousRow.lyrics.length === 0) continue
    const rowGap = Math.max(4, Math.max(previousRow.lineGap, row.lineGap) * 1.45)
    let neededLift = 0
    for (const lyric of previousRow.lyrics) {
      const lyricBounds = lyric.element.getBoundingClientRect()
      for (const chord of row.chords) {
        const chordBounds = visualBoundsForChord(chord)
        if (!horizontalNear(lyricBounds, chordBounds, Math.max(previousRow.lineGap, row.lineGap) * 3.2)) continue
        neededLift = Math.max(neededLift, lyricBounds.bottom + rowGap - chordBounds.top)
      }
    }
    if (neededLift > 0.75) {
      const maxSafeLift = Math.min(...previousRow.lyrics.map(lyric => {
        const bounds = lyric.element.getBoundingClientRect()
        return Math.max(0, bounds.top - minimumSafeLyricTop(rowIndex - 1, lyric))
      }))
      const lift = Math.min(neededLift, maxSafeLift)
      if (lift > 0.75) {
        const lyricUnits = Array.from(new Set(previousRow.lyrics.map(lyric => lyric.unit)))
        for (const unit of lyricUnits) moveScoreRoomElementByScreenY(unit, -lift)
        applied.push({ phase: 'post-stem-lyric-clearance', row: rowIndex, deltaY: Number((-lift).toFixed(2)), items: lyricUnits.length })
      }
    }
  }

  // Phase 4: verify that final chord/stem adjustments did not reintroduce same-row
  // lyric collisions with ovals or stems. Use the same measured string-spacing rule.
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (row.lyrics.length === 0) continue
    const gap = Math.max(2, row.lineGap * 0.58)
    const band = Math.max(3, row.lineGap * 0.78)
    let neededDown = 0
    for (const lyric of row.lyrics) {
      const lyricBounds = lyric.element.getBoundingClientRect()
      for (const overlay of sameRowNoteheadRects[rowIndex] ?? []) {
        if (!horizontalNear(lyricBounds, overlay, band)) continue
        if (overlay.top > lyricBounds.bottom) continue
        neededDown = Math.max(neededDown, overlay.bottom + gap - lyricBounds.top)
      }
    }
    if (neededDown > 0.75) {
      // Do not solve a same-row oval/lyric overlap by pushing lyrics directly into the
      // next system's chord package. Cap the shift at the available inter-row clearance.
      let maxSafeDown = Number.POSITIVE_INFINITY
      const nextRow = rows[rowIndex + 1]
      if (nextRow && nextRow.chords.length > 0) {
        const minNextGap = Math.max(4, Math.max(row.lineGap, nextRow.lineGap) * 1.45)
        for (const lyric of row.lyrics) {
          const lyricBounds = lyric.element.getBoundingClientRect()
          for (const chord of nextRow.chords) {
            const chordBounds = visualBoundsForChord(chord)
            if (!horizontalNear(lyricBounds, chordBounds, Math.max(row.lineGap, nextRow.lineGap) * 3.2)) continue
            maxSafeDown = Math.min(maxSafeDown, chordBounds.top - minNextGap - lyricBounds.bottom)
          }
        }
      }
      const shiftDown = Math.min(neededDown, Math.max(0, maxSafeDown))
      if (shiftDown > 0.75) {
        const units = Array.from(new Set(row.lyrics.map(lyric => lyric.unit)))
        for (const unit of units) moveScoreRoomElementByScreenY(unit, shiftDown)
        applied.push({ phase: 'final-oval-lyric-clearance', row: rowIndex + 1, deltaY: Number(shiftDown.toFixed(2)), items: units.length })
      }
    }
  }

  // Phase 5: validate geometry after all movements. This is intentionally a diagnostic;
  // unresolved cases are reported with row ids rather than patched using measure numbers.
  const unresolved: Array<{ kind: string; row: number; gap: number }> = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    for (const lyric of row.lyrics) {
      const lyricBounds = lyric.element.getBoundingClientRect()
      for (const overlay of sameRowNoteheadRects[rowIndex] ?? []) {
        if (!horizontalNear(lyricBounds, overlay, Math.max(2, row.lineGap * 0.5))) continue
        if (overlay.top <= lyricBounds.bottom && overlay.bottom >= lyricBounds.top) {
          unresolved.push({ kind: 'TAB overlay/lyric', row: rowIndex + 1, gap: Number((lyricBounds.top - overlay.bottom).toFixed(2)) })
        }
      }
    }
    for (const chord of row.chords) {
      const chordBounds = visualBoundsForChord(chord)
      for (const stem of durationStemsByRow.get(row) ?? []) {
        if (!horizontalNear(chordBounds, stem, Math.max(2, row.lineGap * 0.22))) continue
        if (stem.top < chordBounds.bottom && stem.bottom > chordBounds.top) {
          unresolved.push({ kind: 'chord/duration-stem', row: rowIndex + 1, gap: Number((stem.top - chordBounds.bottom).toFixed(2)) })
        }
      }
    }
    if (rowIndex === 0) continue
    const previousRow = rows[rowIndex - 1]
    for (const lyric of previousRow.lyrics) {
      const lyricBounds = lyric.element.getBoundingClientRect()
      for (const chord of row.chords) {
        const chordBounds = visualBoundsForChord(chord)
        if (!horizontalNear(lyricBounds, chordBounds, Math.max(previousRow.lineGap, row.lineGap) * 3.2)) continue
        if (chordBounds.top < lyricBounds.bottom) {
          unresolved.push({ kind: 'lyric/chord package', row: rowIndex + 1, gap: Number((chordBounds.top - lyricBounds.bottom).toFixed(2)) })
        }
      }
    }
  }

  if (SCORE_ROOM_VERBOSE_DEBUG && (applied.length > 0 || unresolved.length > 0)) {
    console.info('[ScoreRoom] Adaptive TAB layout clearance:', {
      zoom: _zoomFactor,
      adjustments: applied,
      unresolved,
    })
  }
}

/**
 * 將吉他指法圖固定繪制在對應和弦名稱正上方。
 * 不做左右移動或上下避讓，避免指法圖與相鄰和弦錯配。
 * 開啟指法圖時會額外增加系統間距；關閉時不呼叫本函數。
 */
function drawChordFrames(
  container: HTMLElement,
  frames: ChordFrameData[],
): void {
  if (frames.length === 0) return

  const svg = container.querySelector('svg')
  if (!svg) return

  // The shared overlay pipeline restores canonical transforms before rebuilding drawings.
  svg.querySelectorAll('[data-score-room-chord-frame]').forEach(
    (element) => element.remove(),
  )

  const sectionPattern =
    /(前奏|間奏|间奏|尾奏|尾聲|尾声|引子|過門|过门|主歌|副歌|橋段|桥段|A段|B段|C段|Intro|Interlude|Outro|Verse|Chorus|Bridge)/i

  const sectionAnnotations = Array.from(
    svg.querySelectorAll<SVGTextElement>('text'),
  ).filter((element) => {
    const text = (element.textContent ?? '')
      .replace(/\s+/g, '')
      .replace(/[：:，,。.!！?？]/g, '')
      .trim()

    return text.length > 0 && sectionPattern.test(text)
  })


  const labels = Array.from(svg.querySelectorAll<SVGTextElement>('text')).filter(
    (element) => {
      const text = element.textContent?.trim() ?? ''
      return (
        element.parentElement?.classList.contains('vf-text') &&
        element.parentElement?.parentElement?.classList.contains('staffline') &&
        text.length > 0 &&
        CHORD_SYMBOL_PATTERN.test(text)
      )
    },
  )

  const frameCountToDraw = Math.min(labels.length, frames.length)
  if (labels.length !== frames.length) {
    console.warn('[ScoreRoom] Chord diagram label/frame counts differ; drawing only the common ordered prefix to avoid hiding every diagram.', {
      chordLabels: labels.length,
      chordFrames: frames.length,
      framesDrawn: frameCountToDraw,
    })
  }
  if (frameCountToDraw === 0) return

  const NS = 'http://www.w3.org/2000/svg'
  const diagramWidth = 22
  const diagramHeight = 19
  const gap = 4
  const drawnDiagramBounds: DOMRect[] = []

  labels.slice(0, frameCountToDraw).forEach((target, index) => {
    const frame = frames[index]
    const parent = target.parentElement
    if (!parent) return

    let box: DOMRect
    try {
      box = target.getBBox()
    } catch {
      return
    }

    // 每張指法圖嚴格對齊自己的和弦名稱，不左右移動，保持同一行的視覺秩序。
    const left = box.x + box.width / 2 - diagramWidth / 2
    const top = box.y - diagramHeight - gap

    const fretLabelSpace = frame.firstFret > 1 ? 3 : 1
    const gridLeft = left + fretLabelSpace
    const gridTop = top + 2
    const gridWidth = diagramWidth - fretLabelSpace - 1
    const gridHeight = diagramHeight - 3
    const cellWidth = gridWidth / (frame.strings - 1)
    const cellHeight = gridHeight / frame.frets

    const group = document.createElementNS(NS, 'g')
    group.setAttribute('data-score-room-chord-frame', String(index))
    group.setAttribute('pointer-events', 'none')
    group.setAttribute('aria-hidden', 'true')

    function draw(
      tagName: string,
      attributes: Record<string, string | number>,
      textContent?: string,
    ): SVGElement {
      const element = document.createElementNS(NS, tagName)
      for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value))
      }
      if (textContent !== undefined) element.textContent = textContent
      group.appendChild(element)
      return element
    }

    // 僅繪制琴弦和品格線，不加背景矩形，減少遮擋。
    for (let string = 0; string < frame.strings; string++) {
      const x = gridLeft + string * cellWidth
      draw('line', {
        x1: x,
        y1: gridTop,
        x2: x,
        y2: gridTop + gridHeight,
        stroke: '#30332c',
        'stroke-width': 0.55,
      })
    }

    for (let fret = 0; fret <= frame.frets; fret++) {
      const y = gridTop + fret * cellHeight
      draw('line', {
        x1: gridLeft,
        y1: y,
        x2: gridLeft + gridWidth,
        y2: y,
        stroke: '#30332c',
        'stroke-width': frame.firstFret === 1 && fret === 0 ? 1 : 0.5,
      })
    }

    if (frame.firstFret > 1) {
      draw(
        'text',
        {
          x: left + 2,
          y: gridTop + 3.8,
          'font-size': 4.2,
          'text-anchor': 'end',
          fill: '#30332c',
        },
        String(frame.firstFret),
      )
    }

    function noteX(stringNumber: number): number {
      return gridLeft + (frame.strings - stringNumber) * cellWidth
    }

    function noteY(fret: number): number {
      return gridTop + (fret - frame.firstFret + 0.5) * cellHeight
    }

    // An omitted string in a MusicXML frame is conventionally a muted/unplayed string;
    // explicit negative fret values are treated the same way. Open strings have fret=0.
    const representedStrings = new Set(frame.notes.map(note => note.stringNumber))
    for (let stringNumber = 1; stringNumber <= frame.strings; stringNumber++) {
      const explicitMute = frame.notes.some(note => note.stringNumber === stringNumber && note.muted)
      if (!representedStrings.has(stringNumber) || explicitMute) {
        // Draw mute X as two vector strokes instead of a tiny text glyph, so it remains
        // visible across fonts, browsers and device zoom levels.
        const x = noteX(stringNumber)
        const y = gridTop - 1.4
        const r = 1.05
        draw('line', { x1: x - r, y1: y - r, x2: x + r, y2: y + r, stroke: '#30332c', 'stroke-width': 0.8, 'stroke-linecap': 'round' })
        draw('line', { x1: x - r, y1: y + r, x2: x + r, y2: y - r, stroke: '#30332c', 'stroke-width': 0.8, 'stroke-linecap': 'round' })
      }
    }

    for (const startNote of frame.notes) {
      if (startNote.muted || !startNote.barre.includes('start')) continue
      const stopNote = frame.notes.find(
        (note) =>
          note.fret === startNote.fret && note.barre.includes('stop'),
      )
      if (!stopNote) continue
      if (
        startNote.fret < frame.firstFret ||
        startNote.fret >= frame.firstFret + frame.frets
      ) {
        continue
      }

      draw('line', {
        x1: noteX(startNote.stringNumber),
        y1: noteY(startNote.fret),
        x2: noteX(stopNote.stringNumber),
        y2: noteY(stopNote.fret),
        stroke: '#292c25',
        'stroke-width': 2,
        'stroke-linecap': 'round',
      })
    }

    for (const note of frame.notes) {
      const x = noteX(note.stringNumber)
      if (note.muted || note.fret < 0) continue
      if (note.fret === 0) {
        draw('circle', {
          cx: x,
          cy: gridTop - 1.6,
          r: 1.15,
          fill: 'none',
          stroke: '#252820',
          'stroke-width': 0.65,
        })
        continue
      }

      const fretIndex = note.fret - frame.firstFret
      if (fretIndex < 0 || fretIndex >= frame.frets) continue
      draw('circle', {
        cx: x,
        cy: noteY(note.fret),
        r: 1.35,
        fill: '#292c25',
      })
    }

    parent.appendChild(group)
    drawnDiagramBounds.push(group.getBoundingClientRect())
  })

  /**
   * 將 SVG 元素沿螢幕縱向移動。儲存原 transform，重復繪制時可以恢復。
   */

  /**
   * 取最小的獨立文字組作為移動單位。若外框是同組子元素，會隨文字一起移動。
   */
  function getAnnotationMoveUnit(
    annotation: SVGTextElement,
  ): SVGGraphicsElement {
    const parent = annotation.parentElement
    if (
      parent &&
      parent.localName === 'g' &&
      parent.querySelectorAll('text').length === 1
    ) {
      return parent as unknown as SVGGraphicsElement
    }
    return annotation as unknown as SVGGraphicsElement
  }

  /**
   * 少數 MusicXML 文字外框由獨立 SVG 形狀繪制。找出緊貼包圍文字的邊框，
   * 讓它和文字同步移動，而不是留下一個孤零零的框。
   */
  function findExternalAnnotationFrames(
    annotation: SVGTextElement,
    moveUnit: SVGGraphicsElement,
  ): SVGGraphicsElement[] {
    return findSectionAnnotationFrameShapes(
      annotation,
      moveUnit,
      getSectionAnnotationLineGap(annotation, 8),
    )
  }

  // 若段落標註與指法圖區域重疊，將文字組及其外框一起移到指法圖上方。
  for (const annotation of sectionAnnotations) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const annotationBounds = annotation.getBoundingClientRect()
      const colliding = drawnDiagramBounds.filter((diagramBounds) => {
        const horizontalOverlap =
          annotationBounds.left < diagramBounds.right + 3 &&
          annotationBounds.right > diagramBounds.left - 3
        const verticalOverlap =
          annotationBounds.top < diagramBounds.bottom + 3 &&
          annotationBounds.bottom > diagramBounds.top - 3
        return horizontalOverlap && verticalOverlap
      })

      if (colliding.length === 0) break

      const diagramTop = Math.min(...colliding.map((bounds) => bounds.top))
      const screenDeltaY = diagramTop - 4 - annotationBounds.bottom
      if (screenDeltaY >= -0.5) break

      const moveUnit = getAnnotationMoveUnit(annotation)
      const externalFrames = findExternalAnnotationFrames(annotation, moveUnit)

      moveScoreRoomElementByScreenY(moveUnit, screenDeltaY)
      for (const frame of externalFrames) {
        moveScoreRoomElementByScreenY(frame, screenDeltaY)
      }
    }
  }
}

function collectGraphicalLinePedals(
  osmd: OpenSheetMusicDisplay,
): any[] {
  const result: any[] = []
  const graphicalSheet = (osmd as any).graphic

  for (const page of graphicalSheet?.musicPages ?? []) {
    for (const system of page.MusicSystems ?? []) {
      for (const staffLine of system.StaffLines ?? []) {
        for (const graphicalPedal of staffLine.Pedals ?? []) {
          const raw = graphicalPedal.getPedal

          const pedal =
            typeof raw === 'function'
              ? raw.call(graphicalPedal)
              : raw

          if (pedal?.IsLine) {
            result.push(pedal)
          }
        }
      }
    }
  }

  return result
}

/** Re-apply the previously validated pedal line endpoint fixes after OSMD re-layout. */
function applyPedalEndCorrections(
  osmd: OpenSheetMusicDisplay,
  correctionIndices: number[],
): boolean {
  if (correctionIndices.length === 0) return false

  const graphicalPedals = collectGraphicalLinePedals(osmd)
  let changed = false

  for (const index of correctionIndices) {
    const pedal = graphicalPedals[index]
    if (pedal && !pedal.EndsStave) {
      pedal.EndsStave = true
      changed = true
    }
  }

  return changed
}

/**
 * 查找由 offset 推進到小節末尾的踏板線段。
 * 此函數只讀取 MusicXML，不會修改源檔案。
 */
async function findPedalSegmentsEndingAtBarline(
  fileUrl: string,
): Promise<number[]> {
  const response = await fetch(fileUrl)

  if (!response.ok) {
    throw new Error(`無法讀取 MusicXML：HTTP ${response.status}`)
  }

  const xml = new DOMParser().parseFromString(
    await response.text(),
    'application/xml',
  )

  if (xml.getElementsByTagName('parsererror').length > 0) {
    throw new Error('MusicXML 格式解析失敗')
  }

  const parts = directChildren(xml.documentElement, 'part')

  if (parts.length !== 1) {
    console.warn(
      '[ScoreRoom] Pedal correction skipped: expected one MusicXML part.',
    )
    return []
  }

  const part = parts[0]

  let divisions = 1
  let beats = 4
  let beatType = 4
  let nextSegmentIndex = 0

  const activeSegments = new Map<string, number>()
  const pedalStaffNumbers = new Set<string>()
  const corrections = new Set<number>()

  const pedalKey = (staff: string, number: string) =>
    `${staff}:${number}`

  function shouldEndAtBarline(
    pedal: Element,
    cursorDivisions: number,
    offsetDivisions: number,
    measureQuarterLength: number,
  ): boolean {
    if (pedal.hasAttribute('default-x')) return false
    if (!Number.isFinite(divisions) || divisions <= 0) return false

    const targetQuarter =
      (cursorDivisions + offsetDivisions) / divisions

    const tolerance = Math.max(2 / divisions, 0.005)

    return (
      Math.abs(targetQuarter - measureQuarterLength) <= tolerance
    )
  }

  for (const measure of directChildren(part, 'measure')) {
    let cursorDivisions = 0

    for (const node of Array.from(measure.children)) {
      if (node.localName === 'attributes') {
        const divisionsNode =
          directChildren(node, 'divisions')[0]

        if (divisionsNode) {
          const value = Number(divisionsNode.textContent)

          if (Number.isFinite(value) && value > 0) {
            divisions = value
          }
        }

        const timeNode = directChildren(node, 'time')[0]

        if (timeNode) {
          const beatNodes = directChildren(timeNode, 'beats')
          const beatTypeNodes =
            directChildren(timeNode, 'beat-type')

          if (beatNodes.length > 0 && beatTypeNodes.length > 0) {
            const nextBeats = beatNodes.reduce((sum, element) => {
              const value = (element.textContent ?? '')
                .split('+')
                .map((part) => Number(part.trim()))
                .reduce(
                  (partSum, value) =>
                    partSum +
                    (Number.isFinite(value) ? value : 0),
                  0,
                )

              return sum + value
            }, 0)

            const nextBeatType = Number(
              beatTypeNodes[0].textContent,
            )

            if (
              Number.isFinite(nextBeats) &&
              nextBeats > 0 &&
              Number.isFinite(nextBeatType) &&
              nextBeatType > 0
            ) {
              beats = nextBeats
              beatType = nextBeatType
            }
          }
        }

        continue
      }

      if (node.localName === 'direction') {
        const offsetNode = directChildren(node, 'offset')[0]
        const offsetDivisions = Number(
          offsetNode?.textContent ?? 0,
        )

        const staff =
          directChildren(node, 'staff')[0]?.textContent?.trim() ||
          '1'

        const measureQuarterLength = (beats * 4) / beatType

        for (const directionType of directChildren(
          node,
          'direction-type',
        )) {
          for (const pedal of directChildren(
            directionType,
            'pedal',
          )) {
            const line = pedal.getAttribute('line')
            const sign = pedal.getAttribute('sign')

            if (line === 'no' || (line !== 'yes' && sign === 'yes')) {
              continue
            }

            pedalStaffNumbers.add(staff)

            const type = pedal.getAttribute('type')
            const number = pedal.getAttribute('number') || '1'
            const key = pedalKey(staff, number)

            if (type === 'start') {
              activeSegments.set(key, nextSegmentIndex)
              nextSegmentIndex++
              continue
            }

            if (type === 'stop') {
              const segmentIndex = activeSegments.get(key)

              if (
                segmentIndex !== undefined &&
                shouldEndAtBarline(
                  pedal,
                  cursorDivisions,
                  offsetDivisions,
                  measureQuarterLength,
                )
              ) {
                corrections.add(segmentIndex)
              }

              activeSegments.delete(key)
              continue
            }

            if (type === 'change') {
              const previousIndex = activeSegments.get(key)

              if (
                previousIndex !== undefined &&
                shouldEndAtBarline(
                  pedal,
                  cursorDivisions,
                  offsetDivisions,
                  measureQuarterLength,
                )
              ) {
                corrections.add(previousIndex)
              }

              activeSegments.set(key, nextSegmentIndex)
              nextSegmentIndex++
            }
          }
        }

        continue
      }

      if (node.localName === 'note') {
        const chord = directChildren(node, 'chord').length > 0
        const grace = directChildren(node, 'grace').length > 0

        if (!chord && !grace) {
          const duration = Number(
            directChildren(node, 'duration')[0]?.textContent ?? 0,
          )

          if (Number.isFinite(duration) && duration > 0) {
            cursorDivisions += duration
          }
        }

        continue
      }

      if (
        node.localName === 'backup' ||
        node.localName === 'forward'
      ) {
        const duration = Number(
          directChildren(node, 'duration')[0]?.textContent ?? 0,
        )

        if (Number.isFinite(duration) && duration > 0) {
          cursorDivisions +=
            node.localName === 'backup' ? -duration : duration

          cursorDivisions = Math.max(0, cursorDivisions)
        }
      }
    }
  }

  if (pedalStaffNumbers.size > 1) {
    console.warn(
      '[ScoreRoom] Pedal correction skipped: pedal marks use multiple staves.',
    )
    return []
  }

  return Array.from(corrections).sort((a, b) => a - b)
}

/**
 * Sibelius exports sometimes include printed page numbers as MusicXML credits, e.g.
 * <credit page="4"><credit-words>4</credit-words></credit>. In a responsive web
 * reader, these print-page labels can detach from the reflowed systems and look like
 * stray measure numbers after zooming. Remove only standalone numeric page credits;
 * keep the actual OSMD measure-number labels and all title/composer/copyright credits.
 */
async function loadScoreWithoutPrintedPageNumberCredits(
  osmd: OpenSheetMusicDisplay,
  fileUrl: string,
  isGuitarScore = false,
): Promise<void> {
  // Compressed MusicXML cannot be edited as text; preserve the standard OSMD path for it.
  const pathWithoutQuery = fileUrl.split(/[?#]/, 1)[0].toLowerCase()
  if (pathWithoutQuery.endsWith('.mxl')) {
    await osmd.load(fileUrl)
    return
  }

  const response = await fetch(fileUrl)
  if (!response.ok) {
    // Keep OSMD's original error handling for inaccessible URLs.
    await osmd.load(fileUrl)
    return
  }

  const source = await response.text()
  const xmlDocument = new DOMParser().parseFromString(source, 'application/xml')
  const hasParseError = xmlDocument.getElementsByTagName('parsererror').length > 0
  const rootName = xmlDocument.documentElement?.localName
  if (hasParseError || (rootName !== 'score-partwise' && rootName !== 'score-timewise')) {
    // Do not transform unknown content; let OSMD handle it as before.
    await osmd.load(fileUrl)
    return
  }

  if (isGuitarScore) {
    let removedLegatoSlurs = 0
    let removedTieDuplicateSlurs = 0
    const normalizeEndpoint = (value: string | null) => {
      const type = (value ?? '').trim().toLowerCase()
      return type === 'end' ? 'stop' : type
    }
    for (const note of Array.from(xmlDocument.getElementsByTagName('note'))) {
      const notations = directChildren(note, 'notations')[0]
      if (!notations) continue
      const technical = directChildren(notations, 'technical')[0] ?? null
      const hpTypes = new Set<string>()
      for (const mark of Array.from(technical?.children ?? [])) {
        if (mark.localName !== 'hammer-on' && mark.localName !== 'pull-off') continue
        const endpoint = normalizeEndpoint(mark.getAttribute('type'))
        if (endpoint === 'start' || endpoint === 'stop') hpTypes.add(endpoint)
      }
      const xmlTieTypes = new Set(directChildren(note, 'tie').map(node => normalizeEndpoint(node.getAttribute('type'))))
      const visualTieTypes = new Set(directChildren(notations, 'tied').map(node => normalizeEndpoint(node.getAttribute('type'))))
      const mirroredTieTypes = new Set([...xmlTieTypes].filter(type =>
        (type === 'start' || type === 'stop') && visualTieTypes.has(type),
      ))
      for (const slur of directChildren(notations, 'slur')) {
        const endpoint = normalizeEndpoint(slur.getAttribute('type'))
        if (hpTypes.has(endpoint)) {
          // H/P exporters can duplicate an arc as a normal slur. Playback still reads original XML.
          slur.parentNode?.removeChild(slur)
          removedLegatoSlurs++
          hpTypes.delete(endpoint)
        } else if (mirroredTieTypes.has(endpoint)) {
          // Guitar TAB rendering preference: when the same note's tie endpoint is represented by
          // both MusicXML <tie> and <tied>, a same-endpoint <slur> can create a second short arc.
          // Remove only that display-copy slur; original XML and playback duration are untouched.
          slur.parentNode?.removeChild(slur)
          removedTieDuplicateSlurs++
          mirroredTieTypes.delete(endpoint)
        }
      }
    }
    if (removedLegatoSlurs > 0 || removedTieDuplicateSlurs > 0) {
      console.info(`[慢半拍] Display-only curve dedupe: hammer/pull-off slurs ${removedLegatoSlurs}, tied-note duplicate slurs ${removedTieDuplicateSlurs}.`)
    }
  }

  const pageWidth = Number(xmlDocument.getElementsByTagName('page-width')[0]?.textContent) || 1200
  const rightCreditX = Math.max(60, pageWidth - 80)
  const titleTextSet = new Set([
    ...Array.from(xmlDocument.getElementsByTagName('work-title')).map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
    ...Array.from(xmlDocument.getElementsByTagName('movement-title')).map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
  ].filter(Boolean))
  const isCopyrightCredit = (value: string) => /copyright|\bcopyright\b|©|all rights reserved|published by|版權|版权|著作權|著作权/i.test(value)
  const credits = Array.from(xmlDocument.getElementsByTagName('credit'))
  let removedPageNumberCredits = 0
  let rightAlignedCredits = 0
  const existingCreditText = new Set<string>()
  const artistCreditTypes = new Set(['composer', 'lyricist', 'arranger', 'artist', 'performer', 'writer', 'author', 'poet', 'librettist', 'translator', 'transcriber', 'editor', 'music', 'words'])
  const rightCreditItems: Array<{ words: Element; value: string; originalY: number }> = []
  for (const credit of credits) {
    const creditWords = Array.from(credit.children).filter(element => element.localName === 'credit-words')
    const value = creditWords.map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
    if (value) existingCreditText.add(value.toLocaleLowerCase())
    if (credit.hasAttribute('page') && /^\d{1,4}$/.test(value)) {
      credit.parentNode?.removeChild(credit)
      removedPageNumberCredits++
      continue
    }
    const typeValues = Array.from(credit.children).filter(element => element.localName === 'credit-type')
      .map(node => (node.textContent ?? '').trim().toLowerCase())
    const explicitlyArtist = typeValues.some(type => artistCreditTypes.has(type))
    for (const words of creditWords) {
      const text = (words.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text || /^\d{1,4}$/.test(text) || titleTextSet.has(text) || isCopyrightCredit(text)) continue
      // In many Guitar Pro/Sibelius exports names are credit-words without a credit-type.
      // Align all non-title/non-copyright credits to the right, not only typed composers.
      if (!explicitlyArtist && typeValues.some(type => /title|subtitle|copyright|publisher|rights/.test(type))) continue
      const rawY = Number(words.getAttribute('default-y'))
      rightCreditItems.push({ words, value: text, originalY: Number.isFinite(rawY) ? rawY : Number.NaN })
    }
  }
  // If a guitar score stores people only under <identification><creator>, turn any missing
  // composer/lyricist/arranger/artist into a normal right-aligned credit instead of leaving
  // OSMD to place it in the left-side composer slot.
  if (isGuitarScore) {
    const creators = Array.from(xmlDocument.getElementsByTagName('creator'))
      .map(node => ({ node, value: (node.textContent ?? '').replace(/\s+/g, ' ').trim(), type: (node.getAttribute('type') ?? 'artist').toLowerCase() }))
      .filter(item => item.value && (artistCreditTypes.has(item.type) || item.type === 'songwriter'))
    let nextY = Math.max(pageWidth, Number(xmlDocument.getElementsByTagName('page-height')[0]?.textContent) || 1600)
    for (const item of rightCreditItems) if (Number.isFinite(item.originalY)) nextY = Math.max(nextY, item.originalY + 18)
    let addedCreatorCredits = 0
    for (const creator of creators) {
      const key = creator.value.toLocaleLowerCase()
      if ([...existingCreditText].some(existing => existing === key || existing.includes(key))) continue
      const credit = xmlDocument.createElement('credit')
      credit.setAttribute('page', '1')
      const typeNode = xmlDocument.createElement('credit-type')
      typeNode.textContent = creator.type
      credit.appendChild(typeNode)
      const words = xmlDocument.createElement('credit-words')
      words.setAttribute('default-x', String(rightCreditX))
      words.setAttribute('default-y', String(nextY - addedCreatorCredits * 20))
      words.setAttribute('justify', 'right')
      words.setAttribute('valign', 'middle')
      words.setAttribute('font-size', '11')
      words.textContent = creator.value
      credit.appendChild(words)
      const partList = xmlDocument.getElementsByTagName('part-list')[0] ?? xmlDocument.getElementsByTagName('part')[0] ?? null
      if (partList && partList.parentNode === xmlDocument.documentElement) xmlDocument.documentElement.insertBefore(credit, partList)
      else xmlDocument.documentElement.appendChild(credit)
      existingCreditText.add(key)
      addedCreatorCredits++
    }
  }
  // Preserve title centering, but force people/metadata names to the page's right margin.
  rightCreditItems.sort((a, b) => {
    if (Number.isFinite(a.originalY) && Number.isFinite(b.originalY)) return b.originalY - a.originalY
    if (Number.isFinite(a.originalY)) return -1
    if (Number.isFinite(b.originalY)) return 1
    return 0
  })
  let lastY = Number.POSITIVE_INFINITY
  const pageHeightForCredits = Number(xmlDocument.getElementsByTagName('page-height')[0]?.textContent) || 1600
  let implicitCreditY = Math.max(pageHeightForCredits - 50, ...rightCreditItems.map(item => Number.isFinite(item.originalY) ? item.originalY + 14 : 0))
  for (const item of rightCreditItems) {
    item.words.setAttribute('default-x', String(rightCreditX))
    item.words.setAttribute('justify', 'right')
    let y = item.originalY
    if (!Number.isFinite(y)) {
      y = Number.isFinite(lastY) ? lastY - 16 : implicitCreditY
      implicitCreditY = y - 16
    }
    if (Number.isFinite(lastY) && lastY - y < 12) y = lastY - 16
    item.words.setAttribute('default-y', String(y))
    lastY = y
    rightAlignedCredits++
  }
  if (rightAlignedCredits > 0) console.info(`[慢半拍] Right-aligned ${rightAlignedCredits} non-title music credits.`)

  if (removedPageNumberCredits > 0) {
    console.info(
      `[ScoreRoom] Removed ${removedPageNumberCredits} printed page-number credit(s); OSMD measure numbers remain enabled.`,
    )
  }

  const lastPathPart = pathWithoutQuery.split('/').filter(Boolean).pop() ?? 'Untitled Score'
  let tempTitle = lastPathPart.replace(/\.(musicxml|xml)$/i, '')
  try {
    tempTitle = decodeURIComponent(tempTitle)
  } catch {
    // Keep the literal file name if URL decoding fails.
  }
  await osmd.load(xmlDocument, tempTitle)
}

/**
 * DOM-backed fallback for whole-system playback hit areas.
 *
 * OSMD's GraphicalMeasure is one measure on one staff line. The VexFlow wrapper does
 * not expose a stable DOM group on every supported OSMD/VexFlow version, which can
 * make the regular MeasureList-to-SVG path produce zero hit areas. The renderer does,
 * however, wrap each rendered staff line in `g.staffline`, and the graphical model
 * exposes MusicPages -> MusicSystems -> GraphicalMeasures. Pair those two stable
 * structures by render order to recover a whole system's bounds and its first source
 * measure index.
 */
type ScoreRoomLineFallbackRow = {
  rowNumber: number
  startIndex: number
  top: number
  bottom: number
  left: number
  right: number
}

function flattenGraphicalMeasureArrays(value: any, output: any[] = []): any[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenGraphicalMeasureArrays(item, output)
  } else if (value && typeof value === 'object') {
    output.push(value)
  }
  return output
}

function getStaffLineFallbackRows(container: HTMLElement, osmd: any): ScoreRoomLineFallbackRow[] {
  const graphic = osmd?.Graphic ?? osmd?.graphic
  const pages: any[] = graphic?.MusicPages ?? graphic?.musicPages ?? []
  const systems: any[] = []
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageSystems = page?.MusicSystems ?? page?.musicSystems ?? []
    if (Array.isArray(pageSystems)) systems.push(...pageSystems)
  }
  if (systems.length === 0) return []

  // `g.staffline` is created by OSMD's SVG drawer around the whole rendered staff
  // line (including its notes/notations). Its screen bounds therefore also survive
  // cases where the private VexFlow measure group is unavailable.
  const staffNodes = Array.from(container.querySelectorAll<SVGGElement>('g.staffline'))
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .filter(item => item.rect.width > 20 && item.rect.height > 0 &&
      Number.isFinite(item.rect.top) && Number.isFinite(item.rect.bottom))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)

  if (staffNodes.length === 0) return []

  const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
  const rows: ScoreRoomLineFallbackRow[] = []
  let staffOffset = 0
  let nextSourceFallback = 0

  for (const system of systems) {
    const graphicalMeasuresRaw = system?.GraphicalMeasures ?? system?.graphicalMeasures ?? []
    const graphicalMeasureRows: any[][] = Array.isArray(graphicalMeasuresRaw)
      ? graphicalMeasuresRaw.map((row: any) => Array.isArray(row) ? row : (row ? [row] : []))
      : []
    const graphicalMeasures = flattenGraphicalMeasureArrays(graphicalMeasureRows)

    const validIndexes: number[] = []
    for (const graphicalMeasure of graphicalMeasures) {
      const sourceMeasure = graphicalMeasure?.parentSourceMeasure ?? graphicalMeasure?.ParentSourceMeasure
      const index = resolveSourceMeasureIndex(osmd, sourceMeasure, -1)
      if (Number.isInteger(index) && index >= 0 && index < sourceMeasures.length) validIndexes.push(index)
    }
    const uniqueIndexes = Array.from(new Set(validIndexes)).sort((a, b) => a - b)
    const measureCountFromRows = Math.max(0, ...graphicalMeasureRows.map(row => row.filter((measure: any) =>
      !(measure?.IsExtraGraphicalMeasure ?? measure?.isExtraGraphicalMeasure),
    ).length))
    // If canonical indexes are available, count only those source measures. Otherwise
    // exclude explicit OSMD synthetic extras before advancing the fallback system range.
    const measureCount = uniqueIndexes.length > 0
      ? uniqueIndexes.length
      : Math.max(1, measureCountFromRows)
    const startIndex = uniqueIndexes.length > 0 ? uniqueIndexes[0] : nextSourceFallback

    const staffLinesRaw = system?.StaffLines ?? system?.staffLines ?? []
    let staffCount = Array.isArray(staffLinesRaw) ? staffLinesRaw.length : 0
    if (staffCount <= 0) staffCount = graphicalMeasureRows.length
    if (staffCount <= 0) staffCount = 1

    const batch = staffNodes.slice(staffOffset, staffOffset + staffCount)
    staffOffset += staffCount
    if (batch.length === 0) {
      const nextKnownSource = uniqueIndexes.length > 0 ? Math.max(...uniqueIndexes) + 1 : startIndex + measureCount
      nextSourceFallback = Math.max(nextSourceFallback, nextKnownSource)
      continue
    }

    const left = Math.min(...batch.map(item => item.rect.left))
    const right = Math.max(...batch.map(item => item.rect.right))
    const top = Math.min(...batch.map(item => item.rect.top))
    const bottom = Math.max(...batch.map(item => item.rect.bottom))
    if (right > left && bottom > top && Number.isFinite(startIndex)) {
      rows.push({ rowNumber: rows.length + 1, startIndex, top, bottom, left, right })
    }
    const nextKnownSource = uniqueIndexes.length > 0 ? Math.max(...uniqueIndexes) + 1 : startIndex + measureCount
    nextSourceFallback = Math.max(nextSourceFallback, nextKnownSource)
  }

  // Protect against an incomplete/older model by using the source-measure range and
  // staff-line groups directly for the unmatched tail. The model-derived rows above
  // remain authoritative whenever present.
  if (rows.length === 0 && sourceMeasures.length > 0 && staffNodes.length > 0) {
    const guessedStaffCount = graphicalStaffCountFromScore(osmd)
    const safeStaffCount = Math.max(1, guessedStaffCount)
    let index = 0
    for (let offset = 0; offset < staffNodes.length; offset += safeStaffCount) {
      const batch = staffNodes.slice(offset, offset + safeStaffCount)
      if (!batch.length || index >= sourceMeasures.length) break
      rows.push({
        rowNumber: rows.length + 1,
        startIndex: index,
        top: Math.min(...batch.map(item => item.rect.top)),
        bottom: Math.max(...batch.map(item => item.rect.bottom)),
        left: Math.min(...batch.map(item => item.rect.left)),
        right: Math.max(...batch.map(item => item.rect.right)),
      })
      // In the last-resort path, advance by the number of measures in one system from
      // the graphical system model, if available. Never reuse one start index twice.
      const modelSystem = systems[rows.length - 1]
      const modelRows = modelSystem?.GraphicalMeasures ?? modelSystem?.graphicalMeasures ?? []
      const count = Math.max(1, ...(Array.isArray(modelRows) ? modelRows.map((row: any) => Array.isArray(row) ? row.length : 1) : [1]))
      index += count
    }
  }

  return rows.sort((a, b) => a.top - b.top).map((row, index) => ({ ...row, rowNumber: index + 1 }))
}

function graphicalStaffCountFromScore(osmd: any): number {
  const systems: any[] = []
  const pages: any[] = osmd?.Graphic?.MusicPages ?? osmd?.graphic?.MusicPages ?? []
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageSystems = page?.MusicSystems ?? page?.musicSystems ?? []
    if (Array.isArray(pageSystems)) systems.push(...pageSystems)
  }
  const counts = systems.map(system => {
    const staffLines = system?.StaffLines ?? system?.staffLines
    const gms = system?.GraphicalMeasures ?? system?.graphicalMeasures
    return Array.isArray(staffLines) && staffLines.length > 0
      ? staffLines.length
      : (Array.isArray(gms) && gms.length > 0 ? gms.length : 1)
  }).filter((count: number) => Number.isFinite(count) && count > 0)
  return counts.length ? counts[0] : 1
}

function installStaffLineFallbackHitAreas(
  container: HTMLElement,
  osmd: any,
  onLineClick?: (rowStartMeasureIndex: number, rowNumber: number) => void,
  options: { append?: boolean; onlyMissingRows?: boolean } = {},
): number {
  const rows = getStaffLineFallbackRows(container, osmd)
  if (rows.length === 0) return 0

  if (!container.style.position || container.style.position === 'static') container.style.position = 'relative'
  let layer = container.querySelector<HTMLDivElement>(':scope > [data-score-room-hitbox-layer="true"]')
  if (!layer) {
    layer = document.createElement('div')
    layer.setAttribute('data-score-room-hitbox-layer', 'true')
    Object.assign(layer.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      zIndex: '100', pointerEvents: 'none', overflow: 'visible',
    } satisfies Partial<CSSStyleDeclaration>)
    container.appendChild(layer)
  }
  if (!options.append) layer.replaceChildren()

  const containerRect = container.getBoundingClientRect()
  const scaleY = containerRect.height / Math.max(1, container.offsetHeight)
  const scale = scaleY || 1
  const targetWidth = Math.max(container.clientWidth, container.offsetWidth, 1)
  let created = 0

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const previous = rows[index - 1]
    const next = rows[index + 1]
    let top = row.top - 28
    let bottom = row.bottom + 18
    if (previous) top = Math.max(top, (previous.bottom + row.top) / 2)
    if (next) bottom = Math.min(bottom, (row.bottom + next.top) / 2)

    // When the main measure-geometry path produced most rows but missed a system
    // (commonly the first system), append only fallback rows that are not already
    // represented by an existing clickable band. Compare in viewport coordinates so
    // browser zoom and CSS scaling do not affect the overlap test.
    if (options.append && options.onlyMissingRows) {
      const candidateHeight = Math.max(1, bottom - top)
      const candidateCenterY = (top + bottom) / 2
      const existingAreas = Array.from(layer.querySelectorAll<HTMLElement>('[data-score-room-line-hitbox="true"]'))
      const centeredAreas = existingAreas.filter(area => {
        const rect = area.getBoundingClientRect()
        return rect.top <= candidateCenterY && rect.bottom >= candidateCenterY
      })
      const exactRowAlreadyCovered = centeredAreas.some(area =>
        Number(area.dataset.lineStartMeasureIndex) === row.startIndex
      )

      // Always rebuild the first visible system's hitbox from staff-line DOM geometry.
      // The opening system can be shifted by title/tempo/clef spacing, so a primary
      // measure box may exist but still fail to cover the actual first row consistently.
      if (row.rowNumber === 1) {
        existingAreas.forEach(area => {
          const rect = area.getBoundingClientRect()
          const overlap = Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top))
          const overlapRatio = overlap / Math.max(1, Math.min(candidateHeight, rect.height))
          if (Number(area.dataset.lineStartMeasureIndex) === row.startIndex ||
              overlapRatio >= 0.12 || (rect.top <= candidateCenterY && rect.bottom >= candidateCenterY)) {
            area.remove()
          }
        })
      } else {
        if (exactRowAlreadyCovered) continue
        const overlapsExisting = existingAreas.some(area => {
          const rect = area.getBoundingClientRect()
          const overlap = Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top))
          return overlap / Math.max(1, Math.min(candidateHeight, rect.height)) >= 0.42
        })
        if (overlapsExisting) continue
      }
    }

    const localTop = (top - containerRect.top) / scale
    const localHeight = (bottom - top) / scale
    if (!Number.isFinite(localTop) || !Number.isFinite(localHeight) || localHeight < 5) continue

    const label = (() => {
      const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
      const measure = sourceMeasures[row.startIndex]
      const number = measure?.MeasureNumberPrinted ?? measure?.MeasureNumberXML ?? measure?.MeasureNumber
      return number !== undefined && number !== null && String(number).trim() ? String(number) : String(row.startIndex + 1)
    })()
    const hitArea = document.createElement('div')
    hitArea.setAttribute('data-score-room-line-hitbox', 'true')
    hitArea.setAttribute('data-line-number', String(row.rowNumber))
    hitArea.setAttribute('data-line-start-measure-index', String(row.startIndex))
    hitArea.setAttribute('role', 'button')
    hitArea.setAttribute('tabindex', '0')
    hitArea.setAttribute('aria-label', `從第 ${row.rowNumber} 行開始播放（本行第一個小節 ${label}）`)
    hitArea.title = `從第 ${row.rowNumber} 行開始播放（第 ${label} 小節）`
    Object.assign(hitArea.style, {
      position: 'absolute', left: '0px', top: `${localTop}px`,
      width: `${targetWidth}px`, height: `${localHeight}px`, margin: '0', padding: '0',
      border: '0', outline: 'none', background: 'rgba(255,255,255,0.001)',
      pointerEvents: 'none', cursor: 'pointer', touchAction: 'manipulation',
    } satisfies Partial<CSSStyleDeclaration>)
    if (onLineClick) {
      // Mouse clicks intentionally pass through this transparent element so the
      // container's live-coordinate hit test remains the single pointer authority.
      // Keep keyboard activation for accessibility.
      hitArea.addEventListener('keydown', event => {
        const keyboardEvent = event as KeyboardEvent
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return
        keyboardEvent.preventDefault()
        keyboardEvent.stopPropagation()
        onLineClick(row.startIndex, Number(hitArea.dataset.lineNumber || row.rowNumber))
      })
    }
    layer.appendChild(hitArea)
    created++
  }

  if (created > 0) console.info(`[ScoreRoom] Installed ${created} staff-line fallback playback areas.`)
  return created
}

/**
 * Build invisible hit areas for complete horizontal score systems (rows).
 *
 * In line mode, any click within a rendered system starts at its leftmost measure.
 * This avoids fragile per-measure hit-testing for exported scores whose SVG boxes
 * may not map cleanly to the source-measure index. Staff-level graphics sharing the
 * same set of source measures are combined so a piano grand staff is treated as one row.
 */
function installLineHitAreas(
  container: HTMLElement,
  osmd: any,
  onLineClick?: (rowStartMeasureIndex: number, rowNumber: number) => void,
): number {
  // Old versions used SVG <rect> hit targets. Some browser/SVG combinations leave
  // those rectangles visually present but unreliable for hit testing after OSMD zooms.
  // Use absolutely-positioned HTML targets instead. They sit above the page SVG and
  // receive normal DOM click events in every browser.
  container.querySelectorAll('[data-score-room-measure-hitbox="true"], [data-score-room-line-hitbox="true"]').forEach(element => element.remove())

  const measureList: any[][] = osmd?.Graphic?.MeasureList ?? osmd?.graphic?.MeasureList ?? []
  if (!Array.isArray(measureList) || measureList.length === 0) {
    return installStaffLineFallbackHitAreas(container, osmd, onLineClick)
  }

  type MeasureBounds = { rects: DOMRect[] }
  type RowBucket = { key: any; svg: SVGSVGElement; measures: Map<number, MeasureBounds> }
  const keyedRows: RowBucket[] = []
  const unkeyedBySvg = new Map<SVGSVGElement, Map<number, MeasureBounds>>()
  const svgNamespace = 'http://www.w3.org/2000/svg'

  const getMeasureGroup = (graphicalMeasure: any): SVGGraphicsElement | null => {
    const candidates = [
      graphicalMeasure?.VexFlowMeasure?.vfMeasure?.group,
      graphicalMeasure?.VexFlowMeasure?.vfMeasure?.getGroup?.(),
      graphicalMeasure?.VexFlowMeasure?.getGroup?.(),
      graphicalMeasure?.vfMeasure?.group,
      graphicalMeasure?.vfMeasure?.getGroup?.(),
      graphicalMeasure?.getGroup?.(),
    ]
    for (const candidate of candidates) {
      const element = candidate?.element ?? candidate?.el ?? candidate
      if (!element || element.namespaceURI !== svgNamespace ||
          typeof element.getBoundingClientRect !== 'function' || !element.ownerSVGElement) continue
      // OSMD/VexFlow wrapper objects may expose an inner SVG group (notes/stave) rather
      // than the full measure group. Hitbox geometry must use the actual rendered
      // `g.vf-measure` ancestor, otherwise a region can be placed over a different bar.
      const measureGroup = typeof element.closest === 'function'
        ? (element.matches?.('g.vf-measure') ? element : element.closest('g.vf-measure'))
        : null
      const normalized = measureGroup ?? element
      if (container.contains(normalized)) return normalized as SVGGraphicsElement
    }
    return null
  }

  const getSourceIndex = (graphicalMeasure: any, _fallbackIndex: number): number => {
    // Never fall back to MeasureList's visual slot index: one synthetic extra slot can
    // shift every subsequent measure from that point onward (as seen around mid-score
    // clef/key/time-signature changes). Unresolvable graphics are skipped, not mislabeled.
    return resolveGraphicalMeasureSourceIndex(osmd, graphicalMeasure)
  }

  const addBounds = (bucket: Map<number, MeasureBounds>, index: number, rect: DOMRect) => {
    let entry = bucket.get(index)
    if (!entry) {
      entry = { rects: [] }
      bucket.set(index, entry)
    }
    entry.rects.push(rect)
  }

  for (let listIndex = 0; listIndex < measureList.length; listIndex++) {
    const graphicalMeasures = Array.isArray(measureList[listIndex]) ? measureList[listIndex] : []
    for (const graphicalMeasure of graphicalMeasures) {
      const group = getMeasureGroup(graphicalMeasure)
      const svg = group?.ownerSVGElement
      if (!group || !svg || !container.contains(group)) continue
      const rect = group.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue

      const sourceIndex = getSourceIndex(graphicalMeasure, listIndex)
      const modelSystem = graphicalMeasure?.ParentMusicSystem ?? graphicalMeasure?.parentMusicSystem
      const domSystem = group.closest('g.vf-system, g.vf-music-system, g.vf-system-container')
      const systemKey = modelSystem && typeof modelSystem === 'object' ? modelSystem : domSystem
      if (systemKey) {
        let row = keyedRows.find(candidate => candidate.key === systemKey && candidate.svg === svg)
        if (!row) {
          row = { key: systemKey, svg, measures: new Map<number, MeasureBounds>() }
          keyedRows.push(row)
        }
        addBounds(row.measures, sourceIndex, rect)
      } else {
        let bucket = unkeyedBySvg.get(svg)
        if (!bucket) {
          bucket = new Map<number, MeasureBounds>()
          unkeyedBySvg.set(svg, bucket)
        }
        addBounds(bucket, sourceIndex, rect)
      }
    }
  }

  // Some OSMD builds do not expose a usable system model. Cluster by vertical position.
  const fallbackRows: RowBucket[] = []
  for (const [svg, measures] of unkeyedBySvg) {
    const entries = Array.from(measures.entries()).map(([index, info]) => {
      const left = Math.min(...info.rects.map(rect => rect.left))
      const right = Math.max(...info.rects.map(rect => rect.right))
      const top = Math.min(...info.rects.map(rect => rect.top))
      const bottom = Math.max(...info.rects.map(rect => rect.bottom))
      return { index, info, left, right, top, bottom, centerY: (top + bottom) / 2 }
    }).sort((a, b) => a.centerY - b.centerY)
    const clusters: Array<{ top: number; bottom: number; centerY: number; measures: Map<number, MeasureBounds> }> = []
    for (const entry of entries) {
      const height = Math.max(1, entry.bottom - entry.top)
      let selected: typeof clusters[number] | undefined
      let selectedScore = -1
      for (const cluster of clusters) {
        const overlap = Math.max(0, Math.min(entry.bottom, cluster.bottom) - Math.max(entry.top, cluster.top))
        const ratio = overlap / Math.max(1, Math.min(height, cluster.bottom - cluster.top))
        const distance = Math.abs(entry.centerY - cluster.centerY)
        const score = Math.max(ratio, distance <= 45 ? 0.31 : 0)
        if (score > selectedScore && score >= 0.28) { selected = cluster; selectedScore = score }
      }
      if (!selected) {
        selected = { top: entry.top, bottom: entry.bottom, centerY: entry.centerY, measures: new Map() }
        clusters.push(selected)
      }
      selected.measures.set(entry.index, entry.info)
      selected.top = Math.min(selected.top, entry.top)
      selected.bottom = Math.max(selected.bottom, entry.bottom)
      selected.centerY = (selected.top + selected.bottom) / 2
    }
    for (const cluster of clusters) fallbackRows.push({ key: cluster, svg, measures: cluster.measures })
  }

  const rows = [...keyedRows, ...fallbackRows]
  const containerRect = container.getBoundingClientRect()
  // getBoundingClientRect() returns viewport-space pixels, while absolute CSS offsets
  // are expressed in the container's untransformed layout pixels. Convert between the
  // two spaces so hit areas remain aligned under browser zoom, CSS transforms, and OSMD
  // re-layouts instead of drifting away from the visible measure groups.
  const layoutScaleX = containerRect.width / Math.max(1, container.offsetWidth)
  const layoutScaleY = containerRect.height / Math.max(1, container.offsetHeight)
  const toLocalX = (viewportX: number) => (viewportX - containerRect.left) / (layoutScaleX || 1)
  const toLocalY = (viewportY: number) => (viewportY - containerRect.top) / (layoutScaleY || 1)
  if (!container.style.position || container.style.position === 'static') container.style.position = 'relative'

  let layer = container.querySelector<HTMLDivElement>(':scope > [data-score-room-hitbox-layer="true"]')
  if (!layer) {
    layer = document.createElement('div')
    layer.setAttribute('data-score-room-hitbox-layer', 'true')
    Object.assign(layer.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      zIndex: '100', pointerEvents: 'none', overflow: 'visible',
    } satisfies Partial<CSSStyleDeclaration>)
    container.appendChild(layer)
  }
  layer.replaceChildren()

  type RowPlan = {
    row: RowBucket
    entries: Array<{ measureIndex: number; left: number; right: number; top: number; bottom: number; centerX: number }>
    actualTop: number
    actualBottom: number
    centerY: number
    rowTop: number
    rowBottom: number
  }
  const rawRowPlans: RowPlan[] = rows.map(row => {
    const entries = Array.from(row.measures.entries()).map(([measureIndex, info]) => {
      const left = Math.min(...info.rects.map(rect => rect.left))
      const right = Math.max(...info.rects.map(rect => rect.right))
      const top = Math.min(...info.rects.map(rect => rect.top))
      const bottom = Math.max(...info.rects.map(rect => rect.bottom))
      return { measureIndex, left, right, top, bottom, centerX: (left + right) / 2 }
    }).sort((a, b) => a.centerX - b.centerX)
    const actualTop = entries.length ? Math.min(...entries.map(entry => entry.top)) : Number.POSITIVE_INFINITY
    const actualBottom = entries.length ? Math.max(...entries.map(entry => entry.bottom)) : Number.NEGATIVE_INFINITY
    const centerY = (actualTop + actualBottom) / 2
    return { row, entries, actualTop, actualBottom, centerY, rowTop: actualTop - 34, rowBottom: actualBottom + 14 }
  }).filter(plan => plan.entries.length > 0 && Number.isFinite(plan.actualTop) && Number.isFinite(plan.actualBottom))

  // Merge staff-level buckets belonging to the same logical system. This is useful
  // when OSMD exposes the piano treble and bass staves as separate graphic containers.
  const rowPlans: RowPlan[] = []
  for (const candidate of rawRowPlans) {
    const candidateSet = new Set(candidate.entries.map(entry => entry.measureIndex))
    let match: RowPlan | undefined
    for (const existing of rowPlans) {
      const existingSet = new Set(existing.entries.map(entry => entry.measureIndex))
      let overlap = 0
      for (const index of candidateSet) if (existingSet.has(index)) overlap++
      const overlapRatio = overlap / Math.max(1, Math.min(candidateSet.size, existingSet.size))
      if (overlapRatio >= 0.6) { match = existing; break }
    }
    if (!match) {
      rowPlans.push(candidate)
      continue
    }

    const byIndex = new Map<number, RowPlan['entries'][number]>()
    for (const entry of [...match.entries, ...candidate.entries]) {
      const prior = byIndex.get(entry.measureIndex)
      if (!prior) byIndex.set(entry.measureIndex, { ...entry })
      else {
        prior.left = Math.min(prior.left, entry.left)
        prior.right = Math.max(prior.right, entry.right)
        prior.top = Math.min(prior.top, entry.top)
        prior.bottom = Math.max(prior.bottom, entry.bottom)
        prior.centerX = (prior.left + prior.right) / 2
      }
    }
    match.entries = Array.from(byIndex.values()).sort((a, b) => a.centerX - b.centerX)
    match.actualTop = Math.min(match.actualTop, candidate.actualTop)
    match.actualBottom = Math.max(match.actualBottom, candidate.actualBottom)
    match.centerY = (match.actualTop + match.actualBottom) / 2
    match.rowTop = match.actualTop - 34
    match.rowBottom = match.actualBottom + 14
  }
  rowPlans.sort((a, b) => a.centerY - b.centerY)

  // Clamp each logical system's click band to the space between adjacent systems.
  for (let i = 0; i < rowPlans.length; i++) {
    const plan = rowPlans[i]
    const previous = rowPlans[i - 1]
    const next = rowPlans[i + 1]
    if (previous) {
      const boundary = previous.actualBottom < plan.actualTop
        ? (previous.actualBottom + plan.actualTop) / 2
        : (previous.centerY + plan.centerY) / 2
      plan.rowTop = Math.max(plan.rowTop, boundary)
    }
    if (next) {
      const boundary = plan.actualBottom < next.actualTop
        ? (plan.actualBottom + next.actualTop) / 2
        : (plan.centerY + next.centerY) / 2
      plan.rowBottom = Math.min(plan.rowBottom, boundary)
    }
  }

  let created = 0
  const sourceMeasuresForLabels: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
  for (let index = 0; index < rowPlans.length; index++) {
    const plan = rowPlans[index]
    const firstEntry = [...plan.entries].sort((a, b) => a.centerX - b.centerX)[0]
    if (!firstEntry) continue
    const rowStartMeasureIndex = firstEntry.measureIndex
    const sourceMeasure = sourceMeasuresForLabels[rowStartMeasureIndex]
    const printedNumber = sourceMeasure?.MeasureNumberPrinted ??
      sourceMeasure?.MeasureNumberXML ?? sourceMeasure?.MeasureNumber ?? rowStartMeasureIndex + 1
    const targetTop = toLocalY(plan.rowTop)
    const targetHeight = (plan.rowBottom - plan.rowTop) / (layoutScaleY || 1)
    const targetWidth = Math.max(container.clientWidth, container.offsetWidth, 1)
    if (![targetTop, targetHeight, targetWidth].every(Number.isFinite) || targetHeight < 4) continue

    const hitArea = document.createElement('div')
    hitArea.setAttribute('data-score-room-line-hitbox', 'true')
    hitArea.setAttribute('data-line-number', String(index + 1))
    hitArea.setAttribute('data-line-start-measure-index', String(rowStartMeasureIndex))
    hitArea.setAttribute('role', 'button')
    hitArea.setAttribute('tabindex', '0')
    hitArea.setAttribute('aria-label', `從第 ${index + 1} 行開始播放（本行第一個小節 ${printedNumber}）`)
    hitArea.title = `從第 ${index + 1} 行開始播放（第 ${printedNumber} 小節）`
    Object.assign(hitArea.style, {
      position: 'absolute', left: '0px', top: `${targetTop}px`,
      width: `${targetWidth}px`, height: `${targetHeight}px`, margin: '0', padding: '0',
      border: '0', outline: 'none', background: 'rgba(255,255,255,0.001)',
      pointerEvents: 'none', cursor: 'pointer', touchAction: 'manipulation',
    } satisfies Partial<CSSStyleDeclaration>)

    if (onLineClick) {
      // Mouse input bubbles to the score container and is resolved against the current
      // rendered geometry; this layer must not swallow pointer events after re-layout.
      hitArea.addEventListener('keydown', event => {
        const keyboardEvent = event as KeyboardEvent
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return
        keyboardEvent.preventDefault()
        keyboardEvent.stopPropagation()
        onLineClick(rowStartMeasureIndex, Number(hitArea.dataset.lineNumber || index + 1))
      })
    }
    layer.appendChild(hitArea)
    created++
  }

  if (created > 0) {
    // A partial main pass can silently omit the first system when its special opening
    // measure does not expose a regular VexFlow group. Fill only gaps from staff-line
    // DOM geometry instead of requiring *all* main rows to fail before fallback runs.
    const fallbackCreated = installStaffLineFallbackHitAreas(container, osmd, onLineClick, {
      append: true,
      onlyMissingRows: true,
    })
    const hitLayer = container.querySelector<HTMLElement>(':scope > [data-score-room-hitbox-layer="true"]')
    if (hitLayer) {
      const orderedAreas = Array.from(hitLayer.querySelectorAll<HTMLElement>('[data-score-room-line-hitbox="true"]'))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
      orderedAreas.forEach((area, rowIndex) => {
        const rowNumber = rowIndex + 1
        area.dataset.lineNumber = String(rowNumber)
        const sourceIndex = Number(area.dataset.lineStartMeasureIndex)
        const sourceMeasure = sourceMeasures[sourceIndex]
        const printedNumber = sourceMeasure?.MeasureNumberPrinted ?? sourceMeasure?.MeasureNumberXML ?? sourceMeasure?.MeasureNumber ?? sourceIndex + 1
        area.setAttribute('aria-label', `從第 ${rowNumber} 行開始播放（本行第一個小節 ${printedNumber}）`)
        area.title = `從第 ${rowNumber} 行開始播放（第 ${printedNumber} 小節）`
      })
    }
    console.info(`[ScoreRoom] Installed ${created} primary and ${fallbackCreated} missing-system full-line playback hit areas.`)
    return created + fallbackCreated
  }

  // In some OSMD builds MeasureList exposes graphical measures but not their internal
  // VexFlow DOM group. Fall back to the renderer's `g.staffline` groups instead of
  // leaving the entire score unclickable.
  const fallbackCreated = installStaffLineFallbackHitAreas(container, osmd, onLineClick)
  if (fallbackCreated > 0) return fallbackCreated

  console.warn('[ScoreRoom] No line hit areas could be built; click-time staff-line detection remains enabled.')
  return 0
}

export default function ScoreReader({
  fileUrl = '/scores/test.musicxml',
  scoreType,
}: ScoreReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const hoveredScoreMeasureRef = useRef<{ group: SVGGElement; overlay: SVGRectElement } | null>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const zoomRef = useRef(1)
  const chordFramesRef = useRef<ChordFrameData[]>([])
  const lyricTextsRef = useRef<Set<string>>(new Set())
  const brushNoteEventsRef = useRef<BrushNoteEvent[]>([])
  const isGuitarTabRef = useRef(false)
  const redrawOverlaysRef = useRef<((container: HTMLElement) => void) | null>(null)
  const theoryOverlayRedrawRef = useRef<(() => void) | null>(null)
  const lastTheoryPlaybackMeasureRef = useRef<number | null>(null)
  // OSMD DOM hit areas are installed by a long-lived effect. Route their clicks through
  // this ref so they always call the latest handlers rather than a stale render closure.
  const lineClickActionRef = useRef<((rowStartMeasureIndex: number, rowNumber: number) => void) | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const previousLang = root.lang
    root.lang = 'zh-TW'
    return () => {
      if (root.lang === 'zh-TW') root.lang = previousLang
    }
  }, [])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(100)
  const [showChordDiagrams, setShowChordDiagrams] = useState(false)
  const [showTheoryPanel, setShowTheoryPanel] = useState(false)
  const [theoryLoading, setTheoryLoading] = useState(false)
  const [theoryError, setTheoryError] = useState('')
  const [theoryAnalysis, setTheoryAnalysis] = useState<ScoreTheoryAnalysis | null>(null)
  const [theoryLoadedForUrl, setTheoryLoadedForUrl] = useState('')
  const [guitarSetupInfo, setGuitarSetupInfo] = useState<GuitarSetupInfo | null>(null)
  const [selectedTheoryMeasureIndex, setSelectedTheoryMeasureIndex] = useState(0)
  const [scoreAnnotationLayers, setScoreAnnotationLayers] = useState<ScoreAnnotationLayers>({
    chordNames: false,
    romanNumerals: false,
    bassLine: false,
    nonChordHints: false,
    melodyContour: false,
  })
  const scoreAnnotationsEnabled = scoreAnnotationLayers.chordNames || scoreAnnotationLayers.romanNumerals ||
    scoreAnnotationLayers.bassLine || scoreAnnotationLayers.nonChordHints || scoreAnnotationLayers.melodyContour
  const appliedAnnotationSpacingRef = useRef<'off' | 'regular' | 'melody' | null>(null)
  const baseTitleBottomDistanceRef = useRef<number | null>(null)
  const pedalCorrectionIndicesRef = useRef<number[]>([])
  const suppressObserverRedrawRef = useRef(false)
  // Manual chord corrections are scoped to a score URL and persisted locally. They alter
  // theory presentation only; the source XML and playback timeline are never modified.
  const [theoryChordCorrections, setTheoryChordCorrections] = useState<Record<string, string>>({})
  const [theoryCorrectionsLoadedForUrl, setTheoryCorrectionsLoadedForUrl] = useState('')
  const effectiveShowChordDiagrams = scoreType !== 'piano' && showChordDiagrams
  const shouldShowGuitarSetup = scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle' || guitarSetupInfo?.isTab === true
  const guitarCapoLabel = !guitarSetupInfo || guitarSetupInfo.capoValues.length === 0
    ? '未標註'
    : guitarSetupInfo.capoValues.length === 1
      ? (guitarSetupInfo.capoValues[0] === 0 ? '未使用（0 品）' : `${guitarSetupInfo.capoValues[0]} 品`)
      : `${guitarSetupInfo.capoValues.map(value => value === 0 ? '無' : `${value} 品`).join(' → ')}（譜面有變化）`
  const guitarTuningLabel = guitarSetupInfo?.tuning.length
    ? guitarSetupInfo.tuning.map(entry => `${entry.stringNumber}弦 ${entry.pitchLabel}`).join('　·　')
    : '未標註'
  const audioContextRef = useRef<AudioContext | null>(null)
  const activePlaybackVoicesRef = useRef<Set<ActivePlaybackVoice>>(new Set())
  const playbackFrameRef = useRef<number | null>(null)
  // A monotonically increasing generation invalidates any stale RAF callback left
  // behind by a seek, pause, score reload, or a new playback start.
  const playbackEpochRef = useRef(0)
  // Explicit seeks can await AudioContext/sample startup. Re-apply the requested cursor
  // after cursor options are configured so the old graphical box cannot survive the seek.
  const pendingCursorSyncEventIndexRef = useRef<number | null>(null)
  const playbackEventsRef = useRef<PlaybackTimelineEvent[]>([])
  // Per-measure barline boundaries used to emulate a fresh sustain-pedal cycle on guitar.
  const guitarMeasureEndTimesRef = useRef<Map<number, number>>(new Map())
  // Visual cursor follows the current score time; audio events are queued separately
  // with a Web Audio look-ahead to tolerate brief main-thread stalls.
  const playbackNextEventIndexRef = useRef(0)
  const playbackAudioNextEventIndexRef = useRef(0)
  const playbackCursorIndexRef = useRef(0)
  const playbackUiLastUpdateMsRef = useRef(0)
  const playbackOriginRef = useRef(0)
  const playbackTimeRef = useRef(0)
  const playbackSpeedRef = useRef(1)
  const playbackDurationRef = useRef(0)
  const playbackRunningRef = useRef(false)
  const playbackStartAttemptRef = useRef(0)
  const playbackStartInProgressRef = useRef(false)
  const pianoSampleBuffersRef = useRef<Map<number, AudioBuffer>>(new Map())
  const pianoSamplePromisesRef = useRef<Map<number, Promise<AudioBuffer>>>(new Map())
  // Cache nearest-neighbour sample selection so each note does not allocate and sort
  // the full sample-buffer table during playback.
  const pianoNearestSampleCacheRef = useRef<Map<number, { midi: number; buffer: AudioBuffer }>>(new Map())
  const guitarSampleBuffersRef = useRef<Map<GuitarSoundfontInstrument, Map<number, AudioBuffer>>>(new Map())
  const guitarSampleDataPromisesRef = useRef<Map<GuitarSoundfontInstrument, Promise<Map<number, string>>>>(new Map())
  const guitarSampleLoadPromisesRef = useRef<Map<GuitarSoundfontInstrument, Promise<void>>>(new Map())
  const guitarNearestSampleCacheRef = useRef<Map<GuitarSoundfontInstrument, Map<number, { midi: number; buffer: AudioBuffer }>>>(new Map())
  const activeMetronomeVoicesRef = useRef<Set<ActivePlaybackVoice>>(new Set())
  const metronomeBeatGridRef = useRef<MetronomeBeat[]>([])
  const metronomeMetersRef = useRef<Map<number, ScoreMeter>>(new Map([[0, { beats: 4, beatType: 4 }]]))
  const metronomeNextBeatIndexRef = useRef(0)
  const metronomeSubdivisionRef = useRef<1 | 2 | 4>(1)
  const playbackStartScoreTimeRef = useRef(0)
  const metronomeEnabledRef = useRef(false)
  const countInBarsRef = useRef(0)
  const isCountingInRef = useRef(false)
  const loopARef = useRef<number | null>(null)
  const loopBRef = useRef<number | null>(null)
  const abLoopEnabledRef = useRef(false)
  // Piano playback uses notehead tinting instead of OSMD's tall full-system cursor.
  // This keeps the highlight attached to the actual notes and inside the staff.
  const highlightedNoteShapesRef = useRef(new Map<SVGElement, string | null>())

  const [isPlaying, setIsPlaying] = useState(false)
  const [isPreparingPlayback, setIsPreparingPlayback] = useState(false)
  const [playbackSeconds, setPlaybackSeconds] = useState(0)
  const [playbackDuration, setPlaybackDuration] = useState(0)
  const [progressPreview, setProgressPreview] = useState<number | null>(null)
  const progressWasPlayingRef = useRef(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [playbackError, setPlaybackError] = useState('')
  const [metronomeEnabled, setMetronomeEnabled] = useState(false)
  const [metronomeSubdivision, setMetronomeSubdivision] = useState<1 | 2 | 4>(1)
  const [countInBars, setCountInBars] = useState(0)
  const [isCountingIn, setIsCountingIn] = useState(false)
  const [metronomeMeterLabel, setMetronomeMeterLabel] = useState('4/4')
  // Progressive practice tempo: increase speed only after a configured number of
  // complete A-to-B loops. This is deliberately independent from note scheduling.
  const [tempoTrainerEnabled, setTempoTrainerEnabled] = useState(false)
  const [tempoTrainerTargetSpeed, setTempoTrainerTargetSpeed] = useState(1.25)
  const [tempoTrainerStep, setTempoTrainerStep] = useState(0.05)
  const [tempoTrainerRepeats, setTempoTrainerRepeats] = useState(2)
  const [tempoTrainerLoopCount, setTempoTrainerLoopCount] = useState(0)
  const [tempoTrainerStatus, setTempoTrainerStatus] = useState('')
  const tempoTrainerRef = useRef({
    enabled: false,
    targetSpeed: 1.25,
    step: 0.05,
    repeatsPerStep: 2,
    loopsAtCurrentSpeed: 0,
    totalLoops: 0,
  })
  const [pianoSampleStatus, setPianoSampleStatus] = useState('首次播放鋼琴譜時載入 Salamander 採樣音色')
  const [guitarSampleStatus, setGuitarSampleStatus] = useState('首次播放吉他譜時載入真實吉他採樣音色')
  const [performanceControlStatus, setPerformanceControlStatus] = useState('尚未讀取樂譜力度與踏板標記')
  const [scoreDynamicsEnabled, setScoreDynamicsEnabled] = useState(true)
  const scoreDynamicsEnabledRef = useRef(true)
  const [scorePedalEnabled, setScorePedalEnabled] = useState(true)
  const scorePedalEnabledRef = useRef(true)
  const [measureSeekStatus, setMeasureSeekStatus] = useState('')
  const [loopA, setLoopA] = useState<number | null>(null)
  const [loopB, setLoopB] = useState<number | null>(null)
  const [abLoopEnabled, setABLoopEnabledState] = useState(false)
  const [autoFollowPlayback, setAutoFollowPlayback] = useState(true)
  const autoFollowPlaybackRef = useRef(true)
  // null means no explicit user preference: preserve the existing default of following
  // when playback starts. Once the user switches follow on/off, future starts respect it.
  const autoFollowPlaybackPreferenceRef = useRef<boolean | null>(null)
  // Auto-follow is row-based: keep the viewport stable while the cursor moves through
  // notes in the same system, and scroll only when playback enters another system.
  const lastAutoFollowRowKeyRef = useRef<string | null>(null)
  const [playbackControlsVisible, setPlaybackControlsVisible] = useState(true)
  const [currentTheoryHudExpanded, setCurrentTheoryHudExpanded] = useState(true)
  // Programmatic scrolls are tagged so the auto-follow cancel logic only reacts to
  // deliberate user scrolling, not scrolling initiated by playback-follow or seeking.
  const programmaticScrollRef = useRef(false)
  const programmaticScrollTimerRef = useRef<number | null>(null)
  const keyboardShortcutsRef = useRef<{
    togglePlayback: () => void
    seek: (deltaSeconds: number) => void
    reset: () => void
    closePanels: () => boolean
    disableAutoFollow: () => void
  }>({
    togglePlayback: () => undefined,
    seek: () => undefined,
    reset: () => undefined,
    closePanels: () => false,
    disableAutoFollow: () => undefined,
  })

  useEffect(() => {
    // The fixed current-measure HUD uses this same analysis model, but its visibility
    // is independent from whether the large Theory Analysis panel is open.
    if (theoryLoadedForUrl === fileUrl) return
    let cancelled = false
    const loadTheory = async () => {
      setTheoryLoading(true)
      setTheoryError('')
      try {
        const response = await fetch(fileUrl)
        if (!response.ok) throw new Error(`無法讀取樂譜檔案（HTTP ${response.status}）。`)
        const text = await response.text()
        const analysis = analyseMusicXmlTheory(text)
        if (cancelled) return
        setTheoryAnalysis(analysis)
        setSelectedTheoryMeasureIndex(0)
        setTheoryLoadedForUrl(fileUrl)
      } catch (error) {
        if (cancelled) return
        setTheoryError(error instanceof Error ? error.message : '樂理分析失敗。')
        setTheoryLoadedForUrl(fileUrl)
      } finally {
        if (!cancelled) setTheoryLoading(false)
      }
    }
    void loadTheory()
    return () => { cancelled = true }
  }, [fileUrl, theoryLoadedForUrl])

  useEffect(() => {
    let cancelled = false
    const key = theoryCorrectionStorageKey(fileUrl)
    void (async () => {
      try {
        const response = await fetch(`/api/state?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`雲端樂理修正讀取失敗（HTTP ${response.status}）`)
        const payload = await response.json() as { value?: unknown; found?: boolean }
        let sourceValue = payload.value
        if (!payload.found) {
          // One-time copy of old hand-corrected chord names into the cloud.
          try {
            const legacyRaw = window.localStorage.getItem(key)
            if (legacyRaw) {
              const legacyParsed: unknown = JSON.parse(legacyRaw)
              if (legacyParsed && typeof legacyParsed === 'object' && !Array.isArray(legacyParsed)) {
                sourceValue = legacyParsed
                await fetch(`/api/state?key=${encodeURIComponent(key)}`, {
                  method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ value: legacyParsed }),
                })
              }
            }
          } catch (migrationError) {
            console.warn('[ScoreRoom] Legacy chord corrections could not be migrated:', migrationError)
          }
        }
        const loaded: Record<string, string> = {}
        if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
          for (const [id, value] of Object.entries(sourceValue as Record<string, unknown>)) {
            if (typeof value === 'string') loaded[id] = value
          }
        }
        if (!cancelled) {
          setTheoryChordCorrections(loaded)
          setTheoryCorrectionsLoadedForUrl(fileUrl)
        }
      } catch (error) {
        console.warn('[ScoreRoom] Could not load cloud chord corrections:', error)
        if (!cancelled) {
          setTheoryChordCorrections({})
          // Do not mark this URL as loaded: the save effect must not overwrite cloud data after a read failure.
        }
      }
    })()
    return () => { cancelled = true }
  }, [fileUrl])

  useEffect(() => {
    if (theoryCorrectionsLoadedForUrl !== fileUrl) return
    const key = theoryCorrectionStorageKey(fileUrl)
    void fetch(`/api/state?key=${encodeURIComponent(key)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: theoryChordCorrections }),
    }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    }).catch(error => console.warn('[ScoreRoom] Could not save cloud chord corrections:', error))
  }, [fileUrl, theoryChordCorrections, theoryCorrectionsLoadedForUrl])

  const displayTheoryAnalysis = useMemo<ScoreTheoryAnalysis | null>(() => {
    if (!theoryAnalysis) return null
    // Never apply the previous score's corrections during the one render before the
    // URL-scoped local corrections have loaded for the newly selected score.
    const scopedCorrections = theoryCorrectionsLoadedForUrl === fileUrl ? theoryChordCorrections : {}
    const correctedMeasures: TheoryMeasureInfo[] = theoryAnalysis.measures.map(measure => {
      const chords = measure.chords.map(chord => {
        const id = theoryCorrectionId(measure.sourceIndex, chord.onsetQuarter)
        const selectedKey = scopedCorrections[id]
        const candidate = selectedKey ? chord.candidateDetails?.find(item => item.key === selectedKey) : undefined
        if (!candidate) return { ...chord, evidenceSummary: chord.evidenceSummary ? [...chord.evidenceSummary] : undefined }
        return {
          ...chord,
          automaticSymbol: chord.automaticSymbol ?? chord.symbol,
          symbol: candidate.symbol,
          rootName: candidate.rootName,
          rootPc: candidate.rootPc,
          quality: candidate.quality,
          qualityLabel: candidate.qualityLabel,
          roman: candidate.roman,
          toneNames: [...candidate.toneNames],
          confidence: '人工校正' as const,
          evidenceSource: '人工校正' as const,
          evidenceSummary: [`人工選擇：${candidate.symbol}（原自動結果：${chord.automaticSymbol ?? chord.symbol}）`, ...candidate.evidenceSummary],
          matchingScore: candidate.score,
          alternatives: chord.alternatives,
          candidateDetails: chord.candidateDetails,
        }
      })
      return {
        ...measure,
        chords,
        primaryChord: chords[0] ?? null,
        nonChordHints: [...measure.nonChordHints],
      }
    })
    // Recompute dependent harmonic labels and non-chord hints after manual corrections.
    addTheoryLearningAnnotations(correctedMeasures)
    return { ...theoryAnalysis, measures: correctedMeasures }
  }, [theoryAnalysis, theoryChordCorrections, theoryCorrectionsLoadedForUrl, fileUrl])

  // A fixed playback HUD follows the source measure selected by the playback timeline.
  // During playback, the latest timeline event also determines which chord is active
  // inside a measure that contains more than one harmony change. When paused or browsing,
  // the selected measure remains the useful focus for analysis.
  const currentTheoryHud = useMemo(() => {
    if (!displayTheoryAnalysis?.measures.length) return null
    const events = playbackEventsRef.current
    let latestEvent: PlaybackTimelineEvent | null = null
    for (const event of events) {
      if (event.time <= playbackSeconds + 0.012) latestEvent = event
      else break
    }

    const timelineMeasureIndex = latestEvent && Number.isInteger(latestEvent.measureIndex)
      ? latestEvent.measureIndex
      : selectedTheoryMeasureIndex
    const preferredMeasureIndex = isPlaying ? timelineMeasureIndex : selectedTheoryMeasureIndex
    const measure = displayTheoryAnalysis.measures.find(item => item.sourceIndex === preferredMeasureIndex)
      ?? displayTheoryAnalysis.measures.find(item => item.sourceIndex === timelineMeasureIndex)
      ?? displayTheoryAnalysis.measures[0]
    if (!measure) return null

    const eventBelongsToMeasure = latestEvent?.measureIndex === measure.sourceIndex
    const quarterPosition = eventBelongsToMeasure ? latestEvent!.positionQuarter : 0
    const eligibleChords = [...measure.chords]
      .filter(chord => chord.onsetQuarter <= quarterPosition + 0.012)
      .sort((a, b) => a.onsetQuarter - b.onsetQuarter)
    const activeChord = (eligibleChords.length ? eligibleChords[eligibleChords.length - 1] : null)
      ?? measure.primaryChord ?? measure.chords[0] ?? null

    let octaveNotes: string[] = []
    if (activeChord) {
      const tonePitchClasses = new Set(activeChord.toneNames
        .map(theoryPitchClassFromName)
        .filter((value): value is number => value !== null))
      const soundingNotes = measure.notes.filter(note =>
        !note.isGrace && note.onsetQuarter <= activeChord.onsetQuarter + 0.001 &&
        note.onsetQuarter + Math.max(note.durationQuarter, 0.03) > activeChord.onsetQuarter + 0.001 &&
        (tonePitchClasses.size === 0 || tonePitchClasses.has(note.pitchClass)),
      ).sort((a, b) => a.midi - b.midi)
      octaveNotes = [...new Set(soundingNotes.map(note => note.name))]
      if (octaveNotes.length === 0) {
        const fallbackNotes = activeChord.actualNotes?.length ? activeChord.actualNotes : measure.notes.map(note => note.name)
        octaveNotes = [...new Set(fallbackNotes)]
      }
    }

    const hints = (Array.isArray(measure.nonChordHints) ? measure.nonChordHints : [])
      .slice(0, 4)
      .map(hint => `${hint.noteName}（${hint.label}）`)
    const chordsInMeasure = [...new Set(measure.chords.map(chord => chord.symbol).filter(Boolean))]
    return {
      measure,
      activeChord,
      octaveNotes: octaveNotes.slice(0, 8),
      bassName: activeChord?.bassName || measure.bassName || '—',
      roman: activeChord?.roman || measure.primaryChord?.roman || '—',
      nonChordText: hints.length ? hints.join('、') : '暫無候選音',
      chordSequence: chordsInMeasure.join(' → '),
    }
  }, [displayTheoryAnalysis, selectedTheoryMeasureIndex, playbackSeconds, isPlaying])

  // Stable alternative to floating score badges:
  // show the selected analysis mode in the measure cards inside the theory panel.
  // We deliberately do not position HTML labels over OSMD SVG geometry, because
  // rendered stave/measure groups are not a reliable cross-score measure anchor.
  useEffect(() => {
    const container = containerRef.current
    const clearTheoryOverlay = () => {
      container?.querySelectorAll('[data-score-room-theory-overlay="true"]').forEach(element => element.remove())
    }
    clearTheoryOverlay()
    theoryOverlayRedrawRef.current = clearTheoryOverlay
    return () => {
      if (theoryOverlayRedrawRef.current === clearTheoryOverlay) theoryOverlayRedrawRef.current = null
      clearTheoryOverlay()
    }
  }, [displayTheoryAnalysis, scoreAnnotationLayers, loading, error, zoom])

  // Annotation mode changes may require a different inter-system gap. Preserve the active
  // audio timeline, graphical cursor index, and viewport across every resulting OSMD render.
  useEffect(() => {
    if (loading) {
      appliedAnnotationSpacingRef.current = null
      return
    }
    const osmd = osmdRef.current as any
    const container = containerRef.current
    if (!osmd || !container || error) return
    // Analysis is presented in the panel's per-measure cards, not as floating score labels.
    // Keep OSMD's native engraving spacing stable for every analysis mode.
    const spacingMode: 'off' | 'regular' | 'melody' = 'off'
    const prior = appliedAnnotationSpacingRef.current
    if (prior === spacingMode) return
    appliedAnnotationSpacingRef.current = spacingMode
    // The initial score render already uses the base spacing values.
    if (prior === null && spacingMode === 'off') return

    const baseSystemGap = effectiveShowChordDiagrams ? 9 : 2.5
    const baseSkyBottomGap = effectiveShowChordDiagrams ? 6 : 1.5
    const baseTitleBottomDistance = baseTitleBottomDistanceRef.current ??
      Number(osmd.EngravingRules.TitleBottomDistance ?? 1)
    const melodyMode = spacingMode === 'melody'
    osmd.EngravingRules.MinimumDistanceBetweenSystems = scoreAnnotationsEnabled
      ? Math.max(baseSystemGap, melodyMode ? 27 : 15)
      : baseSystemGap
    osmd.EngravingRules.MinSkyBottomDistBetweenSystems = scoreAnnotationsEnabled
      ? Math.max(baseSkyBottomGap, melodyMode ? 17 : 10.5)
      : baseSkyBottomGap
    // Reserve a proper annotation band above the first system too, so labels never
    // collide with the native title/composer credits when the first row starts.
    osmd.EngravingRules.TitleBottomDistance = scoreAnnotationsEnabled
      ? Math.max(baseTitleBottomDistance, melodyMode ? 12 : 5.5)
      : baseTitleBottomDistance

    // OSMD.render() resets its graphical cursor. Keep the cursor's actual timeline
    // index rather than reconstructing it from the audio clock: the audio clock may be
    // ahead of the last rendered cursor frame, and cursor steps are not always a safe
    // one-to-one proxy for wall-clock time around grace notes and simultaneous notes.
    // This effect only changes engraving layout, never playback/audio position.
    const eventsBeforeRender = playbackEventsRef.current
    const cursorIndexBeforeRender = eventsBeforeRender.length > 0
      ? Math.max(0, Math.min(playbackCursorIndexRef.current, eventsBeforeRender.length - 1))
      : null

    const savedScrollX = window.scrollX
    const savedScrollY = window.scrollY
    const cursorBeforeRender = osmd.cursor
    if (cursorBeforeRender) {
      cursorBeforeRender.CursorOptions = {
        ...(cursorBeforeRender.CursorOptions ?? {}),
        follow: false,
      }
    }
    const restoreViewport = () => {
      if (Math.abs(window.scrollX - savedScrollX) > 1 || Math.abs(window.scrollY - savedScrollY) > 1) {
        scrollWindowProgrammatically(savedScrollY, 'auto', savedScrollX)
      }
    }

    try {
      suppressObserverRedrawRef.current = true
      restoreScoreRoomLayoutTransforms(container)
      osmd.render()
      if (applyPedalEndCorrections(osmd, pedalCorrectionIndicesRef.current)) {
        osmd.render()
      }
      // Restore the same graphical cursor immediately after render, before the next
      // playback animation frame can observe a reset cursor and treat it as row one.
      if (cursorIndexBeforeRender !== null) {
        positionCursorAtTimelineEvent(cursorIndexBeforeRender)
      }
      restoreViewport()
      window.requestAnimationFrame(() => {
        if (containerRef.current !== container || osmdRef.current !== osmd) {
          suppressObserverRedrawRef.current = false
          return
        }
        redrawOverlaysRef.current?.(container)
        restoreViewport()
        suppressObserverRedrawRef.current = false
      })
    } catch (renderError) {
      suppressObserverRedrawRef.current = false
      appliedAnnotationSpacingRef.current = prior
      console.warn('[ScoreRoom] Could not update annotation spacing:', renderError)
    }
  }, [scoreAnnotationsEnabled, scoreAnnotationLayers.melodyContour, effectiveShowChordDiagrams, loading, error, fileUrl])

  function stopActiveMetronomeClicks() {
    for (const voice of activeMetronomeVoicesRef.current) {
      try {
        voice.source.onended = null
        voice.source.stop()
      } catch {
        // A click that already ended can be ignored.
      }
      try { voice.source.disconnect() } catch { /* already disconnected */ }
      try { voice.gain.disconnect() } catch { /* already disconnected */ }
    }
    activeMetronomeVoicesRef.current.clear()
  }

  function scheduleMetronomeClick(
    context: AudioContext,
    requestedAudioTime: number,
    accent: boolean,
    subdivision = false,
    secondaryAccent = false,
  ) {
    if (context.state === 'closed') return
    const startAt = Math.max(context.currentTime + 0.002, requestedAudioTime)
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    const frequency = subdivision ? 690 : accent ? 1480 : secondaryAccent ? 1220 : 980
    oscillator.frequency.setValueAtTime(frequency, startAt)
    const peak = subdivision ? 0.042 : accent ? 0.16 : secondaryAccent ? 0.12 : 0.085
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + (subdivision ? 0.035 : accent ? 0.075 : secondaryAccent ? 0.065 : 0.055))
    oscillator.connect(gain)
    gain.connect(context.destination)
    const voice: ActivePlaybackVoice = { source: oscillator, gain, scheduledStartTime: startAt }
    activeMetronomeVoicesRef.current.add(voice)
    oscillator.onended = () => {
      activeMetronomeVoicesRef.current.delete(voice)
      try { oscillator.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    oscillator.start(startAt)
    oscillator.stop(startAt + (subdivision ? 0.04 : accent ? 0.08 : secondaryAccent ? 0.07 : 0.06))
  }

  function stopActivePlaybackNotes() {
    stopActiveMetronomeClicks()
    for (const voice of activePlaybackVoicesRef.current) {
      try {
        voice.source.onended = null
        voice.source.stop()
      } catch {
        // A voice that has already ended can safely be ignored.
      }
      try { voice.source.disconnect() } catch { /* already disconnected */ }
      try { voice.gain.disconnect() } catch { /* already disconnected */ }
    }
    activePlaybackVoicesRef.current.clear()
  }

  /** Cancel only voices scheduled in the future, preserving already sounding notes. */
  function cancelFutureScheduledVoices() {
    const context = audioContextRef.current
    if (!context || context.state === 'closed') return
    const cutoff = context.currentTime + 0.018
    const cancelFutureIn = (voices: Set<ActivePlaybackVoice>) => {
      for (const voice of Array.from(voices)) {
        if (voice.scheduledStartTime <= cutoff) continue
        try {
          voice.source.onended = null
          voice.source.stop()
        } catch { /* already stopped or ended */ }
        try { voice.source.disconnect() } catch { /* already disconnected */ }
        try { voice.gain.disconnect() } catch { /* already disconnected */ }
        voices.delete(voice)
      }
    }
    cancelFutureIn(activePlaybackVoicesRef.current)
    cancelFutureIn(activeMetronomeVoicesRef.current)
  }

  function cancelPlaybackFrame() {
    if (playbackFrameRef.current !== null) {
      window.cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = null
    }
  }

  function clearPlaybackNoteHighlights() {
    for (const [element, originalStyle] of highlightedNoteShapesRef.current) {
      if (!element.isConnected) continue
      element.removeAttribute('data-score-room-current-note')
      if (originalStyle === null) element.removeAttribute('style')
      else element.setAttribute('style', originalStyle)
    }
    highlightedNoteShapesRef.current.clear()
  }

  /** Add a zero-style anchor to the current guitar note so auto-follow can track it too. */
  function markCursorNoteAnchor(cursor: any): boolean {
    clearPlaybackNoteHighlights()
    const graphicalNotes: any[] = cursor?.GNotesUnderCursor?.() ?? []
    for (const graphicalNote of graphicalNotes) {
      const sourceNote = graphicalNote?.sourceNote
      const isRest = typeof sourceNote?.isRest === 'function'
        ? sourceNote.isRest()
        : Boolean(sourceNote?.IsRest ?? sourceNote?.isRest)
      if (isRest) continue
      const noteheads: Element[] = graphicalNote?.getNoteheadSVGs?.() ?? []
      for (const notehead of noteheads) {
        const shapes: Element[] = notehead.matches?.('path, ellipse, circle, polygon, rect')
          ? [notehead]
          : Array.from(notehead.querySelectorAll?.('path, ellipse, circle, polygon, rect') ?? [])
        const target = shapes[0] ?? notehead
        if (target instanceof SVGElement) {
          if (!highlightedNoteShapesRef.current.has(target)) {
            highlightedNoteShapesRef.current.set(target, target.getAttribute('style'))
          }
          target.setAttribute('data-score-room-current-note', 'true')
          return true
        }
      }
    }
    return false
  }

  /** Tint only the current piano noteheads. Unlike OSMD's default cursor, this never
   * paints a tall rectangle across the entire grand staff or beyond the staff lines. */
  function highlightPlaybackNoteheads(cursor: any) {
    clearPlaybackNoteHighlights()
    const graphicalNotes: any[] = cursor?.GNotesUnderCursor?.() ?? []
    for (const graphicalNote of graphicalNotes) {
      const sourceNote = graphicalNote?.sourceNote
      const isRest = typeof sourceNote?.isRest === 'function'
        ? sourceNote.isRest()
        : Boolean(sourceNote?.IsRest ?? sourceNote?.isRest)
      if (isRest) continue

      const noteheads: Element[] = graphicalNote?.getNoteheadSVGs?.() ?? []
      for (const notehead of noteheads) {
        const shapeSelector = 'path, ellipse, circle, polygon, rect'
        const shapes: Element[] = notehead.matches?.(shapeSelector)
          ? [notehead]
          : Array.from(notehead.querySelectorAll?.(shapeSelector) ?? [])
        // OSMD may render guitar fret numbers as SVG text rather than geometric noteheads.
        // Tint those glyphs too, keeping the tablature highlight at the same rhythmic cursor
        // event as the corresponding standard-notation notes.
        const texts: Element[] = notehead.matches?.('text')
          ? [notehead]
          : Array.from(notehead.querySelectorAll?.('text') ?? [])
        const targets = [...new Set<Element>([...shapes, ...texts])]
        if (targets.length === 0) targets.push(notehead)
        for (const target of targets) {
          if (!(target instanceof SVGElement)) continue
          if (!highlightedNoteShapesRef.current.has(target)) {
            highlightedNoteShapesRef.current.set(target, target.getAttribute('style'))
          }
          target.setAttribute('data-score-room-current-note', 'true')
          target.style.setProperty('fill', '#f1d99b', 'important')
          if (target.localName !== 'text' && target.localName !== 'tspan') {
            target.style.setProperty('stroke', '#a87935', 'important')
            target.style.setProperty('stroke-width', '1.35px', 'important')
          }
          target.style.setProperty('filter', 'drop-shadow(0 0 2px rgba(194, 148, 62, 0.48))', 'important')
        }
      }
    }
  }

  /** Prefer note-level highlighting for every notation type so TAB fret digits and
   * standard notation share the exact same OSMD cursor event. Keep the native cursor only
   * as a fallback for renderer builds that expose no SVG notehead/text targets. */
  function updatePlaybackCursorVisual(cursor: any) {
    try { cursor?.hide() } catch { /* optional cursor */ }
    highlightPlaybackNoteheads(cursor)
    if (highlightedNoteShapesRef.current.size === 0) {
      // Reassert the champagne-gold fallback immediately before show(); older CursorOptions
      // may survive a resize/re-render, and the built-in cursor was previously green-tinted.
      if (cursor) {
        try {
          cursor.CursorOptions = {
            ...(cursor.CursorOptions ?? {}),
            type: scoreType === 'piano' ? 2 : 1,
            color: '#d9b779',
            alpha: 0.78,
            follow: false,
          }
        } catch { /* optional cursor palette */ }
      }
      try { cursor?.show() } catch { /* optional cursor */ }
      markCursorNoteAnchor(cursor)
    }
  }

  function registerActiveVoice(source: AudioScheduledSourceNode, gain: GainNode, scheduledStartTime: number) {
    const voice: ActivePlaybackVoice = { source, gain, scheduledStartTime }
    activePlaybackVoicesRef.current.add(voice)
    source.onended = () => {
      activePlaybackVoicesRef.current.delete(voice)
      try { source.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    return voice
  }

  async function loadSalamanderSample(key: SalamanderSampleKey, context: AudioContext): Promise<AudioBuffer> {
    const cached = pianoSampleBuffersRef.current.get(key.midi)
    if (cached) return cached

    const pending = pianoSamplePromisesRef.current.get(key.midi)
    if (pending) return pending

    const request = (async () => {
      const response = await fetch(`${SALAMANDER_SAMPLE_BASE_URL}${key.file}`, {
        mode: 'cors',
        cache: 'force-cache',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${key.file}`)
      const encoded = await response.arrayBuffer()
      const decoded = await context.decodeAudioData(encoded)
      pianoSampleBuffersRef.current.set(key.midi, decoded)
      pianoNearestSampleCacheRef.current.clear()
      return decoded
    })()

    pianoSamplePromisesRef.current.set(key.midi, request)
    try {
      return await request
    } finally {
      if (pianoSamplePromisesRef.current.get(key.midi) === request) {
        pianoSamplePromisesRef.current.delete(key.midi)
      }
    }
  }

  async function ensureSalamanderSamplesLoaded(
    context: AudioContext,
    events: PlaybackTimelineEvent[],
  ): Promise<void> {
    const required = new Map<number, SalamanderSampleKey>()
    for (const event of events) {
      for (const note of event.notes) {
        const key = nearestSalamanderSampleKey(note.midi)
        required.set(key.midi, key)
      }
    }

    const keys = [...required.values()]
    if (keys.every(key => pianoSampleBuffersRef.current.has(key.midi))) {
      setPianoSampleStatus('Salamander Grand Piano 採樣音色已就緒')
      return
    }

    setPianoSampleStatus(`正在載入 Salamander 鋼琴採樣（${keys.length} 個音區，首次播放需要聯網）…`)
    const results = await Promise.allSettled(
      keys.map(key => loadSalamanderSample(key, context)),
    )
    const loadedForScore = keys.filter(key => pianoSampleBuffersRef.current.has(key.midi)).length
    const totalLoaded = pianoSampleBuffersRef.current.size

    if (totalLoaded === 0) {
      setPianoSampleStatus('採樣載入失敗，目前使用備用合成音；請檢查是否能訪問 tonejs.github.io')
      console.warn('[ScoreRoom] Salamander samples unavailable; falling back to oscillator playback.', results)
      return
    }

    if (loadedForScore < keys.length) {
      setPianoSampleStatus(`Salamander 採樣部分可用（本曲 ${loadedForScore}/${keys.length} 個音區已載入，缺失音高使用鄰近採樣）`)
      console.warn('[ScoreRoom] Some Salamander samples could not be loaded; nearest available samples will be used.', results)
    } else {
      setPianoSampleStatus('Salamander Grand Piano V3 採樣音色已就緒')
    }
  }

  async function loadGuitarSoundfontData(instrument: GuitarSoundfontInstrument): Promise<Map<number, string>> {
    const cachedPromise = guitarSampleDataPromisesRef.current.get(instrument)
    if (cachedPromise) return cachedPromise

    const pending = (async () => {
      let lastError: unknown = null
      for (const baseUrl of GUITAR_SOUNDFONT_BASE_URLS) {
        try {
          const response = await fetch(`${baseUrl}${instrument}-mp3.js`, { cache: 'force-cache' })
          if (!response.ok) throw new Error(`吉他音色資料下載失敗（HTTP ${response.status}）`)
          const script = await response.text()
          const samples = new Map<number, string>()
          // Parse the public MIDI.js payload as data, without executing remote JavaScript.
          const expression = /[\"']?([A-G](?:s|b)?-?\d+)[\"']?\s*:\s*[\"'](data:audio\/(?:mp3|ogg);base64,[^\"']+)[\"']/g
          let match: RegExpExecArray | null
          while ((match = expression.exec(script)) !== null) {
            const midi = midiFromSoundfontKey(match[1])
            if (midi !== null && !samples.has(midi)) samples.set(midi, match[2])
          }
          if (samples.size > 0) return samples
          throw new Error('吉他音色資料格式無法識別')
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error('所有吉他音色來源均無法讀取')
    })()
    guitarSampleDataPromisesRef.current.set(instrument, pending)
    try {
      return await pending
    } catch (error) {
      guitarSampleDataPromisesRef.current.delete(instrument)
      throw error
    }
  }

  async function ensureGuitarSamplesLoaded(context: AudioContext, events: PlaybackTimelineEvent[]) {
    const instrument = guitarSoundfontInstrumentForScore(scoreType)
    const existingLoad = guitarSampleLoadPromisesRef.current.get(instrument)
    if (existingLoad) {
      await existingLoad
      return
    }

    const loadTask = (async () => {
      const pitchData = await loadGuitarSoundfontData(instrument)
      const buffers = guitarSampleBuffersRef.current.get(instrument) ?? new Map<number, AudioBuffer>()
      guitarSampleBuffersRef.current.set(instrument, buffers)
      const pitchesInScore = new Set<number>()
      for (const event of events) {
        for (const note of event.notes) {
          if (Number.isFinite(note.midi) && note.midi >= 0 && note.midi <= 127) pitchesInScore.add(Math.round(note.midi))
        }
      }

      // Decode only the nearest samples used by this score, instead of the whole soundfont.
      const samplesNeeded = new Set<number>()
      for (const pitch of pitchesInScore) {
        let bestMidi: number | null = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const sampleMidi of pitchData.keys()) {
          const distance = Math.abs(sampleMidi - pitch)
          if (distance < bestDistance) {
            bestMidi = sampleMidi
            bestDistance = distance
          }
        }
        if (bestMidi !== null) samplesNeeded.add(bestMidi)
      }
      const missing = [...samplesNeeded].filter(midi => !buffers.has(midi))
      if (missing.length === 0 && buffers.size > 0) {
        setGuitarSampleStatus(`鋼弦民謠吉他採樣已就緒`)
        return
      }
      setGuitarSampleStatus(`正在載入鋼弦民謠吉他採樣（${missing.length} 個音高，首次播放需要聯網）…`)
      const results = await Promise.allSettled(missing.map(async midi => {
        const dataUrl = pitchData.get(midi)
        if (!dataUrl) throw new Error(`缺少 MIDI ${midi} 的音色資料`)
        const audioResponse = await fetch(dataUrl)
        if (!audioResponse.ok) throw new Error(`音色樣本 ${midi} 讀取失敗`)
        const bytes = await audioResponse.arrayBuffer()
        const buffer = await context.decodeAudioData(bytes.slice(0))
        buffers.set(midi, buffer)
      }))
      const loadedForScore = [...samplesNeeded].filter(midi => buffers.has(midi)).length
      if (buffers.size === 0) {
        setGuitarSampleStatus('吉他採樣載入失敗，暫時使用備用合成音')
        console.warn('[ScoreRoom] Guitar soundfont samples unavailable; using synthesized fallback.', results)
      } else if (loadedForScore < samplesNeeded.size) {
        setGuitarSampleStatus(`吉他採樣部分可用（${loadedForScore}/${samplesNeeded.size} 個音高），缺失音高使用鄰近採樣`)
        console.warn('[ScoreRoom] Some guitar samples failed to load.', results)
      } else {
        setGuitarSampleStatus(`鋼弦民謠吉他採樣已就緒`)
      }
    })()
    guitarSampleLoadPromisesRef.current.set(instrument, loadTask)
    try {
      await loadTask
    } catch (error) {
      setGuitarSampleStatus('吉他採樣載入失敗，暫時使用備用合成音')
      console.warn('[ScoreRoom] Could not load guitar soundfont; using synthesized fallback.', error)
    } finally {
      guitarSampleLoadPromisesRef.current.delete(instrument)
    }
  }

  function playGuitarSampleTone(
    midi: number,
    scoreDurationSeconds: number,
    scheduledAudioTime: number,
    chordSize: number,
    dynamicLevel = 78,
    articulation?: GuitarLegatoArticulation,
    legatoFromMidi?: number,
    velocityMultiplier = 1,
    releaseAtMeasureBoundary = false,
    strumDirection?: BrushDirection,
  ) {
    const context = audioContextRef.current
    if (!context || context.state === 'closed') return
    const instrument = guitarSoundfontInstrumentForScore(scoreType)
    const buffers = guitarSampleBuffersRef.current.get(instrument)
    if (!buffers || buffers.size === 0) {
      playSyntheticTone(midi, scoreDurationSeconds, scheduledAudioTime, chordSize, Math.max(18, Math.min(120, dynamicLevel * velocityMultiplier)))
      return
    }

    const nearestCache = guitarNearestSampleCacheRef.current.get(instrument) ?? new Map<number, { midi: number; buffer: AudioBuffer }>()
    guitarNearestSampleCacheRef.current.set(instrument, nearestCache)
    let closest = nearestCache.get(midi)
    if (!closest || !buffers.has(closest.midi)) {
      let closestMidi = 0
      let closestBuffer: AudioBuffer | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const [candidateMidi, candidateBuffer] of buffers) {
        const distance = Math.abs(candidateMidi - midi)
        if (distance < closestDistance) {
          closestDistance = distance
          closestMidi = candidateMidi
          closestBuffer = candidateBuffer
        }
      }
      if (!closestBuffer) {
        playSyntheticTone(midi, scoreDurationSeconds, scheduledAudioTime, chordSize, Math.max(18, Math.min(120, dynamicLevel * velocityMultiplier)))
        return
      }
      closest = { midi: closestMidi, buffer: closestBuffer }
      nearestCache.set(midi, closest)
    }

    const startAt = Math.max(context.currentTime + 0.002, scheduledAudioTime)
    const duration = Math.max(releaseAtMeasureBoundary ? 0.045 : 0.12, Math.min(8, scoreDurationSeconds / Math.max(0.1, playbackSpeedRef.current)))
    // Do not loop a decaying pluck or layer a second sound. Repeating the sample's body
    // produced an audible echo/re-attack on long notes. Let the steel-string one-shot decay
    // naturally through the measure, then release any remaining tail at the barline.
    const release = releaseAtMeasureBoundary ? 0.045 : Math.min(0.13, Math.max(0.05, duration * 0.12))
    const legato = articulation === 'hammer-on' || articulation === 'pull-off'
    // Always play the target sample from its attack. Offsetting into the sample on h/p notes
    // caused short target notes to lose most of their energy and sound like a missing note.
    const sourceOffset = 0
    const attack = Math.min(legato ? 0.010 : 0.012, duration * 0.18)
    const peak = (0.32 / Math.max(1, Math.sqrt(chordSize))) * dynamicGainMultiplier(dynamicLevel) * Math.max(0.45, Math.min(1.35, velocityMultiplier)) * (legato ? 0.88 : 1)
    const releaseStart = startAt + duration
    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = closest.buffer
    const targetRate = Math.pow(2, (midi - closest.midi) / 12)
    if (legato && Number.isFinite(legatoFromMidi)) {
      // A short, bounded fret transition gives the h/p target a legato character without
      // making it start from an extreme pitch because the previous-note mapping was ambiguous.
      const semitoneDelta = Math.max(-3, Math.min(3, (legatoFromMidi as number) - midi))
      const fromRate = targetRate * Math.pow(2, semitoneDelta / 12)
      const glideSeconds = Math.min(0.038, Math.max(0.018, duration * 0.10))
      source.playbackRate.setValueAtTime(Math.max(0.05, fromRate), startAt)
      source.playbackRate.exponentialRampToValueAtTime(Math.max(0.05, targetRate), startAt + glideSeconds)
    } else {
      source.playbackRate.setValueAtTime(targetRate, startAt)
    }
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + attack)
    // Preserve the naturally decaying pluck envelope instead of holding it at a constant
    // fraction of peak and then creating an artificial level step at the barline.
    const naturalDecayTarget = Math.max(0.0001, peak * (legato ? 0.12 : 0.065))
    gain.gain.setTargetAtTime(naturalDecayTarget, startAt + attack, Math.max(0.09, Math.min(0.22, duration * 0.14)))
    gain.gain.setValueAtTime(Math.max(0.0001, peak * (legato ? 0.12 : 0.045)), releaseStart)
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseStart + release)

    // The direction receives a gentle but distinct spectral signature in addition to the
    // fast reversed string order: upstrokes are brighter, downstrokes have more body.
    let strumFilter: BiquadFilterNode | null = null
    if (strumDirection) {
      strumFilter = context.createBiquadFilter()
      if (strumDirection === 'up') {
        strumFilter.type = 'highshelf'
        strumFilter.frequency.setValueAtTime(2600, startAt)
        strumFilter.gain.setValueAtTime(1.2, startAt)
      } else {
        strumFilter.type = 'lowshelf'
        strumFilter.frequency.setValueAtTime(220, startAt)
        strumFilter.gain.setValueAtTime(1.4, startAt)
      }
      source.connect(strumFilter)
      strumFilter.connect(gain)
    } else {
      source.connect(gain)
    }
    gain.connect(context.destination)
    registerActiveVoice(source, gain, startAt)
    source.start(startAt, sourceOffset)
    source.stop(releaseStart + release + 0.04)

  }

  function playSyntheticTone(
    midi: number,
    scoreDurationSeconds: number,
    scheduledAudioTime: number,
    chordSize: number,
    dynamicLevel = 78,
  ) {
    const context = audioContextRef.current
    if (!context || context.state === 'closed') return

    const startAt = Math.max(context.currentTime, scheduledAudioTime)
    const duration = Math.max(0.07, Math.min(6, scoreDurationSeconds / playbackSpeedRef.current))
    const stopAt = startAt + duration
    const attack = Math.min(0.025, duration * 0.24)
    const releaseStart = Math.max(startAt + attack, stopAt - Math.min(0.09, duration * 0.35))
    const peak = (0.12 / Math.max(1, Math.sqrt(chordSize))) * dynamicGainMultiplier(dynamicLevel)

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(440 * Math.pow(2, (midi - 69) / 12), startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + attack)
    gain.gain.setValueAtTime(Math.max(0.0001, peak * 0.72), releaseStart)
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
    oscillator.connect(gain)
    gain.connect(context.destination)
    registerActiveVoice(oscillator, gain, startAt)
    oscillator.start(startAt)
    oscillator.stop(stopAt + 0.01)
  }

  function playSalamanderPianoTone(
    midi: number,
    scoreDurationSeconds: number,
    scheduledAudioTime: number,
    chordSize: number,
    dynamicLevel = 78,
    pedalDown = false,
    pedalReleaseAudioTime: number | null = null,
  ) {
    const context = audioContextRef.current
    if (!context || context.state === 'closed') return

    if (pianoSampleBuffersRef.current.size === 0) {
      playSyntheticTone(midi, scoreDurationSeconds, scheduledAudioTime, chordSize, dynamicLevel)
      return
    }

    // Avoid allocating and sorting every sample-map entry for every played note.
    // This is particularly important for fast passages, chords and 16th subdivisions.
    let closest = pianoNearestSampleCacheRef.current.get(midi)
    if (!closest || !pianoSampleBuffersRef.current.has(closest.midi)) {
      let closestMidi = 0
      let closestBuffer: AudioBuffer | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const [candidateMidi, candidateBuffer] of pianoSampleBuffersRef.current) {
        const distance = Math.abs(candidateMidi - midi)
        if (distance < closestDistance) {
          closestDistance = distance
          closestMidi = candidateMidi
          closestBuffer = candidateBuffer
        }
      }
      if (!closestBuffer) {
        playSyntheticTone(midi, scoreDurationSeconds, scheduledAudioTime, chordSize, dynamicLevel)
        return
      }
      closest = { midi: closestMidi, buffer: closestBuffer }
      pianoNearestSampleCacheRef.current.set(midi, closest)
    }
    const sampleMidi = closest.midi
    const buffer = closest.buffer
    const startAt = Math.max(context.currentTime, scheduledAudioTime)
    const duration = Math.max(0.07, Math.min(6, scoreDurationSeconds / playbackSpeedRef.current))
    const release = Math.min(0.18, Math.max(0.055, duration * 0.16))
    const keyReleaseAt = startAt + duration
    const releaseAt = pedalDown && pedalReleaseAudioTime !== null && pedalReleaseAudioTime > keyReleaseAt
      ? pedalReleaseAudioTime
      : keyReleaseAt
    const attack = Math.min(0.012, Math.max(0.004, duration * 0.16))
    const peak = (0.38 / Math.max(1, Math.sqrt(chordSize))) * dynamicGainMultiplier(dynamicLevel)

    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = buffer
    source.playbackRate.setValueAtTime(Math.pow(2, (midi - sampleMidi) / 12), startAt)
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + attack)
    gain.gain.setValueAtTime(peak, releaseAt)
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + release)
    source.connect(gain)
    gain.connect(context.destination)
    registerActiveVoice(source, gain, startAt)
    source.start(startAt)
    source.stop(releaseAt + release + 0.035)
  }

  // A wider look-ahead helps prevent dropped notes when the large theory panel
  // briefly occupies the main thread. Seek/pause cancels these queued voices.
  const playbackAudioLookaheadSeconds = 0.28

  function findNextMetronomeBeatIndex(scoreTime: number): number {
    const beats = metronomeBeatGridRef.current
    const index = beats.findIndex(beat => beat.time >= scoreTime - 0.008)
    return index < 0 ? beats.length : index
  }

  /** Queue metronome clicks ahead of time on AudioContext's clock, not at their deadline. */
  function scheduleMetronomeAhead(context: AudioContext, scoreTime: number) {
    if (!metronomeEnabledRef.current || context.state === 'closed') return
    const beatGrid = metronomeBeatGridRef.current
    const speed = Math.max(0.1, playbackSpeedRef.current)
    const horizon = scoreTime + playbackAudioLookaheadSeconds * speed
    const loopEnd = abLoopEnabledRef.current ? loopBRef.current : null
    let beatsHandled = 0
    while (metronomeNextBeatIndexRef.current < beatGrid.length &&
      beatGrid[metronomeNextBeatIndexRef.current].time <= horizon && beatsHandled < 32) {
      const beat = beatGrid[metronomeNextBeatIndexRef.current]
      // Do not consume beats at/after B. The loop handler will rewind the index at B.
      if (loopEnd !== null && beat.time >= loopEnd - 0.003) break
      metronomeNextBeatIndexRef.current += 1
      beatsHandled += 1
      if (beat.time < playbackStartScoreTimeRef.current - 0.015) continue
      if (beat.time > playbackDurationRef.current - 0.02) continue
      const audioTime = playbackOriginRef.current + beat.time / speed
      // If the main thread was blocked for a long time, drop stale clicks rather than
      // firing a pile of old beats at the same currentTime on the next frame.
      if (audioTime < context.currentTime - 0.045) continue
      scheduleMetronomeClick(context, audioTime, beat.accent, beat.subdivision ?? false, beat.secondaryAccent ?? false)
    }
  }

  /** Queue score sounds up to 280 ms ahead, with visual highlighting left to the RAF clock. */
  function schedulePlaybackAudioAhead(context: AudioContext, scoreTime: number) {
    if (context.state === 'closed') return
    const events = playbackEventsRef.current
    const speed = Math.max(0.1, playbackSpeedRef.current)
    const horizon = scoreTime + playbackAudioLookaheadSeconds * speed
    const loopEnd = abLoopEnabledRef.current ? loopBRef.current : null
    let handled = 0
    while (playbackAudioNextEventIndexRef.current < events.length && handled < 256) {
      const event = events[playbackAudioNextEventIndexRef.current]
      if (event.time > horizon) break
      // Do not queue sounds beyond B. Those nodes would otherwise have to be cancelled
      // at loop time and could leak across a very short A/B boundary.
      if (loopEnd !== null && event.time >= loopEnd - 0.003) break

      const scheduledAudioTime = playbackOriginRef.current + event.time / speed
      // If rendering was suspended for longer than the scheduling buffer, stale notes
      // are discarded instead of being fired in a burst. Normal frame jitter remains
      // covered by the 280 ms look-ahead buffer.
      if (scheduledAudioTime >= context.currentTime - 0.045) {
        // Guitar scores deliberately use a fixed playback level. Piano keeps its
        // existing notation-dynamics behavior and is not affected by this rule.
        const isGuitarPlayback = scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle'
        const dynamicLevel = isGuitarPlayback
          ? 78
          : scoreDynamicsEnabledRef.current ? event.dynamicLevel : 78
        const eventUsesPedal = scoreType === 'piano' && scorePedalEnabledRef.current && event.pedalDown
        const pedalReleaseAudioTime = eventUsesPedal && event.pedalReleaseTime !== null
          ? playbackOriginRef.current + event.pedalReleaseTime / speed
          : null
        const principalChordSize = Math.max(1, event.notes.filter(tone =>
          tone.isMainPlaybackEntry !== false && !tone.isGrace,
        ).length)
        for (const tone of event.notes) {
          if (tone.suppressPlayback) continue
          const toneAudioTime = scheduledAudioTime + (Number(tone.startOffsetSeconds ?? 0) / speed)
          if (scoreType === 'piano') {
            playSalamanderPianoTone(
              tone.midi,
              tone.durationSeconds,
              toneAudioTime,
              principalChordSize,
              dynamicLevel,
              eventUsesPedal,
              pedalReleaseAudioTime,
            )
          } else if (scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle') {
            // Do not hold every plucked guitar note until the barline: that turns short
            // notes into overlapping low-level drones and makes fast passages sound muddy.
            // Use the MusicXML/timeline note duration, clamped only at A/B and score ends.
            const toneStartScoreTime = event.time + Number(tone.startOffsetSeconds ?? 0)
            const loopBoundary = loopEnd !== null && loopEnd > toneStartScoreTime ? loopEnd : Number.POSITIVE_INFINITY
            const scoreBoundary = playbackDurationRef.current > 0
              ? playbackDurationRef.current
              : Number.POSITIVE_INFINITY
            const notatedDuration = Number.isFinite(tone.durationSeconds)
              ? Math.max(0.075, tone.durationSeconds)
              : 0.12
            const remainingBoundary = Math.min(loopBoundary, scoreBoundary) - toneStartScoreTime
            const guitarDuration = Number.isFinite(remainingBoundary)
              ? Math.max(0.045, Math.min(notatedDuration, remainingBoundary))
              : notatedDuration
            playGuitarSampleTone(
              tone.midi,
              guitarDuration,
              toneAudioTime,
              principalChordSize,
              dynamicLevel,
              tone.guitarArticulation,
              tone.guitarLegatoFromMidi,
              1, // Fixed guitar velocity: ignore per-note dynamic/velocity variations.
              false,
              tone.guitarStrumDirection,
            )
          } else {
            playSyntheticTone(tone.midi, tone.durationSeconds, toneAudioTime, principalChordSize, dynamicLevel)
          }
        }
      }
      playbackAudioNextEventIndexRef.current += 1
      handled += 1
    }
  }

  function playbackTick(epoch = playbackEpochRef.current) {
    // cancelAnimationFrame cannot invalidate a callback that is already queued for
    // dispatch. The epoch check prevents an old playback loop from joining a newer one.
    if (epoch !== playbackEpochRef.current) return
    const context = audioContextRef.current
    if (!playbackRunningRef.current || !context) return

    // Count-in clicks are scheduled ahead of the score. Keep the timeline parked at
    // the requested start until its exact AudioContext start time; never dispatch the
    // first score notes during the pre-roll.
    const musicStartAudioTime = playbackOriginRef.current + playbackStartScoreTimeRef.current / playbackSpeedRef.current
    if (context.currentTime < musicStartAudioTime - 0.003) {
      if (!isCountingInRef.current && countInBarsRef.current > 0) {
        isCountingInRef.current = true
        setIsCountingIn(true)
      }
      playbackFrameRef.current = window.requestAnimationFrame(() => playbackTick(epoch))
      return
    }
    if (isCountingInRef.current) {
      isCountingInRef.current = false
      setIsCountingIn(false)
    }

    const scoreTime = Math.max(
      playbackStartScoreTimeRef.current,
      (context.currentTime - playbackOriginRef.current) * playbackSpeedRef.current,
      0,
    )

    // Audio is scheduled in a look-ahead window using the stable AudioContext clock.
    // The RAF below is only responsible for visual highlighting and UI updates.
    scheduleMetronomeAhead(context, scoreTime)

    // A/B loop boundaries are score-time values, independent of playback speed.
    // Jump back to A before dispatching events at or beyond B so notes don't leak
    // past the loop boundary. Active synth voices are stopped to prevent overlap.
    const loopAValue = loopARef.current
    const loopBValue = loopBRef.current
    if (abLoopEnabledRef.current && loopAValue !== null && loopBValue !== null &&
        loopBValue > loopAValue && scoreTime >= loopBValue) {
      const events = playbackEventsRef.current
      const loopStartEvent = events.findIndex(event => event.time >= loopAValue - 0.001)
      if (loopStartEvent >= 0) {
        // Count one complete A-to-B pass. After N passes at the same tempo, increase
        // the playback speed by the configured step, clamped to the target speed.
        const trainer = tempoTrainerRef.current
        if (trainer.enabled) {
          trainer.totalLoops += 1
          trainer.loopsAtCurrentSpeed += 1
          if (trainer.loopsAtCurrentSpeed >= Math.max(1, trainer.repeatsPerStep)) {
            trainer.loopsAtCurrentSpeed = 0
            const currentSpeed = playbackSpeedRef.current
            if (currentSpeed + 0.0005 < trainer.targetSpeed) {
              const nextSpeed = Math.min(trainer.targetSpeed, Number((currentSpeed + trainer.step).toFixed(3)))
              if (nextSpeed > currentSpeed + 0.0005) {
                playbackSpeedRef.current = nextSpeed
                setPlaybackSpeed(nextSpeed)
                setTempoTrainerStatus(`已完成 ${trainer.totalLoops} 輪，自動提速至 ${nextSpeed.toFixed(2)}×`)
              }
            } else {
              setTempoTrainerStatus(`已達到目標速度 ${trainer.targetSpeed.toFixed(2)}×，繼續循環鞏固`)
            }
          }
          setTempoTrainerLoopCount(trainer.loopsAtCurrentSpeed)
        }

        stopActivePlaybackNotes()
        clearPlaybackNoteHighlights()
        playbackNextEventIndexRef.current = loopStartEvent
        playbackAudioNextEventIndexRef.current = loopStartEvent
        playbackCursorIndexRef.current = 0
        playbackTimeRef.current = loopAValue
        playbackStartScoreTimeRef.current = loopAValue
        // Re-anchor using the possibly updated speed so A stays at the exact current
        // audio time. This prevents a phase jump when the practice tempo increases.
        const loopGracePreRoll = getEventPreRollSeconds(events[loopStartEvent])
        playbackOriginRef.current = context.currentTime + loopGracePreRoll / playbackSpeedRef.current - loopAValue / playbackSpeedRef.current
        metronomeNextBeatIndexRef.current = findNextMetronomeBeatIndex(loopAValue)
        schedulePlaybackAudioAhead(context, loopAValue)
        scheduleMetronomeAhead(context, loopAValue)
        setPlaybackSeconds(loopAValue)
        playbackUiLastUpdateMsRef.current = performance.now()
        const loopCursor = (osmdRef.current as any)?.cursor
        try {
          loopCursor?.reset()
          loopCursor?.hide()
        } catch (cursorError) {
          console.warn('[ScoreRoom] Cursor reset failed at A/B loop boundary:', cursorError)
        }
        playbackFrameRef.current = window.requestAnimationFrame(() => playbackTick(epoch))
        return
      }
    }

    playbackTimeRef.current = scoreTime

    const events = playbackEventsRef.current
    // Queue upcoming note starts on the audio clock, independent of React rendering.
    schedulePlaybackAudioAhead(context, scoreTime)

    // Advance the graphical cursor only to the event that should be visible now.
    // When several notes pass between frames, update the SVG highlight once at the
    // latest due event instead of touching the DOM for every missed visual frame.
    let latestVisualEventIndex = -1
    let visualHandled = 0
    while (
      playbackNextEventIndexRef.current < events.length &&
      events[playbackNextEventIndexRef.current].time <= scoreTime + 0.006 &&
      visualHandled < 256
    ) {
      latestVisualEventIndex = playbackNextEventIndexRef.current
      playbackNextEventIndexRef.current += 1
      visualHandled += 1
    }

    if (latestVisualEventIndex >= 0) {
      const visibleMeasureIndex = events[latestVisualEventIndex]?.measureIndex
      if (Number.isInteger(visibleMeasureIndex) &&
          visibleMeasureIndex !== lastTheoryPlaybackMeasureRef.current) {
        lastTheoryPlaybackMeasureRef.current = visibleMeasureIndex
        setSelectedTheoryMeasureIndex(visibleMeasureIndex)
      }
      const osmd = osmdRef.current as any
      const cursor = osmd?.cursor
      if (cursor) {
        try {
          while (playbackCursorIndexRef.current < latestVisualEventIndex) {
            cursor.next()
            playbackCursorIndexRef.current += 1
          }
          updatePlaybackCursorVisual(cursor)
        } catch (cursorError) {
          console.warn('[ScoreRoom] Playback cursor update failed; continuing audio:', cursorError)
          try { cursor.hide() } catch { /* cursor is optional for audio */ }
          playbackCursorIndexRef.current = latestVisualEventIndex
        }
      }
      followPlaybackPositionIfNeeded()
    }

    // The audio clock continues at full precision; update React's progress UI at ~12.5 Hz
    // rather than forcing the entire large reader tree to render on every animation frame.
    const uiNow = performance.now()
    if (uiNow - playbackUiLastUpdateMsRef.current >= 80 || scoreTime >= playbackDurationRef.current) {
      setPlaybackSeconds(Math.min(scoreTime, playbackDurationRef.current))
      playbackUiLastUpdateMsRef.current = uiNow
    }

    if (
      scoreTime >= playbackDurationRef.current ||
      (playbackNextEventIndexRef.current >= events.length && events.length > 0 &&
        scoreTime >= events[events.length - 1].time + 0.12)
    ) {
      playbackEpochRef.current += 1
      playbackRunningRef.current = false
      cancelPlaybackFrame()
      isCountingInRef.current = false
      setIsCountingIn(false)
      stopActiveMetronomeClicks()
      setIsPlaying(false)
      setPlaybackSeconds(playbackDurationRef.current)
      playbackTimeRef.current = playbackDurationRef.current
      return
    }

    playbackFrameRef.current = window.requestAnimationFrame(() => playbackTick(epoch))
  }

  function scrollWindowProgrammatically(top: number, behavior: ScrollBehavior = 'auto', left?: number) {
    programmaticScrollRef.current = true
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current)
    }
    window.scrollTo({ left: left ?? window.scrollX, top: Math.max(0, top), behavior })
    // Smooth scrolls normally finish well before this timeout. scrollend releases the
    // guard earlier where supported; the timeout also handles browsers without it.
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false
      programmaticScrollTimerRef.current = null
    }, behavior === 'smooth' ? 1800 : 220)
  }

  function disableAutoFollowFromManualScroll() {
    if (!autoFollowPlaybackRef.current) return
    autoFollowPlaybackRef.current = false
    autoFollowPlaybackPreferenceRef.current = false
    setAutoFollowPlayback(false)
    lastAutoFollowRowKeyRef.current = null
  }

  function scrollToCurrentPlaybackPosition(
    behavior: ScrollBehavior = 'smooth',
    sourceMeasureIndex?: number,
  ) {
    const container = containerRef.current
    if (!container) return
    const current = container.querySelector<SVGElement>('[data-score-room-current-note="true"]')
    if (current) {
      const rect = current.getBoundingClientRect()
      const targetTop = window.scrollY + rect.top - window.innerHeight * 0.42
      scrollWindowProgrammatically(targetTop, behavior)
      return
    }

    // If the current timeline event is a rest and therefore has no notehead anchor,
    // follow the logical score row whose start measure is closest to this source measure.
    if (Number.isInteger(sourceMeasureIndex) && (sourceMeasureIndex as number) >= 0) {
      const hitAreas = Array.from(container.querySelectorAll<HTMLElement>('[data-score-room-line-hitbox="true"]'))
      const starts = hitAreas.map(area => ({
        area,
        start: Number(area.dataset.lineStartMeasureIndex),
      })).filter(item => Number.isInteger(item.start) && item.start >= 0)
        .sort((a, b) => a.start - b.start)
      let rowArea: HTMLElement | null = null
      for (const item of starts) {
        if (item.start <= (sourceMeasureIndex as number)) rowArea = item.area
        else break
      }
      if (rowArea) {
        const rect = rowArea.getBoundingClientRect()
        const targetTop = window.scrollY + rect.top - window.innerHeight * 0.34
        scrollWindowProgrammatically(targetTop, behavior)
        return
      }
    }

    // Before the first note highlight is drawn, at least take the reader to the score.
    const rect = container.getBoundingClientRect()
    scrollWindowProgrammatically(window.scrollY + rect.top - 100, behavior)
  }

  type PlaybackRowAnchor = { key: string; top: number; bottom: number; rowNumber: number; startIndex: number }

  function getPlaybackRowAnchor(sourceMeasureIndex?: number): PlaybackRowAnchor | null {
    const container = containerRef.current
    if (!container) return null

    const areas = Array.from(container.querySelectorAll<HTMLElement>('[data-score-room-line-hitbox="true"]'))
      .map((area) => {
        const rect = area.getBoundingClientRect()
        return {
          key: `hitbox:${area.dataset.lineNumber ?? ''}:${area.dataset.lineStartMeasureIndex ?? ''}`,
          top: rect.top,
          bottom: rect.bottom,
          rowNumber: Number(area.dataset.lineNumber || 1),
          startIndex: Number(area.dataset.lineStartMeasureIndex),
        }
      })
      .filter(row => Number.isInteger(row.startIndex) && row.startIndex >= 0 &&
        Number.isFinite(row.top) && Number.isFinite(row.bottom) && row.bottom > row.top)
      .sort((a, b) => a.startIndex - b.startIndex || a.top - b.top)

    if (areas.length > 0) {
      const target = Number.isInteger(sourceMeasureIndex) && (sourceMeasureIndex as number) >= 0
        ? (areas.filter(row => row.startIndex <= (sourceMeasureIndex as number)).pop() ?? areas[0])
        : areas[0]
      return target
    }

    // Fallback to live staff-line geometry if the invisible HTML hit areas were not
    // created for a particular OSMD build or score layout.
    const fallbackRows = getStaffLineFallbackRows(container, osmdRef.current as any)
      .map(row => ({
        key: `staff:${row.rowNumber}:${row.startIndex}`,
        top: row.top - 18,
        bottom: row.bottom + 18,
        rowNumber: row.rowNumber,
        startIndex: row.startIndex,
      }))
      .sort((a, b) => a.startIndex - b.startIndex || a.top - b.top)
    if (!fallbackRows.length) return null
    return Number.isInteger(sourceMeasureIndex) && (sourceMeasureIndex as number) >= 0
      ? (fallbackRows.filter(row => row.startIndex <= (sourceMeasureIndex as number)).pop() ?? fallbackRows[0])
      : fallbackRows[0]
  }

  function scrollToPlaybackRow(sourceMeasureIndex?: number, behavior: ScrollBehavior = 'auto'): string | null {
    const row = getPlaybackRowAnchor(sourceMeasureIndex)
    if (!row) return null
    const targetTop = window.scrollY + row.top - window.innerHeight * 0.27
    scrollWindowProgrammatically(targetTop, behavior)
    return row.key
  }

  function toggleAutoFollowPlayback() {
    const next = !autoFollowPlaybackRef.current
    autoFollowPlaybackRef.current = next
    autoFollowPlaybackPreferenceRef.current = next
    setAutoFollowPlayback(next)
    lastAutoFollowRowKeyRef.current = null
    if (next) {
      const events = playbackEventsRef.current
      const eventIndex = Math.max(0, Math.min(events.length - 1, playbackNextEventIndexRef.current - 1))
      const measureIndex = events[eventIndex]?.measureIndex
      window.requestAnimationFrame(() => {
        lastAutoFollowRowKeyRef.current = scrollToPlaybackRow(measureIndex, 'smooth')
      })
    }
  }

  function followPlaybackPositionIfNeeded() {
    if (!autoFollowPlaybackRef.current || !playbackRunningRef.current) return
    const events = playbackEventsRef.current
    const eventIndex = Math.max(0, Math.min(events.length - 1, playbackNextEventIndexRef.current - 1))
    const measureIndex = events[eventIndex]?.measureIndex
    const row = getPlaybackRowAnchor(measureIndex)
    if (!row) return

    // Follow the logical score row, not the individual notehead. A seek used to start
    // a note-centered smooth scroll, then this loop saw that same row momentarily
    // outside the viewport and immediately issued a second scroll. That race made the
    // page jump back and forth on ±5 s seeks. Only move when the logical row changes.
    // Intentional user scrolling disables auto-follow through the existing scroll handlers.
    if (row.key === lastAutoFollowRowKeyRef.current) return
    lastAutoFollowRowKeyRef.current = row.key
    scrollToPlaybackRow(measureIndex, 'auto')
  }

  /** Move OSMD's cursor/highlight to a timeline event without scrolling to the
   * individual notehead. Row-level scrolling is performed once by seekPlaybackToSeconds. */
  function positionCursorAtTimelineEvent(eventIndex: number) {
    const osmd = osmdRef.current as any
    const cursor = osmd?.cursor
    if (!cursor) return
    try {
      cursor.reset()
      playbackCursorIndexRef.current = 0
      while (playbackCursorIndexRef.current < eventIndex) {
        cursor.next()
        playbackCursorIndexRef.current += 1
      }
      updatePlaybackCursorVisual(cursor)
    } catch (cursorError) {
      console.warn('[ScoreRoom] Could not position cursor after seeking:', cursorError)
    }
  }

  function seekToMeasure(measureIndex: number) {
    const events = playbackEventsRef.current
    if (!events.length) return false
    const safeMeasureIndex = Math.max(0, Math.floor(measureIndex))
    // Prefer an event exactly in this source measure. Empty/collapsed measures can
    // have no playback event, so advance to the next source measure if needed.
    let eventIndex = events.findIndex(event => event.measureIndex === safeMeasureIndex)
    if (eventIndex < 0) {
      eventIndex = events.findIndex(event => event.measureIndex > safeMeasureIndex)
    }
    if (eventIndex < 0) {
      setPlaybackError(`沒有找到第 ${safeMeasureIndex + 1} 小節的播放位置。請檢查這份譜子的播放時間軸。`)
      console.warn('[ScoreRoom] No playback timeline event for clicked source measure:', safeMeasureIndex,
        'available measure indexes:', Array.from(new Set(events.map(event => event.measureIndex))).slice(0, 12))
      return false
    }

    playbackEpochRef.current += 1
    playbackRunningRef.current = false
    cancelPlaybackFrame()
    stopActivePlaybackNotes()
    clearPlaybackNoteHighlights()
    playbackNextEventIndexRef.current = eventIndex
    playbackAudioNextEventIndexRef.current = eventIndex
    playbackCursorIndexRef.current = 0
    playbackTimeRef.current = events[eventIndex].time
    setPlaybackSeconds(events[eventIndex].time)
    setIsPlaying(false)

    const cursor = (osmdRef.current as any)?.cursor
    if (cursor) {
      cursor.reset()
      cursor.hide()
    }
    return true
  }

  function displayMeasureNumber(sourceIndex: number): string {
    const osmd = osmdRef.current as any
    const sourceMeasures: any[] = osmd?.Sheet?.SourceMeasures ?? osmd?.sheet?.SourceMeasures ?? []
    const measure = sourceMeasures[sourceIndex]
    const number = measure?.MeasureNumberPrinted ?? measure?.MeasureNumberXML ?? measure?.MeasureNumber
    return number !== undefined && number !== null && String(number).trim() !== ''
      ? String(number)
      : String(sourceIndex + 1)
  }

  function playFromMeasure(sourceIndex: number, triggerDescription?: string) {
    const events = playbackEventsRef.current
    let eventIndex = events.findIndex(item => item.measureIndex === sourceIndex)
    if (eventIndex < 0) eventIndex = events.findIndex(item => item.measureIndex > sourceIndex)
    const label = displayMeasureNumber(sourceIndex)
    if (eventIndex < 0) {
      setPlaybackError(`沒有找到第 ${label} 小節的播放位置。請檢查這份譜子的播放時間軸。`)
      return
    }

    const startTime = events[eventIndex].time
    const actualTimelineSourceIndex = events[eventIndex].measureIndex
    const actualTimelineLabel = displayMeasureNumber(actualTimelineSourceIndex)
    const description = triggerDescription ?? `點擊第 ${label} 小節`
    console.info('[ScoreRoom] Click-to-play mapping:', {
      clickedSourceIndex: sourceIndex,
      clickedPrintedNumber: label,
      triggerDescription: description,
      timelineEventIndex: eventIndex,
      timelineSourceIndex: actualTimelineSourceIndex,
      timelinePrintedNumber: actualTimelineLabel,
      startTimeSeconds: startTime,
    })
    const loopStart = loopARef.current
    const loopEnd = loopBRef.current
    if (abLoopEnabledRef.current && loopStart !== null && loopEnd !== null &&
        (startTime < loopStart - 0.01 || startTime >= loopEnd - 0.01)) {
      setABLoopEnabled(false)
    }
    setPlaybackError('')
    // All score-row jumps now use the same atomic seek path as playback scrubbing.
    // It cancels stale note/metronome nodes, resets both event queues, positions the
    // cursor once, and starts the new row with any configured count-in.
    seekPlaybackToSeconds(startTime, true, false, eventIndex, true)
    setSelectedTheoryMeasureIndex(actualTimelineSourceIndex)
    setMeasureSeekStatus(`${description} → 播放軸第 ${actualTimelineLabel} 小節 · ${formatPlaybackTime(startTime)}`)
  }

  /** Select a theory measure and keep audio, cursor, highlight and row scrolling in sync.
   * If playback was active, continue from the selected measure; if paused, only locate it. */
  function selectTheoryMeasureAndSeek(
    sourceIndex: number,
    printedNumber = displayMeasureNumber(sourceIndex),
    triggerLabel = '樂理分析',
  ) {
    const events = playbackEventsRef.current
    let eventIndex = events.findIndex(item => item.measureIndex === sourceIndex)
    let usedNextMeasureFallback = false
    if (eventIndex < 0) {
      eventIndex = events.findIndex(item => item.measureIndex > sourceIndex)
      usedNextMeasureFallback = eventIndex >= 0
    }

    setShowTheoryPanel(true)
    setPlaybackError('')
    if (eventIndex < 0) {
      setSelectedTheoryMeasureIndex(sourceIndex)
      const rowKey = scrollToPlaybackRow(sourceIndex, 'smooth')
      setMeasureSeekStatus(`已選取第 ${printedNumber} 小節，但該小節及其後續沒有可播放事件。${rowKey ? '' : '譜面行也未能定位。'}`)
      return
    }

    const event = events[eventIndex]
    const targetMeasureIndex = event.measureIndex
    const shouldResume = playbackRunningRef.current || playbackStartInProgressRef.current || isCountingInRef.current
    // A target outside the active A/B range would otherwise jump to the old loop on the
    // next frame, looking like a failed seek. Disable that stale range for this explicit
    // navigation; targets inside the range preserve the loop.
    const loopStart = loopARef.current
    const loopEnd = loopBRef.current
    if (abLoopEnabledRef.current && loopStart !== null && loopEnd !== null &&
        (event.time < loopStart - 0.01 || event.time >= loopEnd - 0.01)) {
      setABLoopEnabled(false)
    }

    seekPlaybackToSeconds(event.time, shouldResume, true, eventIndex, false)
    setSelectedTheoryMeasureIndex(targetMeasureIndex)
    lastTheoryPlaybackMeasureRef.current = targetMeasureIndex
    const fallbackNote = usedNextMeasureFallback
      ? `（第 ${printedNumber} 小節無直接事件，定位到後續第 ${displayMeasureNumber(targetMeasureIndex)} 小節）`
      : ''
    setMeasureSeekStatus(`${triggerLabel}：已定位第 ${displayMeasureNumber(targetMeasureIndex)} 小節 ${formatPlaybackTime(event.time)}${fallbackNote}${shouldResume ? '，繼續播放。' : '，保持暫停。'}`)
    console.info('[ScoreRoom] Theory measure navigation:', {
      requestedSourceIndex: sourceIndex,
      requestedPrintedNumber: printedNumber,
      resolvedSourceIndex: targetMeasureIndex,
      resolvedPrintedNumber: displayMeasureNumber(targetMeasureIndex),
      timelineEventIndex: eventIndex,
      timeSeconds: event.time,
      resumedPlayback: shouldResume,
    })
  }

  function locateTheoryChord(sourceIndex: number, onsetQuarter: number, symbol: string) {
    const events = playbackEventsRef.current
    const measureEvents = events.filter(event => event.measureIndex === sourceIndex)
    let targetEvent = measureEvents.find(event => event.positionQuarter >= onsetQuarter - 0.005)
    let fallback = false
    if (!targetEvent) {
      targetEvent = events.find(event => event.measureIndex > sourceIndex)
      fallback = Boolean(targetEvent)
    }
    if (!targetEvent) {
      setPlaybackError(`沒有找到第 ${displayMeasureNumber(sourceIndex)} 小節中和弦 ${symbol} 的播放位置。`)
      return
    }
    setSelectedTheoryMeasureIndex(sourceIndex)
    setShowTheoryPanel(true)
    const shouldResume = playbackRunningRef.current || playbackStartInProgressRef.current || isCountingInRef.current
    const loopStart = loopARef.current
    const loopEnd = loopBRef.current
    if (abLoopEnabledRef.current && loopStart !== null && loopEnd !== null &&
        (targetEvent.time < loopStart - 0.01 || targetEvent.time >= loopEnd - 0.01)) {
      setABLoopEnabled(false)
    }
    // Locate only: preserve a paused state and resume only if playback was already active.
    // Supply the exact event index so equal-time notes cannot resolve to a preceding event.
    seekPlaybackToSeconds(targetEvent.time, shouldResume, true, events.indexOf(targetEvent), false)
    setMeasureSeekStatus(`已定位到第 ${displayMeasureNumber(sourceIndex)} 小節的 ${symbol}${fallback ? '（使用後續可播放事件作為近似位置）' : ''}。${shouldResume ? '繼續播放。' : '保持暫停。'}`)
  }

  function clearScoreMeasureHover() {
    const current = hoveredScoreMeasureRef.current
    if (current?.overlay.isConnected) current.overlay.remove()
    hoveredScoreMeasureRef.current = null
  }

  /** Hover only adds a temporary translucent box to the existing SVG measure group.
   * It never changes score data, playback events, guitar techniques or the note cursor. */
  function handleScoreMeasureHover(event: React.MouseEvent<HTMLDivElement>) {
    if (scoreType === 'piano') return
    const target = event.target instanceof Element ? event.target : null
    const measureGroup = target?.closest('g.vf-measure') as SVGGElement | null
    if (!measureGroup) {
      clearScoreMeasureHover()
      return
    }
    if (hoveredScoreMeasureRef.current?.group === measureGroup) return
    clearScoreMeasureHover()

    let bounds: DOMRect | SVGRect
    try { bounds = measureGroup.getBBox() } catch { return }
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width < 1 || bounds.height < 1) return

    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    overlay.setAttribute('x', String(bounds.x))
    overlay.setAttribute('y', String(bounds.y))
    overlay.setAttribute('width', String(bounds.width))
    overlay.setAttribute('height', String(bounds.height))
    overlay.setAttribute('rx', '2')
    overlay.setAttribute('fill', '#d9b779')
    overlay.setAttribute('fill-opacity', '0.18')
    overlay.setAttribute('stroke', '#b8954a')
    overlay.setAttribute('stroke-opacity', '0.62')
    overlay.setAttribute('stroke-width', '1.1')
    overlay.setAttribute('pointer-events', 'none')
    overlay.setAttribute('aria-hidden', 'true')
    overlay.setAttribute('data-score-room-hover-measure-highlight', 'true')
    measureGroup.insertBefore(overlay, measureGroup.firstChild)
    hoveredScoreMeasureRef.current = { group: measureGroup, overlay }
  }

  function handleScoreClick(event: React.MouseEvent<HTMLDivElement>) {
    const container = containerRef.current
    if (!container) return

    // Enabling smart annotations asks OSMD to re-engrave the score with taller system
    // gaps. Resolve pointer clicks against the *current staff DOM geometry* first,
    // instead of depending on a previously installed transparent overlay's listener.
    // This path is deliberately active only in annotation mode to preserve the mature
    // hitbox mapping for ordinary score reading.
    if (scoreAnnotationsEnabled) {
      const liveRows = getStaffLineFallbackRows(container, osmdRef.current as any)
      const clickY = event.clientY
      const nearest = liveRows.map(row => {
        const top = row.top - 28
        const bottom = row.bottom + 18
        const distance = clickY < top ? top - clickY : clickY > bottom ? clickY - bottom : 0
        return { row, distance }
      }).sort((a, b) => a.distance - b.distance)[0]
      if (nearest && nearest.distance <= 48) {
        const startLabel = displayMeasureNumber(nearest.row.startIndex)
        playFromMeasure(
          nearest.row.startIndex,
          `點擊第 ${nearest.row.rowNumber} 行（從第 ${startLabel} 小節開始，智能標註模式）`,
        )
        return
      }
    }

    const hitAreas = Array.from(container.querySelectorAll<HTMLElement>('[data-score-room-line-hitbox="true"]'))
    if (!hitAreas.length) {
      // Last-resort live hit testing: use the system/staff-line geometry on the actual
      // click Y coordinate. This keeps the score usable even if an HTML overlay could
      // not be installed by the current OSMD/VexFlow DOM build.
      const fallbackRows = getStaffLineFallbackRows(container, osmdRef.current as any)
      const clickY = event.clientY
      const candidates = fallbackRows.map(row => {
        const top = row.top - 28
        const bottom = row.bottom + 18
        const distance = clickY < top ? top - clickY : clickY > bottom ? clickY - bottom : 0
        return { row, distance }
      }).sort((a, b) => a.distance - b.distance)
      const bestFallback = candidates[0]
      if (bestFallback && bestFallback.distance <= 42) {
        const startLabel = displayMeasureNumber(bestFallback.row.startIndex)
        playFromMeasure(
          bestFallback.row.startIndex,
          `點擊第 ${bestFallback.row.rowNumber} 行（從第 ${startLabel} 小節開始）`,
        )
        return
      }
      setPlaybackError('未能識別目前點擊對應的譜面行。請點在五線譜橫行內，或使用播放欄播放。')
      return
    }

    // Fallback for a narrow gap between row overlays. Horizontal position is ignored:
    // whichever score row is vertically closest determines the row start.
    const y = event.clientY
    const candidates = hitAreas.map(area => {
      const rect = area.getBoundingClientRect()
      const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
      return {
        area,
        distance,
        rowNumber: Number(area.dataset.lineNumber || 1),
        startIndex: Number(area.dataset.lineStartMeasureIndex),
      }
    }).filter(item => Number.isInteger(item.startIndex) && item.startIndex >= 0)
      .sort((a, b) => a.distance - b.distance)

    const best = candidates[0]
    if (!best || best.distance > 28) {
      setPlaybackError('沒有識別到對應的譜面行。請點擊五線譜所在的橫行，或使用播放欄播放。')
      return
    }
    const startLabel = displayMeasureNumber(best.startIndex)
    playFromMeasure(best.startIndex, `點擊第 ${best.rowNumber} 行（從第 ${startLabel} 小節開始）`)
  }

  async function startPlayback(enableAutoFollowOnStart = true, skipInitialFollowScroll = false, skipCountIn = false) {
    const osmd = osmdRef.current as any
    const events = playbackEventsRef.current
    if (!osmd || events.length === 0 || playbackDurationRef.current <= 0) {
      setPlaybackError('目前樂譜還沒有可播放的音符時間資訊。')
      return
    }

    const startAttempt = ++playbackStartAttemptRef.current
    const playbackEpoch = ++playbackEpochRef.current
    playbackStartInProgressRef.current = true
    setIsPreparingPlayback(true)
    try {
      let context = audioContextRef.current
      if (!context || context.state === 'closed') {
        context = new AudioContext()
        audioContextRef.current = context
      }
      await context.resume()
      if (scoreType === 'piano') {
        await ensureSalamanderSamplesLoaded(context, events)
        // A pause/background transition may have cancelled this async startup while
        // the samples were downloading. Never start playback after such a cancellation.
        if (startAttempt !== playbackStartAttemptRef.current || playbackEpoch !== playbackEpochRef.current) return
        await context.resume()
      } else if (scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle') {
        await ensureGuitarSamplesLoaded(context, events)
        if (startAttempt !== playbackStartAttemptRef.current || playbackEpoch !== playbackEpochRef.current) return
        await context.resume()
      }
      if (startAttempt !== playbackStartAttemptRef.current || playbackEpoch !== playbackEpochRef.current) return

      if (playbackNextEventIndexRef.current >= events.length) {
        playbackNextEventIndexRef.current = 0
        playbackAudioNextEventIndexRef.current = 0
        playbackCursorIndexRef.current = 0
        playbackTimeRef.current = 0
        setPlaybackSeconds(0)
        clearPlaybackNoteHighlights()
      }

      const cursor = osmd.cursor
      if (playbackNextEventIndexRef.current === 0 && playbackTimeRef.current === 0) {
        playbackAudioNextEventIndexRef.current = 0
        cursor.reset()
        playbackCursorIndexRef.current = 0
        clearPlaybackNoteHighlights()
      }
      cursor.CursorOptions = {
        type: scoreType === 'piano' ? 2 : 1,
        color: '#d9b779',
        alpha: 0.78,
        follow: false,
      }
      const pendingCursorEventIndex = pendingCursorSyncEventIndexRef.current
      if (pendingCursorEventIndex !== null && pendingCursorEventIndex >= 0 && pendingCursorEventIndex < events.length) {
        positionCursorAtTimelineEvent(pendingCursorEventIndex)
        pendingCursorSyncEventIndexRef.current = null
      }
      updatePlaybackCursorVisual(cursor)

      // Optional count-in: schedule a 1- or 2-bar pre-roll before the currently
      // selected score position. The count-in uses the current section's score tempo
      // and time signature, and is cancelled by the normal pause/background cleanup.
      const startScoreTime = Math.max(0, Math.min(playbackDurationRef.current, playbackTimeRef.current))
      playbackStartScoreTimeRef.current = startScoreTime
      const startEventIndex = Math.max(0, Math.min(events.length - 1,
        playbackNextEventIndexRef.current < events.length ? playbackNextEventIndexRef.current : events.length - 1))
      const startMeasureIndex = events[startEventIndex]?.measureIndex ?? 0
      const startMeter = metronomeMetersRef.current.get(startMeasureIndex) ??
        metronomeMetersRef.current.get(0) ?? { beats: 4, beatType: 4 }
      const sectionBpm = Math.max(30, events[startEventIndex]?.bpm ?? events[0]?.bpm ?? 80)
      const requestedCountInBars = skipCountIn ? 0 : countInBarsRef.current
      const denominatorBeatInQuarterNotes = 4 / Math.max(1, startMeter.beatType)
      const countInClicks = Math.min(32, Math.max(0, Math.round(requestedCountInBars * startMeter.beats)))
      const realBeatSeconds = (60 / sectionBpm) * denominatorBeatInQuarterNotes / playbackSpeedRef.current
      const countInDuration = countInClicks > 0 ? countInClicks * realBeatSeconds : 0
      const startNow = context.currentTime
      const countInDivisionCount = metronomeSubdivisionRef.current
      const countInPulses = countInClicks * countInDivisionCount
      const compoundCountIn = startMeter.beatType === 8 && startMeter.beats >= 6 && startMeter.beats % 3 === 0
      for (let pulse = 0; pulse < countInPulses; pulse++) {
        const beatNumber = Math.floor(pulse / countInDivisionCount)
        const beatInBar = beatNumber % Math.max(1, Math.round(startMeter.beats))
        const subdivisionIndex = pulse % countInDivisionCount
        const isSubdivision = subdivisionIndex > 0
        const accent = !isSubdivision && beatInBar === 0
        const secondaryAccent = !isSubdivision && (compoundCountIn
          ? beatInBar > 0 && beatInBar % 3 === 0
          : startMeter.beats >= 4 && beatInBar === 2)
        scheduleMetronomeClick(
          context,
          startNow + pulse * realBeatSeconds / countInDivisionCount,
          accent,
          isSubdivision,
          secondaryAccent,
        )
      }
      const initialGracePreRoll = getEventPreRollSeconds(events[startEventIndex])
      playbackOriginRef.current = startNow + countInDuration + initialGracePreRoll / playbackSpeedRef.current - startScoreTime / playbackSpeedRef.current
      metronomeNextBeatIndexRef.current = findNextMetronomeBeatIndex(startScoreTime)
      if (countInClicks > 0) {
        isCountingInRef.current = true
        setIsCountingIn(true)
      } else {
        isCountingInRef.current = false
        setIsCountingIn(false)
      }
      if (enableAutoFollowOnStart) {
        const shouldAutoFollow = autoFollowPlaybackPreferenceRef.current ?? true
        autoFollowPlaybackRef.current = shouldAutoFollow
        setAutoFollowPlayback(shouldAutoFollow)
        // A seek can already have positioned the destination row. Preserve that key
        // when the caller asked to skip the initial scroll, otherwise the first RAF
        // immediately issues a second scroll to the same row and can fight wheel input.
        if (shouldAutoFollow && !skipInitialFollowScroll) lastAutoFollowRowKeyRef.current = null
      }
      playbackRunningRef.current = true
      // Pre-queue the first short window before the first RAF callback. This is vital
      // when a count-in is enabled: notes can start exactly at the AudioContext time
      // even if the browser's animation frame arrives a few milliseconds late.
      if (playbackAudioNextEventIndexRef.current < playbackNextEventIndexRef.current) {
        playbackAudioNextEventIndexRef.current = playbackNextEventIndexRef.current
      }
      schedulePlaybackAudioAhead(context, startScoreTime)
      scheduleMetronomeAhead(context, startScoreTime)
      playbackUiLastUpdateMsRef.current = performance.now()
      setPlaybackError('')
      setIsPlaying(true)
      if (autoFollowPlaybackRef.current && !skipInitialFollowScroll) {
        const nextMeasureIndex = events[Math.min(playbackNextEventIndexRef.current, events.length - 1)]?.measureIndex
        const rowKey = scrollToPlaybackRow(nextMeasureIndex, 'smooth')
        if (rowKey) lastAutoFollowRowKeyRef.current = rowKey
      }
      playbackFrameRef.current = window.requestAnimationFrame(() => playbackTick(playbackEpoch))
    } catch (playError) {
      if (startAttempt === playbackStartAttemptRef.current) {
        playbackRunningRef.current = false
        setIsPlaying(false)
        setIsPreparingPlayback(false)
        setPlaybackError('音訊啓動失敗，請檢查瀏覽器是否允許播放聲音。')
        console.error('[ScoreRoom] Playback could not start:', playError)
      }
    } finally {
      if (startAttempt === playbackStartAttemptRef.current) {
        playbackStartInProgressRef.current = false
        setIsPreparingPlayback(false)
      }
    }
  }

  function pausePlayback() {
    playbackEpochRef.current += 1
    playbackStartAttemptRef.current += 1
    playbackStartInProgressRef.current = false
    setIsPreparingPlayback(false)
    playbackRunningRef.current = false
    cancelPlaybackFrame()
    // Future events are cancelled on pause. Resume must restart from the next event
    // visible at the current score time, not from an ahead-of-time queue pointer.
    playbackAudioNextEventIndexRef.current = playbackNextEventIndexRef.current
    isCountingInRef.current = false
    setIsCountingIn(false)
    stopActivePlaybackNotes()
    setIsPlaying(false)
  }

  function resetPlayback() {
    playbackEpochRef.current += 1
    playbackStartAttemptRef.current += 1
    playbackStartInProgressRef.current = false
    setIsPreparingPlayback(false)
    playbackRunningRef.current = false
    cancelPlaybackFrame()
    isCountingInRef.current = false
    setIsCountingIn(false)
    stopActivePlaybackNotes()
    playbackNextEventIndexRef.current = 0
    playbackAudioNextEventIndexRef.current = 0
    playbackCursorIndexRef.current = 0
    pendingCursorSyncEventIndexRef.current = null
    playbackTimeRef.current = 0
    playbackStartScoreTimeRef.current = 0
    metronomeNextBeatIndexRef.current = 0
    setPlaybackSeconds(0)
    setProgressPreview(null)
    progressWasPlayingRef.current = false
    setIsPlaying(false)
    setPlaybackError('')
    setMeasureSeekStatus('')
    clearPlaybackNoteHighlights()
    const cursor = (osmdRef.current as any)?.cursor
    if (cursor) {
      cursor.reset()
      cursor.hide()
    }
    lastAutoFollowRowKeyRef.current = scrollToPlaybackRow(0, 'smooth')
  }

  function seekPlaybackToSeconds(
    targetSeconds: number,
    resumeAfterSeek = playbackRunningRef.current,
    skipCountInOnResume = true,
    preferredEventIndex?: number,
    enableAutoFollowOnResume = false,
  ) {
    const events = playbackEventsRef.current
    const duration = playbackDurationRef.current
    if (!events.length || duration <= 0) return

    const target = Math.min(duration, Math.max(0, Number.isFinite(targetSeconds) ? targetSeconds : 0))

    // Invalidate pending asynchronous starts and stale RAF callbacks before resetting
    // queues. This prevents an earlier play request/frame from reviving the old position.
    playbackEpochRef.current += 1
    playbackStartAttemptRef.current += 1
    playbackStartInProgressRef.current = false
    setIsPreparingPlayback(false)
    playbackRunningRef.current = false
    cancelPlaybackFrame()
    stopActivePlaybackNotes()
    stopActiveMetronomeClicks()
    isCountingInRef.current = false
    setIsCountingIn(false)
    clearPlaybackNoteHighlights()

    // Prefer the exact event identified by the caller. Several voice entries can share
    // a timestamp; a time-only search could choose an event before the requested measure.
    let eventIndex = -1
    if (Number.isInteger(preferredEventIndex) && preferredEventIndex! >= 0 && preferredEventIndex! < events.length) {
      const preferred = events[preferredEventIndex!]
      if (Math.abs(preferred.time - target) <= 0.02) eventIndex = preferredEventIndex!
    }
    if (eventIndex < 0) eventIndex = events.findIndex(event => event.time >= target - 0.001)

    playbackTimeRef.current = target
    playbackStartScoreTimeRef.current = target
    setPlaybackSeconds(target)
    setPlaybackError('')
    metronomeNextBeatIndexRef.current = findNextMetronomeBeatIndex(target)
    playbackCursorIndexRef.current = 0

    if (target >= duration - 0.001 || eventIndex < 0) {
      pendingCursorSyncEventIndexRef.current = null
      playbackNextEventIndexRef.current = events.length
      playbackAudioNextEventIndexRef.current = events.length
      playbackTimeRef.current = duration
      setPlaybackSeconds(duration)
      setIsPlaying(false)
      const cursor = (osmdRef.current as any)?.cursor
      try { cursor?.reset(); cursor?.hide() } catch { /* cursor is optional */ }
      return
    }

    playbackNextEventIndexRef.current = eventIndex
    playbackAudioNextEventIndexRef.current = eventIndex
    pendingCursorSyncEventIndexRef.current = eventIndex
    setIsPlaying(false)
    // Only reset and walk the OSMD cursor once. The old implementation reset it before
    // positioning and then positionCursorAtTimelineEvent reset it again, increasing
    // main-thread work on seeks into later systems.
    positionCursorAtTimelineEvent(eventIndex)

    const targetMeasureIndex = events[eventIndex]?.measureIndex
    if (Number.isInteger(targetMeasureIndex) && (targetMeasureIndex as number) >= 0) {
      setSelectedTheoryMeasureIndex(targetMeasureIndex as number)
      lastTheoryPlaybackMeasureRef.current = targetMeasureIndex as number
    }
    let targetRowKey: string | null = null
    if (Number.isInteger(targetMeasureIndex) && (targetMeasureIndex as number) >= 0) {
      targetRowKey = scrollToPlaybackRow(targetMeasureIndex, 'auto')
      if (targetRowKey) lastAutoFollowRowKeyRef.current = targetRowKey
    }

    // The seek already positioned the destination row, so resuming must not launch a
    // second competing scroll. All note and metronome queues are rebuilt from this time.
    if (resumeAfterSeek) {
      void startPlayback(enableAutoFollowOnResume, targetRowKey !== null, skipCountInOnResume)
    }
  }

  function skipPlaybackSeconds(deltaSeconds: number) {
    // seekPlaybackToSeconds also positions the graphical cursor and scrolls the score,
    // so fast-forward/rewind always reveal where the playhead has moved.
    seekPlaybackToSeconds(playbackTimeRef.current + deltaSeconds, playbackRunningRef.current)
  }

  function toggleMetronome() {
    const next = !metronomeEnabledRef.current
    metronomeEnabledRef.current = next
    setMetronomeEnabled(next)
    if (next) {
      metronomeNextBeatIndexRef.current = findNextMetronomeBeatIndex(playbackTimeRef.current)
    } else if (!isCountingInRef.current) {
      // Count-in clicks are part of the chosen pre-roll even if the steady metronome
      // toggle is changed after the pre-roll has already been scheduled.
      stopActiveMetronomeClicks()
    }
  }

  function changeMetronomeSubdivision(value: number) {
    const safeValue: 1 | 2 | 4 = value === 4 ? 4 : value === 2 ? 2 : 1
    metronomeSubdivisionRef.current = safeValue
    setMetronomeSubdivision(safeValue)
    metronomeBeatGridRef.current = buildMetronomeBeatTimeline(
      playbackEventsRef.current,
      metronomeMetersRef.current,
      safeValue,
    )
    // The currently selected position is authoritative after changing the grid.
    // Clear queued clicks so the old and new subdivision patterns never overlap.
    stopActiveMetronomeClicks()
    metronomeNextBeatIndexRef.current = findNextMetronomeBeatIndex(playbackTimeRef.current)
  }

  function changeCountInBars(value: number) {
    const safeValue = value === 1 || value === 2 ? value : 0
    countInBarsRef.current = safeValue
    setCountInBars(safeValue)
  }

  function setABLoopEnabled(enabled: boolean) {
    const validRange = loopARef.current !== null && loopBRef.current !== null &&
      loopBRef.current > loopARef.current
    if (enabled && !validRange) {
      setPlaybackError('請先設定 A 點，再設定晚於 A 點的 B 點。')
      return
    }
    if (!enabled && tempoTrainerRef.current.enabled) {
      disableTempoTrainer('A/B 循環已關閉，漸進提速練習已暫停。')
    }
    abLoopEnabledRef.current = enabled
    setABLoopEnabledState(enabled)
    setPlaybackError('')
  }

  function setABPoint(point: 'A' | 'B') {
    if (tempoTrainerRef.current.enabled) {
      disableTempoTrainer('A/B 點已修改，漸進提速練習已暫停。')
    }
    const currentTime = Math.min(
      playbackDurationRef.current,
      Math.max(0, playbackRunningRef.current ? playbackTimeRef.current : playbackSeconds),
    )
    if (point === 'A') {
      loopARef.current = currentTime
      setLoopA(currentTime)
      if (loopBRef.current !== null && loopBRef.current <= currentTime) {
        loopBRef.current = null
        setLoopB(null)
        abLoopEnabledRef.current = false
        setABLoopEnabledState(false)
      }
    } else {
      const currentA = loopARef.current
      if (currentA === null) {
        setPlaybackError('請先設定 A 點，再設定 B 點。')
        return
      }
      if (currentTime <= currentA + 0.05) {
        setPlaybackError('B 點必須晚於 A 點，請先播放或定位到更靠後的位置。')
        return
      }
      loopBRef.current = currentTime
      setLoopB(currentTime)
    }
    setPlaybackError('')
  }

  function clearABLoop() {
    if (tempoTrainerRef.current.enabled) {
      disableTempoTrainer('A/B 循環已清除，漸進提速練習已暫停。')
    }
    loopARef.current = null
    loopBRef.current = null
    abLoopEnabledRef.current = false
    setLoopA(null)
    setLoopB(null)
    setABLoopEnabledState(false)
    setPlaybackError('')
  }

  function disableTempoTrainer(message = '') {
    const trainer = tempoTrainerRef.current
    trainer.enabled = false
    trainer.loopsAtCurrentSpeed = 0
    trainer.totalLoops = 0
    setTempoTrainerEnabled(false)
    setTempoTrainerLoopCount(0)
    setTempoTrainerStatus(message)
  }

  function toggleTempoTrainer() {
    const trainer = tempoTrainerRef.current
    if (trainer.enabled) {
      disableTempoTrainer('漸進提速練習已關閉。')
      return
    }

    const a = loopARef.current
    const b = loopBRef.current
    if (a === null || b === null || b <= a) {
      setPlaybackError('請先設定有效的 A、B 循環點，再開啟漸進提速。')
      return
    }

    const startSpeed = playbackSpeedRef.current
    const target = tempoTrainerTargetSpeed
    if (target <= startSpeed + 0.0005) {
      setPlaybackError(`目標速度 ${target.toFixed(2)}× 必須高於目前速度 ${startSpeed.toFixed(2)}×。請先降低目前速度或提高目標速度。`)
      return
    }

    trainer.enabled = true
    trainer.targetSpeed = target
    trainer.step = tempoTrainerStep
    trainer.repeatsPerStep = tempoTrainerRepeats
    trainer.loopsAtCurrentSpeed = 0
    trainer.totalLoops = 0
    setTempoTrainerEnabled(true)
    setTempoTrainerLoopCount(0)
    setTempoTrainerStatus(`從 ${startSpeed.toFixed(2)}× 開始；每 ${tempoTrainerRepeats} 輪提高 ${(tempoTrainerStep * 100).toFixed(0)}%，目標 ${target.toFixed(2)}×。`)
    setPlaybackError('')

    // Progressive practice is always based on a complete A-to-B segment. Turn on
    // A/B repeat and place the playhead at A so the first counted pass is meaningful.
    if (!abLoopEnabledRef.current) {
      abLoopEnabledRef.current = true
      setABLoopEnabledState(true)
    }
    seekPlaybackToSeconds(a, playbackRunningRef.current)
  }

  function updateTempoTrainerTarget(value: number) {
    const safe = Math.min(1.5, Math.max(0.75, value))
    setTempoTrainerTargetSpeed(safe)
    tempoTrainerRef.current.targetSpeed = safe
  }

  function updateTempoTrainerStep(value: number) {
    const safe = [0.03, 0.05, 0.1].includes(value) ? value : 0.05
    setTempoTrainerStep(safe)
    tempoTrainerRef.current.step = safe
  }

  function updateTempoTrainerRepeats(value: number) {
    const safe = [1, 2, 3].includes(value) ? value : 2
    setTempoTrainerRepeats(safe)
    tempoTrainerRef.current.repeatsPerStep = safe
  }

  function commitProgressSeek(targetSeconds: number) {
    const resumeAfterSeek = progressWasPlayingRef.current
    progressWasPlayingRef.current = false
    setProgressPreview(null)
    seekPlaybackToSeconds(targetSeconds, resumeAfterSeek)
  }

  function changePlaybackSpeed(nextSpeed: number) {
    if (isCountingInRef.current) {
      setPlaybackError('預備拍進行中，請等樂曲開始後再調整播放速度。')
      return
    }
    if (tempoTrainerRef.current.enabled) {
      disableTempoTrainer('手動更改速度，漸進提速練習已暫停。')
    }
    const safeSpeed = Number.isFinite(nextSpeed) ? Math.min(1.5, Math.max(0.5, nextSpeed)) : 1
    const context = audioContextRef.current
    if (playbackRunningRef.current && context && context.state !== 'closed') {
      // Derive score time from the audio clock, cancel only future queued sounds, then
      // re-anchor and refill the scheduler at the new speed. This avoids old-tempo notes
      // remaining queued after a speed change.
      const currentScoreTime = Math.max(
        playbackStartScoreTimeRef.current,
        (context.currentTime - playbackOriginRef.current) * playbackSpeedRef.current,
        0,
      )
      cancelFutureScheduledVoices()
      playbackTimeRef.current = currentScoreTime
      playbackOriginRef.current = context.currentTime - currentScoreTime / safeSpeed
      const events = playbackEventsRef.current
      let nextIndex = playbackNextEventIndexRef.current
      while (nextIndex < events.length && events[nextIndex].time <= currentScoreTime + 0.006) nextIndex += 1
      playbackNextEventIndexRef.current = nextIndex
      playbackAudioNextEventIndexRef.current = nextIndex
      // Align the visible cursor to the latest event already reached so speed changes
      // neither replay an old note nor leave a stale highlight behind.
      const lastDueIndex = nextIndex - 1
      if (lastDueIndex >= 0) positionCursorAtTimelineEvent(lastDueIndex)
      metronomeNextBeatIndexRef.current = findNextMetronomeBeatIndex(currentScoreTime)
      playbackSpeedRef.current = safeSpeed
      schedulePlaybackAudioAhead(context, currentScoreTime)
      scheduleMetronomeAhead(context, currentScoreTime)
      setPlaybackSeconds(currentScoreTime)
      playbackUiLastUpdateMsRef.current = performance.now()
    } else {
      playbackSpeedRef.current = safeSpeed
    }
    setPlaybackSpeed(safeSpeed)
  }

  useEffect(() => {
    let cancelled = false
    let scoreReady = false
    let observer: MutationObserver | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeTimer: number | null = null
    let resizeFrame1: number | null = null
    let resizeFrame2: number | null = null
    let overlayMutationFrame: number | null = null
    // After React switches from the loading shell to the stable score view, force one
    // settled OSMD render. Measure-number alignment can otherwise run against the
    // pre-layout geometry; opening the theory panel later causes a resize/render and
    // makes the same labels suddenly align, which is the reported symptom.
    let postLoadLayoutTimer: number | null = null
    let pedalCorrectionIndices: number[] = []

    // All overlay/layout passes now share one reset and draw order. This prevents the
    // chord-stem, lyric-spacing, and annotation passes from restoring each other's
    // intermediate transforms, which previously caused size/zoom-dependent drift.
    const redrawOverlays = (targetContainer: HTMLElement) => {
      restoreScoreRoomLayoutTransforms(targetContainer)
      // A manually selected piano type takes precedence over source-file heuristics.
      // Some converted scores contain technical annotations even though they should be
      // rendered as clean piano notation.
      const isTabScore = scoreType === 'piano'
        ? false
        : scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle' || isGuitarTabRef.current

      // Hide only the literal mf dynamic marking in guitar/TAB scores. Keep the text
      // node and its geometry in place so OSMD layout and measure alignment do not shift.
      // Save and restore previous opacity so switching/re-rendering a score is reversible.
      const restoreHiddenMfLabels = () => {
        targetContainer.querySelectorAll<SVGTextElement>('text[data-manbanpai-hidden-mf="1"]').forEach(label => {
          const originalOpacity = label.getAttribute('data-manbanpai-original-opacity')
          const originalStyleOpacity = label.getAttribute('data-manbanpai-original-style-opacity')
          if (originalOpacity === '__none__' || originalOpacity === null) label.removeAttribute('opacity')
          else label.setAttribute('opacity', originalOpacity)
          if (originalStyleOpacity === '__none__' || originalStyleOpacity === null) label.style.removeProperty('opacity')
          else label.style.opacity = originalStyleOpacity
          label.removeAttribute('data-manbanpai-hidden-mf')
          label.removeAttribute('data-manbanpai-original-opacity')
          label.removeAttribute('data-manbanpai-original-style-opacity')
        })
      }
      if (isTabScore) {
        targetContainer.querySelectorAll<SVGTextElement>('svg text').forEach(label => {
          const normalizedText = (label.textContent ?? '').replace(/\s+/g, '').toLowerCase()
          if (normalizedText !== 'mf') return
          if (label.getAttribute('data-manbanpai-hidden-mf') !== '1') {
            label.setAttribute('data-manbanpai-hidden-mf', '1')
            label.setAttribute('data-manbanpai-original-opacity', label.hasAttribute('opacity') ? label.getAttribute('opacity') ?? '' : '__none__')
            label.setAttribute('data-manbanpai-original-style-opacity', label.style.opacity || '__none__')
          }
          label.setAttribute('opacity', '0')
          label.style.opacity = '0'
        })
      } else {
        restoreHiddenMfLabels()
      }

      if (isTabScore && isGuitarTabRef.current && lyricTextsRef.current.size > 0) {
        applyLyricsFontScale(targetContainer, lyricTextsRef.current, 0.82)
      }
      if (effectiveShowChordDiagrams) {
        try {
          drawChordFrames(targetContainer, chordFramesRef.current)
        } catch (overlayError) {
          console.error('[慢半拍] Chord-diagram overlay failed; keeping rendered score visible.', overlayError)
          targetContainer.querySelectorAll('[data-score-room-chord-frame]').forEach(element => element.remove())
        }
      } else {
        targetContainer.querySelectorAll('[data-score-room-chord-frame]').forEach(element => element.remove())
      }
      if (isTabScore) {
        try {
          drawBrushMarkers(targetContainer, brushNoteEventsRef.current)
        } catch (overlayError) {
          console.error('[慢半拍] TAB rhythm overlay failed; keeping rendered score visible.', overlayError)
          targetContainer.querySelectorAll('[data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem]').forEach(element => element.remove())
        }
      } else targetContainer.querySelectorAll('[data-score-room-brush-marker], [data-score-room-dot-marker], [data-score-room-technique-marker], [data-score-room-half-notehead], [data-score-room-duration-stem]').forEach(element => element.remove())
      applyLocalLyricsChordClearance(
        targetContainer,
        lyricTextsRef.current,
        zoomRef.current,
      )
      // Keep TAB row-spacing normalization restricted to guitar scores.
      if (isTabScore) {
        applyUniformSystemRowSpacing(targetContainer)
      } else {
        // In piano notation OSMD's skyline can lift individual measure numbers far above
        // the top staff when notes/annotations are high. Re-anchor them after every render.
        alignPianoMeasureNumbersToStaff(targetContainer)
      }
      // Rebuild whole-line click targets after all layout transforms. This is also
      // called after OSMD resize/re-render and manual zoom, so target geometry stays aligned.
      installLineHitAreas(targetContainer, osmdRef.current as any, (rowStartIndex, rowNumber) => {
        lineClickActionRef.current?.(rowStartIndex, rowNumber)
      })
      // The theory annotation layer is kept separate from the engraving/layout layer.
      // Rebuild it only after line hitboxes and responsive score geometry are current.
      theoryOverlayRedrawRef.current?.()
    }
    redrawOverlaysRef.current = redrawOverlays

    // Use one owner for responsive rendering. OSMD autoResize and our overlay redraw
    // previously raced each other when DevTools opened/closed: overlays could be drawn
    // against the prior system layout. Wait for the width to settle, call OSMD.render()
    // ourselves, re-apply pedal endpoint fixes, then recalculate every overlay.
    const scheduleOverlayRedrawAfterResize = () => {
      if (cancelled || !scoreReady) return

      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (resizeFrame1 !== null) window.cancelAnimationFrame(resizeFrame1)
      if (resizeFrame2 !== null) window.cancelAnimationFrame(resizeFrame2)

      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        if (cancelled) return

        const currentContainer = containerRef.current
        const currentOsmd = osmdRef.current
        if (!currentContainer || !currentOsmd) return

        // Preserve viewport and the actual graphical event across renderer rebuilds.
        // OSMD's built-in cursor follow is disabled because ScoreRoom handles row-follow itself.
        const savedScrollX = window.scrollX
        const savedScrollY = window.scrollY
        const eventsBeforeRender = playbackEventsRef.current
        const cursorIndexBeforeRender = eventsBeforeRender.length > 0
          ? Math.max(0, Math.min(playbackCursorIndexRef.current, eventsBeforeRender.length - 1))
          : null
        const currentCursor = currentOsmd.cursor
        if (currentCursor) {
          currentCursor.CursorOptions = {
            ...(currentCursor.CursorOptions ?? {}),
            follow: false,
          }
        }
        const restoreViewport = () => {
          if (Math.abs(window.scrollX - savedScrollX) > 1 || Math.abs(window.scrollY - savedScrollY) > 1) {
            scrollWindowProgrammatically(savedScrollY, 'auto', savedScrollX)
          }
        }

        // Restore the OSMD baseline before re-layout so stale screen-space translations
        // from the previous width cannot be baked into the next SVG geometry.
        restoreScoreRoomLayoutTransforms(currentContainer)
        currentOsmd.render()
        if (applyPedalEndCorrections(currentOsmd, pedalCorrectionIndices)) {
          currentOsmd.render()
        }
        if (cursorIndexBeforeRender !== null) positionCursorAtTimelineEvent(cursorIndexBeforeRender)
        restoreViewport()

        resizeFrame1 = window.requestAnimationFrame(() => {
          resizeFrame1 = null
          resizeFrame2 = window.requestAnimationFrame(() => {
            resizeFrame2 = null
            if (cancelled) return

            const settledContainer = containerRef.current
            if (!settledContainer) return

            try { redrawOverlays(settledContainer) } catch (overlayError) {
              console.error('[慢半拍] Overlay redraw failed; OSMD score remains available.', overlayError)
            }
            restoreViewport()
          })
        })
      }, 160)
    }

    window.addEventListener('resize', scheduleOverlayRedrawAfterResize, { passive: true })

    async function loadScore() {
      const container = containerRef.current
      if (!container) return

      playbackEpochRef.current += 1
      playbackStartAttemptRef.current += 1
      pendingCursorSyncEventIndexRef.current = null
      playbackRunningRef.current = false
      cancelPlaybackFrame()
      isCountingInRef.current = false
      setIsCountingIn(false)
      playbackStartScoreTimeRef.current = 0
      metronomeNextBeatIndexRef.current = 0
      stopActivePlaybackNotes()
      playbackEventsRef.current = []
      guitarMeasureEndTimesRef.current = new Map()
      playbackNextEventIndexRef.current = 0
      playbackAudioNextEventIndexRef.current = 0
      playbackCursorIndexRef.current = 0
      playbackTimeRef.current = 0
      playbackDurationRef.current = 0
      setIsPlaying(false)
      setPlaybackSeconds(0)
      setPlaybackDuration(0)
      setPlaybackError('')
      setMeasureSeekStatus('')
      loopARef.current = null
      loopBRef.current = null
      abLoopEnabledRef.current = false
      setLoopA(null)
      setLoopB(null)
      setABLoopEnabledState(false)
      setLoading(true)
      setError('')
      setGuitarSetupInfo(null)
      chordFramesRef.current = []
      lyricTextsRef.current = new Set()
      brushNoteEventsRef.current = []
      isGuitarTabRef.current = false
      container.innerHTML = ''

      // 當 OSMD 因視窗尺寸變化而重新生成 SVG 時，恢復指法圖。
      observer = new MutationObserver((mutations) => {
        if (cancelled || !scoreReady) return
        if (suppressObserverRedrawRef.current) return
        // We own both the HTML line-hitbox wrapper and the theory-label overlay.
        // Adding/removing either is not an OSMD engraving change. In v53 the theory
        // overlay was not excluded, so redrawOverlays() rebuilt it, the observer saw
        // that mutation, and queued another full redraw indefinitely. Apart from jank,
        // this repeatedly destroyed clickable hit targets while the user was clicking.
        const isManagedOverlayNode = (node: Node) => {
          if (!(node instanceof Element)) return false
          return node.getAttribute('data-score-room-hitbox-layer') === 'true' ||
            node.getAttribute('data-score-room-theory-overlay') === 'true'
        }
        const hasRendererMutation = mutations.some(mutation => {
          const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
          if (changedNodes.length === 0) return false
          return !changedNodes.every(isManagedOverlayNode)
        })
        if (!hasRendererMutation || overlayMutationFrame !== null) return

        overlayMutationFrame = window.requestAnimationFrame(() => {
          overlayMutationFrame = null
          if (cancelled || !scoreReady || !containerRef.current) return
          try { redrawOverlays(containerRef.current) } catch (overlayError) {
            console.error('[慢半拍] Overlay redraw failed; OSMD score remains available.', overlayError)
          }
        })
      })

      observer.observe(container, { childList: true })

      // Also watch the score container itself. This catches responsive width
      // changes even in cases where the browser does not replace the outer SVG.
      let lastContainerWidth = container.getBoundingClientRect().width
      resizeObserver = new ResizeObserver((entries) => {
        if (cancelled) return
        const entry = entries[entries.length - 1]
        const nextWidth = entry?.contentRect.width
        if (!Number.isFinite(nextWidth)) return

        if (Math.abs(nextWidth! - lastContainerWidth) >= 1) {
          lastContainerWidth = nextWidth!
          scheduleOverlayRedrawAfterResize()
        }
      })
      resizeObserver.observe(container)

      try {
        const osmd = new OpenSheetMusicDisplay(container, {
          autoResize: false,
          backend: 'svg',
          drawCredits: true,
          drawTitle: true,
          drawSubtitle: true,
          drawComposer: true,
          drawingParameters: 'compacttight',
        })

        osmdRef.current = osmd
        zoomRef.current = 1
        baseTitleBottomDistanceRef.current = Number(
          (osmd.EngravingRules as any).TitleBottomDistance ?? 1,
        )

        // Parse lyrics and Guitar Pro technical annotations for every import. The TAB
        // overlay code activates only when real string/fret data exists, rather than
        // relying on a particular filename. This also supports future imported guitar scores.
        try {
          lyricTextsRef.current = await readLyricsTexts(fileUrl)
        } catch (lyricsError) {
          console.warn('[ScoreRoom] Lyrics text loading failed:', lyricsError)
          lyricTextsRef.current = new Set()
        }

        try {
          brushNoteEventsRef.current = await readBrushNoteEvents(fileUrl)
        } catch (brushError) {
          console.warn('[ScoreRoom] Brush marker loading failed:', brushError)
          brushNoteEventsRef.current = []
        }
        isGuitarTabRef.current = brushNoteEventsRef.current.some(
          event => event.fretNotes.length > 0 || event.techniqueStringNumbers.length > 0 ||
            event.techniques.some(tag => /^(?:S|P|T|G|PM|MUTE|MUTED|DAMP)$/i.test(tag)),
        )

        try {
          const parsedGuitarSetup = await readGuitarSetupInfo(fileUrl)
          if (cancelled) return
          setGuitarSetupInfo(parsedGuitarSetup)
        } catch (guitarSetupError) {
          console.warn('[ScoreRoom] Guitar capo/tuning metadata loading failed:', guitarSetupError)
          if (!cancelled) setGuitarSetupInfo(null)
        }

        if (cancelled) return

        // Suppress consecutive duplicate dynamic labels for every imported score.
        // This was previously enabled for only one title, so other guitar scores could
        // display repeated mf marks. Playback dynamics are still read from the MusicXML.
        ;(osmd.EngravingRules as any).IgnoreRepeatedDynamics = true
        if (isGuitarTabRef.current && lyricTextsRef.current.size > 0) {
          ;(osmd.EngravingRules as any).LyricsHeight = 1.8
          ;(osmd.EngravingRules as any).LyricsUseXPaddingForLongLyrics = true
          ;(osmd.EngravingRules as any).LyricsXPaddingFactorForLongLyrics = 1.2
        }

        // 使用固定的樂譜單位間距，不按縮放比例反向補償；縮小時自然更緊湊。
        // 開啟指法圖只增加必要空間，避免系統間距過大。
        osmd.EngravingRules.MinimumDistanceBetweenSystems =
          effectiveShowChordDiagrams ? 9 : 2.5
        osmd.EngravingRules.MinSkyBottomDistBetweenSystems =
          effectiveShowChordDiagrams ? 6 : 1.5
        osmd.EngravingRules.RenderPedals = true
        osmd.EngravingRules.RenderChordSymbols = true

        // Piano scores should display clean notation without fingering numbers.
        // Guitar scores (accompaniment TAB and fingerstyle staff+TAB) retain their
        // source fingerings. This rule affects fingering annotations only; TAB fret
        // numbers are rendered independently and remain visible.
        // Manual library classification takes precedence. This is important because
        // piano fingering numbers and guitar annotations must not be guessed from the
        // same numeric text. Keep the v8 content-based fallback for older call sites.
        const renderFingerings = scoreType
          ? scoreType !== 'piano'
          : isGuitarTabRef.current
        osmd.EngravingRules.RenderFingerings = renderFingerings

        const isGuitarScoreForRender = scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle' || isGuitarTabRef.current
        await loadScoreWithoutPrintedPageNumberCredits(osmd, fileUrl, isGuitarScoreForRender)

        if (cancelled) return

        // Light-touch local width balancing for the compressed bar 36.
        // Do not enable FixedMeasureWidth globally: OSMD makes every measure as wide
        // as the widest one when that experimental rule is on, which opens up the score
        // too much. Instead, nudge only bars 35-37 before the first real render.
        // SourceMeasure.WidthFactor is a pre-layout multiplier, so fret numbers and
        // their stems stay attached to their notes and the vertical row spacing is untouched.
        if (isGuitarTabRef.current) {
          try {
            const sourceMeasures = (osmd as any).Sheet?.SourceMeasures as Array<any> | undefined
            if (sourceMeasures?.length) {
              let centerIndex = sourceMeasures.findIndex(measure =>
                Number(measure.MeasureNumberXML) === 36,
              )
              if (centerIndex < 0) {
                centerIndex = sourceMeasures.findIndex(measure =>
                  Number(measure.MeasureNumber) === 36,
                )
              }

              if (centerIndex >= 0) {
                const localFactors = [0.97, 1.08, 0.97]
                for (let offset = -1; offset <= 1; offset++) {
                  const measure = sourceMeasures[centerIndex + offset]
                  if (!measure) continue
                  // Multiply a source-specified factor instead of overwriting it.
                  const currentFactor = Number(measure.WidthFactor)
                  const baseFactor = Number.isFinite(currentFactor) && currentFactor > 0
                    ? currentFactor
                    : 1
                  measure.WidthFactor = baseFactor * localFactors[offset + 1]
                }
              }
            }
          } catch (measureWidthError) {
            console.warn('[ScoreRoom] Local measure-width balancing skipped:', measureWidthError)
          }
        }

        chordFramesRef.current = []
        if (effectiveShowChordDiagrams) {
          try {
            chordFramesRef.current = await readChordFrames(fileUrl)
          } catch (frameError) {
            console.warn(
              '[ScoreRoom] Chord frame loading failed:',
              frameError,
            )
            chordFramesRef.current = []
          }
        }

        if (cancelled) return

        let correctionIndices: number[] = []

        try {
          correctionIndices =
            await findPedalSegmentsEndingAtBarline(fileUrl)
        } catch (pedalError) {
          console.warn(
            '[ScoreRoom] Pedal endpoint analysis failed:',
            pedalError,
          )
        }

        if (cancelled) return

        pedalCorrectionIndices = correctionIndices
        pedalCorrectionIndicesRef.current = correctionIndices
        osmd.zoom = 1

        osmd.render()

        // Re-apply the validated pedal endpoint adjustments before any custom overlays.
        if (applyPedalEndCorrections(osmd, pedalCorrectionIndices)) {
          osmd.render()
        }

        // Balance only measures with identical MusicXML rhythm patterns. This second
        // render happens before overlays/timeline construction so their coordinates are
        // computed from the final layout; drawBrushMarkers itself remains unchanged.
        if (isGuitarTabRef.current && balanceRepeatedRhythmMeasureWidths(osmd, container, brushNoteEventsRef.current)) {
          osmd.render()
        }

        if (cancelled) return

        // In one deterministic pass, restore the baseline then draw all overlays and
        // collision-adjusted text in a consistent order.
        try { redrawOverlays(container) } catch (overlayError) {
          console.error('[慢半拍] Initial overlay pass failed; retaining the rendered score.', overlayError)
        }

        // Prepare a synchronized note timeline using OSMD's own cursor iterator.
        // Highlight is shown only during playback, to keep the static score clean.
        try {
          const cursor = (osmd as any).cursor
          cursor.CursorOptions = {
            type: scoreType === 'piano' ? 2 : 1,
            color: '#d9b779',
            alpha: 0.78,
            follow: false,
          }
          cursor.reset()
          const timeline = extractPlaybackTimeline(osmd, scoreType)
          if (scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle' || isGuitarTabRef.current) {
            applyGuitarPerformanceToTimeline(timeline, brushNoteEventsRef.current)
          }
          metronomeMetersRef.current = new Map([[0, { beats: 4, beatType: 4 }]])
          metronomeBeatGridRef.current = buildMetronomeBeatTimeline(timeline, metronomeMetersRef.current, metronomeSubdivisionRef.current)
          try {
            const performanceResponse = await fetch(fileUrl)
            if (performanceResponse.ok) {
              const performanceXml = await performanceResponse.text()
              const canonicalModel = getCanonicalMusicXmlData(performanceXml)
              const modelValidation = validateCanonicalMusicXmlData(canonicalModel)
              const timelineValidation = validatePlaybackTimelineAgainstCanonicalModel(timeline, canonicalModel)
              if (!modelValidation.ok || timelineValidation.errors.length > 0) {
                console.warn('[ScoreRoom] Canonical score-data validation found issues.', {
                  model: modelValidation,
                  timeline: timelineValidation,
                })
              } else if (timelineValidation.warnings.length > 0 || modelValidation.warnings.length > 0) {
                console.info('[ScoreRoom] Canonical score-data validation completed with warnings.', {
                  model: modelValidation,
                  timeline: timelineValidation,
                })
              } else {
                console.info(`[ScoreRoom] Canonical score-data validation passed: ${canonicalModel.measures.length} measures, ${canonicalModel.noteCount} notes.`)
              }
              metronomeMetersRef.current = parseMusicXmlMeterMap(performanceXml)
              const firstMeter = metronomeMetersRef.current.get(0) ?? { beats: 4, beatType: 4 }
              setMetronomeMeterLabel(`${firstMeter.beats}/${firstMeter.beatType}`)
              metronomeBeatGridRef.current = buildMetronomeBeatTimeline(timeline, metronomeMetersRef.current, metronomeSubdivisionRef.current)
              const performanceStats = applyMusicXmlPerformanceMarksToTimeline(timeline, performanceXml)
              const dynamicInfo = performanceStats.dynamicsCount > 0
                ? `${performanceStats.dynamicsCount} 個力度標記`
                : '無力度標記，預設 mf'
              const pedalInfo = performanceStats.pedalCount > 0
                ? `${performanceStats.pedalCount} 個踏板標記`
                : '無踏板標記'
              const wedgeInfo = performanceStats.wedgeCount > 0 ? ` · 漸強/漸弱 ${Math.floor(performanceStats.wedgeCount / 2)} 段` : ''
              setPerformanceControlStatus(`${dynamicInfo} · ${pedalInfo}${wedgeInfo}`)
            } else {
              setPerformanceControlStatus('無法讀取力度/踏板標記，使用預設演奏')
            }
          } catch (performanceError) {
            console.warn('[ScoreRoom] Performance-mark parsing failed; default dynamics will be used.', performanceError)
            setPerformanceControlStatus('力度/踏板解析失敗，使用預設演奏')
          }
          if (cancelled) return
          const playableToneCount = timeline.reduce((total, event) => total + event.notes.length, 0)
          if (timeline.length > 0 && playableToneCount > 0) {
            guitarMeasureEndTimesRef.current = buildMeasureEndTimeMap(timeline, metronomeMetersRef.current)
            playbackEventsRef.current = timeline
            const lastEvent = timeline[timeline.length - 1]
            const lastToneEnd = timeline.reduce((maxEnd, event) => {
              const eventEnd = event.notes.reduce(
                (noteEnd, note) => Math.max(
                  noteEnd,
                  event.time + Math.max(0, Number(note.startOffsetSeconds ?? 0)) + note.durationSeconds,
                ),
                event.time,
              )
              return Math.max(maxEnd, eventEnd)
            }, 0)
            const isGuitarScore = scoreType === 'guitar-vocal' || scoreType === 'guitar-fingerstyle'
            const finalMeasureEnd = isGuitarScore
              ? Math.max(0, ...guitarMeasureEndTimesRef.current.values())
              : 0
            const totalDuration = Math.max(lastEvent.time + 0.18, lastToneEnd + 0.08, finalMeasureEnd + (isGuitarScore ? 0.06 : 0))
            playbackDurationRef.current = totalDuration
            setPlaybackDuration(totalDuration)
            setPlaybackError('')
          } else {
            playbackEventsRef.current = []
            guitarMeasureEndTimesRef.current = new Map()
            playbackDurationRef.current = 0
            setPlaybackDuration(0)
            setPlaybackError('這份樂譜沒有識別到可播放的音高資訊。')
          }
          cursor.reset()
          cursor.hide()
        } catch (timelineError) {
          playbackEventsRef.current = []
          guitarMeasureEndTimesRef.current = new Map()
          playbackDurationRef.current = 0
          setPlaybackDuration(0)
          setPlaybackError('無法從這份樂譜提取播放時間資訊。')
          console.warn('[ScoreRoom] Could not prepare playback timeline:', timelineError)
        }

        scoreReady = true
        setZoom(100)
        setLoading(false)

        // The first render above happens while React is still transitioning out of its
        // loading state. In this app the score can acquire its final width/height only
        // after that state commits. The theory panel used to incidentally trigger the
        // needed second render; do the same once automatically so measure numbers are
        // aligned from the outset, even when analysis stays closed.
        if (postLoadLayoutTimer !== null) window.clearTimeout(postLoadLayoutTimer)
        postLoadLayoutTimer = window.setTimeout(() => {
          postLoadLayoutTimer = null
          if (cancelled || !scoreReady || !containerRef.current) return
          scheduleOverlayRedrawAfterResize()
        }, 90)
      } catch (err) {
        if (cancelled) return

        console.error('[ScoreRoom] Failed to load score:', err)
        setError(
          'Failed to load the score. Check the MusicXML file path and browser console.',
        )
        setLoading(false)
      }
    }

    void loadScore()

    return () => {
      cancelled = true
      suppressObserverRedrawRef.current = false
      playbackEpochRef.current += 1
      playbackStartAttemptRef.current += 1
      playbackRunningRef.current = false
      cancelPlaybackFrame()
      isCountingInRef.current = false
      stopActivePlaybackNotes()
      clearPlaybackNoteHighlights()
      observer?.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleOverlayRedrawAfterResize)
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      if (postLoadLayoutTimer !== null) window.clearTimeout(postLoadLayoutTimer)
      if (resizeFrame1 !== null) window.cancelAnimationFrame(resizeFrame1)
      if (resizeFrame2 !== null) window.cancelAnimationFrame(resizeFrame2)
      if (overlayMutationFrame !== null) window.cancelAnimationFrame(overlayMutationFrame)
      osmdRef.current = null
      redrawOverlaysRef.current = null
    }
  }, [fileUrl, effectiveShowChordDiagrams, scoreType])

  // Never let the RAF playback clock accumulate while the tab/window is hidden.
  // Browsers throttle animation frames in the background; if playback remains marked
  // as running, the first frame after returning could schedule many overdue notes at once.
  useEffect(() => {
    const pauseForBackground = () => {
      if (!playbackRunningRef.current && !playbackStartInProgressRef.current) return
      playbackEpochRef.current += 1
      playbackStartAttemptRef.current += 1
      playbackStartInProgressRef.current = false
      setIsPreparingPlayback(false)
      playbackRunningRef.current = false
      playbackAudioNextEventIndexRef.current = playbackNextEventIndexRef.current
      isCountingInRef.current = false
      setIsCountingIn(false)
      if (playbackFrameRef.current !== null) {
        window.cancelAnimationFrame(playbackFrameRef.current)
        playbackFrameRef.current = null
      }
      stopActivePlaybackNotes()
      setIsPlaying(false)
      setPlaybackSeconds(Math.min(playbackDurationRef.current, Math.max(0, playbackTimeRef.current)))
      setMeasureSeekStatus('頁面切換到後台，已自動暫停；返回後點擊「播放」可繼續。')
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') pauseForBackground()
    }
    const onWindowBlur = () => pauseForBackground()
    const onPageHide = () => pauseForBackground()

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  useEffect(() => {
    return () => {
      playbackEpochRef.current += 1
      playbackStartAttemptRef.current += 1
      playbackStartInProgressRef.current = false
      setIsPreparingPlayback(false)
      playbackRunningRef.current = false
      cancelPlaybackFrame()
      stopActivePlaybackNotes()
      const context = audioContextRef.current
      audioContextRef.current = null
      if (context && context.state !== 'closed') {
        void context.close().catch(() => undefined)
      }
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current)
        programmaticScrollTimerRef.current = null
      }
      programmaticScrollRef.current = false
    }
  }, [])

  function changeZoom(amount: number) {
    const nextZoom = Math.min(
      2,
      Math.max(0.5, zoomRef.current + amount),
    )

    zoomRef.current = nextZoom

    const osmd = osmdRef.current

    if (osmd) {
      const container = containerRef.current
      clearPlaybackNoteHighlights()
      if (container) restoreScoreRoomLayoutTransforms(container)
      osmd.zoom = nextZoom
      osmd.render()
      if (container) redrawOverlaysRef.current?.(container)
    }

    setZoom(Math.round(nextZoom * 100))
  }

  function resetZoom() {
    zoomRef.current = 1

    const osmd = osmdRef.current

    if (osmd) {
      const container = containerRef.current
      clearPlaybackNoteHighlights()
      if (container) restoreScoreRoomLayoutTransforms(container)
      osmd.zoom = 1
      osmd.render()
      if (container) redrawOverlaysRef.current?.(container)
    }

    setZoom(100)
  }

  keyboardShortcutsRef.current = {
    togglePlayback: () => {
      if (loading || playbackDurationRef.current <= 0) return
      if (playbackRunningRef.current || playbackStartInProgressRef.current) pausePlayback()
      else void startPlayback(true)
    },
    seek: (deltaSeconds: number) => {
      if (loading || playbackDurationRef.current <= 0) return
      skipPlaybackSeconds(deltaSeconds)
    },
    reset: () => {
      if (loading || playbackDurationRef.current <= 0) return
      resetPlayback()
    },
    closePanels: () => {
      if (showTheoryPanel) {
        setShowTheoryPanel(false)
        return true
      }
      if (showChordDiagrams) {
        setShowChordDiagrams(false)
        return true
      }
      if (progressPreview !== null) {
        setProgressPreview(null)
        progressWasPlayingRef.current = false
        return true
      }
      if (playbackControlsVisible) {
        setPlaybackControlsVisible(false)
        return true
      }
      return false
    },
    disableAutoFollow: disableAutoFollowFromManualScroll,
  }

  useEffect(() => {
    const isTextEditingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target)) return
      const actions = keyboardShortcutsRef.current
      // Browser scrolling keys count as manual navigation and relinquish auto-follow.
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'End'].includes(event.key)) {
        actions.disableAutoFollow()
      }

      if (event.key === ' ' || event.code === 'Space' || event.key === 'Spacebar') {
        event.preventDefault()
        if (!event.repeat) actions.togglePlayback()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        actions.seek(-5)
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        actions.seek(5)
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        if (!event.repeat) actions.reset()
        return
      }
      if (event.key === 'Escape' && !event.repeat) {
        if (actions.closePanels()) event.preventDefault()
      }
    }

    const onScroll = () => {
      if (programmaticScrollRef.current) return
      keyboardShortcutsRef.current.disableAutoFollow()
    }
    const onManualScrollIntent = () => {
      // A native wheel gesture should take control immediately. If a smooth auto-follow
      // scroll is still animating, cancel it so it cannot keep moving the page beneath
      // the user's wheel input.
      if (programmaticScrollRef.current) {
        if (programmaticScrollTimerRef.current !== null) {
          window.clearTimeout(programmaticScrollTimerRef.current)
          programmaticScrollTimerRef.current = null
        }
        programmaticScrollRef.current = false
        window.scrollTo({ top: window.scrollY, behavior: 'auto' })
      }
      keyboardShortcutsRef.current.disableAutoFollow()
    }
    const onPointerDown = (event: PointerEvent) => {
      // Detect a direct drag/click on the browser's native scrollbars where available.
      const root = document.documentElement
      if (event.clientX >= root.clientWidth || event.clientY >= root.clientHeight) {
        keyboardShortcutsRef.current.disableAutoFollow()
      }
    }
    const releaseProgrammaticScroll = () => {
      programmaticScrollRef.current = false
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current)
        programmaticScrollTimerRef.current = null
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    window.addEventListener('wheel', onManualScrollIntent, { passive: true })
    window.addEventListener('touchmove', onManualScrollIntent, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('scrollend', releaseProgrammaticScroll)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('wheel', onManualScrollIntent)
      window.removeEventListener('touchmove', onManualScrollIntent)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scrollend', releaseProgrammaticScroll)
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current)
        programmaticScrollTimerRef.current = null
      }
      programmaticScrollRef.current = false
    }
  }, [])

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 34,
    height: 32,
    padding: '0 10px',
    border: '1px solid #d5d4c9',
    borderRadius: 7,
    background: '#ffffff',
    color: '#292a24',
    fontSize: 18,
    cursor: 'pointer',
  }

  function toggleTheoryPanelVisibility() {
    if (showTheoryPanel) {
      setShowTheoryPanel(false)
      return
    }
    // Default to the combined chord-name / Roman-numeral card mode.
    // The user can switch to bass, non-chord-tone, or melody-contour views,
    // but no longer needs a separate "disable analysis" radio option.
    setScoreAnnotationLayers({
      chordNames: true,
      romanNumerals: false,
      bassLine: false,
      nonChordHints: false,
      melodyContour: false,
    })
    setShowTheoryPanel(true)
  }

  lineClickActionRef.current = (rowStartIndex, rowNumber) => {
    // Any point in a horizontal system starts playback at its first measure.
    const label = displayMeasureNumber(rowStartIndex)
    const triggerDescription = `點擊第 ${rowNumber} 行（從第 ${label} 小節開始）`
    setSelectedTheoryMeasureIndex(rowStartIndex)
    lastTheoryPlaybackMeasureRef.current = rowStartIndex
    setMeasureSeekStatus(`已識別第 ${rowNumber} 行，將從第 ${label} 小節開始播放…`)
    try {
      console.info('[ScoreRoom] Line click mapping:', {
        clickedLineNumber: rowNumber,
        rowStartSourceIndex: rowStartIndex,
        rowStartPrintedNumber: label,
      })
      playFromMeasure(rowStartIndex, triggerDescription)
    } catch (error) {
      console.error('[ScoreRoom] Failed to play from clicked line:', error)
      setMeasureSeekStatus(`已識別第 ${rowNumber} 行，但定位播放失敗。`)
      setPlaybackError(error instanceof Error ? error.message : '譜面行點擊定位時發生未知錯誤。')
    }
  }

  return (
    <section
      lang="zh-TW"
      style={{
        width: '100%',
        fontFamily: '\"Noto Sans TC\", \"Microsoft JhengHei\", \"PingFang TC\", \"Heiti TC\", sans-serif',
        minHeight: 260,
        padding: 20,
        border: '1px solid #303229',
        borderRadius: 12,
        background: '#f8f7f0',
        color: '#24251f',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
          paddingBottom: 12,
          borderBottom: '1px solid #deddd4',
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#55564d',
          }}
        >
          樂譜閱讀
        </span>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={() => isPlaying ? pausePlayback() : void startPlayback()}
            disabled={loading || playbackDuration <= 0}
            aria-label={isPlaying ? '暫停播放' : '播放並同步高亮'}
            style={{
              ...buttonStyle,
              minWidth: 88,
              padding: '0 13px',
              fontSize: 12,
              fontWeight: 700,
              background: isPlaying ? '#26374a' : '#d9b779',
              color: isPlaying ? '#f2dfb8' : '#171a1f',
              borderColor: isPlaying ? '#8a7047' : '#c8a96c',
              opacity: loading || playbackDuration <= 0 ? 0.5 : 1,
            }}
          >
            {isPlaying ? 'Ⅱ 暫停' : '▶ 播放'}
          </button>
          <button
            type="button"
            onClick={resetPlayback}
            disabled={loading || playbackDuration <= 0}
            aria-label="重置播放進度"
            style={{ ...buttonStyle, minWidth: 62, fontSize: 12 }}
          >
            ↺ 重播
          </button>
          <select
            aria-label="播放速度"
            value={playbackSpeed}
            onChange={(event) => changePlaybackSpeed(Number(event.target.value))}
            disabled={loading}
            style={{
              ...buttonStyle,
              minWidth: 76,
              padding: '0 7px',
              fontSize: 12,
              background: '#fffdf7',
            }}
          >
            <option value={0.5}>0.5×</option>
            <option value={0.75}>0.75×</option>
            <option value={1}>1.0×</option>
            <option value={1.25}>1.25×</option>
            <option value={1.5}>1.5×</option>
            {![0.5, 0.75, 1, 1.25, 1.5].some(speed => Math.abs(speed - playbackSpeed) < 0.001) && (
              <option value={playbackSpeed}>{playbackSpeed.toFixed(2)}×（練習）</option>
            )}
          </select>
          <span
            aria-live="polite"
            style={{
              minWidth: 84,
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
              color: '#777361',
            }}
          >
            {formatPlaybackTime(playbackSeconds)} / {formatPlaybackTime(playbackDuration)}
          </span>
          <button
            type="button"
            onClick={toggleTheoryPanelVisibility}
            disabled={loading}
            aria-pressed={showTheoryPanel}
            aria-label={showTheoryPanel ? '關閉樂理分析' : '開啟樂理分析'}
            style={{
              ...buttonStyle,
              minWidth: 92,
              fontSize: 12,
              fontWeight: 700,
              background: showTheoryPanel ? '#26374a' : '#fffaf0',
              color: showTheoryPanel ? '#f1d99b' : '#3a3326',
              borderColor: showTheoryPanel ? '#8a7047' : '#d1b579',
            }}
          >
            ♫ 樂理分析
          </button>
          {scoreType !== 'piano' && (
          <button
            type="button"
            onClick={() => setShowChordDiagrams((current) => !current)}
            disabled={loading}
            aria-pressed={showChordDiagrams}
            style={{
              ...buttonStyle,
              minWidth: 92,
              fontSize: 12,
              background: showChordDiagrams ? '#e8edde' : '#ffffff',
              borderColor: showChordDiagrams ? '#7b8e69' : '#d5d4c9',
            }}
          >
            {showChordDiagrams ? '隱藏指法圖' : '顯示指法圖'}
          </button>
          )}

          <button
            type="button"
            onClick={() => changeZoom(-0.1)}
            disabled={zoom <= 50 || loading}
            aria-label="縮小樂譜"
            style={buttonStyle}
          >
            −
          </button>

          <button
            type="button"
            onClick={resetZoom}
            disabled={loading}
            style={{
              ...buttonStyle,
              minWidth: 62,
              fontSize: 12,
            }}
          >
            <span>{zoom}</span>
            <span>%</span>
          </button>

          <button
            type="button"
            onClick={() => changeZoom(0.1)}
            disabled={zoom >= 200 || loading}
            aria-label="放大樂譜"
            style={buttonStyle}
          >
            +
          </button>
        </div>
      </div>

      {shouldShowGuitarSetup && !loading && !error && (
        <section
          aria-label="吉他變調夾與調弦資訊"
          title="資訊來自 MusicXML 的 capo 與 staff-tuning 標記；顯示未標註時代表原始檔案未提供資料，不會自動假設標準調弦或沒有變調夾。"
          style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 18px',
            margin: '0 0 11px', padding: '9px 12px', borderRadius: 10,
            border: '1px solid #e3d8bf', background: '#fffaf0', color: '#494338',
            fontSize: 11, lineHeight: 1.6, boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
            <span aria-hidden="true" style={{ fontSize: 15, color: '#a7803e' }}>♬</span>
            <strong style={{ fontSize: 11.5, color: '#59472b', whiteSpace: 'nowrap' }}>吉他設定</strong>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ color: '#81745f' }}>變調夾</span>
            <strong style={{ color: '#302a20', fontVariantNumeric: 'tabular-nums' }}>{guitarCapoLabel}</strong>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ color: '#81745f', whiteSpace: 'nowrap' }}>調弦（6弦 → 1弦）</span>
            <strong style={{ color: '#302a20', fontWeight: 650, overflowWrap: 'anywhere' }}>{guitarTuningLabel}</strong>
          </div>
          {guitarSetupInfo?.hasTuningChanges && (
            <span style={{ color: '#986d2d' }}>注意：原譜包含多組調弦標記，以上顯示首組</span>
          )}
          {guitarSetupInfo?.partName && (
            <span style={{ color: '#999080', fontSize: 10, marginLeft: 'auto' }}>來源：{guitarSetupInfo.partName}</span>
          )}
        </section>
      )}

      <div
        aria-label="鍵盤快捷鍵"
        title="輸入框和進度條聚焦時優先使用它們自己的鍵盤操作"
        style={{ margin: '-5px 0 12px', color: '#858172', fontSize: 10.5, lineHeight: 1.5 }}
      >
        快捷鍵：空格 播放/暫停 · ←/→ 後退/前進 5 秒 · Home 回到開頭 · Esc 關閉面板
      </div>

      {playbackError && !loading && (
        <p role="status" style={{ margin: '0 0 12px', color: '#8a5d21', fontSize: 12 }}>
          {playbackError}
        </p>
      )}

      {playbackDuration > 0 && !loading && (
        <p style={{ margin: '0 0 12px', color: (scoreType === 'piano' ? pianoSampleStatus.includes('失敗') : guitarSampleStatus.includes('失敗')) ? '#9b6731' : '#8b8777', fontSize: 11 }}>
          {scoreType === 'piano'
            ? `Salamander Grand Piano · ${pianoSampleStatus} · 音源：Alexander Holm，CC BY 3.0`
            : `鋼弦民謠吉他採樣音色 · ${guitarSampleStatus} · 音源：FluidR3_GM SoundFont，CC BY 3.0`}
          {' · 香檳金音符高亮 · 點擊譜面整行從該行開頭播放'}
          {isCountingIn ? ' · 預備拍中…' : ''}
          {measureSeekStatus ? ` · ${measureSeekStatus}` : ''}
        </p>
      )}

      {loading && (
        <p style={{ padding: 20, textAlign: 'center' }}>
          正在載入樂譜…
        </p>
      )}

      {error && (
        <p role="alert" style={{ padding: 20, color: '#a52d2d' }}>
          {error}
        </p>
      )}

      <div
        ref={containerRef}
        onClick={handleScoreClick}
        onMouseMove={handleScoreMeasureHover}
        onMouseLeave={clearScoreMeasureHover}
        title="滑鼠懸浮可高亮目前小節；點擊譜面橫行，從該行第一個小節開始播放"
        style={{
          width: '100%',
          minWidth: 320,
          position: 'relative',
          visibility: loading || error ? 'hidden' : 'visible',
          cursor: playbackDuration > 0 ? 'pointer' : 'default',
        }}
      />

      {currentTheoryHud && !loading && !error && !theoryLoading && !theoryError && (
        <>
          <style>{`
            @media (max-width: 760px) {
              .score-room-current-theory-hud { left: 12px !important; right: 12px !important; top: 12px !important; width: auto !important; max-height: 34vh; overflow-y: auto; }
              .score-room-current-theory-hud[data-compact="true"] { right: auto !important; width: max-content !important; max-width: calc(100vw - 24px) !important; max-height: none !important; overflow: visible !important; }
            }
          `}</style>
          {currentTheoryHudExpanded ? (
            <aside
              className="score-room-current-theory-hud"
              data-compact="false"
              lang="zh-TW"
              aria-label="目前小節樂理摘要"
              style={{
                position: 'fixed', zIndex: 1190, left: 16, top: 82,
                width: 'min(310px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 220px)',
                boxSizing: 'border-box', overflowY: 'auto',
                padding: '12px 13px 13px', borderRadius: 14,
                border: '1px solid rgba(217,183,121,.42)',
                background: 'rgba(17,24,33,.97)', color: '#e9edf2',
                boxShadow: '0 14px 38px rgba(0,0,0,.3)',
                backdropFilter: 'blur(15px)', WebkitBackdropFilter: 'blur(15px)',
                fontFamily: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingBottom: 9, marginBottom: 9, borderBottom: '1px solid rgba(255,255,255,.1)' }}>
                <div>
                  <div style={{ color: '#9ba8b5', fontSize: 10, letterSpacing: '.04em' }}>當前播放 / 選取小節</div>
                  <div style={{ color: '#f1d99b', fontSize: 16, fontWeight: 850, marginTop: 3 }}>第 {currentTheoryHud.measure.printedNumber} 小節</div>
                </div>
                <button type="button" onClick={() => setCurrentTheoryHudExpanded(false)} aria-label="收起小節摘要" title="收起摘要；收起後僅顯示和弦名稱與級數" style={{ border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, height: 30, padding: '0 9px', background: 'rgba(255,255,255,.05)', color: '#e9edf2', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>收起 ▴</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr)', gap: '8px 9px', alignItems: 'start' }}>
                <div style={{ color: '#9ba8b5', fontSize: 10.5, paddingTop: 2 }}>和弦名稱</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#f1d99b', fontSize: 17, fontWeight: 850, overflowWrap: 'anywhere', lineHeight: 1.3 }}>{currentTheoryHud.activeChord?.symbol ?? '未確定'}</div>
                  {currentTheoryHud.chordSequence && currentTheoryHud.chordSequence !== currentTheoryHud.activeChord?.symbol && <div style={{ color: '#a8b3be', fontSize: 9.5, lineHeight: 1.45, marginTop: 3 }}>本小節和弦：{currentTheoryHud.chordSequence}</div>}
                </div>
                <div style={{ color: '#9ba8b5', fontSize: 10.5, paddingTop: 2 }}>構成音</div>
                <div style={{ color: '#e7edf2', fontSize: 11.5, fontWeight: 650, lineHeight: 1.55, overflowWrap: 'anywhere' }}>{currentTheoryHud.octaveNotes.length ? currentTheoryHud.octaveNotes.join(' · ') : (currentTheoryHud.activeChord?.toneNames?.join(' · ') || '音高資訊不足')}</div>
                <div style={{ color: '#9ba8b5', fontSize: 10.5, paddingTop: 2 }}>低音</div>
                <div style={{ color: '#e7edf2', fontSize: 11.5, fontWeight: 650 }}>{currentTheoryHud.bassName}</div>
                <div style={{ color: '#9ba8b5', fontSize: 10.5, paddingTop: 2 }}>羅馬數字</div>
                <div style={{ color: '#d8c18e', fontSize: 11.5, fontWeight: 700 }}>{currentTheoryHud.roman}</div>
                <div style={{ color: '#9ba8b5', fontSize: 10.5, paddingTop: 2 }}>非和弦候選</div>
                <div style={{ color: currentTheoryHud.nonChordText === '暫無候選音' ? '#8f9ca8' : '#e5c489', fontSize: 10.5, lineHeight: 1.55, overflowWrap: 'anywhere' }}>{currentTheoryHud.nonChordText}</div>
              </div>
            </aside>
          ) : (
            <button
              className="score-room-current-theory-hud"
              data-compact="true"
              type="button"
              onClick={() => setCurrentTheoryHudExpanded(true)}
              aria-label="展開目前小節摘要"
              title={`第 ${currentTheoryHud.measure.printedNumber} 小節 · ${currentTheoryHud.activeChord?.symbol ?? '未確定'} · ${currentTheoryHud.roman}。點擊展開完整摘要`}
              style={{
                position: 'fixed', zIndex: 1190, left: 16, top: 82,
                display: 'inline-flex', flexDirection: 'column', alignItems: 'stretch', gap: 4,
                width: 'max-content', maxWidth: 'min(420px, calc(100vw - 32px))', minHeight: 42,
                boxSizing: 'border-box', padding: '6px 9px', borderRadius: 9,
                border: '1px solid rgba(217,183,121,.42)',
                background: 'rgba(17,24,33,.97)', color: '#e9edf2',
                boxShadow: '0 5px 16px rgba(0,0,0,.22)',
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                fontFamily: '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <strong style={{ color: '#f1d99b', fontSize: 12, lineHeight: 1.2, overflowWrap: 'anywhere' }}>{currentTheoryHud.activeChord?.symbol ?? '未確定'}</strong>
                <span style={{ color: '#d8c18e', fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap' }}>{currentTheoryHud.roman}</span>
                <span aria-hidden="true" style={{ marginLeft: 'auto', color: '#9ba8b5', fontSize: 10, lineHeight: 1 }}>⌄</span>
              </span>
              <span style={{ color: '#d4dbe3', fontSize: 10, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                構成音：{currentTheoryHud.octaveNotes.length ? currentTheoryHud.octaveNotes.join(' · ') : (currentTheoryHud.activeChord?.toneNames?.join(' · ') || '音高資訊不足')}　·　低音：{currentTheoryHud.bassName}
              </span>
            </button>
          )}
        </>
      )}

      {showTheoryPanel && !loading && !error && (
        <aside
          lang="zh-TW"
          role="dialog"
          aria-label="樂理分析面板"
          aria-modal="false"
          style={{
            position: 'fixed', zIndex: 1200, right: 16, top: 82,
            bottom: playbackControlsVisible ? 180 : 20,
            width: 'min(430px, calc(100vw - 24px))',
            minHeight: 180, boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
            overflow: 'hidden', borderRadius: 16,
            border: '1px solid rgba(217,183,121,.38)',
            background: 'rgba(17,24,33,.98)', color: '#e9edf2',
            boxShadow: '0 18px 48px rgba(0,0,0,.38)',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
            fontFamily: '\"Noto Sans TC\", \"Microsoft JhengHei\", \"PingFang TC\", \"Heiti TC\", sans-serif',
          }}
        >
          <div style={{ flexShrink: 0, padding: '14px 16px 11px', borderBottom: '1px solid rgba(255,255,255,.09)', background: 'rgba(17,24,33,.99)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#f1d99b' }}>樂理分析</div>
                <div style={{ marginTop: 4, fontSize: 11, color: '#aab4c0', lineHeight: 1.5 }}>基於 MusicXML 的音高、節奏、調號與和弦標記分析</div>
              </div>
              <button type="button" onClick={() => setShowTheoryPanel(false)} aria-label="隱藏樂理分析面板" title="隱藏面板；可透過頂部「樂理分析」按鈕重新開啟" style={{ border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, height: 30, padding: '0 9px', background: 'rgba(255,255,255,.05)', color: '#e9edf2', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>隱藏面板</button>
            </div>
            {theoryAnalysis && !theoryLoading && !theoryError && (
              <div aria-label="樂理分析模式" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', marginTop: 11 }}>
                {([
                  ['chordNames', '和弦/級數'],
                  ['bassLine', '低音與走向'],
                  ['nonChordHints', '非和弦音候選'],
                  ['melodyContour', '旋律輪廓'],
                ] as Array<[keyof ScoreAnnotationLayers, string]>).map(([key, label]) => (
                  <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: scoreAnnotationLayers[key] ? '#f1d99b' : '#d1d8df', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input
                      type="radio"
                      name="score-annotation-mode"
                      checked={scoreAnnotationLayers[key]}
                      onChange={() => setScoreAnnotationLayers({
                        chordNames: key === 'chordNames',
                        romanNumerals: false,
                        bassLine: key === 'bassLine',
                        nonChordHints: key === 'nonChordHints',
                        melodyContour: key === 'melodyContour',
                      })}
                      style={{ accentColor: '#d9b779', margin: 0 }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div style={{ padding: 14, overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {theoryLoading && <div style={{ padding: '22px 6px', textAlign: 'center', fontSize: 12, color: '#d9c69f' }}>正在讀取音符並分析和聲…</div>}
            {theoryError && !theoryLoading && (
              <div role="alert" style={{ padding: 12, borderRadius: 10, background: 'rgba(170,72,62,.14)', border: '1px solid rgba(231,126,110,.28)', color: '#f2b9ad', fontSize: 12, lineHeight: 1.65 }}>
                {theoryError}<div style={{ marginTop: 7, color: '#c8cfd7' }}>目前支援普通未壓縮的 .musicxml 檔案；.mxl 壓縮檔案與 score-timewise 暫未納入這一版分析。</div>
              </div>
            )}
            {theoryAnalysis && !theoryLoading && !theoryError && (() => {
              const analysisView = displayTheoryAnalysis ?? theoryAnalysis
              const selected = analysisView.measures.find(item => item.sourceIndex === selectedTheoryMeasureIndex) ?? analysisView.measures[0]
              const orderedMeasures = analysisView.measures
              const bassRoute = orderedMeasures.filter(item => item.bassMidi !== null)
              const chordSequence = orderedMeasures.filter(item => item.primaryChord)
              const voiceLeadingPairs = chordSequence.slice(0, -1).map((measure, index) => ({ from: measure, to: chordSequence[index + 1] }))
                .filter(pair => pair.to.sourceIndex > pair.from.sourceIndex)
                .sort((a, b) => Math.min(Math.abs(a.from.sourceIndex - selected.sourceIndex), Math.abs(a.to.sourceIndex - selected.sourceIndex)) - Math.min(Math.abs(b.from.sourceIndex - selected.sourceIndex), Math.abs(b.to.sourceIndex - selected.sourceIndex)))
                .slice(0, 8)
                .sort((a, b) => a.from.sourceIndex - b.from.sourceIndex)
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
                      ].map(([label, value]) => (
                        <div key={label} style={{ padding: '8px 9px', borderRadius: 9, background: 'rgba(0,0,0,.18)' }}>
                          <div style={{ fontSize: 10, color: '#98a4b0' }}>{label}</div>
                          <div style={{ marginTop: 4, fontSize: 13, fontWeight: 750, color: '#f1d99b' }}>{value}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 8, color: '#929eaa', fontSize: 10, lineHeight: 1.5 }}>{analysisView.keySource}</div>
                  </div>

                  <section>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: '#e9edf2' }}>和弦進行</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <div style={{ fontSize: 10, color: '#87929e' }}>逐小節對照；點擊卡片定位</div>
                        {Object.keys(theoryChordCorrections).length > 0 && <button type="button" onClick={() => { if (typeof window === 'undefined' || window.confirm('清除目前樂譜的所有人工和弦校正？')) setTheoryChordCorrections({}) }} style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 6, background: 'rgba(255,255,255,.04)', color: '#c0c8d1', padding: '4px 6px', fontSize: 9.5, cursor: 'pointer' }}>清除人工校正</button>}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6 }}>
                      {orderedMeasures.map(measure => {
                        const chord = measure.primaryChord
                        const active = measure.sourceIndex === selected.sourceIndex
                        const activeMode = (Object.keys(scoreAnnotationLayers) as Array<keyof ScoreAnnotationLayers>)
                          .find(key => scoreAnnotationLayers[key]) ?? null
                        const nextBassMeasure = orderedMeasures.find(item => item.sourceIndex > measure.sourceIndex && item.bassMidi !== null)
                        const bassArrow = !nextBassMeasure || measure.bassMidi === null
                          ? ''
                          : nextBassMeasure.bassMidi! > measure.bassMidi ? ' ↗'
                          : nextBassMeasure.bassMidi! < measure.bassMidi ? ' ↘' : ' →'
                        const hints = Array.isArray(measure.nonChordHints) ? measure.nonChordHints : []
                        let primaryText = chord?.symbol ?? '—'
                        let secondaryText = chord?.roman ?? '未確定'
                        if (activeMode === 'romanNumerals') {
                          primaryText = chord?.roman ?? '級數未確定'
                          secondaryText = chord?.symbol ?? '和弦未確定'
                        } else if (activeMode === 'bassLine') {
                          primaryText = `${measure.bassName || '低音未確定'}${bassArrow}`
                          secondaryText = nextBassMeasure ? `下一小節：${nextBassMeasure.bassName}` : '後續低音不足'
                        } else if (activeMode === 'nonChordHints') {
                          primaryText = hints.length
                            ? hints.slice(0, 2).map(hint => `${hint.noteName}·${hint.label}`).join('、')
                            : '無候選'
                          secondaryText = hints.length ? `${hints.length} 個非和弦音候選` : '本小節沒有候選提示'
                        } else if (activeMode === 'melodyContour') {
                          primaryText = measure.melodyContour || '旋律資訊不足'
                          secondaryText = measure.melodyTrend || measure.melodyRange || '走向資訊不足'
                        }
                        const modeCaption = activeMode === 'chordNames' ? '和弦 / 級數'
                          : activeMode === 'romanNumerals' ? '級數'
                          : activeMode === 'bassLine' ? '低音'
                          : activeMode === 'nonChordHints' ? '非和弦音'
                          : activeMode === 'melodyContour' ? '旋律輪廓'
                          : '和弦 / 級數'
                        return (
                          <button
                            key={`${measure.sourceIndex}-${measure.printedNumber}`}
                            type="button"
                            onClick={() => selectTheoryMeasureAndSeek(measure.sourceIndex, measure.printedNumber, '樂理分析卡片')}
                            title={`選擇第 ${measure.printedNumber} 小節：${primaryText}`}
                            aria-pressed={active}
                            style={{ minWidth: 0, minHeight: 82, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5, textAlign: 'left', padding: '8px 9px', borderRadius: 9, border: `1px solid ${active ? 'rgba(217,183,121,.78)' : 'rgba(255,255,255,.09)'}`, background: active ? 'rgba(217,183,121,.16)' : 'rgba(255,255,255,.035)', color: '#e9edf2', cursor: 'pointer' }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, width: '100%', fontSize: 9.5, color: '#9ba6b1' }}>
                              <span>小節 {measure.printedNumber}</span><span style={{ color: '#c0a66e' }}>{modeCaption}</span>
                            </span>
                            <strong style={{ display: 'block', width: '100%', fontSize: activeMode === 'melodyContour' ? 10.5 : 13, lineHeight: 1.4, color: primaryText && primaryText !== '—' && primaryText !== '無候選' ? '#f1d99b' : '#a7b0ba', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{primaryText}</strong>
                            <span style={{ display: 'block', width: '100%', fontSize: 9.5, lineHeight: 1.4, color: '#aab4bf', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{secondaryText}</span>
                            {(!activeMode || activeMode === 'chordNames' || activeMode === 'romanNumerals') && chord && <span style={{ fontSize: 9, lineHeight: 1.35, color: '#9ba6b1', overflowWrap: 'anywhere' }}>{theoryHarmonicFunction(chord, measure.keyTonicPc, measure.keyMode)}</span>}
                          </button>
                        )
                      })}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 10, lineHeight: 1.55, color: '#8995a2' }}>和弦自動推斷會綜合持續音、短時間內的音符、低音與調性，並降低裝飾音影響。只有音高證據充分且候選差距較大時才標為「較明確」；出現「其他可能」或「推測」時，說明不同和弦解釋仍有競爭，不建議當作定論。</div>
                  </section>

                  <section style={{ borderTop: '1px solid rgba(255,255,255,.09)', paddingTop: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: '#e9edf2' }}>第 {selected.printedNumber} 小節</div>
                      <button type="button" onClick={() => playFromMeasure(selected.sourceIndex, `樂理分析：第 ${selected.printedNumber} 小節`)} style={{ border: '1px solid rgba(217,183,121,.44)', borderRadius: 8, background: 'rgba(217,183,121,.12)', color: '#f1d99b', padding: '6px 9px', fontSize: 10.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>▶ 從這裡播放</button>
                    </div>
                    {selected.chords.length > 0 ? selected.chords.map((chord, index) => (
                      <div key={`${chord.onsetQuarter}-${chord.symbol}-${index}`} style={{ padding: 11, marginBottom: 7, borderRadius: 10, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.075)' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                          <strong style={{ color: '#f1d99b', fontSize: 16 }}>{chord.symbol}</strong>
                          <span style={{ color: '#b2bdc8', fontSize: 11 }}>{chord.roman} · {chord.confidence}</span>
                        </div>
                        <div style={{ color: '#cdd5dd', fontSize: 11, marginTop: 7, lineHeight: 1.55 }}>{chord.qualityLabel} · 起始位置 {Number(chord.onsetQuarter.toFixed(2))} 四分音符</div>
                        <button type="button" onClick={() => locateTheoryChord(selected.sourceIndex, chord.onsetQuarter, chord.symbol)} style={{ marginTop: 7, border: '1px solid rgba(217,183,121,.3)', borderRadius: 7, background: 'rgba(217,183,121,.08)', color: '#e8d4ad', padding: '5px 8px', fontSize: 10, cursor: 'pointer' }}>定位到此和弦</button>
                        <div style={{ marginTop: 4, fontSize: 10, color: chord.evidenceSource === '原譜和弦標記' ? '#a9c7bb' : chord.evidenceSource === '人工校正' ? '#f1d99b' : '#94a0ac', lineHeight: 1.5 }}>來源：{chord.evidenceSource ?? (chord.confidence === '樂譜標記' ? '原譜和弦標記' : '音符推斷')}</div>
                        {chord.toneNames.length > 0 && <div style={{ marginTop: 5, fontSize: 11, color: '#e5e9ed' }}>構成音：{chord.toneNames.join(' · ')}</div>}
                        {chord.alternatives && chord.alternatives.length > 0 && <div style={{ marginTop: 5, fontSize: 10.5, color: '#e3bd78', lineHeight: 1.5 }}>接近的候選：{chord.alternatives.join(' / ')}。這些是匹配分接近的備選解釋，不是統計概率。</div>}
                        {chord.evidenceSummary && chord.evidenceSummary.length > 0 && <div style={{ marginTop: 6, padding: '7px 8px', borderRadius: 7, background: 'rgba(0,0,0,.15)', color: '#b7c2cc', fontSize: 10, lineHeight: 1.6 }}><div style={{ fontWeight: 700, color: '#d7c69f', marginBottom: 3 }}>判斷依據</div>{chord.evidenceSummary.map((reason, reasonIndex) => <div key={`${reason}-${reasonIndex}`}>• {reason}</div>)}{typeof chord.matchingScore === 'number' && <div style={{ marginTop: 3, color: '#8795a2' }}>匹配分數 {chord.matchingScore.toFixed(2)}（啟發式評分，不是概率）</div>}</div>}
                        <div style={{ marginTop: 4, fontSize: 10.5, color: '#94a0ac', lineHeight: 1.5 }}>分析視窗音符：{chord.actualNotes.join('、') || '—'} · 低音參考：{chord.bassName}</div>
                        {chord.candidateDetails && chord.candidateDetails.length > 1 && chord.evidenceSource !== '原譜和弦標記' && (
                          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 9, fontSize: 10, color: '#aeb8c3' }}>
                            <span>人工校正（只影響此曲本地顯示，可隨時恢復自動結果）</span>
                            <select
                              aria-label={`第 ${selected.printedNumber} 小節和弦人工校正`}
                              value={theoryChordCorrections[theoryCorrectionId(selected.sourceIndex, chord.onsetQuarter)] ?? ''}
                              onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                                const id = theoryCorrectionId(selected.sourceIndex, chord.onsetQuarter)
                                const chosen = event.currentTarget.value
                                setTheoryChordCorrections(previous => {
                                  const next = { ...previous }
                                  if (!chosen) delete next[id]
                                  else next[id] = chosen
                                  return next
                                })
                              }}
                              style={{ width: '100%', minWidth: 0, borderRadius: 7, border: '1px solid rgba(217,183,121,.25)', background: '#111923', color: '#e7edf2', padding: '7px 8px', fontSize: 10.5 }}
                            >
                              <option value="">自動分析（{chord.automaticSymbol ?? chord.symbol}）</option>
                              {chord.candidateDetails.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.symbol} · {candidate.qualityLabel} · 匹配分數 {candidate.score.toFixed(2)}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    )) : (
                      <div style={{ padding: 11, borderRadius: 10, background: 'rgba(255,255,255,.035)', color: '#aeb8c3', fontSize: 11, lineHeight: 1.7 }}>
                        目前小節沒有檢測到足夠穩定的三音或七和弦組合。這不代表樂譜有誤，可能是經過音、分解和弦或長音與旋律交替造成的。
                      </div>
                    )}
                    <div style={{ padding: 11, marginTop: 8, borderRadius: 10, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(217,183,121,.16)' }}>
                      <div style={{ fontSize: 10, color: '#93a0ad' }}>和聲功能（按目前調性解釋）</div>
                      <div style={{ color: '#f1d99b', fontSize: 12, fontWeight: 700, marginTop: 4 }}>{selected.harmonicFunction}</div>
                      {selected.keySource.includes('估計') && <div style={{ color: '#aeb8c3', fontSize: 10, lineHeight: 1.5, marginTop: 4 }}>目前調性為自動估計，因此級數與功能也應視為候選。</div>}
                      <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 9 }}>終止式／和聲連接提示</div>
                      <div style={{ color: '#d8e0e8', fontSize: 11, lineHeight: 1.6, marginTop: 4 }}>{selected.cadenceHint ?? '相鄰小節之間未檢測到常見終止式模式。終止式必須結合樂句結尾、節拍重音和聲部解決來判斷，未顯示並不代表沒有終止感。'}</div>
                    </div>
                    {selected.nonChordHints.length > 0 && (
                      <div style={{ padding: 11, marginTop: 8, borderRadius: 10, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.08)' }}>
                        <div style={{ fontSize: 10, color: '#93a0ad', marginBottom: 7 }}>疑似旋律非和弦音（僅作學習提示）</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                          {selected.nonChordHints.map((hint, index) => (
                            <div key={`${hint.noteName}-${hint.onsetQuarter}-${index}`} style={{ borderLeft: '2px solid rgba(217,183,121,.55)', paddingLeft: 8 }}>
                              <div style={{ color: '#f1d99b', fontSize: 11, fontWeight: 700 }}>{hint.noteName} · {hint.label} · 第 {Number(hint.onsetQuarter.toFixed(2))} 拍位</div>
                              <div style={{ color: '#aeb8c3', fontSize: 10, lineHeight: 1.55, marginTop: 3 }}>{hint.explanation}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ color: '#8794a0', fontSize: 10, lineHeight: 1.5, marginTop: 7 }}>自動提示只識別部分級進型經過音／鄰音候選；裝飾音、掛留、預備音與複雜聲部不能僅憑此規則定性。</div>
                      </div>
                    )}
                    <div style={{ padding: 11, marginTop: 8, borderRadius: 10, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.07)' }}>
                      <div style={{ fontSize: 10, color: '#93a0ad' }}>旋律輪廓</div>
                      <div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 4 }}>{selected.melodyContour}</div>
                      <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 9 }}>首尾走向</div>
                      <div style={{ color: '#cbd5df', fontSize: 11, marginTop: 4 }}>{selected.melodyTrend}</div>
                      <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 9 }}>旋律音域</div>
                      <div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 4 }}>{selected.melodyRange}</div>
                      {selected.melodyIntervals.length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 10, color: '#93a0ad', marginBottom: 6 }}>旋律音程（按上聲部主旋律線估計）</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {selected.melodyIntervals.slice(0, 8).map((interval, index) => (
                              <div key={`${interval.fromName}-${interval.toName}-${index}`} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '5px 7px', borderRadius: 7, background: 'rgba(255,255,255,.035)' }}>
                                <span style={{ fontSize: 10.5, color: '#cbd5df' }}>{interval.fromName} → {interval.toName}</span>
                                <span style={{ fontSize: 10, color: interval.direction === '重復音' ? '#aab4bf' : '#f1d99b', textAlign: 'right' }}>{interval.label}</span>
                              </div>
                            ))}
                          </div>
                          {selected.melodyIntervals.length > 8 && <div style={{ fontSize: 10, color: '#8794a0', marginTop: 5 }}>本小節共有 {selected.melodyIntervals.length} 個音程轉換，以上顯示前 8 個。</div>}
                        </div>
                      )}
                      <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 11 }}>節奏型概覽（上聲部主旋律）</div>
                      <div style={{ color: '#cbd5df', fontSize: 10.5, lineHeight: 1.65, marginTop: 4 }}>{selected.rhythmSummary}</div>
                      {selected.rhythmPattern.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
                          {selected.rhythmPattern.map((pattern, index) => <span key={`${pattern}-${index}`} style={{ border: '1px solid rgba(217,183,121,.17)', borderRadius: 6, padding: '4px 6px', background: 'rgba(217,183,121,.07)', color: '#dfd1b1', fontSize: 9.5 }}>{pattern}</span>)}
                        </div>
                      )}
                      <div style={{ fontSize: 10, color: '#93a0ad', marginTop: 10 }}>本小節低音</div>
                      <div style={{ color: '#e3e8ee', fontSize: 11.5, fontWeight: 650, marginTop: 4 }}>{selected.bassName}</div>
                    </div>
                  </section>

                  <section style={{ borderTop: '1px solid rgba(255,255,255,.09)', paddingTop: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>低音走向</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {bassRoute.map((measure, index) => {
                        const next = bassRoute[index + 1]
                        const trend = !next || measure.bassMidi === null || next.bassMidi === null ? '' : next.bassMidi > measure.bassMidi ? '↗' : next.bassMidi < measure.bassMidi ? '↘' : '→'
                        return <span key={measure.sourceIndex} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 7, padding: '5px 7px', background: 'rgba(255,255,255,.045)', color: '#cbd3dc', fontSize: 10.5 }}> {measure.printedNumber}: {measure.bassName} {trend} </span>
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
                        const shared = toChord.toneNames.filter(name => {
                          const pc = theoryPitchClassFromName(name)
                          return pc !== null && fromPcs.has(pc)
                        })
                        const rootDeltaRaw = (toChord.rootPc - fromChord.rootPc + 12) % 12
                        const rootDelta = rootDeltaRaw > 6 ? rootDeltaRaw - 12 : rootDeltaRaw
                        const rootMotion = rootDelta === 0 ? '根音保持' : rootDelta > 0 ? `根音上行 ${rootDelta} 半音` : `根音下行 ${Math.abs(rootDelta)} 半音`
                        const bassDelta = from.bassMidi !== null && to.bassMidi !== null ? to.bassMidi - from.bassMidi : null
                        const bassMotion = bassDelta === null ? '' : bassDelta === 0 ? '低音保持' : bassDelta > 0 ? `低音上行 ${bassDelta} 半音` : `低音下行 ${Math.abs(bassDelta)} 半音`
                        return <button key={`${from.sourceIndex}-${to.sourceIndex}`} type="button" onClick={() => selectTheoryMeasureAndSeek(from.sourceIndex, from.printedNumber, '和弦連接卡片')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4, textAlign: 'left', padding: '9px 10px', borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.035)', color: '#d6dde5', cursor: 'pointer' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><strong style={{ color: '#f1d99b', fontSize: 11 }}>小節 {from.printedNumber}: {fromChord.symbol} → {to.printedNumber}: {toChord.symbol}</strong><span style={{ color: '#a6b1bc', fontSize: 10 }}>{rootMotion}</span></div>
                          <div style={{ color: '#c4ced8', fontSize: 10.5 }}>共同音：{shared.length ? [...new Set(shared)].join(' · ') : '未發現同名共同音'}{bassMotion ? `  ·  ${bassMotion}` : ''}</div>
                        </button>
                      })}
                    </div>
                  </section>

                  <div style={{ padding: 9, borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', color: '#85919d', fontSize: 10, lineHeight: 1.6 }}>
                    分析範圍：調性、和弦構成音、羅馬數字級數、和聲功能、常見終止式候選、部分旋律非和弦音、旋律音程/輪廓/音域、上聲部基礎節奏型及低音線。旋律分析按 MusicXML 的上聲部/上譜表近似提取；復調、跨聲部旋律、複雜切分與連音組可能需要人工復核。採用可解釋的規則分析，不呼叫雲端 AI；請把結果當作學習線索，而非取代樂譜原始標註或教師判斷的定論。
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
          onClick={toggleTheoryPanelVisibility}
          aria-label="顯示樂理分析面板"
          aria-expanded={false}
          title="顯示樂理分析面板"
          style={{
            position: 'fixed', zIndex: 1001, right: 0, top: '43%',
            transform: 'translateY(-50%)', writingMode: 'vertical-rl', textOrientation: 'mixed',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            minHeight: 116, padding: '13px 9px', borderRadius: '12px 0 0 12px',
            border: '1px solid rgba(227, 201, 151, 0.5)', borderRight: 0,
            background: 'rgba(17, 24, 33, 0.96)', color: '#f1d99b',
            fontSize: 12, fontWeight: 750, cursor: 'pointer', letterSpacing: 0.4,
            boxShadow: '0 8px 25px rgba(0,0,0,.28)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          ♫ 樂理分析
        </button>
      )}

      {!loading && !error && playbackDuration > 0 && (
        <>
        {playbackControlsVisible ? (
        <div
          role="toolbar"
          aria-label="懸浮播放控制"
          style={{
            position: 'fixed',
            zIndex: 1000,
            left: '50%',
            bottom: 'max(16px, env(safe-area-inset-bottom))',
            transform: 'translateX(-50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 8,
            padding: '10px 12px 9px',
            width: 'min(720px, calc(100vw - 24px))',
            boxSizing: 'border-box',
            border: '1px solid rgba(227, 201, 151, 0.34)',
            borderRadius: 18,
            background: 'rgba(17, 24, 33, 0.95)',
            color: '#f3ead7',
            boxShadow: '0 12px 36px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.05)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, letterSpacing: 1.2, fontWeight: 750, color: '#b9a783' }}>
              SCORE PLAYBACK
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={toggleAutoFollowPlayback}
                aria-pressed={autoFollowPlayback}
                title="播放時自動滾動，讓目前音符始終跟隨在視野內"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: 30, padding: '0 10px', borderRadius: 10,
                  border: `1px solid ${autoFollowPlayback ? 'rgba(217,183,121,.68)' : 'rgba(216,225,235,.18)'}`,
                  background: autoFollowPlayback ? 'rgba(217,183,121,.22)' : 'rgba(255,255,255,.045)',
                  color: autoFollowPlayback ? '#f1d99b' : '#dfe5ec',
                  fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                ◎ 自動跟隨：{autoFollowPlayback ? '開' : '關'}
              </button>
              <button
                type="button"
                onClick={() => setPlaybackControlsVisible(false)}
                aria-label="隱藏懸浮播放控制"
                title="隱藏懸浮播放控制"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: 30, padding: '0 10px', borderRadius: 10,
                  border: '1px solid rgba(216,225,235,.14)', background: 'rgba(255,255,255,.035)',
                  color: '#c8cfd7', fontSize: 11, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                ⌄ 隱藏控制
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => skipPlaybackSeconds(-5)}
              disabled={playbackDuration <= 0}
              aria-label="後退 5 秒"
              title="後退 5 秒"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                height: 38, minWidth: 66, padding: '0 10px', borderRadius: 12,
                border: '1px solid rgba(216,225,235,.16)', background: 'rgba(255,255,255,.055)',
                color: '#e7edf5', fontSize: 12, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              ↶ 5 秒
            </button>
            <button
              type="button"
              onClick={() => (isPlaying || isPreparingPlayback) ? pausePlayback() : void startPlayback()}
              aria-label={isPreparingPlayback ? '取消載入音源' : isPlaying ? '暫停播放' : '播放'}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                height: 38, minWidth: 78, padding: '0 14px', borderRadius: 12,
                border: '1px solid rgba(241,217,155,.55)',
                background: isPlaying ? '#2a3541' : 'linear-gradient(135deg,#f1d99b,#c49a53)',
                color: isPlaying ? '#f8e8c4' : '#1a1e23', fontSize: 12, fontWeight: 750,
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {isPreparingPlayback ? '… 載入音源' : isPlaying ? 'Ⅱ 暫停' : '▶ 播放'}
            </button>
            <button
              type="button"
              onClick={() => skipPlaybackSeconds(5)}
              disabled={playbackDuration <= 0}
              aria-label="前進 5 秒"
              title="前進 5 秒"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                height: 38, minWidth: 66, padding: '0 10px', borderRadius: 12,
                border: '1px solid rgba(216,225,235,.16)', background: 'rgba(255,255,255,.055)',
                color: '#e7edf5', fontSize: 12, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              5 秒 ↷
            </button>
            <button
              type="button"
              onClick={scrollToCurrentPlaybackPosition}
              aria-label="定位到目前播放位置"
              title="定位到目前播放位置"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                gap: 6, height: 38, padding: '0 12px', borderRadius: 12,
                border: '1px solid rgba(216,225,235,.16)', background: 'rgba(255,255,255,.055)',
                color: '#e7edf5', fontSize: 12, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              ◎ 定位目前
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={toggleMetronome}
              aria-pressed={metronomeEnabled}
              title="節拍器按樂譜速度和拍號同步；播放速度調整時會隨之變化"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30, padding: '0 10px', borderRadius: 10, border: `1px solid ${metronomeEnabled ? 'rgba(217,183,121,.68)' : 'rgba(216,225,235,.18)'}`, background: metronomeEnabled ? 'rgba(217,183,121,.22)' : 'rgba(255,255,255,.045)', color: metronomeEnabled ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              ♩ 節拍器：{metronomeEnabled ? '開' : '關'}
            </button>
            <label
              title="按拍號分母定義的每拍進行細分。4/4 中：主拍、八分音符細分、十六分音符細分；其他拍號會依照其拍單位相應細分。"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '0 9px', borderRadius: 10, border: '1px solid rgba(216,225,235,.16)', background: 'rgba(255,255,255,.035)', color: '#dfe5ec', fontSize: 11, whiteSpace: 'nowrap' }}
            >
              拍內細分
              <select
                aria-label="節拍器拍內細分"
                value={metronomeSubdivision}
                onChange={event => changeMetronomeSubdivision(Number(event.currentTarget.value))}
                style={{ border: 0, outline: 0, background: 'transparent', color: '#f1d99b', font: 'inherit', cursor: 'pointer' }}
              >
                <option value={1} style={{ color: '#17202a' }}>主拍</option>
                <option value={2} style={{ color: '#17202a' }}>二等分</option>
                <option value={4} style={{ color: '#17202a' }}>四等分</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 30, padding: '0 9px', borderRadius: 10, border: '1px solid rgba(216,225,235,.16)', background: 'rgba(255,255,255,.035)', color: '#dfe5ec', fontSize: 11, whiteSpace: 'nowrap' }}>
              預備拍
              <select
                aria-label="播放前預備拍小節數"
                value={countInBars}
                onChange={event => changeCountInBars(Number(event.currentTarget.value))}
                style={{ border: 0, outline: 0, background: 'transparent', color: '#f1d99b', font: 'inherit', cursor: 'pointer' }}
              >
                <option value={0} style={{ color: '#17202a' }}>關閉</option>
                <option value={1} style={{ color: '#17202a' }}>1 小節</option>
                <option value={2} style={{ color: '#17202a' }}>2 小節</option>
              </select>
            </label>
            <span style={{ fontSize: 10, color: '#9ea7b2', whiteSpace: 'nowrap' }} title="節拍器從 MusicXML 的拍號和播放速度讀取節奏">
              {metronomeMeterLabel} · {metronomeSubdivision === 1 ? '主拍' : metronomeSubdivision === 2 ? '二等分' : '四等分'} · 跟隨樂譜速度
            </span>
            {isCountingIn && <span role="status" style={{ fontSize: 11, fontWeight: 750, color: '#f1d99b', whiteSpace: 'nowrap' }}>預備拍中…</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flexWrap: 'wrap' }}>
            {scoreType === 'piano' && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const next = !scoreDynamicsEnabledRef.current
                    scoreDynamicsEnabledRef.current = next
                    setScoreDynamicsEnabled(next)
                  }}
                  aria-pressed={scoreDynamicsEnabled}
                  title="按 MusicXML 的 p、mf、f、漸強/漸弱標記調節音量；關閉後統一力度播放"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30, padding: '0 10px', borderRadius: 10, border: `1px solid ${scoreDynamicsEnabled ? 'rgba(217,183,121,.62)' : 'rgba(216,225,235,.18)'}`, background: scoreDynamicsEnabled ? 'rgba(217,183,121,.18)' : 'rgba(255,255,255,.045)', color: scoreDynamicsEnabled ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  力度：{scoreDynamicsEnabled ? '按樂譜' : '統一'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !scorePedalEnabledRef.current
                    scorePedalEnabledRef.current = next
                    setScorePedalEnabled(next)
                  }}
                  aria-pressed={scorePedalEnabled}
                  title="根據 MusicXML 的延音踏板標記延長音符釋放；關閉後影響後續發聲，已發出的採樣音會自然衰減"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30, padding: '0 10px', borderRadius: 10, border: `1px solid ${scorePedalEnabled ? 'rgba(217,183,121,.62)' : 'rgba(216,225,235,.18)'}`, background: scorePedalEnabled ? 'rgba(217,183,121,.18)' : 'rgba(255,255,255,.045)', color: scorePedalEnabled ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  踏板：{scorePedalEnabled ? '開' : '關'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setABPoint('A')}
              disabled={playbackDuration <= 0}
              aria-label="設定 A 循環點"
              title="把目前播放位置設為循環起點 A"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 30, padding: '0 10px', borderRadius: 10,
                border: '1px solid rgba(216,225,235,.18)',
                background: loopA !== null ? 'rgba(217,183,121,.18)' : 'rgba(255,255,255,.045)',
                color: loopA !== null ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 650, cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {loopA !== null ? `A · ${formatPlaybackTime(loopA)}` : '設 A 點'}
            </button>
            <button
              type="button"
              onClick={() => setABPoint('B')}
              disabled={playbackDuration <= 0 || loopA === null}
              aria-label="設定 B 循環點"
              title="把目前播放位置設為循環終點 B（必須晚於 A）"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 30, padding: '0 10px', borderRadius: 10,
                border: '1px solid rgba(216,225,235,.18)',
                background: loopB !== null ? 'rgba(217,183,121,.18)' : 'rgba(255,255,255,.045)',
                color: loopB !== null ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 650,
                cursor: playbackDuration <= 0 || loopA === null ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                opacity: loopA === null ? 0.48 : 1,
              }}
            >
              {loopB !== null ? `B · ${formatPlaybackTime(loopB)}` : '設 B 點'}
            </button>
            <button
              type="button"
              onClick={() => setABLoopEnabled(!abLoopEnabled)}
              disabled={loopA === null || loopB === null || loopB <= loopA}
              aria-pressed={abLoopEnabled}
              title="在 A 與 B 兩點之間循環播放"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 30, padding: '0 10px', borderRadius: 10,
                border: `1px solid ${abLoopEnabled ? 'rgba(217,183,121,.62)' : 'rgba(216,225,235,.18)'}`,
                background: abLoopEnabled ? 'rgba(217,183,121,.22)' : 'rgba(255,255,255,.045)',
                color: abLoopEnabled ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 700,
                cursor: loopA === null || loopB === null || loopB <= loopA ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap', opacity: loopA === null || loopB === null || loopB <= loopA ? 0.48 : 1,
              }}
            >
              {abLoopEnabled ? 'A↔B 循環中' : 'A↔B 循環'}
            </button>
            <button
              type="button"
              onClick={clearABLoop}
              disabled={loopA === null && loopB === null}
              title="清除 A/B 循環點"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 30, padding: '0 9px', borderRadius: 10,
                border: '1px solid rgba(216,225,235,.12)', background: 'rgba(255,255,255,.025)',
                color: '#b9c2cc', fontSize: 11, cursor: loopA === null && loopB === null ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap', opacity: loopA === null && loopB === null ? 0.45 : 1,
              }}
            >
              清除
            </button>
            {loopA !== null && loopB !== null && (
              <span style={{ fontSize: 10, color: abLoopEnabled ? '#f1d99b' : '#aeb7c1', whiteSpace: 'nowrap' }}>
                {loopB > loopA ? `${formatPlaybackTime(loopB - loopA)} 區間` : 'B 點需晚於 A 點'}
              </span>
            )}
            {scoreType === 'piano' && (
              <span title={performanceControlStatus} style={{ flexBasis: '100%', textAlign: 'center', fontSize: 9.5, color: '#8f9ba7', lineHeight: 1.35 }}>
                {performanceControlStatus}
              </span>
            )}
          </div>
          <div
            aria-label="漸進提速練習設定"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flexWrap: 'wrap', width: '100%', paddingTop: 2 }}
          >
            <button
              type="button"
              onClick={toggleTempoTrainer}
              disabled={playbackDuration <= 0 || (tempoTrainerEnabled ? false : loopA === null || loopB === null || loopB <= loopA)}
              aria-pressed={tempoTrainerEnabled}
              title="使用 A/B 循環進行漸進提速練習：以目前速度開始，每達到指定輪數就提升速度，直到目標速度"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 30, padding: '0 10px', borderRadius: 10,
                border: `1px solid ${tempoTrainerEnabled ? 'rgba(217,183,121,.7)' : 'rgba(216,225,235,.18)'}`,
                background: tempoTrainerEnabled ? 'rgba(217,183,121,.22)' : 'rgba(255,255,255,.045)',
                color: tempoTrainerEnabled ? '#f1d99b' : '#dfe5ec', fontSize: 11, fontWeight: 700,
                cursor: playbackDuration <= 0 || (!tempoTrainerEnabled && (loopA === null || loopB === null || loopB <= loopA)) ? 'not-allowed' : 'pointer',
                opacity: playbackDuration <= 0 || (!tempoTrainerEnabled && (loopA === null || loopB === null || loopB <= loopA)) ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {tempoTrainerEnabled ? '✓ 漸進提速：開' : '↗ 漸進提速'}
            </button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 30, padding: '0 8px', borderRadius: 10, border: '1px solid rgba(216,225,235,.14)', background: 'rgba(255,255,255,.03)', color: '#dfe5ec', fontSize: 10.5, whiteSpace: 'nowrap' }}>
              目標
              <select aria-label="漸進提速目標速度" value={tempoTrainerTargetSpeed} onChange={event => updateTempoTrainerTarget(Number(event.currentTarget.value))} disabled={tempoTrainerEnabled} style={{ border: 0, outline: 0, background: 'transparent', color: '#f1d99b', font: 'inherit', cursor: 'pointer' }}>
                <option value={1} style={{ color: '#17202a' }}>1.00×</option>
                <option value={1.1} style={{ color: '#17202a' }}>1.10×</option>
                <option value={1.25} style={{ color: '#17202a' }}>1.25×</option>
                <option value={1.5} style={{ color: '#17202a' }}>1.50×</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 30, padding: '0 8px', borderRadius: 10, border: '1px solid rgba(216,225,235,.14)', background: 'rgba(255,255,255,.03)', color: '#dfe5ec', fontSize: 10.5, whiteSpace: 'nowrap' }}>
              每檔
              <select aria-label="每次提速幅度" value={tempoTrainerStep} onChange={event => updateTempoTrainerStep(Number(event.currentTarget.value))} disabled={tempoTrainerEnabled} style={{ border: 0, outline: 0, background: 'transparent', color: '#f1d99b', font: 'inherit', cursor: 'pointer' }}>
                <option value={0.03} style={{ color: '#17202a' }}>+3%</option>
                <option value={0.05} style={{ color: '#17202a' }}>+5%</option>
                <option value={0.1} style={{ color: '#17202a' }}>+10%</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 30, padding: '0 8px', borderRadius: 10, border: '1px solid rgba(216,225,235,.14)', background: 'rgba(255,255,255,.03)', color: '#dfe5ec', fontSize: 10.5, whiteSpace: 'nowrap' }}>
              每檔循環
              <select aria-label="每檔重復輪數" value={tempoTrainerRepeats} onChange={event => updateTempoTrainerRepeats(Number(event.currentTarget.value))} disabled={tempoTrainerEnabled} style={{ border: 0, outline: 0, background: 'transparent', color: '#f1d99b', font: 'inherit', cursor: 'pointer' }}>
                <option value={1} style={{ color: '#17202a' }}>1 輪</option>
                <option value={2} style={{ color: '#17202a' }}>2 輪</option>
                <option value={3} style={{ color: '#17202a' }}>3 輪</option>
              </select>
            </label>
            {tempoTrainerStatus && <span role="status" style={{ flexBasis: '100%', textAlign: 'center', color: tempoTrainerEnabled ? '#f1d99b' : '#9ea7b2', fontSize: 10.5, lineHeight: 1.45 }}>
              {tempoTrainerStatus}{tempoTrainerEnabled ? ` · 目前 ${playbackSpeed.toFixed(2)}× · 本檔第 ${tempoTrainerLoopCount + 1}/${tempoTrainerRepeats} 輪` : ''}
            </span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%' }}>
            <span style={{ minWidth: 38, textAlign: 'right', fontSize: 11, color: '#e8d7b8', fontVariantNumeric: 'tabular-nums' }}>
              {formatPlaybackTime(progressPreview ?? playbackSeconds)}
            </span>
            <input
              type="range"
              aria-label="播放進度"
              min={0}
              max={Math.max(0.1, playbackDuration)}
              step={0.1}
              value={Math.min(playbackDuration, Math.max(0, progressPreview ?? playbackSeconds))}
              onFocus={() => { progressWasPlayingRef.current = playbackRunningRef.current }}
              onPointerDown={() => { progressWasPlayingRef.current = playbackRunningRef.current }}
              onChange={event => setProgressPreview(Number(event.currentTarget.value))}
              onPointerUp={event => commitProgressSeek(Number(event.currentTarget.value))}
              onKeyUp={event => commitProgressSeek(Number(event.currentTarget.value))}
              style={{
                flex: 1, minWidth: 72, width: '100%', height: 18, margin: 0,
                accentColor: '#d9b779', cursor: 'pointer',
              }}
            />
            <span style={{ minWidth: 38, textAlign: 'left', fontSize: 11, color: '#c8baa0', fontVariantNumeric: 'tabular-nums' }}>
              {formatPlaybackTime(playbackDuration)}
            </span>
          </div>
        </div>
        ) : (
          <div
            role="group"
            aria-label="迷你播放進度"
            style={{
              position: 'fixed', zIndex: 1000,
              left: '50%', bottom: 'max(10px, env(safe-area-inset-bottom))',
              transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 7,
              width: 'min(500px, calc(100vw - 28px))', boxSizing: 'border-box',
              minHeight: 34, padding: '4px 6px 4px 9px',
              border: '1px solid rgba(227, 201, 151, 0.38)', borderRadius: 18,
              background: 'rgba(17, 24, 33, 0.94)', color: '#f3ead7',
              boxShadow: '0 6px 20px rgba(0,0,0,.25)',
              backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            <span style={{ minWidth: 37, textAlign: 'right', fontSize: 10, color: '#e8d7b8', fontVariantNumeric: 'tabular-nums' }}>
              {formatPlaybackTime(progressPreview ?? playbackSeconds)}
            </span>
            <input
              type="range"
              aria-label="迷你播放進度，點擊或拖動可定位；使用右側三角展開控制欄"
              min={0}
              max={Math.max(0.1, playbackDuration)}
              step={0.1}
              value={Math.min(playbackDuration, Math.max(0, progressPreview ?? playbackSeconds))}
              onFocus={() => { progressWasPlayingRef.current = playbackRunningRef.current }}
              onPointerDown={() => { progressWasPlayingRef.current = playbackRunningRef.current }}
              onChange={event => setProgressPreview(Number(event.currentTarget.value))}
              onPointerUp={event => commitProgressSeek(Number(event.currentTarget.value))}
              onPointerCancel={() => setProgressPreview(null)}
              onKeyUp={event => commitProgressSeek(Number(event.currentTarget.value))}
              title={`${formatPlaybackTime(playbackSeconds)} / ${formatPlaybackTime(playbackDuration)}。點擊或拖動調整進度；右側三角展開控制`}
              style={{ flex: 1, minWidth: 40, width: '100%', height: 18, margin: 0, accentColor: '#d9b779', cursor: 'pointer' }}
            />
            <button
              type="button"
              onClick={() => skipPlaybackSeconds(-3)}
              disabled={playbackDuration <= 0}
              aria-label="後退 3 秒"
              title="後退 3 秒"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flex: '0 0 29px', width: 29, height: 27, padding: 0,
                border: '1px solid rgba(227, 201, 151, 0.25)', borderRadius: 8,
                background: 'rgba(255,255,255,.045)', color: '#e7edf5',
                fontSize: 10, fontWeight: 750, cursor: playbackDuration > 0 ? 'pointer' : 'default',
                opacity: playbackDuration > 0 ? 1 : .45,
              }}
            >
              −3s
            </button>
            <button
              type="button"
              onClick={() => {
                if (playbackRunningRef.current || playbackStartInProgressRef.current) pausePlayback()
                else void startPlayback(true)
              }}
              disabled={playbackDuration <= 0}
              aria-label={isPlaying || isPreparingPlayback ? '暫停播放' : '開始播放'}
              title={isPlaying || isPreparingPlayback ? '暫停播放' : '開始播放'}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flex: '0 0 29px', width: 29, height: 27, padding: 0,
                border: '1px solid rgba(227, 201, 151, 0.38)', borderRadius: 8,
                background: 'rgba(217,183,121,.16)', color: '#f1d99b',
                fontSize: 11, fontWeight: 800, cursor: playbackDuration > 0 ? 'pointer' : 'default',
                opacity: playbackDuration > 0 ? 1 : .45,
              }}
            >
              {isPlaying || isPreparingPlayback ? 'Ⅱ' : '▶'}
            </button>
            <button
              type="button"
              onClick={() => skipPlaybackSeconds(3)}
              disabled={playbackDuration <= 0}
              aria-label="前進 3 秒"
              title="前進 3 秒"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flex: '0 0 29px', width: 29, height: 27, padding: 0,
                border: '1px solid rgba(227, 201, 151, 0.25)', borderRadius: 8,
                background: 'rgba(255,255,255,.045)', color: '#e7edf5',
                fontSize: 10, fontWeight: 750, cursor: playbackDuration > 0 ? 'pointer' : 'default',
                opacity: playbackDuration > 0 ? 1 : .45,
              }}
            >
              +3s
            </button>
            <button
              type="button"
              onClick={toggleAutoFollowPlayback}
              aria-pressed={autoFollowPlayback}
              aria-label={`自動跟隨${autoFollowPlayback ? '開啟' : '關閉'}`}
              title={`自動跟隨：${autoFollowPlayback ? '開' : '關'}；點擊切換`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flex: '0 0 28px', width: 28, height: 27, padding: 0,
                border: `1px solid ${autoFollowPlayback ? 'rgba(217,183,121,.68)' : 'rgba(216,225,235,.18)'}`,
                borderRadius: 8,
                background: autoFollowPlayback ? 'rgba(217,183,121,.22)' : 'rgba(255,255,255,.045)',
                color: autoFollowPlayback ? '#f1d99b' : '#9aa6b2',
                fontSize: 12, fontWeight: 800, cursor: 'pointer',
              }}
            >
              ◎
            </button>
            <button
              type="button"
              onClick={() => setPlaybackControlsVisible(true)}
              aria-label="展開播放控制欄"
              aria-expanded={false}
              title="展開播放控制欄"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flex: '0 0 26px', width: 26, height: 26, padding: 0,
                border: '1px solid rgba(227, 201, 151, 0.42)', borderRadius: '50%',
                background: 'rgba(217,183,121,.16)', color: '#f1d99b',
                fontSize: 12, fontWeight: 800, cursor: 'pointer',
              }}
            >
              ▴
            </button>
          </div>
        )}

        </>
      )}
    </section>
  )
}
