// ============================================================
//  content.js — Tixcraft 搶票助手 內容腳本
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
    console.log("[Tixcraft助手] content.js 已載入，略過重複注入");
} else {
    window.__tixcraftLoaded = true;

    // ── 全域狀態 ─────────────────────────────────────────────────
    let isRunning = false;
    let shouldStop = false;

    // ── 網路請求追蹤器 ────────────────────────────────────────────
    // 計算目前進行中的 XHR / fetch 請求數量
    let _pendingRequests = 0;

    // 攔截 XMLHttpRequest：在 open 時計數加一，請求結束時計數減一
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

    // 攔截 fetch：呼叫前計數加一，Promise 結束後計數減一
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
        choose_date: [],       // 場次日期關鍵字陣列（用於 DETAIL 頁比對場次）
        choose_area: [],       // 區域關鍵字陣列（用於 GAME 頁比對區域）
        ocr_api_url: "http://localhost:5511/ocr",
    };

    // ── 工具函式 ─────────────────────────────────────────────────

    // 延遲
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 傳送紀錄訊息給 popup
    function sendLog(text, type = "info") {
        console.log(`[Tixcraft助手] ${text}`);
        chrome.runtime.sendMessage({ from: "content", event: "LOG", text, type });
    }

    // 傳送事件給 popup
    function sendEvent(event, extra = {}) {
        chrome.runtime.sendMessage({ from: "content", event, ...extra });
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
            // 若圖片尚未載入完成，等待 load 事件
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

    // 透過本地 OCR API 辨識驗證碼圖片
    async function recognizeCaptcha(imgEl) {
        sendLog("正在呼叫 OCR API 辨識驗證碼...");
        const base64 = await imageElementToBase64(imgEl);

        const response = await fetch(CONFIG.ocr_api_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64 }),
        });

        if (!response.ok) {
            throw new Error(`OCR API 回應錯誤：HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(`OCR 辨識失敗：${data.error}`);
        }

        sendLog(`OCR 辨識結果：${data.code}`, "success");
        return data.code;
    }

    // 模擬真實輸入（觸發框架雙向綁定）
    function typeInput(element, text) {
        if (!element) return;
        element.focus();
        element.value = text;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // ── 偵測當前頁面類型 ─────────────────────────────────────────

    function detectPageType() {
        const url = window.location.href;
        if (url.startsWith("https://tixcraft.com/activity/detail")) return "DETAIL";   // 活動詳情
        if (url.includes("/activity/game")) return "DATE";                            // 場次選擇頁
        if (url.includes("/ticket/area/")) return "GAME";                              // 選座/選區頁
        if (url.includes("/ticket/checkout/")) return "CHECKOUT";                      // 驗證碼結帳頁
        if (url.includes("/ticket/ticket/")) return "VERIFY";                          // 驗證頁（同結帳）
        return "UNKNOWN";
    }

    // ── 活動詳情頁步驟 ──────────────────────────────────────────────

    /**
     * DetailStep：從 #gameList 的場次表格中，依 choose_area 優先順序
     * 比對「節目名稱（td[1]）」或「節目地點（td[2]）」，
     * 找到符合的場次後點擊該列 td[3] 內的「立即訂購」按鈕。
     *
     * 場次表格結構：
     *   div#gameList > table > tbody > tr
     *     td[0] 場次時間
     *     td[1] 節目名稱
     *     td[2] 節目地點
     *     td[3] 立即訂購按鈕（button）
     */
    async function detailStep_selectSession() {
        sendLog("等待場次列表載入...");
        await waitForElement("#gameList", 15000);

        // 取出所有場次列
        const rows = Array.from(
            document.querySelectorAll("#gameList table tbody tr")
        );

        if (rows.length === 0) {
            throw new Error("找不到場次列表，請確認已在活動詳情頁面");
        }

        // 過濾出有「立即訂購」按鈕的可購買場次（按鈕存在且未 disabled）
        const availableRows = rows.filter(row => {
            const btn = row.querySelector("td:nth-child(4) button, td:nth-child(4) a");
            return btn && !btn.disabled && btn.offsetParent !== null;
        });

        if (availableRows.length === 0) {
            sendLog("⚠️ 目前無可購買場次，重新整理頁面...", "warn");
            sendEvent("RELOAD");
            window.location.reload();
            return false;
        }

        // 依 choose_date 優先順序比對場次時間（td[0]）
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

        // 找不到指定日期 → 選第一個可用場次
        if (!selectedRow) {
            if (CONFIG.choose_date.length > 0) {
                sendLog("⚠️ 找不到符合日期的場次，選擇第一個可用場次", "warn");
            }
            selectedRow = availableRows[0];
        }

        // 紀錄選到的場次資訊
        const time = selectedRow.querySelector("td:nth-child(1)")?.innerText?.trim() ?? "";
        const name = selectedRow.querySelector("td:nth-child(2)")?.innerText?.trim() ?? "";
        const location = selectedRow.querySelector("td:nth-child(3)")?.innerText?.trim() ?? "";
        sendLog(`選定場次：${time} ／ ${name} ／ ${location}`);

        // 點擊「立即訂購」按鈕，並等待網路請求完成後再繼續
        const buyBtn = selectedRow.querySelector("td:nth-child(4) button, td:nth-child(4) a");
        buyBtn.click();
        sendLog("DetailStep：已點擊立即訂購");
        return true;
    }

    // ── 選座頁步驟 ───────────────────────────────────────────────

    /**
     * GameStep 1：在票種表格中選擇指定區域並點擊「立即購票」
     *
     * Tixcraft 的票種表格結構：
     *   table.zone_list > tbody > tr
     *     td（區域名稱）、td（剩餘數量）、td（價格）、td（購買連結）
     */
    async function gameStep1_selectZone() {
        sendLog("等待區域選擇區塊載入...");

        // 等待主容器 div.zone.area-list 出現
        await waitForElement("div.zone.area-list", 15000);

        // 取出所有區域連結：div.zone.area-list > ul.area-list > li > a
        const allLinks = Array.from(
            document.querySelectorAll("div.zone.area-list ul.area-list li a")
        );

        if (allLinks.length === 0) {
            throw new Error("找不到任何區域連結，請確認已在票種選擇頁面");
        }

        // 過濾掉已售完的連結
        // 售完狀態通常帶有 disabled class、aria-disabled 或父層 li 有 soldout class
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
            return !isSoldOut;
        });

        if (availableLinks.length === 0) {
            sendLog("⚠️ 所有區域已售完，重新整理頁面...", "warn");
            sendEvent("RELOAD");
            window.location.reload();
            return false;
        }

        // 依 choose_area 優先順序比對 <a> 內的 span 文字（包含區域名稱與價格）
        let selectedLink = null;

        for (const keyword of CONFIG.choose_area) {
            const matched = availableLinks.filter(a => {
                // 取出 a 內所有 span 的文字合併判斷
                const spans = Array.from(a.querySelectorAll("span"));
                const spanText = spans.map(s => s.textContent).join(" ");
                // 同時也比對整個 a 的 textContent 以防沒有 span 包覆的情況
                return spanText.includes(keyword) || a.textContent.includes(keyword);
            });

            if (matched.length > 0) {
                // 隨機從符合的連結中選一個（避免所有人搶同一個）
                selectedLink = matched[Math.floor(Math.random() * matched.length)];
                sendLog(`依優先順序選擇區域「${keyword}」`, "success");
                break;
            }
        }

        // 找不到指定關鍵字 → 選第一個可用區域
        if (!selectedLink) {
            sendLog("⚠️ 找不到指定區域關鍵字，選擇第一個可用區域", "warn");
            selectedLink = availableLinks[0];
        }

        // 記錄選到的區域文字
        const zoneText = selectedLink.textContent.trim().replace(/\s+/g, " ");
        sendLog(`選定區域：${zoneText}`);

        selectedLink.click();
        sendLog("GameStep 1：已點擊區域連結");
        return true;
    }

    // ── 驗證碼結帳頁步驟 ─────────────────────────────────────────

    /**
     * CheckoutStep 1：辨識並填入驗證碼
     *
     * Tixcraft 結帳頁驗證碼結構：
     *   <img id="yw0"> 或 <img class="captcha-img">  – 驗證碼圖片
     *   <input id="RegistrationForm_verifyCode">      – 驗證碼輸入框
     */
    async function checkoutStep1_captcha(retryCount = 0) {
        const MAX_RETRIES = 5;
        sendLog(`辨識驗證碼（第 ${retryCount + 1} 次）...`);

        // 找到驗證碼圖片
        const imgEl = document.querySelector(
            "#TicketForm_verifyCode-image"
        );
        if (!imgEl) throw new Error("找不到驗證碼圖片");

        // 找到驗證碼輸入框
        const inputEl = document.querySelector(
            "#TicketForm_verifyCode"
        );
        if (!inputEl) throw new Error("找不到驗證碼輸入框");

        let code;
        try {
            code = await recognizeCaptcha(imgEl);
        } catch (e) {
            // OCR API 呼叫失敗（Server 未啟動等）
            sendLog(`❌ OCR 失敗：${e.message}`, "error");
            sendLog("請確認本地 OCR Server 已啟動（python ocr_server.py）", "error");
            throw e;
        }

        // 填入驗證碼
        typeInput(inputEl, code);
        sendLog(`已填入驗證碼：${code}`, "success");

        return { inputEl, retryCount };
    }

    /**
     * CheckoutStep 2：送出表單並等待結果
     * 若驗證碼錯誤，自動重試（換新圖片再辨識）
     */
    async function checkoutStep2_submit(inputEl, retryCount = 0) {
        const MAX_RETRIES = 5;

        // 記錄送出前的 URL，用於偵測是否成功跳轉
        const urlBefore = window.location.href;

        // 選擇購票數量
        const qtySelect = document.querySelector("select[name*='ticketPrice'], select[id*='TicketForm_ticketPrice']");
        if (qtySelect) {
            qtySelect.value = CONFIG.buy_count;
            qtySelect.dispatchEvent(new Event("change", { bubbles: true }));
            sendLog(`已設置購買數量為 ${CONFIG.buy_count} 張`);
        }

        // 勾選同意條款
        const agreeCheckbox = document.querySelector("input[name='agree'], input[type='checkbox'], input#TicketForm_agree");
        if (agreeCheckbox && !agreeCheckbox.checked) {
            agreeCheckbox.click();
            sendLog("已勾選同意條款");
        }

        // 送出表單
        const submitBtn = document.querySelector(
            "input[type='submit'], button[type='submit'], .btn-primary[type='submit']"
        );
        if (!submitBtn) throw new Error("找不到送出按鈕");

        // ── 攔截 alert，偵測驗證碼錯誤 ──────────────────────────
        // Tixcraft 驗證碼錯誤時會透過 window.alert 彈出提示，
        // 透過覆寫 alert 將其轉為 Promise resolve，避免阻塞並取得錯誤訊息
        let alertMessage = null;
        const originalAlert = window.alert;
        const alertPromise = new Promise(resolve => {
            window.alert = (msg) => {
                alertMessage = msg ?? "";
                sendLog(`⚠️ 攔截到 alert：${alertMessage}`, "warn");
                resolve(true); // 代表有 alert 觸發
            };
        });

        submitBtn.click();
        sendLog("已送出表單，等待結果...");

        // 等待：alert 觸發 或 頁面跳轉（最多 4 秒）
        const raceResult = await Promise.race([
            alertPromise,
            delay(4000).then(() => false),
        ]);

        // 還原原始 alert
        window.alert = originalAlert;

        const alertTriggered = raceResult === true;
        const stillOnSamePage = window.location.href === urlBefore;

        if (alertTriggered || stillOnSamePage) {
            if (retryCount >= MAX_RETRIES) {
                throw new Error(`驗證碼辨識失敗超過 ${MAX_RETRIES} 次，請手動操作`);
            }

            sendLog(`⚠️ 驗證碼錯誤，重新辨識（第 ${retryCount + 2} 次）...`, "warn");

            // 點擊驗證碼圖片以刷新，並等待新圖片的網路請求完成
            const imgEl = document.querySelector("#TicketForm_verifyCode-image");
            if (imgEl) {
                imgEl.click();
            }

            // 遞迴重試
            const { inputEl: newInput } = await checkoutStep1_captcha(retryCount + 1);
            await checkoutStep2_submit(newInput, retryCount + 1);
        } else {
            sendLog("✅ 驗證碼正確，表單已送出！", "success");
        }
    }

    // ── 主流程 ──────────────────────────────────────────────────

    async function runFlow() {
        isRunning = true;
        shouldStop = false;
        let errorCount = 0;

        const pageType = detectPageType();
        sendLog(`偵測到頁面類型：${pageType}`);

        try {
            if (pageType === "DETAIL") {
                // ── 活動詳情頁流程 ─────────────────────
                sendLog("跳轉至場次選擇頁...");
                window.location.href = "https://tixcraft.com/activity/game/" + window.location.pathname.split("/").pop();
            } else if (pageType === "DATE") {
                sendLog("進入場次選擇流程...");
                const selected = await detailStep_selectSession();
                if (!selected) return; // 無可購買場次，觸發 reload
                sendLog("場次選擇完成，等待跳轉至選座頁...", "success");
            }
            else if (pageType === "GAME") {
                // ── 活動選座頁流程 ────────────────────────────────
                sendLog("進入活動票種選擇流程...");
                const selected = await gameStep1_selectZone();
                if (!selected) return; // 已售完，觸發 reload

                sendLog("活動選座步驟完成，等待跳轉至驗證碼結帳頁...", "success");

            } else if (pageType === "CHECKOUT" || pageType === "VERIFY") {
                // ── 驗證碼結帳頁流程 ──────────────────────────────
                sendLog("進入驗證碼結帳流程...");

                // 等待驗證碼圖片出現
                await waitForElement("#TicketForm_verifyCode-image", 10000);

                const { inputEl, retryCount } = await checkoutStep1_captcha(0);

                await checkoutStep2_submit(inputEl, retryCount);

                sendLog("🎉 結帳流程完成！", "success");
                sendEvent("DONE");

            } else {
                sendLog("⚠️ 無法辨識當前頁面，請確認已在 Tixcraft 活動頁面", "warn");
            }

        } catch (err) {
            if (err.message === "使用者已停止") {
                sendLog("流程已停止", "warn");
            } else {
                errorCount++;
                sendLog(`❌ 流程錯誤：${err.message}`, "error");

                if (errorCount >= 3) {
                    sendLog("錯誤過多，重新整理頁面...", "error");
                    sendEvent("RELOAD");
                    window.location.reload();
                    return;
                }
            }
        } finally {
            isRunning = false;
        }
    }

    // ── 監聽 popup 傳入的指令 ────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === "START") {
            CONFIG.buy_count = msg.buyCount ?? 2;
            CONFIG.choose_date = msg.chooseDate ?? [];
            CONFIG.choose_area = msg.chooseArea ?? [];
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

    // ── 通知 Discord Webhook（當到達結帳頁時觸發）─────────────────
    const WEBHOOK_URL =
        "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN";

    async function notify() {
        if (WEBHOOK_URL.includes("YOUR_WEBHOOK")) return; // 尚未設定，略過
        try {
            await fetch(WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: "Tixcraft 搶票通知",
                    embeds: [
                        {
                            title: "🚨 搶票通知",
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
                notify();
            }
        });
        checkoutObserver.observe(document.body, { childList: true, subtree: true });
    }

    // DOM 就緒後：設定 Observer，並自動從 storage 恢復執行狀態
    function onDomReady() {
        setupCheckoutObserver();
        sendLog("Tixcraft 搶票助手已注入頁面 ✅", "success");

        // 若 storage 記錄為執行中，無需等待 background.js 訊息，直接自啟動
        chrome.storage.local.get(["isRunning", "runningConfig"], (result) => {
            if (!result.isRunning || !result.runningConfig || isRunning) return;
            const cfg = result.runningConfig;
            CONFIG.buy_count   = cfg.buyCount   ?? 2;
            CONFIG.choose_date = Array.isArray(cfg.chooseDate)
                ? cfg.chooseDate
                : (cfg.chooseDate ? cfg.chooseDate.split(",").map(s => s.trim()).filter(Boolean) : []);
            CONFIG.choose_area = Array.isArray(cfg.chooseArea)
                ? cfg.chooseArea
                : (cfg.chooseArea ? cfg.chooseArea.split(",").map(s => s.trim()).filter(Boolean) : []);
            CONFIG.ocr_api_url = cfg.ocrApiUrl ?? "http://localhost:5511/ocr";
            sendLog("偵測到搶票任務進行中，自動啟動流程...", "info");
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
