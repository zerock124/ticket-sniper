// ============================================================
//  tixcraft-content.js — Tixcraft 搶票助手 內容腳本（整合版）
//  負責在 Tixcraft 頁面上執行自動搶票流程
//
//  流程說明：
//    1. 偵測當前頁面類型（活動選座頁 / 驗證碼結帳頁）
//    2. 活動選座頁（/activity/game/...）：
//       選擇指定區域 → 選擇數量 → 點擊「立即購票」
//    3. 驗證碼結帳頁（/ticket/checkout/... 或 /ticket/verify/...）：
//       抓取驗證碼圖片 → 呼叫本地 OCR API → 填入結果 → 送出表單
// ============================================================

// 防止重複注入：同一頁面已載入時直接略過，reload 後旗標消失會重新初始化
if (window.__tixcraftLoaded) {
    console.log("[搶票助手][Tixcraft] content.js 已載入，略過重複注入");
} else {
    window.__tixcraftLoaded = true;

    // ── 檢查全域啟用狀態 ─────────────────────────────────────────
    let globalEnabled = true; // 預設為啟用

    // 從 storage 讀取全域開關狀態
    chrome.storage.local.get(["globalEnabled"], (result) => {
        globalEnabled = result.globalEnabled !== false; // 預設為 true
        if (!globalEnabled) {
            console.log("[搶票助手][Tixcraft] 腳本注入已停用，不執行任何操作");
        }
    });

    // 監聽全域開關狀態變更
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "updateGlobalEnabled") {
            globalEnabled = message.enabled;
            console.log(`[搶票助手][Tixcraft] 全域開關已${globalEnabled ? "啟用" : "停用"}`);

            // 如果被停用且正在執行，則停止
            if (!globalEnabled && isRunning) {
                shouldStop = true;
                console.log("[搶票助手][Tixcraft] 因全域開關停用，正在停止執行...");
            }
        }
    });

    // ── 全域狀態 ─────────────────────────────────────────────────
    let isRunning = false;
    let shouldStop = false;

    // ── 網路請求追蹤器 ────────────────────────────────────────────
    let _pendingRequests = 0;

    // 攔截 XMLHttpRequest 追蹤進行中的請求數量
    (function patchXHR() {
        const OrigXHR = window.XMLHttpRequest;
        function PatchedXHR() {
            const xhr = new OrigXHR();
            const origOpen = xhr.open.bind(xhr);
            xhr.open = function (...args) {
                _pendingRequests++;
                xhr.addEventListener("loadend", () => {
                    _pendingRequests = Math.max(0, _pendingRequests - 1);
                });
                return origOpen(...args);
            };
            return xhr;
        }
        PatchedXHR.prototype = OrigXHR.prototype;
        window.XMLHttpRequest = PatchedXHR;
    })();

    // 攔截 fetch 追蹤進行中的請求數量
    (function patchFetch() {
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            _pendingRequests++;
            return origFetch(...args).finally(() => {
                _pendingRequests = Math.max(0, _pendingRequests - 1);
            });
        };
    })();

    // 目前執行參數（由 popup 傳入）
    let CONFIG = {
        buy_count: 2,
        choose_date: [],
        choose_area: [],
        exclude_area: [],
        area_fallback: "refresh",
        date_fallback: "refresh",
        reload_delay: 1,
        target_url: "",
        verify_code: "",
        ocr_api_url: "http://localhost:5511/ocr",
    };

    // ── 工具函式 ─────────────────────────────────────────────────

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── 全域 alert 攔截器 ─────────────────────────────────────────
    // tixcraft-alert-override.js（world: MAIN）已在 main world 覆寫 window.alert，
    // 並透過 CustomEvent '__tixcraft_alert' 橋接回 isolated world。
    const _alertListeners = new Set();
    const _confirmListeners = new Set();
    const originalAlert = window.alert;
    window.addEventListener("__tixcraft_alert", (e) => {
        const alertMessage = e.detail ?? "";
        if (alertMessage.length > 0) {
            sendLog(`⚠️ 攔截到 alert：${alertMessage}`, "warn");
            _alertListeners.forEach(fn => fn(alertMessage));
            _alertListeners.clear();
            window.alert = originalAlert; // 恢復原生 alert，避免重複攔截造成無限迴圈
        }
    });

    const originalConfirm = window.confirm;
    window.addEventListener("__tixcraft_confirm", (e) => {
        console.log(e);
        const confirmMessage = e.detail ?? "";
        if (confirmMessage.length > 0) {
            sendLog(`⚠️ 攔截到 confirm：${confirmMessage}`, "warn");
            _confirmListeners.forEach(fn => fn(confirmMessage));
            _confirmListeners.clear();
            window.confirm = originalConfirm; // 恢復原生 confirm，避免重複攔截造成無限迴圈
        }
    });

    // 傳送紀錄訊息給 popup
    function sendLog(text, type = "info") {
        console.log(`[搶票助手][Tixcraft] ${text}`);
        chrome.runtime.sendMessage({ from: "tixcraft-content", event: "LOG", text, type });
    }

    // 傳送事件給 popup
    function sendEvent(event, extra = {}) {
        chrome.runtime.sendMessage({ from: "tixcraft-content", event, ...extra });
    }

    // 等待指定 selector 出現（最多等待 timeout ms）
    async function waitForElement(selector, timeout = 10000, context = document) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (shouldStop) throw new Error("使用者已停止");
            const el = context.querySelector(selector);
            if (el) return el;
        }
        throw new Error(`等待元素逾時：${selector}`);
    }

    // 將圖片元素轉為 Base64 字串（透過 Canvas）
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

    // 透過 background.js 代理呼叫本地 OCR API（繞過 HTTPS 混合內容限制）
    async function recognizeCaptcha(imgEl) {
        // sendLog("正在呼叫 OCR API 辨識驗證碼...");  // 簡化 LOG：移除過程訊息
        const base64 = await imageElementToBase64(imgEl);

        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: "OCR_REQUEST", ocrApiUrl: CONFIG.ocr_api_url + "/ocr", image: base64 },
                (resp) => {
                    if (chrome.runtime.lastError) {
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
                    if (!resp.success) {
                        return reject(new Error(resp.error));
                    }
                    resolve(resp.data);
                }
            );
        });

        if (!result.success) {
            throw new Error(`OCR 辨識失敗：${result.error}`);
        }

        sendLog(`OCR 辨識結果：${result.code}`, "success");
        return result.code;
    }

    // 模擬真實輸入（觸發框架雙向綁定）
    function typeInput(element, text) {
        if (!element) return;
        element.focus();
        element.value = text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // 延遲指定秒數後重整
    async function reloadAfterDelay() {
        const ms = Math.max(100, CONFIG.reload_delay * 1000);
        sendLog(`等待 ${CONFIG.reload_delay} 秒後重新整理...`, "warn");
        await delay(ms);
        window.location.reload();
    }

    // ── 偵測當前頁面類型 ─────────────────────────────────────────

    function detectPageType() {
        const url = window.location.href;
        if (url.includes("/activity/detail")) return "DETAIL";
        if (url.includes("/activity/game")) return "DATE";
        if (url.includes("/ticket/area/")) return "GAME";
        if (url.includes("/ticket/verify/")) return "VERIFY";
        if (url.includes("/ticket/ticket")) return "CAPTCHA";
        if (url.includes("/ticket/checkout")) return "CHECKOUT";
        if (url.includes("/ticket/order")) return "DONE";
        if (url === "https://tixcraft.com/") return "HOME";
        return "UNKNOWN";
    }

    // ── 活動詳情頁步驟 ────────────────────────────────────────────

    async function detailStep_selectSession() {
        // sendLog("等待場次列表載入...");  // 簡化 LOG：移除等待訊息
        await waitForElement("#gameList", 15000);

        const rows = Array.from(
            document.querySelectorAll("#gameList table tbody tr")
        );

        if (rows.length === 0) {
            throw new Error("找不到場次列表，請確認已在活動詳情頁面");
        }

        const availableRows = rows.filter(row => {
            const btn = row.querySelector("td:nth-child(4) button, td:nth-child(4) a");
            return btn && !btn.disabled && btn.offsetParent !== null;
        });

        if (availableRows.length === 0) {
            sendLog("⚠️ 目前無可購買場次，重新整理頁面...", "warn");
            sendEvent("RELOAD");
            await reloadAfterDelay();
            return false;
        }

        let selectedRow = null;

        for (const keyword of CONFIG.choose_date) {
            const matched = availableRows.filter(row => {
                const time = row.querySelector("td:nth-child(1)")?.innerText ?? "";
                return time.includes(keyword);
            });
            if (matched.length > 0) {
                selectedRow = matched[0];
                sendLog(`依日期選擇場次「${keyword}」`, "success");
                break;
            }
        }

        if (!selectedRow) {
            if (CONFIG.choose_date.length === 0 || CONFIG.date_fallback === "select_first") {
                if (CONFIG.choose_date.length > 0) {
                    sendLog("⚠️ 找不到符合日期的場次，自動選擇第一個可訂購場次", "warn");
                }
                selectedRow = availableRows[0];
            } else {
                sendLog("⚠️ 找不到符合日期的場次，重新整理頁面...", "warn");
                sendEvent("RELOAD");
                await reloadAfterDelay();
                return false;
            }
        }

        const time = selectedRow.querySelector("td:nth-child(1)")?.innerText?.trim() ?? "";
        const name = selectedRow.querySelector("td:nth-child(2)")?.innerText?.trim() ?? "";
        const location = selectedRow.querySelector("td:nth-child(3)")?.innerText?.trim() ?? "";
        sendLog(`選定場次：${time} ／ ${name} ／ ${location}`);

        const buyBtn = selectedRow.querySelector("td:nth-child(4) button, td:nth-child(4) a");
        buyBtn.click();
        // sendLog("DetailStep：已點擊立即訂購");  // 簡化 LOG：移除技術細節
        return true;
    }

    // ── 選座頁步驟 ───────────────────────────────────────────────

    async function gameStep1_selectZone() {
        // sendLog("等待區域選擇區塊載入...");  // 簡化 LOG：移除等待訊息
        await waitForElement("div.zone.area-list", 15000);

        const allLinks = Array.from(
            document.querySelectorAll("div.zone.area-list ul.area-list li a")
        );

        if (allLinks.length === 0) {
            throw new Error("找不到任何區域連結，請確認已在票種選擇頁面");
        }

        const availableLinks = allLinks.filter(a => {
            const li = a.closest("li");
            const text = a.textContent || "";
            const isSoldOut =
                a.classList.contains("disabled") ||
                a.getAttribute("aria-disabled") === "true" ||
                li?.classList.contains("soldout") ||
                li?.classList.contains("disabled") ||
                text.includes("已售完") ||
                text.includes("Sold Out");
            if (isSoldOut) return false;
            // 排除包含排除關鍵字的區域
            const isExcluded = CONFIG.exclude_area.some(kw => text.includes(kw));
            if (isExcluded) {
                sendLog(`略過排除區域：${text.trim().replace(/\s+/g, " ")}`, "warn");
                return false;
            }
            return true;
        });

        if (availableLinks.length === 0) {
            sendLog("⚠️ 所有區域已售完，重新整理頁面...", "warn");
            sendEvent("RELOAD");
            await reloadAfterDelay();
            return false;
        }

        let selectedLink = null;

        for (const keyword of CONFIG.choose_area) {
            const matched = availableLinks.filter(a => {
                const spans = Array.from(a.querySelectorAll("span"));
                const spanText = spans.map(s => s.textContent).join(" ");
                const qtySpan = spans.find(s => /剩餘|數量/.test(s.textContent));
                const qtyMatch = qtySpan?.textContent.match(/(\d+)/);
                const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : null;
                if (qty !== null && qty < CONFIG.buy_count) {
                    return false; // 數量不足，跳過此區域
                }
                return spanText.includes(keyword) || a.textContent.includes(keyword);
            });

            if (matched.length > 0) {
                selectedLink = matched[Math.floor(Math.random() * matched.length)];
                sendLog(`依優先順序選擇區域「${keyword}」`, "success");
                break;
            }
        }

        if (!selectedLink) {
            if (CONFIG.area_fallback === "select_first") {
                sendLog("⚠️ 找不到指定區域關鍵字，自動選擇第一個可訂購區域", "warn");
                selectedLink = availableLinks[0];
            } else {
                sendLog("⚠️ 找不到指定區域關鍵字，重新整理頁面...", "warn");
                sendEvent("RELOAD");
                await reloadAfterDelay();
                return false;
            }
        }

        const zoneText = selectedLink.textContent.trim().replace(/\s+/g, " ");
        sendLog(`選定區域：${zoneText}`);

        selectedLink.click();
        // sendLog("GameStep 1：已點擊區域連結");  // 簡化 LOG：移除技術細節
        return true;
    }

    // ── 問題驗證頁步驟 ────────────────────────────────────────────

    async function verifyStep_answerQuestion() {
        // sendLog("等待問題驗證區塊載入...");  // 簡化 LOG：移除等待訊息
        const zoneVerify = await waitForElement("div.zone-verify", 15000);

        const form = zoneVerify.querySelector("form");
        if (!form) throw new Error("找不到驗證表單");

        const questionDiv = form.querySelector("div:nth-child(1)");
        const questionText = questionDiv?.innerText?.trim() ?? "（無法讀取題目）";
        // sendLog(`驗證問題：${questionText}`);  // 簡化 LOG：移除問題詳情

        const answerInput = form.querySelector("div:nth-child(2) input[name='checkCode']");
        if (!answerInput) throw new Error("找不到答案輸入框");

        if (!CONFIG.verify_code) {
            sendLog("⚠️ 尚未設定驗證答案（verify_code），請在基礎設定中填入", "warn");
            throw new Error("未設定驗證答案");
        }

        typeInput(answerInput, CONFIG.verify_code);
        sendLog("✅ 已填入驗證答案", "success");

        const submitBtn = form.querySelector("button[type='submit']");
        if (!submitBtn) throw new Error("找不到送出按鈕");

        submitBtn.click();
        // sendLog("已送出驗證表單，等待跳轉...");  // 簡化 LOG：移除過程訊息

        return true;
    }

    // ── 驗證碼結帳頁步驟 ─────────────────────────────────────────

    async function checkoutStep1_captcha(retryCount = 0) {
        // sendLog(`辨識驗證碼（第 ${retryCount + 1} 次）...`);  // 簡化 LOG：移除過程訊息

        const imgEl = document.querySelector("#TicketForm_verifyCode-image");
        if (!imgEl) throw new Error("找不到驗證碼圖片");

        const inputEl = document.querySelector("#TicketForm_verifyCode");
        if (!inputEl) throw new Error("找不到驗證碼輸入框");

        let code;
        try {
            code = await recognizeCaptcha(imgEl);
        } catch (e) {
            sendLog(`❌ OCR 失敗：${e.message}`, "error");
            sendLog("請確認本地 OCR Server 已啟動（python ocr_server.py）", "error");
            throw e;
        }

        typeInput(inputEl, code);
        // sendLog(`已填入驗證碼：${code}`, "success");  // 簡化 LOG：移除填入訊息

        return { inputEl, retryCount };
    }

    async function checkoutStep2_submit(inputEl, retryCount = 0) {
        const MAX_RETRIES = 5;
        const urlBefore = window.location.href;

        // 選擇購票數量
        const qtySelect = document.querySelector("select[name*='ticketPrice'], select[id*='TicketForm_ticketPrice']");
        if (qtySelect) {
            qtySelect.value = CONFIG.buy_count;
            qtySelect.dispatchEvent(new Event("change", { bubbles: true }));
            // sendLog(`已設置購買數量為 ${CONFIG.buy_count} 張`);  // 簡化 LOG：移除設置訊息
        }

        // 勾選同意條款
        const agreeCheckbox = document.querySelector("input[name='agree'], input[type='checkbox'], input#TicketForm_agree");
        if (agreeCheckbox && !agreeCheckbox.checked) {
            agreeCheckbox.click();
            // sendLog("已勾選同意條款");  // 簡化 LOG：移除勾選訊息
        }

        const submitBtn = document.querySelector(
            "input[type='submit'], button[type='submit'], .btn-primary[type='submit']"
        );
        if (!submitBtn) throw new Error("找不到送出按鈕");

        submitBtn.click();
        // sendLog("已送出表單，等待結果...");  // 簡化 LOG：移除過程訊息
    }

    // ── 主流程 ──────────────────────────────────────────────────

    async function runFlow() {
        isRunning = true;
        shouldStop = false;

        const pageType = detectPageType();
        // sendLog(`偵測到頁面類型：${pageType}`);  // 簡化 LOG：移除偵測訊息

        try {
            if (pageType === "HOME") {
                if (CONFIG.target_url) {
                    sendLog("跳轉至目標網址", "info");
                    window.location.href = CONFIG.target_url;
                } else {
                    sendLog("⚠️ 請確認已在 Tixcraft 活動頁面或設定目標網址", "warn");
                }
            }
            else if (pageType === "DETAIL") {
                // sendLog("跳轉至場次選擇頁...");  // 簡化 LOG：移除跳轉訊息
                window.location.href = "https://tixcraft.com/activity/game/" + window.location.pathname.split("/").pop();
            }
            else if (pageType === "DATE") {
                // sendLog("進入場次選擇流程...");  // 簡化 LOG：移除進入訊息
                const selected = await detailStep_selectSession();
                if (!selected) return;
                // sendLog("場次選擇完成，等待跳轉至選座頁...", "success");  // 簡化 LOG：移除等待訊息
            }
            else if (pageType === "GAME") {
                // sendLog("進入活動票種選擇流程...");  // 簡化 LOG：移除進入訊息
                const selected = await gameStep1_selectZone();
                if (!selected) return;
                // sendLog("活動選座步驟完成，等待跳轉至驗證碼結帳頁...", "success");  // 簡化 LOG：移除等待訊息
            }
            else if (pageType === "VERIFY") {
                // sendLog("進入問題驗證流程...");  // 簡化 LOG：移除進入訊息
                await verifyStep_answerQuestion();
                sendLog("✅ 驗證完成", "success");
            }
            else if (pageType === "CAPTCHA") {
                // sendLog("進入驗證碼結帳流程...");  // 簡化 LOG：移除進入訊息
                await waitForElement("#TicketForm_verifyCode-image", 10000);
                const { inputEl, retryCount } = await checkoutStep1_captcha(0);
                await checkoutStep2_submit(inputEl, retryCount);
                sendLog("✅ 等待結帳結果...", "success");
            }
            else if (pageType === "CHECKOUT") {
                sendLog("🎉 購票成功！", "success");
                sendEvent("DONE");
            }
            else if (pageType === "DONE") {
                sendLog("🎉 已完成訂單，請前往付款！", "success");
            }
            else {
                sendLog("⚠️ 無法辨識當前頁面", "warn");
            }

        } catch (err) {
            if (err.message === "使用者已停止") {
                sendLog("流程已停止", "warn");
            } else {
                sendLog(`❌ 流程錯誤：${err.message}`, "error");
                sendEvent("RELOAD");
                await reloadAfterDelay();
                return;
            }
        } finally {
            isRunning = false;
        }
    }

    // ── 監聽 popup 傳入的指令 ────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === "START") {
            // 檢查全域開關是否啟用
            if (!globalEnabled) {
                sendResponse({
                    log: "❌ 腳本注入已停用，請在擴充功能選單中啟用「啟用腳本注入」開關",
                    type: "error"
                });
                return true;
            }

            CONFIG.buy_count = msg.buyCount ?? 2;
            CONFIG.choose_date = msg.chooseDate ?? [];
            CONFIG.choose_area = msg.chooseArea ?? [];
            CONFIG.exclude_area = msg.excludeArea
                ? msg.excludeArea.split(",").map(s => s.trim()).filter(Boolean)
                : [];
            CONFIG.area_fallback = msg.areaFallback ?? "refresh";
            CONFIG.date_fallback = msg.dateFallback ?? "refresh";
            CONFIG.reload_delay = msg.reloadDelay ?? 1;
            CONFIG.target_url = msg.targetUrl ?? "";
            CONFIG.verify_code = msg.verifyCode ?? "";
            CONFIG.ocr_api_url = msg.ocrApiUrl ?? "http://localhost:5511/ocr";

            if (!isRunning) {
                runFlow();
                sendResponse({ log: "✅ 搶票流程已啟動", type: "success" });
            } else {
                sendResponse({ log: "⚠️ 搶票流程已在執行中", type: "warn" });
            }
            return true;
        }

        if (msg.action === "STOP") {
            shouldStop = true;
            isRunning = false;
            sendResponse({ log: "⏹ 已送出停止指令", type: "warn" });
            return true;
        }
    });

    // ── Discord 通知（抵達結帳頁時觸發）──────────────────────────
    const TIXCRAFT_WEBHOOK_URL =
        "https://discord.com/api/webhooks/1441623009596280994/qSkW3MisDAEKNTBbI_08aelRZBf81jJCPqGI8-WxIQdb3fsOpz9aFhKrGsAFXSbg26TC";

    async function notifyTixcraft() {
        if (TIXCRAFT_WEBHOOK_URL.includes("YOUR_WEBHOOK")) return; // 尚未設定，略過
        try {
            await fetch(TIXCRAFT_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: "Tixcraft 搶票通知",
                    embeds: [
                        {
                            title: "🚨 Tixcraft 搶票通知",
                            description: "已抵達結帳頁面！請前往付款",
                            color: 0x00ff00,
                            fields: [
                                { name: "時間", value: new Date().toLocaleString("zh-TW") },
                            ],
                        },
                    ],
                }),
            });
            sendLog("📣 Discord 通知已送出", "success");
        } catch (err) {
            sendLog(`❌ Discord 通知失敗：${err.message}`, "error");
        }
    }

    // 監聽頁面變動，偵測是否抵達結帳頁
    function setupCheckoutObserver() {
        if (!document.body) return;
        const checkoutObserver = new MutationObserver(() => {
            const url = window.location.href;
            if (url.includes("/ticket/checkout/") || url.includes("/ticket/verify/")) {
                checkoutObserver.disconnect();
                notifyTixcraft();
            }
        });
        checkoutObserver.observe(document.body, { childList: true, subtree: true });
    }

    // DOM 就緒後：設定 Observer，並自動從 storage 恢復執行狀態
    function onDomReady() {
        setupCheckoutObserver();
        // sendLog("Tixcraft 搶票助手已注入頁面 ✅", "success");  // 簡化 LOG：移除注入訊息

        // 若 storage 記錄為執行中，無需等待 background.js 訊息，直接自啟動
        // 使用 tixcraft_ 前綴命名空間，避免與 KKTIX 設定衝突
        chrome.storage.local.get(["tixcraft_isRunning", "tixcraft_runningConfig"], (result) => {
            if (!result.tixcraft_isRunning || !result.tixcraft_runningConfig || isRunning) return;
            const cfg = result.tixcraft_runningConfig;
            CONFIG.buy_count = cfg.buyCount ?? 2;
            CONFIG.choose_date = Array.isArray(cfg.chooseDate)
                ? cfg.chooseDate
                : (cfg.chooseDate ? cfg.chooseDate.split(",").map(s => s.trim()).filter(Boolean) : []);
            CONFIG.choose_area = Array.isArray(cfg.chooseArea)
                ? cfg.chooseArea
                : (cfg.chooseArea ? cfg.chooseArea.split(",").map(s => s.trim()).filter(Boolean) : []);
            CONFIG.exclude_area = cfg.excludeArea
                ? cfg.excludeArea.split(",").map(s => s.trim()).filter(Boolean)
                : [];
            CONFIG.area_fallback = cfg.areaFallback ?? "refresh";
            CONFIG.date_fallback = cfg.dateFallback ?? "refresh";
            CONFIG.reload_delay = cfg.reloadDelay ?? 1;
            CONFIG.target_url = cfg.targetUrl ?? "";
            CONFIG.verify_code = cfg.verifyCode ?? "";
            CONFIG.ocr_api_url = cfg.ocrApiUrl ?? "http://localhost:5511/ocr";
            sendLog("⚙️ 自動啟動搜票流程", "info");
            runFlow();
        });
    }

    // document_start 時 document.body 可能尚未存在，等 DOMContentLoaded 後再執行
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onDomReady);
    } else {
        onDomReady();
    }

} // end of __tixcraftLoaded guard
