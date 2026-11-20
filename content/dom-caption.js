// DOM, Info Panel, Metadata Extraction, and Caption Persistence Module
// Handles opening the Info panel (with anti-flapping recovery), extracting people/location/year metadata,
// and writing descriptions via Chrome Debugger Protocol (CDP) with network save quiescence.

(function () {
  const DESCRIPTION_JSNAME = "YPqjbf";
  const CLOSE_INFO_SELECTOR = [
    'button[aria-label="Close info"]',
    'button[aria-label="Fermer les infos"]',
    'button[aria-label="Fermer"]',
    'button[aria-label="Cerrar información"]',
    'button[aria-label="Cerrar"]',
    '[role="button"][aria-label="Close info"]',
    '[role="button"][aria-label="Fermer les infos"]',
    '[role="button"][aria-label="Cerrar información"]'
  ].join(", ");
  const OPEN_INFO_SELECTOR = [
    'button[aria-label="Open info"]',
    'button[aria-label="Informations"]',
    'button[aria-label="Info"]',
    'button[aria-label="Abrir información"]',
    'button[jslog*="8918"]',
    '[role="button"][aria-label="Open info"]',
    '[role="button"][aria-label="Informations"]',
    '[role="button"][aria-label="Info"]',
    '[role="button"][aria-label="Abrir información"]'
  ].join(", ");
  const PLACEHOLDER_SELECTOR = [
    '[aria-label="Add a description"]',
    '[aria-label="Ajouter une description"]',
    '[aria-label="Ajoutez une description"]',
    '[aria-label="Añadir una descripción"]',
    '[aria-label="Agregar una descripción"]',
    '[data-placeholder*="description" i]',
    '[data-placeholder*="descripción" i]'
  ].join(", ");
  const DIRECT_TEXTAREA_SELECTOR = [
    'textarea[aria-label="Description"]',
    'textarea[aria-label="Add a description"]',
    'textarea[aria-label="Ajouter une description"]',
    'textarea[aria-label="Ajoutez une description"]',
    'textarea[aria-label="Añadir una descripción"]',
    'textarea[aria-label="Agregar una descripción"]',
    `textarea[jsname="${DESCRIPTION_JSNAME}"]`
  ].join(", ");
  const CAPTION_MAX_LENGTH = 1000;
  const PANEL_OPEN_TIMEOUT_MS = 10000;
  const FOCUS_LAND_TIMEOUT_MS = 700;
  const FOCUS_RECLICK_ATTEMPTS = 2;
  const SAVE_QUIESCENCE_IDLE_MS = 500;
  const SAVE_QUIESCENCE_MAX_WAIT_MS = 4000;
  const METADATA_BUDGET_MS = 2000;
  const METADATA_STABLE_MS = 200;
  const PHOTO_NOT_FOUND_REGEX =
    /\b(photo not found|can't find photo|cannot find photo|photo introuvable|impossible de trouver la photo|no se ha encontrado la foto|no se encontr[óo] la foto)\b/i;
  const SHARED_BY_REGEX = /\b(Shared by|Partagé par|Compartido por)\b/i;

  const isBatchAborted = () =>
    typeof window !== "undefined" &&
    typeof window.__wphotoIsBatchAborted === "function" &&
    window.__wphotoIsBatchAborted();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(predicate, timeoutMs, pollMs = 80) {
    const start = performance.now();
    let virtualElapsed = 0;
    while (Math.max(performance.now() - start, virtualElapsed) < timeoutMs) {
      if (isBatchAborted()) return null;
      try {
        const res = predicate();
        if (res) return res;
      } catch (e) {}
      await sleep(pollMs);
      virtualElapsed += pollMs;
    }
    return null;
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve({ ok: false, error: chrome.runtime.lastError?.message || "no_response" });
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || "send_failed" });
      }
    });
  }

  async function sendCdpWithReattach(message, retryDelayMs = 200) {
    let res = await sendToBackground(message);
    if (!res.ok && !isBatchAborted()) {
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      if (!isBatchAborted()) {
        const attach = await sendToBackground({ type: "BATCH_ATTACH", forPhotoStep: true });
        if (attach.ok) res = await sendToBackground(message);
      }
    }
    return res;
  }

  let panelSeenOpenInMemory = false;

  function markPanelSeenOpen() {
    panelSeenOpenInMemory = true;
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.setItem("__wphotoPanelOpen", "1");
    } catch (e) {}
  }

  function wasPanelPreviouslyOpen() {
    if (panelSeenOpenInMemory) return true;
    try {
      return typeof sessionStorage !== "undefined" && sessionStorage.getItem("__wphotoPanelOpen") === "1";
    } catch (e) {
      return false;
    }
  }

  function isElementVisible(el) {
    if (!el || el.offsetParent === null) return false;
    const hiddenAnc = el.closest?.('[aria-hidden="true"], [hidden], [inert]');
    if (
      hiddenAnc &&
      (hiddenAnc !== el ||
        el.hidden === true ||
        el.getAttribute?.("aria-hidden") === "true" ||
        el.getAttribute?.("hidden") != null)
    ) {
      return false;
    }
    try {
      const st = typeof window !== "undefined" ? window.getComputedStyle?.(el) : null;
      if (
        st &&
        (st.display === "none" ||
          st.visibility === "hidden" ||
          st.visibility === "collapse" ||
          parseFloat(st.opacity) === 0)
      ) {
        return false;
      }
    } catch (e) {}
    try {
      if (
        el.checkVisibility &&
        !el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })
      ) {
        return false;
      }
    } catch (e) {}
    const r = el.getBoundingClientRect?.();
    if (r) {
      if (r.width === 0 || r.height === 0) return false;
      const winW = typeof window !== "undefined" ? window.innerWidth : 0;
      const winH = typeof window !== "undefined" ? window.innerHeight : 0;
      if (winW > 0 && typeof r.left === "number") {
        const right = typeof r.right === "number" ? r.right : r.left + (r.width || 0);
        const cx = r.left + (r.width || 0) / 2;
        if (right <= 0 || r.left >= winW || cx <= 0 || cx >= winW) return false;
      }
      if (winH > 0 && typeof r.top === "number") {
        const bottom = typeof r.bottom === "number" ? r.bottom : r.top + (r.height || 0);
        const cy = r.top + (r.height || 0) / 2;
        if (bottom <= 0 || r.top >= winH || cy <= 0 || cy >= winH) return false;
      }
    }
    return true;
  }

  function queryVisibleElements(selector, root = typeof document !== "undefined" ? document : null) {
    if (!root || !selector) return [];
    const results = [];
    if (typeof root.querySelectorAll === "function") {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (isElementVisible(el)) results.push(el);
      }
    }
    if (results.length === 0 && typeof root.querySelector === "function") {
      const single = root.querySelector(selector);
      if (single && isElementVisible(single)) results.push(single);
    }
    return results;
  }

  function findFirstVisible(selector, root) {
    const visible = queryVisibleElements(selector, root);
    return visible.length > 0 ? visible[visible.length - 1] : null;
  }

  function isPhotoNotFoundPage() {
    if (typeof document === "undefined") return false;
    const bodyText = (document.body?.innerText || document.body?.textContent || "").trim();
    if (bodyText) return PHOTO_NOT_FOUND_REGEX.test(bodyText);
    if (typeof document.querySelectorAll === "function") {
      for (const el of Array.from(document.querySelectorAll("div, span, p, h1, h2"))) {
        if (el.children?.length > 0) continue;
        const txt = (el.textContent || "").trim();
        if (txt && txt.length < 160 && PHOTO_NOT_FOUND_REGEX.test(txt)) return true;
      }
    }
    return false;
  }

  function isInfoPanelOpen() {
    if (typeof document === "undefined") return false;
    if (findFirstVisible(CLOSE_INFO_SELECTOR) || findFirstVisible(DIRECT_TEXTAREA_SELECTOR)) return true;
    for (const btn of queryVisibleElements(OPEN_INFO_SELECTOR)) {
      if (btn.getAttribute?.("aria-expanded") === "true" || btn.getAttribute?.("aria-pressed") === "true") {
        return true;
      }
    }
    if (typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0) {
      for (const dl of queryVisibleElements("dl")) {
        const r = dl.getBoundingClientRect?.();
        if (r && r.width >= 120 && r.left >= window.innerWidth * 0.5) return true;
      }
    }
    return false;
  }

  function findVisibleDescriptionTextarea(options = {}) {
    if (typeof document === "undefined") return null;
    const excludeEl = options?.excludeEl || null;
    const excludeEls = options?.excludeEls || null;
    const strictExclude = Boolean(options?.strictExclude);

    const isExcluded = (ta) =>
      Boolean(
        ta &&
          ((excludeEl && ta === excludeEl) ||
            (excludeEls && (excludeEls.has?.(ta) || (Array.isArray(excludeEls) && excludeEls.includes(ta)))))
      );

    const collectCandidates = () => {
      const list = Array.from(document.querySelectorAll(DIRECT_TEXTAREA_SELECTOR)).filter(isElementVisible);
      for (const ph of Array.from(document.querySelectorAll(PLACEHOLDER_SELECTOR))) {
        if (ph.tagName === "TEXTAREA" && isElementVisible(ph) && !list.includes(ph)) list.push(ph);
      }
      if ((excludeEl || excludeEls) && list.length > 0) {
        const nonExcluded = list.filter((ta) => !isExcluded(ta));
        if (nonExcluded.length > 0) return nonExcluded;
        if (strictExclude) return [];
      }
      return list;
    };

    let candidates = collectCandidates();
    if (candidates.length === 0) {
      let clickedPlaceholder = false;
      for (const ph of Array.from(document.querySelectorAll(PLACEHOLDER_SELECTOR))) {
        if (ph.tagName !== "TEXTAREA" && isElementVisible(ph)) {
          triggerDirectDomClick(ph);
          clickedPlaceholder = true;
        }
      }
      if (clickedPlaceholder) candidates = collectCandidates();
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    if (document.activeElement && candidates.includes(document.activeElement)) return document.activeElement;

    if (typeof document.elementFromPoint === "function") {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const ta = candidates[i];
        const r = ta.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) {
          const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          if (hit && (hit === ta || ta.contains?.(hit))) return ta;
        }
      }
    }
    return candidates[candidates.length - 1];
  }

  function findInfoButton() {
    if (typeof document === "undefined") return null;
    const byLabel = findFirstVisible(OPEN_INFO_SELECTOR);
    if (byLabel) return byLabel;
    if (typeof document.querySelectorAll === "function") {
      for (const svgPath of Array.from(document.querySelectorAll("button svg path, [role='button'] svg path"))) {
        const d = svgPath.getAttribute("d") || "";
        if (d.includes("M11 7h2v2h-2zm0 4h2v6h-2z") || d.includes("M11,7h2v2h-2V7z")) {
          const btn = svgPath.closest('button, [role="button"]');
          if (btn && isElementVisible(btn)) return btn;
        }
      }
    }
    return null;
  }

  function triggerDirectDomClick(btn) {
    if (!btn) return false;
    try {
      const EventCtor =
        (typeof window !== "undefined" && (window.PointerEvent || window.MouseEvent)) ||
        (typeof Event !== "undefined" ? Event : null);
      if (EventCtor && typeof btn.dispatchEvent === "function") {
        for (const evtName of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          btn.dispatchEvent(
            new EventCtor(evtName, {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: typeof window !== "undefined" ? window : undefined,
              button: 0
            })
          );
        }
      }
    } catch (e) {}
    try {
      if (typeof btn.click === "function") {
        btn.click();
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function ensureInfoPanelOpen({ forceToggleIfNoTextarea = false } = {}) {
    const t0 = performance.now();
    const logPanel = (msg) => {
      try {
        window.__batchAppendLog?.(
          `[panel] +${Math.round(performance.now() - t0)}ms: ${msg} (state: open=${isInfoPanelOpen()})`
        );
      } catch (e) {}
    };
    const confirmOpen = async (waitMs, settleMs = 200) => {
      if (!(await waitFor(isInfoPanelOpen, waitMs, 60))) return false;
      if (settleMs > 0) await sleep(settleMs);
      if (!isInfoPanelOpen()) return false;
      markPanelSeenOpen();
      return true;
    };

    logPanel("ensureInfoPanelOpen started");
    if (isPhotoNotFoundPage()) {
      logPanel("ABORT: Photo not found page detected");
      return { ok: false, error: "skipped_unowned", detail: "photo not found (not in your library)" };
    }
    if (isInfoPanelOpen()) {
      if (!forceToggleIfNoTextarea || findVisibleDescriptionTextarea()) {
        await sleep(150);
        if (isInfoPanelOpen()) {
          markPanelSeenOpen();
          logPanel("already open on start");
          return { ok: true };
        }
        logPanel("panel closed within 150ms; re-opening");
      } else {
        logPanel("forceToggleIfNoTextarea: textarea missing; forcing re-open");
      }
    } else if (!forceToggleIfNoTextarea && wasPanelPreviouslyOpen()) {
      logPanel("waiting up to 1200ms for remembered panel hydration");
      if (await confirmOpen(1200, 150)) {
        logPanel("panel naturally hydrated without click");
        return { ok: true };
      }
    }

    if (isBatchAborted()) return { ok: false, error: "batch_aborted", detail: "Batch cancelled" };
    let btn = findInfoButton();
    if (btn) {
      logPanel("attempting direct DOM event click on info button");
      triggerDirectDomClick(btn);
      if (await confirmOpen(700)) {
        logPanel("panel opened via direct click");
        return { ok: true };
      }
      logPanel("direct click did not keep panel open");
    } else {
      logPanel("info button not found in DOM");
    }

    if (isInfoPanelOpen()) {
      markPanelSeenOpen();
      return { ok: true };
    }
    if (isBatchAborted()) return { ok: false, error: "batch_aborted", detail: "Batch cancelled" };

    logPanel("attempting shortcut 'i' key dispatch");
    await sendCdpWithReattach({ type: "BATCH_DISPATCH_KEY", key: "i", code: "KeyI", windowsVirtualKeyCode: 73 }, 0);
    if (await confirmOpen(700)) {
      logPanel("panel opened via 'i' key");
      return { ok: true };
    }

    if (isInfoPanelOpen()) {
      markPanelSeenOpen();
      return { ok: true };
    }
    if (isBatchAborted()) return { ok: false, error: "batch_aborted", detail: "Batch cancelled" };

    btn = findInfoButton() || btn;
    if (!btn) {
      logPanel("FAILED: info button missing from DOM completely");
      return { ok: false, error: "info_button_not_found", detail: "Open info button not found" };
    }

    const rect = btn.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      logPanel(`attempting CDP click at (${cx}, ${cy})`);
      await sendCdpWithReattach({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy }, 0);
      if (await waitFor(isInfoPanelOpen, 5000, 100)) {
        markPanelSeenOpen();
        logPanel("panel opened via CDP click");
        return { ok: true };
      }
    }

    logPanel("FAILED: panel did not open after all strategies");
    return { ok: false, error: "info_panel_did_not_open", detail: "Info panel did not open within timeout" };
  }

  function findInfoPanelRoot() {
    if (typeof document === "undefined") return null;
    const visibleDls = queryVisibleElements("dl");
    if (visibleDls.length > 0) {
      const dl = visibleDls[visibleDls.length - 1];
      return dl.closest?.('[role="region"]') || dl.parentElement?.parentElement || dl.parentElement;
    }
    const closeBtn = findFirstVisible(CLOSE_INFO_SELECTOR);
    const ta = findFirstVisible(DIRECT_TEXTAREA_SELECTOR);
    if (closeBtn && ta) {
      let cur = closeBtn.parentElement;
      while (cur && cur !== document.body) {
        if (cur.contains?.(ta)) return cur;
        cur = cur.parentElement;
      }
    }
    return ta ? ta.closest?.('[role="region"]') || ta.parentElement?.parentElement || null : null;
  }

  async function isInfoPanelReadOnlyUnowned() {
    if (typeof document === "undefined") return false;
    if (findVisibleDescriptionTextarea()) return false;
    const root = findInfoPanelRoot() || document;
    const rootText = root !== document ? root.innerText || root.textContent || "" : "";
    if ((!rootText || SHARED_BY_REGEX.test(rootText)) && typeof root.querySelectorAll === "function") {
      for (const el of Array.from(root.querySelectorAll("dl, div, span"))) {
        if (el.children?.length > 0 && el.tagName !== "DL") continue;
        const txt = (el.textContent || "").trim();
        if (txt && txt.length < 200 && SHARED_BY_REGEX.test(txt)) return true;
      }
    }
    if (queryVisibleElements("dl").length > 0 && isInfoPanelOpen()) {
      const ta = await waitFor(findVisibleDescriptionTextarea, 600, 80);
      if (!ta) return true;
    }
    return false;
  }

  function extractMetadataOnce() {
    const root = findInfoPanelRoot();
    if (!root) return { people: [], untaggedCount: 0, location: null, year: null };

    const anchors = Array.from(root.querySelectorAll("a"));
    const people = [];
    let untaggedCount = 0;
    for (const aEl of anchors) {
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
    let mapAnchor = root.querySelector(
      'a[href*="maps"], a[href*="google.com/maps"], a[href*="maps.google"], a[href*="goo.gl/maps"]'
    );
    if (!mapAnchor) {
      mapAnchor = anchors.find((a) => {
        const h = a.getAttribute("href") || "";
        return h.includes("maps") || h.includes("place");
      });
    }
    if (!mapAnchor) {
      for (const svgPath of Array.from(root.querySelectorAll("svg path"))) {
        const d = svgPath.getAttribute("d") || "";
        if (d.startsWith("M12 2C8.13 2") || d.startsWith("M12 2c-3.87") || d.startsWith("M12 2C6.48 2")) {
          mapAnchor = svgPath.closest('a, button, [role="button"], div');
          if (mapAnchor) break;
        }
      }
    }

    if (mapAnchor) {
      let cur = mapAnchor;
      for (let i = 0; i < 6 && cur && (cur = cur.parentElement); i++) {
        const lines = (cur.innerText ?? cur.textContent ?? "")
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
    return { people, untaggedCount, location, year: yearMatch ? yearMatch[1] : null };
  }

  async function extractMetadataWithStabilization() {
    const start = performance.now();
    let prev = extractMetadataOnce();
    while (performance.now() - start < METADATA_BUDGET_MS && !isBatchAborted()) {
      await sleep(METADATA_STABLE_MS);
      const cur = extractMetadataOnce();
      if (cur.location === null && performance.now() - start < 1500) {
        prev = cur;
        continue;
      }
      if (
        cur.people.length === prev.people.length &&
        cur.untaggedCount === prev.untaggedCount &&
        cur.location === prev.location &&
        cur.year === prev.year
      ) {
        return cur;
      }
      prev = cur;
    }
    return prev;
  }

  async function runCaption({
    text,
    overwrite = false,
    forceWrite = false,
    excludeTextarea = null,
    excludeTextareas = null
  }) {
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

    let textarea = null;
    const finish = (success, error, errorDetail) => {
      timing.totalMs = Math.round(performance.now() - t0);
      return { success, error, errorDetail, timing, textarea };
    };

    const panelStart = performance.now();
    const openRes = await ensureInfoPanelOpen();
    if (!openRes.ok) return finish(false, openRes.error, openRes.detail);
    timing.panelOpenMs = Math.round(performance.now() - panelStart);

    const hasExclusion = Boolean(
      excludeTextarea ||
        (excludeTextareas && (excludeTextareas.size > 0 || (Array.isArray(excludeTextareas) && excludeTextareas.length > 0)))
    );

    const waitTaStart = performance.now();
    let reopenedOnce = false;
    let strictPollCount = 0;
    const found = await waitFor(() => {
      const elapsed = performance.now() - waitTaStart;
      const useStrict = hasExclusion && strictPollCount < 5 && elapsed < 750;
      strictPollCount++;
      const ta = findVisibleDescriptionTextarea({
        excludeEl: excludeTextarea,
        excludeEls: excludeTextareas,
        strictExclude: useStrict
      });
      if (ta) return { kind: "textarea", el: ta };
      if (typeof document !== "undefined" && document.querySelector("video")) return { kind: "video" };
      if (!reopenedOnce && elapsed > 2500) {
        reopenedOnce = true;
        ensureInfoPanelOpen({ forceToggleIfNoTextarea: true }).catch(() => {});
      }
      return null;
    }, PANEL_OPEN_TIMEOUT_MS);

    timing.textareaVisibleMs = Math.round(performance.now() - waitTaStart);
    if (!found) return finish(false, "textarea_not_visible");
    if (found.kind === "video") return finish(false, "skipped_video", "video items are not supported");

    textarea = found.el;
    const settleStart = performance.now();
    const maxSettleIters = hasExclusion ? 2 : 6;
    const settleSleepMs = hasExclusion ? 150 : 250;
    for (let i = 0; i < maxSettleIters && performance.now() - settleStart <= 2000; i++) {
      await sleep(settleSleepMs);
      const latest = findVisibleDescriptionTextarea({ excludeEl: excludeTextarea, excludeEls: excludeTextareas });
      if (!latest || latest === textarea) break;
      textarea = latest;
    }
    timing.textareaVisibleMs = Math.round(performance.now() - waitTaStart);

    let currentVal = textarea.value || "";
    if (!overwrite && currentVal.trim().length > 0) {
      return finish(false, "skipped_existing_description", "existing description preserved");
    }

    const targetText = String(text || "").replace(/\s+$/, "").slice(0, CAPTION_MAX_LENGTH);
    if (!forceWrite && currentVal === targetText) {
      timing.focusToInsertMs = 0;
      timing.blurToSettleMs = 0;
      return finish(true);
    }
    if (isBatchAborted()) return finish(false, "batch_aborted", "cancelled by user");

    const focusStart = performance.now();
    let rect = textarea.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      const refreshed = findVisibleDescriptionTextarea({ excludeEl: excludeTextarea, excludeEls: excludeTextareas });
      if (refreshed) {
        textarea = refreshed;
        rect = textarea.getBoundingClientRect?.();
      }
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return finish(false, "textarea_not_visible");
    }

    let cx = Math.round(rect.left + rect.width / 2);
    let cy = Math.round(rect.top + rect.height / 2);
    const clickRes = await sendCdpWithReattach({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy });
    if (isBatchAborted()) return finish(false, "batch_aborted", "cancelled by user");
    if (!clickRes.ok) return finish(false, "click_dispatch_failed", clickRes.error);

    try {
      textarea.focus?.();
    } catch (e) {}

    const checkTextareaFocused = () => {
      const active = document.activeElement;
      if (!active) return null;
      if (active === textarea) return textarea;
      if (active.tagName === "TEXTAREA" && isElementVisible(active)) {
        textarea = active;
        return textarea;
      }
      return null;
    };

    await sleep(60);
    let focused = !!(await waitFor(checkTextareaFocused, FOCUS_LAND_TIMEOUT_MS));
    for (let attempt = 0; !focused && attempt < FOCUS_RECLICK_ATTEMPTS && !isBatchAborted(); attempt++) {
      const latestTa =
        findVisibleDescriptionTextarea({ excludeEl: excludeTextarea, excludeEls: excludeTextareas }) || textarea;
      if (latestTa && latestTa !== textarea) textarea = latestTa;
      const rRetry = textarea.getBoundingClientRect?.();
      if (!rRetry || rRetry.width <= 0 || rRetry.height <= 0) break;
      cx = Math.round(rRetry.left + rRetry.width / 2);
      cy = Math.round(rRetry.top + rRetry.height / 2);
      await sendCdpWithReattach({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy }, 0);
      try {
        textarea.focus?.();
      } catch (e) {}
      focused = !!(await waitFor(checkTextareaFocused, FOCUS_LAND_TIMEOUT_MS));
    }
    if (isBatchAborted()) return finish(false, "batch_aborted", "cancelled by user");
    if (!focused) return finish(false, "caption_focus_failed");

    currentVal = textarea.value || "";
    if (!overwrite && currentVal.trim().length > 0) {
      return finish(false, "skipped_existing_description", "existing description preserved");
    }
    if (!forceWrite && currentVal === targetText) {
      timing.focusToInsertMs = 0;
      timing.blurToSettleMs = 0;
      return finish(true);
    }

    if (currentVal.length > 0 || forceWrite) {
      const selAll = await sendCdpWithReattach({
        type: "BATCH_DISPATCH_KEY",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        commands: ["SelectAll"]
      });
      if (isBatchAborted()) return finish(false, "batch_aborted", "cancelled by user");
      if (!selAll.ok) return finish(false, "key_dispatch_failed", selAll.error || "select_all_failed");
      await sleep(30);
    }

    if (document.activeElement !== textarea && !isBatchAborted()) {
      try {
        textarea.focus?.();
      } catch (e) {}
      if (document.activeElement !== textarea) {
        const rCur = textarea.getBoundingClientRect?.();
        if (rCur && rCur.width > 0 && rCur.height > 0) {
          cx = Math.round(rCur.left + rCur.width / 2);
          cy = Math.round(rCur.top + rCur.height / 2);
          await sendCdpWithReattach({ type: "BATCH_DISPATCH_CLICK_AT", x: cx, y: cy }, 0);
          await sleep(40);
        }
      }
    }

    const insertRes = await sendCdpWithReattach({ type: "BATCH_INSERT_TEXT", text: targetText });
    if (isBatchAborted()) return finish(false, "batch_aborted", "cancelled by user");
    if (!insertRes.ok) return finish(false, "insert_text_failed", insertRes.error);
    timing.focusToInsertMs = Math.round(performance.now() - focusStart);

    const blurStart = performance.now();
    const escRes = await sendCdpWithReattach({
      type: "BATCH_DISPATCH_KEY",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27
    });
    if (isBatchAborted()) return finish(false, "batch_aborted", "cancelled by user");
    if (!escRes.ok) return finish(false, "key_dispatch_failed", escRes.error || "escape_failed");

    const seedMs = Math.min(Math.round(performance.now() - blurStart) + 250, 3000);
    const qRes = await sendToBackground({
      type: "BATCH_AWAIT_SAVE_QUIESCENCE",
      idleMs: SAVE_QUIESCENCE_IDLE_MS,
      maxWaitMs: SAVE_QUIESCENCE_MAX_WAIT_MS,
      seedRecentMs: seedMs
    });
    let saveXhrs = qRes.ok && typeof qRes.saveXhrsObserved === "number" ? qRes.saveXhrsObserved : -1;
    if (saveXhrs === 0 && !isBatchAborted()) {
      if (document.activeElement === textarea) {
        try {
          textarea.blur?.();
        } catch (e) {}
      }
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
    triggerDirectDomClick,
    isElementVisible,
    isPhotoNotFoundPage,
    isInfoPanelReadOnlyUnowned,
    isInfoPanelOpen,
    findInfoButton,
    findVisibleDescriptionTextarea,
    ensureInfoPanelOpen,
    extractMetadataOnce,
    extractMetadataWithStabilization,
    runCaption
  };
})();
