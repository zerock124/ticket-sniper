#!/bin/bash
cd "$(dirname "$0")"

# 確認 python3.13 是否存在
if ! command -v python3.13 &>/dev/null; then
    echo "錯誤：找不到 python3.13"
    echo "請先安裝 Python 3.13：https://www.python.org/downloads/release/python-31311/"
    read -p "按下 Enter 鍵關閉..."
    exit 1
fi

echo "使用 Python 版本：$(python3.13 --version)"
echo "檢查依賴套件..."
python3.13 -m pip install -r requirements.txt --quiet
echo "啟動 OCR Server..."
python3.13 ocr_server.py
