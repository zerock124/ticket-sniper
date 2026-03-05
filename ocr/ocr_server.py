"""
ocr_server.py — Tixcraft 驗證碼辨識本地 API Server
=====================================================
使用方式：
  1. 安裝依賴套件：
       pip install flask ddddocr flask-cors
  2. 啟動服務（預設監聽 port 5000）：
       python ocr_server.py

Chrome Extension 會自動向 http://localhost:5000/ocr 送出 Base64 圖片，
此 Server 使用 ddddocr 辨識後回傳文字結果。
"""

import base64
import io

# ── Pillow 10.0 相容性補丁 ──────────────────────────────────────
# Pillow >= 10.0.0 移除了 Image.ANTIALIAS，改為 Image.LANCZOS
# ddddocr 內部仍使用舊屬性，此補丁在 ddddocr 載入前先行修補
import PIL.Image
if not hasattr(PIL.Image, "ANTIALIAS"):
    PIL.Image.ANTIALIAS = PIL.Image.LANCZOS

import ddddocr
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)

# 允許來自 Chrome Extension 及 Tixcraft 頁面的跨來源請求
# content.js 在 tixcraft.com 頁面中執行，fetch 的 Origin 為 tixcraft.com，
# 因此需同時允許 tixcraft.com 網域
CORS(app, origins=[
    "https://tixcraft.com",
    "https://www.tixcraft.com",
    "https://tixcraft.net",
    "https://www.tixcraft.net",
])

# 初始化 ddddocr（只初始化一次，節省效能）
ocr = ddddocr.DdddOcr()

@app.route("/ocr", methods=["POST"])
def recognize():
    """
    接收 Base64 編碼的驗證碼圖片，回傳辨識結果。

    請求格式（JSON）：
        { "image": "<base64_string>" }

    回應格式（JSON）：
        成功：{ "code": "ABC123", "success": true }
        失敗：{ "error": "...", "success": false }
    """
    data = request.get_json(silent=True)
    if not data or "image" not in data:
        return jsonify({"success": False, "error": "缺少 image 欄位"}), 400

    try:
        # 去除 data URL 前綴（如 "data:image/png;base64,"）
        raw = data["image"]
        if "," in raw:
            raw = raw.split(",", 1)[1]

        # Base64 解碼為二進位圖片
        img_bytes = base64.b64decode(raw)

        # ddddocr 辨識
        result = ocr.classification(img_bytes)

        print(f"[OCR] 辨識結果：{result}")
        return jsonify({"success": True, "code": result})

    except Exception as e:
        print(f"[OCR] 辨識失敗：{e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    """健康檢查端點，供 Extension 確認 Server 是否正常運行"""
    return jsonify({"status": "ok", "message": "OCR Server 運行中"})


if __name__ == "__main__":
    print("=" * 50)
    print("  Tixcraft OCR Server 已啟動")
    print("  監聽位址：http://localhost:5511")
    print("  驗證碼辨識端點：POST /ocr")
    print("  健康檢查端點：GET /health")
    print("=" * 50)
    app.run(host="0.0.0.0", port=5511, debug=False)
