// ============================================================
//  kktix-content.js — KKTIX 搶票助手 內容腳本（整合版）
//  負責在 KKTIX 頁面上執行自動搶票流程
// ============================================================

// 防止重複注入：同一頁面已載入時直接略過，reload 後旗標消失會重新初始化
if (window.__kktixLoaded) {
    console.log("[搶票助手][KKTIX] content.js 已載入，略過重複注入");
} else {
    window.__kktixLoaded = true;

    // ── 全域狀態 ─────────────────────────────────────────────────
    let isRunning = false;   // 是否正在執行
    let shouldStop = false;   // 是否被要求停止
    let randomUnit = null;    // 已選定的票種 DOM 元素

    // 目前執行參數（由 popup 傳入）
    let CONFIG = {
        buy_count: 0,
        choose_area: [],
        membercode: "",
        question: "",
    };

    // ── 工具函式 ─────────────────────────────────────────────────

    // 延遲
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 傳送紀錄訊息給 popup
    function sendLog(text, type = "info") {
        console.log(`[搶票助手][KKTIX] ${text}`);
        chrome.runtime.sendMessage({ from: "kktix-content", event: "LOG", text, type });
    }

    // 傳送事件給 popup
    function sendEvent(event, extra = {}) {
        chrome.runtime.sendMessage({ from: "kktix-content", event, ...extra });
    }

    // 模擬真實輸入（觸發 Angular/Vue 等框架的雙向綁定）
    function typeInput(element, text) {
        if (!element) return;
        element.focus();
        element.value = "";
        for (const char of text) {
            element.value += char;
            element.dispatchEvent(new Event("input", { bubbles: true }));
        }
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // 帶重試的點擊
    async function clickWithRetry(selector, options = {}) {
        const {
            maxAttempts = 10,
            clickCount = 1,
            context = document,
        } = options;
        let attempts = 0;

        while (attempts < maxAttempts) {
            // 檢查是否被要求停止
            if (shouldStop) throw new Error("使用者已停止");

            const el = context.querySelector(selector);
            if (el) {
                for (let i = 0; i < clickCount; i++) {
                    el.click();
                    // 確認數量欄位是否已達預期值
                    const input = randomUnit.querySelector(
                        "input.ng-pristine.ng-untouched.ng-valid.ng-not-empty, input[type='number']"
                    );
                    if (input.value == CONFIG.buy_count) {
                        break;
                    }
                }
                return true;
            }
            attempts++;
            await delay(300);
        }

        throw new Error(`找不到元素 ${selector}（已嘗試 ${maxAttempts} 次）`);
    }

    // ── 搶票步驟 ─────────────────────────────────────────────────

    // Step 1：選擇票種
    async function step1() {
        const priorityList = CONFIG.choose_area;
        const allUnits = Array.from(document.querySelectorAll(".ticket-unit"));

        // 篩出可操作的 unit（排除輪椅/身障席）
        const validUnits = allUnits.filter(unit => {
            const plusBtn = unit.querySelector(".btn-default.plus");
            const unitText = unit.textContent || "";
            return (
                plusBtn &&
                !plusBtn.disabled &&
                plusBtn.offsetParent !== null &&
                !unitText.includes("輪椅") &&
                !unitText.includes("障")
            );
        });

        if (validUnits.length === 0) throw new Error("找不到可操作的票種");

        let selectedUnit = null;

        // 依優先順序找符合的票種
        for (const price of priorityList) {
            const matched = validUnits.filter(u => u.textContent.includes(price));
            if (matched.length > 0) {
                selectedUnit = matched[Math.floor(Math.random() * matched.length)];
                sendLog(`依優先順序選擇金額 ${price}`, "success");
                break;
            }
        }

        // 找不到指定金額 → 重新整理後重試
        if (!selectedUnit) {
            sendLog("⚠️ 找不到指定金額票種，重新整理頁面...", "warn");
            sendEvent("RELOAD");
            await delay(500);
            window.location.reload();
            return;
        }

        randomUnit = selectedUnit;
        sendLog("Step 1 完成：已選定票種");
    }

    // Step 2：選擇購買數量
    async function step2() {
        await clickWithRetry(".btn-default.plus", {
            context: randomUnit,
            clickCount: CONFIG.buy_count,
        });

        // 確認數量欄位顯示正確
        const input = randomUnit.querySelector(
            "input.ng-pristine.ng-untouched.ng-valid.ng-not-empty, input[type='number']"
        );
        if (input && input.value !== CONFIG.buy_count.toString()) {
            throw new Error(`數量不符，期望 ${CONFIG.buy_count}，實際 ${input.value}`);
        }

        sendLog(`Step 2 完成：數量設為 ${CONFIG.buy_count}`);
    }

    // Step 3：勾選同意條款
    async function step3() {
        const checkbox = document.getElementById("person_agree_terms");

        if (!checkbox) throw new Error("找不到同意條款勾選框 #person_agree_terms");

        if (!checkbox.checked) {
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
            checkbox.click();
        }

        sendLog("Step 3 完成：已勾選同意條款");
    }

    // Step 4：按下立即購買按鈕
    async function step4() {
        await clickWithRetry(".btn.btn-primary.btn-lg.ng-isolate-scope");
        sendLog("Step 4 完成：已點擊立即購買");
    }

    // Step Q：填入會員代碼 / 問題答案
    async function step_question() {
        // 會員代碼
        const membership = document.querySelector("input.member-code");
        if (membership && CONFIG.membercode) {
            typeInput(membership, CONFIG.membercode);
            sendLog("已填入會員代碼");
        }

        // 驗證問題答案
        const captcha = document.querySelector("div.captcha input");
        if (captcha && CONFIG.question) {
            typeInput(captcha, CONFIG.question);
            sendLog("已填入問題答案");
        }
    }

    // ── 主流程 ──────────────────────────────────────────────────

    async function runStepsWithResume() {
        isRunning = true;
        shouldStop = false;

        const steps = [step1, step2, step3, step4];
        let currentStep = 0;
        let errorCount = 0;

        sendLog("等待票券頁面載入...");

        // 等待票券列表元素出現
        let showpage = document.querySelector(".ticket-list-wrapper.ng-scope");
        while (!showpage && !shouldStop) {
            await delay(1000);
            showpage = document.querySelector(".ticket-list-wrapper.ng-scope");
        }

        if (shouldStop) {
            sendLog("流程已停止", "warn");
            isRunning = false;
            return;
        }

        sendLog("票券頁面已就緒，開始執行步驟...");

        // 逐步執行
        while (currentStep < steps.length && !shouldStop) {
            try {
                await steps[currentStep]();
                currentStep++;
                errorCount = 0;

                // 在 Step 4 前先填入問題答案（如果有的話）
                if (currentStep === 3) {
                    await step_question();
                }

            } catch (err) {
                if (err.message === "使用者已停止") {
                    sendLog("流程已停止", "warn");
                    break;
                }

                errorCount++;
                sendLog(
                    `⚠️ Step ${currentStep + 1} 錯誤（第 ${errorCount} 次）：${err.message}`,
                    "warn"
                );

                // 錯誤超過 5 次 → 重新整理
                if (errorCount >= 5) {
                    sendLog("錯誤過多，重新整理頁面...", "error");
                    sendEvent("RELOAD");
                    await delay(500);
                    window.location.reload();
                    return;
                }

                await delay(1000);
            }
        }

        if (!shouldStop) {
            sendLog("所有步驟完成！", "success");
            sendEvent("DONE");
        }

        isRunning = false;
    }

    // ── 攔截 alert 並重整 ────────────────────────────────────────
    const originalAlert = window.alert;
    window.alert = function (message) {
        sendLog(`⚠️ 攔截到 alert：${message}`, "warn");
        originalAlert.apply(window, arguments);
        window.location.reload();
    };

    // ── 監聽 popup 傳入的指令 ────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === "START") {
            CONFIG.buy_count = msg.buyCount ?? 1;
            CONFIG.choose_area = msg.chooseArea ?? [];
            CONFIG.membercode = msg.memberCode ?? "";
            CONFIG.question = msg.question ?? "";

            if (!isRunning) {
                runStepsWithResume();
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

        // 抓取頁面上的所有票種資訊
        if (msg.action === "GET_TICKETS") {
            const wrapper = document.querySelector(".arena-ticket-wrapper");
            if (!wrapper) {
                sendResponse({ tickets: [], error: "找不到票種區塊，請確認已在票券選擇頁面" });
                return true;
            }

            const units = Array.from(wrapper.querySelectorAll(".ticket-list .ticket-unit"));
            const tickets = units
                .map(unit => {
                    const nameEl = unit.querySelector(".ticket-name");
                    const priceEl = unit.querySelector(".ticket-price");
                    return {
                        name: nameEl ? nameEl.innerText.trim().replace(/\s+/g, " ") : "",
                        price: priceEl ? priceEl.innerText.trim().replace(/\s+/g, " ") : "",
                    };
                })
                .filter(t => t.name || t.price);

            sendResponse({ tickets });
            return true;
        }
    });

    // ── 通知 Discord Webhook（當到達結帳頁時觸發）─────────────────
    const KKTIX_WEBHOOK_URL =
        "https://discord.com/api/webhooks/1441618093750222941/oa5CSblPI3FuwScYUtm_Uq_xqhAI__XhvR6WCyoW37jUvWH4WWdSdbKSxTwGdf5GhTRT";

    async function notifyKKTIX() {
        try {
            await fetch(KKTIX_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: "KKTIX 搶票通知機器人",
                    avatar_url: "https://i.imgur.com/AfFp7pu.png",
                    embeds: [
                        {
                            title: "🚨 KKTIX 搶票通知",
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
    const checkoutObserver = new MutationObserver(() => {
        if (document.querySelector(".checkout-page, .order-confirm")) {
            checkoutObserver.disconnect();
            notifyKKTIX();
        }
    });
    checkoutObserver.observe(document.body, { childList: true, subtree: true });

    sendLog("KKTIX 搶票助手已注入頁面 ✅", "success");

} // end of __kktixLoaded guard
