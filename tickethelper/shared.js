// ============================================================
// shared.js — 內容腳本共用工具函式庫
// ============================================================
// 提供所有內容腳本共用的工具函式，包括：
// - 延遲執行（delay）
// - 訊息傳遞（sendLog、sendEvent）
// - 表單輸入模擬（typeInput）
// - DOM 元素等待（waitForElement）
// - 圖片轉 Base64（imageElementToBase64）
// - 帶重試的點擊（clickWithRetry）
// - Storage 存取包裝（storageGet、storageSet、storageRemove）
// - 流程控制器工廠函式（createContentController）
// ============================================================

/**
 * 延遲執行指定毫秒數
 * @param {number} ms - 延遲的毫秒數
 * @returns {Promise<void>} 完成延遲後 resolve 的 Promise
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 傳送日誌訊息到 popup 介面並記錄到 console
 * @param {string} text - 日誌訊息內容
 * @param {string} type - 訊息類型："info", "success", "warn", "error"
 * @param {string} source - 訊息來源（平台名稱）
 */
function sendLog(text, type = "info", source = "unknown") {
    console.log(`[tickethelper][${source}] ${text}`);
    chrome.runtime.sendMessage({ from: source, event: "LOG", text, type });
}

/**
 * 傳送事件通知到 popup 介面
 * @param {string} event - 事件名稱（如 "RELOAD", "DONE"）
 * @param {Object} extra - 額外的事件資料
 * @param {string} source - 事件來源（平台名稱）
 */
function sendEvent(event, extra = {}, source = "unknown") {
    chrome.runtime.sendMessage({ from: source, event, ...extra });
}

/**
 * 模擬使用者在輸入框中輸入文字
 * @param {HTMLElement} element - 目標輸入框元素
 * @param {string} text - 要輸入的文字內容
 * @param {boolean} stepByStep - 是否逐字輸入（模擬真實打字）
 * 
 * 功能說明：
 * - 會觸發 focus、input、change 事件
 * - stepByStep=true 時會逐字輸入，繞過某些網站的反機器人檢測
 * - stepByStep=false 時直接設定 value，效率較高
 */
function typeInput(element, text, stepByStep = false) {
    if (!element) return;
    element.focus();

    if (stepByStep) {
        // 逐字輸入模式：模擬真實使用者打字行為
        element.value = "";
        for (const char of String(text ?? "")) {
            element.value += char;
            element.dispatchEvent(new Event("input", { bubbles: true }));
        }
    } else {
        // 直接設定模式：快速填入整段文字
        element.value = text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 觸發 change 事件，讓網站知道輸入框內容已變更
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * 等待 DOM 元素出現在頁面上
 * @param {string} selector - CSS 選擇器
 * @param {number} timeout - 等待超時時間（毫秒），預設 10 秒
 * @param {Document|HTMLElement} context - 搜尋的上下文範圍，預設為整個 document
 * @param {Function} shouldStop - 檢查是否應停止等待的函式
 * @returns {Promise<HTMLElement>} 找到的元素
 * @throws {Error} 超時或被停止時拋出錯誤
 * 
 * 使用情境：
 * - 等待動態載入的內容出現
 * - 等待 AJAX 請求完成後的 DOM 更新
 * - 等待單頁應用（SPA）的路由切換完成
 */
async function waitForElement(selector, timeout = 10000, context = document, shouldStop = null) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        // 檢查是否收到停止指令
        if (shouldStop && shouldStop()) {
            throw new Error("STOPPED");
        }

        // 嘗試找到元素
        const element = context.querySelector(selector);
        if (element) return element;
        
        // 每 100ms 重試一次
        await delay(100);
    }

    // 超時後拋出錯誤
    throw new Error(`Element not found: ${selector}`);
}

/**
 * 將圖片元素轉換為 Base64 編碼字串
 * @param {HTMLImageElement} imgEl - 圖片元素
 * @returns {Promise<string>} Base64 編碼的圖片資料（data:image/png;base64,...）
 * 
 * 用途：
 * - 將驗證碼圖片轉為 Base64 傳送給 OCR 服務
 * - 不受 CORS 限制影響（圖片已載入到瀏覽器）
 * 
 * 實作原理：
 * 1. 建立 Canvas 元素
 * 2. 將圖片繪製到 Canvas 上
 * 3. 使用 toDataURL 轉換為 Base64
 */
async function imageElementToBase64(imgEl) {
    return new Promise((resolve, reject) => {
        const convert = () => {
            try {
                // 建立與圖片相同尺寸的 Canvas
                const canvas = document.createElement("canvas");
                canvas.width = imgEl.naturalWidth || imgEl.width;
                canvas.height = imgEl.naturalHeight || imgEl.height;
                
                // 將圖片繪製到 Canvas 上
                const ctx = canvas.getContext("2d");
                ctx.drawImage(imgEl, 0, 0);
                
                // 轉換為 Base64
                resolve(canvas.toDataURL("image/png"));
            } catch (error) {
                reject(error);
            }
        };

        // 如果圖片已載入完成，直接轉換
        if (imgEl.complete && imgEl.naturalWidth > 0) {
            convert();
            return;
        }

        // 否則等待圖片載入完成
        imgEl.onload = convert;
        imgEl.onerror = () => reject(new Error("Image load failed"));
    });
}

/**
 * 帶重試機制的元素點擊函式
 * @param {string} selector - CSS 選擇器
 * @param {Object} options - 選項設定
 * @param {number} options.maxAttempts - 最大重試次數，預設 10 次
 * @param {number} options.clickCount - 連續點擊次數，預設 1 次
 * @param {Document|HTMLElement} options.context - 搜尋上下文，預設為 document
 * @param {Function} options.shouldStop - 檢查是否應停止的函式
 * @returns {Promise<boolean>} 點擊成功回傳 true
 * @throws {Error} 找不到元素或被停止時拋出錯誤
 * 
 * 使用情境：
 * - 點擊動態載入的按鈕
 * - 需要連續點擊增減數量的按鈕（如購票數量 +1）
 * - 處理網路延遲導致元素尚未出現的情況
 */
async function clickWithRetry(selector, options = {}) {
    const {
        maxAttempts = 10,
        clickCount = 1,
        context = document,
        shouldStop = null,
    } = options;

    let attempts = 0;
    while (attempts < maxAttempts) {
        // 檢查是否收到停止指令
        if (shouldStop && shouldStop()) {
            throw new Error("STOPPED");
        }

        // 嘗試找到並點擊元素
        const element = context.querySelector(selector);
        if (element) {
            // 連續點擊指定次數（中間間隔 50ms）
            for (let index = 0; index < clickCount; index += 1) {
                element.click();
                await delay(50);
            }
            return true;
        }

        // 找不到元素，等待 300ms 後重試
        attempts += 1;
        await delay(300);
    }

    // 超過最大重試次數，拋出錯誤
    throw new Error(`Click target not found: ${selector}`);
}

// ============================================================
// 全域共用工具集合：TicketHelperShared
// ============================================================
// 將所有共用函式封裝到 window.TicketHelperShared 物件中，
// 供各個平台的內容腳本使用。
// ============================================================
(function attachTicketHelperShared() {
    // 防止重複載入
    if (window.TicketHelperShared) return;

    /**
     * 從 Chrome Storage 讀取資料
     * @param {string|string[]} keys - 要讀取的鍵名
     * @returns {Promise<Object>} 包含資料的物件
     */
    function storageGet(keys) {
        return new Promise(resolve => {
            try {
                chrome.storage.local.get(keys, resolve);
            } catch (_) {
                resolve({});
            }
        });
    }

    /**
     * 將資料寫入 Chrome Storage
     * @param {Object} obj - 要寫入的鍵值對物件
     * @returns {Promise<void>}
     */
    function storageSet(obj) {
        return new Promise(resolve => {
            try {
                chrome.storage.local.set(obj, resolve);
            } catch (_) {
                resolve();
            }
        });
    }

    /**
     * 從 Chrome Storage 刪除資料
     * @param {string|string[]} keys - 要刪除的鍵名
     * @returns {Promise<void>}
     */
    function storageRemove(keys) {
        return new Promise(resolve => {
            try {
                chrome.storage.local.remove(keys, resolve);
            } catch (_) {
                resolve();
            }
        });
    }

    /**
     * 將關鍵字字串正規化為陣列
     * @param {string|string[]} value - 輸入的關鍵字（字串或陣列）
     * @param {RegExp} splitter - 分隔符的正則表達式，預設為 /[,;]/
     * @returns {string[]} 正規化後的關鍵字陣列
     * 
     * 功能：
     * - 如果輸入已是陣列，直接清理空項
     * - 如果輸入是字串，依分隔符切分並清理空項
     * 
     * 範例：
     * normalizeKeywordList("A區,B區;C區") => ["A區", "B區", "C區"]
     * normalizeKeywordList(["A區", "", "B區"]) => ["A區", "B區"]
     */
    function normalizeKeywordList(value, splitter = /[,;]/) {
        if (Array.isArray(value)) {
            return value.map(item => String(item).trim()).filter(Boolean);
        }
        return String(value || "")
            .split(splitter)
            .map(item => item.trim())
            .filter(Boolean);
    }

    /**
     * 建立內容腳本流程控制器
     * 這是一個工廠函式，為每個平台（Tixcraft, KKTIX, Inline）建立獨立的控制器。
     * 
     * @param {Object} options - 控制器設定
     * @param {string} options.source - 平台名稱（如 "tixcraft-content"）
     * @param {string} options.storageRunningKey - 儲存執行狀態的 storage key
     * @param {string} options.storageConfigKey - 儲存設定的 storage key
     * @param {Object} options.defaultConfig - 預設設定
     * @param {Function} options.parseConfig - 設定解析函式
     * @param {boolean} options.persistStartConfig - 是否持久化設定到 storage
     * @param {Function} options.onStart - 開始執行時的回調函式
     * @param {Function} options.onResume - 恢復執行時的回調函式
     * @param {Function} options.onStateChange - 狀態變更時的回調函式
     * @param {Function} options.extraMessageHandler - 額外的訊息處理函式
     * @param {string} options.autoResumeLog - 自動恢復時顯示的日誌訊息
     * @returns {Object} 控制器物件
     * 
     * 控制器功能：
     * - 管理流程的啟動、停止、恢復
     * - 處理全域開關狀態
     * - 管理設定的讀取和儲存
     * - 提供統一的訊息處理介面
     */
    function createContentController(options) {
        const {
            source,
            storageRunningKey,
            storageConfigKey,
            defaultConfig = {},
            parseConfig = value => ({ ...defaultConfig, ...(value || {}) }),
            persistStartConfig = false,
            onStart = async () => {},
            onResume = null,
            onStateChange = null,
            extraMessageHandler = null,
            autoResumeLog = null,
        } = options;

        const state = {
            globalEnabled: true,
            isRunning: false,
            shouldStop: false,
            runToken: 0,
            config: parseConfig(defaultConfig),
        };

        function emitState() {
            onStateChange?.({ ...state });
        }

        function patchState(patch) {
            Object.assign(state, patch);
            emitState();
        }

        function getConfig() {
            return state.config;
        }

        function setConfig(config) {
            patchState({ config: parseConfig(config) });
            return state.config;
        }

        function sendPlatformLog(text, type = "info") {
            sendLog(text, type, source);
        }

        function sendPlatformEvent(event, extra = {}) {
            sendEvent(event, extra, source);
        }

        function startRun() {
            patchState({
                isRunning: true,
                shouldStop: false,
                runToken: state.runToken + 1,
            });
            return state.runToken;
        }

        function finishRun(token = null) {
            if (token !== null && token !== state.runToken) return;
            patchState({ isRunning: false });
        }

        function requestStop() {
            patchState({ shouldStop: true, isRunning: false });
        }

        function isStopped() {
            return state.shouldStop;
        }

        function isRunning() {
            return state.isRunning;
        }

        async function loadGlobalEnabled() {
            const result = await storageGet(["globalEnabled"]);
            patchState({ globalEnabled: result.globalEnabled !== false });
            return state.globalEnabled;
        }

        async function runFlow(reason = "manual", resume = false) {
            const token = startRun();
            try {
                await (resume && onResume ? onResume : onStart)(state.config, {
                    reason,
                    token,
                    controller,
                });
            } finally {
                finishRun(token);
            }
        }

        async function persistConfigIfNeeded() {
            if (!persistStartConfig) return;
            await storageSet({
                [storageRunningKey]: true,
                [storageConfigKey]: state.config,
            });
        }

        async function handleStart(message, sendResponse) {
            if (!state.globalEnabled) {
                sendResponse?.({ log: "全域自動化已停用", type: "error" });
                return true;
            }

            if (state.isRunning) {
                sendResponse?.({ log: "流程已在執行中", type: "warn" });
                return true;
            }

            setConfig(message);
            await persistConfigIfNeeded();
            runFlow("message-start", false);
            sendResponse?.({ log: "已收到開始指令", type: "success" });
            return true;
        }

        async function handleStop(sendResponse) {
            requestStop();
            if (persistStartConfig) {
                await storageSet({ [storageRunningKey]: false });
            }
            sendResponse?.({ log: "已收到停止指令", type: "warn" });
            return true;
        }

        async function autoResume() {
            const result = await storageGet([storageRunningKey, storageConfigKey]);
            if (!result[storageRunningKey] || !result[storageConfigKey] || state.isRunning) {
                return;
            }

            setConfig(result[storageConfigKey]);
            if (autoResumeLog) {
                sendPlatformLog(autoResumeLog, "info");
            }
            runFlow("storage-resume", true);
        }

        async function handleRuntimeMessage(message, sender, sendResponse) {
            if (message.action === "updateGlobalEnabled") {
                patchState({ globalEnabled: message.enabled !== false });
                if (!state.globalEnabled && state.isRunning) {
                    patchState({ shouldStop: true });
                }
                return false;
            }

            if (message.action === "START") {
                return handleStart(message, sendResponse);
            }

            if (message.action === "STOP") {
                return handleStop(sendResponse);
            }

            if (extraMessageHandler) {
                return extraMessageHandler(message, sender, sendResponse, controller) === true;
            }

            return false;
        }

        const controller = {
            source,
            state,
            getConfig,
            setConfig,
            sendLog: sendPlatformLog,
            sendEvent: sendPlatformEvent,
            startRun,
            finishRun,
            requestStop,
            isStopped,
            isRunning,
            loadGlobalEnabled,
            autoResume,
            handleRuntimeMessage,
            storageGet,
            storageSet,
            storageRemove,
            normalizeKeywordList,
        };

        return controller;
    }

    window.TicketHelperShared = {
        delay,
        sendLog,
        sendEvent,
        typeInput,
        waitForElement,
        imageElementToBase64,
        clickWithRetry,
        storageGet,
        storageSet,
        storageRemove,
        normalizeKeywordList,
        createContentController,
    };
})();
