# linebot-relay

以 Node.js 20 執行，無 npm 相依套件。將 webhook 訊息送進指定的 Codex CLI 工作階段，支援續接、依 session 排隊、全域並行限制與非同步回呼。CLI 指令格式適用 Codex CLI 0.166.0。

```sh
export WEBHOOK_TOKEN='請換成隨機長字串'
export DATA_DIR="$PWD/data" WORK_DIR="$PWD/work" LOG_DIR="$PWD/logs"
node server.js
```

預設監聽 `127.0.0.1:8790`。`WEBHOOK_TOKEN` 必填；其他環境變數如下：

| 變數 | 預設值 |
| --- | --- |
| HOST / PORT | 127.0.0.1 / 8790 |
| CODEX_BIN | /root/.local/bin/codex |
| DATA_DIR | /opt/linebot-relay/data |
| WORK_DIR | /opt/linebot-relay/work |
| LOG_DIR | /opt/linebot-relay/logs |
| MAX_CONCURRENCY | 2 |
| CODEX_TIMEOUT_MS | 600000 |
| CODEX_MODEL | 不指定（設定時用於新 app-server thread 或 CLI 的 -m） |
| CODEX_APP_SERVER_SOCK | /root/.codex/app-server-control/app-server-control.sock（設為 off 停用） |

```sh
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/webhook \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session":"line:user-123","message":"你好"}'
curl http://127.0.0.1:8790/sessions -H "Authorization: Bearer $WEBHOOK_TOKEN"
```

相同 `session` 會依收到的順序續接既有 Codex 工作階段；可加入 `codex_session_id` 綁定既有 ID。成功回傳 `{session,codex_session_id,reply}`。加入 `callback_url`（HTTP/HTTPS）時立即回傳 202，完成後 POST 相同結果；失敗回呼為 `{session,error}`，回呼逾時為 15 秒，不自動重試。同步錯誤回傳 500，CLI 逾時回傳 504。無附件的 JSON 本文上限為 1 MiB。

工作目錄以 session 命名，冒號改為底線，`.` 與 `..` 會安全轉碼；因此請避免使用只有冒號／底線差異的不同 key。不同 key 綁定同一個 Codex ID 時仍各自排隊，請由呼叫端避免同時操作該 ID。

`sessions.json` 以暫存檔與 rename 原子儲存；僅成功完成的訊息計入 `messages`，明確指定的綁定會在 CLI 執行前儲存。請只啟動一個服務實例使用同一組資料目錄。日誌位於 `LOG_DIR/relay.log`，超過 5 MiB 後保留三代，訊息與回覆只記錄前 200 字元。

部署時將檔案放到 `/opt/linebot-relay`，在該目錄建立 `.env`（至少設定 `WEBHOOK_TOKEN`，建議權限 600），並確保 Codex 已完成登入。將 `linebot-relay.service` 複製到 `/etc/systemd/system/` 後執行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now linebot-relay
```

執行本機測試（使用 fake codex，不呼叫真實模型）：

```sh
bash test/run-tests.sh
```

完整測試需要允許本機 HTTP 監聽與建立子行程。受限環境可先執行 `node test/attachments-tests.js`、`node test/in-process-tests.js` 與 `node test/appserver-tests.js`，以模擬傳輸驗證 handler、CLI 事件解析、排隊、持久化與逾時；此檢查不替代完整整合測試。

## App-server mode

預設優先連接正在執行的 `codex app-server --listen unix://...`，透過 Unix socket 上的 WebSocket 將訊息送入同一個 Codex App thread，避免另開 CLI writer。預設 socket 為 `/root/.codex/app-server-control/app-server-control.sock`（支援 symlink）；可用 `CODEX_APP_SERVER_SOCK` 指定其他路徑，或設為 `off` 強制使用 exec。服務不會自行啟動 app-server。

服務啟動時建立並共用連線，斷線後每 2 秒嘗試重連。每次連線都以 `thread/resume {threadId, excludeTurns:true}` 訂閱所有已綁定 thread；即使已由 App 載入，也會確保 relay 自己已訂閱後才送出 turn，不覆寫其模型、工作目錄或權限。新 thread 使用 session 工作目錄、`workspace-write`、`approvalPolicy: never`，並套用 `CODEX_MODEL`（若有設定）。App 中已有執行中的 turn 時，訊息會 steer 至該 turn，並等待它完成。成功結果另含 `transport: "app-server"`；relay 日誌亦記錄使用的 transport。

socket 不存在或提交 turn 前連線／初始化失敗時，會改用既有 exec 流程；一旦提交 `turn/start`，即使回應遺失也不會重複執行。exec 遇到 active writer 衝突時回傳簡短的 409 錯誤。`CODEX_TIMEOUT_MS` 限制 turn 等待時間，逾時只對追蹤中仍在執行的 turn 盡力送出 `turn/interrupt` 並回傳 504；其他 RPC 預設逾時 30 秒。斷線會使進行中的請求失敗，不自動重送訊息。

Relay 不回答任何 app-server 主動要求（包括審批與使用者輸入），僅記錄方法名稱，交由使用者的 Codex App 處理。它需要可存取 socket 的檔案權限與相容的 app-server 協定（依 Codex 0.166.0 驗證）；不轉送串流中間訊息，僅在 turn 完成後回傳最終回答。既有每個 key 的佇列與全域並行限制維持不變。

## Web 控制台

開啟 `https://linebot.dylantsai.com/console`（本機為 `http://127.0.0.1:8790/console`）。`/console/` 亦可使用，`/` 維持 404。

控制台有兩個版本：

- **Vue 版（`web/`）**：Vue 3 + Vite + TypeScript，僅依賴 `marked`、`DOMPurify` 與自帶的 Inter 字型，無 UI 套件。若 `web/dist/index.html` 存在，`server.js` 會在 `/console` 提供它（`/console/*` 以 SPA 方式回退至 `index.html`，`/console/assets/*` 帶長效快取，HTML 仍為 `no-store` 與相同 CSP）。
- **舊版（`console.html`）**：單檔頁面，無外部資源。沒有 build、或設定 `CONSOLE_UI=legacy` 時於 `/console` 提供；任何情況下都可從 `/console/legacy` 開啟。

`CONSOLE_DIST` 可改變 build 目錄（預設 `web/dist`）。部署時須將 `console.html`、`server.js` 與（若使用 Vue 版）`web/dist/` 一起放上伺服器。

### 本機開發 Vue 控制台

```bash
cd web
npm install
npm run dev        # http://localhost:5173/console/
```

開發伺服器將 `/api`、`/webhook`、`/health`、`/sessions` 代理到 `https://linebot.dylantsai.com`；改用本機後端：`RELAY_BACKEND=http://127.0.0.1:8790 npm run dev`。`web/.env.development` 的 `VITE_PUBLIC_ORIGIN` 決定複製出的 Webhook URL／curl 使用的網域（預設線上網域而非 localhost）。

```bash
npm run typecheck  # vue-tsc
npm run build      # 輸出 web/dist，server.js 會自動在 /console 提供
```

`web/dist/` 與 `web/node_modules/` 不納入版本控制。

使用帳號密碼登入（見「使用者管理」），或點「使用访问令牌登录」以 `WEBHOOK_TOKEN` 登入，透過 `/api/whoami` 驗證。未勾選「记住我」時 Token 存於 sessionStorage；勾選時存於 localStorage，登出會清除兩者。HTML 本身不含 Token，回應帶有 `Cache-Control: no-store` 及限制同源連線、禁止嵌入的 CSP。

「会话」可搜尋、新建、綁定 Codex ID、查看歷史與傳送訊息；新建會話先在瀏覽器選取，首次送出時才建立服務端資料。Enter 或 Cmd/Ctrl+Enter 傳送，Shift+Enter 換行。顯示執行中、排隊數、台北時間與耗時，支援安全的簡易 Markdown（粗體、行內程式碼及程式碼區塊）。會話清單每 5 秒更新；選取的會話歷史每 3 秒更新（分頁隱藏時暫停），包含 Codex App 中輸入的訊息（標示 App）與執行中提示，並保留捲動位置。「日志统计」顯示台北日曆日的呼叫與失敗統計、平均耗時及近期請求，可停用自動更新。「调用说明」提供可複製的 curl 範例。

所有 `/api/*` 使用 `Authorization: Bearer <TOKEN>`；未授權回應為 401 `{"error":"Unauthorized"}`。

| 方法與路徑 | 回應／用途 |
| --- | --- |
| `GET /api/whoami` | `{ok:true}`，檢查登入 |
| `GET /api/sessions` | `{sessions:[{key,codex_session_id,messages,created_at,updated_at,status,queued}]}`，依最後更新排序，含尚未完成首次執行的會話 |
| `GET /api/sessions/:key/history?limit=200` | `{key,session,history:[...],source,revision?,running}`，由舊到新；key 需 URL 編碼，上限 550 |
| `DELETE /api/sessions/:key` | `{ok:true}`；未知會話 404，執行中或排隊中 409；僅移除映射與歷史，不刪除 Codex 檔案或工作目錄 |
| `POST /api/send` | `{session,message,codex_session_id?}`；共用 webhook 排隊、驗證、並行及逾時邏輯，等待完成後回傳 `{session,codex_session_id,reply}`，不使用回呼模式 |
| `GET /api/requests?limit=100` | `{requests:[...]}`，由新到舊，上限 500 |
| `GET /api/stats` | `{today:{calls,failures,avg_duration_ms},total_sessions,running,queued,uptime_s}` |

app-server 可用時，歷史來自 `thread/read {threadId, includeTurns:true}`，包括 App 輸入與最終回答；以通知 revision 快取，最長 30 秒後重讀。會話清單使用相同快取計算完成 turn 數與更新時間，每 10 秒最多重讀一次（revision 改變則立即更新），等待上限約 3 秒。讀取失敗或離線時，歷史回退至本機（`source: "local"`；正常為 `"thread"`）。

本機歷史保存於 `DATA_DIR/history/<safe-key>.jsonl`，與工作目錄使用相同的 key 映射（包括安全轉碼 `.`／`..`）。每輪開始執行時記錄完整使用者訊息、來源（webhook/console）、時間及 request ID，完成時記錄回覆或錯誤、耗時及 Codex ID。超過 550 行時保留最新 500 行；歷史不含修改前已有的舊對話。

請求紀錄存於 `DATA_DIR/requests.jsonl`，記憶體保留最新 500 筆，啟動時恢復；檔案超過 2200 行時縮減至最新 2000 行。僅記錄 `/webhook` 與 `/api/send`，包含驗證失敗；不記錄訊息本文或 Authorization，錯誤文字最多 200 字元。非同步 webhook 在工作完成／失敗時記一次結果，202 受理及回呼傳送本身不重複計入；進行中的呼叫尚未計入今日統計。台北日期的累計另存 `DATA_DIR/stats.json`，避免記憶體上限與重新啟動影響今日總計。原有 `LOG_DIR/relay.log` 與 `/sessions` 格式保持不變。

### 圖示

應用圖示的唯一來源是 `web/src/brand/mark.svg`：控制台左上角與登入頁的 logo 直接內嵌它（跟隨控制台深淺色主題），Vite 也會把它輸出為 `/console/favicon.svg`（內建 `prefers-color-scheme` 深色版）。更換圖示時替換這個檔案（備選方案在 `web/src/brand/concepts/concept-1..4.svg`，可直接複製覆蓋），再執行 `python3 web/scripts/render-icons.py` 重新產生 `web/public/favicon-32.png` 與 `apple-touch-icon.png`。SVG 請沿用 `rm-tile`／`rm-g`／`rm-gf`／`rm-a`／`rm-af` class。

## 使用者管理

控制台內建以 SQLite 儲存的帳號系統，管理員可以指定每個使用者能看到哪些會話。

- **資料庫**：`DATA_DIR/users.db`（可用 `USERS_DB` 覆寫），檔案權限 600，已被 `.gitignore` 的 `data/` 排除。
- **驅動**：Node ≥ 22.5 使用內建 `node:sqlite`，不需任何 npm 套件；Node 20 改用 `optionalDependencies` 中的 `better-sqlite3`（部署時執行 `npm ci --omit=dev` 或 `npm install --omit=dev`，需要能下載預編譯檔或有 build toolchain）。可用 `SQLITE_DRIVER=node|better-sqlite3` 強制指定，啟動日誌會印出 `users: <driver>`。
- **密碼**：scrypt（N=16384, r=8, p=1, 16 位元組 salt）；登入 Token 為隨機 256-bit，資料庫只存 SHA-256，有效 30 天，可登出或由管理員停用帳號時撤銷。同一使用者名稱 15 分鐘內失敗 10 次會回 429。

### 角色與權限

| 角色 | 權限 |
| --- | --- |
| 管理員 `admin` | 所有會話、日誌、統計；管理使用者；可取得 `WEBHOOK_TOKEN`（複製「curl（含 Token）」） |
| 普通使用者 `user` | 只看得到被授權的會話：列表、歷史、傳送／附件、日誌、統計、`/api/files` 全部依授權過濾；未授權的會話一律回 **404**（不洩漏是否存在）。不能綁定 Codex ID，也拿不到 `WEBHOOK_TOKEN` |
| `can_create` 旗標 | 普通使用者可新建（傳送到新 key）與刪除會話；自己建立的會話自動授權給自己 |

`WEBHOOK_TOKEN` 永遠擁有完整權限：既有的 Webhook 整合不受影響，也可用來登入控制台救回管理員。

### 初始化

1. **環境變數**：若資料庫中沒有管理員，且設定了 `ADMIN_USERNAME`／`ADMIN_PASSWORD`，啟動時自動建立該管理員（之後可以從環境變數移除）。
2. **控制台**：否則登入頁會提示「使用访问令牌登录」。用 `WEBHOOK_TOKEN` 登入後頂部出現橫幅，點「创建管理员」建立第一個帳號並自動切換成該帳號。

### API

公開：`GET /api/auth/status` → `{needs_setup}`；`POST /api/auth/login {username,password}` → `{token, expires_at, user}`，之後以 `Authorization: Bearer <token>` 呼叫所有 API。

已登入：`GET /api/whoami`、`POST /api/auth/logout`、`POST /api/auth/password {current_password,new_password}`（會登出其他裝置）、`POST /api/auth/setup {username,password}`（僅 `WEBHOOK_TOKEN` 且尚無管理員時）、`GET /api/webhook-token`（僅管理員）。

管理員：`GET/POST /api/users`、`GET/PATCH/DELETE /api/users/:id`、`PUT /api/users/:id/sessions {sessions:[...]}`（整批覆寫授權）、`POST /api/users/:id/password {password}`。`POST`／`PATCH` 欄位：`username`、`password`、`role`、`can_create`、`disabled`、`sessions`。停用或重設密碼會撤銷該使用者的所有 Token；系統至少保留一個啟用中的管理員，管理員不能降級、停用或刪除自己。

| 變數 | 說明 |
| --- | --- |
| USERS_DB | 使用者資料庫路徑，預設 `DATA_DIR/users.db` |
| ADMIN_USERNAME / ADMIN_PASSWORD | 尚無管理員時自動建立（密碼至少 8 字元） |
| SQLITE_DRIVER | `node` 或 `better-sqlite3`，預設自動選擇 |

## 附件與 Webhook 複製

控制台側欄的「复制 Webhook」及每個會話的複製選單提供網址、JSON curl、檔案 curl。一般範例使用 `$TOKEN`；只有明確選擇「含 Token，真实密钥」才把記憶體中的 Token 寫入剪貼簿。沒有選取會話時只能複製基礎 Webhook 網址。

控制台支援迴紋針選檔、拖放與貼上圖片，送出前可預覽／移除附件，也可只傳附件。歷史訊息中的圖片可點開原尺寸，其他檔案可下載；附件由帶 Authorization 的請求取得，登出會清除 blob URL。

`POST /webhook` 與 `POST /api/send` 同時接受 JSON 及 multipart，原有純文字用法保持相容。附件存在時 `message` 可省略，預設為「请查看附件。」；`session` 仍必填，`codex_session_id`、`callback_url` 仍可使用（`/api/send` 一律等待完成）。

```sh
# Multipart：可重複 file 或 files 欄位，支援 UTF-8 檔名。
curl https://linebot.dylantsai.com/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -F 'session=my-session' \
  -F 'message=請查看附件' \
  -F 'file=@./picture.png' \
  -F 'files=@./notes.txt;type=text/plain'

# JSON Base64；mime 可省略。
curl https://linebot.dylantsai.com/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session":"my-session","files":[{"name":"hello.txt","content_base64":"aGVsbG8=","mime":"text/plain"}]}'

# 下載遠端檔案後存入相同的附件目錄。
curl https://linebot.dylantsai.com/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"session":"my-session","file_urls":["https://example.com/report.txt"]}'
```

| 環境變數 | 預設值 |
| --- | --- |
| `UPLOAD_DIR` | `/opt/linebot-relay/uploads` |
| `MAX_FILE_BYTES` | `20971520`（20 MiB／檔） |
| `MAX_FILES` | `5`（所有來源合計） |

超限回傳 413；含附件請求本文上限為 `ceil(MAX_FILES * MAX_FILE_BYTES * 1.4) + 1 MiB`，預設 141 MiB。純文字 JSON 仍限制 1 MiB。控制台固定限制 5 個檔案、每檔 20 MiB。nginx 請設定 **`client_max_body_size 150m;`**；若提高服務端限制，也需相應調整 nginx。

遠端下載僅允許 HTTP/HTTPS，單檔上限同上，每次下載（包含 DNS 及跳轉）共 30 秒、最多 3 次跳轉。每一跳檢查 DNS 全部位址，拒絕 loopback、私有、link-local、CGNAT、metadata 及其他保留位址，並固定已驗證的連線位址，避免 DNS rebinding。檔名優先取 Content-Disposition，否則取 URL 路徑。

附件保存為 `UPLOAD_DIR/<safeKey>/<YYYYMMDD-HHMMSS>-<rand4>-<safeName>`，目錄 0755、檔案 0644。檔名會移除路徑、清理不支援字元及開頭的點，最長 100 字元。請確保服務帳號能寫入此目錄，且 Codex app-server 能讀取；附件不因刪除會話而刪除。

PNG/JPEG/GIF/WebP 以 MIME 或 magic bytes 判定，透過 `localImage` 送入 app-server。所有附件路徑均列在文字中的 `[附件 · linebot-relay]` 區塊；UTF-8 文字類附件不超過 64 KiB 時亦內嵌內容。exec fallback 使用包含路徑的文字。歷史的使用者項目附帶 `attachments: [{name,path,mime,size,kind}]`；App 歷史中的 image URL 會記錄為 `{kind:"image",url,...}`。

`GET /api/files?path=<URL 編碼的絕對路徑>` 需要 Bearer Token，只提供 realpath 位於 `UPLOAD_DIR` 之內的普通檔案。圖片回傳圖片 Content-Type 與 inline disposition，其他檔案（包括 SVG）一律為 `application/octet-stream` 並下載；回應帶 `X-Content-Type-Options: nosniff` 和 `Cache-Control: private, max-age=3600`。
