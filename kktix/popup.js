// ============================================================
//  popup.js — KKTIX 搶票助手 彈出視窗邏輯
// ============================================================

// DOM 元素參考
const buyCountEl = document.getElementById("buyCount");
const chooseAreaEl = document.getElementById("chooseArea");
const memberCodeEl = document.getElementById("memberCode");
const questionEl = document.getElementById("question");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const saveBtn = document.getElementById("saveBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const logArea = document.getElementById("logArea");

// ── 工具函式 ─────────────────────────────────────────────────

// 寫入紀錄訊息
function addLog(message, type = "info") {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    const now = new Date().toLocaleTimeString("zh-TW");
    entry.textContent = `[${now}] ${message}`;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;
}

// 更新狀態列
function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
}

// 解析區域字串 → 陣列（去除多餘空白）
function parseAreaList(raw) {
    return raw
        .split(";")
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

// 勾選順序追蹤（依勾選先後排列的 price 字串）
let checkOrder = [];

// 讀取目前勾選的票種，依勾選順序（=優先順序）回傳 price 字串陣列
// 若沒有任何勾選，回傳 null（改用手動輸入）
function getCheckedTicketPrices() {
    if (checkOrder.length === 0) return null;
    return [...checkOrder];
}

// 刷新所有列上的優先順序徳章
function refreshOrderBadges() {
    document.querySelectorAll("#ticketList .ticket-cb").forEach(cb => {
        const badge = cb.closest(".ticket-row")?.querySelector(".ticket-priority");
        if (!badge) return;
        const idx = checkOrder.indexOf(cb.dataset.price);
        if (idx >= 0) {
            badge.textContent = idx + 1;
            badge.dataset.active = "true";
        } else {
            badge.textContent = "";
            badge.dataset.active = "false";
        }
    });
}

// ── 設定讀取 / 儲存 ─────────────────────────────────────────

// 從 chrome.storage 讀取設定並填入欄位
function loadSettings() {
    chrome.storage.local.get(
        ["buyCount", "chooseArea", "memberCode", "question"],
        (result) => {
            buyCountEl.value = result.buyCount ?? 1;
            chooseAreaEl.value = result.chooseArea ?? [];
            memberCodeEl.value = result.memberCode ?? "";
            questionEl.value = result.question ?? "";
        }
    );
}

// ── 票種清單抓取與渲染 ──────────────────────────────────────

// 向 content script 抓取票種清單
async function fetchTickets() {
    const tabId = await getActiveTabId();
    if (!tabId) {
        addLog("❌ 找不到目前分頁", "error");
        return;
    }

    // 確保 content.js 已注入
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (_) { }

    chrome.tabs.sendMessage(tabId, { action: "GET_TICKETS" }, (response) => {
        if (chrome.runtime.lastError) {
            addLog(`⚠️ 抓取票種失敗：${chrome.runtime.lastError.message}`, "warn");
            return;
        }
        if (response?.error) {
            addLog(`⚠️ ${response.error}`, "warn");
            return;
        }
        renderTicketList(response?.tickets ?? []);
    });
}

// 渲染票種 Checkbox 清單
function renderTicketList(tickets) {
    const listEl = document.getElementById("ticketList");
    listEl.innerHTML = "";

    if (tickets.length === 0) {
        listEl.innerHTML = "<div class='ticket-placeholder'>找不到票種，請確認已在 KKTIX 票券選擇頁面</div>";
        addLog("找不到任何票種", "warn");
        return;
    }

    // 讀取已儲存的勾選清單（已依優先順序排列）
    chrome.storage.local.get(["chooseArea"], (result) => {
        // 從 storage 恢復勾選順序
        checkOrder = (result.chooseArea ?? []).filter(
            saved => tickets.some(t => (t.price || t.name) === saved)
        );

        tickets.forEach((ticket, idx) => {
            const id = `tcb_${idx}`;
            const price = ticket.price || ticket.name; // 以 price 作為匹配鍵

            const row = document.createElement("label");
            row.className = "ticket-row";
            row.htmlFor = id;

            // 優先順序徳章
            const badge = document.createElement("span");
            badge.className = "ticket-priority";
            badge.dataset.active = "false";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "ticket-cb";
            cb.id = id;
            cb.dataset.price = price;
            // 若之前有儲存勾選狀態，恢復它
            cb.checked = checkOrder.includes(price);

            // 勾選 / 取消時更新 checkOrder
            cb.addEventListener("change", () => {
                if (cb.checked) {
                    // 新增到阶序最後
                    if (!checkOrder.includes(price)) checkOrder.push(price);
                } else {
                    // 從順序中移除
                    checkOrder = checkOrder.filter(p => p !== price);
                }
                refreshOrderBadges();
            });

            const nameSpan = document.createElement("span");
            nameSpan.className = "ticket-row-name";
            nameSpan.textContent = ticket.name || "（無名稱）";

            const priceSpan = document.createElement("span");
            priceSpan.className = "ticket-row-price";
            priceSpan.textContent = ticket.price || "—";

            row.appendChild(badge);
            row.appendChild(cb);
            row.appendChild(nameSpan);
            row.appendChild(priceSpan);
            listEl.appendChild(row);
        });

        // 初始化徳章顯示
        refreshOrderBadges();
        addLog(`✅ 已載入 ${tickets.length} 個票種`, "success");
    });
}

// 組建設定物件
function buildSettings() {
    // 優先使用勾選清單；若沒有勾選則 fallback 到手動輸入
    const checkedPrices = getCheckedTicketPrices();

        return {
        buyCount: parseInt(buyCountEl.value, 10) || 2,
        chooseArea: checkedPrices,
        memberCode: memberCodeEl.value.trim(),
        question: questionEl.value.trim(),
    };
}

// ── 與 Content Script 通訊 ──────────────────────────────────

// 取得目前活躍分頁的 ID
async function getActiveTabId() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs[0]?.id ?? null);
        });
    });
}

// 傳送訊息給 Content Script
async function sendToContent(action, data = {}) {
    const tabId = await getActiveTabId();
    if (!tabId) {
        addLog("❌ 找不到目前分頁", "error");
        return;
    }

    // 先嘗試注入 content.js（如果尚未注入）
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
    } catch (_) {
        // 若已注入則會拋出錯誤，可安全忽略
    }

    chrome.tabs.sendMessage(tabId, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
            addLog(`⚠️ 通訊錯誤：${chrome.runtime.lastError.message}`, "warn");
            return;
        }
        if (response?.log) {
            addLog(response.log, response.type ?? "info");
        }
    });
}

// ── 按鈕事件 ────────────────────────────────────────────────

// 開始搶票
startBtn.addEventListener("click", async () => {
    const settings = buildSettings();

    // 基本驗證
    if (!settings.buyCount || settings.buyCount < 1) {
        addLog("❌ 購買數量必須大於 0", "error");
        return;
    }

    if (settings.chooseArea.length === 0) {
        addLog("❌ 請至少輸入一個區域金額", "error");
        return;
    }

    // 儲存目前勾選的票種，重開 popup 時可恢復
    const checkedPrices = getCheckedTicketPrices();
    if (checkedPrices) {
        chrome.storage.local.set({ chooseArea: checkedPrices });
    }

    // 同步最新設定到 storage，並記錄執行狀態供 background 重注入使用
    chrome.storage.local.set({
        ...settings,
        isRunning: true,
        runningConfig: {
            buyCount: settings.buyCount,
            chooseArea: settings.chooseArea,
            memberCode: settings.memberCode,
            question: settings.question,
        },
    });

    setStatus("running", "搶票執行中...");
    startBtn.disabled = true;
    stopBtn.disabled = false;
    addLog("🚀 開始搶票流程", "info");

    await sendToContent("START", {
        buyCount: settings.buyCount,
        chooseArea: settings.chooseArea,
        memberCode: settings.memberCode,
        question: settings.question,
    });
});

// 停止搶票
stopBtn.addEventListener("click", async () => {
    // 清除執行狀態，避免 background 在 reload 後繼續自動重注入
    chrome.storage.local.set({ isRunning: false });

    setStatus("idle", "已停止");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    addLog("⏹ 使用者手動停止", "warn");

    await sendToContent("STOP");
});

// 儲存設定
saveBtn.addEventListener("click", () => {
    const settings = buildSettings();
    chrome.storage.local.set(settings, () => {
        addLog("✅ 設定已儲存", "success");
    });
});

// 抓取票種
document.getElementById("fetchTicketsBtn").addEventListener("click", () => {
    addLog("🔍 正在抓取票種...", "info");
    fetchTickets();
});

// ── 監聽來自 Content Script 的主動訊息 ──────────────────────

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.from !== "content") return;

    switch (msg.event) {
        case "LOG":
            addLog(msg.text, msg.type ?? "info");
            break;
        case "DONE":
            // 清除執行狀態
            chrome.storage.local.set({ isRunning: false });
            setStatus("idle", "流程完成");
            startBtn.disabled = false;
            stopBtn.disabled = true;
            addLog("🎉 所有步驟完成！", "success");
            break;
        case "RELOAD":
            addLog("🔄 頁面重新整理中...", "warn");
            break;
        case "ERROR":
            setStatus("error", "發生錯誤");
            addLog(`❌ ${msg.text}`, "error");
            break;
    }
});

// ── 初始化 ──────────────────────────────────────────────────
loadSettings();

// 若擴充功能重新開啟時正在執行中，恢復 UI 狀態；完成後自動嘗試抓取票種
chrome.storage.local.get(["isRunning"], (result) => {
    if (result.isRunning) {
        setStatus("running", "搶票執行中...");
        startBtn.disabled = true;
        stopBtn.disabled = false;
        addLog("偵測到搶票流程仍在執行中", "warn");
    } else {
        addLog("擴充功能已載入，正在自動抓取票種...", "info");
    }

    // 自動抓取票種（無論是否執行中，讓清單保持最新）
    fetchTickets();
});
