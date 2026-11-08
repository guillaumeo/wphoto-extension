// AI Description Engine (Cloud Gemini + Local Gemini Nano + Multi-Language Template Interpolation + Stack Propagation)

(function () {
  const CAPTION_MAX_LENGTH = 1000;
  const GENERATE_TIMEOUT_MS = 35000;
  let nanoMsgSeq = 0;
  let nanoInjectedOrigin = null;

  function getPromptConfig(lang = "en") {
    const prompts = (typeof window !== "undefined" && window.WPHOTO_PROMPTS) || {};
    return prompts[lang] || prompts.en || {};
  }

  function extractFirstNames(people = []) {
    return (people || [])
      .map((name) => String(name).trim().split(/\s+/)[0])
      .filter((first) => first.length > 0);
  }

  function joinNamesList(firstNames, lang = "en") {
    const tpl = getPromptConfig(lang);
    const andWord = tpl.andWord || "and";
    if (!firstNames || firstNames.length === 0) return "";
    if (firstNames.length === 1) return firstNames[0];
    if (firstNames.length === 2) return `${firstNames[0]} ${andWord} ${firstNames[1]}`;
    const commaAnd = lang === "en" ? `, ${andWord} ` : ` ${andWord} `;
    return `${firstNames.slice(0, -1).join(", ")}${commaAnd}${firstNames[firstNames.length - 1]}`;
  }

  function buildRules(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    const untaggedCount = metadata?.untaggedCount || 0;
    const location = metadata?.location || null;

    let peoplePart = "";
    if (firstNames.length > 0) {
      let peopleListStr = firstNames.join(", ");
      if (untaggedCount > 0) {
        const untaggedPhrase =
          untaggedCount === 1
            ? tpl.untaggedOne || "one additional untagged person"
            : (tpl.untaggedMany || "{count} additional untagged people").replace(
                /\{count\}/g,
                String(untaggedCount)
              );
        const plusWord = lang === "es" ? "más" : "plus";
        peopleListStr += `, ${plusWord} ${untaggedPhrase}`;
      }
      peoplePart = (tpl.peopleTagged || "Tagged people in this photo: {people}.").replace(
        /\{people\}/g,
        peopleListStr
      );
    } else {
      peoplePart = tpl.peopleNone || "No people are tagged in this photo.";
    }

    const strictPart = tpl.strictRules || "";
    const locationPart = location
      ? (tpl.locationRule || "The tagged place name is '{location}'.").replace(
          /\{location\}/g,
          location
        )
      : "";

    return [peoplePart, strictPart, locationPart].filter(Boolean).join(" ");
  }

  function buildInstruction(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    if (firstNames.length > 0) {
      const namesJoined = joinNamesList(firstNames, lang);
      return (tpl.instructionWithPeople || "").replace(/\{names\}/g, namesJoined);
    }
    return tpl.instructionNoPeople || "";
  }

  function composeMetadataCaption(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    const location = metadata?.location || null;
    const year = metadata?.year || null;
    const inWord = tpl.inWord || "in";

    if (firstNames.length === 0 && !location) return null;

    let text = "";
    if (firstNames.length > 0) {
      text = joinNamesList(firstNames, lang);
      if (location) {
        text += ` ${inWord} ${location}`;
      }
    } else {
      text = `${location}`;
    }

    if (year) {
      text += `, ${year}`;
    }
    return (text + ".").slice(0, CAPTION_MAX_LENGTH);
  }

  function cleanGeneratedCaption(rawText) {
    let text = String(rawText || "").trim();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length > 1 && /^(here'?s|voici|voil[àa]|aqu[íi]\s+tienes|he\s+aqu[íi])\b.*:$/i.test(lines[0])) {
      lines.shift();
    }

    text = lines
      .join(" ")
      .replace(/\*\*/g, "")
      .replace(/^["'\u201c\u2018\u00ab]+|["'\u201d\u2019\u00bb]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    let stripped = text
      .replace(
        /^(here'?s|here\s+is)(?:\s+(?:a|an|the)?\s*(?:suggested\s+)?(?:caption|description)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(voici|voil[àa])(?:\s+(?:une|la|cette)?\s*(?:proposition\s+de\s+)?(?:l[ée]gende|description)?\s*(?:pour|de)?\s*(?:la|cette)?\s*(?:photo|image)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(aqu[íi]\s+tienes|he\s+aqu[íi])(?:\s+(?:una|la|esta)?\s*(?:propuesta\s+de\s+)?(?:leyenda|descripci[óo]n|pie\s+de\s+foto)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(a |an |the )?(photo(graph)?|image|picture|snapshot)\b( of| shows| showing| features| depicting| with)?[,:]?\s*/i,
        ""
      )
      .replace(
        /^((une |la |cette )?(photo(graphie)?|image|vue|clich[ée])\b( de| d'| montre| montrant| pr[ée]sentant| avec)?[,:]?\s*)/i,
        ""
      )
      .replace(
        /^((una |la |esta )?(foto(graf[íi]a)?|imagen|vista|instant[áa]nea)\b( de| muestra| mostrando| con)?[,:]?\s*)/i,
        ""
      );

    if (stripped.length >= 10 && stripped !== text) {
      text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }

    const twoSentences = text.match(/^[^.!?]*[.!?](?:\s+[^.!?]*[.!?])?/);
    if (twoSentences && twoSentences[0].trim().length >= 15) {
      text = twoSentences[0].trim();
    }

    return text.slice(0, CAPTION_MAX_LENGTH);
  }

  let logWriteBusy = false;
  let logPendingLines = [];

  function flushLogQueue() {
    if (logWriteBusy || logPendingLines.length === 0) return;
    logWriteBusy = true;
    const batchText = logPendingLines.join("");
    logPendingLines = [];
    try {
      let handled = false;
      const onRead = (data) => {
        if (handled) return;
        handled = true;
        const prev = (data && data.aiDescriptionVerboseLog) || "";
        const next = () => {
          logWriteBusy = false;
          if (logPendingLines.length > 0) flushLogQueue();
        };
        try {
          let setDone = false;
          const finishSet = () => {
            if (setDone) return;
            setDone = true;
            next();
          };
          const p = chrome.storage.local.set({ aiDescriptionVerboseLog: prev + batchText }, finishSet);
          if (p && typeof p.then === "function") {
            p.then(finishSet).catch(finishSet);
          }
        } catch (e) {
          next();
        }
      };
      const g = chrome.storage.local.get("aiDescriptionVerboseLog", onRead);
      if (g && typeof g.then === "function") {
        g.then(onRead).catch(() => {
          logWriteBusy = false;
        });
      }
    } catch (e) {
      logWriteBusy = false;
    }
  }

  async function clearAiDescLog() {
    logPendingLines = [];
    logWriteBusy = false;
    try {
      await chrome.storage.local.set({ aiDescriptionVerboseLog: "" });
    } catch (e) {}
  }

  async function getAiDescLog() {
    try {
      const data = await chrome.storage.local.get("aiDescriptionVerboseLog");
      return ((data && data.aiDescriptionVerboseLog) || "") + logPendingLines.join("");
    } catch (e) {
      return "";
    }
  }

  function appendAiDescLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logPendingLines.push(line);
    flushLogQueue();
  }

  if (typeof window !== "undefined") {
    window.__batchAppendLog = appendAiDescLog;
  }

  const DEFAULT_429_BACKOFF_MS = [2000, 5000, 10000];

  function sleepMs(ms) {
    if (typeof window !== "undefined" && window.WPhotoDomCaption?.sleep) {
      return window.WPhotoDomCaption.sleep(ms);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resolve429RetryDelayMs(resp, attemptIndex, customDelays) {
    const schedule =
      Array.isArray(customDelays) && customDelays.length > 0
        ? customDelays
        : (typeof window !== "undefined" && Array.isArray(window.__wphotoRetryDelaysMs)
            ? window.__wphotoRetryDelaysMs
            : DEFAULT_429_BACKOFF_MS);
    const baseDelay = schedule[Math.min(attemptIndex, schedule.length - 1)] ?? 2000;
    try {
      const retryAfterHeader = resp?.headers?.get?.("Retry-After") || resp?.headers?.get?.("retry-after");
      if (retryAfterHeader && !Array.isArray(customDelays)) {
        const secs = Number(retryAfterHeader);
        if (Number.isFinite(secs) && secs > 0) {
          return Math.min(30000, Math.max(baseDelay, Math.round(secs * 1000)));
        }
      }
    } catch (e) {}
    return baseDelay;
  }

  let cachedWorkingCloudModel = null;
  let thinkingConfigSupported = true;

  async function fetchWithTimeout(url, init, timeoutMs) {
    if (typeof AbortController !== "function" || !timeoutMs) {
      return fetch(url, init);
    }
    const ctrl = new AbortController();
    const parentSignal = init?.signal;
    const onParentAbort = () => ctrl.abort();
    if (parentSignal) {
      if (parentSignal.aborted) {
        ctrl.abort();
      } else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
    }
    const tStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const timer = setTimeout(() => {
      const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - tStart;
      if (elapsed >= timeoutMs * 0.5) {
        ctrl.abort();
      }
    }, timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      if (parentSignal) {
        try {
          parentSignal.removeEventListener("abort", onParentAbort);
        } catch (e) {}
      }
    }
  }

  function toSizedGooglePhotosUrl(src) {
    if (!src || typeof src !== "string") return src;
    if (!src.includes("googleusercontent.com/")) return src;
    if (/=w\d+-h\d+[^/]*$/.test(src)) {
      return src.replace(/=w\d+-h\d+[^/]*$/, "=w768-h768");
    }
    if (/=s\d+[^/]*$/.test(src)) {
      return src.replace(/=s\d+[^/]*$/, "=w768-h768");
    }
    return src;
  }

  async function callGeminiCloud({
    apiKey,
    model = "gemini-3.1-flash-lite",
    rules = "",
    instruction = "",
    imgSrc = null,
    lang = "en",
    retryDelaysMs = null,
    onRetry = null
  }) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return { error: "missing_gemini_api_key" };
    }
    const prompt = (rules ? rules + "\n\n" : "") + instruction;
    const parts = [{ text: prompt.trim() }];

    if (imgSrc && typeof document !== "undefined") {
      let b64 = null;
      const targetW = 768;
      const targetH = 768;
      const drawSourceTo768 = (srcObj, sw, sh) => {
        const canvas = document.createElement("canvas");
        const w = sw || targetW;
        const h = sh || targetH;
        const scale = Math.min(targetW / w, targetH / h);
        const dw = Math.round(w * scale);
        const dh = Math.round(h * scale);
        const dx = Math.round((targetW - dw) / 2);
        const dy = Math.round((targetH - dh) / 2);
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(srcObj, dx, dy, dw, dh);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        return dataUrl && dataUrl.includes(",") ? dataUrl.split(",")[1] : null;
      };

      try {
        const img = Array.from(document.querySelectorAll("img")).find(
          (el) => el.src === imgSrc && el.naturalWidth > 0
        );
        if (img) {
          b64 = drawSourceTo768(img, img.naturalWidth, img.naturalHeight);
        }
      } catch (e) {
        b64 = null;
      }

      if (!b64 && typeof fetch === "function" && typeof createImageBitmap === "function") {
        try {
          const sizedUrl = toSizedGooglePhotosUrl(imgSrc);
          let imgResp = await fetchWithTimeout(sizedUrl, { credentials: "omit" }, 6000).catch(() => null);
          if ((!imgResp || !imgResp.ok) && sizedUrl !== imgSrc) {
            imgResp = await fetchWithTimeout(imgSrc, { credentials: "omit" }, 6000).catch(() => null);
          }
          if (!imgResp || !imgResp.ok) {
            imgResp = await fetchWithTimeout(imgSrc, { credentials: "include" }, 6000).catch(() => null);
          }
          if (imgResp && imgResp.ok) {
            const blob = await imgResp.blob();
            const bmp = await createImageBitmap(blob);
            try {
              b64 = drawSourceTo768(bmp, bmp.width, bmp.height);
            } finally {
              try {
                bmp.close();
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      if (b64) {
        parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
      }
    }

    const buildUrl = (m) =>
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(m) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey.trim());

    const tpl = getPromptConfig(lang);
    const sysInst = tpl.system ? { parts: [{ text: tpl.system }] } : undefined;
    const isAborted = () =>
      typeof window !== "undefined" &&
      typeof window.__wphotoIsBatchAborted === "function" &&
      window.__wphotoIsBatchAborted();

    let abortController = null;
    if (typeof AbortController === "function") {
      abortController = new AbortController();
      if (typeof window !== "undefined") {
        window.__wphotoActiveAbortController = abortController;
      }
    }

    const buildReqInit = (useThinkingConfig) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(abortController ? { signal: abortController.signal } : {}),
      body: JSON.stringify({
        contents: [{ parts }],
        ...(sysInst ? { system_instruction: sysInst } : {}),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 250,
          ...(useThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }
      })
    });

    try {
      let activeModel =
        model === "gemini-3.1-flash-lite" && cachedWorkingCloudModel
          ? cachedWorkingCloudModel
          : model;
      let resp = null;
      let retries429 = 0;
      const maxRetries429 = Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
        ? retryDelaysMs.length
        : DEFAULT_429_BACKOFF_MS.length;

      for (let attempt = 0; attempt <= maxRetries429; attempt++) {
        if (isAborted()) {
          return { error: "batch_aborted", retries429 };
        }
        resp = await fetchWithTimeout(
          buildUrl(activeModel),
          buildReqInit(thinkingConfigSupported),
          15000
        );
        if (resp.status === 404 && activeModel === "gemini-3.1-flash-lite") {
          activeModel = "gemini-3.1-flash-lite-preview";
          cachedWorkingCloudModel = activeModel;
          resp = await fetchWithTimeout(
            buildUrl(activeModel),
            buildReqInit(thinkingConfigSupported),
            15000
          );
        }
        if (resp.status === 400 && thinkingConfigSupported) {
          thinkingConfigSupported = false;
          resp = await fetchWithTimeout(buildUrl(activeModel), buildReqInit(false), 15000);
        }
        if (resp.ok && activeModel === "gemini-3.1-flash-lite-preview") {
          cachedWorkingCloudModel = activeModel;
        }
        if (resp.status === 429 && attempt < maxRetries429) {
          retries429++;
          const waitMs = resolve429RetryDelayMs(resp, attempt, retryDelaysMs);
          if (typeof onRetry === "function") {
            try {
              onRetry(retries429, waitMs);
            } catch (e) {}
          }
          await sleepMs(waitMs);
          if (isAborted()) {
            return { error: "batch_aborted", retries429 };
          }
          continue;
        }
        break;
      }

      if (isAborted()) {
        return { error: "batch_aborted", retries429 };
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return {
          error: "gemini_api_error_" + resp.status + ": " + errText.slice(0, 150),
          retries429
        };
      }
      const data = await resp.json();
      const candParts = data?.candidates?.[0]?.content?.parts;
      let text = null;
      if (Array.isArray(candParts)) {
        const nonThought = candParts.filter(
          (p) => p && !p.thought && typeof p.text === "string" && p.text.trim().length > 0
        );
        if (nonThought.length > 0) {
          text = nonThought.map((p) => p.text.trim()).join(" ");
        } else {
          const anyText = candParts.find((p) => p && typeof p.text === "string" && p.text.trim().length > 0);
          if (anyText) text = anyText.text.trim();
        }
      }
      return typeof text === "string" && text.trim().length > 0
        ? { text: text.trim(), retries429 }
        : { error: "empty_gemini_reply", retries429 };
    } catch (e) {
      if (isAborted() || e?.name === "AbortError") {
        return { error: "batch_aborted" };
      }
      return { error: "gemini_fetch_failed: " + String(e?.message || e) };
    } finally {
      if (
        typeof window !== "undefined" &&
        abortController &&
        window.__wphotoActiveAbortController === abortController
      ) {
        window.__wphotoActiveAbortController = null;
      }
    }
  }

  async function ensureNanoInjected() {
    if (typeof location !== "undefined" && nanoInjectedOrigin === location.origin) return true;
    try {
      const res = await window.WPhotoDomCaption.sendToBackground({ type: "BATCH_NANO_INJECT" });
      if (res?.ok) {
        if (typeof location !== "undefined") nanoInjectedOrigin = location.origin;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function sendNanoMessage(payload, timeoutMs, onProgress) {
    if (!(await ensureNanoInjected())) return null;
    const id = `n${++nanoMsgSeq}_${Date.now()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, timeoutMs);

      function listener(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.ns !== "wphotoNanoReply" || data.id !== id) return;
        if (typeof data.progressPct === "number") {
          onProgress?.(data.progressPct);
          return;
        }
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(data);
      }

      window.addEventListener("message", listener);
      window.postMessage({ ns: "wphotoNano", id, ...payload }, window.location.origin);
    });
  }

  async function probeNanoAvailability() {
    const res = await sendNanoMessage({ op: "probe" }, 3000);
    const status = res?.status;
    return status === "available" || status === "downloadable" || status === "downloading"
      ? status
      : "unavailable";
  }

  async function downloadNanoModel(onProgress) {
    const res = await sendNanoMessage({ op: "download" }, 300000, onProgress);
    return res?.status === "available" ? "available" : "unavailable";
  }

  function parseCurrentPhotoId() {
    if (typeof location === "undefined" || typeof location.pathname !== "string") return null;
    const m = location.pathname.match(/\/photo\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function isInsideInfoPanel(el) {
    if (!el || typeof el.closest !== "function") return false;
    if (
      el.closest(
        'dl, [aria-label="Info" i], [aria-label="Informations" i], [aria-label="Información" i]'
      )
    ) {
      return true;
    }
    if (typeof document !== "undefined" && typeof el.getBoundingClientRect === "function") {
      const dl = document.querySelector("dl");
      if (dl && dl.offsetParent !== null && typeof dl.getBoundingClientRect === "function") {
        const dlRect = dl.getBoundingClientRect();
        const winW = typeof window !== "undefined" ? window.innerWidth || 1280 : 1280;
        if (dlRect.width > 0 && dlRect.left > winW * 0.45) {
          const r = el.getBoundingClientRect();
          if (r && r.left >= dlRect.left - 16) return true;
        }
      }
    }
    return false;
  }

  function hasThumbVisual(el) {
    if (!el) return false;
    if (el.tagName === "IMG") return true;
    if (typeof el.querySelector === "function") {
      if (el.querySelector("img")) return true;
      if (el.querySelector('[style*="background-image"]')) return true;
    }
    if (el.style && typeof el.style.backgroundImage === "string" && el.style.backgroundImage.includes("url(")) {
      return true;
    }
    const p = el.parentElement;
    if (p && typeof p.querySelector === "function") {
      const pRect = typeof p.getBoundingClientRect === "function" ? p.getBoundingClientRect() : null;
      if (!pRect || (pRect.width <= 165 && pRect.height <= 165)) {
        if (p.querySelector("img") || p.querySelector('[style*="background-image"]')) return true;
      }
    }
    if (typeof getComputedStyle === "function" && el instanceof Element) {
      try {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg.startsWith("url(")) return true;
      } catch (e) {}
    }
    return false;
  }

  function wakeViewerControls() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    try {
      const winW = window.innerWidth || 1280;
      const winH = window.innerHeight || 800;
      const targets = [
        ...Array.from(document.querySelectorAll("img")).filter((el) => el.naturalWidth > 200),
        document.body
      ].filter(Boolean);
      for (const t of targets.slice(0, 3)) {
        for (const type of ["mouseenter", "mouseover", "pointermove", "mousemove"]) {
          const Ctor = type.startsWith("pointer")
            ? window.PointerEvent || window.MouseEvent || (typeof Event !== "undefined" ? Event : null)
            : window.MouseEvent || (typeof Event !== "undefined" ? Event : null);
          if (Ctor && typeof t.dispatchEvent === "function") {
            t.dispatchEvent(
              new Ctor(type, {
                bubbles: true,
                cancelable: true,
                clientX: Math.round(winW * 0.4),
                clientY: Math.round(winH * 0.85)
              })
            );
          }
        }
      }
    } catch (e) {}
  }

  function findStackThumbs() {
    if (typeof document === "undefined") return [];

    // Strategy 1: Explicit button / role selectors (includes unit-test compatible selector)
    const explicitCandidates = Array.from(
      document.querySelectorAll(
        'button[aria-label*="Photo "], button[aria-label*="photo "], [role="button"][data-stack-item], button[data-photo-id], [role="listitem"] button'
      )
    );
    let thumbs = explicitCandidates.filter(
      (el) =>
        el.offsetParent !== null &&
        hasThumbVisual(el) &&
        !isInsideInfoPanel(el) &&
        (el.getBoundingClientRect?.().height ?? 80) < 160
    );
    if (thumbs.length > 1) return thumbs;

    // Strategy 2: Expanded role/aria selectors across EN/FR/ES
    const roleCandidates = Array.from(
      document.querySelectorAll(
        '[role="button"][aria-label*="Photo " i], [role="option"][aria-label*="Photo " i], [role="tab"][aria-label*="Photo " i], ' +
          'button[aria-label*="Foto " i], [role="button"][aria-label*="Foto " i], [role="option"][aria-label*="Foto " i], [role="tab"][aria-label*="Foto " i], ' +
          '[aria-label*="Top pick" i], [aria-label*="Meilleure photo" i], [aria-label*="Mejor foto" i], [aria-label*="Mejor toma" i], ' +
          '[data-stack-item], [data-photo-id], [role="listitem"] [role="button"], [role="option"], [role="tab"]'
      )
    );
    thumbs = roleCandidates.filter((el) => {
      if (el.offsetParent === null || !hasThumbVisual(el) || isInsideInfoPanel(el)) return false;
      const r = el.getBoundingClientRect?.();
      return !r || ((r.height === undefined || (r.height >= 20 && r.height < 160)) && (r.width === undefined || r.width < 160));
    });
    if (thumbs.length > 1) return thumbs;

    // Strategy 3: Strip container selectors
    const strips = Array.from(
      document.querySelectorAll(
        '[role="region"][aria-label*="Photos in stack"], [aria-label*="stack" i], [aria-label*="pile" i], [aria-label*="pila" i], [jsname="bCqjTe"], [data-filmstrip], [role="listbox"], [role="tablist"]'
      )
    ).filter((s) => !isInsideInfoPanel(s));
    for (const strip of strips) {
      const stripItems = Array.from(
        strip.querySelectorAll('button, [role="button"], [role="option"], [role="tab"], [role="listitem"], a, [jsaction], [tabindex]')
      ).filter(
        (el) =>
          el.offsetParent !== null &&
          hasThumbVisual(el) &&
          (el.getBoundingClientRect?.().height ?? 80) < 160
      );
      if (stripItems.length > 1) return stripItems;
    }

    // Strategy 4: Geometric bottom-filmstrip row discovery (language & class agnostic)
    const winH = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
    const rawVisuals = Array.from(
      document.querySelectorAll('img, [style*="background-image"], button, [role="button"], [role="option"], [role="tab"]')
    ).filter((el) => {
      if (el.offsetParent === null || isInsideInfoPanel(el) || !hasThumbVisual(el)) return false;
      const r = el.getBoundingClientRect?.();
      if (!r || typeof r.top !== "number") return false;
      return (
        r.width >= 22 &&
        r.width <= 150 &&
        r.height >= 22 &&
        r.height <= 150 &&
        r.top >= winH * 0.55 &&
        r.bottom <= winH + 12
      );
    });

    if (rawVisuals.length > 1) {
      const items = [];
      for (const vis of rawVisuals) {
        let best = vis;
        let cur = vis;
        for (let d = 0; d < 4 && cur && cur.parentElement; d++, cur = cur.parentElement) {
          const r = cur.getBoundingClientRect?.();
          if (!r || r.width > 165 || r.height > 165 || r.width < 20 || r.height < 20) break;
          const role = cur.getAttribute?.("role");
          if (
            cur.tagName === "BUTTON" ||
            cur.tagName === "A" ||
            role === "button" ||
            role === "option" ||
            role === "tab" ||
            role === "listitem" ||
            cur.hasAttribute?.("jsaction") ||
            cur.hasAttribute?.("tabindex")
          ) {
            best = cur;
          }
        }
        if (!items.some((existing) => existing === best || existing.contains?.(best) || best.contains?.(existing))) {
          items.push(best);
        }
      }

      // Find a horizontal row of >= 2 items at the same vertical center
      for (const base of items) {
        const br = base.getBoundingClientRect();
        const bcy = br.top + br.height / 2;
        const row = items
          .filter((other) => {
            const or = other.getBoundingClientRect();
            const ocy = or.top + or.height / 2;
            return Math.abs(bcy - ocy) <= 18;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

        // Deduplicate items with virtually identical horizontal position
        const distinctRow = [];
        for (const item of row) {
          const ir = item.getBoundingClientRect();
          if (
            distinctRow.length === 0 ||
            Math.abs(ir.left - distinctRow[distinctRow.length - 1].getBoundingClientRect().left) >= 16
          ) {
            distinctRow.push(item);
          }
        }
        if (distinctRow.length > 1) {
          return distinctRow;
        }
      }
    }

    return thumbs;
  }

  function findMainPhotoImage() {
    if (typeof document === "undefined") return null;
    const imgs = Array.from(document.querySelectorAll("img"))
      .filter((el) => {
        if (el.naturalWidth <= 200) return false;
        if (typeof el.checkVisibility === "function") {
          return el.checkVisibility({
            visibilityProperty: true,
            opacityProperty: true,
            contentVisibilityAuto: true
          });
        }
        return el.offsetParent !== null;
      })
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    return imgs[0]?.src ?? null;
  }

  async function runAiDescription(options = {}) {
    const dom = window.WPhotoDomCaption;
    const t0 = performance.now();
    const timing = {
      panelOpenMs: -1,
      textareaVisibleMs: -1,
      focusToInsertMs: -1,
      blurToSettleMs: -1,
      totalMs: -1,
      retried: false,
      metadataMs: -1,
      generateMs: -1,
      peopleCount: 0,
      hadLocation: false,
      usedAi: false
    };

    const getPhotoId = () =>
      options.photoId ||
      (typeof location !== "undefined" && location.pathname.match(/\/photo\/([^/?#]+)/)?.[1]) ||
      "unknown";

    const logStep = (step, details) => {
      if (!options.verbose) return;
      const elapsed = Math.round(performance.now() - t0);
      appendAiDescLog(
        `photo: ${getPhotoId()} | +${elapsed}ms | [${step}]${details ? " | " + details : ""}`
      );
    };

    let finalCaption = null;
    const logFinal = (success, err, det) => {
      if (!options.verbose) return;
      const mName = options.model || "cloud";
      const resStr = success
        ? finalCaption
          ? `"${finalCaption}"`
          : "SUCCESS"
        : err
        ? err + (det ? ` (${det})` : "")
        : "failed";
      appendAiDescLog(
        `photo: ${getPhotoId()} | model: ${mName} | ${
          success ? "response: " : "error: "
        }${resStr} | timing: panelOpen=${timing.panelOpenMs}ms metadata=${timing.metadataMs}ms generate=${timing.generateMs}ms focusInsert=${timing.focusToInsertMs}ms total=${Math.round(
          performance.now() - t0
        )}ms`
      );
    };

    const finish = (success, error, errorDetail) => {
      logFinal(success, error, errorDetail);
      timing.totalMs = Math.round(performance.now() - t0);
      return { success, error, errorDetail, timing };
    };

    if (typeof document !== "undefined" && document.querySelector("video")) {
      return finish(false, "skipped_video", "video items are not supported");
    }
    if (dom.isPhotoNotFoundPage?.()) {
      return finish(false, "skipped_unowned", "photo not found (not in your library)");
    }

    // Ensure the main viewer image has mounted/hydrated before checking or toggling the Info panel
    const entryUrlPhotoId = parseCurrentPhotoId();
    let photoImg = findMainPhotoImage();
    const preHydrateStart = performance.now();
    while (!photoImg && performance.now() - preHydrateStart < 3500) {
      await dom.sleep(150);
      if (typeof document !== "undefined" && document.querySelector("video")) {
        return finish(false, "skipped_video", "video items are not supported");
      }
      if (dom.isPhotoNotFoundPage?.()) {
        return finish(false, "skipped_unowned", "photo not found (not in your library)");
      }
      photoImg = findMainPhotoImage();
      if (
        !photoImg &&
        performance.now() - preHydrateStart >= 1200 &&
        !dom.findInfoButton?.() &&
        !dom.isInfoPanelOpen?.()
      ) {
        break;
      }
    }

    // If Google Photos redirected a Photo Stack URL to its Top Pick during load, give the viewer a brief settle
    if (parseCurrentPhotoId() && entryUrlPhotoId && parseCurrentPhotoId() !== entryUrlPhotoId) {
      await dom.sleep(300);
      photoImg = findMainPhotoImage() || photoImg;
    }
    const prePanelUrlPhotoId = parseCurrentPhotoId();

    logStep("panel_open_start");
    const panelStart = performance.now();
    let panelRes = await dom.ensureInfoPanelOpen();
    if (!panelRes.ok) {
      logStep("panel_open_failed", `${panelRes.error} (${panelRes.detail})`);
      if (panelRes.error === "info_button_not_found" && !photoImg) {
        return finish(false, "skipped_unowned", "photo not found or uneditable");
      }
      return finish(false, panelRes.error, panelRes.detail);
    }
    timing.panelOpenMs = Math.round(performance.now() - panelStart);
    logStep("panel_open_success", `${timing.panelOpenMs}ms`);

    const shouldOverwrite = options.overwrite === true || options.overwrite === "yes";
    if (!shouldOverwrite) {
      let ta = dom.findVisibleDescriptionTextarea();
      if (!ta) {
        const wStart = performance.now();
        while (!ta && performance.now() - wStart < 1500) {
          await dom.sleep(150);
          ta = dom.findVisibleDescriptionTextarea();
        }
      }
      if (ta && typeof ta.value === "string" && ta.value.trim().length > 0) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }
    }

    logStep("metadata_fetch_start");
    const metaStart = performance.now();
    let metadata = await dom.extractMetadataWithStabilization();

    // If Google Photos redirected the stack URL while opening the panel or fetching metadata, re-verify panel & metadata
    if (parseCurrentPhotoId() && prePanelUrlPhotoId && parseCurrentPhotoId() !== prePanelUrlPhotoId) {
      logStep("stack_redirect_settled", `${prePanelUrlPhotoId} -> ${parseCurrentPhotoId()}`);
      await dom.ensureInfoPanelOpen();
      metadata = await dom.extractMetadataWithStabilization();
    }

    timing.metadataMs = Math.round(performance.now() - metaStart);
    timing.peopleCount = metadata.people.length;
    timing.hadLocation = metadata.location !== null;
    logStep(
      "metadata_fetch_done",
      `${timing.metadataMs}ms (people=${timing.peopleCount}, location=${timing.hadLocation})`
    );

    if (await dom.isInfoPanelReadOnlyUnowned?.()) {
      logStep("skipped_unowned", "info panel has no editable description field");
      return finish(false, "skipped_unowned", "photo cannot be edited (not owned by you)");
    }

    if (!shouldOverwrite) {
      const ta = dom.findVisibleDescriptionTextarea();
      if (ta && typeof ta.value === "string" && ta.value.trim().length > 0) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }
    }

    // Always refresh photoImg right before generation so stack Top Pick redirects never leave a stale image URL
    photoImg = findMainPhotoImage() || photoImg;
    if (!photoImg) {
      const imgWaitStart = performance.now();
      while (!photoImg && performance.now() - imgWaitStart < 2500) {
        await dom.sleep(150);
        photoImg = findMainPhotoImage();
      }
    }
    logStep("image_found", photoImg ? "ready" : "not_found");
    wakeViewerControls();
    const preGenStackCount = findStackThumbs().length;

    const lang = options.lang || "en";
    const rulesText = buildRules(metadata, lang);
    const instrText = buildInstruction(metadata, lang);

    const genStart = performance.now();
    let genErrorDetail = null;

    if (options.model === "cloud") {
      let apiKeyVal = null;
      try {
        const stored = await chrome.storage.local.get("geminiApiKey");
        apiKeyVal = stored?.geminiApiKey;
      } catch (e) {}

      if (!apiKeyVal || typeof apiKeyVal !== "string" || !apiKeyVal.trim()) {
        genErrorDetail = "missing_gemini_api_key: Please configure your Google AI Studio API key";
      } else {
        const cloudRes = await callGeminiCloud({
          apiKey: apiKeyVal.trim(),
          model: "gemini-3.1-flash-lite",
          rules: rulesText,
          instruction: instrText,
          imgSrc: photoImg,
          lang,
          onRetry: (attempt, waitMs) => {
            logStep("cloud_retry_429", `attempt=${attempt} wait=${waitMs}ms`);
          }
        });
        if (cloudRes?.error === "batch_aborted") {
          return finish(false, "batch_aborted", "cancelled by user");
        }
        if (cloudRes && !cloudRes.error && typeof cloudRes.text === "string") {
          const cleaned = cleanGeneratedCaption(cloudRes.text);
          if (cleaned.length > 0) {
            finalCaption = cleaned;
            timing.usedAi = true;
          } else {
            genErrorDetail = "cloud model returned empty caption";
          }
        } else {
          genErrorDetail = cloudRes ? cloudRes.error ?? "empty reply" : "cloud api error";
        }
      }
      timing.generateMs = Math.round(performance.now() - genStart);
      if (!finalCaption) {
        return finish(false, "skipped_cloud_error", genErrorDetail || "cloud model failed");
      }
    } else {
      const avail = await probeNanoAvailability();
      if (avail === "available" && photoImg) {
        const nanoRes = await sendNanoMessage(
          { op: "generate", imgSrc: photoImg, rules: rulesText, instruction: instrText },
          GENERATE_TIMEOUT_MS + 15000
        );
        if (nanoRes && !nanoRes.error && typeof nanoRes.text === "string") {
          const cleaned = cleanGeneratedCaption(nanoRes.text);
          if (cleaned.length > 0) {
            finalCaption = cleaned;
            timing.usedAi = true;
          } else {
            genErrorDetail = "local model returned empty caption";
          }
        } else {
          genErrorDetail = nanoRes ? nanoRes.error ?? "empty reply" : "bridge timeout";
        }
      }
      timing.generateMs = Math.round(performance.now() - genStart);
      if (finalCaption === null) {
        finalCaption = composeMetadataCaption(metadata, lang);
        if (finalCaption === null) {
          return finish(false, "skipped_no_metadata", genErrorDetail || "no metadata for fallback");
        }
      }
    }

    if (
      typeof window !== "undefined" &&
      typeof window.__wphotoIsBatchAborted === "function" &&
      window.__wphotoIsBatchAborted()
    ) {
      return finish(false, "batch_aborted", "cancelled by user");
    }

    if (!shouldOverwrite) {
      const ta = dom.findVisibleDescriptionTextarea();
      if (ta && typeof ta.value === "string" && ta.value.trim().length > 0) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }
    }

    const capRes = await dom.runCaption({
      text: finalCaption,
      overwrite: shouldOverwrite
    });
    if (!capRes.success) {
      return finish(false, capRes.error, capRes.errorDetail);
    }

    // Photo stack propagation: apply the same description to all other photos in the stack
    const extraStackPhotoIds = [];
    const primaryTaggedId = parseCurrentPhotoId() || options.photoId;
    if (primaryTaggedId && options.photoId && primaryTaggedId !== options.photoId) {
      extraStackPhotoIds.push(primaryTaggedId);
    }
    const visitedStackIds = new Set([primaryTaggedId].filter(Boolean));

    try {
      const isThumbExplicitlySelected = (el) => {
        let cur = el;
        for (let d = 0; d < 3 && cur; d++, cur = cur.parentElement) {
          if (
            cur.getAttribute?.("aria-selected") === "true" ||
            cur.getAttribute?.("aria-current") === "true" ||
            cur.getAttribute?.("aria-pressed") === "true"
          ) {
            return true;
          }
        }
        return false;
      };

      wakeViewerControls();
      let stackThumbs = findStackThumbs();
      if (stackThumbs.length <= 1 && preGenStackCount > 1) {
        await dom.waitFor(
          () => {
            wakeViewerControls();
            stackThumbs = findStackThumbs();
            return stackThumbs.length > 1 ? stackThumbs : null;
          },
          700,
          100
        );
      }

      if (stackThumbs.length > 1) {
        logStep("stack_detected", `count=${stackThumbs.length} primary=${primaryTaggedId}`);
        for (let idx = 0; idx < stackThumbs.length; idx++) {
          if (
            typeof window !== "undefined" &&
            typeof window.__wphotoIsBatchAborted === "function" &&
            window.__wphotoIsBatchAborted()
          ) {
            break;
          }
          wakeViewerControls();
          const curThumbs = findStackThumbs();
          const targetThumb =
            curThumbs[idx] ||
            curThumbs.find(
              (t) =>
                t.getAttribute?.("aria-label") &&
                t.getAttribute?.("aria-label") === stackThumbs[idx].getAttribute?.("aria-label")
            ) ||
            stackThumbs[idx];
          if (!targetThumb) continue;
          if (isThumbExplicitlySelected(targetThumb)) continue;

          const beforeId = parseCurrentPhotoId();
          const beforeTa = dom.findVisibleDescriptionTextarea();

          if (dom.triggerDirectDomClick) {
            dom.triggerDirectDomClick(targetThumb);
          } else if (typeof targetThumb.click === "function") {
            targetThumb.click();
          }
          const innerClickable = targetThumb.querySelector?.('button, [role="button"], a, img');
          if (innerClickable && innerClickable !== targetThumb) {
            try {
              innerClickable.click?.();
            } catch (e) {}
          }

          await dom.sleep(300);
          let subPhotoId = parseCurrentPhotoId();

          // If DOM click did not switch the stack item, dispatch a hardware CDP click at the thumbnail center
          if (
            subPhotoId === beforeId &&
            !isThumbExplicitlySelected(targetThumb) &&
            typeof targetThumb.getBoundingClientRect === "function"
          ) {
            const r = targetThumb.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0 && typeof r.left === "number" && typeof r.top === "number") {
              await dom.sendToBackground({
                type: "BATCH_DISPATCH_CLICK_AT",
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2)
              });
              await dom.waitFor(
                () => {
                  const cid = parseCurrentPhotoId();
                  return (cid && cid !== beforeId) || isThumbExplicitlySelected(targetThumb);
                },
                700,
                80
              );
              subPhotoId = parseCurrentPhotoId();
            }
          }

          if (subPhotoId === beforeId && !isThumbExplicitlySelected(targetThumb)) {
            continue;
          }
          if (subPhotoId && visitedStackIds.has(subPhotoId)) {
            continue;
          }
          if (subPhotoId) {
            visitedStackIds.add(subPhotoId);
            if (subPhotoId !== options.photoId && !extraStackPhotoIds.includes(subPhotoId)) {
              extraStackPhotoIds.push(subPhotoId);
            }
          }

          logStep("stack_sub_start", `idx=${idx + 1}/${stackThumbs.length} id=${subPhotoId || "unknown"}`);

          // Wait briefly for the Info panel textarea to update for the newly selected stack item
          if (beforeTa) {
            await dom.waitFor(
              () => {
                const curTa = dom.findVisibleDescriptionTextarea();
                return !curTa || curTa !== beforeTa || (curTa.value || "").trim() !== finalCaption.trim();
              },
              600,
              80
            );
          }

          await dom.ensureInfoPanelOpen();
          const subTa = dom.findVisibleDescriptionTextarea();
          const subVal = subTa && typeof subTa.value === "string" ? subTa.value.trim() : "";
          const hasDifferentExisting = subVal.length > 0 && subVal !== finalCaption.trim();
          if (shouldOverwrite || !hasDifferentExisting) {
            const subCapRes = await dom.runCaption({
              text: finalCaption,
              overwrite: true,
              forceWrite: true
            });
            logStep(
              "stack_sub_done",
              `idx=${idx + 1}/${stackThumbs.length} id=${subPhotoId || "unknown"} ok=${subCapRes.success}`
            );
          } else {
            logStep("stack_sub_skipped_existing", `idx=${idx + 1}/${stackThumbs.length} id=${subPhotoId || "unknown"}`);
          }
          await dom.sleep(200);
        }
      }
    } catch (e) {}

    timing.textareaVisibleMs = capRes.timing.textareaVisibleMs;
    timing.focusToInsertMs = capRes.timing.focusToInsertMs;
    timing.blurToSettleMs = capRes.timing.blurToSettleMs;
    timing.retried = capRes.timing.retried;

    return finish(
      true,
      undefined,
      extraStackPhotoIds.length > 0 ? JSON.stringify({ extraCompletedIds: extraStackPhotoIds }) : undefined
    );
  }

  window.WPhotoAiEngine = {
    getPromptConfig,
    extractFirstNames,
    joinNamesList,
    buildRules,
    buildInstruction,
    composeMetadataCaption,
    cleanGeneratedCaption,
    callGeminiCloud,
    probeNanoAvailability,
    downloadNanoModel,
    runAiDescription,
    findStackThumbs,
    clearAiDescLog,
    getAiDescLog,
    appendAiDescLog
  };
})();
