import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Sequencer, WorkletSynthesizer } from 'spessasynth_lib'

type MidiSequencer = InstanceType<typeof Sequencer>
type MidiSynth = InstanceType<typeof WorkletSynthesizer>

const panelStyle: CSSProperties = {
  width: 'min(760px, calc(100% - 32px))',
  margin: '40px auto',
  padding: 24,
  border: '1px solid rgba(217,183,121,.35)',
  borderRadius: 16,
  background: '#111923',
  color: '#edf2f8',
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  boxSizing: 'border-box',
}

const labelStyle: CSSProperties = { display: 'block', marginBottom: 8, fontWeight: 600 }
const buttonStyle: CSSProperties = {
  border: '1px solid rgba(217,183,121,.5)',
  borderRadius: 9,
  padding: '9px 14px',
  color: '#f4dfb6',
  background: '#202c3a',
  cursor: 'pointer',
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export default function MidiTest() {
  const contextRef = useRef<AudioContext | null>(null)
  const sequencerRef = useRef<MidiSequencer | null>(null)
  const synthRef = useRef<MidiSynth | null>(null)
  const [soundFontName, setSoundFontName] = useState('尚未載入音源')
  const [midiName, setMidiName] = useState('尚未載入 MIDI')
  const [status, setStatus] = useState('先載入 GM 音源，再選擇你的 MIDI 檔。')
  const [busy, setBusy] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [midiLoaded, setMidiLoaded] = useState(false)
  const [rate, setRate] = useState(1)

  useEffect(() => {
    const timer = window.setInterval(() => {
      const seq = sequencerRef.current
      if (!seq) return
      const d = Number(seq.duration) || 0
      const t = Number(seq.currentTime) || 0
      setDuration(d)
      setCurrentTime(Math.min(t, d || t))
      setPlaying(!seq.paused)
    }, 180)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => () => {
    try { sequencerRef.current?.pause() } catch { /* no-op during unmount */ }
    const ctx = contextRef.current
    if (ctx && ctx.state !== 'closed') void ctx.close()
  }, [])

  const loadSoundFont = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true)
    setStatus('正在初始化音源引擎並載入音色，首次載入可能需要一些時間…')
    try {
      const previousContext = contextRef.current
      if (previousContext && previousContext.state !== 'closed') await previousContext.close()
      sequencerRef.current = null
      setMidiLoaded(false)
      synthRef.current = null
      contextRef.current = null

      const context = new AudioContext()
      contextRef.current = context
      await context.audioWorklet.addModule('/spessasynth_processor.min.js')
      const synth = new WorkletSynthesizer(context)
      synth.connect(context.destination)
      await synth.soundBankManager.addSoundBank(await file.arrayBuffer(), 'main')
      await synth.isReady
      synthRef.current = synth
      sequencerRef.current = new Sequencer(synth)
      setSoundFontName(file.name)
      setStatus('GM 音源載入成功。現在選擇 MIDI 檔即可播放。')
      setDuration(0)
      setCurrentTime(0)
    } catch (error) {
      setStatus(`音源載入失敗：${error instanceof Error ? error.message : String(error)}。請確認檔案是有效的 .sf2、.sf3 或 .dls。`)
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  const loadMidi = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const seq = sequencerRef.current
    if (!seq) {
      setStatus('請先載入 GM 音源，再選 MIDI 檔。')
      event.target.value = ''
      return
    }
    setBusy(true)
    setStatus(`正在載入 ${file.name}…`)
    try {
      seq.pause()
      setMidiLoaded(false)
      const binary = await file.arrayBuffer()
      seq.loadNewSongList([{ binary, fileName: file.name }])
      setMidiName(file.name)
      setMidiLoaded(true)
      seq.play()
      setRate(Number(seq.playbackRate) || 1)
      setCurrentTime(0)
      setStatus('MIDI 已交給 Sequencer 播放。若沒有聲音，請查看下方排查提示。')
      // loadNewSongList parses asynchronously inside the sequencer; the polling loop updates duration.
    } catch (error) {
      setStatus(`MIDI 載入失敗：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  const togglePlayback = async () => {
    const seq = sequencerRef.current
    const context = contextRef.current
    if (!seq || !context) {
      setStatus('請先載入 GM 音源和 MIDI 檔。')
      return
    }
    try {
      await context.resume()
      if (seq.paused) seq.play()
      else seq.pause()
      setPlaying(!seq.paused)
    } catch (error) {
      setStatus(`播放操作失敗：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const stopPlayback = () => {
    const seq = sequencerRef.current
    if (!seq) return
    seq.pause()
    seq.currentTime = 0
    setCurrentTime(0)
    setPlaying(false)
  }

  const seek = (value: number) => {
    const seq = sequencerRef.current
    if (!seq || !Number.isFinite(value)) return
    seq.currentTime = value
    setCurrentTime(value)
  }

  const changeRate = (value: number) => {
    setRate(value)
    if (sequencerRef.current) sequencerRef.current.playbackRate = value
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0b1017', padding: '1px 0 40px', boxSizing: 'border-box' }}>
      <section style={panelStyle}>
        <div style={{ color: '#d9b779', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' }}>LOCAL MIDI ENGINE TEST</div>
        <h1 style={{ margin: '10px 0 6px', fontSize: 26 }}>慢半拍譜間 · MIDI 播放測試</h1>
        <p style={{ marginTop: 0, color: '#b7c4d3', lineHeight: 1.65 }}>
          這是獨立測試頁，不會取代 PDF/XML 實驗播放器，也不會上傳你從檔案選擇器挑選的 MIDI 或音源檔。
        </p>

        <div style={{ margin: '22px 0', padding: 16, borderRadius: 12, background: '#182331' }}>
          <label style={labelStyle} htmlFor="midi-test-sf">1. 載入 GM 音源（SF2 / SF3 / DLS）</label>
          <input id="midi-test-sf" type="file" accept=".sf2,.sf3,.dls,application/octet-stream" disabled={busy} onChange={loadSoundFont} style={{ display: 'block', width: '100%', color: '#dbe5ef' }} />
          <p style={{ marginBottom: 0, color: '#d9b779', overflowWrap: 'anywhere' }}>目前音源：{soundFontName}</p>
        </div>

        <div style={{ margin: '22px 0', padding: 16, borderRadius: 12, background: '#182331' }}>
          <label style={labelStyle} htmlFor="midi-test-file">2. 選擇你已生成的 MIDI（MID / MIDI）</label>
          <input id="midi-test-file" type="file" accept=".mid,.midi,.rmi,.xmf,.mxmf,application/octet-stream" disabled={busy || !synthRef.current} onChange={loadMidi} style={{ display: 'block', width: '100%', color: '#dbe5ef' }} />
          <p style={{ marginBottom: 0, color: '#d9b779', overflowWrap: 'anywhere' }}>目前曲目：{midiName}</p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
          <button type="button" style={buttonStyle} onClick={() => void togglePlayback()} disabled={busy || !sequencerRef.current || !midiLoaded}>{playing ? '暫停' : '播放 / 繼續'}</button>
          <button type="button" style={buttonStyle} onClick={stopPlayback} disabled={!sequencerRef.current}>停止並回到開頭</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#c8d4e2' }}>
            速度
            <select value={rate} onChange={e => changeRate(Number(e.target.value))} style={{ background: '#202c3a', color: '#edf2f8', border: '1px solid #475569', borderRadius: 8, padding: '8px 10px' }}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: '#c8d4e2', fontVariantNumeric: 'tabular-nums' }}>
            <span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span>
          </div>
          <input aria-label="MIDI 播放進度" type="range" min={0} max={Math.max(duration, 0.1)} step={0.01} value={Math.min(currentTime, Math.max(duration, 0.1))} onChange={e => seek(Number(e.target.value))} disabled={duration <= 0} style={{ width: '100%', accentColor: '#d9b779' }} />
        </div>

        <div role="status" style={{ marginTop: 18, padding: 14, border: '1px solid rgba(217,183,121,.25)', borderRadius: 10, color: '#e5d3ae', lineHeight: 1.6, overflowWrap: 'anywhere' }}>{status}</div>

        <div style={{ marginTop: 20, color: '#9eafc2', fontSize: 13, lineHeight: 1.7 }}>
          <strong style={{ color: '#c8d4e2' }}>若沒有聲音：</strong>先確認瀏覽器音量、MIDI 檔本身有音符，並且音源已載入完成。這個測試只驗證 MIDI 的發聲、暫停、跳轉和變速；尚未接入 PDF 游標或 XML 小節映射。
        </div>
      </section>
    </main>
  )
}
