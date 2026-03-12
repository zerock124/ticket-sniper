# OCR Server 打包說明

將 OCR Server 打包成可執行檔，讓用戶無需安裝 Python 即可運行。

## 📦 打包步驟

### 方法一：使用 build_exe.py（推薦）

1. **安裝打包依賴**
   ```bash
   pip install -r requirements.txt
   pip install pyinstaller
   ```

2. **執行打包腳本**
   ```bash
   python build_exe.py
   ```

3. **完成**
   - 可執行檔位於 `dist/ocr_server/` 目錄
   - Windows: `dist/ocr_server/ocr_server.exe`
   - Mac/Linux: `dist/ocr_server/ocr_server`

### 方法二：使用 spec 檔案（進階）

如果需要更細緻的控制，可以直接使用 spec 檔案：

```bash
pip install pyinstaller
pyinstaller ocr_server.spec
```

## 🚀 使用打包後的執行檔

### Windows
```bash
cd dist\ocr_server
ocr_server.exe
```

### Mac/Linux
```bash
cd dist/ocr_server
./ocr_server
```

執行後，服務會在 `http://localhost:5511` 啟動。

## 📤 分發給用戶

1. **壓縮整個目錄**
   - 將整個 `dist/ocr_server/` 目錄打包成 zip
   - 不能只分發 exe 檔案，必須包含所有依賴檔案

2. **為 Windows 和 Mac 分別打包**
   - 在 Windows 上打包 → Windows 版本
   - 在 Mac 上打包 → Mac 版本
   - 無法跨平台打包

3. **檔案大小**
   - 打包後約 100-200 MB（包含模型檔案）
   - 這是正常的，因為包含了完整的 Python 環境和 ddddocr 模型

## ⚠️ 注意事項

### 防毒軟體警告
- 首次執行時，某些防毒軟體可能會警告
- 這是因為 PyInstaller 打包的執行檔沒有數位簽章
- 用戶需要允許執行或加入白名單

### 防火牆設定
- Windows Defender 可能會彈出防火牆警告
- 需要允許應用程式使用網路（監聽 5511 port）

### Mac 安全性設定
- Mac 用戶可能會遇到「來自未識別的開發者」警告
- 解決方式：
  1. 右鍵點擊執行檔 → 選擇「打開」
  2. 或在「系統偏好設定」→「安全性與隱私」中允許

### 效能
- 首次啟動較慢（約 5-10 秒），因為需要解壓和初始化
- 後續辨識速度與直接執行 Python 腳本相同

## 🔧 自訂打包設定

如果需要自訂打包設定，可以編輯 `ocr_server.spec` 檔案：

- **修改執行檔名稱**：修改 `name='ocr_server'`
- **無視窗模式**：將 `console=True` 改為 `console=False`（不建議，會看不到日誌）
- **單一執行檔**：將 `--onedir` 改為 `--onefile`（檔案較大，啟動較慢）

## 🐛 疑難排解

### 打包失敗：找不到 ddddocr

確保已安裝所有依賴：
```bash
pip install -r requirements.txt
pip install pyinstaller
```

### 執行檔無法啟動

檢查是否缺少系統依賴：
- Windows: 需要 Visual C++ Redistributable
- Mac: 需要 Command Line Tools

### 模型檔案未包含

執行時出現 "model file not found" 錯誤：
- 使用 `--collect-all=ddddocr` 選項確保包含所有資源
- 或使用提供的 spec 檔案打包

### 打包檔案過大

可以嘗試：
- 使用虛擬環境打包，避免包含不必要的套件
- 使用 `--exclude-module` 排除不需要的模組
- 使用 UPX 壓縮（已在 spec 中啟用）

## 📝 發布清單

發布給用戶時，建議包含：

1. ✅ 打包後的執行檔目錄（`dist/ocr_server/`）
2. ✅ 簡單的使用說明（如何啟動、如何檢查運行狀態）
3. ✅ 常見問題解答（防毒軟體警告、防火牆設定）
4. ✅ Chrome Extension 的配置說明（如何連接到本地 API）

## 🔗 相關連結

- [PyInstaller 官方文件](https://pyinstaller.org/)
- [ddddocr 專案](https://github.com/sml2h3/ddddocr)
