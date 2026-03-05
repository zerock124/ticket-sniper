// ============================================================
//  background.js — Service Worker
//  負責轉發訊息，以及在頁面 reload 後自動重新注入 content.js
// ============================================================

// KKTIX 網址匹配規則
const KKTIX_PATTERN = /^https:\/\/([a-z0-9-]+\.)?kktix\.com\//;

// ── reload 後自動重注入 ───────────────────────────────────────
// 監聽分頁更新事件：當 KKTIX 頁面載入完成，且儲存狀態為「執行中」，
// 自動重新注入 content.js 並恢復搶票流程
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 只處理頁面完全載入完成的事件
  if (changeInfo.status !== "complete") return;

  // 只處理 KKTIX 網域
  if (!tab.url || !KKTIX_PATTERN.test(tab.url)) return;

  // 讀取儲存的執行狀態
  chrome.storage.local.get(["isRunning", "runningConfig"], async (result) => {
    if (!result.isRunning || !result.runningConfig) return;

    console.log("[KKTIX助手] 偵測到頁面重新載入，自動重新注入腳本...");

    try {
      // 重新注入 content.js
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    } catch (err) {
      // 注入失敗（例如頁面不允許），停止重試
      console.warn("[KKTIX助手] 腳本注入失敗：", err.message);
      return;
    }

    // 稍等頁面腳本初始化完成後再送出 START 指令
    await new Promise(resolve => setTimeout(resolve, 800));

    const cfg = result.runningConfig;
    chrome.tabs.sendMessage(
      tabId,
      {
        action:     "START",
        buyCount:   cfg.buyCount,
        chooseArea: cfg.chooseArea,
        memberCode: cfg.memberCode,
        question:   cfg.question,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[KKTIX助手] 送出 START 失敗：", chrome.runtime.lastError.message);
          return;
        }
        console.log("[KKTIX助手] 已恢復搶票流程", response);
      }
    );
  });
});

// 當擴充功能安裝或更新時，顯示歡迎訊息
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[KKTIX助手] 擴充功能已安裝");
  }
});
