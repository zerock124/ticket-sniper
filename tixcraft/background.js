// ============================================================
//  background.js — Service Worker
//  負責在頁面 reload 後自動重新注入 content.js 並恢復搶票流程
// ============================================================

// Tixcraft 網址匹配規則
const TIXCRAFT_PATTERN = /^https:\/\/([a-z0-9-]+\.)?tixcraft\.com\//;

// ── reload 後自動重注入 ───────────────────────────────────────
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
    // 僅需偷小延遲確保訊息監聽器已登記。
    await new Promise(resolve => setTimeout(resolve, 200));

    const cfg = result.runningConfig;
    chrome.tabs.sendMessage(
      tabId,
      {
        action:     "START",
        buyCount:   cfg.buyCount,
        chooseDate: Array.isArray(cfg.chooseDate)
                      ? cfg.chooseDate
                      : (cfg.chooseDate ? cfg.chooseDate.split(",").map(s => s.trim()).filter(Boolean) : []),
        chooseArea: Array.isArray(cfg.chooseArea)
                      ? cfg.chooseArea
                      : (cfg.chooseArea ? cfg.chooseArea.split(",").map(s => s.trim()).filter(Boolean) : []),
        ocrApiUrl:  cfg.ocrApiUrl,
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

// 當擴充功能安裝或更新時，顯示歡迎訊息
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[Tixcraft助手] 擴充功能已安裝");
  }
});
