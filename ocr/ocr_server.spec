# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 配置檔案（--onefile 模式）
======================================
使用方式：
  pyinstaller ocr_server.spec
"""
import os
from PyInstaller.utils.hooks import collect_all

# 輸出單一 exe 到 tickethelper 目錄
SPEC_DIR = os.path.dirname(os.path.abspath(SPECPATH))
DISTDIR = os.path.abspath(os.path.join(SPEC_DIR, '..', 'tickethelper', 'ocr_server'))

datas = []
binaries = []
hiddenimports = [
    'flask',
    'flask_cors',
    'PIL',
    'PIL.Image',
]

tmp_ret = collect_all('ddddocr')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

tmp_ret = collect_all('onnxruntime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

a = Analysis(
    ['ocr_server.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['rth_onnxruntime.py'],  # console 暫停機制
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ocr_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # 顯示 console 視窗
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    distpath=DISTDIR,
)
