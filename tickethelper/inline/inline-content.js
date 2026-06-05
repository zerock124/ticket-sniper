// ============================================================
// inline/inline-content.refactor.js — Inline 訂位助手
//
// 流程說明：
//   START → 讀取 popup 傳入設定 → 選擇人數 → 依三段式順位選日期/時間
//         → 點擊前置 submit → 檢查是否進入 /form
//         → 填寫聯絡資訊 → 點擊最終 submit → 檢查是否進入 /success；失敗則重新整理。
// ============================================================

(() => {
  if (window.__INLINE_HELPER_LOADED__) return;
  window.__INLINE_HELPER_LOADED__ = true;

  // ── 可調整等待秒數 / 間隔 ─────────────────────────────────────
  // 選位頁點擊 submit 後，等待進入 /form 或 /success 的時間。
  const WAIT_FORM_TIMEOUT_MS = 10000;

  // 聯絡資訊頁點擊 submit 後，等待進入 /success 的時間。
  const WAIT_SUCCESS_TIMEOUT_MS = 10000;

  // 等待 submit 按鈕結構出現的時間。
  const WAIT_SUBMIT_BUTTON_TIMEOUT_MS = 4000;

  // 頁面狀態偵測輪詢間隔。
  const WAIT_PAGE_INTERVAL_MS = 50;

  // 聯絡資訊欄位出現後，等待填寫的時間。
  const WAIT_FORM_READY_TIMEOUT_MS = 5000;

  // 進入 success URL 後，等待成功頁 DOM 與行事曆彈窗/成功訊息完成渲染的時間。
  const WAIT_SUCCESS_READY_TIMEOUT_MS = 8000;

  // UNKNOWN 頁面跳回訂位頁前的等待時間。設為 0 可立即跳轉。
  const WAIT_REDIRECT_BOOKING_MS = 0;

  // success 頁 DOM 不完整時，只允許重整 success 頁一次；再失敗就回訂位頁。
  const MAX_SUCCESS_RELOAD = 1;

  let isRunning = false;
  let CONFIG = {};
  let runToken = 0;
  let finalReadyEmitted = false;
  let inlineDone = false;
  let navigationInProgress = false;
  let successCheckInProgress = false;
  let currentPhase = "IDLE";

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  function sendEvent(event, text = "", type = "info") {
    try { chrome.runtime.sendMessage({ from: "inline-content", event, text, type }); } catch (_) { }
  }

  function sendLog(text, type = "info") {
    console.log(`[Inline助手] ${text}`);
    sendEvent("LOG", text, type);
  }

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

  function storageRemove(keys) {
    return new Promise(resolve => {
      try { chrome.storage.local.remove(keys, resolve); } catch (_) { resolve(); }
    });
  }

  function norm(s) { return String(s || "").replace(/\s+/g, "").trim(); }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const cn = String(el.className || "").toLowerCase();
    if (cn.includes("disabled")) return true;
    return false;
  }

  function safeClick(el) {
    if (!el || !isVisible(el) || isDisabled(el)) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setSelectValue(selector, matcher) {
    const select = document.querySelector(selector);
    if (!select) return false;
    const target = String(matcher || "");
    const opt = [...select.options].find(o =>
      o.value === target || norm(o.textContent).includes(norm(target)) || norm(o.dataset.testid).includes(norm(target))
    );
    if (!opt) return false;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(select, opt.value);
    else select.value = opt.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === opt.value;
  }

  async function waitFor(fn, timeout = 10000, interval = 150) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return null;
      const result = await fn();
      if (result) return result;
      await delay(interval);
    }
    return null;
  }

  // ── Inline 聯絡資訊頁穩定 selector / 表單工具 ─────────────────────
  // 原則：使用 id / data-cy / name / autocomplete / aria-label / label-for；不依賴 sc-* 動態 class。
  function qsa(root, selector) {
    try { return [...(root || document).querySelectorAll(selector)]; } catch (_) { return []; }
  }

  function firstVisible(root, selectors) {
    for (const selector of selectors) {
      const hit = qsa(root, selector).find(isVisible);
      if (hit) return hit;
    }
    return null;
  }

  function cssEscapeValue(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function findFormRoot() {
    return document.querySelector("form#contact-form")
      || document.querySelector("#contact-form")
      || document.querySelector("form[action='javascript:void(0)']")
      || document;
  }

  function findInputByLabelText(labelPattern, root = findFormRoot()) {
    const label = qsa(root, "label").filter(isVisible).find(l => labelPattern.test(norm(l.innerText || l.textContent || "")));
    if (!label) return null;

    const forId = label.getAttribute("for");
    if (forId) {
      const byFor = root.querySelector(`#${cssEscapeValue(forId)}`) || document.querySelector(`#${cssEscapeValue(forId)}`);
      if (byFor && isVisible(byFor)) return byFor;
    }

    const local = label.querySelector("input, textarea, select");
    if (local && isVisible(local)) return local;

    let cursor = label.nextElementSibling;
    while (cursor) {
      const hit = cursor.matches?.("input, textarea, select") ? cursor : cursor.querySelector?.("input, textarea, select");
      if (hit && isVisible(hit)) return hit;
      cursor = cursor.nextElementSibling;
    }
    return null;
  }

  function splitChineseName(fullName) {
    const name = String(fullName || "").trim().replace(/\s+/g, "");
    if (!name) return { familyName: "", givenName: "" };
    const compoundSurnames = ["歐陽", "司馬", "上官", "諸葛", "夏侯", "皇甫", "尉遲", "公孫", "慕容", "司徒", "令狐", "東方", "西門", "南宮", "宇文", "長孫"];
    const familyName = compoundSurnames.find(s => name.startsWith(s)) || name.slice(0, 1);
    return { familyName, givenName: name.slice(familyName.length) };
  }

  function fillNameFields(root = findFormRoot()) {
    const fullName = String(CONFIG.name || "").trim();
    if (!fullName) return true;

    const family = firstVisible(root, [
      "input#familyName[data-cy='familyName']",
      "input[data-cy='familyName']",
      "input#familyName",
      "input[autocomplete='family-name']",
      "#nameFields input[placeholder='姓']"
    ]);
    const given = firstVisible(root, [
      "input#givenName[data-cy='givenName']",
      "input[data-cy='givenName']",
      "input#givenName",
      "input[autocomplete='given-name']",
      "#nameFields input[placeholder='名']"
    ]);

    if (family || given) {
      const parts = splitChineseName(fullName);
      if (family) setNativeValue(family, parts.familyName || fullName);
      if (given) setNativeValue(given, parts.givenName || "");
      return true;
    }

    const singleName = firstVisible(root, [
      "input#name[data-cy='name']",
      "input[data-cy='name']",
      "input#name",
      "input[autocomplete='name']"
    ]) || findInputByLabelText(/訂位人姓名|姓名/, root);
    if (!singleName) return false;
    setNativeValue(singleName, fullName);
    return true;
  }

  function fillPhoneField(root = findFormRoot()) {
    if (!CONFIG.phone) return true;
    const phone = firstVisible(root, [
      "input#phone[data-cy='phone']",
      "input[data-cy='phone']",
      "input#phone",
      "input[type='tel']",
      "input[autocomplete='tel']"
    ]) || findInputByLabelText(/手機|電話|phone/i, root);
    if (!phone) return false;
    setNativeValue(phone, CONFIG.phone);
    return true;
  }

  function fillEmailField(root = findFormRoot()) {
    if (!CONFIG.email) return true;
    const email = firstVisible(root, [
      "input#email[data-cy='email']",
      "input[data-cy='email']",
      "input#email",
      "input[type='email']",
      "input[autocomplete='email']"
    ]) || findInputByLabelText(/email|e-mail|電子信箱/i, root);
    if (!email) return false;
    setNativeValue(email, CONFIG.email);
    return true;
  }

  function fillNoteField(root = findFormRoot()) {
    if (!CONFIG.note) return true;
    const textarea = firstVisible(root, ["textarea[data-cy='note']", "textarea[data-cy='memo']", "textarea[aria-invalid]", "textarea"])
      || findInputByLabelText(/其他備註|備註|特殊需求|note|memo/i, root);
    if (!textarea) return false;
    setNativeValue(textarea, CONFIG.note);
    return true;
  }

  function fillCardholderNameField(root = findFormRoot()) {
    const cardholderName = String(CONFIG.cardholderName || CONFIG.name || "").trim();
    if (!cardholderName) return true;
    const field = firstVisible(root, [
      "input#cardholder-name[data-cy='cardholder-name']",
      "input[data-cy='cardholder-name']",
      "input#cardholder-name",
      "input[name='cardholder-name']",
      "input[autocomplete='cc-name']"
    ]) || findInputByLabelText(/持卡人姓名|cardholder|持卡人/i, root);
    if (!field) return true;
    setNativeValue(field, cardholderName);
    return true;
  }

  function getFormVersionInfo(root = findFormRoot()) {
    const hasSingleName = !!firstVisible(root, ["input#name[data-cy='name']", "input[data-cy='name']", "input#name", "input[autocomplete='name']"]);
    const hasSplitName = !!firstVisible(root, ["input#familyName[data-cy='familyName']", "input[data-cy='familyName']", "input#familyName", "input[autocomplete='family-name']"]);
    const hasPayment = !!root.querySelector("[data-cy='booking-payment-form'], [aria-label='credit card number'], [data-cy='card-number'], #card-number");
    const hasInvoice = !!root.querySelector("[data-cy='invoice-info'], #invoice-type, #tw-duplicate-invoice, #tw-triplicate-invoice");
    return { hasSingleName, hasSplitName, hasPayment, hasInvoice };
  }

  function logFormVersionOnce(root = findFormRoot()) {
    if (window.__INLINE_HELPER_FORM_VERSION_LOGGED__) return;
    window.__INLINE_HELPER_FORM_VERSION_LOGGED__ = true;
    const v = getFormVersionInfo(root);
    const nameVersion = v.hasSplitName ? "姓名拆欄版" : (v.hasSingleName ? "單一姓名版" : "未知姓名版");
    sendLog(`Inline 表單版本：${nameVersion} / ${v.hasPayment ? "含付款區" : "無付款區"} / ${v.hasInvoice ? "含發票區" : "無發票區"}`, "info");
  }

  function detectSecurePaymentBlock(root = findFormRoot()) {
    const paymentRoot = root.querySelector("[data-cy='booking-payment-form']") || root;
    const cardNumber = paymentRoot.querySelector("[data-cy='card-number'], #card-number, [aria-label='credit card number']");
    const cardExpiry = paymentRoot.querySelector("[data-cy='card-expiry'], #card-expiry, [aria-label='credit card expiry date']");
    const cardSecurityCode = paymentRoot.querySelector("[data-cy='card-security-code'], #card-security-code, [aria-label='credit card security code']");
    const tappayFrame = paymentRoot.querySelector("iframe[src*='tappay-field'], iframe[src*='js.tappaysdk.com']");
    return { required: !!(cardNumber || cardExpiry || cardSecurityCode || tappayFrame), cardNumber: !!cardNumber, cardExpiry: !!cardExpiry, cardSecurityCode: !!cardSecurityCode, tappayFrame: !!tappayFrame };
  }

  async function hydrateCardConfigFromStorageIfNeeded() {
    // START 訊息偶爾可能沒有帶到信用卡欄位，尤其使用者停在 /form 或 popup UI 尚未重新載入時。
    // 付款頁只要出現，就再從 chrome.storage.local 補一次，避免誤判「未設定完整卡號 / 效期 / CCV」。
    const before = {
      autoCardFill: CONFIG.autoCardFill,
      autoSubmitPayment: CONFIG.autoSubmitPayment,
      cardNumber: CONFIG.cardNumber,
      cardExpiry: CONFIG.cardExpiry,
      cardCcv: CONFIG.cardCcv,
      cardholderName: CONFIG.cardholderName
    };

    const saved = await storageGet([
      "inline_autoCardFill",
      "inline_autoSubmitPayment",
      "inline_cardNumber",
      "inline_cardExpiry",
      "inline_cardCcv",
      "inline_cardholderName"
    ]);

    if (CONFIG.autoCardFill !== true && saved.inline_autoCardFill === true) CONFIG.autoCardFill = true;
    if (CONFIG.autoSubmitPayment !== true && saved.inline_autoSubmitPayment === true) CONFIG.autoSubmitPayment = true;
    if (!String(CONFIG.cardNumber || "").trim() && saved.inline_cardNumber) CONFIG.cardNumber = saved.inline_cardNumber;
    if (!String(CONFIG.cardExpiry || "").trim() && saved.inline_cardExpiry) CONFIG.cardExpiry = saved.inline_cardExpiry;
    if (!String(CONFIG.cardCcv || "").trim() && saved.inline_cardCcv) CONFIG.cardCcv = saved.inline_cardCcv;
    if (!String(CONFIG.cardholderName || "").trim() && saved.inline_cardholderName) CONFIG.cardholderName = saved.inline_cardholderName;

    const changed = before.autoCardFill !== CONFIG.autoCardFill
      || before.autoSubmitPayment !== CONFIG.autoSubmitPayment
      || String(before.cardNumber || "") !== String(CONFIG.cardNumber || "")
      || String(before.cardExpiry || "") !== String(CONFIG.cardExpiry || "")
      || String(before.cardCcv || "") !== String(CONFIG.cardCcv || "")
      || String(before.cardholderName || "") !== String(CONFIG.cardholderName || "");

    if (changed) sendLog("已從本機儲存補齊 Inline 信用卡設定", "info");
  }

  function hasCardAutoFillConfig() {
    return CONFIG.autoCardFill === true
      && !!String(CONFIG.cardNumber || "").trim()
      && !!String(CONFIG.cardExpiry || "").trim()
      && !!String(CONFIG.cardCcv || "").trim();
  }

  function paymentErrorIsShown(el) {
    if (!el) return false;
    if (el.hidden || el.hasAttribute("hidden")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    // TapPay/Inline 的錯誤 div 有時高度很小或被 layout 包住；付款驗證不能只靠 rect。
    return true;
  }

  function paymentValidationErrors(root = findFormRoot()) {
    return qsa(root, "[data-cy='card-number-is-empty-error'], [data-cy='card-number-is-invalid-error'], [data-cy='card-expiry-is-empty-error'], [data-cy='card-expiry-is-invalid-error'], [data-cy='card-security-code-is-empty-error'], [data-cy='card-security-code-is-invalid-error']")
      .filter(paymentErrorIsShown)
      .map(el => norm(el.innerText || el.textContent || el.getAttribute("data-cy") || ""))
      .filter(Boolean);
  }

  function hasVisibleValidationError(root = findFormRoot()) {
    return qsa(root, "[data-cy$='-error'], [data-cy*='-is-empty-error'], [data-cy*='-is-invalid-error']")
      .filter(el => !el.hidden && isVisible(el))
      .map(el => norm(el.innerText || el.textContent || el.getAttribute("data-cy") || ""))
      .filter(Boolean);
  }

  function tapPayValue(type) {
    if (type === "card-number") return String(CONFIG.cardNumber || "");
    if (type === "expiration-date") return String(CONFIG.cardExpiry || "");
    if (type === "ccv") return String(CONFIG.cardCcv || "");
    return "";
  }

  async function sendTapPayCommand(type, value, timeout = 7000) {
    const id = `${Date.now()}-${type}-${Math.random().toString(36).slice(2)}`;
    await storageSet({ inline_tappayCommand: { id, type, value }, inline_tappayFilledStatus: {} });
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const data = await storageGet(["inline_tappayFilledStatus"]);
      const hit = data.inline_tappayFilledStatus?.[type];
      if (hit && hit.commandId === id) return hit;
      await delay(120);
    }
    return { ok: false, reason: "timeout", actual: "" };
  }

  async function fillTapPayFieldsSequential(root = findFormRoot()) {
    const fields = [
      { type: "card-number", box: root.querySelector("[data-cy='card-number'], #card-number, [aria-label='credit card number']") },
      { type: "expiration-date", box: root.querySelector("[data-cy='card-expiry'], #card-expiry, [aria-label='credit card expiry date']") },
      { type: "ccv", box: root.querySelector("[data-cy='card-security-code'], #card-security-code, [aria-label='credit card security code']") }
    ];

    for (const f of fields) {
      const value = tapPayValue(f.type);
      if (!value) return false;
      const iframe = f.box?.matches?.("iframe") ? f.box : f.box?.querySelector?.("iframe");
      try { f.box?.scrollIntoView?.({ block: "center", inline: "center" }); } catch (_) { }
      await delay(80);
      try { f.box?.click?.(); } catch (_) { }
      try { iframe?.focus?.(); } catch (_) { }
      await delay(120);
      const result = await sendTapPayCommand(f.type, value);
      sendLog(`TapPay ${f.type} 回報：${result.ok ? "已輸入" : "失敗"}${result.reason ? ` (${result.reason})` : ""}`, result.ok ? "info" : "warn");
      await delay(220);
    }

    const start = Date.now();
    let last = [];
    while (Date.now() - start < 6000) {
      last = paymentValidationErrors(root);
      if (!last.length) return true;
      await delay(180);
    }
    if (last.length) sendLog(`TapPay 父頁仍顯示信用卡驗證錯誤：${last.join("、")}`, "warn");
    return false;
  }


  function parseClockToMin(t) {
    const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function minToClock(min) {
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m = String(min % 60).padStart(2, "0");
    return `${h}:${m}`;
  }

  function parseTimes(raw) {
    const out = [];
    String(raw || "").split(/[，,、]/).map(s => s.trim()).filter(Boolean).forEach(part => {
      const range = part.match(/^(\d{1,2}:\d{2})\s*[-~～]\s*(\d{1,2}:\d{2})$/);
      if (range) {
        const a = parseClockToMin(range[1]);
        const b = parseClockToMin(range[2]);
        if (a !== null && b !== null && b >= a) {
          for (let t = a; t <= b; t += 10) out.push(minToClock(t));
        }
      } else if (/^\d{1,2}:\d{2}$/.test(part)) {
        out.push(part.padStart(5, "0"));
      }
    });
    return [...new Set(out)];
  }

  function getPriorityPlanRules() {
    const plan = CONFIG.priorityPlan || {};
    const exact = Array.isArray(plan.exact) ? plan.exact : [];
    const range = Array.isArray(plan.range) ? plan.range : [];
    const any = Array.isArray(plan.any) ? plan.any : [];
    return { exact, range, any };
  }

  function planHasRows(plan = getPriorityPlanRules()) {
    return !!(plan.exact.length || plan.range.length || plan.any.length);
  }

  function timeInRange(text, start, end) {
    const t = parseClockToMin(text);
    const a = parseClockToMin(start);
    const b = parseClockToMin(end);
    return t !== null && a !== null && b !== null && t >= a && t <= b;
  }

  function mealRange(meal) {
    if (meal === "lunch") return [11 * 60, 15 * 60];
    if (meal === "dinner") return [17 * 60, 22 * 60 + 30];
    return [0, 24 * 60 - 1];
  }

  function timeInMeal(text, meal) {
    const t = parseClockToMin(text);
    if (t === null) return false;
    const [a, b] = mealRange(meal || "all");
    return t >= a && t <= b;
  }

  function parsePriorityRules() {
    const rules = [];
    const raw = String(CONFIG.priorityRules || "").trim();
    if (raw) {
      raw.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(line => {
        let dateText = "";
        let timesText = "";
        if (line.includes("|")) {
          const parts = line.split("|");
          dateText = parts[0].trim();
          timesText = parts.slice(1).join("|").trim();
        } else {
          const m = line.match(/^(.+?)\s+(\d{1,2}:\d{2}(?:\s*[-~～,，、]\s*\d{1,2}:\d{2})*)$/);
          if (m) { dateText = m[1].trim(); timesText = m[2].trim(); }
          else { dateText = line.trim(); }
        }
        const times = parseTimes(timesText);
        if (dateText) rules.push({ dateText, times, label: `${dateText}${times.length ? " | " + times.join(",") : ""}` });
      });
    }
    if (!rules.length && CONFIG.dateText) {
      const times = Array.isArray(CONFIG.times) && CONFIG.times.length ? CONFIG.times : parseTimes(CONFIG.timeText);
      rules.push({ dateText: CONFIG.dateText, times, label: `${CONFIG.dateText} | ${times.join(",")}` });
    }
    return rules;
  }

  function allPreferredTimes(rules) {
    const times = [];
    rules.forEach(r => (r.times || []).forEach(t => times.push(t)));
    if (!times.length) parseTimes(CONFIG.timeText).forEach(t => times.push(t));
    return [...new Set(times)];
  }

  function dateParts(text) {
    const s = String(text || "");
    const m1 = s.match(/(\d{1,2})月\s*(\d{1,2})日?/);
    if (m1) return { month: m1[1], day: m1[2] };
    const m2 = s.match(/(\d{1,2})\/(\d{1,2})/);
    if (m2) return { month: m2[1], day: m2[2] };
    const m3 = s.match(/\b(\d{1,2})\b/);
    return { month: "", day: m3 ? m3[1] : "" };
  }

  function rowDateParts(rowOrText) {
    if (rowOrText && typeof rowOrText === "object" && rowOrText.date) {
      const m = String(rowOrText.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    }
    const p = dateParts(typeof rowOrText === "object" ? rowOrText.dateText : rowOrText);
    return { year: null, month: p.month ? Number(p.month) : null, day: p.day ? Number(p.day) : null };
  }

  function currentDatePickerText() {
    return document.querySelector("#date-picker, [data-cy='date-picker']")?.innerText || "";
  }

  function getCalendarPicker() {
    return document.querySelector("#calendar-picker, [data-cy='calendar-picker']");
  }

  function getCalendarRoot() {
    const picker = getCalendarPicker();
    return picker && isVisible(picker) ? picker : document;
  }

  function visibleCalendarText() {
    const picker = getCalendarPicker();
    if (picker && isVisible(picker)) return picker.innerText || "";
    return "";
  }

  function findCalendarHeaders() {
    const root = getCalendarRoot();
    return [...root.querySelectorAll("[data-cy='calendar'] h4, h4")]
      .filter(isVisible)
      .map(el => {
        const text = (el.innerText || el.textContent || "").trim();
        const m = text.match(/^(\d{4})年\s*(\d{1,2})月$/);
        if (!m) return null;
        const rect = el.getBoundingClientRect();
        return { el, year: Number(m[1]), month: Number(m[2]), text, top: rect.top, left: rect.left, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => (a.left - b.left) || (a.top - b.top) || (a.area - b.area));
  }

  function domBefore(a, b) {
    if (!a || !b || a === b) return false;
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function monthKey(obj) {
    if (!obj?.year || !obj?.month) return "";
    return `${obj.year}-${String(obj.month).padStart(2, "0")}`;
  }

  function calendarMonthValue(obj) {
    if (!obj?.year || !obj?.month) return null;
    return Number(obj.year) * 12 + Number(obj.month);
  }

  function visibleCalendarMonths() {
    const seen = new Set();
    return findCalendarHeaders()
      .map(h => ({ year: h.year, month: h.month, value: calendarMonthValue(h), text: h.text }))
      .filter(m => {
        const key = `${m.year}-${m.month}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.value - b.value);
  }

  function visibleMonthLabel() {
    const months = visibleCalendarMonths();
    return months.length ? months.map(m => `${m.year}年${m.month}月`).join("、") : "無可見月份";
  }

  function inferTargetYear(month) {
    const months = visibleCalendarMonths();
    if (months.length) {
      const sameMonth = months.find(m => m.month === Number(month));
      if (sameMonth) return sameMonth.year;
      return months[0].year;
    }
    return new Date().getFullYear();
  }

  function normalizeTargetDate(rowOrText) {
    const p = rowDateParts(rowOrText);
    if (p.month && p.day && !p.year) p.year = inferTargetYear(p.month);
    return p;
  }

  function targetIso(target) {
    if (!target?.year || !target?.month || !target?.day) return "";
    return `${target.year}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}`;
  }

  function findCalendarNavButton(direction) {
    const root = getCalendarRoot();
    const selector = direction === "prev" ? ".prevMonth" : ".nextMonth";
    const hits = [...root.querySelectorAll(selector)]
      .map(el => el.closest("button, [role='button'], a") || el)
      .filter(el => el && isVisible(el) && !isDisabled(el))
      .map(el => {
        const rect = el.getBoundingClientRect();
        return { el, left: rect.left, top: rect.top, area: rect.width * rect.height };
      })
      .sort((a, b) => direction === "prev"
        ? (a.left - b.left) || (a.top - b.top) || (a.area - b.area)
        : (b.left - a.left) || (a.top - b.top) || (a.area - b.area));
    if (hits.length) return hits[0].el;

    const exact = direction === "prev" ? "-" : "+";
    const pattern = direction === "prev" ? /上一|上個|prev|previous|‹|«|〈|＜|-/ : /下一|下個|next|›|»|〉|＞|\+/;
    const textHits = [...root.querySelectorAll("button, [role='button'], div, span, a")]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => {
        const rootEl = el.closest("button, [role='button'], a") || el;
        const rect = rootEl.getBoundingClientRect();
        const t = norm(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
        return { el: rootEl, t, left: rect.left, top: rect.top, area: rect.width * rect.height };
      })
      .filter(x => x.t === exact || pattern.test(x.t))
      .sort((a, b) => direction === "prev"
        ? (a.left - b.left) || (a.top - b.top) || (a.area - b.area)
        : (b.left - a.left) || (a.top - b.top) || (a.area - b.area));
    return textHits[0]?.el || null;
  }

  async function waitCalendarChanged(beforeKey, timeout = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return false;
      const nowKey = visibleCalendarMonths().map(m => `${m.year}-${m.month}`).join(",");
      if (nowKey && nowKey !== beforeKey) return true;
      await delay(40);
    }
    return false;
  }

  async function ensureCalendarMonthVisible(target) {
    if (!target.year || !target.month) return true;
    if (!(await openDatePicker())) return false;

    const targetValue = calendarMonthValue(target);
    const targetLabel = `${target.year}年${target.month}月`;

    for (let i = 0; i < 14; i++) {
      if (!isRunning) return false;
      const months = visibleCalendarMonths();
      const currentLabel = visibleMonthLabel();

      if (months.some(m => m.value === targetValue)) return true;
      if (!months.length) {
        sendLog(`日期選單沒有可見月份`, "warn");
        return false;
      }

      const first = months[0].value;
      const last = months[months.length - 1].value;
      const direction = targetValue < first ? "prev" : "next";
      if (targetValue >= first && targetValue <= last) return true;

      sendLog(`目標月份 ${targetLabel} 不在目前日曆 ${currentLabel}，按${direction === "prev" ? "上一月" : "下一月"}`, "info");
      const beforeKey = months.map(m => `${m.year}-${m.month}`).join(",");
      const btn = findCalendarNavButton(direction);
      if (!btn || !safeClick(btn)) {
        sendLog(`找不到${direction === "prev" ? "上" : "下"}一月按鈕，目前日曆：${currentLabel}`, "warn");
        return false;
      }
      await waitCalendarChanged(beforeKey, 1200);
      await delay(80);
    }

    return visibleCalendarMonths().some(m => m.value === targetValue);
  }

  async function openDatePicker() {
    const datePicker = await waitFor(() => document.querySelector("#date-picker, [data-cy='date-picker']"), 2000, 50);
    if (!datePicker) return false;

    const picker = getCalendarPicker();
    if (picker && isVisible(picker) && findCalendarHeaders().length) return true;

    for (let i = 0; i < 3; i++) {
      if (!isRunning) return false;
      safeClick(datePicker);
      const opened = await waitFor(() => {
        const p = getCalendarPicker();
        return p && isVisible(p) && findCalendarHeaders().length ? p : null;
      }, 900, 50);
      if (opened) return true;
      await delay(80);
    }

    sendLog("日期選單沒有成功展開", "warn");
    return false;
  }

  function findDateElement(dateText, row = null) {
    const target = normalizeTargetDate(row || dateText);
    if (!target.day) return null;

    const iso = targetIso(target);
    if (iso) {
      const root = getCalendarRoot();
      const exact = root.querySelector(`[data-cy='bt-cal-day'][data-date='${iso}']`);
      if (!exact) {
        sendLog(`找不到日期節點：${iso}；目前日曆：${visibleMonthLabel()}`, "warn");
        return null;
      }
      if (!isVisible(exact)) {
        sendLog(`日期節點存在但不可見：${iso}`, "warn");
        return null;
      }
      if (isDisabled(exact)) {
        sendLog(`日期節點存在但 disabled：${iso}`, "warn");
        return null;
      }
      return exact;
    }

    const dayText = String(target.day);
    const headers = findCalendarHeaders();
    const targetKey = monthKey(target);

    const raw = [...getCalendarRoot().querySelectorAll("[data-cy='bt-cal-day']")]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => {
        const text = norm(el.innerText || el.textContent || "");
        const rect = el.getBoundingClientRect();
        return { el, rawEl: el, text, rect, area: rect.width * rect.height };
      })
      .filter(x => x.text === dayText || x.text === `${target.month || ""}月${dayText}日` || x.text.includes(norm(dateText)))
      .filter(x => x.rect.width <= 120 && x.rect.height <= 120)
      .sort((a, b) => (a.area - b.area));

    if (!raw.length) return null;

    if (targetKey && headers.length) {
      const matched = raw.filter(x => {
        const prevHeaders = headers.filter(h => domBefore(h.el, x.rawEl) || h.el.contains(x.rawEl));
        const nearest = prevHeaders[prevHeaders.length - 1];
        return nearest && monthKey(nearest) === targetKey;
      });
      if (matched.length) return matched[0].el;
    }

    return raw[0]?.el || null;
  }

  async function chooseDate(dateText, row = null) {
    if (!(await openDatePicker())) return false;

    const target = normalizeTargetDate(row || dateText);
    sendLog(`準備選日期：${dateText}；目前日曆：${visibleMonthLabel()}`, "info");

    if (!(await ensureCalendarMonthVisible(target))) {
      sendLog(`找不到月份：${target.year || ""}年${target.month || ""}月`, "warn");
      return false;
    }

    const el = findDateElement(dateText, row);
    if (!el) return false;
    if (!safeClick(el)) return false;

    const day = String(target.day || "");
    const month = String(target.month || "");
    const ok = await waitFor(() => {
      const picked = norm(currentDatePickerText());
      return picked.includes(day) && (!month || picked.includes(`${month}月`));
    }, 900, 50);

    if (!ok) sendLog(`日期點擊後頁面顯示為：${currentDatePickerText() || "空白"}`, "warn");
    return !!ok;
  }

  function timeElements() {
    const timeRegex = /^([01]?\d|2[0-3]):[0-5]\d$/;

    // Inline 的時間文字在 button 內的 span；舊版用「面積最小」去重，
    // 會讓 DOM / 時間順序被打亂，導致 14:00-18:00 可能選到 17:10。
    // 這裡改成以真正的 button.time-slot 為主，最後一律依分鐘數由小到大排序。
    const buttons = [...document.querySelectorAll("button.time-slot, button[data-cy^='book-now-time-slot-box-'], [role='button'].time-slot")]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => {
        const text = (el.innerText || el.textContent || "").trim().match(timeRegex)?.[0] || "";
        const rect = el.getBoundingClientRect();
        const parentText = (el.innerText || el.textContent || text).trim();
        const isWaitlist = /候補|登記候補|候位/.test(parentText);
        return { el, text, parentText, isWaitlist, area: rect.width * rect.height, rect, min: parseClockToMin(text) };
      })
      .filter(x => timeRegex.test(x.text))
      .filter(x => x.rect.width <= 260 && x.rect.height <= 130)
      .filter(x => !x.isWaitlist);

    const uniq = [];
    const seen = new Set();
    for (const x of buttons) {
      const key = x.text;
      if (!seen.has(key)) { seen.add(key); uniq.push(x); }
    }

    return uniq.sort((a, b) => (a.min ?? 99999) - (b.min ?? 99999));
  }

  function findTimeButton(times, opts = {}) {
    const candidates = timeElements();
    if (!candidates.length) return null;
    const targets = (times || []).map(t => norm(t));
    if (targets.length) {
      for (const target of targets) {
        const hit = candidates.find(x => norm(x.text) === target);
        if (hit) return hit;
      }
      return null;
    }
    return candidates[0] || null;
  }

  function findTimeByPredicate(predicate, opts = {}) {
    const candidates = timeElements();
    return candidates.find(x => predicate(x.text, x)) || null;
  }

  function findAnySelectableDateElements() {
    return [...document.querySelectorAll("button, [role='button'], div, span, a")]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => {
        const text = norm(el.innerText || el.textContent || "");
        const rect = el.getBoundingClientRect();
        return { el: el.closest("button, [role='button']") || el, text, rect, area: rect.width * rect.height };
      })
      .filter(x => /^\d{1,2}$/.test(x.text))
      .filter(x => !x.el.closest(".prevMonth, .nextMonth"))
      .filter(x => x.rect.width <= 100 && x.rect.height <= 100)
      .sort((a, b) => a.area - b.area);
  }

  async function choosePeople() {
    if (CONFIG.adultCount) {
      if (setSelectValue("#adult-picker", `${CONFIG.adultCount}位大人`) || setSelectValue("#adult-picker", String(CONFIG.adultCount))) {
        sendLog(`已選大人：${CONFIG.adultCount}`, "success");
      }
    }
    if (CONFIG.kidCount !== "" && CONFIG.kidCount !== undefined && CONFIG.kidCount !== null) {
      if (setSelectValue("#kid-picker", `${CONFIG.kidCount}位小孩`) || setSelectValue("#kid-picker", String(CONFIG.kidCount))) {
        sendLog(`已選小孩：${CONFIG.kidCount}`, "success");
      }
    }
    await delay(120);
  }

  async function tryRule(rule, opts = {}) {
    if (!isRunning) return null;
    const modeText = opts.waitlist ? "候補" : "可訂";
    sendLog(`檢查順位：${rule.label || rule.dateText}（${modeText}）`, "info");

    const dateOk = await chooseDate(rule.dateText, rule);
    if (!dateOk) {
      sendLog(`日期不可選或未選成功：${rule.dateText}`, "warn");
      return null;
    }
    sendLog(`已選日期：${rule.dateText}`, "success");
    await delay(600);

    const hit = await waitFor(() => findTimeButton(rule.times), 1800, 100);
    if (!hit) {
      sendLog(`此日期找不到可訂時段：${rule.times?.length ? rule.times.join(",") : "任一時段"}`, "warn");
      return null;
    }
    safeClick(hit.el);
    await delay(800);
    sendLog(`已選時段：${hit.text}`, "success");
    return { dateText: rule.dateText, timeText: hit.text, waitlist: !!opts.waitlist };
  }

  async function tryTimeOnly(rules) {
    const times = allPreferredTimes(rules);
    if (!times.length) return null;
    sendLog(`Fallback：只看時間，尋找 ${times.join(",")}`, "warn");
    await openDatePicker();
    const dates = findAnySelectableDateElements().slice(0, 45);
    for (const d of dates) {
      if (!isRunning) return null;
      safeClick(d.el);
      await delay(600);
      const hit = findTimeButton(times, { includeWaitlist: false });
      if (hit) {
        safeClick(hit.el);
        await delay(800);
        sendLog(`Fallback 成功：任一日期 + ${hit.text}`, "success");
        return { dateText: currentDatePickerText(), timeText: hit.text, fallback: "timeOnly" };
      }
      await openDatePicker();
    }
    sendLog("Fallback 只看時間仍找不到", "warn");
    return null;
  }

  async function tryDateOnly(rules) {
    sendLog("Fallback：只看日期，該日期任一可訂時段都接受", "warn");
    for (const rule of rules) {
      if (!isRunning) return null;
      const dateOk = await chooseDate(rule.dateText, rule);
      if (!dateOk) continue;
      await delay(600);
      const hit = findTimeButton([], { includeWaitlist: false });
      if (hit) {
        safeClick(hit.el);
        await delay(800);
        sendLog(`Fallback 成功：${rule.dateText} + 任一時段 ${hit.text}`, "success");
        return { dateText: rule.dateText, timeText: hit.text, fallback: "dateOnly" };
      }
    }
    sendLog("Fallback 只看日期仍找不到", "warn");
    return null;
  }

  async function tryExactRows(rows) {
    for (const row of rows) {
      if (!isRunning) return null;
      const dateText = row.dateText || row.date;
      const time = row.time;
      sendLog(`第一順位檢查：${dateText} ${time}（可訂）`, "info");
      if (!(await chooseDate(dateText, row))) {
        sendLog(`日期不可選或未選成功：${dateText}`, "warn");
        continue;
      }
      await delay(100);
      const hit = await waitFor(() => findTimeButton([time]), 1800, 100);
      if (hit) {
        safeClick(hit.el);
        await delay(100);
        sendLog(`第一順位成功：${dateText} ${hit.text}`, "success");
        return { dateText, timeText: hit.text, stage: "exact" };
      }
      sendLog(`第一順位不可用：${dateText} ${time}`, "warn");
    }
    return null;
  }

  async function tryRangeRows(rows) {
    for (const row of rows) {
      if (!isRunning) return null;
      const dateText = row.dateText || row.date;
      sendLog(`第二順位檢查：${dateText} ${row.start}-${row.end}（可訂）`, "info");
      if (!(await chooseDate(dateText, row))) {
        sendLog(`日期不可選或未選成功：${dateText}`, "warn");
        continue;
      }
      await delay(250);
      const hit = await waitFor(() => findTimeByPredicate(t => timeInRange(t, row.start, row.end)), 1800, 100);
      if (hit) {
        safeClick(hit.el);
        await delay(250);
        sendLog(`第二順位成功：${dateText} ${hit.text}`, "success");
        return { dateText, timeText: hit.text, stage: "range" };
      }
      sendLog(`第二順位不可用：${dateText} ${row.start}-${row.end}`, "warn");
    }
    return null;
  }

  async function tryAnyRows(rows) {
    for (const row of rows) {
      if (!isRunning) return null;
      const dateText = row.dateText || row.date;
      sendLog(`第三順位檢查：${dateText} 全部可訂時間（可訂）`, "info");
      if (!(await chooseDate(dateText, row))) {
        sendLog(`日期不可選或未選成功：${dateText}`, "warn");
        continue;
      }
      await delay(250);
      const hit = await waitFor(() => findTimeButton([]), 2000, 100);
      if (hit) {
        safeClick(hit.el);
        await delay(250);
        sendLog(`第三順位成功：${dateText} ${hit.text}`, "success");
        return { dateText, timeText: hit.text, stage: "any" };
      }
      sendLog(`第三順位不可用：${dateText} 全部可訂時間`, "warn");
    }
    return null;
  }

  async function chooseByPlan(plan) {
    return (await tryExactRows(plan.exact))
      || (await tryRangeRows(plan.range))
      || (await tryAnyRows(plan.any));
  }

  async function chooseByPriority() {
    await choosePeople();
    const plan = getPriorityPlanRules();

    if (!planHasRows(plan)) {
      sendLog("沒有可用的三段式順位設定", "error");
      return null;
    }

    const selected = await chooseByPlan(plan);
    if (selected) return selected;

    sendLog("三段式順位都不可選", "warn");
    return null;
  }

  function getClickableRoot(el) {
    if (!el) return null;
    return el.closest("button, [role='button'], a") || el;
  }

  function clickableArea(el) {
    const rect = el?.getBoundingClientRect?.();
    if (!rect) return 99999999;
    return rect.width * rect.height;
  }

  function findInlineSubmitButton(opts = {}) {
    const root = opts.root || document;
    const spinnerSelector = "[data-cy='submit-button-spinner']";

    const candidates = [...root.querySelectorAll(spinnerSelector)]
      .map(spinner => getClickableRoot(spinner))
      .filter(Boolean)
      .filter(el => !opts.exclude || !opts.exclude(el))
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => ({ el, area: clickableArea(el), top: el.getBoundingClientRect().top }))
      .sort((a, b) => (a.area - b.area) || (a.top - b.top));

    if (candidates.length) return candidates[0].el;

    // 結構備援：Inline 有些版本會把 submit 標在 button 本體，而不是 spinner。
    const structuralFallbacks = [
      "button[data-cy='submit']",
      "[role='button'][data-cy='submit']",
      "button[type='submit']"
    ];

    for (const selector of structuralFallbacks) {
      const hit = [...root.querySelectorAll(selector)]
        .filter(el => !opts.exclude || !opts.exclude(el))
        .filter(isVisible)
        .filter(el => !isDisabled(el))
        .sort((a, b) => clickableArea(a) - clickableArea(b))[0];
      if (hit) return hit;
    }

    return null;
  }

  function clickText(texts, opts = {}) {
    const arr = Array.isArray(texts) ? texts : [texts];
    const wanted = arr.map(norm).filter(Boolean);
    if (!wanted.length) return false;
    const root = opts.root || document;
    const candidates = [...root.querySelectorAll(opts.selector || "button, [role='button'], [role='checkbox'], label, div, span, a")]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .filter(el => !opts.exclude || !opts.exclude(el));
    const found = candidates.find(el => {
      const t = norm(el.innerText || el.textContent || el.value || el.getAttribute("aria-label"));
      if (!t) return false;
      return wanted.some(w => opts.exact ? t === w : t.includes(w));
    });
    return safeClick(found);
  }

  function chooseGender() {
    const g = norm(CONFIG.gender || "");
    if (!g) return;
    let id = "";
    if (["先生", "男", "male", "0"].includes(g)) id = "#gender-male";
    if (["小姐", "女", "female", "1"].includes(g)) id = "#gender-female";
    if (["其他", "none", "2"].includes(g)) id = "#gender-none";
    if (id) safeClick(document.querySelector(id));
  }

  function clickPurpose() {
    const purposes = Array.isArray(CONFIG.purposes) ? CONFIG.purposes : String(CONFIG.purpose || "").split(",");
    purposes.map(s => s.trim()).filter(Boolean).forEach(p => clickText(p, { selector: "[role='checkbox'], label, div, span" }));
  }

  function checkAgreement() {
    if (CONFIG.autoAgree === false) return;
    const labels = [...document.querySelectorAll("label")].filter(l => /服務條款|隱私權|同意/.test(l.innerText || l.textContent || ""));
    for (const label of labels) {
      const checkbox = label.querySelector("button[role='checkbox'], [role='checkbox'], input[type='checkbox']") || label;
      const checked = checkbox.getAttribute?.("aria-checked") === "true" || checkbox.checked;
      if (!checked) safeClick(checkbox);
    }
  }

  // ── 偵測當前 Inline 流程階段 ─────────────────────────────────────

  function isSuccessUrl() {
    return /\/reservations\/[^/]+\/success(?:[?#].*)?$/.test(window.location.href);
  }

  function hasReservationSummarySignature() {
    return !!(
      document.querySelector("[data-cy='rsv-date']") &&
      document.querySelector("[data-cy='rsv-time']") &&
      document.querySelector("[data-cy='group-size']")
    );
  }

  function hasSuccessMessageSignature() {
    return !!document.querySelector("[data-cy='booking-success-message']");
  }

  function hasCalendarModalSignature() {
    return !!(
      document.querySelector("button[name='calendarModalAcceptButton']") ||
      document.querySelector("button[name='calendarModalRejectButton']") ||
      document.querySelector("button[name='calendarModalCloseButton']") ||
      [...document.querySelectorAll(".ReactModal__Content[role='dialog'], .ReactModal__Content")]
        .some(el => /是否幫您把訂位加到行事曆/.test(el.innerText || el.textContent || ""))
    );
  }

  function hasSuccessReservationObject() {
    return !!(
      window.appGlobal?.reservation?._key &&
      window.appGlobal?.reservation?.reservationTime &&
      window.appGlobal?.reservation?.groupSize
    );
  }

  // 頁面階段判斷用：URL 已到 success 就視為 SUCCESS，避免流程誤判成 UNKNOWN。
  function hasSuccessPageSignature() {
    return isSuccessUrl() || (hasReservationSummarySignature() && hasSuccessReservationObject());
  }

  // 最終完成判斷用：必須看到成功頁核心 DOM，不能只看 URL。
  function getSuccessDiagnostics() {
    const url = isSuccessUrl();
    const summary = hasReservationSummarySignature();
    const appGlobal = hasSuccessReservationObject();
    const message = hasSuccessMessageSignature();
    const modal = hasCalendarModalSignature();

    // 注意：content script 跑在 Chrome isolated world，通常不能可靠讀取頁面本身的 window.appGlobal。
    // 因此 appGlobal 只保留為診斷資訊，不再作為成功必要條件。
    // 真正成功條件以 URL + 訂位摘要 DOM + 成功訊息/行事曆彈窗為準。
    const complete = !!(url && summary && (message || modal));

    return { url, summary, appGlobal, message, modal, complete };
  }

  function formatSuccessDiagnostics(d) {
    return `url=${d.url ? "Y" : "N"} / summary=${d.summary ? "Y" : "N"} / appGlobal=${d.appGlobal ? "Y" : "N"} / message=${d.message ? "Y" : "N"} / modal=${d.modal ? "Y" : "N"} / complete=${d.complete ? "Y" : "N"}`;
  }

  function hasSuccessCompleteSignature() {
    return getSuccessDiagnostics().complete;
  }

  function hasFormPageSignature() {
    if (/\/booking\/[^/]+\/[^/]+\/form(?:[?#].*)?$/.test(window.location.href)) return true;
    return !!(document.querySelector("#contact-form") || document.querySelector("#name, #familyName, #givenName, #phone, #email, [data-cy='name'], [data-cy='familyName'], [data-cy='phone'], [data-cy='email'], [data-cy='booking-payment-form']"));
  }

  function hasBookingPageSignature() {
    if (/\/booking\/[^/]+\/[^/]+(?:[?#].*)?$/.test(window.location.href)) return true;
    return !!document.querySelector("#date-picker, [data-cy='date-picker']");
  }

  function detectPageType() {
    if (hasSuccessPageSignature()) return "SUCCESS";
    if (hasFormPageSignature()) return "FORM";
    if (hasBookingPageSignature()) return "BOOKING";
    return "UNKNOWN";
  }

  async function waitForPageType(expectedTypes, timeout = WAIT_FORM_TIMEOUT_MS, interval = WAIT_PAGE_INTERVAL_MS) {
    const expected = new Set(Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes]);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isRunning) return null;
      const pageType = detectPageType();
      if (expected.has(pageType)) return pageType;
      await delay(interval);
    }
    return null;
  }

  function normalizeBookingUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    try {
      const u = new URL(raw, window.location.origin);
      const m = u.pathname.match(/^(\/booking\/[^/]+\/[^/]+)(?:\/form)?\/?$/);
      if (!m) return "";
      return `${u.origin}${m[1]}`;
    } catch (_) {
      return "";
    }
  }

  function getBookingUrlFromCurrentPage() {
    const direct = normalizeBookingUrl(window.location.href);
    if (direct) return direct;

    const app = window.appGlobal || {};
    const companyId = app.branch?.companyId || app.company?._key || app.reservation?.company?.companyId;
    const branchId = app.branch?._key || app.reservation?.branch?.branchId;
    if (companyId && branchId) {
      return `${window.location.origin}/booking/${companyId}/${branchId}`;
    }

    const logoLink = document.querySelector("a[href^='/booking/'], a[href*='/booking/']")?.getAttribute("href");
    return normalizeBookingUrl(logoLink);
  }

  function getTargetBookingUrl() {
    return normalizeBookingUrl(CONFIG.bookingUrl)
      || normalizeBookingUrl(CONFIG.targetUrl)
      || normalizeBookingUrl(CONFIG.url)
      || getBookingUrlFromCurrentPage();
  }

  async function goToBookingPage(reason = "無法辨識當前 Inline 頁面") {
    if (await alreadyCompletedGuard(reason)) return true;
    const target = getTargetBookingUrl();
    if (!target) {
      sendLog(`${reason}，且找不到可跳回的訂位網址`, "error");
      isRunning = false;
      return false;
    }

    sendLog(`${reason}，跳回訂位頁`, "warn");
    navigationInProgress = true;
    currentPhase = "NAVIGATING";
    if (WAIT_REDIRECT_BOOKING_MS > 0) await delay(WAIT_REDIRECT_BOOKING_MS);
    window.location.href = target;
    return true;
  }

  async function finishInlineDone(message = "已確認訂位成功頁與成功訊息/行事曆彈窗") {
    if (inlineDone || currentPhase === "DONE") return true;
    inlineDone = true;
    currentPhase = "DONE";
    isRunning = false;
    finalReadyEmitted = true;
    window.__INLINE_HELPER_FINAL_READY__ = true;
    await storageSet({ inline_isRunning: false });
    await storageRemove(["inline_successReloadCount", "inline_runningConfig"]);
    sendEvent("DONE", message, "success");
    return true;
  }

  async function alreadyCompletedGuard(reason = "") {
    if (inlineDone || currentPhase === "DONE") return true;
    if (detectPageType() === "SUCCESS") {
      if (reason) sendLog(`${reason}，但已偵測到成功頁完整特徵，停止後續動作`, "success");
      await finishInlineDone();
      return true;
    }
    const running = await storageGet(["inline_isRunning"]);
    return running.inline_isRunning === false;
  }

  async function reloadAfterDelay(reason = "Inline submit 後未進入預期頁面") {
    if (await alreadyCompletedGuard(reason)) return false;
    const ms = Math.max(500, Number(CONFIG.reloadDelay || 2) * 1000);
    sendEvent("RELOAD", `${reason}，等待 ${Math.round(ms / 1000)} 秒後重新整理`, "warn");
    navigationInProgress = true;
    currentPhase = "RELOADING";
    await delay(ms);
    if (await alreadyCompletedGuard(reason)) return false;
    window.location.reload();
    return true;
  }

  async function goToBookingPageOnError(reason) {
    await storageRemove("inline_successReloadCount");
    return goToBookingPage(reason);
  }

  async function handleIncompleteSuccessPage(reason) {
    const result = await storageGet(["inline_successReloadCount"]);
    const count = Number(result.inline_successReloadCount || 0);

    if (count < MAX_SUCCESS_RELOAD) {
      await storageSet({ inline_successReloadCount: count + 1 });
      await reloadAfterDelay(`${reason}，先重整 success 頁第 ${count + 1} 次`);
      return false;
    }

    await storageRemove("inline_successReloadCount");
    await goToBookingPage(reason + "，重整後仍不完整");
    return false;
  }

  // ── Inline 流程步驟 ─────────────────────────────────────────────

  async function clickBookingSubmit() {
    const clicked = await waitFor(() => {
      const excludeContactFormButton = el => !!el.closest?.("#contact-form");
      return safeClick(findInlineSubmitButton({ exclude: excludeContactFormButton }));
    }, WAIT_SUBMIT_BUTTON_TIMEOUT_MS, 150);

    if (!clicked) {
      sendLog("已選時段，但找不到前置 submit 結構按鈕", "warn");
      return false;
    }

    sendLog("已點擊前置 submit，檢查是否進入聯絡資訊頁", "success");
    return true;
  }

  async function bookingStep() {
    currentPhase = "BOOKING";

    const bookingReady = await waitFor(() => hasBookingPageSignature(), 2500, 50);
    if (!bookingReady) {
      await goToBookingPageOnError("BOOKING 頁等待過久，尚未載入日期選擇器");
      return false;
    }

    const selected = await chooseByPriority();

    if (!selected) {
      if (CONFIG.reloadOnNoTime) {
        await reloadAfterDelay("Inline 全部順位不可用");
      } else {
        sendLog("Inline 全部順位不可用，流程停止", "warn");
        isRunning = false;
      }
      return false;
    }

    if (!(await clickBookingSubmit())) {
      await goToBookingPageOnError("已選時段但找不到前置 submit 按鈕");
      return false;
    }

    const nextPage = await waitForPageType(["FORM", "SUCCESS"], WAIT_FORM_TIMEOUT_MS, WAIT_PAGE_INTERVAL_MS);

    if (nextPage === "SUCCESS") {
      sendLog("前置 submit 後直接進入 SUCCESS", "success");
      return successStep();
    }

    if (nextPage === "FORM") {
      await storageRemove("inline_successReloadCount");
      sendLog("已進入聯絡資訊頁", "success");
      return formStep();
    }

    await goToBookingPageOnError("前置 submit 後等待過久，未偵測到聯絡資訊頁或成功頁");
    return false;
  }

  function fillContactFields() {
    const formRoot = findFormRoot();
    const hasForm = formRoot !== document
      || document.querySelector("#name, #familyName, #givenName, #phone, #email, [data-cy='name'], [data-cy='familyName'], [data-cy='phone'], [data-cy='email'], [data-cy='booking-payment-form']");
    if (!hasForm) return false;

    logFormVersionOnce(formRoot);

    const results = {
      name: fillNameFields(formRoot),
      phone: fillPhoneField(formRoot),
      email: fillEmailField(formRoot),
      note: fillNoteField(formRoot),
      cardholderName: fillCardholderNameField(formRoot)
    };

    chooseGender();
    clickPurpose();
    checkAgreement();

    const failed = Object.entries(results)
      .filter(([key, ok]) => CONFIG[key] && !ok)
      .map(([key]) => key);
    if (failed.length) sendLog(`聯絡資訊部分欄位找不到或填寫失敗：${failed.join(", ")}`, "warn");

    const validationErrors = hasVisibleValidationError(formRoot);
    if (validationErrors.length) sendLog(`表單目前仍有可見驗證訊息：${validationErrors.slice(0, 4).join("、")}`, "warn");

    return true;
  }

  async function clickFormSubmit() {
    const formRoot = document.querySelector("#contact-form") || document;
    const finalBtn = await waitFor(() => findInlineSubmitButton({ root: formRoot }), WAIT_SUBMIT_BUTTON_TIMEOUT_MS, 150);

    if (!finalBtn) {
      sendLog("找不到最終 submit 結構按鈕", "warn");
      return false;
    }

    const securePayment = detectSecurePaymentBlock(formRoot);
    if (securePayment.required) {
      finalBtn.scrollIntoView({ block: "center" });
      finalReadyEmitted = true;
      window.__INLINE_HELPER_FINAL_READY__ = true;

      await hydrateCardConfigFromStorageIfNeeded();

      if (!hasCardAutoFillConfig()) {
        isRunning = false;
        await storageSet({ inline_isRunning: false });
        sendEvent("FINAL_READY", "偵測到信用卡綁定 / 付款版 Inline 表單；未設定完整卡號 / 效期 / CCV，已停在確認訂位前。", "warn");
        sendLog("偵測到信用卡綁定 / 付款版表單，但未設定完整卡號 / 效期 / CCV，已停止在最終送出前。", "warn");
        return false;
      }

      sendLog("TapPay rebuild v2：偵測到信用卡 iframe，開始依序預填卡號 / 效期 / 安全碼", "info");
      const cardOk = await fillTapPayFieldsSequential(formRoot);
      if (!cardOk) {
        isRunning = false;
        await storageSet({ inline_isRunning: false });
        sendEvent("FINAL_READY", "信用卡欄位未通過 Inline / TapPay 驗證，已停在確認訂位前。", "warn");
        return false;
      }

      if (CONFIG.autoSubmitPayment !== true) {
        isRunning = false;
        await storageSet({ inline_isRunning: false });
        sendEvent("FINAL_READY", "信用卡欄位已通過父頁驗證，已停在確認訂位前。", "success");
        sendLog("信用卡欄位已通過父頁驗證；依設定停在最終送出前。", "success");
        return false;
      }

      sendLog("信用卡欄位已通過父頁驗證；依設定自動確認訂位。", "success");
    }

    finalBtn.scrollIntoView({ block: "center" });
    await delay(120);
    finalReadyEmitted = true;
    window.__INLINE_HELPER_FINAL_READY__ = true;
    safeClick(finalBtn);
    sendLog("已點擊最終 submit，檢查是否進入訂位成功頁", "success");
    return true;
  }

  async function formStep() {
    currentPhase = "FORM";

    const formReady = await waitFor(() => hasFormPageSignature(), WAIT_FORM_READY_TIMEOUT_MS, WAIT_PAGE_INTERVAL_MS);
    if (!formReady) {
      await goToBookingPageOnError("等待過久，未偵測到聯絡資訊表單");
      return false;
    }

    if (!fillContactFields()) {
      await goToBookingPageOnError("聯絡資訊表單存在但欄位填寫失敗");
      return false;
    }

    await delay(120);

    if (!(await clickFormSubmit())) {
      // 付款表單若刻意停在確認前、或信用卡資料不完整，不要跳回訂位頁重跑。
      if (finalReadyEmitted && !isRunning) return false;
      await goToBookingPageOnError("找不到最終 submit 按鈕");
      return false;
    }

    const success = await waitForPageType("SUCCESS", WAIT_SUCCESS_TIMEOUT_MS, WAIT_PAGE_INTERVAL_MS);
    if (success === "SUCCESS") {
      sendLog("已偵測到 SUCCESS 頁面，開始驗證成功特徵", "success");
      return successStep();
    }

    await goToBookingPageOnError("最終 submit 後等待過久，未偵測到訂位成功頁");
    return false;
  }

  async function successStep() {
    if (inlineDone || currentPhase === "DONE") return true;

    currentPhase = "SUCCESS";
    sendLog("已進入訂位成功頁，流程完成", "success");

    return finishInlineDone("已進入訂位成功頁");
  }

  // ── 主流程 ─────────────────────────────────────────────────────

  async function runFlow(myToken) {
    const pageType = detectPageType();
    sendLog(`偵測到 Inline 頁面類型：${pageType}`, "info");
    sendLog("Inline 自動流程啟動", "info");

    try {
      if (myToken !== runToken || !isRunning) return;

      if (pageType === "BOOKING") {
        await bookingStep();
      } else if (pageType === "FORM") {
        await formStep();
      } else if (pageType === "SUCCESS") {
        await successStep();
      } else {
        await goToBookingPage("無法辨識當前 Inline 頁面");
      }
    } catch (err) {
      sendEvent("ERROR", `Inline 流程錯誤：${err.message}`, "error");
      await goToBookingPageOnError("Inline 流程錯誤");
    } finally {
      if (currentPhase !== "DONE" && !navigationInProgress) isRunning = false;
    }
  }

  // ── 監聽 popup 傳入的指令 ───────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "updateGlobalEnabled") {
      if (msg.enabled === false) isRunning = false;
      sendResponse?.({ ok: true });
      return true;
    }

    if (msg.action === "STOP") {
      isRunning = false;
      navigationInProgress = false;
      currentPhase = "IDLE";
      storageSet({ inline_isRunning: false });
      storageRemove(["inline_runningConfig", "inline_successReloadCount"]);
      runToken++;
      sendLog("Inline 流程已停止", "warn");
      sendResponse?.({ log: "Inline 已停止", type: "warn" });
      return true;
    }

    if (msg.action === "START") {
      const pageType = detectPageType();

      if (pageType === "SUCCESS") {
        CONFIG = { ...msg };
        delete CONFIG.action;
        storageSet({ inline_isRunning: true, inline_runningConfig: CONFIG });
        isRunning = true;
        navigationInProgress = false;
        currentPhase = "STARTING";
        const token = ++runToken;
        sendResponse?.({ log: "Inline 已在訂位成功頁，開始檢查成功特徵", type: "success" });
        runFlow(token);
        return true;
      }

      if (isRunning && currentPhase !== "IDLE" && currentPhase !== "DONE") {
        sendResponse?.({ log: "Inline 流程已在執行中，忽略重複 START", type: "warn" });
        return true;
      }

      CONFIG = { ...msg };
      delete CONFIG.action;
      storageSet({ inline_isRunning: true, inline_runningConfig: CONFIG });
      isRunning = true;
      navigationInProgress = false;
      inlineDone = false;
      finalReadyEmitted = false;
      window.__INLINE_HELPER_FINAL_READY__ = false;
      currentPhase = "STARTING";
      const token = ++runToken;
      sendResponse?.({ log: "Inline 已收到 START", type: "success" });
      runFlow(token);
      return true;
    }
  });

  async function autoResumeIfRunning() {
    const result = await storageGet(["inline_isRunning", "inline_runningConfig"]);
    if (!result.inline_isRunning || !result.inline_runningConfig || isRunning) return;

    CONFIG = { ...result.inline_runningConfig };
    isRunning = true;
    inlineDone = false;
    currentPhase = "AUTO_RESUME";
    const token = ++runToken;
    sendLog("偵測到 Inline 流程仍在執行中，自動接續檢查", "info");
    if (detectPageType() === "SUCCESS") {
      await finishInlineDone("已進入訂位成功頁");
      return;
    }
    runFlow(token);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoResumeIfRunning, { once: true });
  } else {
    autoResumeIfRunning();
  }
})();