// ============================================================
//  alert-override.js — 在 main world 中覆寫 window.alert
//  宣告在 manifest.json 的 "world": "MAIN"，由瀏覽器直接注入，
//  不受頁面 CSP 限制，可攔截頁面 JS 與 console 發出的 alert()。
//
//  觸發時透過 CustomEvent '__tixcraft_alert' 橋接回 isolated world
//  （content.js 監聽此事件並呼叫 waitForAlert）
// ============================================================

window.alert = function (msg) {
    window.dispatchEvent(
        new CustomEvent("__tixcraft_alert", { detail: msg ?? "" })
    );
};

window.confirm = function (msg) {
    window.dispatchEvent(
        new CustomEvent("__tixcraft_confirm", { detail: msg ?? "" })
    );
};
