import { useMemo } from 'react'
import { useManbanpaiTheme } from './ManbanpaiTheme'

type GuitarSettings = {
  capo: string
  tuning: string[]
  tuningSource: 'musicxml' | 'standard-fallback'
}

const STANDARD_TUNING = [
  { stringNumber: 6, pitch: 'E2' },
  { stringNumber: 5, pitch: 'A2' },
  { stringNumber: 4, pitch: 'D3' },
  { stringNumber: 3, pitch: 'G3' },
  { stringNumber: 2, pitch: 'B3' },
  { stringNumber: 1, pitch: 'E4' },
]

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function childText(parent: Element, localName: string): string {
  const child = Array.from(parent.children).find(element => element.localName === localName)
  return child?.textContent?.trim() ?? ''
}

function pitchNumber(step: string, alter: number, octave: number): number | null {
  const pitchClass = STEP_PC[step]
  if (pitchClass === undefined || !Number.isFinite(octave)) return null
  return (octave + 1) * 12 + pitchClass + alter
}

function midiToPitchName(value: number): string {
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
  const rounded = Math.round(value)
  const pitchClass = ((rounded % 12) + 12) % 12
  const octave = Math.floor(rounded / 12) - 1
  return `${names[pitchClass]}${octave}`
}

function parseCapo(document: Document): string {
  const capoElements = Array.from(document.getElementsByTagName('*')).filter(element => element.localName.toLowerCase() === 'capo')
  for (const element of capoElements) {
    const text = element.textContent?.trim() ?? ''
    const match = text.match(/\d{1,2}/)
    if (match) {
      const fret = Number(match[0])
      return fret <= 0 ? '無' : `第 ${fret} 格`
    }
  }
  const textElements = Array.from(document.getElementsByTagName('*')).filter(element => {
    const name = element.localName.toLowerCase()
    return name === 'words' || name === 'rehearsal' || name === 'other-direction'
  })
  for (const element of textElements) {
    const text = element.textContent ?? ''
    const match = text.match(/(?:\bcapo\s*(?:[:：=]|at)?\s*|變調夾\s*(?:[:：=]|第)?\s*)(\d{1,2})/i)
    if (match) {
      const fret = Number(match[1])
      return fret <= 0 ? '無' : `第 ${fret} 格`
    }
  }
  return '未標註'
}

function parseTuning(document: Document): { tuning: string[]; tuningSource: 'musicxml' | 'standard-fallback' } {
  const staffDetails = Array.from(document.getElementsByTagName('*')).filter(element => element.localName === 'staff-details')
  const groups = staffDetails.map(details =>
    Array.from(details.children).filter(element => element.localName === 'staff-tuning').map(element => {
      const step = childText(element, 'tuning-step').toUpperCase()
      const alterText = childText(element, 'tuning-alter')
      const octaveText = childText(element, 'tuning-octave')
      const alter = alterText ? Number(alterText) : 0
      const octave = Number(octaveText)
      const value = pitchNumber(step, alter, octave)
      return value === null ? null : { value, display: midiToPitchName(value), step, octave, alter }
    }).filter((item): item is NonNullable<typeof item> => item !== null)
  )
  const sixStringGroup = groups.find(group => group.length === 6)
  let pitches = sixStringGroup?.map(item => item.value)

  // Some MusicXML exports omit staff-details and place tuning records directly elsewhere.
  if (!pitches?.length) {
    const allTuningElements = Array.from(document.getElementsByTagName('*')).filter(element => element.localName === 'staff-tuning')
    const firstSix = allTuningElements.slice(0, 6).map(element => {
      const step = childText(element, 'tuning-step').toUpperCase()
      const alterText = childText(element, 'tuning-alter')
      const octaveText = childText(element, 'tuning-octave')
      const alter = alterText ? Number(alterText) : 0
      const value = pitchNumber(step, alter, Number(octaveText))
      return value
    }).filter((value): value is number => value !== null)
    if (firstSix.length === 6) pitches = firstSix
  }

  if (!pitches || pitches.length !== 6) {
    return {
      tuning: STANDARD_TUNING.map(item => `${item.stringNumber}弦 ${item.pitch}`),
      tuningSource: 'standard-fallback',
    }
  }

  // Sort by sounding pitch, not MusicXML's line index. This handles different exporter conventions.
  const ordered = [...pitches].sort((a, b) => a - b)
  return {
    tuning: ordered.map((pitch, index) => `${6 - index}弦 ${midiToPitchName(pitch)}`),
    tuningSource: 'musicxml',
  }
}

function extractGuitarSettings(xmlText: string): GuitarSettings {
  if (!xmlText.trim()) {
    return {
      capo: '未標註',
      tuning: STANDARD_TUNING.map(item => `${item.stringNumber}弦 ${item.pitch}`),
      tuningSource: 'standard-fallback',
    }
  }
  try {
    const document = new DOMParser().parseFromString(xmlText.replace(/^\uFEFF/, ''), 'application/xml')
    if (document.documentElement.localName.toLowerCase() === 'parsererror' || document.getElementsByTagName('parsererror').length) {
      throw new Error('invalid MusicXML')
    }
    const parsed = parseTuning(document)
    return { capo: parseCapo(document), ...parsed }
  } catch {
    return {
      capo: '未標註',
      tuning: STANDARD_TUNING.map(item => `${item.stringNumber}弦 ${item.pitch}`),
      tuningSource: 'standard-fallback',
    }
  }
}

export default function GuitarSettingsPanel({ xmlText }: { xmlText: string }) {
  const settings = useMemo(() => extractGuitarSettings(xmlText), [xmlText])
  const theme = useManbanpaiTheme()
  const day = theme === 'day'
  const colors = day
    ? { bg: 'linear-gradient(110deg,#fffdf7,#f3ecdf)', border: '#d6c5a6', text: '#27332d', muted: '#4a554e', gold: '#72501e', tuning: '#202b25', shadow: '0 5px 18px rgba(73,54,25,.07)' }
    : { bg: 'linear-gradient(110deg,#1b242d,#141b23)', border: 'rgba(217,183,121,.34)', text: '#e8edf3', muted: '#c2ccd5', gold: '#e0c183', tuning: '#f2e6cc', shadow: '0 6px 20px rgba(0,0,0,.16)' }
  return (
    <section
      className="mb-guitar-settings-panel"
      aria-label="吉他設定"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 14px',
        margin: '10px 0 12px',
        padding: '11px 14px',
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        background: colors.bg,
        color: colors.text,
        boxShadow: colors.shadow,
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <strong style={{ fontSize: 12, letterSpacing: 0.35, whiteSpace: 'nowrap', color: colors.gold }}>吉他設定</strong>
      <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>變調夾 <strong style={{ color: colors.text, fontWeight: 750 }}>{settings.capo}</strong></span>
      <span style={{ color: colors.muted, whiteSpace: 'nowrap' }}>調弦（6弦 → 1弦）</span>
      <strong aria-label={`調弦順序：${settings.tuning.join('，')}`} style={{ color: colors.tuning, display: 'inline-block', fontWeight: 800, letterSpacing: '.1px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflowX: 'auto', maxWidth: '100%' }}>
        {settings.tuning.join('　·　')}
      </strong>
      {settings.tuningSource === 'standard-fallback' && (
        <span style={{ flexBasis: '100%', color: colors.muted, fontSize: 11 }}>
          MusicXML 未標註六弦調弦，暫以標準調弦顯示。
        </span>
      )}
    </section>
  )
}
