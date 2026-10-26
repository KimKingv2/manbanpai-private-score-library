import { useEffect, useState } from 'react'

export type ManbanpaiTheme = 'day' | 'night'
const THEME_KEY = 'manbanpai-theme-mode-v1'
const THEME_EVENT = 'manbanpai-theme-change'

function readTheme(): ManbanpaiTheme {
  if (typeof window === 'undefined') return 'night'
  try {
    return window.localStorage.getItem(THEME_KEY) === 'day' ? 'day' : 'night'
  } catch {
    return 'night'
  }
}

function applyTheme(theme: ManbanpaiTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.manbanpaiTheme = theme
  document.documentElement.style.colorScheme = theme === 'day' ? 'light' : 'dark'
}

function setTheme(theme: ManbanpaiTheme) {
  applyTheme(theme)
  try { window.localStorage.setItem(THEME_KEY, theme) } catch { /* private mode may block storage */ }
  window.dispatchEvent(new CustomEvent<ManbanpaiTheme>(THEME_EVENT, { detail: theme }))
}

const THEME_CSS = `
:root { color-scheme: dark; }
html[data-manbanpai-theme="day"] { color-scheme: light; background:#f3f0e8; }
html[data-manbanpai-theme="night"] { color-scheme: dark; background:#0b1017; }
body { transition: background-color .22s ease, color .22s ease; }
html[data-manbanpai-theme="day"] body { background:#f3f0e8 !important; color:#2c3331 !important; }
html[data-manbanpai-theme="night"] body { background:#0b1017 !important; color:#edf2f8 !important; }

.mb-theme-toggle { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:36px; padding:7px 12px; border-radius:999px; font:600 11.5px/1.1 "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; letter-spacing:.15px; white-space:nowrap; cursor:pointer; transition:background .18s ease,border-color .18s ease,color .18s ease,box-shadow .18s ease,transform .18s ease; }
.mb-theme-toggle:hover { transform:translateY(-1px); }
.mb-theme-toggle:focus-visible { outline:2px solid #c7a568; outline-offset:3px; }
.mb-theme-toggle-icon { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:50%; font-size:15px; line-height:1; }
html[data-manbanpai-theme="night"] .mb-theme-toggle { color:#eedcb8; background:linear-gradient(180deg,rgba(35,44,54,.96),rgba(20,27,36,.96)); border:1px solid rgba(217,183,121,.36); box-shadow:0 5px 17px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.045); }
html[data-manbanpai-theme="night"] .mb-theme-toggle-icon { color:#f0d7a5; background:rgba(217,183,121,.12); }
html[data-manbanpai-theme="day"] .mb-theme-toggle { color:#5d4828; background:linear-gradient(180deg,rgba(255,253,247,.98),rgba(245,239,226,.98)); border:1px solid rgba(142,109,54,.3); box-shadow:0 4px 15px rgba(86,68,39,.09), inset 0 1px 0 rgba(255,255,255,.92); }
html[data-manbanpai-theme="day"] .mb-theme-toggle-icon { color:#85652f; background:rgba(178,142,79,.13); }
.mb-reader-header-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; }

/* Library: warm editorial paper palette by day, deep graphite palette by night. */
html[data-manbanpai-theme="day"] .score-library-page {
  --sl-bg:#f3f0e8 !important; --sl-panel:#fffdf7 !important; --sl-panel-2:#f6f1e7 !important; --sl-panel-hover:#eee6d8 !important;
  --sl-line:rgba(124,100,61,.15) !important; --sl-line-strong:rgba(124,100,61,.26) !important;
  --sl-text:#2c3331 !important; --sl-muted:#65706c !important; --sl-muted-2:#7f8982 !important;
  --sl-gold:#8d6a32 !important; --sl-gold-dark:#70532a !important;
  color:#2c3331 !important; color-scheme:light !important;
  background:radial-gradient(ellipse at 12% -10%,rgba(204,175,123,.19),transparent 38%),radial-gradient(ellipse at 100% 0%,rgba(138,118,81,.08),transparent 30%),#f3f0e8 !important;
}
html[data-manbanpai-theme="day"] .score-library-title { color:#28312f !important; }
html[data-manbanpai-theme="day"] .score-library-kim { color:#8d6a32 !important; }
html[data-manbanpai-theme="day"] .score-library-subtitle,
html[data-manbanpai-theme="day"] .score-library-meta-chip,
html[data-manbanpai-theme="day"] .score-library-item-meta { color:#65706c !important; }
html[data-manbanpai-theme="day"] .score-library-button { color:#3e4641 !important; border-color:#d8cdbb !important; background:linear-gradient(180deg,#fffdf8,#f4eee3) !important; box-shadow:0 3px 10px rgba(65,51,31,.045) !important; }
html[data-manbanpai-theme="day"] .score-library-button:hover { color:#604a29 !important; background:#efe4ce !important; border-color:#c5ab79 !important; }
html[data-manbanpai-theme="day"] .score-library-button-primary { color:#fffaf0 !important; background:linear-gradient(135deg,#9b7a42,#76582f) !important; border-color:#92703a !important; }
html[data-manbanpai-theme="day"] .score-library-panel { background:linear-gradient(155deg,#fffdf8,#f8f4eb) !important; border-color:#ded5c6 !important; box-shadow:0 15px 40px rgba(67,52,31,.075) !important; }
html[data-manbanpai-theme="day"] .score-library-controls { background:rgba(125,100,58,.035) !important; border-color:#e4dacb !important; }
html[data-manbanpai-theme="day"] .score-library-input,
html[data-manbanpai-theme="day"] .score-library-select { color:#303936 !important; background:#fffdf8 !important; border-color:#d9cebc !important; }
html[data-manbanpai-theme="day"] .score-library-input::placeholder { color:#92968e !important; }
html[data-manbanpai-theme="day"] .score-library-select option { color:#303936 !important; background:#fffdf8 !important; }
html[data-manbanpai-theme="day"] .score-library-chip { color:#646d67 !important; background:rgba(132,105,59,.035) !important; border-color:#e0d7c8 !important; }
html[data-manbanpai-theme="day"] .score-library-chip.active { color:#6f5225 !important; background:#eee2c8 !important; border-color:#c9ad77 !important; }
html[data-manbanpai-theme="day"] .score-library-item { color:#303835 !important; border-bottom-color:rgba(124,100,61,.11) !important; }
html[data-manbanpai-theme="day"] .score-library-item:hover { background:#f2ecdf !important; border-color:#e0d2b8 !important; }
html[data-manbanpai-theme="day"] .score-library-status { color:#745b30 !important; background:rgba(186,148,75,.07) !important; border-color:rgba(148,112,48,.23) !important; }
html[data-manbanpai-theme="day"] .score-library-file-status { color:#735a2d !important; background:#f4ebd9 !important; border-color:#dfcfad !important; }
html[data-manbanpai-theme="day"] .score-library-reader-head { background:linear-gradient(145deg,#fffdf8,#f2ebde) !important; border-color:#ded3c0 !important; box-shadow:0 10px 28px rgba(67,52,31,.07) !important; }
html[data-manbanpai-theme="day"] .score-library-reader-title { color:#2e3532 !important; }
html[data-manbanpai-theme="day"] .score-library-reader-meta { color:#68716c !important; }
html[data-manbanpai-theme="day"] .score-library-modal { color:#303835 !important; background:#fffdf7 !important; border-color:#ded3bf !important; box-shadow:0 22px 80px rgba(49,39,24,.22) !important; }
html[data-manbanpai-theme="day"] .score-library-modal h1,
html[data-manbanpai-theme="day"] .score-library-modal h2,
html[data-manbanpai-theme="day"] .score-library-modal h3 { color:#2d3431 !important; }
html[data-manbanpai-theme="day"] .score-library-field-label { color:#5e6862 !important; }

/* Reader shells and controls. Canvas-rendered PDF pages stay untouched and white. */
html[data-manbanpai-theme="day"] .manbanpai-reader-page { background:#f3f0e8 !important; color:#2c3331 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page h1,
html[data-manbanpai-theme="day"] .manbanpai-reader-page h2,
html[data-manbanpai-theme="day"] .manbanpai-reader-page h3 { color:#2c3331 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page p { color:#5d6763; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel { background:rgba(255,253,247,.985) !important; color:#303734 !important; border-color:#ded3c1 !important; box-shadow:0 22px 64px rgba(62,48,28,.16) !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel [style*="rgba(255"] { background:rgba(110,88,51,.045) !important; border-color:rgba(125,99,55,.16) !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel [style*="rgba(0, 0, 0"] { background:#f5f0e6 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud { background:rgba(255,253,247,.97) !important; color:#303734 !important; border-color:rgba(150,116,57,.5) !important; box-shadow:0 10px 30px rgba(61,48,29,.16) !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud strong { color:#795c2d !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud span { color:#5d6762 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud button { color:#775a2b !important; background:#f2e7d1 !important; border-color:#d7bd8c !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="rgba(255, 255, 255"] { background-color:rgba(103,83,48,.045) !important; border-color:rgba(116,94,59,.16) !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="rgba(17, 24, 33"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="rgba(17, 25, 35"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#182331"] { background:#fffdf7 !important; color:#303734 !important; border-color:#ded3c1 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#e9edf2"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#edf2f8"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#e5ebf2"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#d4dbe3"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#c4ced8"] { color:#333b37 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#aab4bf"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#9ba6b1"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#87929e"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#8794a0"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#98a4b0"],
html[data-manbanpai-theme="day"] .manbanpai-reader-page [style*="#929eaa"] { color:#727a73 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page input:not([type="range"]),
html[data-manbanpai-theme="day"] .manbanpai-reader-page select,
html[data-manbanpai-theme="day"] .manbanpai-reader-page textarea { color:#303734 !important; background:#fffdf7 !important; border-color:#d8cdbb !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page button { border-color:#d7cbb7 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page button[aria-pressed="true"] { color:#76592b !important; background:#eee2c8 !important; border-color:#c7a96d !important; }
html[data-manbanpai-theme="day"] .mb-header-control-bar { background:rgba(255,253,247,.92) !important; color:#303734 !important; border-color:#ded3c1 !important; box-shadow:0 4px 14px rgba(70,54,30,.04) !important; }
html[data-manbanpai-theme="day"] .mb-header-control-bar button { color:#414944 !important; background:#fffdf7 !important; border-color:#d7cbb7 !important; }
html[data-manbanpai-theme="day"] .mb-header-control-bar button[aria-pressed="true"] { color:#76592b !important; background:#eee2c8 !important; border-color:#c7a96d !important; }
html[data-manbanpai-theme="day"] .mb-header-control-bar span { color:#606a64 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel { background:rgba(255,253,247,.97) !important; color:#303734 !important; border-color:#ded3c1 !important; box-shadow:0 -6px 28px rgba(70,54,30,.12) !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel button:not([data-primary="true"]) { color:#414944 !important; background:#fffdf7 !important; border-color:#d7cbb7 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel button[aria-pressed="true"]:not([data-primary="true"]) { color:#76592b !important; background:#eee2c8 !important; border-color:#c7a96d !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel select { color:#303734 !important; background:#fffdf7 !important; border-color:#d7cbb7 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel span,
html[data-manbanpai-theme="day"] .mb-playback-panel label { color:#5d6762 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel input[type="range"] { accent-color:#8d6a32 !important; }
html[data-manbanpai-theme="day"] .mb-reader-header-actions { color:#2c3331 !important; }

/* Stronger day-mode contrast for score titles, artists, chord labels and selected-measure HUD. */
html[data-manbanpai-theme="day"] .score-library-item-title { color:#202723 !important; }
html[data-manbanpai-theme="day"] .score-library-item.active .score-library-item-title { color:#4f3918 !important; }
html[data-manbanpai-theme="day"] .score-library-item-artist { color:#3f4a44 !important; }
html[data-manbanpai-theme="day"] .score-library-item-meta { color:#46524b !important; }
html[data-manbanpai-theme="day"] .score-library-meta-chip { color:#3f4943 !important; }
html[data-manbanpai-theme="day"] .score-library-meta-chip-type { color:#63491e !important; }
html[data-manbanpai-theme="day"] .score-library-meta-chip-music { color:#344a40 !important; }
html[data-manbanpai-theme="day"] .score-library-cover-glyph { color:#6c532b !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel [style*="color:"] { color:#29332e !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel strong,
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel h3 { color:#3d321f !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel button { color:#3b3325 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-theory-panel button[aria-pressed="true"] { color:#533d17 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud [style*="color:"] { color:#29332e !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud strong { color:#573f18 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud span { color:#38443d !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud button { color:#4c3919 !important; }
html[data-manbanpai-theme="day"] .manbanpai-reader-page .score-room-current-theory-hud [aria-pressed="true"] { color:#4c3919 !important; }

/* Theme the paper surface itself while keeping notation readable. The day filter is intentionally subtle;
   the night filter inverts monochrome score rendering to make a dark paper without losing note contrast. */
html[data-manbanpai-theme="day"] .piano-pdf-page,
html[data-manbanpai-theme="day"] .manbanpai-pdf-page {
  background:#fbf8f0 !important;
  border:1px solid #d9cdb7 !important;
  box-shadow:0 8px 28px rgba(74,57,31,.16) !important;
  transition:background-color .22s ease, border-color .22s ease, box-shadow .22s ease;
}
html[data-manbanpai-theme="day"] .piano-pdf-page canvas {
  background:#fbf8f0 !important;
  filter:sepia(.085) saturate(.94) brightness(.995);
  transition:filter .22s ease, background-color .22s ease;
}
/* Guitar vocal and fingerstyle PDFs follow the active paper theme, while their overlay layers remain untouched. */
html[data-manbanpai-theme="day"] .manbanpai-pdf-page canvas {
  background:#fbf8f0 !important;
  filter:sepia(.085) saturate(.94) brightness(.995);
  transition:filter .22s ease, background-color .22s ease;
}
html[data-manbanpai-theme="night"] .manbanpai-pdf-page canvas {
  background:#171d25 !important;
  filter:invert(.88) hue-rotate(180deg) brightness(.94) contrast(.96);
  transition:filter .22s ease, background-color .22s ease;
}
html[data-manbanpai-theme="night"] .piano-pdf-page,
html[data-manbanpai-theme="night"] .manbanpai-pdf-page {
  background:#171d25 !important;
  border:1px solid #37414d !important;
  box-shadow:0 9px 32px rgba(0,0,0,.42) !important;
  transition:background-color .22s ease, border-color .22s ease, box-shadow .22s ease;
}
html[data-manbanpai-theme="night"] .piano-pdf-page canvas {
  background:#171d25 !important;
  filter:invert(.88) hue-rotate(180deg) brightness(.94) contrast(.96);
  transition:filter .22s ease, background-color .22s ease;
}
html[data-manbanpai-theme="day"] .piano-pdf-page [data-measure-number],
html[data-manbanpai-theme="day"] .manbanpai-pdf-page [data-measure-number] { text-shadow:0 1px 0 rgba(255,252,244,.75); }
html[data-manbanpai-theme="night"] .piano-pdf-page [data-measure-number],
html[data-manbanpai-theme="night"] .manbanpai-pdf-page [data-measure-number] { text-shadow:0 1px 0 rgba(12,16,22,.6); }


/* High-contrast mapping notice and explicit guitar setup palette. */
.mb-score-mapping-notice {
  border:1px solid rgba(217,183,121,.34);
  background:linear-gradient(105deg,rgba(217,183,121,.13),rgba(217,183,121,.06));
  color:#f1d7a0;
  box-shadow:0 4px 18px rgba(0,0,0,.035);
}
html[data-manbanpai-theme="day"] .mb-score-mapping-notice {
  border-color:#c9a65e !important;
  background:linear-gradient(105deg,#f5e8cc,#fbf4e6) !important;
  color:#574018 !important;
  box-shadow:0 4px 16px rgba(76,57,23,.07) !important;
}
html[data-manbanpai-theme="night"] .mb-score-mapping-notice {
  border-color:#715d3d !important;
  background:linear-gradient(105deg,#282b2d,#1c242d) !important;
  color:#f0d7a0 !important;
}
html[data-manbanpai-theme="day"] .mb-guitar-settings-panel { color:#27332d !important; }
html[data-manbanpai-theme="night"] .mb-guitar-settings-panel { color:#e8edf3 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel button[data-primary="true"] { color:#1b2026 !important; background:linear-gradient(145deg,#f0d99f,#d4ad61) !important; border-color:#b89655 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel .mb-playback-compact span,
html[data-manbanpai-theme="day"] .mb-playback-panel .mb-playback-expanded span { color:#5c5140 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel .mb-playback-title { color:#65491c !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel .mb-playback-shortcuts { color:#4d5851 !important; }
html[data-manbanpai-theme="day"] .mb-playback-panel .mb-playback-expanded div[style*="SCORE PLAYBACK"] { color:#72521f !important; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
`

function ensureThemeStyles() {
  if (typeof document === 'undefined' || document.getElementById('manbanpai-theme-styles')) return
  const style = document.createElement('style')
  style.id = 'manbanpai-theme-styles'
  style.textContent = THEME_CSS
  document.head.appendChild(style)
}

export function useManbanpaiTheme(): ManbanpaiTheme {
  const [theme, setThemeState] = useState<ManbanpaiTheme>(readTheme)
  useEffect(() => {
    ensureThemeStyles()
    applyTheme(theme)
    const onThemeChange = (event: Event) => {
      const next = (event as CustomEvent<ManbanpaiTheme>).detail
      if (next === 'day' || next === 'night') setThemeState(next)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_KEY) setThemeState(event.newValue === 'day' ? 'day' : 'night')
    }
    window.addEventListener(THEME_EVENT, onThemeChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(THEME_EVENT, onThemeChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [theme])
  return theme
}

export function ManbanpaiThemeToggle() {
  const theme = useManbanpaiTheme()
  const nextTheme: ManbanpaiTheme = theme === 'night' ? 'day' : 'night'
  const label = nextTheme === 'day' ? '日間模式' : '夜間模式'
  return (
    <button
      type="button"
      className="mb-theme-toggle"
      aria-label={`切換至${label}`}
      title={`切換至${label}；偏好會保存在這台裝置`}
      onClick={() => setTheme(nextTheme)}
    >
      <span aria-hidden="true" className="mb-theme-toggle-icon">{nextTheme === 'day' ? '☼' : '☾'}</span>
      <span>{label}</span>
    </button>
  )
}
