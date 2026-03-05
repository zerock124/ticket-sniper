# KKTIX 搶票助手 Chrome Extension

基於 `kktix.js` 腳本封裝而成的 Chrome 擴充功能，提供視覺化設定介面與一鍵啟動/停止功能。

---

## 檔案結構

```
extension/
├── manifest.json        # 擴充功能設定檔
├── popup.html           # 彈出視窗 UI
├── popup.css            # 彈出視窗樣式
├── popup.js             # 彈出視窗邏輯
├── content.js           # 注入 KKTIX 頁面的核心腳本
├── background.js        # Service Worker（訊息中繼）
└── generate_icons.js    # （選用）產生圖示的腳本
```

---

## 安裝方式

1. 開啟 Chrome，前往 `chrome://extensions/`
2. 右上角開啟「**開發人員模式**」
3. 點擊「**載入未封裝項目**」
4. 選擇此 `extension/` 資料夾
5. 擴充功能列會出現 🎫 圖示

---

## 使用說明

| 功能 | 說明 |
|------|------|
| **購買數量** | 要購買的票數（預設 2） |
| **選擇區域** | 以逗號分隔的票價字串，依優先順序排列<br>例如：`2,880, 4,480, 2880, 4480` |
| **會員代碼** | 部分活動需要輸入，可留空 |
| **問題答案** | 有驗證問題時填入；有 Google reCAPTCHA 則留空 |
| **💾 儲存設定** | 將設定儲存至 chrome.storage，下次開啟自動帶入 |
| **▶ 開始搶票** | 將設定傳送至 KKTIX 頁面並啟動自動流程 |
| **■ 停止** | 立即中斷執行中的搶票流程 |

### 執行流程

```
Step 1 → 依優先金額選擇票種
Step 2 → 選擇購買數量（點擊 + 按鈕）
Step 3 → 勾選同意使用條款
  Q   → 填入會員代碼 / 問題答案（如需要）
Step 4 → 點擊「立即購買」
```

- 若找不到指定金額票種 → 自動重新整理頁面重試
- 單一步驟失敗超過 **5 次** → 自動重新整理頁面
- 抵達結帳頁 → 自動發送 Discord Webhook 通知

---

## 注意事項

- 擴充功能只會在 `kktix.com` 或其子網域上運作
- 請在 **票券選擇頁面** 按下「開始搶票」
- Discord Webhook URL 請自行替換為自己的

---

## （選用）產生圖示

若需要自訂圖示，安裝 `canvas` 套件後執行：

```bash
npm install canvas
node generate_icons.js
```

產生的 `icons/icon16.png`、`icon48.png`、`icon128.png` 加入 `manifest.json` 的 `icons` 欄位即可。
