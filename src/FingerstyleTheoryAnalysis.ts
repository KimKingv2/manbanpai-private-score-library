import { getCanonicalMusicXmlData } from './musicDataModel'

export function theoryPitchClassFromName(name: string): number | null {
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

export type TheoryMeasureInfo = {
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

export type ScoreTheoryAnalysis = {
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

export function analyseMusicXmlTheory(xmlText: string): ScoreTheoryAnalysis {
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


/** Apply local chord corrections while preserving the original analysis fields. */
export function applyTheoryChordCorrections(
  analysis: ScoreTheoryAnalysis,
  corrections: Record<string, string>,
): ScoreTheoryAnalysis {
  const correctedMeasures: TheoryMeasureInfo[] = analysis.measures.map(measure => {
    const chords = measure.chords.map(chord => {
      const id = theoryCorrectionId(measure.sourceIndex, chord.onsetQuarter)
      const selectedKey = corrections[id]
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
    return { ...measure, chords, primaryChord: chords[0] ?? null, nonChordHints: [...measure.nonChordHints] }
  })
  addTheoryLearningAnnotations(correctedMeasures)
  return { ...analysis, measures: correctedMeasures }
}
