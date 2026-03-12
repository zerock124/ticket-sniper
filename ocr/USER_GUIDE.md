# OCR Server 使用指南

這是一個本地 OCR（光學字元識別）服務，用於辨識 Tixcraft 驗證碼。

## 🚀 快速開始

### Windows 用戶

1. **下載並解壓縮**
   - 下載 `ocr_server_windows.zip`
   - 解壓縮到任意目錄

2. **執行服務**
   - 雙擊 `ocr_server.exe`
   - 會出現一個黑色視窗，顯示「Tixcraft OCR Server 已啟動」

3. **確認運行**
   - 開啟瀏覽器，訪問 http://localhost:5511/health
   - 應該會看到 `{"status": "ok", "message": "OCR Server 運行中"}`

### Mac 用戶

1. **下載並解壓縮**
   - 下載 `ocr_server_mac.zip`
   - 解壓縮到任意目錄

2. **首次執行需設定權限**
   ```bash
   cd ocr_server
   chmod +x ocr_server
   ```

3. **執行服務**
   ```bash
   ./ocr_server
   ```

4. **如遇安全性警告**
   - 右鍵點擊執行檔 → 選擇「打開」
   - 或到「系統偏好設定」→「安全性與隱私」→ 允許執行

5. **確認運行**
   - 開啟瀏覽器，訪問 http://localhost:5511/health
   - 應該會看到 `{"status": "ok", "message": "OCR Server 運行中"}`

## 🔧 使用流程

1. **啟動 OCR Server**（依照上述步驟）

2. **安裝 Chrome 擴充功能**
   - 確保已安裝相應的 Tixcraft Chrome Extension

3. **瀏覽 Tixcraft**
   - Extension 會自動將驗證碼圖片傳送到本地 API
   - OCR Server 會自動辨識並回傳結果

4. **關閉服務**
   - 在執行視窗按 `Ctrl+C`（Windows/Mac 皆可）
   - 或直接關閉視窗

## ⚠️ 常見問題

### Q: 防毒軟體警告此程式有風險？

**A:** 這是正常現象。PyInstaller 打包的執行檔沒有數位簽章，所以會被某些防毒軟體標記。請放心使用，或將程式加入白名單。

### Q: Windows Defender 防火牆彈出警告？

**A:** 請點擊「允許存取」。OCR Server 需要監聽 5511 port 來接收請求。

### Q: Mac 提示「無法打開，因為來自未識別的開發者」？

**A:** 解決方式：
1. 右鍵點擊執行檔
2. 選擇「打開」
3. 在彈出視窗中點擊「打開」

或者：
1. 前往「系統偏好設定」→「安全性與隱私」
2. 在「一般」標籤下，點擊「仍要打開」

### Q: 執行後沒有反應？

**A:** 檢查：
1. 確認 5511 port 沒被其他程式占用
2. 檢查防火牆是否封鎖了程式
3. 嘗試以管理員身份執行（Windows）

### Q: Chrome Extension 連不上 OCR Server？

**A:** 確認：
1. OCR Server 是否正在執行（視窗應該保持開啟）
2. 訪問 http://localhost:5511/health 確認服務正常
3. 檢查 Chrome Extension 的設定是否指向 http://localhost:5511

### Q: 辨識速度很慢？

**A:** 
- 首次啟動時較慢（約 5-10 秒），這是正常的初始化過程
- 後續辨識應該很快（通常 < 1 秒）
- 如果持續很慢，可能是電腦效能問題

### Q: 可以在背景執行嗎？

**A:** 
- Windows: 可以最小化視窗，但不要關閉
- Mac: 可以隱藏視窗（Cmd+H），但程式需保持運行

### Q: 需要一直啟動嗎？

**A:** 只有在使用 Tixcraft Chrome Extension 搶票時才需要啟動。平時可以關閉。

### Q: 會不會有安全性問題？

**A:** 
- 此服務只在本地執行（localhost），不會對外開放
- 只接收驗證碼圖片，不會收集其他資訊
- 完全離線運行，不會連接外部伺服器

## 📋 技術資訊

- **監聽位址**：http://localhost:5511
- **API 端點**：
  - `POST /ocr` - 辨識驗證碼
  - `GET /health` - 健康檢查
- **支援格式**：Base64 編碼的圖片
- **辨識引擎**：ddddocr 1.5.6

## 🐛 回報問題

如果遇到無法解決的問題，請提供：
1. 作業系統版本（Windows 10/11, macOS 版本等）
2. 錯誤訊息截圖或執行視窗的完整輸出
3. 問題發生的步驟

## 📞 支援

更多技術細節請參考：
- [開發者文件](BUILD_README.md)
- [原始碼](https://github.com/...)
