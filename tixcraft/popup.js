// ============================================================
//  popup.js — Tixcraft 搶票助手 彈出視窗邏輯
// ============================================================

// DOM 元素參考
const buyCountEl    = document.getElementById("buyCount");
const chooseDateEl  = document.getElementById("chooseDate");
const chooseAreaEl  = document.getElementById("chooseArea");
const ocrApiUrlEl   = document.getElementById("ocrApiUrl");
const startBtn      = document.getElementById("startBtn");
const stopBtn       = document.getElementById("stopBtn");
const saveBtn       = document.getElementById("saveBtn");
const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");
const logArea       = document.getElementById("logArea");
const ocrDot        = document.getElementById("ocrDot");
const ocrLabel      = document.getElementById("ocrLabel");
const checkOcrBtn   = document.getElementById("checkOcrBtn");

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

// 更新主狀態列
function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
}

// 更新 OCR Server 狀態顯示
function setOcrStatus(online) {
    if (online) {
        ocrDot.className = "ocr-dot online";
        ocrLabel.textContent = "OCR Server：✅ 已連線";
        ocrLabel.style.color = "#4caf50";
    } else {
        ocrDot.className = "ocr-dot offline";
        ocrLabel.textContent = "OCR Server：❌ 未連線（請啟動 python ocr_server.py）";
        ocrLabel.style.color = "#ef5350";
    }
}

// ── OCR Server 健康檢查 ───────────────────────────────────────

async function checkOcrServer() {
    const apiUrl = ocrApiUrlEl.value.trim() || "http://localhost:5000/ocr";
    // 將 /ocr 替換為 /health 進行健康檢查
    const healthUrl = apiUrl.replace(/\/ocr$/, "/health");

    try {
        const res = await fetch(healthUrl, {
            method: "GET",
            signal: AbortSignal.timeout(3000), // 3 秒逾時
        });
        const data = await res.json();
        setOcrStatus(data.status === "ok");
    } catch (_) {
        setOcrStatus(false);
    }
}

// ── 工具函式：解析關鍵字字串為陣列 ──────────────────────────
// 以半形逗號分隔，去除多餘空白，過濾空字串
function parseKeywords(raw) {
    return raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
}

// ── 設定讀取 / 儲存 ─────────────────────────────────────────

// 從 chrome.storage 讀取設定並填入欄位
function loadSettings() {
    chrome.storage.local.get(
        ["buyCount", "chooseDate", "chooseArea", "ocrApiUrl"],
        (result) => {
            buyCountEl.value   = result.buyCount   ?? 2;
            chooseDateEl.value = result.chooseDate ?? "";
            chooseAreaEl.value = result.chooseArea ?? "";
            ocrApiUrlEl.value  = result.ocrApiUrl  ?? "http://localhost:5000/ocr";
        }
    );
}

// 組建設定物件
function buildSettings() {
    return {
        buyCount:    parseInt(buyCountEl.value, 10) || 2,
        chooseDate:  chooseDateEl.value.trim(),
        chooseArea:  chooseAreaEl.value.trim(),
        ocrApiUrl:   ocrApiUrlEl.value.trim() || "http://localhost:5000/ocr",
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

    // 先注入 content.js（如果尚未注入）
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (_) {}

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

    if (!settings.buyCount || settings.buyCount < 1) {
        addLog("❌ 購買數量必須大於 0", "error");
        return;
    }

    // 將字串解析為陣列（場次日期和區域關鍵字都允許多個）
    const chooseDateArr = parseKeywords(settings.chooseDate);
    const chooseAreaArr = parseKeywords(settings.chooseArea);

    chrome.storage.local.set({
        ...settings,
        isRunning: true,
        runningConfig: {
            buyCount:   settings.buyCount,
            chooseDate: settings.chooseDate,
            chooseArea: settings.chooseArea,
            ocrApiUrl:  settings.ocrApiUrl,
        },
    });

    setStatus("running", "搶票執行中...");
    startBtn.disabled = true;
    stopBtn.disabled  = false;
    addLog("🚀 開始搶票流程", "info");
    if (chooseDateArr.length > 0) addLog(`場次日期：${chooseDateArr.join(" / ")}`, "info");
    if (chooseAreaArr.length > 0) addLog(`區域關鍵字：${chooseAreaArr.join(" / ")}`, "info");

    await sendToContent("START", {
        buyCount:   settings.buyCount,
        chooseDate: chooseDateArr,
        chooseArea: chooseAreaArr,
        ocrApiUrl:  settings.ocrApiUrl,
    });
});

// 停止搶票
stopBtn.addEventListener("click", async () => {
    chrome.storage.local.set({ isRunning: false });
    setStatus("idle", "已停止");
    startBtn.disabled = false;
    stopBtn.disabled  = true;
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

// 檢查 OCR Server
checkOcrBtn.addEventListener("click", () => {
    ocrLabel.textContent  = "OCR Server：檢查中...";
    ocrLabel.style.color  = "#aaa";
    ocrDot.className      = "ocr-dot";
    checkOcrServer();
});

// ── 監聽來自 Content Script 的主動訊息 ──────────────────────

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.from !== "content") return;

    switch (msg.event) {
        case "LOG":
            addLog(msg.text, msg.type ?? "info");
            break;
        case "DONE":
            chrome.storage.local.set({ isRunning: false });
            setStatus("idle", "流程完成");
            startBtn.disabled = false;
            stopBtn.disabled  = true;
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

// 啟動時檢查 OCR Server 狀態
checkOcrServer();

// 若擴充功能重新開啟時正在執行中，恢復 UI 狀態
chrome.storage.local.get(["isRunning"], (result) => {
    if (result.isRunning) {
        setStatus("running", "搶票執行中...");
        startBtn.disabled = true;
        stopBtn.disabled  = false;
        addLog("偵測到搶票流程仍在執行中", "warn");
    } else {
        addLog("擴充功能已載入，請設定場次日期與區域關鍵字後開始搶票", "info");
    }
});
