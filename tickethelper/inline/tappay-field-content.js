// inline/tappay-field-content.js — TapPay iframe 欄位預填助手（乾淨版）
// 只在 js.tappaysdk.com 的 tappay-field iframe 內執行。
(() => {
  if (window.__INLINE_TAPPAY_CLEAN_HELPER_LOADED__) return;
  window.__INLINE_TAPPAY_CLEAN_HELPER_LOADED__ = true;

  const FIELD_TYPES = new Set(["card-number", "expiration-date", "ccv"]);

  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function storageGet(keys) {
    return new Promise(resolve => {
      try { chrome.storage.local.get(keys, resolve); } catch (_) { resolve({}); }
    });
  }

  function storageSet(obj) {
    return new Promise(resolve => {
      try { chrome.storage.local.set(obj, resolve); } catch (_) { resolve(); }
    });
  }

  function detectFieldType() {
    try {
      const raw = decodeURIComponent(location.search.slice(1) || "");
      const json = raw && raw.startsWith("{") ? JSON.parse(raw) : null;
      const type = String(json?.type || "");
      if (FIELD_TYPES.has(type)) return type;
    } catch (_) { }
    const href = decodeURIComponent(location.href || "");
    if (href.includes("card-number")) return "card-number";
    if (href.includes("expiration-date")) return "expiration-date";
    if (href.includes("ccv")) return "ccv";
    return "";
  }

  const FIELD_TYPE = detectFieldType();
  if (!FIELD_TYPE) return;

  function normalizeValue(type, value) {
    let s = String(value || "").trim();
    if (type === "card-number") return s.replace(/\D/g, "");
    if (type === "ccv") return s.replace(/\D/g, "").slice(0, 4);
    if (type === "expiration-date") {
      const m = s.replace(/\s+/g, "").match(/^(\d{1,2})[\/\-]?((?:\d{2})|(?:\d{4}))$/);
      if (!m) return s.replace(/\D/g, "").slice(0, 4);
      const mm = String(m[1]).padStart(2, "0");
      const yy = m[2].length === 4 ? m[2].slice(-2) : m[2];
      // TapPay 欄位由 SDK 自己加斜線，直接輸入 MMYY 最穩。
      return `${mm}${yy}`;
    }
    return s;
  }

  function findInput() {
    // TapPay 每個 iframe 內其實都有多個 input。
    // 不能拿第一個可用 input，否則 expiration-date / ccv 會寫進 focus-helper 或 autofill 欄位。
    const selectorsByType = {
      "card-number": [
        "input#cc-number.card-number",
        "input[name='cc-number'].card-number",
        "input[autocomplete='cc-number'].card-number",
        "input#cc-number:not(.autofill)"
      ],
      "expiration-date": [
        "input#cc-exp.expiration-date",
        "input[name='cc-exp'].expiration-date",
        "input[autocomplete='cc-exp'].expiration-date",
        "input#cc-exp:not(.autofill)"
      ],
      "ccv": [
        "input#cc-ccv.ccv",
        "input[name='cc-ccv'].ccv",
        "input[autocomplete='cc-csc'].ccv",
        "input#cc-ccv:not(.autofill)"
      ]
    };

    for (const selector of selectorsByType[FIELD_TYPE] || []) {
      const el = document.querySelector(selector);
      if (el && !el.disabled) return el;
    }

    return document.querySelector("input:not([type='hidden']):not([disabled]):not(.focus-helper-prev):not(.focus-helper-next):not(.autofill), textarea:not([disabled]), [contenteditable='true']");
  }

  function digits(s) {
    return String(s || "").replace(/\D/g, "");
  }

  function valueLooksAccepted(type, actual, expected) {
    const a = digits(actual);
    const e = digits(normalizeValue(type, expected));
    if (type === "card-number") return a.length >= 12 && a.endsWith(e.slice(-4));
    if (type === "expiration-date") return a === e || (a.length === 4 && e.length === 4 && a === e);
    if (type === "ccv") return a === e && (a.length === 3 || a.length === 4);
    return !!a;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  async function typeLikeUser(el, value) {
    if (!el) return { ok: false, reason: "input-not-found", actual: "" };
    try { window.focus(); } catch (_) { }
    el.focus();
    await delay(30);

    // 清空
    try { el.select?.(); } catch (_) { }
    setNativeValue(el, "");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward", data: null }));
    await delay(20);

    for (const ch of String(value)) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: /^\d$/.test(ch) ? `Digit${ch}` : ch, bubbles: true, cancelable: true, composed: true }));
      const before = el.value || "";
      setNativeValue(el, before + ch);
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: /^\d$/.test(ch) ? `Digit${ch}` : ch, bubbles: true, cancelable: true, composed: true }));
      await delay(35);
    }

    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    el.blur();
    await delay(80);
    const actual = String(el.value || "");
    const ok = valueLooksAccepted(FIELD_TYPE, actual, value);
    return { ok, reason: ok ? "typed-main-field" : `typed-but-unmatched:${actual}`, actual };
  }

  async function mark(commandId, ok, reason, actual = "") {
    const now = Date.now();
    const data = await storageGet(["inline_tappayFilledStatus"]);
    const status = data.inline_tappayFilledStatus || {};
    status[FIELD_TYPE] = { ok, reason, actual, commandId, ts: now };
    await storageSet({ inline_tappayFilledStatus: status });
    try {
      chrome.runtime.sendMessage({ from: "inline-tappay-field", event: "TAPPAY_FIELD_RESULT", fieldType: FIELD_TYPE, ok, reason, actual, commandId, ts: now });
    } catch (_) { }
  }

  async function runCommand(command) {
    if (!command || command.type !== FIELD_TYPE || !command.id) return;
    const value = normalizeValue(FIELD_TYPE, command.value);
    if (!value) {
      await mark(command.id, false, "empty-value", "");
      return;
    }

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const input = findInput();
      if (input) {
        const result = await typeLikeUser(input, value);
        await mark(command.id, result.ok, result.reason, result.actual);
        return;
      }
      await delay(80);
    }
    await mark(command.id, false, "input-timeout", "");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.inline_tappayCommand) return;
    runCommand(changes.inline_tappayCommand.newValue);
  });

  storageGet(["inline_tappayCommand"]).then(data => runCommand(data.inline_tappayCommand));
})();
