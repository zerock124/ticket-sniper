"""
OCR Server 打包腳本
===================
此腳本用於將 ocr_server.py 打包成可執行檔

使用方式：
  1. 安裝打包依賴：
       pip install pyinstaller
  2. 執行打包：
       python build_exe.py

打包完成後，可執行檔將位於 ../tickethelper/ocr_server/ 目錄中
"""

import os
import sys
import subprocess
import platform

def build_executable():
    """使用 PyInstaller 打包 OCR Server"""
    
    # 取得目標輸出目錄的絕對路徑
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_dir = os.path.join(script_dir, "..", "tickethelper", "ocr_server")
    output_dir = os.path.abspath(output_dir)
    
    print("=" * 60)
    print("  開始打包 OCR Server")
    print("  目標平台：", platform.system())
    print(f"  輸出目錄：{output_dir}")
    print("=" * 60)
    
    # PyInstaller 打包命令
    cmd = [
        "pyinstaller",
        "--name=ocr_server",           # 執行檔名稱
        "--onedir",                     # 打包成目錄（包含所有依賴）
        "--console",                    # 顯示控制台視窗
        "--noconfirm",                  # 覆蓋現有輸出目錄
        "--clean",                      # 清理暫存檔案
        "--distpath", output_dir,       # 指定輸出目錄
        "--add-data", "ocr_server.py" + os.pathsep + ".",  # 包含主程式
        # 確保包含 ddddocr 的模型數據
        "--hidden-import=ddddocr",
        "--hidden-import=onnxruntime",
        "--hidden-import=PIL",
        "--hidden-import=flask",
        "--hidden-import=flask_cors",
        "--collect-all=ddddocr",        # 包含 ddddocr 所有資源
        "--collect-all=onnxruntime",    # 包含 onnxruntime 所有資源
        "ocr_server.py"
    ]
    
    print("\n執行命令：")
    print(" ".join(cmd))
    print()
    
    try:
        # 執行打包
        result = subprocess.run(cmd, check=True)
        
        print("\n" + "=" * 60)
        print("  ✓ 打包完成！")
        print("=" * 60)
        print(f"\n可執行檔位置：{output_dir}")
        
        if platform.system() == "Windows":
            print(f"執行方式：{os.path.join(output_dir, 'ocr_server.exe')}")
        else:
            print(f"執行方式：{os.path.join(output_dir, 'ocr_server')}")
            
        print("\n注意事項：")
        print("  1. 整個 ocr_server 目錄需要一起分發")
        print("  2. 首次執行時防毒軟體可能會警告，請允許執行")
        print("  3. 執行檔會在 http://localhost:5511 啟動服務")
        
    except subprocess.CalledProcessError as e:
        print(f"\n✗ 打包失敗：{e}")
        sys.exit(1)
    except FileNotFoundError:
        print("\n✗ 找不到 PyInstaller，請先安裝：")
        print("    pip install pyinstaller")
        sys.exit(1)


if __name__ == "__main__":
    build_executable()
