// ============================================================
//  popup.js — 搶票助手 Pro 彈出視窗邏輯（整合版）
//  包含 KKTIX、Tixcraft 和 Inline 三個平台的控制邏輯
// ============================================================
// 功能：
// - 管理全域開關（啟用/停用腳本注入）
// - 管理三個平台的設定介面
// - 發送 START/STOP 指令給內容腳本
// - 顯示各平台的即時日誌
// - 管理設定的儲存和讀取
// 
// 介面結構：
// - 全域開關區：控制所有平台的腳本注入
// - 平台切換按鈕：KKTIX / Tixcraft / Inline
// - 各平台子分頁：設定 / 邏輯設定 / 日誌
// 
// 通訊流程：
// popup.js → background.js → content script
// content script → popup.js（日誌和事件）
// ============================================================

// ═══════════════════════════════════════════════════════════
//  全域 Toast 通知系統
// ═══════════════════════════════════════════════════════════

// popup.js
// 側邊欄主控台：管理設定、啟動流程與顯示平台日誌。

const toastEl = document.getElementById("toast");
let toastTimeout = null;

/**
 * 顯示 Toast 通知
 * @param {string} message - 通知訊息
 * @param {string} type - 通知類型：success/error/warn/info
 * @param {number} duration - 顯示時長（毫秒），預設 2500
 */
// 顯示 Toast 訊息，統一處理側邊欄內的成功、警告與錯誤提示。
function showToast(message, type = "info", duration = 2500) {
    // 清除現有的 timeout
    if (toastTimeout) {
        clearTimeout(toastTimeout);
        toastTimeout = null;
    }

    // 設定圖標
    const icons = {
        success: "✓",
        error: "✕",
        warn: "⚠",
        info: "ℹ"
    };

    // 更新內容
    toastEl.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-text">${message}</span>
    `;

    // 移除舊的類型樣式
    toastEl.className = "toast";

    // 添加新的類型樣式並顯示
    toastEl.classList.add(type, "show");

    // 設定自動隱藏
    toastTimeout = setTimeout(() => {
        toastEl.classList.remove("show");
        toastTimeout = null;
    }, duration);
}

// ═══════════════════════════════════════════════════════════
//  全域啟用/停用開關
// ═══════════════════════════════════════════════════════════

const globalEnableToggle = document.getElementById("globalEnableToggle");

// 載入全域啟用狀態
chrome.storage.local.get(["globalEnabled"], (result) => {
    const enabled = result.globalEnabled !== false; // 預設為 true
    globalEnableToggle.checked = enabled;
    updateToggleUI(enabled);
});

// 監聽開關變更
globalEnableToggle.addEventListener("change", () => {
    const enabled = globalEnableToggle.checked;

    // 儲存狀態
    chrome.storage.local.set({ globalEnabled: enabled }, () => {
        console.log(`[全域開關] 已${enabled ? "啟用" : "停用"}腳本注入`);
        showToast(
            enabled ? "腳本注入已啟用" : "腳本注入已停用",
            enabled ? "success" : "info"
        );
    });

    // 更新 UI
    updateToggleUI(enabled);

    // 通知所有 content scripts 狀態已改變
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                action: "updateGlobalEnabled",
                enabled: enabled
            }).catch(() => {
                // 忽略無法傳送訊息的分頁（如 chrome:// 開頭的頁面）
            });
        });
    });
});

// 更新開關 UI 狀態
function updateToggleUI(enabled) {
    const section = document.querySelector(".global-toggle-section");
    if (enabled) {
        section.style.borderColor = "#4caf50";
        section.style.background = "rgba(76, 175, 80, 0.1)";
    } else {
        section.style.borderColor = "#f44336";
        section.style.background = "rgba(244, 67, 54, 0.1)";
    }
}

function popupDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function popupGetActiveTabId(urlPatterns) {
    return new Promise((resolve) => {
        chrome.tabs.query({ url: urlPatterns }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const activeTab = tabs.find(tab => tab.active) ?? tabs[tabs.length - 1];
                resolve(activeTab.id);
                return;
            }
            resolve(null);
        });
    });
}

async function popupEnsureTabId({ urlPatterns, createUrl = "", createDelayMs = 0 }) {
    let tabId = await popupGetActiveTabId(urlPatterns);
    if (!tabId && createUrl) {
        const tab = await chrome.tabs.create({ url: createUrl, active: true });
        tabId = tab.id;
        if (createDelayMs > 0) {
            await popupDelay(createDelayMs);
        }
    }
    return tabId;
}

async function popupInjectFiles(tabId, files, onWarn) {
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files });
    } catch (error) {
        onWarn?.(error);
    }
}

function popupSendMessage(tabId, payload, onSuccess, onError) {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
        if (chrome.runtime.lastError) {
            onError?.(chrome.runtime.lastError);
            return;
        }
        onSuccess?.(response);
    });
}

function popupStorageSet(data) {
    return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

function popupSetRunningState(prefix, isRunning, runningConfig = null) {
    const payload = { [`${prefix}_isRunning`]: isRunning };
    if (runningConfig !== null) {
        payload[`${prefix}_runningConfig`] = runningConfig;
    }
    return popupStorageSet(payload);
}

// ═══════════════════════════════════════════════════════════
//  平台切換
// ═══════════════════════════════════════════════════════════

// ── 平台切換 ─────────────────────────────────────────────────────
document.querySelectorAll(".platform-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const platform = btn.dataset.platform;

        // 切換按鈕 active 狀態
        document.querySelectorAll(".platform-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        // 切換面板顯示
        document.querySelectorAll(".platform-panel").forEach(p => p.classList.remove("active"));
        document.getElementById(`panel-${platform}`).classList.add("active");
    });
});

// ── KKTIX 子 Tab 切換 ────────────────────────────────────────────
document.querySelectorAll("#panel-kktix .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tabId = btn.dataset.tab;

        document.querySelectorAll("#panel-kktix .tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll("#panel-kktix .tab-panel").forEach(p => p.classList.remove("active"));

        btn.classList.add("active");
        document.getElementById(tabId).classList.add("active");
    });
});

// ── Tixcraft 子 Tab 切換 ─────────────────────────────────────────
document.querySelectorAll("#panel-tixcraft .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tabId = btn.dataset.tab;

        document.querySelectorAll("#panel-tixcraft .tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll("#panel-tixcraft .tab-panel").forEach(p => p.classList.remove("active"));

        btn.classList.add("active");
        document.getElementById(tabId).classList.add("active");
    });
});

// ════════════════════════════════════════════════════════════════
//  KKTIX 邏輯
// ════════════════════════════════════════════════════════════════

// ── KKTIX DOM 元素引用 ────────────────────────────────────────────
const kktixBuyCountEl = document.getElementById("kktix-buyCount");
const kktixChooseAreaEl = document.getElementById("kktix-chooseArea");
const kktixMemberCodeEl = document.getElementById("kktix-memberCode");
const kktixQuestionEl = document.getElementById("kktix-question");
const kktixTicketFallbackEl = document.getElementById("kktix-ticketFallback");
const kktixReloadDelayEl = document.getElementById("kktix-reloadDelay");
const kktixStartBtn = document.getElementById("kktix-startBtn");
const kktixStopBtn = document.getElementById("kktix-stopBtn");
const kktixSaveBtn = document.getElementById("kktix-saveBtn");
const kktixSaveBtnLogic = document.getElementById("kktix-saveBtnLogic");
const kktixLogArea = document.getElementById("kktix-logArea");
const kktixStatusDot = document.getElementById("kktix-statusDot");
const kktixStatusText = document.getElementById("kktix-statusText");
const kktixClearLogBtn = document.getElementById("kktix-clearLogBtn");

// 記錄勾選的票種優先順序
let kktixCheckOrder = [];

// ── KKTIX 工具函式 ────────────────────────────────────────────────

function kktixAddLog(message, type = "info") {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    const now = new Date().toLocaleTimeString("zh-TW");
    entry.textContent = `[${now}] ${message}`;
    kktixLogArea.appendChild(entry);
    kktixLogArea.scrollTop = kktixLogArea.scrollHeight;
}

function kktixSetStatus(state, text) {
    kktixStatusDot.className = `status-dot ${state}`;
    kktixStatusText.textContent = text;
}

// 讀取目前勾選的票種（依勾選順序）
function kktixGetCheckedPrices() {
    if (kktixCheckOrder.length === 0) return null;
    return [...kktixCheckOrder];
}

// 刷新優先順序徽章
function kktixRefreshBadges() {
    document.querySelectorAll("#kktix-ticketList .ticket-cb").forEach(cb => {
        const badge = cb.closest(".ticket-row")?.querySelector(".ticket-priority");
        if (!badge) return;
        const idx = kktixCheckOrder.indexOf(cb.dataset.price);
        if (idx >= 0) {
            badge.textContent = idx + 1;
            badge.dataset.active = "true";
        } else {
            badge.textContent = "";
            badge.dataset.active = "false";
        }
    });
}

// ── KKTIX 設定讀取 / 儲存 ────────────────────────────────────────

function kktixLoadSettings() {
    chrome.storage.local.get(
        ["kktix_buyCount", "kktix_chooseArea", "kktix_memberCode", "kktix_question",
            "kktix_ticketFallback", "kktix_reloadDelay"],
        (result) => {
            kktixBuyCountEl.value = result.kktix_buyCount ?? 2;
            kktixMemberCodeEl.value = result.kktix_memberCode ?? "";
            kktixQuestionEl.value = result.kktix_question ?? "";
            kktixTicketFallbackEl.value = result.kktix_ticketFallback ?? "refresh";
            kktixReloadDelayEl.value = result.kktix_reloadDelay ?? 1;
            // chooseArea 陣列顯示於 textarea（備用）
            if (Array.isArray(result.kktix_chooseArea)) {
                kktixChooseAreaEl.value = result.kktix_chooseArea.join(", ");
            }
        }
    );
}

function kktixBuildSettings() {
    const checkedPrices = kktixGetCheckedPrices();
    // 若無勾選，嘗試從 textarea 手動輸入取得
    let chooseArea = checkedPrices;
    if (!chooseArea) {
        const raw = kktixChooseAreaEl.value.trim();
        chooseArea = raw ? raw.split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
    }
    return {
        buyCount: parseInt(kktixBuyCountEl.value, 10) || 2,
        chooseArea,
        memberCode: kktixMemberCodeEl.value.trim(),
        question: kktixQuestionEl.value.trim(),
        ticketFallback: kktixTicketFallbackEl.value,
        reloadDelay: parseFloat(kktixReloadDelayEl.value) || 1,
    };
}

// ── KKTIX 票種清單抓取 ────────────────────────────────────────────

async function kktixFetchTickets() {
    const tabId = await kktixGetActiveTabId();
    if (!tabId) {
        kktixAddLog("❌ 找不到目前的 KKTIX 分頁", "error");
        return;
    }

    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "kktix/kktix-content.js"] });
    } catch (err) {
        kktixAddLog(`⚠️ 注入腳本失敗：${err.message}`, "warn");
    }

    // 等待 content script 初始化
    await new Promise(resolve => setTimeout(resolve, 300));

    chrome.tabs.sendMessage(tabId, { action: "GET_TICKETS" }, (response) => {
        if (chrome.runtime.lastError) {
            kktixAddLog(`⚠️ 抓取票種失敗：${chrome.runtime.lastError.message}`, "warn");
            kktixAddLog("請確認已在 KKTIX 票券選擇頁面，並重新整理頁面後再試", "info");
            return;
        }
        if (response?.error) {
            kktixAddLog(`⚠️ ${response.error}`, "warn");
            return;
        }
        kktixRenderTicketList(response?.tickets ?? []);
    });
}

function kktixRenderTicketList(tickets) {
    const listEl = document.getElementById("kktix-ticketList");
    listEl.innerHTML = "";

    if (tickets.length === 0) {
        listEl.innerHTML = "<div class='ticket-placeholder'>找不到票種，請確認已在 KKTIX 票券選擇頁面</div>";
        kktixAddLog("找不到任何票種", "warn");
        return;
    }

    chrome.storage.local.get(["kktix_chooseArea"], (result) => {
        kktixCheckOrder = (result.kktix_chooseArea ?? []).filter(
            saved => tickets.some(t => (t.price || t.name) === saved)
        );

        tickets.forEach((ticket, idx) => {
            const id = `kktix-tcb-${idx}`;
            const price = ticket.price || ticket.name;

            const row = document.createElement("label");
            row.className = "ticket-row";
            row.htmlFor = id;

            const badge = document.createElement("span");
            badge.className = "ticket-priority";
            badge.dataset.active = "false";

            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "ticket-cb";
            cb.id = id;
            cb.dataset.price = price;
            cb.checked = kktixCheckOrder.includes(price);

            cb.addEventListener("change", () => {
                if (cb.checked) {
                    if (!kktixCheckOrder.includes(price)) kktixCheckOrder.push(price);
                } else {
                    kktixCheckOrder = kktixCheckOrder.filter(p => p !== price);
                }
                kktixRefreshBadges();
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

        // 顯示手動輸入區塊
        document.getElementById("kktix-manualAreaWrap").style.display = "";

        kktixRefreshBadges();
        kktixAddLog(`✅ 已載入 ${tickets.length} 個票種`, "success");
    });
}

// ── KKTIX 與 Content Script 通訊 ─────────────────────────────────

async function kktixGetActiveTabId() {
    return popupGetActiveTabId(["https://kktix.com/*", "https://*.kktix.com/*", "https://*.kktix.cc/*"]);
}

async function kktixSendToContent(action, data = {}) {
    const tabId = await kktixGetActiveTabId();
    if (!tabId) {
        kktixAddLog("❌ 找不到 KKTIX 分頁，請確認已開啟 kktix.com", "error");
        return;
    }

    await popupInjectFiles(tabId, ["shared.js", "kktix/kktix-content.js"], (err) => {
        kktixAddLog(`⚠️ 注入腳本失敗：${err.message}`, "warn");
    });

    await popupDelay(300);

    popupSendMessage(
        tabId,
        { action, ...data },
        (response) => {
            if (response?.log) {
                kktixAddLog(response.log, response.type ?? "info");
            }
        },
        (runtimeError) => {
            kktixAddLog(`⚠️ 通訊錯誤：${runtimeError.message}`, "warn");
            kktixAddLog("請確認已在 KKTIX 頁面，並重新整理後再試", "info");
        }
    );
}

// ── KKTIX 按鈕事件 ────────────────────────────────────────────────

kktixStartBtn.addEventListener("click", async () => {
    const settings = kktixBuildSettings();

    if (!settings.buyCount || settings.buyCount < 1) {
        kktixAddLog("❌ 步驟 1：購買數量必須大於 0", "error");
        showToast("請填寫步驟 1：購買數量", "error");
        return;
    }

    if (!settings.chooseArea || settings.chooseArea.length === 0) {
        kktixAddLog("❌ 步驟 2：請至少輸入或勾選一個票種", "error");
        showToast("請完成步驟 2：選擇票種", "error");
        return;
    }

    // 儲存勾選狀態供重開 popup 時恢復
    const checkedPrices = kktixGetCheckedPrices();
    if (checkedPrices) {
        chrome.storage.local.set({ kktix_chooseArea: checkedPrices });
    }

    await popupStorageSet({
        kktix_buyCount: settings.buyCount,
        kktix_memberCode: settings.memberCode,
        kktix_question: settings.question,
        kktix_ticketFallback: settings.ticketFallback,
        kktix_reloadDelay: settings.reloadDelay,
        kktix_isRunning: true,
        kktix_runningConfig: {
            buyCount: settings.buyCount,
            chooseArea: settings.chooseArea,
            memberCode: settings.memberCode,
            question: settings.question,
            ticketFallback: settings.ticketFallback,
            reloadDelay: settings.reloadDelay,
        },
    });

    kktixSetStatus("running", "搶票執行中...");
    kktixStartBtn.disabled = true;
    kktixStopBtn.disabled = false;
    kktixAddLog("🚀 開始 KKTIX 搶票流程", "info");

    await kktixSendToContent("START", {
        buyCount: settings.buyCount,
        chooseArea: settings.chooseArea,
        memberCode: settings.memberCode,
        question: settings.question,
        ticketFallback: settings.ticketFallback,
        reloadDelay: settings.reloadDelay,
    });
});

kktixStopBtn.addEventListener("click", async () => {
    await popupSetRunningState("kktix", false);
    kktixSetStatus("idle", "已停止");
    kktixStartBtn.disabled = false;
    kktixStopBtn.disabled = true;
    kktixAddLog("⏹ 使用者手動停止", "warn");
    await kktixSendToContent("STOP");
});

kktixSaveBtn.addEventListener("click", () => {
    const settings = kktixBuildSettings();
    chrome.storage.local.set(
        {
            kktix_buyCount: settings.buyCount,
            kktix_chooseArea: settings.chooseArea,
            kktix_memberCode: settings.memberCode,
            kktix_question: settings.question,
        },
        () => {
            showToast("KKTIX 基礎設定已儲存", "success");
            kktixAddLog("✅ KKTIX 基礎設定已儲存", "success");
        }
    );
});

kktixSaveBtnLogic.addEventListener("click", () => {
    const settings = kktixBuildSettings();
    chrome.storage.local.set(
        {
            kktix_ticketFallback: settings.ticketFallback,
            kktix_reloadDelay: settings.reloadDelay,
        },
        () => {
            showToast("KKTIX 執行邏輯已儲存", "success");
            kktixAddLog("✅ KKTIX 執行邏輯已儲存", "success");
        }
    );
});

kktixClearLogBtn.addEventListener("click", () => {
    kktixLogArea.innerHTML = "";
});

document.getElementById("kktix-fetchTicketsBtn").addEventListener("click", () => {
    kktixAddLog("🔍 正在抓取票種...", "info");
    kktixFetchTickets();
});

// ── KKTIX 初始化 ──────────────────────────────────────────────────

function kktixInit() {
    kktixLoadSettings();

    chrome.storage.local.get(["kktix_isRunning", "globalEnabled"], (result) => {
        const globalEnabled = result.globalEnabled !== false; // 預設為 true

        if (result.kktix_isRunning) {
            kktixSetStatus("running", "搶票執行中...");
            kktixStartBtn.disabled = true;
            kktixStopBtn.disabled = false;
            kktixAddLog("偵測到 KKTIX 搶票流程仍在執行中", "warn");
        } else if (globalEnabled) {
            kktixAddLog("KKTIX 助手已載入，請抓取票種後開始搶票", "info");
        } else {
            kktixAddLog("⚠️ 腳本注入已停用，請開啟「啟用腳本注入」開關", "warn");
        }

        // 自動抓取票種（僅在啟用時）
        if (globalEnabled) {
            kktixFetchTickets();
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  Tixcraft 邏輯
// ════════════════════════════════════════════════════════════════

// ── Tixcraft DOM 元素引用 ─────────────────────────────────────────
const tcBuyCountEl = document.getElementById("tixcraft-buyCount");
const tcChooseDateEl = document.getElementById("tixcraft-chooseDate");
const tcChooseAreaEl = document.getElementById("tixcraft-chooseArea");
const tcExcludeAreaEl = document.getElementById("tixcraft-excludeArea");
const tcOcrApiUrlSelectEl = document.getElementById("tixcraft-ocrApiUrlSelect");
const tcOcrApiUrlCustomEl = document.getElementById("tixcraft-ocrApiUrlCustom");
const tcAreaFallbackEl = document.getElementById("tixcraft-areaFallback");
const tcDateFallbackEl = document.getElementById("tixcraft-dateFallback");
const tcReloadDelayEl = document.getElementById("tixcraft-reloadDelay");
const tcTargetUrlEl = document.getElementById("tixcraft-targetUrl");
const tcVerifyCodeEl = document.getElementById("tixcraft-verifyCode");
const tcStartBtn = document.getElementById("tixcraft-startBtn");
const tcStopBtn = document.getElementById("tixcraft-stopBtn");
const tcSaveBtn = document.getElementById("tixcraft-saveBtn");
const tcSaveBtnLogic = document.getElementById("tixcraft-saveBtnLogic");
const tcLogArea = document.getElementById("tixcraft-logArea");
const tcStatusDot = document.getElementById("tixcraft-statusDot");
const tcStatusText = document.getElementById("tixcraft-statusText");
const tcOcrDot = document.getElementById("tixcraft-ocrDot");
const tcOcrLabel = document.getElementById("tixcraft-ocrLabel");
const tcCheckOcrBtn = document.getElementById("tixcraft-checkOcrBtn");
const tcClearLogBtn = document.getElementById("tixcraft-clearLogBtn");

// 日誌最大保留筆數
const TC_MAX_LOG_ENTRIES = 300;

// ── Tixcraft 工具函式 ─────────────────────────────────────────────

// 僅渲染日誌到畫面（不寫入 storage）
function tcRenderLogEntry(time, message, type) {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${time}] ${message}`;
    tcLogArea.appendChild(entry);
    tcLogArea.scrollTop = tcLogArea.scrollHeight;
}

// 寫入日誌並持久化到 storage
function tcAddLog(message, type = "info") {
    const now = new Date().toLocaleTimeString("zh-TW");
    tcRenderLogEntry(now, message, type);

    chrome.storage.local.get(["tixcraft_savedLogs"], (result) => {
        const logs = result.tixcraft_savedLogs ?? [];
        logs.push({ time: now, message, type });
        if (logs.length > TC_MAX_LOG_ENTRIES) {
            logs.splice(0, logs.length - TC_MAX_LOG_ENTRIES);
        }
        chrome.storage.local.set({ tixcraft_savedLogs: logs });
    });
}

function tcSetStatus(state, text) {
    tcStatusDot.className = `status-dot ${state}`;
    tcStatusText.textContent = text;
}

function tcSetOcrStatus(online) {
    if (online) {
        tcOcrDot.className = "ocr-dot online";
        tcOcrLabel.textContent = "OCR Server：✅ 已連線";
        tcOcrLabel.style.color = "#4caf50";
    } else {
        tcOcrDot.className = "ocr-dot offline";
        tcOcrLabel.textContent = "OCR Server：❌ 未連線（請啟動 python ocr_server.py）";
        tcOcrLabel.style.color = "#ef5350";
    }
}

// 以半形逗號分隔關鍵字為陣列
function tcParseKeywords(raw) {
    return raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
}

// ── Tixcraft OCR API 輔助函式 ─────────────────────────────────────

function tcGetOcrApiUrl() {
    if (tcOcrApiUrlSelectEl.value === "__custom__") {
        return tcOcrApiUrlCustomEl.value.trim() || "http://localhost:5511/ocr";
    }
    return tcOcrApiUrlSelectEl.value;
}

function tcGetOcrBaseUrl() {
    const apiUrl = tcGetOcrApiUrl().replace(/\/+$/, "");
    return apiUrl.endsWith("/ocr") ? apiUrl.slice(0, -4) : apiUrl;
}

function tcSetOcrApiUrl(url) {
    const options = Array.from(tcOcrApiUrlSelectEl.options).map(o => o.value);
    const presetIdx = options.indexOf(url);
    if (presetIdx !== -1 && options[presetIdx] !== "__custom__") {
        tcOcrApiUrlSelectEl.value = url;
        tcOcrApiUrlCustomEl.style.display = "none";
    } else {
        tcOcrApiUrlSelectEl.value = "__custom__";
        tcOcrApiUrlCustomEl.value = url;
        tcOcrApiUrlCustomEl.style.display = "block";
    }
}

tcOcrApiUrlSelectEl.addEventListener("change", () => {
    if (tcOcrApiUrlSelectEl.value === "__custom__") {
        tcOcrApiUrlCustomEl.style.display = "block";
        tcOcrApiUrlCustomEl.focus();
    } else {
        tcOcrApiUrlCustomEl.style.display = "none";
    }
});

async function tcCheckOcrServer() {
    const healthUrl = tcGetOcrBaseUrl() + "/health";

    try {
        const res = await fetch(healthUrl, {
            method: "GET",
            signal: AbortSignal.timeout(3000),
        });
        const data = await res.json();
        const isOnline = data.status === "ok";
        tcSetOcrStatus(isOnline);

        if (isOnline) {
            chrome.storage.local.set({ tixcraft_ocrVerifiedAt: Date.now() }, () => {
                tcAddLog("✅ OCR Server 驗證成功，有效期限 1 小時", "success");
            });
        }
    } catch (_) {
        tcSetOcrStatus(false);
    }
}

function tcIsOcrVerificationValid() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["tixcraft_ocrVerifiedAt"], (result) => {
            if (!result.tixcraft_ocrVerifiedAt) { resolve(false); return; }
            const oneHour = 60 * 60 * 1000;
            resolve(Date.now() - result.tixcraft_ocrVerifiedAt < oneHour);
        });
    });
}

// ── Tixcraft 設定讀取 / 儲存 ──────────────────────────────────────

function tcLoadSettings() {
    chrome.storage.local.get(
        [
            "tixcraft_buyCount", "tixcraft_chooseDate", "tixcraft_chooseArea",
            "tixcraft_excludeArea", "tixcraft_ocrApiUrl", "tixcraft_areaFallback",
            "tixcraft_dateFallback", "tixcraft_reloadDelay", "tixcraft_targetUrl",
            "tixcraft_verifyCode",
        ],
        (result) => {
            tcBuyCountEl.value = result.tixcraft_buyCount ?? 2;
            tcChooseDateEl.value = result.tixcraft_chooseDate ?? "";
            tcChooseAreaEl.value = result.tixcraft_chooseArea ?? "";
            tcExcludeAreaEl.value = result.tixcraft_excludeArea ?? "輪椅,身障,身心障礙,Restricted View,燈柱遮蔽,視線不完整";
            tcSetOcrApiUrl(result.tixcraft_ocrApiUrl ?? "http://localhost:5511/ocr");
            tcAreaFallbackEl.value = result.tixcraft_areaFallback ?? "refresh";
            tcDateFallbackEl.value = result.tixcraft_dateFallback ?? "refresh";
            tcReloadDelayEl.value = result.tixcraft_reloadDelay ?? 1;
            tcTargetUrlEl.value = result.tixcraft_targetUrl ?? "";
            tcVerifyCodeEl.value = result.tixcraft_verifyCode ?? "";
        }
    );
}

function tcBuildSettings() {
    return {
        buyCount: parseInt(tcBuyCountEl.value, 10) || 2,
        chooseDate: tcChooseDateEl.value.trim(),
        chooseArea: tcChooseAreaEl.value.trim(),
        excludeArea: tcExcludeAreaEl.value.trim(),
        ocrApiUrl: tcGetOcrApiUrl(),
        areaFallback: tcAreaFallbackEl.value,
        dateFallback: tcDateFallbackEl.value,
        reloadDelay: parseFloat(tcReloadDelayEl.value) || 1,
        targetUrl: tcTargetUrlEl.value.trim(),
        verifyCode: tcVerifyCodeEl.value.trim(),
    };
}

// ── Tixcraft 與 Content Script 通訊 ──────────────────────────────

async function tcGetActiveTabId() {
    return popupGetActiveTabId(["https://tixcraft.com/*", "https://*.tixcraft.com/*"]);
}

async function tcSendToContent(action, data = {}) {
    const tabId = await tcGetActiveTabId();
    if (!tabId) {
        tcAddLog("❌ 找不到 Tixcraft 分頁，請確認已開啟 tixcraft.com", "error");
        return;
    }

    await popupInjectFiles(tabId, ["shared.js", "tixcraft/tixcraft-content.js"], (err) => {
        tcAddLog(`⚠️ 注入腳本失敗：${err.message}`, "warn");
    });

    await popupDelay(300);

    popupSendMessage(
        tabId,
        { action, ...data },
        (response) => {
            if (response?.log) {
                tcAddLog(response.log, response.type ?? "info");
            }
        },
        (runtimeError) => {
            tcAddLog(`⚠️ 通訊錯誤：${runtimeError.message}`, "warn");
            tcAddLog("請確認已在 Tixcraft 頁面，並重新整理後再試", "info");
        }
    );
}

// ── Tixcraft 按鈕事件 ─────────────────────────────────────────────

tcStartBtn.addEventListener("click", async () => {
    // 檢查 OCR 驗證是否有效
    const isValid = await tcIsOcrVerificationValid();
    if (!isValid) {
        tcAddLog("❌ OCR Server 驗證已過期或未驗證，請先點擊 🔄 重新驗證", "error");
        showToast("OCR 驗證已過期，請重新檢查", "error");
        return;
    }

    if (!tcOcrDot.className.includes("online")) {
        tcAddLog("❌ OCR Server 未連線，請先啟動 ocr_server.py", "error");
        showToast("OCR Server 未連線", "error");
        return;
    }

    const settings = tcBuildSettings();

    if (!settings.buyCount || settings.buyCount < 1) {
        tcAddLog("❌ 步驟 1：購買數量必須大於 0", "error");
        showToast("請填寫步驟 1：購買數量", "error");
        return;
    }

    const chooseDateArr = tcParseKeywords(settings.chooseDate);
    const chooseAreaArr = tcParseKeywords(settings.chooseArea);

    await popupStorageSet({
        tixcraft_buyCount: settings.buyCount,
        tixcraft_chooseDate: settings.chooseDate,
        tixcraft_chooseArea: settings.chooseArea,
        tixcraft_excludeArea: settings.excludeArea,
        tixcraft_ocrApiUrl: settings.ocrApiUrl,
        tixcraft_areaFallback: settings.areaFallback,
        tixcraft_dateFallback: settings.dateFallback,
        tixcraft_reloadDelay: settings.reloadDelay,
        tixcraft_targetUrl: settings.targetUrl,
        tixcraft_verifyCode: settings.verifyCode,
        tixcraft_isRunning: true,
        tixcraft_runningConfig: {
            buyCount: settings.buyCount,
            chooseDate: settings.chooseDate,
            chooseArea: settings.chooseArea,
            excludeArea: settings.excludeArea,
            ocrApiUrl: settings.ocrApiUrl,
            areaFallback: settings.areaFallback,
            dateFallback: settings.dateFallback,
            reloadDelay: settings.reloadDelay,
            targetUrl: settings.targetUrl,
            verifyCode: settings.verifyCode,
        },
    });

    tcSetStatus("running", "搶票執行中...");
    tcStartBtn.disabled = true;
    tcStopBtn.disabled = false;
    tcAddLog("🚀 開始 Tixcraft 搶票流程", "info");

    if (settings.targetUrl) tcAddLog(`目標網址：${settings.targetUrl}`, "info");
    if (chooseDateArr.length > 0) {
        const dateFallbackLabel = settings.dateFallback === "select_first"
            ? "選擇可訂購場次"
            : `重整（${settings.reloadDelay}秒）`;
        tcAddLog(`場次日期：${chooseDateArr.join(" / ")}（找不到時：${dateFallbackLabel}）`, "info");
    }
    if (chooseAreaArr.length > 0) {
        const fallbackLabel = settings.areaFallback === "select_first"
            ? "選擇可訂購區域"
            : `重整（${settings.reloadDelay}秒）`;
        tcAddLog(`區域關鍵字：${chooseAreaArr.join(" / ")}（找不到時：${fallbackLabel}）`, "info");
    }
    const excludeAreaArr = tcParseKeywords(settings.excludeArea);
    if (excludeAreaArr.length > 0) {
        tcAddLog(`排除關鍵字：${excludeAreaArr.join(" / ")}`, "info");
    }

    await tcSendToContent("START", {
        buyCount: settings.buyCount,
        chooseDate: chooseDateArr,
        chooseArea: chooseAreaArr,
        excludeArea: settings.excludeArea,
        ocrApiUrl: settings.ocrApiUrl,
        areaFallback: settings.areaFallback,
        dateFallback: settings.dateFallback,
        reloadDelay: settings.reloadDelay,
        targetUrl: settings.targetUrl,
        verifyCode: settings.verifyCode,
    });
});

tcStopBtn.addEventListener("click", async () => {
    await popupSetRunningState("tixcraft", false);
    tcSetStatus("idle", "已停止");
    tcStartBtn.disabled = false;
    tcStopBtn.disabled = true;
    tcAddLog("⏹ 使用者手動停止", "warn");
    await tcSendToContent("STOP");
});

tcSaveBtn.addEventListener("click", () => {
    const settings = tcBuildSettings();
    chrome.storage.local.set(
        {
            tixcraft_buyCount: settings.buyCount,
            tixcraft_chooseDate: settings.chooseDate,
            tixcraft_chooseArea: settings.chooseArea,
            tixcraft_excludeArea: settings.excludeArea,
            tixcraft_ocrApiUrl: settings.ocrApiUrl,
            tixcraft_targetUrl: settings.targetUrl,
            tixcraft_verifyCode: settings.verifyCode,
        },
        () => {
            showToast("Tixcraft 基礎設定已儲存", "success");
            tcAddLog("✅ Tixcraft 基礎設定已儲存", "success");
        }
    );
});

tcSaveBtnLogic.addEventListener("click", () => {
    const settings = tcBuildSettings();
    chrome.storage.local.set(
        {
            tixcraft_areaFallback: settings.areaFallback,
            tixcraft_dateFallback: settings.dateFallback,
            tixcraft_reloadDelay: settings.reloadDelay,
        },
        () => {
            showToast("Tixcraft 執行邏輯已儲存", "success");
            tcAddLog("✅ Tixcraft 執行邏輯已儲存", "success");
        }
    );
});

tcClearLogBtn.addEventListener("click", () => {
    tcLogArea.innerHTML = "";
    chrome.storage.local.remove("tixcraft_savedLogs");
});

tcCheckOcrBtn.addEventListener("click", () => {
    tcOcrLabel.textContent = "OCR Server：檢查中...";
    tcOcrLabel.style.color = "#aaa";
    tcOcrDot.className = "ocr-dot";
    tcCheckOcrServer();
});

// ── Tixcraft 初始化 ────────────────────────────────────────────────

async function tcInit() {
    tcLoadSettings();

    chrome.storage.local.get(
        ["tixcraft_isRunning", "tixcraft_savedLogs", "tixcraft_ocrVerifiedAt", "globalEnabled"],
        async (result) => {
            // 還原歷史日誌
            (result.tixcraft_savedLogs ?? []).forEach(({ time, message, type }) => {
                tcRenderLogEntry(time, message, type);
            });

            // 恢復 OCR 驗證狀態
            if (result.tixcraft_ocrVerifiedAt) {
                const timeLeft = 60 * 60 * 1000 - (Date.now() - result.tixcraft_ocrVerifiedAt);
                if (timeLeft > 0) {
                    await tcSetOcrStatus(true);
                } else {
                    tcSetOcrStatus(false);
                }
            } else {
                await tcCheckOcrServer();
            }

            // 恢復執行狀態
            const globalEnabled = result.globalEnabled !== false; // 預設為 true

            if (result.tixcraft_isRunning) {
                tcSetStatus("running", "搶票執行中...");
                tcStartBtn.disabled = true;
                tcStopBtn.disabled = false;
                tcAddLog("偵測到 Tixcraft 搶票流程仍在執行中", "warn");
            } else if (globalEnabled) {
                tcAddLog("Tixcraft 助手已載入，請設定場次日期與區域關鍵字後開始搶票", "info");
            } else {
                tcAddLog("⚠️ 腳本注入已停用，請開啟「啟用腳本注入」開關", "warn");
            }
        }
    );
}

// ════════════════════════════════════════════════════════════════
//  監聽來自 Content Script 的主動訊息
// ════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
    // ── KKTIX 訊息 ────────────────────────────────────────────
    if (msg.from === "kktix-content") {
        switch (msg.event) {
            case "LOG":
                kktixAddLog(msg.text, msg.type ?? "info");
                break;
            case "DONE":
                chrome.storage.local.set({ kktix_isRunning: false });
                kktixSetStatus("idle", "流程完成");
                kktixStartBtn.disabled = false;
                kktixStopBtn.disabled = true;
                kktixAddLog("🎉 KKTIX 所有步驟完成！", "success");
                break;
            case "RELOAD":
                kktixAddLog("🔄 KKTIX 頁面重新整理中...", "warn");
                break;
            case "ERROR":
                kktixSetStatus("error", "發生錯誤");
                kktixAddLog(`❌ ${msg.text}`, "error");
                break;
        }
        return;
    }

    // ── Tixcraft 訊息 ─────────────────────────────────────────
    if (msg.from === "tixcraft-content") {
        switch (msg.event) {
            case "LOG":
                tcAddLog(msg.text, msg.type ?? "info");
                break;
            case "DONE":
                chrome.storage.local.set({ tixcraft_isRunning: false });
                tcSetStatus("idle", "流程完成");
                tcStartBtn.disabled = false;
                tcStopBtn.disabled = true;
                tcAddLog("🎉 Tixcraft 所有步驟完成！", "success");
                break;
            case "RELOAD":
                // 頁面重整：清除舊日誌
                chrome.storage.local.remove("tixcraft_savedLogs");
                tcAddLog("🔄 Tixcraft 頁面重新整理中...", "warn");
                break;
            case "ERROR":
                tcSetStatus("error", "發生錯誤");
                tcAddLog(`❌ ${msg.text}`, "error");
                break;
        }
    }
});

// ── 啟動初始化 ────────────────────────────────────────────────────
kktixInit();
tcInit();

// ════════════════════════════════════════════════════════════════
//  Inline 邏輯（自動填到最後確認訂位前，不自動送出）
// ════════════════════════════════════════════════════════════════

document.querySelectorAll("#panel-inline .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tabId = btn.dataset.tab;
        document.querySelectorAll("#panel-inline .tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll("#panel-inline .tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(tabId).classList.add("active");
    });
});

const inTargetUrlEl = document.getElementById("inline-targetUrl");
const inAdultCountEl = document.getElementById("inline-adultCount");
const inKidCountEl = document.getElementById("inline-kidCount");
const inPriorityPlanEl = document.getElementById("inline-priorityPlan");
const inExactDateEl = document.getElementById("inline-exactDate");
const inExactTimeEl = document.getElementById("inline-exactTime");
const inAddExactBtn = document.getElementById("inline-addExactBtn");
const inExactListEl = document.getElementById("inline-exactList");
const inRangeDateEl = document.getElementById("inline-rangeDate");
const inRangeStartEl = document.getElementById("inline-rangeStart");
const inRangeEndEl = document.getElementById("inline-rangeEnd");
const inAddRangeBtn = document.getElementById("inline-addRangeBtn");
const inRangeListEl = document.getElementById("inline-rangeList");
const inAnyDateEl = document.getElementById("inline-anyDate");
const inAddAnyBtn = document.getElementById("inline-addAnyBtn");
const inAnyListEl = document.getElementById("inline-anyList");
const inReloadOnNoTimeEl = document.getElementById("inline-reloadOnNoTime");
const inReloadDelayEl = document.getElementById("inline-reloadDelay");
const inNameEl = document.getElementById("inline-name");
const inGenderEl = document.getElementById("inline-gender");
const inPhoneEl = document.getElementById("inline-phone");
const inEmailEl = document.getElementById("inline-email");
const inPurposeEl = document.getElementById("inline-purpose");
const inNoteEl = document.getElementById("inline-note");
const inAutoAgreeEl = document.getElementById("inline-autoAgree");
const inStartBtn = document.getElementById("inline-startBtn");
const inStopBtn = document.getElementById("inline-stopBtn");
const inSaveBtn = document.getElementById("inline-saveBtn");
const inSaveContactBtn = document.getElementById("inline-saveContactBtn");
const inClearLogBtn = document.getElementById("inline-clearLogBtn");
const inLogArea = document.getElementById("inline-logArea");
const inStatusDot = document.getElementById("inline-statusDot");
const inStatusText = document.getElementById("inline-statusText");

const INLINE_MAX_LOG_ENTRIES = 300;

let inPriorityPlanState = { exact: [], range: [], any: [] };

function inPopulateTimeSelects() {
    const targets = [inExactTimeEl, inRangeStartEl, inRangeEndEl].filter(Boolean);
    targets.forEach(select => {
        const current = select.value;
        select.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "請選擇時間";
        select.appendChild(placeholder);
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 60; m += 10) {
                const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
                const opt = document.createElement("option");
                opt.value = value;
                opt.textContent = value;
                select.appendChild(opt);
            }
        }
        if (current) select.value = current;
    });
}

function inDateLabel(isoDate) {
    if (!isoDate) return "";
    const [y, m, d] = isoDate.split("-").map(Number);
    if (!y || !m || !d) return isoDate;
    const w = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
    return `${m}月${d}日週${w}`;
}

function inNormalizeTime(t) {
    if (!t) return "";
    const [h, m] = String(t).split(":");
    return `${String(Number(h)).padStart(2, "0")}:${String(Number(m || 0)).padStart(2, "0")}`;
}

function inSyncPriorityPlanInput() {
    if (inPriorityPlanEl) inPriorityPlanEl.value = JSON.stringify(inPriorityPlanState);
}

function inRenderPriorityPlan() {
    const render = (root, rows, formatter, bucket) => {
        if (!root) return;
        root.innerHTML = "";
        if (!rows.length) {
            const empty = document.createElement("div");
            empty.className = "log-entry info";
            empty.textContent = "尚未設定";
            root.appendChild(empty);
            return;
        }
        rows.forEach((row, idx) => {
            const div = document.createElement("div");
            div.className = "inline-priority-row";
            const span = document.createElement("span");
            span.textContent = `${idx + 1}. ${formatter(row)}`;
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "刪除";
            del.addEventListener("click", () => {
                inPriorityPlanState[bucket].splice(idx, 1);
                inSyncPriorityPlanInput();
                inRenderPriorityPlan();
            });
            div.appendChild(span);
            div.appendChild(del);
            root.appendChild(div);
        });
    };
    render(inExactListEl, inPriorityPlanState.exact, r => `${r.dateText} ${r.time}`, "exact");
    render(inRangeListEl, inPriorityPlanState.range, r => `${r.dateText} ${r.start}-${r.end}`, "range");
    render(inAnyListEl, inPriorityPlanState.any, r => `${r.dateText} 全部可訂時間`, "any");
    inSyncPriorityPlanInput();
}

function inLoadPriorityPlan(raw) {
    try {
        const parsed = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : raw;
        inPriorityPlanState = {
            exact: Array.isArray(parsed?.exact) ? parsed.exact : [],
            range: Array.isArray(parsed?.range) ? parsed.range : [],
            any: Array.isArray(parsed?.any) ? parsed.any : [],
        };
    } catch (_) {
        inPriorityPlanState = { exact: [], range: [], any: [] };
    }
    inRenderPriorityPlan();
}

function inPriorityPlanHasRows(plan = inPriorityPlanState) {
    return !!(plan?.exact?.length || plan?.range?.length || plan?.any?.length);
}


function inRenderLogEntry(time, message, type) {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${time}] ${message}`;
    inLogArea.appendChild(entry);
    inLogArea.scrollTop = inLogArea.scrollHeight;
}

function inAddLog(message, type = "info") {
    const now = new Date().toLocaleTimeString("zh-TW");
    inRenderLogEntry(now, message, type);
    chrome.storage.local.get(["inline_savedLogs"], (result) => {
        const logs = result.inline_savedLogs ?? [];
        logs.push({ time: now, message, type });
        if (logs.length > INLINE_MAX_LOG_ENTRIES) logs.splice(0, logs.length - INLINE_MAX_LOG_ENTRIES);
        chrome.storage.local.set({ inline_savedLogs: logs });
    });
}

function inSetStatus(state, text) {
    inStatusDot.className = `status-dot ${state}`;
    inStatusText.textContent = text;
}

function inParseKeywords(raw) {
    return String(raw || "").split(",").map(s => s.trim()).filter(Boolean);
}

function inBuildSettings() {
    return {
        targetUrl: inTargetUrlEl.value.trim(),
        adultCount: parseInt(inAdultCountEl.value, 10) || 1,
        kidCount: inKidCountEl.value.trim(),
        priorityPlan: JSON.parse(JSON.stringify(inPriorityPlanState)),
        reloadOnNoTime: inReloadOnNoTimeEl.value === "true",
        reloadDelay: parseFloat(inReloadDelayEl.value) || 2,
        name: inNameEl.value.trim(),
        gender: inGenderEl.value,
        phone: inPhoneEl.value.trim(),
        email: inEmailEl.value.trim(),
        purpose: inPurposeEl.value.trim(),
        purposes: inParseKeywords(inPurposeEl.value),
        note: inNoteEl.value.trim(),
        autoAgree: inAutoAgreeEl.value === "true",
    };
}

function inLoadSettings() {
    chrome.storage.local.get([
        "inline_targetUrl", "inline_adultCount", "inline_kidCount", "inline_priorityPlan",
        "inline_reloadOnNoTime", "inline_reloadDelay", "inline_name", "inline_gender", "inline_phone",
        "inline_email", "inline_purpose", "inline_note", "inline_autoAgree", "inline_isRunning", "inline_savedLogs", "globalEnabled"
    ], (r) => {
        inTargetUrlEl.value = r.inline_targetUrl ?? "";
        inAdultCountEl.value = r.inline_adultCount ?? 2;
        inKidCountEl.value = r.inline_kidCount ?? "";
        inLoadPriorityPlan(r.inline_priorityPlan ?? "");
        inReloadOnNoTimeEl.value = String(r.inline_reloadOnNoTime ?? true);
        inReloadDelayEl.value = r.inline_reloadDelay ?? 1;
        inNameEl.value = r.inline_name ?? "";
        inGenderEl.value = r.inline_gender ?? "先生";
        inPhoneEl.value = r.inline_phone ?? "";
        inEmailEl.value = r.inline_email ?? "";
        inPurposeEl.value = r.inline_purpose ?? "";
        inNoteEl.value = r.inline_note ?? "";
        inAutoAgreeEl.value = String(r.inline_autoAgree ?? true);

        (r.inline_savedLogs ?? []).forEach(({ time, message, type }) => inRenderLogEntry(time, message, type));

        const globalEnabled = r.globalEnabled !== false; // 預設為 true

        if (r.inline_isRunning) {
            inSetStatus("running", "Inline 流程執行中...");
            inStartBtn.disabled = true;
            inStopBtn.disabled = false;
            inAddLog("偵測到 Inline 流程仍在執行中", "warn");
        } else if (globalEnabled) {
            inAddLog("Inline 助手已載入", "info");
        } else {
            inAddLog("⚠️ 腳本注入已停用，請開啟「啟用腳本注入」開關", "warn");
        }
    });
}

async function inGetActiveTabId(targetUrl = "") {
    return popupGetActiveTabId(["https://inline.app/*", "https://*.inline.app/*"]);
}

async function inSendToContent(action, data = {}) {
    let tabId = await popupEnsureTabId({
        urlPatterns: ["https://inline.app/*", "https://*.inline.app/*"],
        createUrl: data.targetUrl || "",
        createDelayMs: 1200,
    });

    if (!tabId) {
        inAddLog("❌ 找不到 Inline 分頁，請先開啟 inline.app 訂位頁", "error");
        return;
    }

    await popupInjectFiles(tabId, ["inline/inline-content.js"], (err) => {
        inAddLog(`⚠️ 注入 Inline 腳本失敗：${err.message}`, "warn");
    });

    await popupDelay(300);

    popupSendMessage(
        tabId,
        { action, ...data },
        (response) => {
            if (response?.log) inAddLog(response.log, response.type ?? "info");
        },
        (runtimeError) => {
            inAddLog(`⚠️ Inline 通訊錯誤：${runtimeError.message}`, "warn");
            inAddLog("請確認已在 Inline 訂位頁，並重新整理後再試", "info");
        }
    );
}

function inSaveSettings(show = true) {
    const s = inBuildSettings();
    chrome.storage.local.set({
        inline_targetUrl: s.targetUrl,
        inline_adultCount: s.adultCount,
        inline_kidCount: s.kidCount,
        inline_priorityPlan: JSON.stringify(s.priorityPlan),
        inline_reloadOnNoTime: s.reloadOnNoTime,
        inline_reloadDelay: s.reloadDelay,
        inline_name: s.name,
        inline_gender: s.gender,
        inline_phone: s.phone,
        inline_email: s.email,
        inline_purpose: s.purpose,
        inline_note: s.note,
        inline_autoAgree: s.autoAgree,
    }, () => {
        if (show) {
            showToast("Inline 設定已儲存", "success");
            inAddLog("✅ Inline 設定已儲存", "success");
        }
    });
}


inAddExactBtn?.addEventListener("click", () => {
    const date = inExactDateEl.value;
    const time = inNormalizeTime(inExactTimeEl.value);
    if (!date || !time) { inAddLog("❌ 第一順位請選日期與時間", "error"); return; }
    inPriorityPlanState.exact.push({ date, dateText: inDateLabel(date), time });
    inRenderPriorityPlan();
});

inAddRangeBtn?.addEventListener("click", () => {
    const date = inRangeDateEl.value;
    const start = inNormalizeTime(inRangeStartEl.value);
    const end = inNormalizeTime(inRangeEndEl.value);
    if (!date || !start || !end) { inAddLog("❌ 第二順位請選日期、開始時間與結束時間", "error"); return; }
    if (start > end) { inAddLog("❌ 第二順位開始時間不可晚於結束時間", "error"); return; }
    inPriorityPlanState.range.push({ date, dateText: inDateLabel(date), start, end });
    inRenderPriorityPlan();
});

inAddAnyBtn?.addEventListener("click", () => {
    const date = inAnyDateEl.value;
    if (!date) { inAddLog("❌ 第三順位請選日期", "error"); return; }
    inPriorityPlanState.any.push({ date, dateText: inDateLabel(date) });
    inRenderPriorityPlan();
});

inSaveBtn.addEventListener("click", () => inSaveSettings(true));
inSaveContactBtn.addEventListener("click", () => inSaveSettings(true));

inStartBtn.addEventListener("click", async () => {
    const s = inBuildSettings();
    if (!s.targetUrl && !(await inGetActiveTabId())) {
        inAddLog("❌ 請填 Inline 訂位網址，或先開啟 Inline 分頁", "error");
        showToast("請填 Inline 訂位網址", "error");
        return;
    }
    if (!s.adultCount || s.adultCount < 1) {
        inAddLog("❌ 大人人數必須大於 0", "error");
        return;
    }
    if (!inPriorityPlanHasRows(s.priorityPlan)) {
        inAddLog("❌ 請至少設定一筆三段式順位", "error");
        return;
    }
    if (!s.name || !s.phone) {
        inAddLog("❌ 請填訂位人姓名與手機號碼", "error");
        showToast("請填姓名與手機", "error");
        return;
    }

    inSaveSettings(false);
    // 不在注入前預先寫入 inline_isRunning，避免 content script auto-resume 與手動 START 同時啟動。
    // START 送達 content script 後，content script 會自行寫入 inline_isRunning / inline_runningConfig。
    chrome.storage.local.remove(["inline_successReloadCount"]);

    inSetStatus("running", "Inline 流程執行中...");
    inStartBtn.disabled = true;
    inStopBtn.disabled = false;
    await inSendToContent("START", s);
});

inStopBtn.addEventListener("click", async () => {
    await popupSetRunningState("inline", false);
    inSetStatus("idle", "已停止");
    inStartBtn.disabled = false;
    inStopBtn.disabled = true;
    inAddLog("⏹ 使用者手動停止 Inline", "warn");
    await inSendToContent("STOP");
});

inClearLogBtn.addEventListener("click", () => {
    inLogArea.innerHTML = "";
    chrome.storage.local.remove("inline_savedLogs");
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.from !== "inline-content") return;
    switch (msg.event) {
        case "LOG":
            inAddLog(msg.text, msg.type ?? "info");
            break;
        case "DONE":
            chrome.storage.local.set({ inline_isRunning: false });
            inSetStatus("idle", "訂位完成");
            inStartBtn.disabled = false;
            inStopBtn.disabled = true;
            inAddLog("Inline 訂位完成", "success");
            showToast("Inline 訂位完成", "success", 4000);
            break;
        case "RELOAD":
            inAddLog("🔄 Inline 頁面重新整理中...", "warn");
            break;
        case "ERROR":
            inSetStatus("error", "Inline 發生錯誤");
            inAddLog(`❌ ${msg.text}`, "error");
            break;
    }
});

inPopulateTimeSelects();
inLoadSettings();
