// ============================================================
//  kktix-content.js — KKTIX 搶票助手 內容腳本（整合版）
//  負責在 KKTIX 頁面上執行自動搶票流程
// ============================================================
// 功能：
// - 自動選擇票種（依金額優先順序）
// - 自動設定購買數量
// - 自動勾選同意條款
// - 自動填寫會員代碼和問題答案
// - 支援全域開關控制
// - 支援 reload 後自動恢復流程
// 
// 流程：
// Step 1: 選擇票種（排除輪椅/身障席，依 choose_area 金額優先順序）
// Step 2: 選擇購買數量（點擊 + 按鈕）
// Step 3: 勾選同意條款
// Step Q: 填入會員代碼和問題答案（如果有）
// Step 4: 點擊立即購買
// ============================================================

// 防止重複注入：同一頁面已載入時直接略過，reload 後旗標消失會重新初始化
if (window.__kktixLoaded) {
    console.log("[搶票助手][KKTIX] content.js 已載入，略過重複注入");
} else {
    window.__kktixLoaded = true;

    // ── 檢查全域啟用狀態 ─────────────────────────────────────────
    let globalEnabled = true; // 預設為啟用
    
    // 從 storage 讀取全域開關狀態
    chrome.storage.local.get(["globalEnabled"], (result) => {
        globalEnabled = result.globalEnabled !== false; // 預設為 true
        if (!globalEnabled) {
            console.log("[搶票助手][KKTIX] 腳本注入已停用，不執行任何操作");
        }
    });

    // 監聽全域開關狀態變更
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "updateGlobalEnabled") {
            globalEnabled = message.enabled;
            console.log(`[搶票助手][KKTIX] 全域開關已${globalEnabled ? "啟用" : "停用"}`);
            
            // 如果被停用且正在執行，則停止
            if (!globalEnabled && isRunning) {
                shouldStop = true;
                console.log("[搶票助手][KKTIX] 因全域開關停用，正在停止執行...");
            }
        }
    });

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

    // 停止檢查旗標函式（供 shared.js 的函式使用）
    function isStopped() {
        return shouldStop;
    }

    // 覆蓋 sendLog 以自動添加 source
    const _originalSendLog = window.sendLog;
    function sendLogKKTIX(text, type = "info") {
        _originalSendLog(text, type, "KKTIX");
    }

    // 覆蓋 sendEvent 以自動添加 source
    const _originalSendEvent = window.sendEvent;
    function sendEventKKTIX(event, extra = {}) {
        _originalSendEvent(event, extra, "KKTIX");
    }

    // 覆蓋 typeInput 以使用 KKTIX 的逐字輸入模式
    const _originalTypeInput = window.typeInput;
    function typeInputKKTIX(element, text) {
        _originalTypeInput(element, text, true); // stepByStep = true
    }

    // 帶重試的點擊
    async function clickWithRetry(selector, options = {}) {
        return window.clickWithRetry(selector, {
            ...options,
            shouldStop: isStopped,
        });
    }

    // ============================================================
    // 搶票步驟函式
    // ============================================================

    /**
     * Step 1：選擇票種
     * 
     * 功能：
     * 1. 篩出可操作的票種（排除輪椅/身障席）
     * 2. 依優先順序匹配票種金額
     * 3. 如果找不到指定金額，重新整理頁面
     */
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
                sendLogKKTIX(`依優先順序選擇金額 ${price}`, "success");
                break;
            }
        }

        // 找不到指定金額 → 重新整理後重試
        if (!selectedUnit) {
            sendLogKKTIX("⚠️ 找不到指定金額票種，重新整理頁面...", "warn");
            sendEventKKTIX("RELOAD");
            await delay(500);
            window.location.reload();
            return;
        }

        randomUnit = selectedUnit;
        // sendLog("Step 1 完成：已選定票種");  // 簡化 LOG：移除步驟細節
    }

    /**
     * Step 2：選擇購買數量
     * 
     * 功能：
     * 1. 點擊 + 按鈕增加數量到指定值
     * 2. 確認數量欄位顯示正確
     */
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

        // sendLog(`Step 2 完成：數量設為 ${CONFIG.buy_count}`);  // 簡化 LOG：移除步驟細節
    }

    /**
     * Step 3：勾選同意條款
     * 
     * 功能：
     * 1. 找到同意條款勾選框
     * 2. 觸發 change 事件並點擊
     */
    async function step3() {
        const checkbox = document.getElementById("person_agree_terms");

        if (!checkbox) throw new Error("找不到同意條款勾選框 #person_agree_terms");

        if (!checkbox.checked) {
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
            checkbox.click();
        }

        // sendLog("Step 3 完成：已勾選同意條款");  // 簡化 LOG：移除步驟細節
    }

    /**
     * Step 4：按下立即購買按鈕
     * 
     * 功能：
     * 點擊 KKTIX 的主要送出按鈕
     */
    async function step4() {
        await clickWithRetry(".btn.btn-primary.btn-lg.ng-isolate-scope");
        // sendLog("Step 4 完成：已點擊立即購買");  // 簡化 LOG：移除步驟細節
    }

    /**
     * Step Q：填入會員代碼 / 問題答案
     * 
     * 功能：
     * 1. 如果有會員代碼欄位且設定了 membercode，填入
     * 2. 如果有驗證問題且設定了 question，填入
     */
    async function step_question() {
        // 會員代碼
        const membership = document.querySelector("input.member-code");
        if (membership && CONFIG.membercode) {
            typeInputKKTIX(membership, CONFIG.membercode);
            sendLogKKTIX("已填入會員代碼");
        }

        // 驗證問題答案
        const captcha = document.querySelector("div.captcha input");
        if (captcha && CONFIG.question) {
            typeInputKKTIX(captcha, CONFIG.question);
            sendLogKKTIX("已填入問題答案");
        }
    }

    // ============================================================
    // 主流程控制函式
    // ============================================================

    /**
     * 主流程執行函式（帶恢復機制）
     * 
     * 流程：
     * 1. 等待票券頁面載入
     * 2. 依序執行 step1 → step2 → step3 → step_question → step4
     * 3. 如果有錯誤，重試最多 5 次
     * 4. 錯誤過多時重新整理頁面
     * 5. 所有步驟完成後發送 DONE 事件
     */
    async function runStepsWithResume() {
        isRunning = true;
        shouldStop = false;

        const steps = [step1, step2, step3, step4];
        let currentStep = 0;
        let errorCount = 0;

        sendLogKKTIX("等待票券頁面載入...");

        // 等待票券列表元素出現
        let showpage = document.querySelector(".ticket-list-wrapper.ng-scope");
        while (!showpage && !shouldStop) {
            await delay(1000);
            showpage = document.querySelector(".ticket-list-wrapper.ng-scope");
        }

        if (shouldStop) {
            sendLogKKTIX("流程已停止", "warn");
            isRunning = false;
            return;
        }

        // sendLog("票券頁面已就緒，開始執行步驟...");  // 簡化 LOG：移除步驟訊息

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
                    sendLogKKTIX("流程已停止", "warn");
                    break;
                }

                errorCount++;
                sendLogKKTIX(
                    `⚠️ Step ${currentStep + 1} 錯誤（第 ${errorCount} 次）：${err.message}`,
                    "warn"
                );

                // 錯誤超過 5 次 → 重新整理
                if (errorCount >= 5) {
                    sendLogKKTIX("錯誤過多，重新整理頁面...", "error");
                    sendEventKKTIX("RELOAD");
                    await delay(500);
                    window.location.reload();
                    return;
                }

                await delay(1000);
            }
        }

        if (!shouldStop) {
            sendLogKKTIX("所有步驟完成！", "success");
            sendEventKKTIX("DONE");
        }

        isRunning = false;
    }

    // ── 攔截 alert 並重整 ────────────────────────────────────────
    const originalAlert = window.alert;
    window.alert = function (message) {
        sendLogKKTIX(`⚠️ 攔截到 alert：${message}`, "warn");
        originalAlert.apply(window, arguments);
        window.location.reload();
    };

    // ── DOM 就緒後自動恢復 KKTIX 進度（reload 之後可自動重新執行）
    function onDomReady() {
        chrome.storage.local.get(["kktix_isRunning", "kktix_runningConfig"], (result) => {
            if (!result.kktix_isRunning || !result.kktix_runningConfig || isRunning) return;

            const cfg = result.kktix_runningConfig;
            CONFIG.buy_count = cfg.buyCount ?? 1;
            CONFIG.choose_area = Array.isArray(cfg.chooseArea)
                ? cfg.chooseArea
                : (cfg.chooseArea ? cfg.chooseArea.split(/[,;]/).map(s => s.trim()).filter(Boolean) : []);
            CONFIG.membercode = cfg.memberCode ?? "";
            CONFIG.question = cfg.question ?? "";

            sendLogKKTIX("⚙️ 自動啟動 KKTIX 搶票流程", "info");
            runStepsWithResume();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onDomReady);
    } else {
        onDomReady();
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
            sendLogKKTIX("📃 Discord 通知已送出", "success");
        } catch (err) {
            sendLogKKTIX(`❌ Discord 通知失敗：${err.message}`, "error");
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

    sendLogKKTIX("KKTIX 搶票助手已注入頁面 ✅", "success");
}