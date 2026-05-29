@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 搜尋 Python 3.13
set PY313=
for %%p in (
    "%LocalAppData%\Programs\Python\Python313\python.exe"
    "C:\Python313\python.exe"
    "C:\Program Files\Python313\python.exe"
) do (
    if exist %%p set PY313=%%~p
)

if "%PY313%"=="" (
    echo 錯誤：找不到 Python 3.13
    echo 請先安裝 Python 3.13：https://www.python.org/downloads/release/python-31311/
    pause
    exit /b 1
)

echo 使用 Python 版本：
"%PY310%" --version
echo 檢查依賴套件...
"%PY310%" -m pip install -r requirements.txt --quiet
echo 啟動 OCR Server...
"%PY310%" ocr_server.py
