# 慢半拍系列｜Kim｜私人雲端樂譜庫

這是一個可獨立安裝依賴、建置並部署到 Cloudflare Pages 的 React + Vite 起步專案，包含 ScoreReader、曲庫、Pages Functions、D1 schema 和 R2 音源遷移腳本。它不是已部署網站，Cloudflare 資源仍需由你在自己的帳戶建立。

## 登入與權限

登入畫面有兩種方式：

- **Kim 管理者登入：** 使用 Cloudflare Pages Secret `APP_PASSWORD` 設定的密碼。通過後才可以新增、編輯、刪除、匯入或更新曲庫資料。
- **朋友登入：** 只需輸入姓名，可以瀏覽與播放曲譜。伺服器會以已簽章的 HttpOnly Cookie 區分 `guest` 與 `admin`，不是靠前端按鈕判斷權限。訪客無法呼叫曲庫寫入 API；樂理修正若有保存，會按姓名放在獨立的訪客 state namespace，不會覆蓋管理者的全域修正。

**安全限制請務必知道：** 只輸入姓名不會驗證朋友的真實身分。任何知道網站網址的人都可以輸入任意姓名並以訪客方式瀏覽／播放。因此，這個模式適合你接受「連結持有者可讀」的私人曲庫；若希望只有受邀朋友才能看見，請另外加入訪客共用通行碼或 Cloudflare Access。即使訪客輸入「Kim」，也只會得到 `guest` 權限，不會成為管理者。

## 雲端服務分工

- Cloudflare Pages：網站前端。
- Pages Functions：`/api/*`、`/media/*`、簽章 Cookie 和伺服器端權限檢查。
- D1：曲目資料、全域樂理修正和應用程式狀態。
- 私有 R2：MusicXML 原始檔、鋼琴取樣音源及鋼弦吉他音源。請勿啟用公開存取。

建議資源：Pages `manbanpai`、D1 `manbanpai-db`、R2 `manbanpai-data`；bindings 分別為 `DB` 和 `DATA`。

## 第 1 步：在本機啟動

1. 安裝 Node.js LTS。
2. 將本專案 ZIP 解壓縮到例如 `C:\Users\KimSa\Projects\manbanpai`。
3. 在專案資料夾空白處點右鍵開啟終端機，執行：

```powershell
npm install
npm run build
```

建置成功後，才繼續建立 Cloudflare 資源。

## 第 2 步：建立 Cloudflare 資源

在 Cloudflare Dashboard 建立 D1 資料庫 `manbanpai-db` 和私有 R2 bucket `manbanpai-data`。部署 Pages 專案後，在 Settings／Bindings 中將 D1 綁定為 `DB`，將 R2 綁定為 `DATA`，新增／修改 binding 後重新部署。

將 `wrangler.pages.example.toml` 複製為 `wrangler.toml`，並將 D1 `database_id` 換成真實 ID。若使用 Dashboard 設定 bindings，請確認名稱與實際 binding 一致。

## 第 3 步：初始化 D1

在專案根目錄開啟 PowerShell：

```powershell
npx wrangler login
npx wrangler d1 execute manbanpai-db --remote --file=migrations/0001_initial.sql
```

如有「資料表已存在」錯誤，先停止並檢查，不要刪除既有資料。

## 第 4 步：設定密碼與工作階段金鑰

在 Cloudflare Pages 專案的 Settings／Variables and Secrets 中新增 **Secrets**：

- `APP_PASSWORD`：只有 Kim 知道的管理者登入密碼。
- `SESSION_SECRET`：至少 32 個隨機字元的獨立簽章密鑰，不可與 `APP_PASSWORD` 相同。

不要把密碼寫進程式碼、`.env`、GitHub 或聊天訊息。設定後重新部署。朋友登入無需管理者密碼；但姓名登入不驗證身分，請先閱讀上方安全限制。

## 第 5 步：部署 Pages

建立 Pages 專案 `manbanpai`，連結 GitHub 儲存庫，設定 build command `npm run build`、output directory `dist`，或在完成 Wrangler 設定後使用 Wrangler 部署。Pages Functions 需要與 `functions/` 資料夾一同部署。

設定你自己的網域時，到 Pages 專案 Custom domains 新增子網域；請勿把 R2 bucket 設成公開。

## 第 6 步：上傳播放音源到私有 R2

本專案的讀取 URL 已指向 `/media/audio/...`。只有音源已實際上傳後，播放才會成功。安裝依賴並完成 `npx wrangler login`、建立 bucket 及綁定後，執行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\\scripts\\sync-audio-to-r2.ps1 -BucketName 'manbanpai-data'
```

此腳本會下載專案目前使用的 Salamander 鋼琴取樣和 FluidR3_GM 鋼弦吉他音源並上傳至 R2。請保留 `AUDIO_ATTRIBUTION.md` 中的授權及署名資訊。音源上傳完成前，不要把正式使用者切換到只依賴雲端音源的版本。

## 第 7 步：首次遷移曲庫

請先以 Kim 管理者模式登入。曲庫載入後會嘗試將目前瀏覽器的舊曲庫與 IndexedDB MusicXML 遷移到雲端。遷移前先用「匯出備份」留一份 JSON。舊資料遷移不會主動刪除本機副本。訪客模式不會執行本機曲庫遷移或寫入雲端曲庫。

## 驗收清單

1. 管理者可以新增／編輯／刪除曲譜。
2. 朋友輸入姓名後只能瀏覽及播放，直接呼叫寫入 API 會得到 403。
3. 訪客輸入「Kim」仍然是 guest，不會取得管理權限。
4. MusicXML 上傳後重新整理與跨裝置登入仍可讀取。
5. 音源請求走 `/media/audio/...`，且 R2 未開啟公開讀取。
6. `drawBrushMarkers()` 保留自 v100 穩定版本的原樣實作。

## 品牌

- 慢半拍系列
- Kim
- 私人雲端樂譜庫 · 鋼琴 · 吉他

舊資料識別碼 `scoreroom.library.v1`、`scoreroom.score-files.v1`、`ScoreRoomLibraryBackup`、URL 參數 `scoreRoomId` 為向後相容用途，請勿全域取代。
