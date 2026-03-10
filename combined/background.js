// ============================================================
//  background.js — Service Worker（KKTIX + Tixcraft 整合版）
//  負責：
//    1. 以獨立視窗開啟 popup（避免點外側自動關閉）
//    2. KKTIX 頁面 reload 後自動重新注入腳本並恢復流程
//    3. Tixcraft 頁面跳轉時自動重新注入腳本並恢復流程
//    4. 代理 Tixcraft OCR API 請求（繞過混合內容限制）
// ============================================================

// 網址匹配規則
const KKTIX_PATTERN    = /^https:\/\/([a-z0-9-]+\.)?kktix\.com\//;
const TIXCRAFT_PATTERN = /^https:\/\/([a-z0-9-]+\.)?tixcraft\.com\//;

// ── 獨立視窗開啟 popup ───────────────────────────────────────
// 點擊擴充功能圖示時，以獨立視窗開啟 popup.html，
// 不使用 default_popup 以避免點外側自動關閉。
let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  // 若視窗已存在，聚焦至現有視窗
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch (_) {
      // 視窗已關閉，重置後重新建立
      popupWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 320,
    height: 620,
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

// ── 分頁更新監聽器 ────────────────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const pageUrl = changeInfo.url || tab.url;
  if (!pageUrl) return;

  // ── KKTIX：頁面 complete 後重注入 ─────────────────────────
  if (KKTIX_PATTERN.test(pageUrl) && changeInfo.status === "complete") {
    chrome.storage.local.get(["kktix_isRunning", "kktix_runningConfig"], async (result) => {
      if (!result.kktix_isRunning || !result.kktix_runningConfig) return;

      console.log("[搶票助手] 偵測到 KKTIX 頁面重載，自動重新注入腳本...");

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["kktix-content.js"],
        });
      } catch (err) {
        console.warn("[搶票助手] KKTIX 腳本注入失敗：", err.message);
        return;
      }

      // 等待腳本初始化完成後再送出 START 指令
      await new Promise(resolve => setTimeout(resolve, 800));

      const cfg = result.kktix_runningConfig;
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
            console.warn("[搶票助手] KKTIX START 失敗：", chrome.runtime.lastError.message);
            return;
          }
          console.log("[搶票助手] KKTIX 已恢復搶票流程", response);
        }
      );
    });
  }

  // ── Tixcraft：頁面開始載入即重注入 ────────────────────────
  if (TIXCRAFT_PATTERN.test(pageUrl) && changeInfo.status === "loading") {
    chrome.storage.local.get(["tixcraft_isRunning", "tixcraft_runningConfig"], async (result) => {
      if (!result.tixcraft_isRunning || !result.tixcraft_runningConfig) return;

      console.log("[搶票助手] 偵測到 Tixcraft 頁面跳轉，立即重新注入腳本...");

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["tixcraft-content.js"],
        });
      } catch (err) {
        console.warn("[搶票助手] Tixcraft 腳本注入失敗：", err.message);
        return;
      }

      // 稍作延遲確保訊息監聽器已登記
      await new Promise(resolve => setTimeout(resolve, 200));

      const cfg = result.tixcraft_runningConfig;
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
          verifyCode:   cfg.verifyCode ?? "",
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[搶票助手] Tixcraft START 失敗：", chrome.runtime.lastError.message);
            return;
          }
          console.log("[搶票助手] Tixcraft 已恢復搶票流程", response);
        }
      );
    });
  }
});

// ── OCR API 代理（Tixcraft 專用）──────────────────────────────
// content.js 在 HTTPS 環境無法直接對 http://localhost 發出 fetch，
// 由 background service worker 代理發出 HTTP 請求後回傳結果。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== "OCR_REQUEST") return false;

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

  return true; // 保持非同步回應通道開啟
});

// 安裝時顯示歡迎訊息
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[搶票助手] 擴充功能已安裝（整合版）");
  }
});
