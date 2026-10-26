type GuitarFingeringDiagramProps = {
  chordSymbol?: string | null
  onClose: () => void
}

type ShapeQuality = 'major' | 'minor' | '7' | 'maj7' | 'm7'

const ROOT_TO_FRET: Record<string, number> = {
  E: 0, F: 1, 'F#': 2, Gb: 2, G: 3, 'G#': 4, Ab: 4, A: 5,
  'A#': 6, Bb: 6, B: 7, C: 8, 'C#': 9, Db: 9, D: 10, 'D#': 11, Eb: 11,
}

function resolveShape(symbol?: string | null): { label: string; frets: number[]; baseFret: number } | null {
  if (!symbol) return null
  const normalized = symbol.replace(/♭/g, 'b').replace(/♯/g, '#').replace(/Δ7|△7/g, 'maj7').replace(/Δ/g, 'maj7').trim()
  const match = normalized.match(/^([A-G])([#b]?)(.*)$/i)
  if (!match) return null
  const root = `${match[1].toUpperCase()}${match[2]}`
  const suffix = match[3].replace(/^[:\s]+/, '').split('/')[0].replace(/[()\s]/g, '')
  let quality: ShapeQuality
  if (/^(maj7|M7|Maj7)$/i.test(suffix)) quality = 'maj7'
  else if (/^(m7|min7|-7)$/i.test(suffix)) quality = 'm7'
  else if (/^(m|min|-)$/i.test(suffix)) quality = 'minor'
  else if (/^7$/i.test(suffix)) quality = '7'
  else if (/^(|maj|M)$/i.test(suffix)) quality = 'major'
  else return null
  const rootFret = ROOT_TO_FRET[root]
  if (rootFret === undefined) return null
  let frets: number[]
  switch (quality) {
    case 'major': frets = [rootFret, rootFret + 2, rootFret + 2, rootFret + 1, rootFret, rootFret]; break
    case 'minor': frets = [rootFret, rootFret + 2, rootFret + 2, rootFret, rootFret, rootFret]; break
    case '7': frets = [rootFret, rootFret + 2, rootFret, rootFret + 1, rootFret, rootFret]; break
    case 'maj7': frets = [rootFret, rootFret + 2, rootFret + 1, rootFret + 1, rootFret, rootFret]; break
    case 'm7': frets = [rootFret, rootFret + 2, rootFret, rootFret, rootFret, rootFret]; break
  }
  // Keep the whole movable E-string shape within a five-fret viewport.
  const positiveFrets = frets.filter(fret => fret > 0)
  const baseFret = Math.max(1, Math.min(...positiveFrets))
  return { label: `${root}${quality === 'minor' ? 'm' : quality === 'maj7' ? 'maj7' : quality === 'm7' ? 'm7' : quality === '7' ? '7' : ''}`, frets, baseFret }
}

export default function GuitarFingeringDiagram({ chordSymbol, onClose }: GuitarFingeringDiagramProps) {
  const shape = resolveShape(chordSymbol)
  const xPositions = [42, 70, 98, 126, 154, 182]
  const top = 40
  const fretHeight = 22
  return (
    <section aria-label="吉他和弦指法圖" style={{ margin: '8px 0 14px', padding: 12, borderRadius: 12, border: '1px solid rgba(217,183,121,.28)', background: 'rgba(17,25,35,.92)', color: '#e7edf4' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ color: '#f1d99b', fontSize: 13, fontWeight: 800 }}>吉他指法圖</div>
          <div style={{ color: '#aeb8c3', fontSize: 11, marginTop: 3 }}>目前和弦：{chordSymbol || '尚未識別'}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="關閉指法圖" style={{ border: '1px solid rgba(255,255,255,.15)', borderRadius: 7, padding: '5px 9px', background: 'rgba(255,255,255,.045)', color: '#e7edf4', cursor: 'pointer' }}>收起</button>
      </div>
      {!shape ? (
        <p style={{ margin: '11px 0 2px', color: '#c5ced8', fontSize: 11.5, lineHeight: 1.6 }}>這個和弦目前沒有對應到內建的常用大調／小調／七和弦指型。請以樂理分析中的和弦與構成音為準。</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 8 }}>
          <svg viewBox="0 0 224 176" width="224" height="176" role="img" aria-label={`${shape.label} 吉他指法圖`} style={{ maxWidth: '100%', height: 'auto' }}>
            <text x="112" y="12" textAnchor="middle" fontSize="10" fill="#aeb8c3">E　A　D　G　B　e</text>
            {xPositions.map((x, index) => <g key={`string-${index}`}>
              <line x1={x} y1={top} x2={x} y2={top + fretHeight * 5} stroke="#94a1ad" strokeWidth={index === 0 || index === 5 ? 1.5 : 1} />
              <text x={x} y="31" textAnchor="middle" fontSize="10" fill={shape.frets[index] === 0 ? '#f1d99b' : '#c5ced8'}>{shape.frets[index] === 0 ? '○' : shape.frets[index] < 0 ? '×' : ''}</text>
            </g>)}
            {Array.from({ length: 6 }, (_, index) => <line key={`fret-${index}`} x1={xPositions[0]} y1={top + index * fretHeight} x2={xPositions[5]} y2={top + index * fretHeight} stroke={shape.baseFret === 1 && index === 0 ? '#e7edf4' : '#667380'} strokeWidth={shape.baseFret === 1 && index === 0 ? 3 : 1} />)}
            {shape.frets.map((fret, index) => fret > 0 ? <circle key={`dot-${index}`} cx={xPositions[index]} cy={top + (fret - shape.baseFret + .5) * fretHeight} r="7" fill="#d9b779" stroke="#fff0ce" strokeWidth=".6" /> : null)}
            {shape.baseFret > 1 && <text x="11" y={top + 12} fontSize="10" fill="#f1d99b">{shape.baseFret}品</text>}
            <text x="112" y="170" textAnchor="middle" fontSize="10" fill="#aeb8c3">標準調弦 · 低音弦至高音弦</text>
          </svg>
          <div style={{ color: '#c5ced8', fontSize: 11, lineHeight: 1.7, maxWidth: 250 }}>
            <div style={{ color: '#f1d99b', fontWeight: 800, fontSize: 14 }}>{shape.label}</div>
            <div>弦序：低音 E → A → D → G → B → 高音 e</div>
            <div>圓點為按弦位置，○ 為空弦，× 為不彈。</div>
            <div style={{ color: '#8e9aa7', marginTop: 4 }}>這是依和弦名稱推定的可移動 E 型指法參考，實際編配與轉位請對照原譜。</div>
          </div>
        </div>
      )}
    </section>
  )
}
