// ============================================================
//  background.js — Service Worker
//  負責在頁面 reload 後自動重新注入 content.js 並恢復搶票流程
// ============================================================

// Tixcraft 網址匹配規則
const TIXCRAFT_PATTERN = /^https:\/\/([a-z0-9-]+\.)?tixcraft\.com\//;

// ── 獨立視窗開啟 popup ───────────────────────────────────────
// 移除 default_popup 後，透過 onClicked 以獨立視窗開啟，
// 這樣點擊 popup 外不會自動關閉。
let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  // 若視窗已存在，聚焦至現有視窗而不重複開啟
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch (_) {
      // 視窗已被關閉，重置 ID 再建新視窗
      popupWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",       // 無工具列的瀏覽器小視窗
    width: 480,
    height: 640,
    focused: true,
  });
  popupWindowId = win.id;
});

// 視窗關閉時清除記錄
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// 監聽分頁更新事件：當 Tixcraft 頁面載入完成，且儲存狀態為「執行中」，
// 自動重新注入 content.js 並恢復搶票流程
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 頁面開始載入時即觸發（不等 complete）
  if (changeInfo.status !== "loading") return;

  // 只處理 Tixcraft 網域（loading 時 URL 從 changeInfo 或 tab 取得）
  const pageUrl = changeInfo.url || tab.url;
  if (!pageUrl || !TIXCRAFT_PATTERN.test(pageUrl)) return;

  // 讀取儲存的執行狀態
  chrome.storage.local.get(["isRunning", "runningConfig"], async (result) => {
    if (!result.isRunning || !result.runningConfig) return;

    console.log("[Tixcraft助手] 偵測到頁面轉跳，立即重新注入腳本...");

    try {
      // 重新注入 content.js
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    } catch (err) {
      // 注入失敗（例如頁面不允許），停止重試
      console.warn("[Tixcraft助手] 腳本注入失敗：", err.message);
      return;
    }

    // content.js 已在 document_start 注入，內部會自動等待 DOMContentLoaded 後啟動流程。
    // 稍作延遲以確保訊息監聽器已登記。
    await new Promise(resolve => setTimeout(resolve, 200));

    const cfg = result.runningConfig;
    chrome.tabs.sendMessage(
      tabId,
      {
        action:       "START",
        buyCount:     cfg.buyCount,
        chooseDate:   Array.isArray(cfg.chooseDate)
                        ? cfg.chooseDate
                        : (cfg.chooseDate ? cfg.chooseDate.split(",").map(s => s.trim()).filter(Boolean) : []),
        chooseArea:   Array.isArray(cfg.chooseArea)
                        ? cfg.chooseArea
                        : (cfg.chooseArea ? cfg.chooseArea.split(",").map(s => s.trim()).filter(Boolean) : []),
        ocrApiUrl:    cfg.ocrApiUrl,
        areaFallback: cfg.areaFallback ?? "refresh",
        dateFallback: cfg.dateFallback ?? "refresh",
        reloadDelay:  cfg.reloadDelay ?? 1,
        targetUrl:    cfg.targetUrl ?? "",
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Tixcraft助手] 送出 START 失敗：", chrome.runtime.lastError.message);
          return;
        }
        console.log("[Tixcraft助手] 已恢復搶票流程", response);
      }
    );
  });
});

// ── OCR API 代理 ─────────────────────────────────────────────
// content.js 執行於 https://tixcraft.com (HTTPS) 環境，
// Chrome 會自動將 http://localhost 的 fetch 升級為 HTTPS，
// 導致 POST 請求出現 ERR_SSL_PROTOCOL_ERROR。
// 解決方式：由 background service worker（不受混合內容限制）
// 代為發出 HTTP 請求，再將結果回傳給 content.js。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== "OCR_REQUEST") return false; // 非 OCR 請求，不處理

  const { ocrApiUrl, image } = msg;
  fetch(ocrApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  })
    .then(res => {
      if (!res.ok) throw new Error(`OCR API 回應錯誤：HTTP ${res.status}`);
      return res.json();
    })
    .then(data => sendResponse({ success: true, data }))
    .catch(err => sendResponse({ success: false, error: err.message }));

  return true; // 保持 sendResponse 的通道開啟（非同步回應必須）
});

// 當擴充功能安裝或更新時，顯示歡迎訊息
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[Tixcraft助手] 擴充功能已安裝");
  }
});
