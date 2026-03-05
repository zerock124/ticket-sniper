# 使用官方 Python 3.8 slim 版本作為基礎映像
FROM python:3.8-slim

# 設定工作目錄
WORKDIR /app

# 安裝系統依賴（ddddocr / Pillow 需要 libgl 與 libglib2）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 先複製依賴清單並安裝，利用 Docker 層快取加速後續建置
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製應用程式原始碼
COPY ocr_server.py .

# 對外開放 5511 埠
EXPOSE 5511

# 啟動 OCR Server
CMD ["python", "ocr_server.py"]
