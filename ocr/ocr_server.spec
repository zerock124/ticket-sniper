# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 配置檔案
====================
用於更細緻地控制打包過程

使用方式：
  pyinstaller ocr_server.spec
"""

import sys
import os
from PyInstaller.utils.hooks import collect_all, collect_data_files

# 設定輸出目錄到 tickethelper/ocr_server
SPEC_DIR = os.path.dirname(os.path.abspath(SPECPATH))
DISTDIR = os.path.join(SPEC_DIR, "..", "tickethelper", "ocr_server")
DISTDIR = os.path.abspath(DISTDIR)

block_cipher = None

# 收集 ddddocr 的所有數據（包括模型檔案）
datas_ddddocr = []
binaries_ddddocr = []
hiddenimports_ddddocr = []

tmp_ret = collect_all('ddddocr')
datas_ddddocr += tmp_ret[0]
binaries_ddddocr += tmp_ret[1]
hiddenimports_ddddocr += tmp_ret[2]

# 收集 onnxruntime 的所有數據
datas_onnx = []
binaries_onnx = []
hiddenimports_onnx = []

tmp_ret = collect_all('onnxruntime')
datas_onnx += tmp_ret[0]
binaries_onnx += tmp_ret[1]
hiddenimports_onnx += tmp_ret[2]

# 合併所有數據
all_datas = datas_ddddocr + datas_onnx
all_binaries = binaries_ddddocr + binaries_onnx
all_hiddenimports = hiddenimports_ddddocr + hiddenimports_onnx + [
    'flask',
    'flask_cors',
    'PIL',
    'PIL.Image',
    'io',
    'base64',
]

a = Analysis(
    ['ocr_server.py'],
    pathex=[],
    binaries=all_binaries,
    datas=all_datas,
    hiddenimports=all_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ocr_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # 顯示控制台視窗
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ocr_server',
    distpath=DISTDIR,
)
