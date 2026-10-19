> **DEMO ONLY / 示範專案：** 所有資料均為虛構樣本，不含真實客戶資料、金鑰或收款。Stripe 只限測試模式。

# salon-app-v4 — 單店美容護理預約網站 + 員工 CRM（可上線版）

由 v3 示範版升級而成（v3 未改動）。Node 22 + PostgreSQL，只有兩個執行期套件（`pg`、`nodemailer`）；Stripe / WhatsApp / SendGrid 用 Node 內建 `fetch`。

**服務與價目（全站只有這四個價錢）：** Hydrafacial 免費體驗 HK$0 · 單次 Hydrafacial HK$688 · 激光脫毛體驗 HK$288 · 10 次套餐 HK$8,800。

> 這是軟件，不是法律意見。私隱政策、條款、WhatsApp/電郵推廣安排，上線前須由商戶／律師確認（見下方「未能驗證」及 `DEPLOY.md`）。

## 功能
- 公開網站：服務、預約（時段名額、不會超額預約）、會員註冊／登入／忘記密碼／下載資料／刪除帳戶、私隱政策與條款（草稿模板）、退訂頁。
- 員工後台：儀表板、預約日曆、客戶資料庫、銷售流程（7 階段）、提醒訊息、設定、**員工邀請**、員工帳戶管理、操作紀錄、上線檢查清單、發送設定（管理員）。
- 員工只可經管理員邀請連結註冊，**管理員批准後**才可登入。
- Stripe Checkout 收取 10 次套餐 HK$8,800：**只有經簽名 webhook／員工驗證（由伺服器向 Stripe 取回 session）確認 paid，客戶才會進入 Package Sold**。預設 **Test Mode**。
- 提醒訊息預設只產生**草稿**。真實發送須：`NOTIFY_ENABLED=true` + 渠道設定 + 員工逐則核准（或管理員另外開啟自動發送）。

## 在 Windows 本機試用（最簡單，不用安裝資料庫）
1. 安裝 Node.js 22 LTS（https://nodejs.org）。
2. 在此資料夾開啟 PowerShell：
   ```powershell
   npm install
   npm run dev
   ```
3. 開啟 http://localhost:3000 。員工登入網址 `/staff/login.html`；電郵 `admin@local.test`，**密碼會在終端機顯示**（首次啟動隨機產生，只限本機）。
   `npm run dev` 使用內嵌 PostgreSQL（資料在 `.devdb/`），開啟示範模式及 15 筆虛構樣本資料。**不可用於正式營運。**

其他本機方式：安裝 Docker Desktop 後，複製 `.env.example` 為 `.env`，填好 `POSTGRES_PASSWORD`、`DOMAIN`（本機可用 `localhost`，但 Caddy 的自動 HTTPS 只對真實網域有效）、`APP_SECRET`、`ADMIN_*`，執行 `docker compose up -d --build`。或自行安裝 PostgreSQL，設定 `DATABASE_URL` 後 `npm run migrate && npm start`。

## 指令
| 指令 | 用途 |
|---|---|
| `npm start` | 啟動（會先驗證設定，錯誤會直接列出並停止；`AUTO_MIGRATE=true` 時自動升級資料庫） |
| `npm run migrate` | 手動執行資料庫遷移 |
| `npm run create-admin` | 互動建立管理員（密碼輸入不顯示） |
| `npm run seed` | 載入虛構樣本資料（只在 `SEED_DEMO_DATA=true` 時允許） |
| `npm run purge-retention` | 依 `DATA_RETENTION_MONTHS` 匿名化過期客戶資料（建議每日 cron） |
| `npm test` | 全部測試（真實 PostgreSQL，見下） |
| `npm run check:content` | 掃描禁用字詞、非指定價錢、金鑰／示範密碼 |
| `scripts/backup.sh` / `scripts/restore.sh` | 備份／還原（pg_dump） |

## 環境變數
全部列在 `.env.example` 並附說明。必填（正式環境）：`DATABASE_URL`、`APP_SECRET`（≥32 字元）、`PUBLIC_BASE_URL`（https）。設定錯誤時伺服器**拒絕啟動**並列出所有問題。重點：
- Stripe：`STRIPE_MODE=test`（預設）。要收真錢須**同時**：`STRIPE_MODE=live` + `STRIPE_ALLOW_LIVE=yes` + `sk_live_` 金鑰 + `STRIPE_WEBHOOK_SECRET`。在 test 模式下放入 live 金鑰會啟動失敗。
- `SITE_DEMO_MODE=false`（預設）：不顯示示範標籤、AI 示範圖、虛構護理師頁；未填的商戶資料顯示「待填」，**不會自行編造**。
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`：首次啟動建立管理員（密碼 ≥12 字元）；完成後請從環境變數移除密碼。
- `TRUST_PROXY`：前面有幾層反向代理（Caddy／Render／Railway＝1）。

## 架構
`server.js` → `lib/app.js`（所有路由）→ `lib/core.js`（預約、流程、提醒草稿）、`auth.js`（登入、session、邀請、重設密碼）、`payments.js` + `stripe.js`、`notify.js` + `providers.js`、`privacy.js`、`checklist.js`。資料庫結構在 `migrations/`。前端是無建置步驟的靜態檔（`public/`），HTML 在送出時按模式處理（`lib/pages.js`）。

安全重點：scrypt 密碼雜湊；session token 只存雜湊；Cookie `HttpOnly` + `SameSite=Strict` + `Secure` + `__Host-`（正式環境）；CSRF 以嚴格 Origin 檢查 + 僅接受 JSON；CSP 不允許內嵌 script；登入／註冊／預約限流（**每個實例各自計算**，多實例請在代理層另設限流）；帳戶鎖定（指數退避）；員工 session 8 小時／閒置 2 小時；改密碼後所有 session 失效；Webhook 簽名 + 重放容忍 + 事件冪等 + 金額／貨幣／livemode／metadata 全面驗證；日誌不含個人資料（IP 只記雜湊標記）。

## 私隱與合規（香港 PDPO / UEMO）— 程式已做的部分
- 收集前同意（PICS 連結 + 勾選）；**不收集 HKID**；推廣訊息需另外勾選同意，預設不勾選；每則電郵有退訂連結，WhatsApp 草稿附 STOP 字句；退訂名單只存雜湊。
- 查閱／更正：客人可下載自己的資料、員工可匯出單一客戶資料；刪除＝匿名化（付款／帳目紀錄保留但不含身份）。
- 保存期限：`DATA_RETENTION_MONTHS`（預設 24）；`purge-retention` 匿名化過期資料，已購套餐客戶保留（保存年期請與會計師確認）。
- 操作紀錄（誰在何時做了什麼）供管理員查閱。

## 每日自動備份（Hostinger VPS / docker-compose.yml）
`docker-compose.yml` 內的 `backup` 服務會自動備份 PostgreSQL：
- 容器啟動時立即備份一次，之後每日 **03:00（香港／上海時間，UTC+8）** 再備份。
- 格式：`pg_dump -Fc`（custom format），檔名 `salon-YYYYmmdd-HHMMSS.dump`，存放在 Docker volume **`salon-backups`**（容器內路徑 `/backups`）。
- 每次備份後會用 `pg_restore -l` 檢查檔案；失敗的備份不會保留。只保留最近 **14 天**。
- 密碼由專案環境變數 `POSTGRES_PASSWORD` 提供，倉庫內沒有任何金鑰。
- 備份檔含個人資料：只限管理員存取。這些備份與資料庫在同一部 VPS，**並不是異地備份**，請另外開 Hostinger VPS 快照，或定期把檔案複製到其他地方。

以下指令在 VPS 上執行（SSH 或 hPanel 瀏覽器終端），先 `cd /docker/salon-demo`：

```bash
# 查看備份紀錄／列出備份
docker compose logs --tail 50 backup
docker compose exec backup ls -lh /backups

# 即時多做一次備份（重啟 backup 容器時會先備份一次）
docker compose restart backup

# 下載一份到 VPS 目前資料夾（之後可用 SFTP 取走）
docker compose cp backup:/backups/salon-20261019-030000.dump ./

# 還原（會覆蓋現有資料！請先另外備份一次，並先停止 app）
docker compose stop app
docker compose exec backup pg_restore --clean --if-exists --no-owner -d salon /backups/salon-20261019-030000.dump
docker compose start app
```

先試還原到測試資料庫（不影響正式資料）：
```bash
docker compose exec backup createdb restore_test
docker compose exec backup pg_restore --no-owner -d restore_test /backups/salon-20261019-030000.dump
docker compose exec backup psql -d restore_test -c '\dt'
docker compose exec backup dropdb restore_test
```

## 測試
`npm test` 用 `node:test`，對**真實 PostgreSQL**（dev 依賴 `embedded-postgres` 自動啟動；或設定 `TEST_PG_ADMIN_URL` 用自己的）。Stripe 用本機**模擬 Stripe API 伺服器** + 本機簽名 webhook；電郵／WhatsApp 用模擬 provider 及本機模擬 SendGrid / WhatsApp Cloud API。涵蓋：遷移、登入／session／CSRF／限流／鎖定、邀請與權限、預約並發不超額、流程規則、Stripe（冪等、簽名、金額／模式不符、live 金鑰拒絕）、通知（預設關閉、試運行、核准、退訂、推廣阻擋）、匯出／刪除／保存期限、示範／正式頁面、設定驗證、內容檢查。

## 未能驗證（請務必留意）
- **沒有連接真實 Stripe**：只對模擬 API 測試。上線前請用你自己的 Stripe Test Mode 金鑰及 `stripe listen` 或真實 webhook 走一次，再考慮 live。
- **沒有發出任何真實 WhatsApp／電郵／SendGrid／SMTP**：只測試了請求格式及邏輯。WhatsApp 需 Meta 已批准的範本，名稱以環境變數設定。
- **沒有真實網域／HTTPS／Caddy**、沒有在真實 VPS 或 Render／Railway 部署；**Dockerfile、docker-compose、render.yaml 未能在此建置／執行**（此環境沒有 Docker）。語法已人手核對，首次部署請預留時間除錯。
- 私隱政策、條款內容只是**草稿模板**（含 `[待填]`），**須由律師審閱**；上線檢查清單內有對應手動項目。
- 限流是每個程序各自計算；負載均衡多實例需另外設定。
- 沒有做滲透測試或第三方資安審計。
