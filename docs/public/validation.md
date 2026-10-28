# 驗證摘要

目前版本：0.3.5。這份文件說明已完成的驗證及限制，不包含使用者帳號、私人對話或本機診斷紀錄。

## 自動測試

在 Windows x64 環境執行：

```text
npm ci
npm run typecheck
npm run build
npm test
```

0.3.5 的測試共 106 項，涵蓋：

- 帳號 A→B→A、憑證更新、忙碌時阻擋切換、驗證失敗還原及登入檔並行變更。
- 真實 Windows 啟動器、私有橋接通道及官方後端路徑更新。
- QuickPick 帳號列的修復／改名／移除、取消移除及 100 個帳號上限。
- 額度查詢的五秒啟動、前景一分鐘／背景三分鐘、自動重試及多視窗共用結果。
- 同時到期時的查詢鎖，以及程序中斷後留下空鎖的恢復。
- 0.3.4 補強查詢鎖：其他視窗剛好釋放或刪除鎖時跳過該輪，不記為查詢失敗；時鐘倒退留下的鎖會過期；多個視窗同時清除過期鎖時只有一個取得。尚未到期的帳號不讀取憑證、不取得鎖。
- 0.3.5 改以內容區分橋接：位元組相同的橋接沿用原資料夾（含舊版以版本號命名者），升級時不移動 `chatgpt.cliExecutable`，也不提示；內容變更才建立新資料夾。所有套用提示改為重新載入視窗，不再只重啟擴充執行環境。
- 直接 HTTPS 查詢、錯誤回應、逾時、取消及保留上次成功額度；額度測試禁止啟動子程序。

多視窗去重使用同一 Profile 的共用快取與查詢鎖。此機制以快取正常讀寫為前提；不同 Profile 或獨立資料目錄不共用。

## 官方介面與後端

`npm run test:integration` 在隔離 VS Code 使用真實 SecretStorage，驗證命令註冊及帳號保存，不使用真實帳號。

設定 `MULTICODEX_OFFICIAL_EXTENSION` 指向已安裝的官方擴充目錄後，可執行：

```text
npm run test:official-ui
npm run test:auth-routing
```

- 官方介面測試在隔離、未登入的環境啟動官方擴充與本機橋接，確認介面 routes 已掛載及後端完成 initialize。0.3.5 以官方擴充 26.1021.22027、VS Code 1.143.1 通過。
- 路由測試使用真實官方 app-server、合成憑證及僅限本機的模擬 HTTP API。既有對話先使用 A；切到 B 後，舊對話與新對話都使用 B；切回 A 後舊對話使用 A。預期路由為 A→B→B→A，不呼叫付費模型。

測試腳本會在本機 `docs/validation/evidence/` 產生結果；這些執行紀錄不納入公開 repo。

## 真實帳號的選用診斷

以下診斷需明確指定 `--current-access-token`，會使用目前已登入帳號：

```text
node --import tsx scripts/live-bridge-probe.ts --current-access-token
node --import tsx scripts/quota-probe.ts --current-access-token
```

前者另需 `MULTICODEX_OFFICIAL_EXTENSION`，只把 access token 交給隔離後端核對登入更新及通知，不提供 refresh token、不送模型請求。後者直接查詢一次 HTTPS 額度。兩者均核對原登入檔未變。

## 已知限制

同一後端的路由驗證，不代表其他客戶端持有的舊對話也會切換。官方介面可能將訊息轉送給另一個對話持有者；本視窗切換帳號或重新載入，不會替另一個客戶端同步登入。

兩個真實帳號的完整官方 UI 切換、自然憑證到期續用及跨客戶端接手仍待驗收。免重載功能因此保留啟用／停用入口。

額度查詢已移除反覆啟停 Codex 的路徑，但歷史 LSASS 異常根因未證實。測試不能證明 Windows 問題已修復或保證不再發生。
