// ============================================================
// background.js — 背景服務工作執行緒（Service Worker）
// ============================================================
// 功能：
// 1. 處理擴充功能圖示點擊，開啟側邊欄（Side Panel）
// 2. 監聆分頁更新，自動重新注入平台腳本
// 3. 代理轉送 OCR 請求，繞過 CORS 限制
// 4. 恢復中斷的流程（當網頁重新載入時）
// ============================================================

// 平台 URL 比對模式
const KKTIX_PATTERN = /^https:\/\/([a-z0-9-]+\.)?kktix\.com\//;
const TIXCRAFT_PATTERN = /^https:\/\/([a-z0-9-]+\.)?tixcraft\.com\//;
const INLINE_PATTERN = /^https:\/\/([a-z0-9-]+\.)?inline\.app\//;;

/**
 * 平台重新注入規則設定
 * 當分頁重新載入時，根據這些規則自動注入腳本並恢復流程
 */
const PLATFORM_REINJECTION_RULES = [
  {
    key: "kktix",                                    // 平台識別碼
    pattern: KKTIX_PATTERN,                          // URL 比對模式
    status: "complete",                              // 監聆的分頁狀態（loading/complete）
    runningKey: "kktix_isRunning",                  // Storage 中儲存的執行狀態 key
    configKey: "kktix_runningConfig",               // Storage 中儲存的設定 key
    injectDelayMs: 800,                              // 注入後延遲多久才傳送 START 指令（毫秒）
    scripts: ["shared.js", "kktix/kktix-content.js"], // 要注入的腳本檔案
    buildStartPayload: (cfg) => ({                   // 建立 START 指令的 payload
      action: "START",
      buyCount: cfg.buyCount,
      chooseArea: cfg.chooseArea,
      memberCode: cfg.memberCode,
      question: cfg.question,
    }),
  },
  {
    key: "tixcraft",
    pattern: TIXCRAFT_PATTERN,
    status: "loading",                               // Tixcraft 在 loading 階段就需要注入（提早攻擊 alert）
    runningKey: "tixcraft_isRunning",
    configKey: "tixcraft_runningConfig",
    injectDelayMs: 200,
    preScripts: [{ files: ["tixcraft/tixcraft-alert-override.js"], world: "MAIN" }],  // 預先注入到 MAIN world
    scripts: ["shared.js", "tixcraft/tixcraft-content.js"],
    buildStartPayload: (cfg) => ({
      action: "START",
      buyCount: cfg.buyCount,
      chooseDate: normalizeKeywordInput(cfg.chooseDate),
      chooseArea: normalizeKeywordInput(cfg.chooseArea),
      excludeArea: cfg.excludeArea ?? "",
      ocrApiUrl: cfg.ocrApiUrl,
      areaFallback: cfg.areaFallback ?? "refresh",
      dateFallback: cfg.dateFallback ?? "refresh",
      reloadDelay: cfg.reloadDelay ?? 1,
      targetUrl: cfg.targetUrl ?? "",
      verifyCode: cfg.verifyCode ?? "",
    }),
  },
  {
    key: "inline",
    pattern: INLINE_PATTERN,
    status: "complete",
    runningKey: "inline_isRunning",
    configKey: "inline_runningConfig",
    injectDelayMs: 500,
    scripts: ["inline/inline-content.js"],
    buildStartPayload: (cfg) => ({
      action: "START",
      ...cfg,  // Inline 直接傳送所有設定
    }),
  },
];

/**
 * 擴充功能圖示點擊事件監聴器
 * 當使用者點擊瀏覽器工具列的擴充功能圖示時，開啟側邊欄
 */
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

/**
 * 從 Chrome Storage 讀取資料的包裝函式
 * @param {string|string[]} keys - 要讀取的鍵名
 * @returns {Promise<Object>}
 */
function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

/**
 * 延遲執行
 * @param {number} ms - 延遲的毫秒數
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 將關鍵字輸入正規化為陣列
 * @param {string|string[]} value - 輸入值（字串或陣列）
 * @returns {string[]} 正規化後的陣列
 */
function normalizeKeywordInput(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * 批次執行腳本注入
 * @param {number} tabId - 分頁 ID
 * @param {Object} batch - 腳本批次設定（files, world 等）
 */
async function executeScriptBatch(tabId, batch) {
  await chrome.scripting.executeScript({
    target: { tabId },
    ...batch,
  });
}

/**
 * 根據平台規則注入所有必要的腳本
 * @param {number} tabId - 分頁 ID
 * @param {Object} rule - 平台規則物件
 */
async function injectPlatformScripts(tabId, rule) {
  // 預先注入的腳本（如 Tixcraft 的 alert override）
  for (const batch of rule.preScripts || []) {
    await executeScriptBatch(tabId, batch);
  }

  // 注入主要腳本（shared.js 和平台專用腳本）
  await executeScriptBatch(tabId, { files: rule.scripts });
}

/**
 * 傳送 START 指令給內容腳本
 * @param {number} tabId - 分頁 ID
 * @param {Object} payload - 要傳送的訊息
 * @param {string} label - 平台名稱（用於記錄）
 * @returns {Promise<boolean>} 傳送成功回傳 true
 */
function sendStartMessage(tabId, payload, label) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(`[tickethelper] ${label} START failed:`, chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      console.log(`[tickethelper] ${label} START sent`, response);
      resolve(true);
    });
  });
}

/**
 * 恢復平台流程執行
 * 當分頁重新載入且先前有進行中的流程時，自動恢復執行
 * 
 * @param {number} tabId - 分頁 ID
 * @param {Object} rule - 平台規則物件
 * 
 * 流程：
 * 1. 從 Storage 讀取執行狀態和設定
 * 2. 如果有進行中的流程，重新注入腳本
 * 3. 等待指定時間後傳送 START 指令
 */
async function resumePlatformRun(tabId, rule) {
  const result = await storageGet([rule.runningKey, rule.configKey]);
  
  // 檢查是否有進行中的流程
  if (!result[rule.runningKey] || !result[rule.configKey]) {
    return;
  }

  // 重新進入目標頁後，自動補注入腳本並恢復原本的執行設定。
  console.log(`[tickethelper] Reinjecting ${rule.key} flow`);

  try {
    await injectPlatformScripts(tabId, rule);
  } catch (error) {
    console.warn(`[tickethelper] ${rule.key} inject failed:`, error.message);
    return;
  }

  // 等待腳本初始化完成
  await delay(rule.injectDelayMs);
  
  // 建立並傳送 START 指令
  const payload = rule.buildStartPayload(result[rule.configKey]);
  await sendStartMessage(tabId, payload, rule.key);
}

/**
 * 分頁更新事件監聴器
 * 當分頁 URL 或狀態變更時，檢查是否需要自動恢復流程
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const pageUrl = changeInfo.url || tab.url;
  if (!pageUrl) return;

  // 遍歷所有平台規則，檢查是否符合任何平台的 URL 模式
  for (const rule of PLATFORM_REINJECTION_RULES) {
    if (!rule.pattern.test(pageUrl)) continue;  // URL 不符合，跳過
    if (changeInfo.status !== rule.status) continue;  // 狀態不符合，跳過
    await resumePlatformRun(tabId, rule);  // 嘗試恢復流程
  }
});

/**
 * 訊息監聆器：處理 OCR 請求
 * 由背景頁代理 OCR API 請求，避免內容腳本直接受 CORS 限制影響
 * 
 * 流程：
 * 1. 內容腳本傳送 OCR_REQUEST 訊息
 * 2. 背景頁使用 fetch API 傳送圖片給 OCR 服務
 * 3. 將 OCR 結果回傳給內容腳本
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== "OCR_REQUEST") return false;

  // 由背景頁代理 OCR 請求，避免內容腳本直接受跨來源限制影響。
  const { ocrApiUrl, image } = msg;
  fetch(ocrApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  })
    .then(res => {
      if (!res.ok) throw new Error(`OCR API HTTP ${res.status}`);
      return res.json();
    })
    .then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));

  return true;  // 保持訊息通道開啟，等待非同步回應
});

/**
 * 擴充功能安裝事件監聆器
 * 記錄擴充功能安裝或更新的事件
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    console.log("[tickethelper] installed");
  }
});
