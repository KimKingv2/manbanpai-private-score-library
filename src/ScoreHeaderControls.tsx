import { useEffect, useState, type CSSProperties } from 'react'

type ScoreHeaderControlsProps = {
  currentTime: number
  duration: number
  playing: boolean
  ready: boolean
  rate: number
  zoom: number
  theoryOpen: boolean
  onTogglePlay: () => void
  onReplay: () => void
  onRateChange: (rate: number) => void
  onToggleTheory: () => void
  onZoomChange: (zoom: number) => void
}

const RATES = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]
const ZOOMS = [75, 90, 100, 110, 125, 150]

function displayTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  const tenths = Math.floor((safe % 1) * 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export default function ScoreHeaderControls(props: ScoreHeaderControlsProps) {
  const [themeMode, setThemeMode] = useState<'day' | 'night'>(() => {
    if (typeof document === 'undefined') return 'night'
    return document.documentElement.dataset.manbanpaiTheme === 'day' ? 'day' : 'night'
  })

  useEffect(() => {
    const syncTheme = (event?: Event) => {
      const detail = (event as CustomEvent<'day' | 'night'> | undefined)?.detail
      const next = detail === 'day' || detail === 'night'
        ? detail
        : (document.documentElement.dataset.manbanpaiTheme === 'day' ? 'day' : 'night')
      setThemeMode(next)
    }
    syncTheme()
    window.addEventListener('manbanpai-theme-change', syncTheme)
    return () => window.removeEventListener('manbanpai-theme-change', syncTheme)
  }, [])

  const isDay = themeMode === 'day'
  const baseButton: CSSProperties = {
    minHeight: 32, borderRadius: 8,
    border: isDay ? '1px solid rgba(63,75,86,.24)' : '1px solid rgba(220,230,240,.16)',
    padding: '5px 9px',
    background: isDay ? 'rgba(39,54,68,.035)' : 'rgba(255,255,255,.045)',
    color: isDay ? '#27343e' : '#e5ebf2',
    cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1.2, whiteSpace: 'nowrap',
  }
  const activeButton: CSSProperties = {
    ...baseButton,
    borderColor: isDay ? 'rgba(67,106,142,.58)' : 'rgba(217,183,121,.62)',
    background: isDay ? 'rgba(76,119,157,.14)' : 'rgba(217,183,121,.15)',
    color: isDay ? '#234762' : '#f3d99d',
  }
  const selectStyle: CSSProperties = {
    minHeight: 29, borderRadius: 8,
    border: isDay ? '1px solid #c8cfd4' : '1px solid rgba(220,230,240,.16)',
    padding: '4px 25px 4px 8px',
    background: isDay ? '#ffffff' : '#222b35', color: isDay ? '#26343e' : '#f3d99d',
    fontSize: 11, fontWeight: 750, outline: 'none', cursor: props.ready ? 'pointer' : 'default',
  }
  const currentZoomIndex = ZOOMS.reduce((best, value, index) =>
    Math.abs(value - props.zoom) < Math.abs(ZOOMS[best] - props.zoom) ? index : best, 0)
  const setZoomStep = (delta: number) => {
    const nextIndex = Math.max(0, Math.min(ZOOMS.length - 1, currentZoomIndex + delta))
    props.onZoomChange(ZOOMS[nextIndex])
  }

  const optionStyle: CSSProperties = isDay
    ? { background: '#ffffff', color: '#26343e' }
    : { background: '#222b35', color: '#f3d99d' }

  return (
    <div aria-label="曲譜播放控制" style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '9px 10px', margin: '10px 0 14px', borderRadius: 12,
      border: isDay ? '1px solid #d9d0c2' : '1px solid rgba(217,183,121,.22)',
      background: isDay ? 'rgba(255,253,248,.97)' : 'rgba(17,25,35,.72)',
      color: isDay ? '#26343e' : '#e7edf4',
      boxShadow: isDay ? '0 4px 16px rgba(30,38,45,.07)' : 'none',
    }}>
      <button
        type="button"
        disabled={!props.ready}
        onClick={props.onTogglePlay}
        style={{
          ...(isDay ? {
            ...activeButton,
            border: '1px solid rgba(163,124,49,.72)',
            background: 'linear-gradient(135deg, #f7edcf 0%, #e5cc8e 100%)',
            color: '#493516',
            fontWeight: 800,
            boxShadow: '0 2px 7px rgba(123,88,30,.13), inset 0 1px 0 rgba(255,255,255,.86)',
          } : activeButton),
          opacity: props.ready ? 1 : .5,
        }}
      >{props.playing ? 'Ⅱ 暫停' : '▶ 播放'}</button>
      <button
        type="button"
        disabled={!props.ready}
        onClick={props.onReplay}
        style={{
          ...(isDay ? {
            ...baseButton,
            border: '1px solid rgba(151,116,55,.38)',
            background: 'rgba(183,149,83,.075)',
            color: '#76603b',
            fontWeight: 750,
          } : baseButton),
          opacity: props.ready ? 1 : .5,
        }}
        title="從頭重新播放 MP3"
      >↺ 重播</button>
      <label aria-label="播放速度" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: isDay ? '#354550' : '#c5ced8', fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap' }}>
        速度
        <select aria-label="播放倍速" value={props.rate} disabled={!props.ready} onChange={event => props.onRateChange(Number(event.currentTarget.value))} style={selectStyle}>
          {RATES.map(value => <option key={value} value={value} style={optionStyle}>{value.toFixed(1)}×</option>)}
        </select>
      </label>
      <span aria-live="off" style={{ padding: '0 5px', fontSize: 11, fontWeight: 650, color: isDay ? '#354550' : '#c5ced8', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{displayTime(props.currentTime)} / {displayTime(props.duration)}</span>
      <button type="button" onClick={props.onToggleTheory} aria-pressed={props.theoryOpen} style={props.theoryOpen ? activeButton : baseButton}>♫ 樂理分析</button>
      <div aria-label="PDF 縮放" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}>
        <button type="button" disabled={currentZoomIndex <= 0} onClick={() => setZoomStep(-1)} aria-label="縮小 PDF" style={{ ...baseButton, width: 30, padding: 0, opacity: currentZoomIndex <= 0 ? .42 : 1 }}>−</button>
        <span style={{ minWidth: 43, textAlign: 'center', fontSize: 11, fontWeight: 700, color: isDay ? '#27343e' : '#e5ebf2', fontVariantNumeric: 'tabular-nums' }}>{props.zoom}%</span>
        <button type="button" disabled={currentZoomIndex >= ZOOMS.length - 1} onClick={() => setZoomStep(1)} aria-label="放大 PDF" style={{ ...baseButton, width: 30, padding: 0, opacity: currentZoomIndex >= ZOOMS.length - 1 ? .42 : 1 }}>＋</button>
      </div>
    </div>
  )
}
