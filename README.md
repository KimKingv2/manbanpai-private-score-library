# 慢半拍譜間

> 私人雲端樂譜庫 · 鋼琴 · 吉他

**原始碼：** <https://github.com/KimKingv2/manbanpai-private-score-library>

「慢半拍譜間」是一個為自己與少數朋友打造的私人雲端樂譜庫。專案以 React + TypeScript 建立前端，部署於 Cloudflare Pages，並搭配 Pages Functions、D1 與私有 R2 儲存資料及播放資源。

## 功能特色

- **雲端曲譜收藏：** 集中管理鋼琴、吉他等曲譜，支援曲目資料、分類與搜尋。
- **線上閱讀：** 依曲譜所提供的檔案格式，在瀏覽器中閱讀與查看樂譜。
- **播放與同步：** 對已配置所需音源及播放資料的曲譜，提供線上播放相關功能。
- **樂理輔助：** 依曲譜資料提供和弦標記及相關分析資訊，協助閱讀小節與理解和聲。
- **管理者曲庫管理：** 管理者可新增、編輯、刪除及匯入曲譜，並使用備份功能保存資料。
- **朋友瀏覽：** 朋友以允許清單中的名稱進入，可瀏覽與播放曲譜，不具備曲庫管理權限。
- **個別小紙條：** 可為指定朋友設定不同的歡迎通知、內容與顯示延遲，也能獨立控制是否顯示通知。
- **朋友訪問管理：** 可設定朋友名稱是否允許訪問，以及是否顯示對應的小紙條。
- **動態分頁標題：** 閱讀曲譜時，瀏覽器分頁顯示「曲名｜慢半拍譜間」；返回曲庫後恢復為網站名稱。

> 曲譜能否播放及可用的播放控制，會依該曲譜的檔案、對應資料與音源配置而有所不同。

## 技術架構

| 部分 | 技術／服務 | 用途 |
| --- | --- | --- |
| 前端 | React、TypeScript、Vite | 網站介面與建置 |
| 五線譜顯示 | OpenSheetMusicDisplay | 顯示支援的 MusicXML 樂譜 |
| PDF 顯示 | PDF.js | 瀏覽 PDF 樂譜 |
| MIDI 音訊 | SpessaSynth | MIDI 合成與播放相關功能 |
| 後端 API | Cloudflare Pages Functions | 登入、曲庫 API、資源讀取與權限檢查 |
| 結構化資料 | Cloudflare D1 | 曲目資料、應用狀態及相關設定 |
| 檔案與音源 | Cloudflare R2 | 儲存 MusicXML 與播放所需資源 |
| 自動部署 | GitHub Actions + Cloudflare Wrangler | 推送 `main` 分支後建置並部署 |

## 登入與權限

### 管理者

管理者使用 Cloudflare Pages Secret `APP_PASSWORD` 設定的密碼登入。管理者工作階段另由 `SESSION_SECRET` 簽章；請勿將這些值寫入原始碼或提交至 GitHub。

### 朋友

朋友輸入已在「朋友訪問管理」中啟用的名稱，即可使用訪客權限瀏覽與播放曲譜。訪客無法新增、編輯或刪除全域曲庫資料。

**重要安全說明：朋友登入只核對名稱是否在允許清單中，不會驗證使用者是否為該名稱本人。** 知道網站網址且知道某個已允許名稱的人，可能冒用該名稱進入。請不要把這種登入方式當成實名驗證，也不要把它用於需要嚴格身分認證的內容。若將來需要更強的限制，可考慮增加朋友共用通行碼或 Cloudflare Access。

原始碼儲存庫目前是公開的。公開原始碼不應包含管理者密碼、工作階段密鑰、私人樂譜檔案或其他秘密資料；也請確認你上傳的樂譜、錄音與音源具有合適的使用及分享權限。

## 本機開發

### 環境需求

- Node.js 22（與目前 GitHub Actions 建置環境一致）
- npm
- Windows 使用 PowerShell 時，若系統的執行原則阻擋 `npm.ps1`，請使用 `npm.cmd` 與 `npx.cmd`

### 啟動步驟

在專案根目錄開啟 PowerShell，執行：

```powershell
npm.cmd install
npm.cmd run dev
```

Vite 開發伺服器預設綁定 `127.0.0.1`。依終端機顯示的網址，在本機瀏覽器開啟網站。

### 建置與預覽

```powershell
npm.cmd run build
npm.cmd run preview
```

`npm.cmd run build` 會將網站建置至 `dist/`。如果建置時出現大型 bundle 的提醒，那是打包體積警告，與是否成功建置是兩回事；仍應確認最後是否顯示建置成功。

## Cloudflare 部署

目前正式部署使用以下資源名稱：

- **Pages 專案：** `manbanpai`
- **D1 資料庫：** `manbanpai-db`，綁定名稱 `DB`
- **R2 儲存桶：** `manbanpai-assets`，綁定名稱 `DATA`

以 Cloudflare Dashboard 中實際設定的 bindings 與 secrets 為準。R2 中的曲譜或音源資源應維持預期的存取限制，不要為了方便而直接開啟整個儲存桶的公開讀取。

### 自動部署流程

GitHub Actions 工作流程位於 `.github/workflows/pages-deployment.yml`。當程式碼推送至 `main` 分支，工作流程會：

1. 使用 Node.js 22 安裝依賴。
2. 執行 `npm run build`。
3. 使用 Wrangler 將 `dist/` 部署至 Cloudflare Pages 專案 `manbanpai`。

工作流程需要在 GitHub Repository Secrets 中設定：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

不要將 API Token 寫進工作流程檔案或提交到儲存庫。推送完成後，可到 GitHub 儲存庫的 **Actions** 頁面檢查部署是否成功。

## 專案目錄概覽

```text
.
├── .github/workflows/       # GitHub Actions 自動部署流程
├── functions/               # Cloudflare Pages Functions 與 API
├── migrations/              # D1 資料庫結構遷移 SQL
├── public/                  # 靜態公開資源
├── scripts/                 # 維護與音源同步相關腳本
├── src/                     # React 前端、曲庫與閱讀器
├── index.html               # 網頁入口與預設標題
├── package.json             # 套件與 npm 指令
├── wrangler.toml            # Cloudflare Pages、D1、R2 設定
└── AUDIO_ATTRIBUTION.md     # 播放音源的來源與署名資訊
```

## 音源授權與致謝

專案使用的鋼琴與吉他取樣音源具有各自的來源與授權條件。請保留 [`AUDIO_ATTRIBUTION.md`](./AUDIO_ATTRIBUTION.md) 中的資訊；若重新散布相關音源，也請遵守其授權要求。

## 備份與資料維護

- 進行曲庫批次匯入、結構調整或其他大量操作前，先匯出一份備份。
- 不要為了排查問題而直接刪除 D1 資料表或 R2 物件；先確認影響範圍與可還原方式。
- 新增 Cloudflare binding 或修改 Secrets 後，確認正式環境的設定與本專案使用的名稱一致，並重新部署以套用設定。
- 避免將私人曲譜、管理者憑證、Cloudflare Token 或其他敏感資料提交至公開儲存庫。

## 專案狀態

本專案主要供個人與少數朋友使用，並持續調整曲譜閱讀、播放及樂理分析體驗。不同曲譜格式與來源的資料完整度不盡相同，因此不保證每一份檔案都能使用完全相同的播放、同步或分析功能。
