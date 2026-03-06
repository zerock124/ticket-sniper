// ============================================================
//  popup.js — Tixcraft 搶票助手 彈出視窗邏輯
// ============================================================

// DOM 元素參考
const buyCountEl = document.getElementById("buyCount");
const chooseDateEl = document.getElementById("chooseDate");
const chooseAreaEl = document.getElementById("chooseArea");
const ocrApiUrlSelectEl  = document.getElementById("ocrApiUrlSelect");
const ocrApiUrlCustomEl  = document.getElementById("ocrApiUrlCustom");
const areaFallbackEl     = document.getElementById("areaFallback");
const dateFallbackEl     = document.getElementById("dateFallback");
const reloadDelayEl      = document.getElementById("reloadDelay");
const targetUrlEl        = document.getElementById("targetUrl");
const verifyCodeEl       = document.getElementById("verifyCode");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const saveBtn = document.getElementById("saveBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const logArea = document.getElementById("logArea");
const ocrDot = document.getElementById("ocrDot");
const ocrLabel = document.getElementById("ocrLabel");
const checkOcrBtn = document.getElementById("checkOcrBtn");
const clearLogBtn = document.getElementById("clearLogBtn");

// ── Tab 切換 ─────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
    });
});

// Tab 2 的儲存設定按鈕
document.getElementById("saveBtnLogic").addEventListener("click", () => {
    const settings = buildSettings();
    chrome.storage.local.set(settings, () => {
        addLog("✅ 設定已儲存", "success");
    });
});

// ── OCR API 網址輔助函式 ──────────────────────────────────────

// 取得目前選取的 OCR API 網址
function getOcrApiUrl() {
    if (ocrApiUrlSelectEl.value === "__custom__") {
        return ocrApiUrlCustomEl.value.trim() || "http://localhost:5511/ocr";
    }
    return ocrApiUrlSelectEl.value;
}

// 設定 OCR API 網址（讀取儲存值時使用）
function setOcrApiUrl(url) {
    // 判斷是否為預設選項之一
    const options = Array.from(ocrApiUrlSelectEl.options).map(o => o.value);
    const presetIdx = options.indexOf(url);
    if (presetIdx !== -1 && options[presetIdx] !== "__custom__") {
        ocrApiUrlSelectEl.value = url;
        ocrApiUrlCustomEl.style.display = "none";
    } else {
        // 非預設選項，切到「自行輸入」
        ocrApiUrlSelectEl.value = "__custom__";
        ocrApiUrlCustomEl.value = url;
        ocrApiUrlCustomEl.style.display = "block";
    }
}

// 下拉選單切換時顯示 / 隱藏自行輸入欄
ocrApiUrlSelectEl.addEventListener("change", () => {
    if (ocrApiUrlSelectEl.value === "__custom__") {
        ocrApiUrlCustomEl.style.display = "block";
        ocrApiUrlCustomEl.focus();
    } else {
        ocrApiUrlCustomEl.style.display = "none";
    }
});

// ── 工具函式 ─────────────────────────────────────────────────

// 日誌最大保留筆數，避免 storage 無限增長
const MAX_LOG_ENTRIES = 300;

// 將單筆日誌渲染到畫面（不寫入 storage）
function _renderLogEntry(time, message, type) {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${time}] ${message}`;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;
}

// 寫入紀錄訊息，並同步持久化到 chrome.storage.local
function addLog(message, type = "info") {
    const now = new Date().toLocaleTimeString("zh-TW");
    _renderLogEntry(now, message, type);

    // 讀取現有日誌 → 追加 → 裁切超量 → 寫回
    chrome.storage.local.get(["savedLogs"], (result) => {
        const logs = result.savedLogs ?? [];
        logs.push({ time: now, message, type });
        if (logs.length > MAX_LOG_ENTRIES) {
            logs.splice(0, logs.length - MAX_LOG_ENTRIES);
        }
        chrome.storage.local.set({ savedLogs: logs });
    });
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

// 檢查 OCR 驗證記錄是否有效（1 小時內）
function isOcrVerificationValid() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["ocrVerifiedAt"], (result) => {
            if (!result.ocrVerifiedAt) {
                resolve(false);
                return;
            }
            const now = Date.now();
            const verifiedAt = result.ocrVerifiedAt;
            const oneHour = 60 * 60 * 1000; // 1 小時（毫秒）
            resolve(now - verifiedAt < oneHour);
        });
    });
}

async function checkOcrServer() {
    const apiUrl = getOcrApiUrl();
    // 將 /ocr 替換為 /health 進行健康檢查
    const healthUrl = apiUrl.replace(/\/ocr$/, "/health");

    try {
        const res = await fetch(healthUrl, {
            method: "GET",
            signal: AbortSignal.timeout(3000), // 3 秒逾時
        });
        const data = await res.json();
        const isOnline = data.status === "ok";
        setOcrStatus(isOnline);
        
        // 驗證成功時，記錄時間戳到 storage
        if (isOnline) {
            chrome.storage.local.set({ ocrVerifiedAt: Date.now() }, () => {
                addLog("✅ OCR Server 驗證成功，有效期限 1 小時", "success");
            });
        }
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
        ["buyCount", "chooseDate", "chooseArea", "ocrApiUrl", "areaFallback", "dateFallback", "reloadDelay", "targetUrl", "verifyCode"],
        (result) => {
            buyCountEl.value = result.buyCount ?? 2;
            chooseDateEl.value = result.chooseDate ?? "";
            chooseAreaEl.value = result.chooseArea ?? "";
            setOcrApiUrl(result.ocrApiUrl ?? "http://localhost:5511/ocr");
            areaFallbackEl.value = result.areaFallback ?? "refresh";
            dateFallbackEl.value = result.dateFallback ?? "refresh";
            reloadDelayEl.value = result.reloadDelay ?? 1;
            targetUrlEl.value = result.targetUrl ?? "";
            verifyCodeEl.value = result.verifyCode ?? "";
        }
    );
}

// 組建設定物件
function buildSettings() {
    return {
        buyCount: parseInt(buyCountEl.value, 10) || 2,
        chooseDate: chooseDateEl.value.trim(),
        chooseArea: chooseAreaEl.value.trim(),
        ocrApiUrl: getOcrApiUrl(),
        areaFallback: areaFallbackEl.value,
        dateFallback: dateFallbackEl.value,
        reloadDelay: parseFloat(reloadDelayEl.value) || 1,
        targetUrl: targetUrlEl.value.trim(),
        verifyCode: verifyCodeEl.value.trim(),
    };
}

// ── 與 Content Script 通訊 ──────────────────────────────────

// 取得目前活躍的 Tixcraft 分頁 ID
// 因為 popup 已改為獨立視窗，`currentWindow` 指向的是 popup 視窗而非瀏覽器視窗，
// 因此改為查詢所有視窗中符合 tixcraft.com 的分頁。
async function getActiveTabId() {
    return new Promise((resolve) => {
        // 優先找活躍中的 tixcraft.com 分頁
        chrome.tabs.query({ url: ["https://tixcraft.com/*", "https://*.tixcraft.com/*"] }, (tabs) => {
            if (tabs && tabs.length > 0) {
                // 優先選取活躍中的分頁，否則取最近一個
                const activeTab = tabs.find(t => t.active) ?? tabs[tabs.length - 1];
                resolve(activeTab.id);
            } else {
                resolve(null);
            }
        });
    });
}

// 傳送訊息給 Content Script
async function sendToContent(action, data = {}) {
    const tabId = await getActiveTabId();
    if (!tabId) {
        addLog("❌ 找不到 Tixcraft 分頁，請確認已開啟 tixcraft.com", "error");
        return;
    }

    // 先注入 content.js（如果尚未注入）
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (_) { }

    // 等待注入的腳本完成初始化，確保訊息監聽器已登記
    await new Promise(resolve => setTimeout(resolve, 300));

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
    // 檢查 OCR 驗證記錄是否在有效期限內
    const isValid = await isOcrVerificationValid();
    if (!isValid) {
        addLog("❌ OCR Server 驗證已過期或未驗證，請點擊 🔄 重新驗證", "error");
        return;
    }
    
    // 請先檢查ocr使否連線成功
    if(ocrDot.className.includes("online") === false){
        addLog("❌ 請先確保 OCR Server 已啟動並連線成功", "error");
        return;
    }

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
            buyCount: settings.buyCount,
            chooseDate: settings.chooseDate,
            chooseArea: settings.chooseArea,
            ocrApiUrl: settings.ocrApiUrl,
            areaFallback: settings.areaFallback,
            dateFallback: settings.dateFallback,
            reloadDelay: settings.reloadDelay,
            targetUrl: settings.targetUrl,
        },
    });

    setStatus("running", "搶票執行中...");
    startBtn.disabled = true;
    stopBtn.disabled = false;
    addLog("🚀 開始搶票流程", "info");
    if (settings.targetUrl) addLog(`目標網址：${settings.targetUrl}`, "info");
    if (chooseDateArr.length > 0) {
        const dateFallbackLabel = settings.dateFallback === "select_first" ? "選擇可訂購場次" : `重整（${settings.reloadDelay}秒）`;
        addLog(`場次日期：${chooseDateArr.join(" / ")}（找不到時：${dateFallbackLabel}）`, "info");
    }
    if (chooseAreaArr.length > 0) {
        const fallbackLabel = settings.areaFallback === "select_first" ? "選擇可訂購區域" : `重整（${settings.reloadDelay}秒`;
        addLog(`區域關鍵字：${chooseAreaArr.join(" / ")}（找不到時：${fallbackLabel})）`, "info");
    }

    await sendToContent("START", {
        buyCount: settings.buyCount,
        chooseDate: chooseDateArr,
        chooseArea: chooseAreaArr,
        ocrApiUrl: settings.ocrApiUrl,
        areaFallback: settings.areaFallback,
        dateFallback: settings.dateFallback,
        reloadDelay: settings.reloadDelay,
        targetUrl: settings.targetUrl,
    });
});

// 停止搶票
stopBtn.addEventListener("click", async () => {
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

// 檢查 OCR Server
checkOcrBtn.addEventListener("click", () => {
    ocrLabel.textContent = "OCR Server：檢查中...";
    ocrLabel.style.color = "#aaa";
    ocrDot.className = "ocr-dot";
    checkOcrServer();
});

// 清除日誌
clearLogBtn.addEventListener("click", () => {
    // 清除畫面上的日誌
    logArea.innerHTML = "";
    // 清除 storage 中的日誌記錄
    chrome.storage.local.remove("savedLogs");
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
            stopBtn.disabled = true;
            addLog("🎉 所有步驟完成！", "success");
            break;
        case "RELOAD":
            // 頁面重新整理：清除舊日誌，讓下一頁從乾淨狀態開始
            chrome.storage.local.remove("savedLogs");
            addLog("🔄 頁面重新整理中...", "warn");
            break;
        case "ERROR":
            setStatus("error", "發生錯誤");
            addLog(`❌ ${msg.text}`, "error");
            break;
    }
});

// ── 初始化 ──────────────────────────────────────────────────
(async function () {
    loadSettings();

    // 還原歷史日誌，接著恢復 UI 執行狀態
    chrome.storage.local.get(["isRunning", "savedLogs", "ocrVerifiedAt"], async (result) => {
        // 先把持久化的日誌重新渲染到畫面（不重複寫入 storage）
        const savedLogs = result.savedLogs ?? [];
        savedLogs.forEach(({ time, message, type }) => {
            _renderLogEntry(time, message, type);
        });

        // 檢查 OCR 驗證狀態並自動驗證
        if (result.ocrVerifiedAt) {
            const now = Date.now();
            const verifiedAt = result.ocrVerifiedAt;
            const oneHour = 60 * 60 * 1000;
            const timeLeft = oneHour - (now - verifiedAt);
            
            if (timeLeft > 0) {
                // addLog(`OCR Server 驗證有效，剩餘 ${minutesLeft} 分鐘`, "info");
                // 驗證仍有效，自動檢查 OCR Server 連線狀態
                await setOcrStatus(true);
            } else {
                // addLog("OCR Server 驗證已過期，請重新驗證", "warn");
                setOcrStatus(false);
            }
        } else {
            // 首次使用或無驗證記錄，自動執行檢查
            // addLog("正在檢查 OCR Server 連線狀態...", "info");
            await checkOcrServer();
        }

        // 再加上本次開啟的狀態訊息
        if (result.isRunning) {
            setStatus("running", "搶票執行中...");
            startBtn.disabled = true;
            stopBtn.disabled = false;
            addLog("偵測到搶票流程仍在執行中", "warn");
        } else {
            addLog("擴充功能已載入，請設定場次日期與區域關鍵字後開始搶票", "info");
        }
    });
})();