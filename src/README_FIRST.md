# 慢半拍譜間｜三類曲譜四件套整合測試補丁

這是套用到現有 `manbanpai_standalone_project` 的增量補丁，不是整個專案重包。三種類型一律要求 **MusicXML、PDF、MP3、MIDI 四份檔案齊全**；未備齊不會儲存，也不能從曲庫進入正式閱讀頁。

## 四份檔案各自負責什麼

- **MusicXML**：提供音符、小節、節奏與可分析的譜面結構。
- **PDF**：唯一的視覺譜面來源，原樣顯示匯出的樂譜。
- **MP3**：唯一的實際播放音源與播放時鐘。
- **MIDI**：提供事件起音時間，協助把 MusicXML 音符映射到 PDF 並校準播放游標。

這套規則同時適用「鋼琴譜」「吉他彈唱譜」「吉他指彈譜」，沒有例外。

## 0. 這包會改／不會改什麼

會覆蓋／新增：

- `src/App.tsx`
- `src/ScoreLibrary.tsx`
- 新增 `src/GuitarVocalPdfMp3Reader.tsx`
- `functions/api/score-assets/[scoreId]/[kind].ts`
- `functions/api/score-assets-map.ts`
- `src/PianoPdfMp3Test.tsx`、`src/PianoPdfScoreDisplay.tsx`、`src/FingerstylePdfMp3Test.tsx`、`src/FingerstylePdfScoreDisplay.tsx` 與相關分析模組
- `public/piano-pdf-mp3-test/`、`public/fingerstyle-pdf-mp3-test/` 本地示範素材

**不覆蓋 `src/ScoreReader.tsx`**，其原始碼保持原樣。為讓三類主曲庫入口都以 PDF 顯示譜面、以 MP3 播放、以 MIDI 對位，主曲庫中的吉他彈唱路由改為新增的 `GuitarVocalPdfMp3Reader.tsx`，使用既有 `PdfScoreDisplay.tsx`。原本的 `ScoreReader.tsx` 保留作對照；在曲目網址加上 `&legacyVocalReader=1` 可開舊版（例如 `http://localhost:8788/?scoreRoomId=你的曲目ID&legacyVocalReader=1`）。請特別測試新舊閱讀器的差異，避免把「原檔沒有修改」誤解成「主路由完全沒改」。

不覆蓋 `functions/api/[[path]].ts`、`functions/_middleware.ts`、資料庫 migrations、`wrangler.toml`、`.dev.vars`、密碼或 Cloudflare 綁定。新增附件索引沿用既有 D1 `app_state`，二進位檔案存入既有 R2 `DATA`。附件讀取要求登入；上傳／刪除要求管理員權限。

## 1. 套用補丁

1. 在執行本地服務的 PowerShell 按 `Ctrl+C` 停止服務。
2. 將 ZIP 解壓縮到：

   `C:\Users\KimSa\Projects\manbanpai_standalone_project`

3. 保留 ZIP 裡的 `src`、`functions`、`public` 子資料夾結構，只覆蓋同名檔案並新增包內新檔。**不要自行刪除／覆蓋本包未列出的檔案。**
4. `src/GuitarVocalPdfMp3Reader.tsx` 需要既有 `src/PdfScoreDisplay.tsx`；這是舊吉他 PDF 測試頁已用的元件，無需另外替換。
5. 如果建置提示缺少 `pdfjs-dist`，再執行一次：

   ```powershell
   npm.cmd install pdfjs-dist@^4.10.38
   ```

## 2. 建置並啟動本地網站

```powershell
cd "C:\Users\KimSa\Projects\manbanpai_standalone_project"
npm.cmd run build
npx.cmd wrangler pages dev dist --port 8788
```

瀏覽器打開：`http://localhost:8788`，用原本管理員密碼登入。此階段不要執行 `wrangler pages deploy`。

## 3. 單曲匯入：四份全部必填

管理員點「＋ 新增樂譜」，先選 MusicXML，再從同一張表單選 PDF、MP3、MIDI，最後選擇鋼琴／吉他彈唱／吉他指彈類型並儲存。儲存前會驗證 MusicXML 結構，缺少任何一份都會列出缺少項目並阻止儲存。成功後二進位附件上傳 R2，附件索引寫入 D1。

## 4. 批次匯入：按相同主檔名配對四件套

管理員點「批次匯入四件套」，一次選取多首曲目的全部檔案。每首曲目的四份檔案必須使用相同主檔名，例如：

- `小幸運.musicxml`
- `小幸運.pdf`
- `小幸運.mp3`
- `小幸運.mid`

`.xml` 和 `.midi` 也支援。系統按不區分大小寫的主檔名配對；有缺檔、重複類型或不支援的格式時，只回報該組並略過，不會建立不完整的曲目。匯入結果會列出成功與未匯入組別。

## 5. 三類主曲庫閱讀器

- **鋼琴譜**：PDF 顯示鋼琴雙譜表；MP3 實際播放；MIDI 提供起音事件時間；MusicXML 提供音符和小節結構。
- **吉他彈唱譜**：從曲庫開啟新的獨立 PDF／MP3／MIDI 閱讀器，沿用既有 `PdfScoreDisplay.tsx`。原有 `ScoreReader.tsx` 不覆蓋，並保留 `legacyVocalReader=1` 對照入口。
- **吉他指彈譜**：PDF 顯示五線譜＋六線 TAB；MP3 實際播放；MIDI 用於時間對位；MusicXML 提供音符與小節結構。包含已調整的 PDF 小節範圍與第 8、9 小節起音對位。

缺少任何一份附件的舊資料仍可在曲庫顯示並由管理員編輯，但會顯示「素材未齊」，無法進入主閱讀器，直到四份檔案補全。

## 6. 本地示範入口

以下入口只供管理員調試，必須先登入管理員帳號：

- 鋼琴：`http://localhost:8788/?pianoPdfMp3Demo=1`
- 吉他指彈：`http://localhost:8788/?fingerstyleDemo=1`
- 吉他彈唱請先從曲庫匯入完整四件套再開啟。舊的 `?pdfMp3Demo=1` 入口會提示使用曲庫，因這包未包含那組單曲示範素材。

本包含鋼琴與指彈本地示範素材，放在 `public/piano-pdf-mp3-test/`、`public/fingerstyle-pdf-mp3-test/`。這些檔案只能用來本地測試。

## 7. 備份限制

目前 JSON 備份會包含曲目資料與 MusicXML 內容，但不會嵌入 PDF／MP3／MIDI 二進位檔。匯入舊備份時，沒有四份有效檔案參照的曲目會被略過，不會再建立不完整條目。正式發布前請另外保留每首曲目的原始 MusicXML／PDF／MP3／MIDI，並規劃 R2 附件備份。

## 8. 上線前隱私提醒

`public` 目錄內的本地示範檔案可能被靜態公開。測試完成後，正式部署前必須移除 `public/piano-pdf-mp3-test/` 與 `public/fingerstyle-pdf-mp3-test/`，並清理 `src/App.tsx` 中只供調試的 DemoRoute／query 入口。**不要把本地示範素材部署上線。** 該清理應作為最後一個獨立補丁，待你完成本地測試後再做。

## 9. 驗證狀態

本補丁會先做 TS／TSX 語法轉譯檢查；目前尚未在你的 Windows 專案依賴環境完成 `npm.cmd run build` 或真實瀏覽器測試，因此不能宣稱已完整通過。請本機建置並照 `PRELAUNCH_CHECKLIST.md` 逐項回測；未通過前不要部署。
