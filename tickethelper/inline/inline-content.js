// ============================================================
// inline/inline-content.js
// Inline 訂位輔助：自動完成前置選擇與聯絡資訊填寫，停在最後確認訂位前。
// 不處理 CAPTCHA / PX 驗證，不自動按最終「確認訂位」送出。
// v9: 修正點完成預訂後重跑選位；視窗寬度恢復初版。
// ============================================================

(() => {
  if (window.__INLINE_HELPER_LOADED__) return;
  window.__INLINE_HELPER_LOADED__ = true;

  let running = false;
  let config = {};
  let runToken = 0;
  let doneEmitted = false;
  let phase = "IDLE";

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function emit(event, text, type = "info") {
    try { chrome.runtime.sendMessage({ from: "inline-content", event, text, type }); } catch (_) { }
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
      if (!running) return null;
      // fn 可能是同步函式，也可能是 async 函式。
      // v9 這裡沒有 await，導致 fillContactForm() 的 Promise 被當成「已找到」，
      // 實際只檢查一次就結束，所以畫面已到聯絡頁時仍不會填。
      const result = await fn();
      if (result) return result;
      await sleep(interval);
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
    const plan = config.priorityPlan || {};
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
    const raw = String(config.priorityRules || "").trim();
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
    if (!rules.length && config.dateText) {
      const times = Array.isArray(config.times) && config.times.length ? config.times : parseTimes(config.timeText);
      rules.push({ dateText: config.dateText, times, label: `${config.dateText} | ${times.join(",")}` });
    }
    return rules;
  }

  function allPreferredTimes(rules) {
    const times = [];
    rules.forEach(r => (r.times || []).forEach(t => times.push(t)));
    if (!times.length) parseTimes(config.timeText).forEach(t => times.push(t));
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
      await sleep(250);
    }
    return visibleCalendarText().includes(headerText);
  }

  async function openDatePicker() {
    const datePicker = document.querySelector("#date-picker, [data-cy='date-picker']");
    if (!datePicker) return false;
    if (datePicker.getAttribute("aria-expanded") !== "true") {
      safeClick(datePicker);
      await sleep(250);
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
      emit("LOG", `找不到月份：${target.year || ""}年${target.month || ""}月`, "warn");
      return false;
    }

    const el = findDateElement(dateText, row);
    if (!el) return false;
    if (!safeClick(el)) return false;

    await sleep(350);
    const picked = norm(currentDatePickerText());
    const day = String(target.day || "");
    const month = String(target.month || "");
    const ok = picked.includes(day) && (!month || picked.includes(`${month}月`));
    if (!ok) emit("LOG", `日期點擊後頁面顯示為：${currentDatePickerText() || "空白"}`, "warn");
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
    if (config.adultCount) {
      if (setSelectValue("#adult-picker", `${config.adultCount}位大人`) || setSelectValue("#adult-picker", String(config.adultCount))) {
        emit("LOG", `已選大人：${config.adultCount}`, "success");
      }
    }
    if (config.kidCount !== "" && config.kidCount !== undefined && config.kidCount !== null) {
      if (setSelectValue("#kid-picker", `${config.kidCount}位小孩`) || setSelectValue("#kid-picker", String(config.kidCount))) {
        emit("LOG", `已選小孩：${config.kidCount}`, "success");
      }
    }
    await sleep(250);
  }

  async function tryRule(rule, opts = {}) {
    if (!running) return null;
    const modeText = opts.waitlist ? "候補" : "可訂";
    emit("LOG", `檢查順位：${rule.label || rule.dateText}（${modeText}）`, "info");

    const dateOk = await chooseDate(rule.dateText, rule);
    if (!dateOk) {
      emit("LOG", `日期不可選或未選成功：${rule.dateText}`, "warn");
      return null;
    }
    emit("LOG", `已選日期：${rule.dateText}`, "success");
    await sleep(600);

    const hit = await waitFor(() => findTimeButton(rule.times), 1800, 100);
    if (!hit) {
      emit("LOG", `此日期找不到可訂時段：${rule.times?.length ? rule.times.join(",") : "任一時段"}`, "warn");
      return null;
    }
    safeClick(hit.el);
    await sleep(800);
    emit("LOG", `已選時段：${hit.text}`, "success");
    return { dateText: rule.dateText, timeText: hit.text, waitlist: !!opts.waitlist };
  }

  async function tryTimeOnly(rules) {
    const times = allPreferredTimes(rules);
    if (!times.length) return null;
    emit("LOG", `Fallback：只看時間，尋找 ${times.join(",")}`, "warn");
    await openDatePicker();
    const dates = findAnySelectableDateElements().slice(0, 45);
    for (const d of dates) {
      if (!running) return null;
      safeClick(d.el);
      await sleep(600);
      const hit = findTimeButton(times, { includeWaitlist: false });
      if (hit) {
        safeClick(hit.el);
        await sleep(800);
        emit("LOG", `Fallback 成功：任一日期 + ${hit.text}`, "success");
        return { dateText: currentDatePickerText(), timeText: hit.text, fallback: "timeOnly" };
      }
      await openDatePicker();
    }
    emit("LOG", "Fallback 只看時間仍找不到", "warn");
    return null;
  }

  async function tryDateOnly(rules) {
    emit("LOG", "Fallback：只看日期，該日期任一可訂時段都接受", "warn");
    for (const rule of rules) {
      if (!running) return null;
      const dateOk = await chooseDate(rule.dateText, rule);
      if (!dateOk) continue;
      await sleep(600);
      const hit = findTimeButton([], { includeWaitlist: false });
      if (hit) {
        safeClick(hit.el);
        await sleep(800);
        emit("LOG", `Fallback 成功：${rule.dateText} + 任一時段 ${hit.text}`, "success");
        return { dateText: rule.dateText, timeText: hit.text, fallback: "dateOnly" };
      }
    }
    emit("LOG", "Fallback 只看日期仍找不到", "warn");
    return null;
  }

  async function tryExactRows(rows) {
    for (const row of rows) {
      if (!running) return null;
      const dateText = row.dateText || row.date;
      const time = row.time;
      emit("LOG", `第一順位檢查：${dateText} ${time}（可訂）`, "info");
      if (!(await chooseDate(dateText, row))) {
        emit("LOG", `日期不可選或未選成功：${dateText}`, "warn");
        continue;
      }
      await sleep(250);
      const hit = await waitFor(() => findTimeButton([time]), 1800, 100);
      if (hit) {
        safeClick(hit.el);
        await sleep(250);
        emit("LOG", `第一順位成功：${dateText} ${hit.text}`, "success");
        return { dateText, timeText: hit.text, stage: "exact" };
      }
      emit("LOG", `第一順位不可用：${dateText} ${time}`, "warn");
    }
    return null;
  }

  async function tryRangeRows(rows) {
    for (const row of rows) {
      if (!running) return null;
      const dateText = row.dateText || row.date;
      emit("LOG", `第二順位檢查：${dateText} ${row.start}-${row.end}（可訂）`, "info");
      if (!(await chooseDate(dateText, row))) {
        emit("LOG", `日期不可選或未選成功：${dateText}`, "warn");
        continue;
      }
      await sleep(250);
      const hit = await waitFor(() => findTimeByPredicate(t => timeInRange(t, row.start, row.end)), 1800, 100);
      if (hit) {
        safeClick(hit.el);
        await sleep(250);
        emit("LOG", `第二順位成功：${dateText} ${hit.text}`, "success");
        return { dateText, timeText: hit.text, stage: "range" };
      }
      emit("LOG", `第二順位不可用：${dateText} ${row.start}-${row.end}`, "warn");
    }
    return null;
  }

  async function tryAnyRows(rows) {
    for (const row of rows) {
      if (!running) return null;
      const dateText = row.dateText || row.date;
      emit("LOG", `第三順位檢查：${dateText} 全部可訂時間（可訂）`, "info");
      if (!(await chooseDate(dateText, row))) {
        emit("LOG", `日期不可選或未選成功：${dateText}`, "warn");
        continue;
      }
      await sleep(250);
      const hit = await waitFor(() => findTimeButton([]), 2000, 100);
      if (hit) {
        safeClick(hit.el);
        await sleep(250);
        emit("LOG", `第三順位成功：${dateText} ${hit.text}`, "success");
        return { dateText, timeText: hit.text, stage: "any" };
      }
      emit("LOG", `第三順位不可用：${dateText} 全部可訂時間`, "warn");
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
      emit("LOG", "沒有可用的三段式順位設定", "error");
      return null;
    }

    const selected = await chooseByPlan(plan);
    if (selected) return selected;

    emit("LOG", "三段式順位都不可選", "warn");
    return null;
  }

  function findSmallestClickableByText(text, opts = {}) {
    const wanted = norm(text);
    if (!wanted) return null;
    const selector = opts.selector || "button, [role='button'], div, span, a";
    const candidates = [...document.querySelectorAll(selector)]
      .filter(isVisible)
      .filter(el => !isDisabled(el))
      .map(el => {
        const t = norm(el.innerText || el.textContent || el.value || el.getAttribute("aria-label"));
        const rect = el.getBoundingClientRect();
        return { el, t, area: rect.width * rect.height };
      })
      .filter(x => x.t && (opts.exact ? x.t === wanted : x.t.includes(wanted)))
      .filter(x => !opts.exclude || !opts.exclude(x.el))
      .sort((a, b) => a.area - b.area);
    return candidates[0]?.el || null;
  }

  async function clickNextAfterTime() {
    const clickedNext = await waitFor(() => {
      const excludedFinal = el => el.matches?.("[data-cy='submit'], button[type='submit']") || el.closest?.("#contact-form");
      const btn = findSmallestClickableByText("完成預訂", { exact: true, selector: "button, [role='button'], a", exclude: excludedFinal })
        || findSmallestClickableByText("完成預定", { exact: true, selector: "button, [role='button'], a", exclude: excludedFinal })
        || findSmallestClickableByText("立即訂位", { exact: true, selector: "button, [role='button'], a", exclude: excludedFinal })
        || findSmallestClickableByText("下一步", { exact: true, selector: "button, [role='button'], a", exclude: excludedFinal });
      return safeClick(btn);
    }, 4000, 150);

    if (clickedNext) {
      emit("LOG", "已進入下一步，等待聯絡資訊頁", "success");
      return true;
    }
    emit("LOG", "已選時段，但找不到前置完成/下一步按鈕", "warn");
    return false;
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
    const g = norm(config.gender || "");
    if (!g) return;
    let id = "";
    if (["先生", "男", "male", "0"].includes(g)) id = "#gender-male";
    if (["小姐", "女", "female", "1"].includes(g)) id = "#gender-female";
    if (["其他", "none", "2"].includes(g)) id = "#gender-none";
    if (id) safeClick(document.querySelector(id));
  }

  function clickPurpose() {
    const purposes = Array.isArray(config.purposes) ? config.purposes : String(config.purpose || "").split(",");
    purposes.map(s => s.trim()).filter(Boolean).forEach(p => clickText(p, { selector: "[role='checkbox'], label, div, span" }));
  }

  function checkAgreement() {
    if (config.autoAgree === false) return;
    const labels = [...document.querySelectorAll("label")].filter(l => /服務條款|隱私權|同意/.test(l.innerText || l.textContent || ""));
    for (const label of labels) {
      const checkbox = label.querySelector("button[role='checkbox'], [role='checkbox'], input[type='checkbox']") || label;
      const checked = checkbox.getAttribute?.("aria-checked") === "true" || checkbox.checked;
      if (!checked) safeClick(checkbox);
    }
  }

  async function fillContactForm() {
    const hasForm = document.querySelector("#contact-form") || document.querySelector("#name, #phone, #email");
    if (!hasForm) return false;
    if (doneEmitted || window.__INLINE_HELPER_FINAL_READY__) return true;
    phase = "FILLING";
    if (config.name) setNativeValue(document.querySelector("#name, [data-cy='name'], input[autocomplete='name']"), config.name);
    chooseGender();
    if (config.phone) setNativeValue(document.querySelector("#phone, [data-cy='phone'], input[type='tel']"), config.phone);
    if (config.email) setNativeValue(document.querySelector("#email, [data-cy='email'], input[type='email']"), config.email);
    clickPurpose();
    if (config.note) {
      const textarea = document.querySelector("textarea, [data-cy='note'], [data-cy='memo']");
      if (textarea) setNativeValue(textarea, config.note);
    }
    await sleep(120);
    checkAgreement();
    const submit = document.querySelector("[data-cy='submit'], button[type='submit']");
    if (submit) submit.scrollIntoView({ block: "center" });
    doneEmitted = true;
    window.__INLINE_HELPER_FINAL_READY__ = true;
    phase = "DONE";
    running = false;
    try { chrome.storage.local.set({ inline_isRunning: false }); } catch (_) { }
    const finalBtn =
      document.querySelector("[data-cy='submit'], button[type='submit']") ||
      findSmallestClickableByText("確認訂位", {
        exact: true,
        selector: "button, [role='button'], a, span"
      });

    if (finalBtn) {
      safeClick(finalBtn);
      emit("DONE", "已點擊確認訂位", "success");
    } else {
      emit("LOG", "找不到確認訂位按鈕", "warn");
    }

    return true;
  }

  async function runLoop(myToken) {
    if (phase !== "RUNNING") emit("LOG", "Inline 自動流程啟動", "info");
    phase = "RUNNING";
    while (running && myToken === runToken) {
      try {
        if (myToken !== runToken) return;
        if (await fillContactForm()) return;
        const selected = await chooseByPriority();
        if (selected) {
          phase = "NEXT_PAGE";
          const moved = await clickNextAfterTime();
          if (moved) {
            // 已完成前置選位並點擊「完成預訂」。
            // 接下來只等待聯絡資訊頁，不允許回頭再跑一次選日期/時間。
            const filled = await waitFor(() => fillContactForm(), 15000, 120);
            if (!filled) {
              emit("LOG", "已進入下一步，但 15 秒內未偵測到聯絡資訊表單；請貼目前頁面的姓名/手機欄位 HTML。", "warn");
            }
            return;
          }
          return;
        } else if (config.reloadOnNoTime) {
          emit("RELOAD", "Inline 全部順位不可用，準備重新整理", "warn");
          setTimeout(() => location.reload(), Math.max(500, Number(config.reloadDelay || 2) * 1000));
          return;
        }
        await sleep(300);
      } catch (err) {
        emit("ERROR", `Inline 流程錯誤：${err.message}`, "error");
        await sleep(500);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "updateGlobalEnabled") {
      if (msg.enabled === false) running = false;
      sendResponse?.({ ok: true });
      return true;
    }
    if (msg.action === "STOP") {
      running = false;
      phase = "IDLE";
      runToken++;
      emit("LOG", "Inline 流程已停止", "warn");
      sendResponse?.({ log: "Inline 已停止", type: "warn" });
      return true;
    }
    if (msg.action === "START") {
      if (phase === "NEXT_PAGE" || phase === "FILLING") {
        sendResponse?.({ log: "Inline 已進入下一步，忽略重複 START", type: "warn" });
        return true;
      }
      if (window.__INLINE_HELPER_FINAL_READY__ && (document.querySelector("#contact-form") || document.querySelector("#name, #phone, #email"))) {
        running = false;
        sendResponse?.({ log: "Inline 已在最後確認頁，忽略重複 START", type: "warn" });
        return true;
      }
      if (running && phase !== "IDLE" && phase !== "DONE") {
        sendResponse?.({ log: "Inline 流程已在執行中，忽略重複 START", type: "warn" });
        return true;
      }
      config = { ...msg };
      delete config.action;
      running = true;
      doneEmitted = false;
      window.__INLINE_HELPER_FINAL_READY__ = false;
      phase = "STARTING";
      const token = ++runToken;
      sendResponse?.({ log: "Inline 已收到 START", type: "success" });
      runLoop(token);
      return true;
    }
  });
})();
