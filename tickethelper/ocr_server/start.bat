@echo off
chcp 65001 >nul

REM 搜尋 Python 3.10
set PY310=
for %%p in (
    "%LocalAppData%\Programs\Python\Python310\python.exe"
    "C:\Python310\python.exe"
    "C:\Program Files\Python310\python.exe"
) do (
    if exist %%p set PY310=%%p
)

if "%PY310%"=="" (
    echo 錯誤：找不到 Python 3.10
    echo 請先安裝 Python 3.10：https://www.python.org/downloads/release/python-31011/
    pause
    exit /b 1
)

echo 啟動 OCR Server...
ocr_server.exe
