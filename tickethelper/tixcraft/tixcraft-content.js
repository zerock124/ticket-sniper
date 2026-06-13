// ============================================================
// tixcraft-content.js — Tixcraft 平台內容腳本
// ============================================================
// 功能：在 Tixcraft 網站上執行自動搶票流程
// 
// 主要步驟：
// 1. DETAIL → DATE: 跳轉到場次選擇頁
// 2. DATE: 選擇符合條件的場次（依日期關鍵字）
// 3. GAME: 選擇符合條件的票區（依區域關鍵字、排除區域）
// 4. VERIFY: 填寫驗證問題答案（如果有）
// 5. CAPTCHA: OCR 辨識驗證碼並選擇購票數量、送出
// 6. CHECKOUT: 到達結帳頁，發送 Discord 通知
// 7. DONE: 完成訂單
// 
// 特殊功能：
// - 自動 OCR 驗證碼辨識（透過背景頁代理）
// - 攻擊 alert/confirm 彈窗（使用 MAIN world 腳本）
// - 網路請求追蹤（XHR 和 fetch 次數）
// - 自動恢復流程（頁面重新載入後）
// ============================================================

// 防止重複載入
if (window.__tixcraftLoaded) {
    console.log("[tickethelper][tixcraft-content] already loaded");
} else {
    window.__tixcraftLoaded = true;

    const helper = window.TicketHelperShared;
    
    // 預設設定
    const DEFAULT_CONFIG = {
        buy_count: 2,              // 購票數量
        choose_date: [],           // 場次日期關鍵字陣列
        choose_area: [],           // 票區關鍵字陣列
        exclude_area: [],          // 排除的票區關鍵字
        area_fallback: "refresh",  // 無符合的票區時的回退策略：refresh 或 select_first
        date_fallback: "refresh",  // 無符合的場次時的回退策略：refresh 或 select_first
        reload_delay: 1,           // 重新整理前的延遲秒數
        target_url: "",            // 目標活動網址（從首頁跳轉用）
        verify_code: "",           // 驗證問題答案
        ocr_api_url: "http://localhost:5511/ocr",  // OCR API 端點
    };

    /**
     * 正規化 OCR API URL
     * 確保 URL 結尾是 /ocr
     * @param {string} value - 輸入的 URL
     * @returns {string} 正規化後的 URL
     */
    function normalizeOcrApiUrl(value) {
        const raw = String(value || "http://localhost:5511/ocr").trim().replace(/\/+$/, "");
        return raw.endsWith("/ocr") ? raw : `${raw}/ocr`;
    }

    /**
     * 正規化使用者輸入的設定
     * 將各種格式的輸入轉換為統一的內部格式
     * @param {Object} raw - 原始設定物件
     * @returns {Object} 正規化後的設定
     */
    function normalizeConfig(raw = {}) {
        return {
            buy_count: Math.max(1, Number(raw.buyCount ?? raw.buy_count ?? 2) || 2),
            choose_date: helper.normalizeKeywordList(raw.chooseDate ?? raw.choose_date ?? []),
            choose_area: helper.normalizeKeywordList(raw.chooseArea ?? raw.choose_area ?? []),
            exclude_area: helper.normalizeKeywordList(raw.excludeArea ?? raw.exclude_area ?? []),
            area_fallback: raw.areaFallback ?? raw.area_fallback ?? "refresh",
            date_fallback: raw.dateFallback ?? raw.date_fallback ?? "refresh",
            reload_delay: Math.max(0.2, Number(raw.reloadDelay ?? raw.reload_delay ?? 1) || 1),
            target_url: String(raw.targetUrl ?? raw.target_url ?? "").trim(),
            verify_code: String(raw.verifyCode ?? raw.verify_code ?? "").trim(),
            ocr_api_url: normalizeOcrApiUrl(raw.ocrApiUrl ?? raw.ocr_api_url ?? DEFAULT_CONFIG.ocr_api_url),
        };
    }

    // 建立流程控制器
    // 提供統一的狀態管理、訊息處理、流程控制
    const controller = helper.createContentController({
        source: "tixcraft-content",
        storageRunningKey: "tixcraft_isRunning",
        storageConfigKey: "tixcraft_runningConfig",
        defaultConfig: DEFAULT_CONFIG,
        parseConfig: normalizeConfig,
        onStart: async (config, meta) => {
            await runFlow(config, meta.token);
        },
        onResume: async (config, meta) => {
            controller.sendLog("偵測到 Tixcraft 進行中設定，自動恢復流程", "info");
            await runFlow(config, meta.token);
        },
    });

    // 快速存取函式
    function isStopped() {
        return controller.isStopped();
    }

    function sendLogTixcraft(text, type = "info") {
        controller.sendLog(text, type);
    }

    function sendEventTixcraft(event, extra = {}) {
        controller.sendEvent(event, extra);
    }

    // ============================================================
    // 網路請求追蹤系統
    // ============================================================
    // 攻擊 Tixcraft 的 XHR 和 fetch 請求，追蹤進行中的網路請求數量
    // 用於判斷頁面是否完成載入或正在處理中
    // ============================================================
    if (!window.__tixcraftNetworkPatched) {
        window.__tixcraftNetworkPatched = true;
        window.__tixcraftPendingRequests = 0;

        // 攻擊 XMLHttpRequest
        const OriginalXHR = window.XMLHttpRequest;
        function PatchedXHR() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open.bind(xhr);
            xhr.open = function patchedOpen(...args) {
                window.__tixcraftPendingRequests += 1;
                xhr.addEventListener("loadend", () => {
                    window.__tixcraftPendingRequests = Math.max(0, window.__tixcraftPendingRequests - 1);
                });
                return originalOpen(...args);
            };
            return xhr;
        }
        PatchedXHR.prototype = OriginalXHR.prototype;
        window.XMLHttpRequest = PatchedXHR;

        // 攻擊 fetch API
        const originalFetch = window.fetch;
        window.fetch = function patchedFetch(...args) {
            window.__tixcraftPendingRequests += 1;
            return originalFetch(...args).finally(() => {
                window.__tixcraftPendingRequests = Math.max(0, window.__tixcraftPendingRequests - 1);
            });
        };
    }
    // ============================================================
    // alert/confirm 攻擊與恢復
    // ============================================================
    // 監聆並攻擊 Tixcraft 的 alert 和 confirm 彈窗
    // 記錄彈窗訊息並自動恢復原始函式
    // ============================================================    const originalAlert = window.alert;
    const originalConfirm = window.confirm;

    window.addEventListener("__tixcraft_alert", event => {
        const message = event.detail ?? "";
        if (!message) return;
        sendLogTixcraft(`攔截 alert：${message}`, "warn");
        window.alert = originalAlert;
    });

    window.addEventListener("__tixcraft_confirm", event => {
        const message = event.detail ?? "";
        if (!message) return;
        sendLogTixcraft(`攔截 confirm：${message}`, "warn");
        window.confirm = originalConfirm;
    });

    /**
     * OCR 驗證碼辨識
     * 將驗證碼圖片轉換為 Base64 並傳送給 OCR 服務辨識
     * 
     * @param {Object} config - 設定物件（包含 ocr_api_url）
     * @param {HTMLImageElement} imgEl - 驗證碼圖片元素
     * @returns {Promise<string>} 辨識得到的驗證碼字串
     * 
     * 流程：
     * 1. 將圖片轉換為 Base64
     * 2. 透過 background.js 傳送給 OCR API
     * 3. 等待並返回辨識結果
     */
    async function recognizeCaptcha(config, imgEl) {
        const base64 = await window.imageElementToBase64(imgEl);

        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: "OCR_REQUEST", ocrApiUrl: config.ocr_api_url, image: base64 },
                response => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (!response?.success) {
                        reject(new Error(response?.error || "OCR request failed"));
                        return;
                    }
                    resolve(response.data);
                }
            );
        });

        if (!result?.success) {
            throw new Error(result?.error || "OCR result invalid");
        }

        sendLogTixcraft(`OCR 辨識結果：${result.code}`, "success");
        return result.code;
    }

    /**
     * 延遲後重新載入頁面
     * @param {Object} config - 設定物件
     * @param {string} reason - 重新載入的原因（顯示在日誌中）
     */
    async function reloadAfterDelay(config, reason = "重新整理頁面") {
        sendLogTixcraft(`${reason}，${config.reload_delay} 秒後重試`, "warn");
        sendEventTixcraft("RELOAD");
        await helper.delay(config.reload_delay * 1000);
        window.location.reload();
    }

    /**
     * 偵測當前頁面類型
     * 根據 URL 路徑判斷當前在 Tixcraft 流程的哪個階段
     * @returns {string} 頁面類型："HOME", "DETAIL", "DATE", "GAME", "VERIFY", "CAPTCHA", "CHECKOUT", "DONE", "UNKNOWN"
     */
    function detectPageType() {
        const url = window.location.href;
        if (url.includes("/activity/detail")) return "DETAIL";   // 活動詳情頁
        if (url.includes("/activity/game")) return "DATE";       // 場次選擇頁
        if (url.includes("/ticket/area/")) return "GAME";        // 票區選擇頁
        if (url.includes("/ticket/verify/")) return "VERIFY";    // 驗證問題頁
        if (url.includes("/ticket/ticket")) return "CAPTCHA";    // 驗證碼輸入頁
        if (url.includes("/ticket/checkout")) return "CHECKOUT"; // 結帳頁
        if (url.includes("/ticket/order")) return "DONE";        // 完成頁
        if (url === "https://tixcraft.com/") return "HOME";      // 首頁
        return "UNKNOWN";  // 未知頁面
    }

    /**
     * 步驟 1：場次選擇頁 - 選擇符合條件的場次
     * 
     * @param {Object} config - 設定物件
     * @returns {Promise<boolean>} 是否成功選擇場次
     * 
     * 功能：
     * 1. 等待場次列表載入
     * 2. 篩選出可購買的場次（按鈕未禁用且可見）
     * 3. 依 choose_date 關鍵字順序匹配場次
     * 4. 如果找不到，根據 date_fallback 策略處理
     * 5. 點擊選定的場次購買按鈕
     */
    async function detailStepSelectSession(config) {
        await waitForElement("#gameList", 15000, document, isStopped);

        const rows = Array.from(document.querySelectorAll("#gameList table tbody tr"));
        if (rows.length === 0) {
            throw new Error("找不到場次列表");
        }

        const availableRows = rows.filter(row => {
            const button = row.querySelector("td:nth-child(4) button, td:nth-child(4) a");
            return button && !button.disabled && button.offsetParent !== null;
        });

        if (availableRows.length === 0) {
            await reloadAfterDelay(config, "目前沒有可購買場次");
            return false;
        }

        let selectedRow = null;
        for (const keyword of config.choose_date) {
            const matchedRow = availableRows.find(row => {
                const time = row.querySelector("td:nth-child(1)")?.innerText ?? "";
                return time.includes(keyword);
            });
            if (matchedRow) {
                selectedRow = matchedRow;
                sendLogTixcraft(`依日期關鍵字選到場次：${keyword}`, "success");
                break;
            }
        }

        if (!selectedRow) {
            if (config.choose_date.length === 0 || config.date_fallback === "select_first") {
                selectedRow = availableRows[0];
                sendLogTixcraft("找不到指定日期，改選第一個可購買場次", "warn");
            } else {
                await reloadAfterDelay(config, "找不到符合日期的場次");
                return false;
            }
        }

        const time = selectedRow.querySelector("td:nth-child(1)")?.innerText?.trim() ?? "";
        const name = selectedRow.querySelector("td:nth-child(2)")?.innerText?.trim() ?? "";
        const location = selectedRow.querySelector("td:nth-child(3)")?.innerText?.trim() ?? "";
        sendLogTixcraft(`選定場次：${time} / ${name} / ${location}`, "info");

        const buyButton = selectedRow.querySelector("td:nth-child(4) button, td:nth-child(4) a");
        buyButton?.click();
        return true;
    }

    /**
     * 步驟 2：票區選擇頁 - 選擇符合條件的票區
     * 
     * @param {Object} config - 設定物件
     * @returns {Promise<boolean>} 是否成功選擇票區
     * 
     * 功能：
     * 1. 等待票區列表載入
     * 2. 過濾掉已售罄、禁用的票區
     * 3. 過濾掉 exclude_area 中指定的票區
     * 4. 依 choose_area 關鍵字順序匹配票區
     * 5. 檢查票區剩餘數量是否足夠
     * 6. 如果找不到，根據 area_fallback 策略處理
     * 7. 點擊選定的票區
     */
    async function gameStepSelectZone(config) {
        await waitForElement("div.zone.area-list", 15000, document, isStopped);

        const allLinks = Array.from(document.querySelectorAll("div.zone.area-list ul.area-list li a"));
        if (allLinks.length === 0) {
            throw new Error("找不到區域清單");
        }

        const availableLinks = allLinks.filter(link => {
            const item = link.closest("li");
            const text = link.textContent || "";
            const soldOut =
                link.classList.contains("disabled") ||
                link.getAttribute("aria-disabled") === "true" ||
                item?.classList.contains("soldout") ||
                item?.classList.contains("disabled") ||
                text.includes("Sold Out") ||
                text.includes("已售完");

            if (soldOut) return false;

            if (config.exclude_area.some(keyword => text.includes(keyword))) {
                sendLogTixcraft(`略過排除區域：${text.trim().replace(/\s+/g, " ")}`, "warn");
                return false;
            }

            return true;
        });

        if (availableLinks.length === 0) {
            await reloadAfterDelay(config, "目前沒有可購買區域");
            return false;
        }

        let selectedLink = null;
        for (const keyword of config.choose_area) {
            const matched = availableLinks.filter(link => {
                const spans = Array.from(link.querySelectorAll("span"));
                const spanText = spans.map(span => span.textContent).join(" ");
                const qtySpan = spans.find(span => /剩餘|數量|Seats|Available/i.test(span.textContent));
                const qtyMatch = qtySpan?.textContent.match(/(\d+)/);
                const qty = qtyMatch ? Number(qtyMatch[1]) : null;
                if (qty !== null && qty < config.buy_count) {
                    return false;
                }
                return spanText.includes(keyword) || link.textContent.includes(keyword);
            });

            if (matched.length > 0) {
                selectedLink = matched[Math.floor(Math.random() * matched.length)];
                sendLogTixcraft(`依區域關鍵字選到票區：${keyword}`, "success");
                break;
            }
        }

        if (!selectedLink) {
            if (config.area_fallback === "select_first") {
                selectedLink = availableLinks[0];
                sendLogTixcraft("找不到指定區域，改選第一個可購買區域", "warn");
            } else {
                await reloadAfterDelay(config, "找不到符合條件的區域");
                return false;
            }
        }

        const zoneText = selectedLink.textContent.trim().replace(/\s+/g, " ");
        sendLogTixcraft(`選定區域：${zoneText}`, "info");
        selectedLink.click();
        return true;
    }

    /**
     * 步驟 3：驗證問題頁 - 填寫驗證答案
     * 
     * @param {Object} config - 設定物件
     * @returns {Promise<boolean>} 是否成功填寫並送出
     * 
     * 功能：
     * 1. 等待驗證表單出現
     * 2. 找到答案輸入框
     * 3. 填入 verify_code 設定值
     * 4. 點擊送出按鈕
     */
    async function verifyStepAnswerQuestion(config) {
        const zoneVerify = await waitForElement("div.zone-verify", 15000, document, isStopped);
        const form = zoneVerify.querySelector("form");
        if (!form) {
            throw new Error("找不到驗證表單");
        }

        const answerInput = form.querySelector("div:nth-child(2) input[name='checkCode']");
        if (!answerInput) {
            throw new Error("找不到驗證答案輸入框");
        }

        if (!config.verify_code) {
            throw new Error("尚未設定 verifyCode");
        }

        window.typeInput(answerInput, config.verify_code);
        sendLogTixcraft("已填入驗證答案", "success");

        const submitButton = form.querySelector("button[type='submit']");
        if (!submitButton) {
            throw new Error("找不到驗證送出按鈕");
        }

        submitButton.click();
        return true;
    }

    /**
     * 步驟 4：OCR 辨識驗證碼
     * 
     * @param {Object} config - 設定物件
     * @returns {Promise<HTMLElement>} 驗證碼輸入框元素
     * 
     * 功能：
     * 1. 找到驗證碼圖片
     * 2. 透過 OCR API 辨識圖片
     * 3. 填入辨識結果到輸入框
     */
    async function checkoutStepCaptcha(config) {
        const imgEl = document.querySelector("#TicketForm_verifyCode-image");
        if (!imgEl) {
            throw new Error("找不到驗證碼圖片");
        }

        const inputEl = document.querySelector("#TicketForm_verifyCode");
        if (!inputEl) {
            throw new Error("找不到驗證碼輸入框");
        }

        let code;
        try {
            code = await recognizeCaptcha(config, imgEl);
        } catch (error) {
            sendLogTixcraft(`OCR 失敗：${error.message}`, "error");
            sendLogTixcraft("請確認 OCR Server 已啟動，且 OCR URL 指向 /ocr 端點", "error");
            throw error;
        }

        window.typeInput(inputEl, code);
        return inputEl;
    }

    /**
     * 步驟 5：送出結帳表單
     * 
     * @param {Object} config - 設定物件
     * 
     * 功能：
     * 1. 選擇購票數量
     * 2. 勾選同意條款
     * 3. 點擊送出按鈕
     */
    async function checkoutStepSubmit(config) {
        const qtySelect = document.querySelector("select[name*='ticketPrice'], select[id*='TicketForm_ticketPrice']");
        if (qtySelect) {
            qtySelect.value = String(config.buy_count);
            qtySelect.dispatchEvent(new Event("change", { bubbles: true }));
        }

        const agreeCheckbox = document.querySelector("input[name='agree'], input[type='checkbox'], input#TicketForm_agree");
        if (agreeCheckbox && !agreeCheckbox.checked) {
            agreeCheckbox.click();
        }

        const submitButton = document.querySelector(
            "input[type='submit'], button[type='submit'], .btn-primary[type='submit']"
        );
        if (!submitButton) {
            throw new Error("找不到送出按鈕");
        }

        submitButton.click();
    }

    async function runFlow(config, token) {
        const pageType = detectPageType();

        try {
            if (token !== controller.state.runToken) return;

            switch (pageType) {
                case "HOME":
                    if (config.target_url) {
                        sendLogTixcraft("跳轉至目標活動網址", "info");
                        window.location.href = config.target_url;
                    } else {
                        sendLogTixcraft("目前在首頁，且尚未設定目標網址", "warn");
                    }
                    break;

                case "DETAIL":
                    window.location.href = "https://tixcraft.com/activity/game/" + window.location.pathname.split("/").pop();
                    break;

                case "DATE": {
                    const selected = await detailStepSelectSession(config);
                    if (!selected) return;
                    break;
                }

                case "GAME": {
                    const selected = await gameStepSelectZone(config);
                    if (!selected) return;
                    break;
                }

                case "VERIFY":
                    await verifyStepAnswerQuestion(config);
                    sendLogTixcraft("驗證問題已送出", "success");
                    break;

                case "CAPTCHA":
                    await waitForElement("#TicketForm_verifyCode-image", 10000, document, isStopped);
                    await checkoutStepCaptcha(config);
                    await checkoutStepSubmit(config);
                    sendLogTixcraft("驗證碼已送出，等待結果", "success");
                    break;

                case "CHECKOUT":
                    sendLogTixcraft("已進入結帳頁", "success");
                    sendEventTixcraft("DONE");
                    break;

                case "DONE":
                    sendLogTixcraft("已完成訂單，請前往付款", "success");
                    break;

                default:
                    sendLogTixcraft("無法辨識目前頁面", "warn");
                    break;
            }
        } catch (error) {
            if (error.message === "STOPPED") {
                sendLogTixcraft("流程已停止", "warn");
                return;
            }

            sendLogTixcraft(`流程錯誤：${error.message}`, "error");
            await reloadAfterDelay(config, "流程發生錯誤");
        }
    }

    const TIXCRAFT_WEBHOOK_URL =
        "https://discord.com/api/webhooks/1441623009596280994/qSkW3MisDAEKNTBbI_08aelRZBf81jJCPqGI8-WxIQdb3fsOpz9aFhKrGsAFXSbg26TC";

    async function notifyTixcraft() {
        if (TIXCRAFT_WEBHOOK_URL.includes("YOUR_WEBHOOK")) return;

        try {
            await fetch(TIXCRAFT_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: "Tixcraft Ticket Helper",
                    embeds: [
                        {
                            title: "Tixcraft 通知",
                            description: "流程進入驗證或結帳階段",
                            color: 0x00ff00,
                            fields: [{ name: "時間", value: new Date().toLocaleString("zh-TW") }],
                        },
                    ],
                }),
            });
            sendLogTixcraft("Discord 通知已送出", "success");
        } catch (error) {
            sendLogTixcraft(`Discord 通知失敗：${error.message}`, "error");
        }
    }

    function setupCheckoutObserver() {
        if (!document.body) return;

        const observer = new MutationObserver(() => {
            const url = window.location.href;
            if (url.includes("/ticket/checkout/") || url.includes("/ticket/verify/")) {
                observer.disconnect();
                notifyTixcraft();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
        controller.handleRuntimeMessage(message, sender, sendResponse)
    );

    async function onDomReady() {
        setupCheckoutObserver();
        await controller.loadGlobalEnabled();
        await controller.autoResume();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
    } else {
        onDomReady();
    }
}
