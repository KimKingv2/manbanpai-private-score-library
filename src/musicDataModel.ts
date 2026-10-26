/**
 * ScoreRoom canonical MusicXML data model.
 *
 * The renderer (OSMD) remains the authority for engraving and source-note identity,
 * while this module is the shared, normalized source for theory, dynamics, pedal,
 * tempo and meter readers. All positions are zero-based source-measure indices and
 * quarter-note offsets inside each measure.
 */
export type MusicMode = 'major' | 'minor'
export type CanonicalPerformanceMark = {
  kind: 'dynamic' | 'pedal' | 'wedge'
  measureIndex: number
  positionQuarter: number
  order: number
  value?: number
  action?: 'on' | 'off' | 'change'
  wedgeType?: 'crescendo' | 'diminuendo' | 'stop'
  number?: string
}
export type CanonicalTimeSignature = {
  beats: number
  beatType: number
  beatGroups: number[]
}
export type CanonicalHarmony = {
  onsetQuarter: number
  symbol: string
  rootPc: number
  quality: string
  rootName: string
  bassPc?: number
  bassName?: string
  inversion?: number
}
export type CanonicalNote = {
  id: string
  partIndex: number
  partId: string
  measureIndex: number
  printedNumber: string
  noteIndex: number
  onsetQuarter: number
  durationQuarter: number
  midi: number | null
  pitchClass: number | null
  step: string | null
  alter: number
  octave: number | null
  name: string | null
  staff: string
  voice: string
  isRest: boolean
  isGrace: boolean
  isChordMember: boolean
  tieStart: boolean
  tieStop: boolean
  noteType: string
  dots: number
  accidental: string | null
  instrumentId: string | null
}
export type CanonicalRhythmEvent = {
  onsetQuarter: number
  durationQuarter: number
  isRest: boolean
  isGrace: boolean
  voice: string
  noteType: string
  dots: number
}
export type CanonicalMeasure = {
  sourceIndex: number
  printedNumber: string
  notes: CanonicalNote[]
  rhythmEvents: CanonicalRhythmEvent[]
  explicitHarmonies: CanonicalHarmony[]
  fifths: number | null
  mode: MusicMode
  meter: CanonicalTimeSignature
  measureDurationQuarter: number
  divisionsSeen: number[]
}
export type CanonicalPart = {
  index: number
  id: string
  name: string
  measureCount: number
}
export type CanonicalMusicXmlData = {
  schemaVersion: '1.0'
  title: string
  composer: string
  partNames: string[]
  parts: CanonicalPart[]
  measures: CanonicalMeasure[]
  performanceMarks: CanonicalPerformanceMark[]
  tempoMarks: Array<{ measureIndex: number; positionQuarter: number; bpm: number; beatUnit: string | null; dotted: boolean }>
  explicitKey: { fifths: number; mode: MusicMode } | null
  firstMeter: CanonicalTimeSignature | null
  firstTempo: number | null
  pitchClassWeights: number[]
  noteCount: number
  diagnostics: string[]
}
export type CanonicalValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  measures: number
  notes: number
}

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const DYNAMIC_LEVELS: Record<string, number> = {
  pppp: 22, ppp: 28, pp: 36, p: 46, mp: 59, mf: 78,
  f: 94, ff: 107, fff: 117, ffff: 123,
  sf: 96, sfz: 104, sffz: 112, rf: 92, rfz: 100, fp: 88, pf: 64,
}
const HARMONY_KINDS: Record<string, { quality: string; suffix: string }> = {
  major: { quality: 'maj', suffix: '' },
  minor: { quality: 'min', suffix: 'm' },
  augmented: { quality: 'aug', suffix: 'aug' },
  diminished: { quality: 'dim', suffix: 'dim' },
  'dominant-seventh': { quality: '7', suffix: '7' },
  'major-seventh': { quality: 'maj7', suffix: 'maj7' },
  'minor-seventh': { quality: 'min7', suffix: 'm7' },
  'diminished-seventh': { quality: 'dim7', suffix: 'dim7' },
  'half-diminished': { quality: 'm7b5', suffix: 'm7♭5' },
  'minor-major': { quality: 'minMaj7', suffix: 'm(maj7)' },
  'major-sixth': { quality: '6', suffix: '6' },
  'minor-sixth': { quality: 'm6', suffix: 'm6' },
  'suspended-second': { quality: 'sus2', suffix: 'sus2' },
  'suspended-fourth': { quality: 'sus4', suffix: 'sus4' },
  'dominant-ninth': { quality: '9', suffix: '9' },
  'major-ninth': { quality: 'maj9', suffix: 'maj9' },
  'minor-ninth': { quality: 'min9', suffix: 'm9' },
}

function children(element: Element | null | undefined, name: string): Element[] {
  if (!element) return []
  return Array.from(element.children).filter(child => child.localName === name)
}
function firstChild(element: Element | null | undefined, name: string): Element | null {
  return children(element, name)[0] ?? null
}
function textOf(element: Element | null | undefined, fallback = ''): string {
  return (element?.textContent ?? fallback).trim()
}
function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
function safeMeter(beats: number, beatType: number, groups: number[] = []): CanonicalTimeSignature {
  const safeBeats = Number.isFinite(beats) && beats > 0 ? beats : 4
  const safeBeatType = Number.isFinite(beatType) && beatType > 0 ? beatType : 4
  return { beats: safeBeats, beatType: safeBeatType, beatGroups: groups.length ? groups : [safeBeats] }
}
function meterText(meter: CanonicalTimeSignature): string {
  return `${meter.beats}/${meter.beatType}`
}
function pitchName(step: string, alter: number, octave?: number | null): string {
  let suffix = ''
  if (Math.abs(alter - Math.round(alter)) > 0.001) suffix = `(${alter > 0 ? '+' : ''}${alter})`
  else if (alter === 2) suffix = '𝄪'
  else if (alter === -2) suffix = '𝄫'
  else if (alter > 0) suffix = '♯'.repeat(Math.min(4, Math.round(alter)))
  else if (alter < 0) suffix = '♭'.repeat(Math.min(4, Math.abs(Math.round(alter))))
  return `${step}${suffix}${octave === undefined || octave === null ? '' : octave}`
}
function parseMeter(timeNode: Element): CanonicalTimeSignature | null {
  const beatNodes = children(timeNode, 'beats')
  const groups = beatNodes.map(node => textOf(node).split('+').reduce((sum, chunk) => {
    const value = Number(chunk.trim())
    return sum + (Number.isFinite(value) && value > 0 ? value : 0)
  }, 0)).filter(value => value > 0)
  const beats = groups.reduce((sum, value) => sum + value, 0)
  const beatType = finiteNumber(textOf(firstChild(timeNode, 'beat-type')), 0)
  if (beats <= 0 || beatType <= 0) return null
  return safeMeter(beats, beatType, groups)
}
function parseKey(keyNode: Element): { fifths: number; mode: MusicMode } | null {
  const fifthsRaw = Number(textOf(firstChild(keyNode, 'fifths'), 'NaN'))
  if (!Number.isFinite(fifthsRaw)) return null
  const mode = textOf(firstChild(keyNode, 'mode'), 'major').toLowerCase() === 'minor' ? 'minor' : 'major'
  return { fifths: Math.max(-7, Math.min(7, Math.round(fifthsRaw))), mode }
}
function parseHarmony(node: Element, cursorQuarter: number, divisions: number): CanonicalHarmony | null {
  const rootNode = firstChild(node, 'root')
  const step = textOf(firstChild(rootNode, 'root-step')).toUpperCase()
  if (!(step in STEP_PC)) return null
  const alterRaw = Number(textOf(firstChild(rootNode, 'root-alter'), '0'))
  const alter = Number.isFinite(alterRaw) ? alterRaw : 0
  const rootPc = ((STEP_PC[step] + alter) % 12 + 12) % 12
  const rootName = pitchName(step, alter)
  const kindNode = firstChild(node, 'kind')
  const kind = textOf(kindNode).toLowerCase()
  const mapping = HARMONY_KINDS[kind]
  const customText = kindNode?.getAttribute('text')?.trim()
  const bassNode = firstChild(node, 'bass')
  const bassStep = textOf(firstChild(bassNode, 'bass-step')).toUpperCase()
  const bassAlterRaw = Number(textOf(firstChild(bassNode, 'bass-alter'), '0'))
  const bassAlter = Number.isFinite(bassAlterRaw) ? bassAlterRaw : 0
  let bassPc: number | undefined = bassStep in STEP_PC ? ((STEP_PC[bassStep] + bassAlter) % 12 + 12) % 12 : undefined
  let bassName: string | undefined = bassStep in STEP_PC ? pitchName(bassStep, bassAlter) : undefined
  const inversion = Number(textOf(firstChild(node, 'inversion'), '0'))
  // MusicXML permits inversion numbers without an explicit slash-bass. Recover a
  // conservative bass hint for common triads/seventh chords so the model does not
  // regress the reader's previous explicit-harmony handling.
  const inversionIntervals: Record<string, number[]> = {
    maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
    sus2: [0, 2, 7], sus4: [0, 5, 7], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
    '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
    minMaj7: [0, 3, 7, 11], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9],
    '9': [0, 2, 4, 7, 10], maj9: [0, 2, 4, 7, 11], min9: [0, 2, 3, 7, 10],
  }
  if (bassPc === undefined && mapping && Number.isInteger(inversion) && inversion > 0) {
    const intervals = inversionIntervals[mapping.quality]
    if (intervals && inversion < intervals.length) {
      bassPc = (rootPc + intervals[inversion]) % 12
      const pitchToSpelling = (pc: number): string => {
        const choices: Array<{ step: string; alter: number; pc: number }> = []
        for (const [candidateStep, basePc] of Object.entries(STEP_PC)) {
          for (let candidateAlter = -2; candidateAlter <= 2; candidateAlter++) {
            if (((basePc + candidateAlter) % 12 + 12) % 12 === pc) choices.push({ step: candidateStep, alter: candidateAlter, pc })
          }
        }
        const preferred = choices.find(candidate => candidate.step === step && candidate.alter === 0) ?? choices.find(candidate => candidate.alter === 0) ?? choices[0]
        return preferred ? pitchName(preferred.step, preferred.alter) : rootName
      }
      bassName = pitchToSpelling(bassPc)
    }
  }
  const offsetDivisions = Number(textOf(firstChild(node, 'offset'), '0'))
  const offset = Number.isFinite(offsetDivisions) ? offsetDivisions / Math.max(1, divisions) : 0
  const base = customText || `${rootName}${mapping?.suffix ?? (kind ? ` (${kind.replace(/-/g, ' ')})` : '')}`
  const symbol = !customText && bassName && bassPc !== undefined && bassPc !== rootPc
    ? `${base}/${bassName}` : base
  return {
    onsetQuarter: Math.max(0, cursorQuarter + offset),
    symbol,
    rootPc,
    quality: mapping?.quality ?? 'unknown',
    rootName,
    ...(bassPc === undefined ? {} : { bassPc }),
    ...(bassName === undefined ? {} : { bassName }),
    // Preserve inversion metadata for later theory interpretation.
    ...(Number.isInteger(inversion) && inversion >= 0 ? { inversion } : {}),
  }
}
function dynamicLevel(node: Element): number | null {
  const mark = node.children[0]
  if (!mark) return null
  const name = mark.localName.toLowerCase()
  if (DYNAMIC_LEVELS[name] !== undefined) return DYNAMIC_LEVELS[name]
  if (name === 'other-dynamics') return DYNAMIC_LEVELS[textOf(mark).toLowerCase()] ?? null
  return null
}
function tieFlags(note: Element): { tieStart: boolean; tieStop: boolean } {
  const all: Element[] = [...children(note, 'tie')]
  const notations = firstChild(note, 'notations')
  all.push(...children(notations, 'tied'))
  return {
    tieStart: all.some(element => element.getAttribute('type') === 'start'),
    tieStop: all.some(element => element.getAttribute('type') === 'stop'),
  }
}

let lastXmlText = ''
let lastModel: CanonicalMusicXmlData | null = null

/** Parse MusicXML once into a stable source-measure, note, rhythm and performance model. */
export function getCanonicalMusicXmlData(xmlText: string): CanonicalMusicXmlData {
  if (lastModel && lastXmlText === xmlText) return lastModel
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (xml.getElementsByTagName('parsererror').length > 0) throw new Error('MusicXML XML 解析失败。')
  const root = xml.documentElement
  if (!root || root.localName !== 'score-partwise') throw new Error('当前统一数据模型只支持未压缩的 score-partwise MusicXML；暂不支持 .mxl 或 score-timewise。')
  const partNodes = children(root, 'part')
  if (!partNodes.length) throw new Error('MusicXML 中没有 <part> 声部数据。')
  const scorePartNodes = children(firstChild(root, 'part-list'), 'score-part')
  const namesById = new Map(scorePartNodes.map(partNode => [partNode.getAttribute('id') ?? '', textOf(firstChild(partNode, 'part-name'), '未命名声部')]))
  const parts: CanonicalPart[] = partNodes.map((part, index) => ({
    index,
    id: part.getAttribute('id') ?? `part-${index + 1}`,
    name: namesById.get(part.getAttribute('id') ?? '') ?? '未命名声部',
    measureCount: children(part, 'measure').length,
  }))
  const measuresByIndex = new Map<number, CanonicalMeasure>()
  const performanceMarks: CanonicalPerformanceMark[] = []
  const tempoMarks: CanonicalMusicXmlData['tempoMarks'] = []
  const pitchClassWeights = new Array<number>(12).fill(0)
  const diagnostics: string[] = []
  let explicitKey: CanonicalMusicXmlData['explicitKey'] = null
  let firstMeter: CanonicalTimeSignature | null = null
  let firstTempo: number | null = null
  let performanceMarkOrder = 0
  let totalNotes = 0

  for (const [partIndex, partNode] of partNodes.entries()) {
    const partId = partNode.getAttribute('id') ?? parts[partIndex].id
    let divisions = 1
    let currentKey: { fifths: number; mode: MusicMode } | null = null
    let currentMeter = safeMeter(4, 4)
    for (const [measureIndex, measureNode] of children(partNode, 'measure').entries()) {
      let target = measuresByIndex.get(measureIndex)
      if (!target) {
        target = {
          sourceIndex: measureIndex,
          printedNumber: measureNode.getAttribute('number') || String(measureIndex + 1),
          notes: [],
          rhythmEvents: [],
          explicitHarmonies: [],
          fifths: null,
          mode: 'major',
          meter: safeMeter(4, 4),
          measureDurationQuarter: 0,
          divisionsSeen: [],
        }
        measuresByIndex.set(measureIndex, target)
      } else if (partIndex === 0) {
        target.printedNumber = measureNode.getAttribute('number') || target.printedNumber
      }

      let cursorQuarter = 0
      let maxQuarter = 0
      let lastNoteOnsetQuarter = 0
      let noteIndex = 0
      for (const node of Array.from(measureNode.children)) {
        if (node.localName === 'attributes') {
          const divisionsRaw = Number(textOf(firstChild(node, 'divisions'), 'NaN'))
          if (Number.isFinite(divisionsRaw) && divisionsRaw > 0) divisions = divisionsRaw
          if (!target.divisionsSeen.includes(divisions)) target.divisionsSeen.push(divisions)
          const keyNode = firstChild(node, 'key')
          if (keyNode) {
            const nextKey = parseKey(keyNode)
            if (nextKey) {
              currentKey = nextKey
              if (!explicitKey) explicitKey = nextKey
            }
          }
          const timeNode = firstChild(node, 'time')
          if (timeNode) {
            const nextMeter = parseMeter(timeNode)
            if (nextMeter) {
              currentMeter = nextMeter
              if (!firstMeter) firstMeter = nextMeter
            }
          }
          if (partIndex === 0) {
            target.fifths = currentKey?.fifths ?? target.fifths
            target.mode = currentKey?.mode ?? target.mode
            target.meter = { ...currentMeter, beatGroups: [...currentMeter.beatGroups] }
          }
          continue
        }
        if (node.localName === 'backup' || node.localName === 'forward') {
          const durationDivisions = Number(textOf(firstChild(node, 'duration'), '0'))
          if (Number.isFinite(durationDivisions) && durationDivisions > 0) {
            const durationQuarter = durationDivisions / Math.max(1, divisions)
            cursorQuarter = node.localName === 'backup' ? Math.max(0, cursorQuarter - durationQuarter) : cursorQuarter + durationQuarter
            maxQuarter = Math.max(maxQuarter, cursorQuarter)
          }
          continue
        }
        if (node.localName === 'direction') {
          const offsetDivisions = Number(textOf(firstChild(node, 'offset'), '0'))
          const positionQuarter = Math.max(0, cursorQuarter + (Number.isFinite(offsetDivisions) ? offsetDivisions / Math.max(1, divisions) : 0))
          const sound = firstChild(node, 'sound')
          const soundTempo = Number(sound?.getAttribute('tempo'))
          // Tempo can be engraved in any part, while performance marks are read only
          // from the first part to avoid double-applying shared dynamics/pedal symbols.
          if (Number.isFinite(soundTempo) && soundTempo > 0) {
            tempoMarks.push({ measureIndex, positionQuarter, bpm: soundTempo, beatUnit: null, dotted: false })
            if (firstTempo === null) firstTempo = soundTempo
          }
          const metronome = Array.from(node.getElementsByTagName('*')).find(element => element.localName === 'metronome')
          if (metronome) {
            const perMinute = Number(textOf(firstChild(metronome, 'per-minute'), 'NaN'))
            const beatUnit = textOf(firstChild(metronome, 'beat-unit')) || null
            const dotted = children(metronome, 'beat-unit-dot').length > 0
            if (Number.isFinite(perMinute) && perMinute > 0) {
              tempoMarks.push({ measureIndex, positionQuarter, bpm: perMinute, beatUnit, dotted })
              if (firstTempo === null) firstTempo = perMinute
            }
          }
          if (partIndex !== 0) continue

          let hasNotationDynamic = false
          for (const directionType of children(node, 'direction-type')) {
            for (const child of Array.from(directionType.children)) {
              if (child.localName === 'dynamics') {
                const level = dynamicLevel(child)
                if (level !== null) {
                  performanceMarks.push({ kind: 'dynamic', measureIndex, positionQuarter, order: performanceMarkOrder++, value: level })
                  hasNotationDynamic = true
                }
              } else if (child.localName === 'wedge') {
                const rawType = child.getAttribute('type')
                if (rawType === 'crescendo' || rawType === 'diminuendo' || rawType === 'stop') {
                  performanceMarks.push({ kind: 'wedge', measureIndex, positionQuarter, order: performanceMarkOrder++, wedgeType: rawType, number: child.getAttribute('number') || '1' })
                }
              } else if (child.localName === 'pedal') {
                const rawType = (child.getAttribute('type') || '').toLowerCase()
                const action = rawType === 'start' ? 'on' : (rawType === 'stop' || rawType === 'discontinue') ? 'off' : rawType === 'change' ? 'change' : undefined
                if (action) performanceMarks.push({ kind: 'pedal', measureIndex, positionQuarter, order: performanceMarkOrder++, action, number: child.getAttribute('number') || '1' })
              }
            }
          }
          const soundDynamics = Number(sound?.getAttribute('dynamics'))
          if (!hasNotationDynamic && Number.isFinite(soundDynamics) && soundDynamics >= 0) {
            performanceMarks.push({ kind: 'dynamic', measureIndex, positionQuarter, order: performanceMarkOrder++, value: Math.max(18, Math.min(120, Math.round(soundDynamics * 0.92))) })
          }
          const soundPedal = sound?.getAttribute('damper-pedal')?.toLowerCase()
          if (soundPedal === 'yes' || soundPedal === 'no') {
            performanceMarks.push({ kind: 'pedal', measureIndex, positionQuarter, order: performanceMarkOrder++, action: soundPedal === 'yes' ? 'on' : 'off', number: 'sound' })
          }
          continue
        }
        if (node.localName === 'harmony') {
          if (partIndex === 0) {
            const harmony = parseHarmony(node, cursorQuarter, divisions)
            if (harmony) target.explicitHarmonies.push(harmony)
          }
          continue
        }
        if (node.localName !== 'note') continue

        const isChordMember = children(node, 'chord').length > 0
        const isGrace = children(node, 'grace').length > 0
        const isRest = children(node, 'rest').length > 0
        const rawDurationDivisions = Number(textOf(firstChild(node, 'duration'), '0'))
        const durationQuarter = Number.isFinite(rawDurationDivisions) && rawDurationDivisions > 0 ? rawDurationDivisions / Math.max(1, divisions) : 0
        const onsetQuarter = isChordMember ? lastNoteOnsetQuarter : cursorQuarter
        const staff = textOf(firstChild(node, 'staff'), '1')
        const voice = textOf(firstChild(node, 'voice'), '1')
        const type = textOf(firstChild(node, 'type'), isGrace ? 'grace' : 'unknown')
        const dots = children(node, 'dot').length
        const accidental = textOf(firstChild(node, 'accidental')) || null
        const instrumentId = firstChild(node, 'instrument')?.getAttribute('id') ?? null
        const ties = tieFlags(node)
        const pitch = firstChild(node, 'pitch')
        let step: string | null = null
        let octave: number | null = null
        let alter = 0
        let midi: number | null = null
        let pitchClass: number | null = null
        let name: string | null = null
        if (!isRest && pitch) {
          const candidateStep = textOf(firstChild(pitch, 'step')).toUpperCase()
          const candidateOctave = Number(textOf(firstChild(pitch, 'octave'), 'NaN'))
          const alterRaw = Number(textOf(firstChild(pitch, 'alter'), '0'))
          if (candidateStep in STEP_PC && Number.isFinite(candidateOctave)) {
            step = candidateStep
            octave = candidateOctave
            alter = Number.isFinite(alterRaw) ? alterRaw : 0
            midi = (candidateOctave + 1) * 12 + STEP_PC[candidateStep] + alter
            pitchClass = ((STEP_PC[candidateStep] + alter) % 12 + 12) % 12
            name = pitchName(candidateStep, alter, candidateOctave)
          }
        }
        const note: CanonicalNote = {
          id: `${partIndex}:${measureIndex}:${noteIndex++}`,
          partIndex, partId, measureIndex, printedNumber: target.printedNumber,
          noteIndex: noteIndex - 1, onsetQuarter: Math.max(0, onsetQuarter), durationQuarter,
          midi, pitchClass, step, alter, octave, name, staff, voice, isRest, isGrace,
          isChordMember, tieStart: ties.tieStart, tieStop: ties.tieStop,
          noteType: type, dots, accidental, instrumentId,
        }
        target.notes.push(note)
        totalNotes += 1
        if (partIndex === 0 && staff === '1' && !isChordMember) {
          target.rhythmEvents.push({ onsetQuarter: Math.max(0, onsetQuarter), durationQuarter, isRest, isGrace, voice, noteType: type, dots })
        }
        if (midi !== null && pitchClass !== null && !isGrace && Math.abs(alter - Math.round(alter)) < 0.001) {
          pitchClassWeights[Math.round(pitchClass) % 12] += Math.max(0.15, durationQuarter)
        }
        if (!isChordMember) {
          lastNoteOnsetQuarter = cursorQuarter
          if (!isGrace) cursorQuarter += durationQuarter
        }
        maxQuarter = Math.max(maxQuarter, onsetQuarter + durationQuarter, cursorQuarter)
      }
      target.measureDurationQuarter = Math.max(target.measureDurationQuarter, maxQuarter)
      if (partIndex === 0) {
        target.fifths = currentKey?.fifths ?? target.fifths
        target.mode = currentKey?.mode ?? target.mode
        target.meter = { ...currentMeter, beatGroups: [...currentMeter.beatGroups] }
      }
    }
  }

  const measures = [...measuresByIndex.values()].sort((a, b) => a.sourceIndex - b.sourceIndex)
  measures.forEach(measure => {
    measure.notes.sort((a, b) => a.onsetQuarter - b.onsetQuarter || (a.partIndex - b.partIndex) || (a.midi ?? 0) - (b.midi ?? 0))
    measure.rhythmEvents.sort((a, b) => a.onsetQuarter - b.onsetQuarter)
    measure.explicitHarmonies.sort((a, b) => a.onsetQuarter - b.onsetQuarter)
    if (!measure.notes.some(note => !note.isRest && note.midi !== null)) diagnostics.push(`第 ${measure.printedNumber} 小节没有可识别音高。`)
    const invalid = measure.notes.find(note => !Number.isFinite(note.onsetQuarter) || note.onsetQuarter < 0 || !Number.isFinite(note.durationQuarter) || note.durationQuarter < 0)
    if (invalid) diagnostics.push(`第 ${measure.printedNumber} 小节存在无效音符时间。`)
  })
  const title = textOf(firstChild(firstChild(root, 'work'), 'work-title')) || textOf(firstChild(root, 'movement-title')) || '未命名乐谱'
  const creator = Array.from(root.getElementsByTagName('*')).find(element => element.localName === 'creator' && element.getAttribute('type') === 'composer')
  const model: CanonicalMusicXmlData = {
    schemaVersion: '1.0', title, composer: textOf(creator), partNames: parts.map(part => part.name), parts,
    measures, performanceMarks: performanceMarks.sort((a, b) => a.measureIndex - b.measureIndex || a.positionQuarter - b.positionQuarter || a.order - b.order),
    tempoMarks: tempoMarks.sort((a, b) => a.measureIndex - b.measureIndex || a.positionQuarter - b.positionQuarter),
    explicitKey, firstMeter, firstTempo, pitchClassWeights, noteCount: totalNotes, diagnostics,
  }
  lastXmlText = xmlText
  lastModel = model
  return model
}

/** Validate invariants shared by playback, metronome and theory readers. */
export function validateCanonicalMusicXmlData(model: CanonicalMusicXmlData): CanonicalValidationResult {
  const errors: string[] = []
  const warnings: string[] = [...model.diagnostics]
  if (model.measures.length === 0) errors.push('未解析到小节。')
  for (let index = 0; index < model.measures.length; index++) {
    const measure = model.measures[index]
    if (measure.sourceIndex !== index) errors.push(`小节索引不连续：预期 ${index}，实际 ${measure.sourceIndex}。`)
    if (!measure.printedNumber) warnings.push(`源小节 ${index} 缺少显示编号。`)
    for (const note of measure.notes) {
      if (note.measureIndex !== measure.sourceIndex) errors.push(`音符 ${note.id} 所属小节索引不一致。`)
      if (!Number.isFinite(note.onsetQuarter) || note.onsetQuarter < 0) errors.push(`音符 ${note.id} 起音时间无效。`)
      if (!Number.isFinite(note.durationQuarter) || note.durationQuarter < 0) errors.push(`音符 ${note.id} 时值无效。`)
      if (note.midi !== null && (!Number.isFinite(note.midi) || note.midi < 0 || note.midi > 140)) warnings.push(`音符 ${note.id} 的 MIDI 音高超出常见范围。`)
    }
    const duplicateIds = new Set<string>()
    for (const note of measure.notes) {
      if (duplicateIds.has(note.id)) errors.push(`重复的标准音符 ID：${note.id}。`)
      duplicateIds.add(note.id)
    }
  }
  if (model.measures.length > 0 && model.measures.some((measure, index) => measure.sourceIndex !== index)) warnings.push('源小节索引映射需要检查。')
  const uniquePrintedNumbers = new Set(model.measures.map(measure => measure.printedNumber))
  if (uniquePrintedNumbers.size < model.measures.length) warnings.push('存在重复显示的小节编号；内部索引仍使用零基源小节顺序。')
  return { ok: errors.length === 0, errors, warnings, measures: model.measures.length, notes: model.noteCount }
}

/** Self-contained browser regression suite; no test framework or extra npm package required. */
export function runMusicDataModelRegressionSuite(): { passed: number; failed: number; details: string[] } {
  const fixture = `<?xml version="1.0" encoding="UTF-8"?>
  <score-partwise version="3.1"><work><work-title>ScoreRoom Regression</work-title></work>
  <identification><creator type="composer">Test Composer</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><dynamics><mf/></dynamics></direction-type><sound tempo="120"/></direction>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><type>quarter</type><tie type="start"/></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><type>quarter</type></note>
      <direction><direction-type><pedal type="start" line="yes"/></direction-type></direction>
      <note><rest/><duration>2</duration><voice>1</voice><staff>1</staff><type>quarter</type></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff><type>quarter</type></note>
      <forward><duration>2</duration></forward>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><staff>2</staff><type>quarter</type></note>
    </measure>
    <measure number="5"><attributes><divisions>4</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff><type>quarter</type><tie type="stop"/></note>
    </measure>
  </part></score-partwise>`
  const details: string[] = []
  const check = (name: string, condition: boolean) => {
    details.push(`${condition ? 'PASS' : 'FAIL'} · ${name}`)
  }
  try {
    const model = getCanonicalMusicXmlData(fixture)
    const first = model.measures[0]
    const second = model.measures[1]
    check('解析标题与作曲者', model.title === 'ScoreRoom Regression' && model.composer === 'Test Composer')
    check('源索引独立于印刷编号', first.sourceIndex === 0 && second.sourceIndex === 1 && second.printedNumber === '5')
    const noteC4 = first.notes.find(note => note.step === 'C' && note.octave === 4)
    const noteE4 = first.notes.find(note => note.step === 'E' && note.octave === 4)
    check('和弦音共享起音位置', noteC4?.onsetQuarter === 0 && noteE4?.onsetQuarter === 0 && noteE4?.isChordMember === true)
    check('时值除以 divisions 正确', Math.abs((first.notes.find(note => note.step === 'G')?.onsetQuarter ?? -1) - 1) < 0.0001 && Math.abs((first.notes.find(note => note.step === 'D' && note.octave === 3)?.onsetQuarter ?? -1) - 2) < 0.0001)
    check('主谱表节奏事件包含休止符', first.rhythmEvents.some(event => event.isRest))
    check('调号与拍号在后续小节继承', first.fifths === 0 && second.fifths === 0 && meterText(second.meter) === '4/4')
    check('力度、踏板和速度标记抽取', model.performanceMarks.some(mark => mark.kind === 'dynamic') && model.performanceMarks.some(mark => mark.kind === 'pedal') && model.tempoMarks.some(mark => mark.bpm === 120))
    check('明确和弦标记读取', first.explicitHarmonies.some(harmony => harmony.symbol === 'C'))
    check('跨小节延音线起止标记保留', first.notes.some(note => note.tieStart) && second.notes.some(note => note.tieStop))
    const validation = validateCanonicalMusicXmlData(model)
    check('规范数据模型结构校验', validation.ok && validation.measures === 2 && validation.notes === 7)
  } catch (error) {
    details.push(`FAIL · 解析异常：${error instanceof Error ? error.message : String(error)}`)
  }
  const failed = details.filter(line => line.startsWith('FAIL')).length
  return { passed: details.length - failed, failed, details }
}
