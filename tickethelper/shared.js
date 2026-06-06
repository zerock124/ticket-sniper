// ============================================================
//  shared.js — 共用工具函式（KKTIX + Tixcraft）
//  包含兩個平台都需要的基礎功能
// ============================================================

/**
 * 延遲指定毫秒數
 * @param {number} ms - 毫秒數
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 傳送紀錄訊息給 popup
 * @param {string} text - 訊息內容
 * @param {string} type - 訊息類型（info/success/warn/error）
 * @param {string} source - 訊息來源（kktix-content 或 tixcraft-content）
 */
function sendLog(text, type = "info", source = "unknown") {
    console.log(`[搶票助手][${source}] ${text}`);
    chrome.runtime.sendMessage({ from: source, event: "LOG", text, type });
}

/**
 * 傳送事件給 popup
 * @param {string} event - 事件名稱
 * @param {object} extra - 額外資料
 * @param {string} source - 訊息來源
 */
function sendEvent(event, extra = {}, source = "unknown") {
    chrome.runtime.sendMessage({ from: source, event, ...extra });
}

/**
 * 模擬真實輸入（觸發框架雙向綁定）
 * @param {HTMLElement} element - 目標輸入元素
 * @param {string} text - 要輸入的文字
 * @param {boolean} stepByStep - 是否逐字輸入（預設為直接設置）
 */
function typeInput(element, text, stepByStep = false) {
    if (!element) return;
    element.focus();
    
    if (stepByStep) {
        // 逐字輸入模式（KKTIX 為確保 Angular 雙向綁定正確觸發）
        element.value = "";
        for (const char of text) {
            element.value += char;
            element.dispatchEvent(new Event("input", { bubbles: true }));
        }
    } else {
        // 直接設置模式（Tixcraft）
        element.value = text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * 等待指定 selector 出現
 * @param {string} selector - CSS selector
 * @param {number} timeout - 超時毫秒數（預設 10000）
 * @param {HTMLElement} context - 查詢範圍（預設 document）
 * @param {boolean} shouldStop - 是否已被要求停止的外部旗標參考
 * @returns {Promise<HTMLElement>}
 */
async function waitForElement(selector, timeout = 10000, context = document, shouldStop = null) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        // 檢查是否被要求停止（如果傳入旗標參考）
        if (shouldStop !== null && shouldStop()) {
            throw new Error("使用者已停止");
        }
        const el = context.querySelector(selector);
        if (el) return el;
        await delay(100);
    }
    throw new Error(`等待元素逾時：${selector}`);
}

/**
 * 將圖片元素轉為 Base64 字串（透過 Canvas）
 * @param {HTMLImageElement} imgEl - 圖片元素
 * @returns {Promise<string>}
 */
async function imageElementToBase64(imgEl) {
    return new Promise((resolve, reject) => {
        const doConvert = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = imgEl.naturalWidth || imgEl.width;
                canvas.height = imgEl.naturalHeight || imgEl.height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(imgEl, 0, 0);
                resolve(canvas.toDataURL("image/png"));
            } catch (e) {
                reject(e);
            }
        };

        if (imgEl.complete && imgEl.naturalWidth > 0) {
            doConvert();
        } else {
            imgEl.onload = doConvert;
            imgEl.onerror = () => reject(new Error("驗證碼圖片載入失敗"));
        }
    });
}

/**
 * 帶重試的點擊元素
 * @param {string} selector - CSS selector
 * @param {object} options - 配置選項
 *   - maxAttempts: 最大嘗試次數（預設 10）
 *   - clickCount: 點擊次數（預設 1）
 *   - context: 查詢範圍（預設 document）
 *   - shouldStop: 是否已停止的旗標檢查函式
 * @returns {Promise<boolean>}
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
        // 檢查是否被要求停止
        if (shouldStop && shouldStop()) {
            throw new Error("使用者已停止");
        }

        const el = context.querySelector(selector);
        if (el) {
            for (let i = 0; i < clickCount; i++) {
                el.click();
                await delay(50);
            }
            return true;
        }
        attempts++;
        await delay(300);
    }

    throw new Error(`找不到元素 ${selector}（已嘗試 ${maxAttempts} 次）`);
}
