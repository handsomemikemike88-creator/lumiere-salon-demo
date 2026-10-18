# 上線指南（香港商戶，非技術背景）

兩條路：**A. 自己租 VPS（約 HK$40–80／月，一次設定，最大控制權）**，或 **B. 用 Render／Railway 這類平台（較簡單，按月收費）**。兩者都需要一個網域名稱（例如 `salon.yourshop.com.hk`）。

## 上線前，商戶要自己決定／提供的事（我不會代你編造）
1. 店名、地址、電話、WhatsApp 號碼、營業時間、（如要顯示）商業登記號碼 → 填入 `STORE_*`、`BUSINESS_REG_NO`。未填的位置網站會顯示「待填」。
2. 真實相片、真實護理師資料：目前正式模式不顯示 AI 示範圖及虛構護理師頁；請提供真實相片及資料後再加回（可找人更新 `public/`）。
3. 私隱政策（PICS）及服務條款：已附草稿，**請律師審閱**，然後在「上線檢查清單」剔選。
4. 是否使用 WhatsApp／電郵提醒、是否做推廣（需要客人另外同意；UEMO 規定）。
5. 資料保存年期（預設 24 個月）及會計紀錄保存年期（請問會計師）。
6. Stripe 帳戶：先用 Test Mode 完整試過，再決定何時轉 live。

## 共同步驟
1. 取得網域；把 DNS 的 `A` 記錄指向伺服器 IP（平台則按平台指示加 `CNAME`）。
2. 準備 `.env`（由 `.env.example` 複製）。必填：`PUBLIC_BASE_URL`、`APP_SECRET`、`DATABASE_URL`（Docker 方案自動處理）、`ADMIN_EMAIL`、`ADMIN_PASSWORD`。產生 `APP_SECRET`：`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`。
3. 第一次啟動後，用管理員登入 `/staff/login.html`，到「員工帳戶」→ 更改密碼，並把 `ADMIN_PASSWORD` 從環境變數刪除。
4. 開啟「上線檢查清單」逐項完成，直到 `SITE_DEMO_MODE=false` 且沒有未完成項目。
5. 員工加入：「員工邀請」建立連結（只顯示一次）→ 傳給員工（用安全方式）→ 員工註冊 → 你在「員工帳戶」批准。

## 方案 A：VPS + Docker（建議）
1. 租 Ubuntu 22.04/24.04 VPS（亞洲機房，例如香港／新加坡），開放 80、443 埠；只用 SSH 金鑰登入。
2. 安裝 Docker：`curl -fsSL https://get.docker.com | sh`。
3. 上傳整個專案資料夾（zip 解壓），`cp .env.example .env`，編輯 `.env`：`DOMAIN`、`POSTGRES_PASSWORD`（長隨機密碼）、`APP_SECRET`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`STORE_*`。
4. `docker compose up -d --build`。Caddy 會自動申請並續期 HTTPS 憑證（網域須已指向此伺服器）。
5. 檢查：`docker compose ps`、`curl https://你的網域/healthz` 應回 `{"status":"ok"}`；`docker compose logs -f app` 看日誌。
6. 更新版本：上傳新檔案 → `docker compose up -d --build`（資料庫遷移自動執行）。
7. 防火牆：只開 22/80/443（`ufw allow 22,80,443/tcp && ufw enable`）。定期 `apt upgrade`。

## 方案 B：Render（或 Railway）
- **Render**：把專案放上 GitHub 私有 repo → Render「New > Blueprint」→ 選此 repo（`render.yaml` 會建立網站 + PostgreSQL）。在儀表板填入標示 `sync: false` 的變數（`PUBLIC_BASE_URL`、`ADMIN_*`、`STORE_*`、Stripe 等），綁定自訂網域（Render 自動 HTTPS）。`TRUST_PROXY=1`、`DATABASE_SSL=require` 已預設。
- **Railway**：New Project → Deploy from GitHub → 加 PostgreSQL 外掛 → 在 Variables 設 `DATABASE_URL`（引用外掛）、`DATABASE_SSL=require`、`TRUST_PROXY=1`、`NODE_ENV=production`、其餘同 `.env.example`；Start command `node server.js`；Healthcheck path `/healthz`；綁定網域。
- 平台的免費／最低方案可能會休眠或資料庫有期限，**營運用請選付費方案**，並確認資料庫有每日備份。

## HTTPS
Docker 方案由 Caddy 自動處理；平台方案由平台處理。正式環境程式會拒絕非 https 的 `PUBLIC_BASE_URL`，Cookie 為 `Secure`，並送出 HSTS。

## 備份與還原
- 每日備份：`crontab -e` 加入 `0 3 * * * cd /path/to/app && docker compose exec -T db pg_dump -U salon salon | gzip > backups/salon-$(date +\%F).sql.gz`（Docker），或用 `scripts/backup.sh`（自行安裝 PostgreSQL 時）。備份檔含個人資料：加密保存、限制存取，並定期把檔案複製到另一個地方（異地備份）。
- 還原：`scripts/restore.sh backups/xxx.sql.gz`（會要求輸入 RESTORE 確認，並會覆蓋現有資料）。**請至少試還原一次到測試環境。**
- 保存期限：每日 cron 執行 `npm run purge-retention`（Docker：`docker compose exec app node scripts/purge-retention.js`）。

## Stripe
1. Stripe 儀表板（**Test Mode**）→ Developers → API keys：取得 `sk_test_...` → `STRIPE_SECRET_KEY`。
2. Developers → Webhooks → Add endpoint：網址 `https://你的網域/api/stripe/webhook`；事件選 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`checkout.session.expired`、`payment_intent.payment_failed`、`charge.refunded`；取得 `whsec_...` → `STRIPE_WEBHOOK_SECRET`。
3. 在 Test Mode 完整走一次：預約 → 標記出席 → 套餐諮詢 → 建立付款連結 → 以 Stripe 測試卡付款 → 客戶自動進入 Package Sold。
4. 轉 live（**這步會收真錢**）：換成 live 金鑰與 live webhook，並同時設定 `STRIPE_MODE=live`、`STRIPE_ALLOW_LIVE=yes`。後台會顯示正式模式標示。Stripe 帳戶啟用、收款條款、退款政策請自行確認。

## 電郵（重設密碼）與提醒
- 沒有電郵服務時，重設密碼連結只會寫入**伺服器日誌**（管理員可在日誌查看後轉交），不會出現在網頁回應。建議設定 `EMAIL_PROVIDER=smtp` 或 `sendgrid` + `EMAIL_FROM`（寄件網域需設好 SPF/DKIM）。
- 預約提醒預設只產生草稿。要真實發送：設定電郵或 WhatsApp 供應商 → `NOTIFY_ENABLED=true` → 先設 `NOTIFY_DRY_RUN=true` 試運行 → 再設 `NOTIFY_TEST_ALLOWLIST=你自己的地址` 小範圍測試 → 才正式開放。員工在「提醒訊息」頁逐則核准；管理員可在「發送設定」另外開啟自動發送。
- WhatsApp：使用 Meta WhatsApp Business Cloud API，**只發已獲批准的範本訊息**。需要 Meta 業務帳戶、已驗證的號碼及範本（`WHATSAPP_TEMPLATE_CONFIRMATION`、`WHATSAPP_TEMPLATE_REMINDER`，各含 4 個參數：姓名、服務、日期時間、預約編號）。
- 只發給「已預約的體驗／單次護理」客人的預約通知；推廣訊息需客人另外同意，系統目前不提供批量推廣功能。

## 日常維護
- 日誌看 `docker compose logs`；`/healthz` 可接入監察服務（如 UptimeRobot）。
- 員工離職：「員工帳戶」→ 停用（即時登出）。
- 客人要求查閱／刪除資料：員工在客戶資料頁匯出；管理員可匿名化；客人亦可自行在會員專區操作。
- 發現資料外洩：立即更換 `APP_SECRET`（會令所有登入失效）及管理員密碼，並諮詢律師有關通報安排。
