import { useEffect, useRef, useState } from 'react'

type PlaybackControlBarProps = {
  currentTime: number
  duration: number
  playing: boolean
  ready: boolean
  rate: number
  autoFollow: boolean
  scoreTempo?: number
  meter?: string
  metronomeBeatGrid?: PianoMetronomeBeatGridItem[]
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onSkip: (delta: number) => void
  onRateChange: (rate: number) => void
  onAutoFollowChange: (enabled: boolean) => void
  onStop?: () => void
  zoom?: number
  onZoomChange?: (zoom: number) => void
  theoryOpen?: boolean
  onToggleTheory?: () => void
  loopStart?: number | null
  loopEnd?: number | null
  loopEnabled?: boolean
  onMarkLoopStart?: () => void
  onMarkLoopEnd?: () => void
  onClearLoop?: () => void
  label?: string
}

const RATES = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]
const ZOOMS = [75, 90, 100, 110, 125, 150]
type ClickVoice = { oscillator: OscillatorNode; gain: GainNode; startAt: number }

type PianoMetronomeBeatGridItem = { time: number; beatSeconds: number; accent: boolean }

function formatPlaybackTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  const tenths = Math.floor((safe % 1) * 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))
}

function beatConfig(meterValue: string | undefined, scoreTempo: number | undefined) {
  const meter = meterValue || '4/4'
  const [beatsRaw, beatTypeRaw] = meter.split('/')
  const numerator = beatsRaw.split('+').reduce((sum, value) => sum + (Number(value) || 0), 0) || 4
  const denominator = Number(beatTypeRaw) || 4
  const compound = denominator === 8 && numerator >= 6 && numerator % 3 === 0
  const beatsPerBar = compound ? numerator / 3 : numerator
  const quarterNotesPerBeat = compound ? 1.5 : 4 / denominator
  const bpm = Math.max(30, Math.min(300, Number(scoreTempo) > 0 ? Number(scoreTempo) : 80))
  return { meter, bpm, beatsPerBar, beatSeconds: 60 / bpm * quarterNotesPerBeat }
}

/** Compact shared transport with an MP3-clock-following metronome and optional count-in. */
export default function PlaybackControlBar(props: PlaybackControlBarProps) {
  const [expanded, setExpanded] = useState(true)
  const previousTheoryOpenRef = useRef(Boolean(props.theoryOpen))
  const [panelHeight, setPanelHeight] = useState(41)
  const panelRef = useRef<HTMLDivElement>(null)
  const compactContentRef = useRef<HTMLDivElement>(null)
  const expandedContentRef = useRef<HTMLDivElement>(null)
  const transitionFrameRef = useRef<number | null>(null)
  const transitionExpandedRef = useRef<(next: boolean) => void>(() => {})
  const [themeMode, setThemeMode] = useState<'day' | 'night'>(() => {
    if (typeof document === 'undefined') return 'night'
    return document.documentElement.dataset.manbanpaiTheme === 'day' ? 'day' : 'night'
  })
  const [scrubTime, setScrubTime] = useState<number | null>(null)
  const [metronomeEnabled, setMetronomeEnabled] = useState(false)
  const [metronomeVolume, setMetronomeVolume] = useState(50)
  const [metronomeSubdivision, setMetronomeSubdivision] = useState<1 | 2 | 4>(1)
  const [countInBars, setCountInBars] = useState<0 | 1 | 2>(0)
  const [isCountingIn, setIsCountingIn] = useState(false)

  // Keep both layouts mounted and animate the measured panel height. This prevents
  // the collapsed row from disappearing for a frame while React swaps layouts.
  transitionExpandedRef.current = (next: boolean) => {
    const panel = panelRef.current
    if (!panel) {
      setExpanded(next)
      setPanelHeight(next ? 292 : 41)
      return
    }
    if (transitionFrameRef.current !== null) {
      cancelAnimationFrame(transitionFrameRef.current)
      transitionFrameRef.current = null
    }
    const visualHeight = Math.max(41, Math.round(panel.getBoundingClientRect().height))
    setPanelHeight(visualHeight)
    setExpanded(next)
    transitionFrameRef.current = requestAnimationFrame(() => {
      const content = next ? expandedContentRef.current : compactContentRef.current
      if (content) {
        const target = next ? Math.max(220, Math.ceil(content.scrollHeight + 2)) : 41
        setPanelHeight(target)
      }
      transitionFrameRef.current = null
    })
  }

  useEffect(() => () => {
    if (transitionFrameRef.current !== null) cancelAnimationFrame(transitionFrameRef.current)
  }, [])

  useEffect(() => {
    if (!expanded || typeof ResizeObserver === 'undefined') return
    const content = expandedContentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      const nextHeight = Math.max(220, Math.ceil(content.scrollHeight + 2))
      setPanelHeight(current => Math.abs(current - nextHeight) > 2 ? nextHeight : current)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [expanded])

  // Keep the two large floating panels mutually exclusive: opening theory collapses
  // the playback controls; expanding playback controls closes the theory panel first.
  useEffect(() => {
    const isOpen = Boolean(props.theoryOpen)
    const justOpened = isOpen && !previousTheoryOpenRef.current
    previousTheoryOpenRef.current = isOpen
    if (justOpened && expanded) transitionExpandedRef.current(false)
  }, [props.theoryOpen, expanded])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const syncTheme = (event?: Event) => {
      const detail = (event as CustomEvent<'day' | 'night'> | undefined)?.detail
      const next = detail === 'day' || detail === 'night' ? detail : (document.documentElement.dataset.manbanpaiTheme === 'day' ? 'day' : 'night')
      setThemeMode(next)
    }
    syncTheme()
    window.addEventListener('manbanpai-theme-change', syncTheme)
    return () => window.removeEventListener('manbanpai-theme-change', syncTheme)
  }, [])

  const duration = Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0
  const displayedTime = Math.max(0, Math.min(duration || props.currentTime, scrubTime ?? props.currentTime))
  const max = Math.max(0.01, duration)
  const canLoop = Boolean(props.onMarkLoopStart && props.onMarkLoopEnd && props.onClearLoop)
  const audioContextRef = useRef<AudioContext | null>(null)
  const metronomeMasterGainRef = useRef<GainNode | null>(null)
  const countInTimerRef = useRef<number | null>(null)
  const clickVoicesRef = useRef<ClickVoice[]>([])
  const observedTimeRef = useRef({ value: props.currentTime, at: typeof performance !== 'undefined' ? performance.now() : 0 })
  const needsResyncRef = useRef(false)
  const latestPlayingRef = useRef(props.playing)
  const latestRateRef = useRef(props.rate)
  const lastScheduledTickRef = useRef(Number.NaN)
  // MANBANPAI_METRONOME_PHASE_FIX_V1: keep the next score-time tick and phase stable when a measure changes tempo.
  const nextTickScoreTimeRef = useRef<number | null>(null)
  const lastScheduledScoreTimeRef = useRef<number | null>(null)
  const latestScoreTempoRef = useRef(props.scoreTempo)
  const latestMeterRef = useRef(props.meter)
  const lastMetronomeTempoRef = useRef<number | null>(null)
  const lastMetronomeMeterRef = useRef<string | undefined>(undefined)
  const lastMetronomeSubdivisionRef = useRef<1 | 2 | 4 | null>(null)

  latestPlayingRef.current = props.playing
  latestRateRef.current = props.rate
  latestScoreTempoRef.current = props.scoreTempo
  latestMeterRef.current = props.meter

  useEffect(() => {
    const now = performance.now()
    const delta = props.currentTime - observedTimeRef.current.value
    if (Math.abs(delta) > 0.48 || delta < -0.28) needsResyncRef.current = true
    observedTimeRef.current = { value: props.currentTime, at: now }
  }, [props.currentTime])

  const ensureAudioContext = () => {
    if (typeof window === 'undefined') return null
    const AudioContextCtor = window.AudioContext
    if (!AudioContextCtor) return null
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const context = new AudioContextCtor()
      const masterGain = context.createGain()
      masterGain.gain.value = Math.min(2, metronomeVolume / 50)
      masterGain.connect(context.destination)
      audioContextRef.current = context
      metronomeMasterGainRef.current = masterGain
    }
    return audioContextRef.current
  }

  useEffect(() => {
    const context = audioContextRef.current
    const masterGain = metronomeMasterGainRef.current
    if (!context || context.state === 'closed' || !masterGain) return
    masterGain.gain.setTargetAtTime(Math.min(2, metronomeVolume / 50), context.currentTime, 0.015)
  }, [metronomeVolume])

  const stopFutureClicks = () => {
    const context = audioContextRef.current
    if (!context) return
    const cutoff = context.currentTime + 0.018
    for (const voice of [...clickVoicesRef.current]) {
      if (voice.startAt <= cutoff) continue
      try { voice.oscillator.onended = null; voice.oscillator.stop() } catch { /* already stopped */ }
      try { voice.oscillator.disconnect() } catch { /* already disconnected */ }
      try { voice.gain.disconnect() } catch { /* already disconnected */ }
      clickVoicesRef.current = clickVoicesRef.current.filter(item => item !== voice)
    }
  }

  const scheduleClick = (context: AudioContext, requestedTime: number, accent: boolean, subdivision: boolean) => {
    const startAt = Math.max(context.currentTime + 0.003, requestedTime)
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(subdivision ? 620 : accent ? 1480 : 940, startAt)
    const peak = subdivision ? 0.14 : accent ? 0.42 : 0.28
    const length = subdivision ? 0.032 : accent ? 0.078 : 0.055
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + length)
    oscillator.connect(gain)
    gain.connect(metronomeMasterGainRef.current ?? context.destination)
    const voice: ClickVoice = { oscillator, gain, startAt }
    clickVoicesRef.current.push(voice)
    oscillator.onended = () => {
      clickVoicesRef.current = clickVoicesRef.current.filter(item => item !== voice)
      try { oscillator.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    }
    oscillator.start(startAt)
    oscillator.stop(startAt + length + 0.01)
  }

  const cancelCountIn = () => {
    if (countInTimerRef.current !== null) window.clearTimeout(countInTimerRef.current)
    countInTimerRef.current = null
    setIsCountingIn(false)
    stopFutureClicks()
  }

  const toggleMetronome = async () => {
    needsResyncRef.current = true
    const next = !metronomeEnabled
    if (next) {
      const context = ensureAudioContext()
      if (context) {
        try { await context.resume() } catch { /* browser may require another user gesture */ }
      }
    } else {
      stopFutureClicks()
    }
    setMetronomeEnabled(next)
  }

  const startOrTogglePlayback = async () => {
    if (isCountingIn) {
      cancelCountIn()
      return
    }
    if (props.playing || countInBars === 0 || !props.ready) {
      props.onTogglePlay()
      return
    }
    const context = ensureAudioContext()
    if (!context) {
      props.onTogglePlay()
      return
    }
    try { await context.resume() } catch { /* best effort */ }
    const config = beatConfig(props.meter, props.scoreTempo)
    const beatCount = config.beatsPerBar * countInBars
    const stepSeconds = config.beatSeconds / metronomeSubdivision
    const startAt = context.currentTime + 0.075
    const rate = Math.max(0.1, props.rate || 1)
    for (let pulse = 0; pulse < beatCount * metronomeSubdivision; pulse++) {
      const beatIndex = Math.floor(pulse / metronomeSubdivision)
      const isSubdivision = pulse % metronomeSubdivision !== 0
      scheduleClick(context, startAt + pulse * stepSeconds / rate, beatIndex % config.beatsPerBar === 0 && !isSubdivision, isSubdivision)
    }
    setIsCountingIn(true)
    countInTimerRef.current = window.setTimeout(() => {
      countInTimerRef.current = null
      setIsCountingIn(false)
      props.onTogglePlay()
    }, Math.max(150, beatCount * config.beatSeconds / rate * 1000))
  }

  // MANBANPAI_METRONOME_PHASE_FIX_V1: pause/seek/toggle re-aligns the scheduler; BPM changes do not restart it.
  useEffect(() => {
    if (!props.playing) needsResyncRef.current = true
  }, [props.playing])

  useEffect(() => {
    if (!metronomeEnabled || !props.ready || !props.playing) return
    const context = ensureAudioContext()
    if (!context) return
    void context.resume()

    // MANBANPAI_PIANO_MEASURE_GRID_METRONOME_V3: the piano provides the actual start time of every scheduled measure.
    // Accent is derived from each measure's own first beat, never from a global tick counter.
    // MANBANPAI_PIANO_MEASURE_GRID_METRONOME_V3
    const suppliedBeatGrid = props.metronomeBeatGrid
    if (suppliedBeatGrid && suppliedBeatGrid.length > 0) {
      const pulseGrid: Array<{ time: number; accent: boolean; subdivision: boolean }> = []
      const divisions = Math.max(1, metronomeSubdivision)
      for (let index = 0; index < suppliedBeatGrid.length; index++) {
        const beat = suppliedBeatGrid[index]
        const fallbackSpan = index + 1 < suppliedBeatGrid.length
          ? Math.max(0.025, suppliedBeatGrid[index + 1].time - beat.time)
          : Math.max(0.025, beat.beatSeconds)
        const beatSeconds = Number.isFinite(beat.beatSeconds) && beat.beatSeconds > 0
          ? beat.beatSeconds
          : fallbackSpan
        for (let division = 0; division < divisions; division++) {
          pulseGrid.push({
            time: beat.time + beatSeconds * division / divisions,
            accent: division === 0 && beat.accent,
            subdivision: division > 0,
          })
        }
      }
      pulseGrid.sort((a, b) => a.time - b.time)

      const findNextPulseIndex = (scoreTime: number) => {
        let low = 0
        let high = pulseGrid.length
        const threshold = scoreTime - 0.008
        while (low < high) {
          const middle = (low + high) >>> 1
          if (pulseGrid[middle].time < threshold) low = middle + 1
          else high = middle
        }
        return low
      }

      let nextPulseIndex = findNextPulseIndex(Math.max(0, observedTimeRef.current.value))
      needsResyncRef.current = false
      const gridScheduler = window.setInterval(() => {
        if (!latestPlayingRef.current) return
        const now = performance.now()
        const baseline = observedTimeRef.current
        const currentScoreTime = Math.max(0, baseline.value + Math.max(0, now - baseline.at) / 1000 * Math.max(0.1, latestRateRef.current))
        if (needsResyncRef.current) {
          nextPulseIndex = findNextPulseIndex(currentScoreTime)
          needsResyncRef.current = false
        }
        const rate = Math.max(0.1, latestRateRef.current)
        const horizon = currentScoreTime + 0.105 * rate
        let handled = 0
        while (nextPulseIndex < pulseGrid.length && pulseGrid[nextPulseIndex].time <= horizon && handled < 24) {
          const pulse = pulseGrid[nextPulseIndex]
          nextPulseIndex += 1
          handled += 1
          const timeUntilScorePulse = pulse.time - currentScoreTime
          if (timeUntilScorePulse < -0.035) continue
          scheduleClick(context, context.currentTime + Math.max(0.003, timeUntilScorePulse / rate), pulse.accent, pulse.subdivision)
        }
      }, 20)
      return () => {
        window.clearInterval(gridScheduler)
        stopFutureClicks()
      }
    }

    const observed = observedTimeRef.current
    const meterValue = latestMeterRef.current
    const config = beatConfig(meterValue, latestScoreTempoRef.current)
    const tickSeconds = config.beatSeconds / metronomeSubdivision
    const meterKey = meterValue || '4/4'
    const meterChanged = lastMetronomeMeterRef.current !== undefined && lastMetronomeMeterRef.current !== meterKey
    const subdivisionChanged = lastMetronomeSubdivisionRef.current !== null && lastMetronomeSubdivisionRef.current !== metronomeSubdivision
    if (meterChanged || subdivisionChanged) needsResyncRef.current = true

    const tempoChanged = lastMetronomeTempoRef.current !== null && lastMetronomeTempoRef.current !== config.bpm
    if (needsResyncRef.current || !Number.isFinite(lastScheduledTickRef.current) || nextTickScoreTimeRef.current === null) {
      // MANBANPAI_METRONOME_FIRST_BEAT_FIX_V2: do not skip beat 1 if React starts this scheduler a few frames after audio playback.
      // The old 45 ms cutoff could classify the song's opening as beat 2, making beat 4 sound accented.
      const startsAtPianoOpening = props.label?.includes('鋼琴') === true && observed.value <= Math.max(0.22, tickSeconds * 0.4)
      if (startsAtPianoOpening) {
        scheduleClick(context, context.currentTime + 0.003, true, false)
        lastScheduledTickRef.current = 0
        lastScheduledScoreTimeRef.current = 0
        nextTickScoreTimeRef.current = tickSeconds
      } else {
        const firstTick = observed.value <= 0.045 ? 0 : Math.floor(observed.value / tickSeconds) + 1
        lastScheduledTickRef.current = firstTick - 1
        nextTickScoreTimeRef.current = firstTick * tickSeconds
        lastScheduledScoreTimeRef.current = firstTick > 0 ? (firstTick - 1) * tickSeconds : null
      }
      needsResyncRef.current = false
    } else if (tempoChanged && lastScheduledScoreTimeRef.current !== null) {
      // Keep the next click after the last scheduled beat instead of re-deriving the
      // beat ordinal from currentTime / the new BPM. That calculation can move a downbeat
      // onto the previous measure's final beat when the piano tempo changes.
      nextTickScoreTimeRef.current = lastScheduledScoreTimeRef.current + tickSeconds
    }
    lastMetronomeTempoRef.current = config.bpm
    lastMetronomeMeterRef.current = meterKey
    lastMetronomeSubdivisionRef.current = metronomeSubdivision

    const scheduler = window.setInterval(() => {
      if (!latestPlayingRef.current) return
      const now = performance.now()
      const baseline = observedTimeRef.current
      const currentScoreTime = Math.max(0, baseline.value + Math.max(0, now - baseline.at) / 1000 * Math.max(0.1, latestRateRef.current))
      const liveMeter = latestMeterRef.current
      const liveConfig = beatConfig(liveMeter, latestScoreTempoRef.current)
      const liveTickSeconds = liveConfig.beatSeconds / metronomeSubdivision
      const liveMeterKey = liveMeter || '4/4'
      const liveMeterChanged = lastMetronomeMeterRef.current !== liveMeterKey
      const liveSubdivisionChanged = lastMetronomeSubdivisionRef.current !== metronomeSubdivision
      if (liveMeterChanged || liveSubdivisionChanged) needsResyncRef.current = true

      const tempoChangedDuringPlayback = lastMetronomeTempoRef.current !== null && lastMetronomeTempoRef.current !== liveConfig.bpm
      if (needsResyncRef.current || !Number.isFinite(lastScheduledTickRef.current) || nextTickScoreTimeRef.current === null) {
        // MANBANPAI_METRONOME_FIRST_BEAT_FIX_V2: same opening-beat guard when a seek/resync reaches the scheduler first.
        const startsAtPianoOpening = props.label?.includes('鋼琴') === true && currentScoreTime <= Math.max(0.22, liveTickSeconds * 0.4)
        if (startsAtPianoOpening) {
          scheduleClick(context, context.currentTime + 0.003, true, false)
          lastScheduledTickRef.current = 0
          lastScheduledScoreTimeRef.current = 0
          nextTickScoreTimeRef.current = liveTickSeconds
        } else {
          const firstTick = currentScoreTime <= 0.045 ? 0 : Math.floor(currentScoreTime / liveTickSeconds) + 1
          lastScheduledTickRef.current = firstTick - 1
          nextTickScoreTimeRef.current = firstTick * liveTickSeconds
          lastScheduledScoreTimeRef.current = firstTick > 0 ? (firstTick - 1) * liveTickSeconds : null
        }
        needsResyncRef.current = false
      } else if (tempoChangedDuringPlayback && lastScheduledScoreTimeRef.current !== null) {
        // Tempo changes update the interval from the last beat, but do not reset the bar's
        // beat count. This keeps the regular/downbeat click pattern from shifting by one.
        nextTickScoreTimeRef.current = lastScheduledScoreTimeRef.current + liveTickSeconds
      }
      lastMetronomeTempoRef.current = liveConfig.bpm
      lastMetronomeMeterRef.current = liveMeterKey
      lastMetronomeSubdivisionRef.current = metronomeSubdivision

      const nextTick = Number.isFinite(lastScheduledTickRef.current) ? lastScheduledTickRef.current + 1 : Math.max(0, Math.ceil(currentScoreTime / liveTickSeconds))
      const targetScoreTime = nextTickScoreTimeRef.current ?? nextTick * liveTickSeconds
      const timeUntilScoreTick = targetScoreTime - currentScoreTime
      const rate = Math.max(0.1, latestRateRef.current)
      if (timeUntilScoreTick < -0.035) {
        // Drop a stale click without losing the beat ordinal, so later clicks keep their phase.
        lastScheduledTickRef.current = nextTick
        lastScheduledScoreTimeRef.current = targetScoreTime
        nextTickScoreTimeRef.current = targetScoreTime + liveTickSeconds
        return
      }
      if (timeUntilScoreTick / rate <= 0.105) {
        const beatIndex = Math.floor(nextTick / metronomeSubdivision)
        const isSubdivision = nextTick % metronomeSubdivision !== 0
        const accent = !isSubdivision && beatIndex % liveConfig.beatsPerBar === 0
        scheduleClick(context, context.currentTime + Math.max(0.003, timeUntilScoreTick / rate), accent, isSubdivision)
        lastScheduledTickRef.current = nextTick
        lastScheduledScoreTimeRef.current = targetScoreTime
        nextTickScoreTimeRef.current = targetScoreTime + liveTickSeconds
      }
    }, 20)
    return () => {
      window.clearInterval(scheduler)
      stopFutureClicks()
    }
  }, [metronomeEnabled, props.ready, props.playing, metronomeSubdivision, props.metronomeBeatGrid])

  useEffect(() => () => {
    if (countInTimerRef.current !== null) window.clearTimeout(countInTimerRef.current)
    for (const voice of clickVoicesRef.current) {
      try { voice.oscillator.onended = null; voice.oscillator.stop() } catch { /* already ended */ }
      try { voice.oscillator.disconnect() } catch { /* already disconnected */ }
      try { voice.gain.disconnect() } catch { /* already disconnected */ }
    }
    clickVoicesRef.current = []
    try { metronomeMasterGainRef.current?.disconnect() } catch { /* already disconnected */ }
    metronomeMasterGainRef.current = null
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') void audioContextRef.current.close()
  }, [])


  // A deliberate score scroll hands control back to the reader. Playback will no longer pull the page away.
  useEffect(() => {
    if (!props.autoFollow || typeof window === 'undefined') return
    const isScoreSurface = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false
      return Boolean(target.closest('.manbanpai-pdf-page, .piano-pdf-page, .manbanpai-pdf-scroll, .piano-pdf-pages, [data-pdf-measure-index]'))
    }
    const onManualScrollIntent = (event: Event) => {
      if (isScoreSurface(event.target)) props.onAutoFollowChange(false)
    }
    const onScrollbarGrab = (event: Event) => {
      const pointer = event as PointerEvent
      // Native vertical scrollbar clicks commonly target the document edge, outside the PDF node tree.
      if (!isScoreSurface(pointer.target) && pointer.clientX >= Math.max(0, window.innerWidth - 20)) props.onAutoFollowChange(false)
    }
    window.addEventListener('wheel', onManualScrollIntent, { capture: true, passive: true })
    window.addEventListener('touchmove', onManualScrollIntent, { capture: true, passive: true })
    window.addEventListener('pointerdown', onScrollbarGrab, true)
    return () => {
      window.removeEventListener('wheel', onManualScrollIntent, true)
      window.removeEventListener('touchmove', onManualScrollIntent, true)
      window.removeEventListener('pointerdown', onScrollbarGrab, true)
    }
  }, [props.autoFollow, props.onAutoFollowChange])

  const commitSeek = () => {
    if (scrubTime === null) return
    needsResyncRef.current = true
    props.onSeek(Math.max(0, Math.min(duration || scrubTime, scrubTime)))
    setScrubTime(null)
  }

  const seekToBeginning = () => {
    cancelCountIn()
    props.onStop?.()
    if (!props.onStop && props.playing) props.onTogglePlay()
    needsResyncRef.current = true
    props.onSeek(0)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return
      if (event.key === 'Escape') {
        if (expanded) {
          event.preventDefault()
          transitionExpandedRef.current(false)
        }
        return
      }
      if (!props.ready || event.repeat) return
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        void startOrTogglePlayback()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        props.onSkip(-5)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        props.onSkip(5)
      } else if (event.key === 'Home') {
        event.preventDefault()
        seekToBeginning()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [expanded, props.ready, props.playing, props.rate, props.currentTime, countInBars, metronomeSubdivision, isCountingIn, props.scoreTempo, props.meter])

  const progress = (
    <input
      aria-label={`${props.label ?? '音樂'}播放進度`}
      title="拖動定位播放位置"
      type="range"
      min={0}
      max={max}
      step={0.02}
      value={Math.min(max, displayedTime)}
      disabled={!props.ready}
      onChange={event => setScrubTime(Number(event.currentTarget.value))}
      onPointerUp={commitSeek}
      onKeyUp={commitSeek}
      onTouchEnd={commitSeek}
      style={{ width: '100%', minWidth: 0, margin: 0, padding: 0, accentColor: '#d9b779', cursor: props.ready ? 'pointer' : 'default' }}
    />
  )

  const buttonStyle = (primary = false, active = false) => ({
    minHeight: 34,
    padding: '6px 11px',
    borderRadius: 12,
    border: primary || active ? '1px solid rgba(217,183,121,.65)' : '1px solid rgba(220,230,240,.17)',
    background: primary ? 'linear-gradient(145deg,#f0d99f,#d4ad61)' : active ? 'rgba(217,183,121,.17)' : 'rgba(255,255,255,.055)',
    color: primary ? '#1b2026' : active ? '#f3d99d' : '#e5ebf2',
    cursor: props.ready ? 'pointer' : 'default',
    fontSize: 12,
    fontWeight: 750,
    whiteSpace: 'nowrap' as const,
    opacity: props.ready ? 1 : 0.48,
    boxShadow: primary ? '0 3px 10px rgba(0,0,0,.12)' : 'none',
  })

  const selectStyle = {
    minHeight: 30,
    maxWidth: 150,
    borderRadius: 10,
    border: themeMode === 'day' ? '1px solid #d7cbb7' : '1px solid rgba(220,230,240,.17)',
    background: themeMode === 'day' ? '#fffdf7' : '#222b35',
    color: themeMode === 'day' ? '#303734' : '#f3d99d',
    padding: '4px 26px 4px 9px',
    fontSize: 11,
    fontWeight: 750,
    outline: 'none',
    cursor: props.ready ? 'pointer' : 'default',
  } as const

  const optionStyle = themeMode === 'day'
    ? { background: '#fffdf7', color: '#303734' }
    : { background: '#222b35', color: '#f3d99d' }

  const config = beatConfig(props.meter, props.scoreTempo)
  const subdivisionLabel = metronomeSubdivision === 1 ? '主拍' : metronomeSubdivision === 2 ? '二等分' : '四等分'

  return (
    <>
      <div aria-hidden="true" style={{ height: expanded ? Math.max(292, panelHeight) : 41, width: '100%', pointerEvents: 'none', transition: 'height .26s cubic-bezier(.22,.61,.36,1)' }} />
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 2000, padding: '0 10px max(8px, env(safe-area-inset-bottom))', pointerEvents: 'none' }}>
        <div
          ref={panelRef}
          className="mb-playback-panel"
          aria-label="曲譜播放控制"
          style={{
            position: 'relative',
            boxSizing: 'border-box',
            height: panelHeight,
            pointerEvents: 'auto',
            width: expanded ? 'min(890px, calc(100% - 20px))' : 'min(580px, calc(100% - 16px))',
            margin: '0 auto',
            border: expanded ? '1px solid rgba(220,230,240,.18)' : '1px solid rgba(235,225,204,.34)',
            borderRadius: expanded ? 25 : 999,
            background: themeMode === 'night'
              ? (expanded ? 'rgba(25,32,41,.53)' : 'rgba(25,32,41,.28)')
              : (expanded ? 'rgba(25,32,41,.64)' : 'rgba(25,32,41,.40)'),
            color: '#e7edf4',
            boxShadow: expanded ? '0 16px 52px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.17), inset 0 -1px 0 rgba(255,255,255,.055)' : '0 10px 32px rgba(0,0,0,.26), inset 0 1px 0 rgba(255,255,255,.24), inset 0 -1px 0 rgba(255,255,255,.07)',
            backdropFilter: 'blur(40px) saturate(190%)',
            WebkitBackdropFilter: 'blur(40px) saturate(190%)',
            overflow: 'hidden',
            willChange: 'height, width',
            transition: 'height .26s cubic-bezier(.22,.61,.36,1), width .26s cubic-bezier(.22,.61,.36,1), border-radius .22s ease, border-color .2s ease, background .22s ease, box-shadow .22s ease',
          }}
        >
            <div
              ref={compactContentRef}
              className="mb-playback-compact"
              aria-hidden={expanded}
              style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: '100%', boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', gap: 4, minHeight: 27, padding: '4px 7px 4px 10px',
                opacity: expanded ? 0 : 1,
                transform: expanded ? 'translateY(-5px) scale(.99)' : 'translateY(0) scale(1)',
                visibility: expanded ? 'hidden' : 'visible',
                pointerEvents: expanded ? 'none' : 'auto',
                transition: expanded ? 'opacity .14s ease, transform .22s cubic-bezier(.22,.61,.36,1), visibility 0s linear .22s' : 'opacity .16s ease, transform .22s cubic-bezier(.22,.61,.36,1), visibility 0s linear 0s',
              }}
            >
              <span style={{ minWidth: 29, fontSize: 10, color: '#d2c09a', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatPlaybackTime(displayedTime).split('.')[0]}</span>
              <div style={{ flex: 1, minWidth: 25, display: 'flex', alignItems: 'center' }}>{progress}</div>
              <span aria-label="整首歌曲時長" title="整首歌曲時長" style={{ minWidth: 29, fontSize: 10, color: '#d2c09a', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatPlaybackTime(duration).split('.')[0]}</span>
              <button type="button" disabled={!props.ready} onClick={() => props.onSkip(-3)} aria-label="後退 3 秒" title="後退 3 秒" style={{ ...buttonStyle(), minHeight: 25, height: 25, minWidth: 31, width: 31, padding: 0, borderRadius: 8, fontSize: 9 }}>−3s</button>
              <button type="button" data-primary="true" disabled={!props.ready} onClick={() => void startOrTogglePlayback()} aria-label={isCountingIn ? '取消預備拍' : props.playing ? '暫停' : '播放'} title={isCountingIn ? '取消預備拍' : props.playing ? '暫停' : '播放'} style={{ ...buttonStyle(true), minHeight: 25, height: 25, width: 31, minWidth: 31, padding: 0, borderRadius: 7, fontSize: 12 }}>{isCountingIn ? '…' : props.playing ? 'Ⅱ' : '▶'}</button>
              <button type="button" disabled={!props.ready} onClick={() => props.onSkip(3)} aria-label="前進 3 秒" title="前進 3 秒" style={{ ...buttonStyle(), minHeight: 25, height: 25, minWidth: 31, width: 31, padding: 0, borderRadius: 8, fontSize: 9 }}>+3s</button>
              <button type="button" onClick={() => props.onAutoFollowChange(!props.autoFollow)} aria-label={props.autoFollow ? '關閉自動跟隨' : '開啟自動跟隨'} title={props.autoFollow ? '自動跟隨：開，點擊關閉' : '自動跟隨：關，點擊開啟'} aria-pressed={props.autoFollow} style={{ ...buttonStyle(false, props.autoFollow), minHeight: 25, height: 25, width: 29, minWidth: 29, padding: 0, borderRadius: 7, fontSize: 11 }}>◎</button>
              <button
                type="button"
                onClick={() => {
                  if (props.theoryOpen) props.onToggleTheory?.()
                  transitionExpandedRef.current(true)
                }}
                aria-label="展開播放控制欄"
                title={props.theoryOpen ? '關閉樂理分析並展開播放控制欄' : '展開播放控制欄'}
                style={{ ...buttonStyle(false, true), minHeight: 25, height: 25, width: 29, minWidth: 29, padding: 0, borderRadius: 7, fontSize: 12 }}
              >⌃</button>
            </div>
            <div
              ref={expandedContentRef}
              className="mb-playback-expanded"
              aria-hidden={!expanded}
              style={{
                position: 'absolute', top: 0, left: 0, right: 0, boxSizing: 'border-box', width: '100%', padding: '10px 16px 8px',
                opacity: expanded ? 1 : 0,
                transform: expanded ? 'translateY(0) scale(1)' : 'translateY(8px) scale(.995)',
                visibility: expanded ? 'visible' : 'hidden',
                pointerEvents: expanded ? 'auto' : 'none',
                transition: expanded ? 'opacity .16s ease, transform .22s cubic-bezier(.22,.61,.36,1), visibility 0s linear 0s' : 'opacity .14s ease, transform .22s cubic-bezier(.22,.61,.36,1), visibility 0s linear .22s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div className="mb-playback-title" style={{ flex: 1, color: '#d0b985', fontSize: 12, fontWeight: 850, letterSpacing: 1.7 }}>SCORE PLAYBACK</div>
                <button type="button" onClick={() => transitionExpandedRef.current(false)} style={{ ...buttonStyle(), minHeight: 34 }}>⌄ 隱藏控制</button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 7 }}>
                <button type="button" disabled={!props.ready} onClick={() => props.onSkip(-5)} style={{ ...buttonStyle(), minHeight: 42, minWidth: 78, fontSize: 13 }}>↶ 5 秒</button>
                <button type="button" data-primary="true" disabled={!props.ready} onClick={() => void startOrTogglePlayback()} style={{ ...buttonStyle(true), minHeight: 42, minWidth: 95, fontSize: 15 }}>{isCountingIn ? '取消預備拍' : props.playing ? 'Ⅱ 暫停' : '▶ 播放'}</button>
                <button type="button" disabled={!props.ready} onClick={() => props.onSkip(5)} style={{ ...buttonStyle(), minHeight: 42, minWidth: 78, fontSize: 13 }}>5 秒 ↷</button>
                <button type="button" onClick={() => props.onAutoFollowChange(!props.autoFollow)} aria-pressed={props.autoFollow} aria-label={props.autoFollow ? '關閉自動跟隨' : '開啟自動跟隨'} title={props.autoFollow ? '自動跟隨：開，點擊關閉' : '自動跟隨：關，點擊開啟'} style={{ ...buttonStyle(false, props.autoFollow), minHeight: 42, minWidth: 95, fontSize: 12 }}>◎ 自動跟隨：{props.autoFollow ? '開' : '關'}</button>
                <button type="button" disabled={!props.ready} onClick={seekToBeginning} aria-label="停止並回到開頭" title="停止並回到開頭" style={{ ...buttonStyle(), boxSizing: 'border-box', width: 100, minWidth: 100, maxWidth: 100, height: 42, minHeight: 42, padding: '4px 6px', fontSize: 10, lineHeight: 1.2, whiteSpace: 'normal' }}>停止並回到開頭</button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#bac5d0', fontSize: 11, fontWeight: 650 }}>
                  速度
                  <select aria-label="播放倍速" value={props.rate} disabled={!props.ready} onChange={event => props.onRateChange(Number(event.currentTarget.value))} style={selectStyle}>
                    {RATES.map(value => <option key={value} value={value} style={optionStyle}>{value.toFixed(1)}×</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => void toggleMetronome()} aria-pressed={metronomeEnabled} title="節拍器依 MusicXML 速度與拍號跟隨 MP3 播放時鐘" style={{ ...buttonStyle(false, metronomeEnabled), minHeight: 30, padding: '4px 9px' }}>♩ 節拍器：{metronomeEnabled ? '開' : '關'}</button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid rgba(220,230,240,.17)', borderRadius: 10, padding: '3px 8px', color: '#bac5d0', fontSize: 11, minHeight: 30 }}>
                  <span>音量</span>
                  <input aria-label="節拍器音量" title="只調整節拍器聲音，不影響 MP3 音量；50% 為基準音量，100% 約為基準的兩倍" type="range" min={0} max={100} step={5} value={metronomeVolume} onChange={event => setMetronomeVolume(Number(event.currentTarget.value))} style={{ width: 88, margin: 0, accentColor: '#d9b779', cursor: 'pointer' }} />
                  <span style={{ width: 31, textAlign: 'right', color: '#e8d3a5', fontVariantNumeric: 'tabular-nums' }}>{metronomeVolume}%</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid rgba(220,230,240,.17)', borderRadius: 10, padding: '2px 8px', color: '#bac5d0', fontSize: 11, minHeight: 30 }}>
                  拍內細分
                  <select aria-label="節拍器拍內細分" value={metronomeSubdivision} onChange={event => setMetronomeSubdivision(Number(event.currentTarget.value) as 1 | 2 | 4)} style={{ ...selectStyle, border: 0, minHeight: 25, padding: '2px 16px 2px 3px', maxWidth: 98 }}>
                    <option value={1} style={optionStyle}>主拍</option>
                    <option value={2} style={optionStyle}>二等分</option>
                    <option value={4} style={optionStyle}>四等分</option>
                  </select>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid rgba(220,230,240,.17)', borderRadius: 10, padding: '2px 8px', color: '#bac5d0', fontSize: 11, minHeight: 30 }}>
                  預備拍
                  <select aria-label="播放前預備拍小節數" value={countInBars} onChange={event => setCountInBars(Number(event.currentTarget.value) as 0 | 1 | 2)} style={{ ...selectStyle, border: 0, minHeight: 25, padding: '2px 16px 2px 3px', maxWidth: 91 }}>
                    <option value={0} style={optionStyle}>關閉</option>
                    <option value={1} style={optionStyle}>1 小節</option>
                    <option value={2} style={optionStyle}>2 小節</option>
                  </select>
                </label>
                <span style={{ color: '#9ba6b1', fontSize: 10, whiteSpace: 'nowrap' }}>{config.meter} · {subdivisionLabel} · 跟隨樂譜速度 {Math.round(config.bpm)} BPM</span>
              </div>

              {canLoop && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 7, marginBottom: 6 }}>
                <button type="button" disabled={!props.ready} onClick={props.onMarkLoopStart} style={buttonStyle(Boolean(props.loopStart !== null && props.loopStart !== undefined))}>設 A 點</button>
                <button type="button" disabled={!props.ready} onClick={props.onMarkLoopEnd} style={buttonStyle(Boolean(props.loopEnd !== null && props.loopEnd !== undefined))}>設 B 點</button>
                <button type="button" disabled={!props.ready || (props.loopStart == null && props.loopEnd == null)} onClick={props.onClearLoop} style={buttonStyle()}>清除 A/B</button>
                <span style={{ color: props.loopEnabled ? '#e8cf95' : '#9ba6b1', fontSize: 11, whiteSpace: 'nowrap' }}>
                  A/B：{props.loopStart == null ? '未設 A' : formatPlaybackTime(props.loopStart)} → {props.loopEnd == null ? '未設 B' : formatPlaybackTime(props.loopEnd)}{props.loopEnabled ? ' · 循環中' : ''}
                </span>
              </div>}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                <span style={{ fontSize: 12, color: '#d8c49c', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatPlaybackTime(displayedTime)}</span>
                <div style={{ flex: 1, minWidth: 30, display: 'flex', alignItems: 'center' }}>{progress}</div>
                <span style={{ fontSize: 12, color: '#d8c49c', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatPlaybackTime(duration)}</span>
              </div>
              <div className="mb-playback-shortcuts" style={{ textAlign: 'center', marginTop: 5, color: '#aeb8c3', fontSize: 10, lineHeight: 1.35 }}>
                快捷鍵：空格 播放/暫停 · ←/→ 後退/前進 5 秒 · Home 回到開頭 · Esc 關閉面板
              </div>
            </div>
        </div>
      </div>
    </>
  )
}
