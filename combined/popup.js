// ============================================================
//  popup.js — 搶票助手 Pro 彈出視窗邏輯（整合版）
//  包含 KKTIX 和 Tixcraft 兩個平台的控制邏輯
// ============================================================

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
const kktixBuyCountEl       = document.getElementById("kktix-buyCount");
const kktixChooseAreaEl     = document.getElementById("kktix-chooseArea");
const kktixMemberCodeEl     = document.getElementById("kktix-memberCode");
const kktixQuestionEl       = document.getElementById("kktix-question");
const kktixTicketFallbackEl = document.getElementById("kktix-ticketFallback");
const kktixReloadDelayEl    = document.getElementById("kktix-reloadDelay");
const kktixStartBtn         = document.getElementById("kktix-startBtn");
const kktixStopBtn          = document.getElementById("kktix-stopBtn");
const kktixSaveBtn          = document.getElementById("kktix-saveBtn");
const kktixSaveBtnLogic     = document.getElementById("kktix-saveBtnLogic");
const kktixLogArea          = document.getElementById("kktix-logArea");
const kktixStatusDot        = document.getElementById("kktix-statusDot");
const kktixStatusText       = document.getElementById("kktix-statusText");
const kktixClearLogBtn      = document.getElementById("kktix-clearLogBtn");

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
            kktixBuyCountEl.value   = result.kktix_buyCount ?? 2;
            kktixMemberCodeEl.value = result.kktix_memberCode ?? "";
            kktixQuestionEl.value   = result.kktix_question ?? "";
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
        buyCount:       parseInt(kktixBuyCountEl.value, 10) || 2,
        chooseArea,
        memberCode:     kktixMemberCodeEl.value.trim(),
        question:       kktixQuestionEl.value.trim(),
        ticketFallback: kktixTicketFallbackEl.value,
        reloadDelay:    parseFloat(kktixReloadDelayEl.value) || 1,
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
        await chrome.scripting.executeScript({ target: { tabId }, files: ["kktix-content.js"] });
    } catch (_) { }

    chrome.tabs.sendMessage(tabId, { action: "GET_TICKETS" }, (response) => {
        if (chrome.runtime.lastError) {
            kktixAddLog(`⚠️ 抓取票種失敗：${chrome.runtime.lastError.message}`, "warn");
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
    return new Promise((resolve) => {
        // 查詢所有視窗中符合 kktix.com 的分頁
        chrome.tabs.query({ url: ["https://kktix.com/*", "https://*.kktix.com/*"] }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const activeTab = tabs.find(t => t.active) ?? tabs[tabs.length - 1];
                resolve(activeTab.id);
            } else {
                resolve(null);
            }
        });
    });
}

async function kktixSendToContent(action, data = {}) {
    const tabId = await kktixGetActiveTabId();
    if (!tabId) {
        kktixAddLog("❌ 找不到 KKTIX 分頁，請確認已開啟 kktix.com", "error");
        return;
    }

    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["kktix-content.js"] });
    } catch (_) { }

    chrome.tabs.sendMessage(tabId, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
            kktixAddLog(`⚠️ 通訊錯誤：${chrome.runtime.lastError.message}`, "warn");
            return;
        }
        if (response?.log) {
            kktixAddLog(response.log, response.type ?? "info");
        }
    });
}

// ── KKTIX 按鈕事件 ────────────────────────────────────────────────

kktixStartBtn.addEventListener("click", async () => {
    const settings = kktixBuildSettings();

    if (!settings.buyCount || settings.buyCount < 1) {
        kktixAddLog("❌ 購買數量必須大於 0", "error");
        return;
    }

    if (!settings.chooseArea || settings.chooseArea.length === 0) {
        kktixAddLog("❌ 請至少輸入或勾選一個票種", "error");
        return;
    }

    // 儲存勾選狀態供重開 popup 時恢復
    const checkedPrices = kktixGetCheckedPrices();
    if (checkedPrices) {
        chrome.storage.local.set({ kktix_chooseArea: checkedPrices });
    }

    chrome.storage.local.set({
        kktix_buyCount:   settings.buyCount,
        kktix_memberCode: settings.memberCode,
        kktix_question:   settings.question,
        kktix_ticketFallback: settings.ticketFallback,
        kktix_reloadDelay:    settings.reloadDelay,
        kktix_isRunning:  true,
        kktix_runningConfig: {
            buyCount:       settings.buyCount,
            chooseArea:     settings.chooseArea,
            memberCode:     settings.memberCode,
            question:       settings.question,
            ticketFallback: settings.ticketFallback,
            reloadDelay:    settings.reloadDelay,
        },
    });

    kktixSetStatus("running", "搶票執行中...");
    kktixStartBtn.disabled = true;
    kktixStopBtn.disabled  = false;
    kktixAddLog("🚀 開始 KKTIX 搶票流程", "info");

    await kktixSendToContent("START", {
        buyCount:       settings.buyCount,
        chooseArea:     settings.chooseArea,
        memberCode:     settings.memberCode,
        question:       settings.question,
        ticketFallback: settings.ticketFallback,
        reloadDelay:    settings.reloadDelay,
    });
});

kktixStopBtn.addEventListener("click", async () => {
    chrome.storage.local.set({ kktix_isRunning: false });
    kktixSetStatus("idle", "已停止");
    kktixStartBtn.disabled = false;
    kktixStopBtn.disabled  = true;
    kktixAddLog("⏹ 使用者手動停止", "warn");
    await kktixSendToContent("STOP");
});

kktixSaveBtn.addEventListener("click", () => {
    const settings = kktixBuildSettings();
    chrome.storage.local.set(
        {
            kktix_buyCount:   settings.buyCount,
            kktix_chooseArea: settings.chooseArea,
            kktix_memberCode: settings.memberCode,
            kktix_question:   settings.question,
        },
        () => kktixAddLog("✅ KKTIX 基礎設定已儲存", "success")
    );
});

kktixSaveBtnLogic.addEventListener("click", () => {
    const settings = kktixBuildSettings();
    chrome.storage.local.set(
        {
            kktix_ticketFallback: settings.ticketFallback,
            kktix_reloadDelay:    settings.reloadDelay,
        },
        () => kktixAddLog("✅ KKTIX 執行邏輯已儲存", "success")
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

    chrome.storage.local.get(["kktix_isRunning"], (result) => {
        if (result.kktix_isRunning) {
            kktixSetStatus("running", "搶票執行中...");
            kktixStartBtn.disabled = true;
            kktixStopBtn.disabled  = false;
            kktixAddLog("偵測到 KKTIX 搶票流程仍在執行中", "warn");
        } else {
            kktixAddLog("KKTIX 助手已載入，請抓取票種後開始搶票", "info");
        }

        // 自動抓取票種
        kktixFetchTickets();
    });
}

// ════════════════════════════════════════════════════════════════
//  Tixcraft 邏輯
// ════════════════════════════════════════════════════════════════

// ── Tixcraft DOM 元素引用 ─────────────────────────────────────────
const tcBuyCountEl          = document.getElementById("tixcraft-buyCount");
const tcChooseDateEl        = document.getElementById("tixcraft-chooseDate");
const tcChooseAreaEl        = document.getElementById("tixcraft-chooseArea");
const tcOcrApiUrlSelectEl   = document.getElementById("tixcraft-ocrApiUrlSelect");
const tcOcrApiUrlCustomEl   = document.getElementById("tixcraft-ocrApiUrlCustom");
const tcAreaFallbackEl      = document.getElementById("tixcraft-areaFallback");
const tcDateFallbackEl      = document.getElementById("tixcraft-dateFallback");
const tcReloadDelayEl       = document.getElementById("tixcraft-reloadDelay");
const tcTargetUrlEl         = document.getElementById("tixcraft-targetUrl");
const tcVerifyCodeEl        = document.getElementById("tixcraft-verifyCode");
const tcStartBtn            = document.getElementById("tixcraft-startBtn");
const tcStopBtn             = document.getElementById("tixcraft-stopBtn");
const tcSaveBtn             = document.getElementById("tixcraft-saveBtn");
const tcSaveBtnLogic        = document.getElementById("tixcraft-saveBtnLogic");
const tcLogArea             = document.getElementById("tixcraft-logArea");
const tcStatusDot           = document.getElementById("tixcraft-statusDot");
const tcStatusText          = document.getElementById("tixcraft-statusText");
const tcOcrDot              = document.getElementById("tixcraft-ocrDot");
const tcOcrLabel            = document.getElementById("tixcraft-ocrLabel");
const tcCheckOcrBtn         = document.getElementById("tixcraft-checkOcrBtn");
const tcClearLogBtn         = document.getElementById("tixcraft-clearLogBtn");

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
    const apiUrl = tcGetOcrApiUrl();
    const healthUrl = apiUrl.replace(/\/ocr$/, "/health");

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
            "tixcraft_ocrApiUrl", "tixcraft_areaFallback", "tixcraft_dateFallback",
            "tixcraft_reloadDelay", "tixcraft_targetUrl", "tixcraft_verifyCode",
        ],
        (result) => {
            tcBuyCountEl.value    = result.tixcraft_buyCount ?? 2;
            tcChooseDateEl.value  = result.tixcraft_chooseDate ?? "";
            tcChooseAreaEl.value  = result.tixcraft_chooseArea ?? "";
            tcSetOcrApiUrl(result.tixcraft_ocrApiUrl ?? "http://localhost:5511/ocr");
            tcAreaFallbackEl.value  = result.tixcraft_areaFallback ?? "refresh";
            tcDateFallbackEl.value  = result.tixcraft_dateFallback ?? "refresh";
            tcReloadDelayEl.value   = result.tixcraft_reloadDelay ?? 1;
            tcTargetUrlEl.value     = result.tixcraft_targetUrl ?? "";
            tcVerifyCodeEl.value    = result.tixcraft_verifyCode ?? "";
        }
    );
}

function tcBuildSettings() {
    return {
        buyCount:     parseInt(tcBuyCountEl.value, 10) || 2,
        chooseDate:   tcChooseDateEl.value.trim(),
        chooseArea:   tcChooseAreaEl.value.trim(),
        ocrApiUrl:    tcGetOcrApiUrl(),
        areaFallback: tcAreaFallbackEl.value,
        dateFallback: tcDateFallbackEl.value,
        reloadDelay:  parseFloat(tcReloadDelayEl.value) || 1,
        targetUrl:    tcTargetUrlEl.value.trim(),
        verifyCode:   tcVerifyCodeEl.value.trim(),
    };
}

// ── Tixcraft 與 Content Script 通訊 ──────────────────────────────

async function tcGetActiveTabId() {
    return new Promise((resolve) => {
        // 查詢所有視窗中符合 tixcraft.com 的分頁
        chrome.tabs.query({ url: ["https://tixcraft.com/*", "https://*.tixcraft.com/*"] }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const activeTab = tabs.find(t => t.active) ?? tabs[tabs.length - 1];
                resolve(activeTab.id);
            } else {
                resolve(null);
            }
        });
    });
}

async function tcSendToContent(action, data = {}) {
    const tabId = await tcGetActiveTabId();
    if (!tabId) {
        tcAddLog("❌ 找不到 Tixcraft 分頁，請確認已開啟 tixcraft.com", "error");
        return;
    }

    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["tixcraft-content.js"] });
    } catch (_) { }

    // 等待注入腳本初始化
    await new Promise(resolve => setTimeout(resolve, 300));

    chrome.tabs.sendMessage(tabId, { action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
            tcAddLog(`⚠️ 通訊錯誤：${chrome.runtime.lastError.message}`, "warn");
            return;
        }
        if (response?.log) {
            tcAddLog(response.log, response.type ?? "info");
        }
    });
}

// ── Tixcraft 按鈕事件 ─────────────────────────────────────────────

tcStartBtn.addEventListener("click", async () => {
    // 檢查 OCR 驗證是否有效
    const isValid = await tcIsOcrVerificationValid();
    if (!isValid) {
        tcAddLog("❌ OCR Server 驗證已過期或未驗證，請先點擊 🔄 重新驗證", "error");
        return;
    }

    if (!tcOcrDot.className.includes("online")) {
        tcAddLog("❌ 請先確保 OCR Server 已啟動並連線成功", "error");
        return;
    }

    const settings = tcBuildSettings();

    if (!settings.buyCount || settings.buyCount < 1) {
        tcAddLog("❌ 購買數量必須大於 0", "error");
        return;
    }

    const chooseDateArr = tcParseKeywords(settings.chooseDate);
    const chooseAreaArr = tcParseKeywords(settings.chooseArea);

    chrome.storage.local.set({
        tixcraft_buyCount:    settings.buyCount,
        tixcraft_chooseDate:  settings.chooseDate,
        tixcraft_chooseArea:  settings.chooseArea,
        tixcraft_ocrApiUrl:   settings.ocrApiUrl,
        tixcraft_areaFallback: settings.areaFallback,
        tixcraft_dateFallback: settings.dateFallback,
        tixcraft_reloadDelay:  settings.reloadDelay,
        tixcraft_targetUrl:    settings.targetUrl,
        tixcraft_verifyCode:   settings.verifyCode,
        tixcraft_isRunning:   true,
        tixcraft_runningConfig: {
            buyCount:     settings.buyCount,
            chooseDate:   settings.chooseDate,
            chooseArea:   settings.chooseArea,
            ocrApiUrl:    settings.ocrApiUrl,
            areaFallback: settings.areaFallback,
            dateFallback: settings.dateFallback,
            reloadDelay:  settings.reloadDelay,
            targetUrl:    settings.targetUrl,
            verifyCode:   settings.verifyCode,
        },
    });

    tcSetStatus("running", "搶票執行中...");
    tcStartBtn.disabled = true;
    tcStopBtn.disabled  = false;
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

    await tcSendToContent("START", {
        buyCount:     settings.buyCount,
        chooseDate:   chooseDateArr,
        chooseArea:   chooseAreaArr,
        ocrApiUrl:    settings.ocrApiUrl,
        areaFallback: settings.areaFallback,
        dateFallback: settings.dateFallback,
        reloadDelay:  settings.reloadDelay,
        targetUrl:    settings.targetUrl,
        verifyCode:   settings.verifyCode,
    });
});

tcStopBtn.addEventListener("click", async () => {
    chrome.storage.local.set({ tixcraft_isRunning: false });
    tcSetStatus("idle", "已停止");
    tcStartBtn.disabled = false;
    tcStopBtn.disabled  = true;
    tcAddLog("⏹ 使用者手動停止", "warn");
    await tcSendToContent("STOP");
});

tcSaveBtn.addEventListener("click", () => {
    const settings = tcBuildSettings();
    chrome.storage.local.set(
        {
            tixcraft_buyCount:    settings.buyCount,
            tixcraft_chooseDate:  settings.chooseDate,
            tixcraft_chooseArea:  settings.chooseArea,
            tixcraft_ocrApiUrl:   settings.ocrApiUrl,
            tixcraft_targetUrl:   settings.targetUrl,
            tixcraft_verifyCode:  settings.verifyCode,
        },
        () => tcAddLog("✅ Tixcraft 基礎設定已儲存", "success")
    );
});

tcSaveBtnLogic.addEventListener("click", () => {
    const settings = tcBuildSettings();
    chrome.storage.local.set(
        {
            tixcraft_areaFallback: settings.areaFallback,
            tixcraft_dateFallback: settings.dateFallback,
            tixcraft_reloadDelay:  settings.reloadDelay,
        },
        () => tcAddLog("✅ Tixcraft 執行邏輯已儲存", "success")
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
        ["tixcraft_isRunning", "tixcraft_savedLogs", "tixcraft_ocrVerifiedAt"],
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
            if (result.tixcraft_isRunning) {
                tcSetStatus("running", "搶票執行中...");
                tcStartBtn.disabled = true;
                tcStopBtn.disabled  = false;
                tcAddLog("偵測到 Tixcraft 搶票流程仍在執行中", "warn");
            } else {
                tcAddLog("Tixcraft 助手已載入，請設定場次日期與區域關鍵字後開始搶票", "info");
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
                kktixStopBtn.disabled  = true;
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
                tcStopBtn.disabled  = true;
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
