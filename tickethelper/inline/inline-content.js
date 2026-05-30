// ============================================================
// inline/inline-content.refactor.js — Inline 訂位助手 內容腳本（Tixcraft 風格重構版）
//
// 目標：
//   1. 保留原本已測試過的選日期、選時間、填資料與送出結果。
//   2. 將流程命名、狀態控制、訊息處理方式整理成接近 tixcraft-content.js 的風格。
//   3. 不新增 CAPTCHA / PX 驗證處理。
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
  const WAIT_FORM_TIMEOUT_MS = 5000;

  // 聯絡資訊頁點擊 submit 後，等待進入 /success 的時間。
  const WAIT_SUCCESS_TIMEOUT_MS = 6000;

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
      // fn 可能是同步函式，也可能是 async 函式。
      // v9 這裡沒有 await，導致 fillContactForm() 的 Promise 被當成「已找到」，
      // 實際只檢查一次就結束，所以畫面已到聯絡頁時仍不會填。
      const result = await fn();
      if (result) return result;
      await delay(interval);
    }
    return null;
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

  function visibleCalendarText() {
    return document.body.innerText || "";
  }

  function findCalendarHeaders() {
    return [...document.querySelectorAll("button, [role='button'], div, span")]
      .filter(isVisible)
      .map(el => {
        const text = (el.innerText || el.textContent || "").trim();
        const m = text.match(/(\d{4})年\s*(\d{1,2})月/);
        if (!m) return null;
        const rect = el.getBoundingClientRect();
        return { el, year: Number(m[1]), month: Number(m[2]), text, top: rect.top, left: rect.left, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.area - b.area));
  }

  function domBefore(a, b) {
    if (!a || !b || a === b) return false;
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function monthKey(obj) {
    if (!obj?.year || !obj?.month) return "";
    return `${obj.year}-${String(obj.month).padStart(2, "0")}`;
  }

  async function ensureCalendarMonthVisible(target) {
    if (!target.year || !target.month) return true;
    const headerText = `${target.year}年${target.month}月`;
    for (let i = 0; i < 14; i++) {
      if (visibleCalendarText().includes(headerText)) return true;
      const nextBtn = [...document.querySelectorAll("button, [role='button'], div, span, a")]
        .filter(isVisible)
        .filter(el => !isDisabled(el))
        .map(el => {
          const t = norm(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
          const rect = el.getBoundingClientRect();
          return { el: el.closest("button, [role='button']") || el, t, area: rect.width * rect.height };
        })
        .filter(x => x.t === "+" || /下一|下個|next|›|»|〉|＞/.test(x.t))
        .sort((a, b) => a.area - b.area)[0]?.el;
      if (!nextBtn || !safeClick(nextBtn)) return false;
      await delay(250);
    }
    return visibleCalendarText().includes(headerText);
  }

  async function openDatePicker() {
    const datePicker = document.querySelector("#date-picker, [data-cy='date-picker']");
    if (!datePicker) return false;
    if (datePicker.getAttribute("aria-expanded") !== "true") {
      safeClick(datePicker);
      await delay(250);
    }
    return true;
  }

  function findDateElement(dateText, row = null) {
    const target = rowDateParts(row || dateText);
    if (!target.day) return null;

    const dayText = String(target.day);
    const headers = findCalendarHeaders();
    const targetKey = monthKey(target);

    const raw = [...document.querySelectorAll("button, [role='button'], div, span, a")]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => {
        const text = norm(el.innerText || el.textContent || "");
        const rect = el.getBoundingClientRect();
        const clickable = el.closest("button, [role='button']") || el;
        return { el: clickable, rawEl: el, text, rect, area: rect.width * rect.height };
      })
      .filter(x => x.text === dayText || x.text === `${target.month || ""}月${dayText}日` || x.text.includes(norm(dateText)))
      .filter(x => !x.el.closest(".prevMonth, .nextMonth"))
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

      // fallback：以畫面座標判斷在同一個月份區塊附近，避免 5/29 與 6/29 同時出現時點錯前一個月
      const targetHeaders = headers.filter(h => monthKey(h) === targetKey);
      if (targetHeaders.length) {
        const h = targetHeaders[targetHeaders.length - 1];
        const hr = h.el.getBoundingClientRect();
        const spatial = raw.filter(x => x.rect.top > hr.top && Math.abs(x.rect.left - hr.left) < 420);
        if (spatial.length) return spatial[0].el;
      }
    }

    return raw[0]?.el || null;
  }

  async function chooseDate(dateText, row = null) {
    await openDatePicker();
    const target = rowDateParts(row || dateText);
    if (!(await ensureCalendarMonthVisible(target))) {
      sendLog(`找不到月份：${target.year || ""}年${target.month || ""}月`, "warn");
      return false;
    }

    const el = findDateElement(dateText, row);
    if (!el) return false;
    if (!safeClick(el)) return false;

    await delay(200);
    const picked = norm(currentDatePickerText());
    const day = String(target.day || "");
    const month = String(target.month || "");
    const ok = picked.includes(day) && (!month || picked.includes(`${month}月`));
    if (!ok) sendLog(`日期點擊後頁面顯示為：${currentDatePickerText() || "空白"}`, "warn");
    return ok;
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
    return !!(document.querySelector("#contact-form") || document.querySelector("#name, #phone, #email"));
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
    if (detectPageType() === "SUCCESS" && hasSuccessCompleteSignature()) {
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
    const hasForm = document.querySelector("#contact-form") || document.querySelector("#name, #phone, #email");
    if (!hasForm) return false;

    if (CONFIG.name) setNativeValue(document.querySelector("#name, [data-cy='name'], input[autocomplete='name']"), CONFIG.name);
    chooseGender();
    if (CONFIG.phone) setNativeValue(document.querySelector("#phone, [data-cy='phone'], input[type='tel']"), CONFIG.phone);
    if (CONFIG.email) setNativeValue(document.querySelector("#email, [data-cy='email'], input[type='email']"), CONFIG.email);
    clickPurpose();
    if (CONFIG.note) {
      const textarea = document.querySelector("textarea, [data-cy='note'], [data-cy='memo']");
      if (textarea) setNativeValue(textarea, CONFIG.note);
    }
    checkAgreement();
    return true;
  }

  async function clickFormSubmit() {
    const formRoot = document.querySelector("#contact-form") || document;
    const finalBtn = await waitFor(() => findInlineSubmitButton({ root: formRoot }), WAIT_SUBMIT_BUTTON_TIMEOUT_MS, 150);

    if (!finalBtn) {
      sendLog("找不到最終 submit 結構按鈕", "warn");
      return false;
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
    if (successCheckInProgress) return true;
    successCheckInProgress = true;
    currentPhase = "SUCCESS";
    sendLog("已進入訂位成功頁，等待成功訊息或行事曆彈窗", "info");

    const complete = await waitFor(() => {
      const d = getSuccessDiagnostics();
      console.log(`[Inline助手] success check: ${formatSuccessDiagnostics(d)}`);
      return d.complete;
    }, WAIT_SUCCESS_READY_TIMEOUT_MS, WAIT_PAGE_INTERVAL_MS);

    const finalDiagnostics = getSuccessDiagnostics();
    console.log(`[Inline助手] final success check: ${formatSuccessDiagnostics(finalDiagnostics)}`);

    if (!complete) {
      successCheckInProgress = false;
      return handleIncompleteSuccessPage("已到 success 頁，但未偵測到成功頁完整特徵");
    }

    const done = await finishInlineDone("已確認訂位成功頁與成功訊息/行事曆彈窗");
    successCheckInProgress = false;
    return done;
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
    if (detectPageType() === "SUCCESS" && hasSuccessCompleteSignature()) {
      const d = getSuccessDiagnostics();
      console.log(`[Inline助手] auto-resume success check: ${formatSuccessDiagnostics(d)}`);
      finishInlineDone("已確認訂位成功頁與成功訊息/行事曆彈窗");
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
