// DOM, Info Panel, Metadata Extraction, and Caption Persistence Module
// Handles opening the Info panel (with anti-flapping recovery), extracting people/location/year metadata,
// and writing descriptions via Chrome Debugger Protocol (CDP) with network save quiescence.

(function () {
  const DESCRIPTION_JSNAME = "YPqjbf";
  const CAPTION_MAX_LENGTH = 1000;
  const PANEL_OPEN_TIMEOUT_MS = 10000;
  const FOCUS_LAND_TIMEOUT_MS = 700;
  const FOCUS_RECLICK_ATTEMPTS = 2;
  const SAVE_QUIESCENCE_IDLE_MS = 500;
  const SAVE_QUIESCENCE_MAX_WAIT_MS = 4000;
  const METADATA_BUDGET_MS = 2000;
  const METADATA_STABLE_MS = 200;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(predicate, timeoutMs, pollMs = 80) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      try {
        const res = predicate();
        if (res) return res;
      } catch (e) {}
      await sleep(pollMs);
    }
    return null;
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError?.message || "no_response"
            });
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || "send_failed" });
      }
    });
  }

  function isInfoPanelOpen() {
    if (typeof document === "undefined") return false;
    const closeBtn = document.querySelector(
      'button[aria-label="Close info"], button[aria-label="Fermer les infos"], button[aria-label="Cerrar información"]'
    );
    if (closeBtn) return true;
    const ta = document.querySelector(`textarea[jsname="${DESCRIPTION_JSNAME}"]`);
    if (ta) {
      const rect = ta.getBoundingClientRect?.();
      if (!rect || (rect.width > 0 && rect.height > 0)) return true;
    }
    return false;
  }

  function findVisibleDescriptionTextarea() {
    if (typeof document === "undefined") return null;
    const directSelectors = [
      'textarea[aria-label="Description"]',
      'textarea[aria-label="Add a description"]',
      'textarea[aria-label="Ajouter une description"]',
      'textarea[aria-label="Ajoutez une description"]',
      'textarea[aria-label="Añadir una descripción"]',
      'textarea[aria-label="Agregar una descripción"]',
      `textarea[jsname="${DESCRIPTION_JSNAME}"]`
    ];
    const direct = Array.from(document.querySelectorAll(directSelectors.join(", ")));
    for (const ta of direct) {
      const rect = ta.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return ta;
    }

    const placeholderSelectors = [
      '[aria-label="Add a description"]',
      '[aria-label="Ajouter une description"]',
      '[aria-label="Ajoutez une description"]',
      '[aria-label="Añadir una descripción"]',
      '[aria-label="Agregar una descripción"]',
      '[data-placeholder*="description" i]',
      '[data-placeholder*="descripción" i]'
    ];
    const placeholders = Array.from(document.querySelectorAll(placeholderSelectors.join(", ")));
    for (const ph of placeholders) {
      if (ph.tagName === "TEXTAREA") {
        const rect = ph.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return ph;
      } else if (ph.offsetParent !== null) {
        try {
          ph.click();
        } catch (e) {}
      }
    }
    return null;
  }

  function findInfoButton() {
    if (typeof document === "undefined") return null;
    const byLabel = document.querySelector(
      'button[aria-label="Open info"], button[aria-label="Informations"], button[aria-label="Info"], button[aria-label="Abrir información"], button[jslog*="8918"]'
    );
    if (byLabel && byLabel.offsetParent !== null) return byLabel;

    for (const svgPath of Array.from(document.querySelectorAll("button svg path, [role='button'] svg path"))) {
      const d = svgPath.getAttribute("d") || "";
      if (d.includes("M11 7h2v2h-2zm0 4h2v6h-2z")) {
        const btn = svgPath.closest('button, [role="button"]');
        if (btn && btn.offsetParent !== null) return btn;
      }
    }
    return byLabel || null;
  }

  function triggerDirectDomClick(btn) {
    if (!btn) return false;
    try {
      for (const evtName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const EventCtor = window.PointerEvent || window.MouseEvent || Event;
        const evt = new EventCtor(evtName, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          button: 0
        });
        btn.dispatchEvent(evt);
      }
      if (typeof btn.click === "function") btn.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function ensureInfoPanelOpen() {
    const t0 = performance.now();
    const logPanel = (msg) => {
      try {
        if (typeof window !== "undefined" && typeof window.__batchAppendLog === "function") {
          window.__batchAppendLog(
            `[panel] +${Math.round(performance.now() - t0)}ms: ${msg} (state: open=${isInfoPanelOpen()})`
          );
        }
      } catch (e) {}
    };

    logPanel("ensureInfoPanelOpen started");
    if (isInfoPanelOpen()) {
      logPanel("already open on start");
      return { ok: true };
    }

    let btn = findInfoButton();
    if (btn) {
      logPanel("attempting direct DOM event click on info button");
      triggerDirectDomClick(btn);
      const opened = await waitFor(isInfoPanelOpen, 600, 60);
      if (opened) {
        logPanel("panel opened via direct click");
        await sleep(150);
        if (isInfoPanelOpen()) {
          return { ok: true };
        }
        logPanel("WARNING: panel flapped/closed right after direct click! Re-triggering");
      } else {
        logPanel("panel not opened within 600ms of direct click");
      }
    } else {
      logPanel("info button not found in DOM");
    }

    logPanel("attempting shortcut 'z' key dispatch");
    await sendToBackground({
      type: "BATCH_DISPATCH_KEY",
      key: "z",
      code: "KeyZ",
      windowsVirtualKeyCode: 90
    });
    const zOpened = await waitFor(isInfoPanelOpen, 600, 60);
    if (zOpened) {
      logPanel("panel opened via 'z' key");
      await sleep(150);
      if (isInfoPanelOpen()) {
        return { ok: true };
      }
      logPanel("WARNING: panel flapped/closed right after 'z' key! Continuing to CDP click");
    } else {
      logPanel("panel not opened within 600ms of 'z' key");
    }

    if (!btn) btn = findInfoButton();
    if (!btn) {
      logPanel("FAILED: info button missing from DOM completely");
      return { ok: false, error: "info_button_not_found", detail: "Open info button not found" };
    }

    const rect = btn.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    logPanel(`attempting CDP click at (${cx}, ${cy})`);
    let clickRes = await sendToBackground({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
    if (!clickRes.ok) {
      const attachRes = await sendToBackground({ type: "BATCH_ATTACH" });
      if (attachRes.ok) {
        clickRes = await sendToBackground({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
      }
    }

    const cdpOpened = await waitFor(isInfoPanelOpen, 5000, 100);
    if (cdpOpened) {
      logPanel("panel opened via CDP click");
      return { ok: true };
    }

    logPanel("FAILED: panel did not open after all strategies");
    return { ok: false, error: "info_panel_did_not_open", detail: "Info panel did not open within timeout" };
  }

  function findInfoPanelRoot() {
    if (typeof document === "undefined") return null;
    for (const dl of Array.from(document.querySelectorAll("dl"))) {
      if (dl.offsetParent !== null) {
        return dl.closest('[role="region"]') || dl.parentElement?.parentElement || dl.parentElement;
      }
    }
    const closeBtn = document.querySelector(
      'button[aria-label="Close info"], button[aria-label="Fermer les infos"], button[aria-label="Cerrar información"]'
    );
    const ta = document.querySelector(`textarea[jsname="${DESCRIPTION_JSNAME}"]`);
    if (closeBtn && ta) {
      let cur = closeBtn.parentElement;
      while (cur && cur !== document.body) {
        if (cur.contains(ta)) return cur;
        cur = cur.parentElement;
      }
    }
    if (ta) {
      return ta.closest?.('[role="region"]') || ta.parentElement?.parentElement || null;
    }
    return null;
  }

  function extractMetadataOnce() {
    const root = findInfoPanelRoot();
    if (!root) {
      return { people: [], untaggedCount: 0, location: null, year: null };
    }

    const people = [];
    let untaggedCount = 0;
    for (const aEl of Array.from(root.querySelectorAll("a"))) {
      const href = aEl.getAttribute("href") ?? "";
      if (!/\/search\//.test(href) || !aEl.querySelector("img")) continue;
      const name = (aEl.textContent ?? "").trim();
      if (name.length > 0) {
        if (!people.includes(name)) people.push(name);
      } else {
        untaggedCount++;
      }
    }

    let location = null;
    const findMapAnchor = () => {
      const direct = root.querySelector(
        'a[href*="maps"], a[href*="google.com/maps"], a[href*="maps.google"], a[href*="goo.gl/maps"]'
      );
      if (direct) return direct;
      for (const aEl of Array.from(root.querySelectorAll("a"))) {
        const href = aEl.getAttribute("href") || "";
        if (href.includes("maps") || href.includes("place")) return aEl;
      }
      for (const svgPath of Array.from(root.querySelectorAll("svg path"))) {
        const d = svgPath.getAttribute("d") || "";
        if (
          d.startsWith("M12 2C8.13 2") ||
          d.startsWith("M12 2c-3.87") ||
          d.startsWith("M12 2C6.48 2")
        ) {
          const anc = svgPath.closest('a, button, [role="button"], div');
          if (anc) return anc;
        }
      }
      return null;
    };

    const mapAnchor = findMapAnchor();
    if (mapAnchor) {
      let cur = mapAnchor;
      for (let i = 0; i < 6 && cur && (cur = cur.parentElement); i++) {
        const rawText = cur.innerText ?? cur.textContent ?? "";
        const lines = rawText
          .split("\n")
          .map((l) => l.trim())
          .filter(
            (l) =>
              l.length > 0 &&
              !l.includes("\u00a9") &&
              !/^(\d+°|\d+\.\d+)/.test(l) &&
              !/^(where was this|où a été prise|add a location|ajouter un lieu|añadir una ubicación|agregar una ubicación)/i.test(l)
          );
        if (lines.length > 0) {
          location = lines[0];
          break;
        }
      }
    }

    const panelText = root.innerText ?? root.textContent ?? "";
    const yearMatch = panelText.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
    const year = yearMatch ? yearMatch[1] : null;

    return { people, untaggedCount, location, year };
  }

  async function extractMetadataWithStabilization() {
    const start = performance.now();
    let prev = extractMetadataOnce();
    while (performance.now() - start < METADATA_BUDGET_MS) {
      await sleep(METADATA_STABLE_MS);
      const cur = extractMetadataOnce();
      if (cur.location === null && performance.now() - start < 1500) {
        prev = cur;
        continue;
      }
      if (
        cur.people.length === prev.people.length &&
        cur.untaggedCount === prev.untaggedCount &&
        (cur.location !== null) === (prev.location !== null)
      ) {
        return cur;
      }
      prev = cur;
    }
    return prev;
  }

  async function runCaption({ text, overwrite = false }) {
    const t0 = performance.now();
    const timing = {
      panelOpenMs: -1,
      textareaVisibleMs: -1,
      focusToInsertMs: -1,
      blurToSettleMs: -1,
      totalMs: -1,
      retried: false,
      saveXhrs: -1
    };

    const finish = (success, error, errorDetail) => {
      timing.totalMs = Math.round(performance.now() - t0);
      return { success, error, errorDetail, timing };
    };

    const panelStart = performance.now();
    const openRes = await ensureInfoPanelOpen();
    if (!openRes.ok) {
      return finish(false, openRes.error, openRes.detail);
    }
    timing.panelOpenMs = Math.round(performance.now() - panelStart);

    const waitTaStart = performance.now();
    let reopenedOnce = false;
    const found = await waitFor(() => {
      const ta = findVisibleDescriptionTextarea();
      if (ta) return { kind: "textarea", el: ta };
      if (typeof document !== "undefined" && document.querySelector("video")) {
        return { kind: "video" };
      }
      if (!reopenedOnce && performance.now() - waitTaStart > 2500) {
        reopenedOnce = true;
        ensureInfoPanelOpen().catch(() => {});
      }
      return null;
    }, PANEL_OPEN_TIMEOUT_MS);

    if (!found) {
      timing.textareaVisibleMs = Math.round(performance.now() - waitTaStart);
      return finish(false, "textarea_not_visible");
    }
    if (found.kind === "video") {
      timing.textareaVisibleMs = Math.round(performance.now() - waitTaStart);
      return finish(false, "skipped_video", "video items are not supported");
    }

    let textarea = found.el;
    const settleStart = performance.now();
    for (let i = 0; i < 6 && performance.now() - settleStart <= 2000; i++) {
      await sleep(250);
      const latest = findVisibleDescriptionTextarea();
      if (!latest || latest === textarea) break;
      textarea = latest;
    }
    timing.textareaVisibleMs = Math.round(performance.now() - waitTaStart);

    const currentVal = textarea.value || "";
    if (!overwrite && currentVal.trim().length > 0) {
      return finish(false, "skipped_existing_description", "existing description preserved");
    }

    const targetText = String(text || "").replace(/\s+$/, "").slice(0, CAPTION_MAX_LENGTH);
    if (currentVal === targetText) {
      timing.focusToInsertMs = 0;
      timing.blurToSettleMs = 0;
      return finish(true);
    }

    const focusStart = performance.now();
    const rect = textarea.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    let clickRes = await sendToBackground({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
    if (!clickRes.ok) {
      await sleep(200);
      const attach = await sendToBackground({ type: "BATCH_ATTACH" });
      if (attach.ok) {
        clickRes = await sendToBackground({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
      }
    }
    if (!clickRes.ok) {
      return finish(false, "click_dispatch_failed", clickRes.error);
    }

    await sleep(60);
    let focused = !!(await waitFor(() => document.activeElement === textarea || null, FOCUS_LAND_TIMEOUT_MS));
    for (let attempt = 0; !focused && attempt < FOCUS_RECLICK_ATTEMPTS; attempt++) {
      let retryClick = await sendToBackground({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
      if (!retryClick.ok) {
        const attach = await sendToBackground({ type: "BATCH_ATTACH" });
        if (attach.ok) {
          retryClick = await sendToBackground({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
        }
      }
      focused = !!(await waitFor(() => document.activeElement === textarea || null, FOCUS_LAND_TIMEOUT_MS));
    }
    if (!focused) {
      return finish(false, "caption_focus_failed");
    }

    if (currentVal.length > 0) {
      let selAll = await sendToBackground({
        type: "BATCH_DISPATCH_KEY",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        commands: ["SelectAll"]
      });
      if (!selAll.ok) {
        await sleep(200);
        const attach = await sendToBackground({ type: "BATCH_ATTACH" });
        if (attach.ok) {
          selAll = await sendToBackground({
            type: "BATCH_DISPATCH_KEY",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            commands: ["SelectAll"]
          });
        }
      }
      if (!selAll.ok) {
        return finish(false, "key_dispatch_failed", selAll.error || "select_all_failed");
      }
      await sleep(30);
    }

    let insertRes = await sendToBackground({ type: "BATCH_INSERT_TEXT", text: targetText });
    if (!insertRes.ok) {
      await sleep(200);
      const attach = await sendToBackground({ type: "BATCH_ATTACH" });
      if (attach.ok) {
        insertRes = await sendToBackground({ type: "BATCH_INSERT_TEXT", text: targetText });
      }
    }
    if (!insertRes.ok) {
      return finish(false, "insert_text_failed", insertRes.error);
    }
    timing.focusToInsertMs = Math.round(performance.now() - focusStart);

    const blurStart = performance.now();
    let escRes = await sendToBackground({
      type: "BATCH_DISPATCH_KEY",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27
    });
    if (!escRes.ok) {
      await sleep(200);
      const attach = await sendToBackground({ type: "BATCH_ATTACH" });
      if (attach.ok) {
        escRes = await sendToBackground({
          type: "BATCH_DISPATCH_KEY",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27
        });
      }
    }
    if (!escRes.ok) {
      return finish(false, "key_dispatch_failed", escRes.error || "escape_failed");
    }

    const seedMs = Math.min(Math.round(performance.now() - blurStart) + 250, 3000);
    const qRes = await sendToBackground({
      type: "BATCH_AWAIT_SAVE_QUIESCENCE",
      idleMs: SAVE_QUIESCENCE_IDLE_MS,
      maxWaitMs: SAVE_QUIESCENCE_MAX_WAIT_MS,
      seedRecentMs: seedMs
    });
    let saveXhrs = qRes.ok && typeof qRes.saveXhrsObserved === "number" ? qRes.saveXhrsObserved : -1;
    if (saveXhrs === 0) {
      const qRes2 = await sendToBackground({
        type: "BATCH_AWAIT_SAVE_QUIESCENCE",
        idleMs: SAVE_QUIESCENCE_IDLE_MS,
        maxWaitMs: SAVE_QUIESCENCE_MAX_WAIT_MS
      });
      saveXhrs = qRes2.ok && typeof qRes2.saveXhrsObserved === "number" ? qRes2.saveXhrsObserved : -1;
    }

    timing.blurToSettleMs = Math.round(performance.now() - blurStart);
    timing.saveXhrs = saveXhrs;
    return finish(true);
  }

  window.WPhotoDomCaption = {
    sleep,
    waitFor,
    sendToBackground,
    isInfoPanelOpen,
    findVisibleDescriptionTextarea,
    ensureInfoPanelOpen,
    extractMetadataOnce,
    extractMetadataWithStabilization,
    runCaption
  };
})();
