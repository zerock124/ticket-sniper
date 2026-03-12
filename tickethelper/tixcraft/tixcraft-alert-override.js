// ============================================================
//  tixcraft-alert-override.js — 在 main world 中覆寫 window.alert
//  宣告在 manifest.json 的 "world": "MAIN"，由瀏覽器直接注入，
//  不受頁面 CSP 限制，可攔截頁面 JS 與 console 發出的 alert()。
//
//  觸發時透過 CustomEvent '__tixcraft_alert' 橋接回 isolated world
//  （tixcraft-content.js 監聽此事件並呼叫 waitForAlert）
//
//  注意：此檔案在 main world 執行，無法直接存取 chrome.storage API
//  因此無法檢查全域開關狀態，由 tixcraft-content.js 負責檢查
// ============================================================

// 保存原始的 alert 和 confirm 函數，以便在停用時可以恢復
const _originalAlert = window.alert;
const _originalConfirm = window.confirm;

window.alert = function (msg) {
    window.dispatchEvent(
        new CustomEvent("__tixcraft_alert", { detail: msg ?? "" })
    );
};

window.confirm = function (msg) {
    window.dispatchEvent(
        new CustomEvent("__tixcraft_confirm", { detail: msg ?? "" })
    );
    return true; // 自動回應 "確定"
};
