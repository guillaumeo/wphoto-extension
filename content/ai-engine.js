// AI Description Engine (Cloud Gemini + Local Gemini Nano + Multi-Language Template Interpolation + Stack Propagation)

(function () {
  const CAPTION_MAX_LENGTH = 1000;
  const GENERATE_TIMEOUT_MS = 35000;
  const DEFAULT_429_BACKOFF_MS = [2000, 5000, 10000];
  const DEFAULT_CLOUD_MODEL = "gemini-flash-latest";
  const FALLBACK_CLOUD_MODEL = "gemini-2.5-flash";
  let nanoMsgSeq = 0;
  let nanoInjectedOrigin = null;
  let logWriteBusy = false;
  let logPendingLines = [];
  let logGeneration = 0;
  let cachedWorkingCloudModel = null;
  let thinkingConfigSupported = true;

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
    const andWord = getPromptConfig(lang).andWord || "and";
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

    let peoplePart;
    if (firstNames.length > 0) {
      let peopleListStr = firstNames.join(", ");
      if (untaggedCount > 0) {
        const untaggedPhrase =
          untaggedCount === 1
            ? tpl.untaggedOne || "one additional untagged person"
            : (tpl.untaggedMany || "{count} additional untagged people").replace(/\{count\}/g, String(untaggedCount));
        peopleListStr += `, ${lang === "es" ? "más" : "plus"} ${untaggedPhrase}`;
      }
      peoplePart = (tpl.peopleTagged || "Tagged people in this photo: {people}.").replace(/\{people\}/g, peopleListStr);
    } else {
      peoplePart = tpl.peopleNone || "No people are tagged in this photo.";
    }

    const locationPart = location
      ? (tpl.locationRule || "The tagged place name is '{location}'.").replace(/\{location\}/g, location)
      : "";
    return [peoplePart, tpl.strictRules || "", locationPart].filter(Boolean).join(" ");
  }

  function buildInstruction(metadata, lang = "en") {
    const tpl = getPromptConfig(lang);
    const firstNames = extractFirstNames(metadata?.people || []);
    if (firstNames.length > 0) {
      return (tpl.instructionWithPeople || "").replace(/\{names\}/g, joinNamesList(firstNames, lang));
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
    let text =
      firstNames.length > 0
        ? joinNamesList(firstNames, lang) + (location ? ` ${inWord} ${location}` : "")
        : `${location}`;
    if (year) text += `, ${year}`;
    return (text + ".").slice(0, CAPTION_MAX_LENGTH);
  }

  function cleanGeneratedCaption(rawText) {
    const lines = String(rawText || "")
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length > 1 && /^(here'?s|voici|voil[àa]|aqu[íi]\s+tienes|he\s+aqu[íi])\b.*:$/i.test(lines[0])) {
      lines.shift();
    }

    let text = lines
      .join(" ")
      .replace(/\*\*/g, "")
      .replace(/^["'\u201c\u2018\u00ab]+|["'\u201d\u2019\u00bb]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const stripped = text
      .replace(/^(here'?s|here\s+is)(?:\s+(?:a|an|the)?\s*(?:suggested\s+)?(?:caption|description)?)?\s*[:.-]?\s*/i, "")
      .replace(
        /^(voici|voil[àa])(?:\s+(?:une|la|cette)?\s*(?:proposition\s+de\s+)?(?:l[ée]gende|description)?\s*(?:pour|de)?\s*(?:la|cette)?\s*(?:photo|image)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(
        /^(aqu[íi]\s+tienes|he\s+aqu[íi])(?:\s+(?:una|la|esta)?\s*(?:propuesta\s+de\s+)?(?:leyenda|descripci[óo]n|pie\s+de\s+foto)?)?\s*[:.-]?\s*/i,
        ""
      )
      .replace(/^(a |an |the )?(photo(graph)?|image|picture|snapshot)\b( of| shows| showing| features| depicting| with)?[,:]?\s*/i, "")
      .replace(/^((une |la |cette )?(photo(graphie)?|image|vue|clich[ée])\b( de| d'| montre| montrant| pr[ée]sentant| avec)?[,:]?\s*)/i, "")
      .replace(/^((una |la |esta )?(foto(graf[íi]a)?|imagen|vista|instant[áa]nea)\b( de| muestra| mostrando| con)?[,:]?\s*)/i, "");

    if (stripped.length >= 10 && stripped !== text) {
      text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }

    const twoSentences = text.match(/^[^.!?]*[.!?](?:\s+[^.!?]*[.!?])?/);
    if (twoSentences && twoSentences[0].trim().length >= 15) {
      text = twoSentences[0].trim();
    }
    return text.slice(0, CAPTION_MAX_LENGTH);
  }

  const isBatchAbortedNow = () =>
    typeof window !== "undefined" &&
    typeof window.__wphotoIsBatchAborted === "function" &&
    window.__wphotoIsBatchAborted();

  function flushLogQueue() {
    if (logWriteBusy || logPendingLines.length === 0) return;
    logWriteBusy = true;
    const gen = logGeneration;
    const batchText = logPendingLines.join("");
    logPendingLines = [];
    const finishSet = () => {
      logWriteBusy = false;
      if (logPendingLines.length > 0 && gen === logGeneration) flushLogQueue();
    };
    try {
      let handled = false;
      const onRead = (data) => {
        if (handled) return;
        handled = true;
        if (gen !== logGeneration) {
          logWriteBusy = false;
          return;
        }
        const nextLog = (((data && data.aiDescriptionVerboseLog) || "") + batchText).slice(-500000);
        let setDone = false;
        const done = () => {
          if (setDone) return;
          setDone = true;
          finishSet();
        };
        try {
          const p = chrome.storage.local.set({ aiDescriptionVerboseLog: nextLog }, done);
          if (p?.then) p.then(done, done);
        } catch (e) {
          done();
        }
      };
      const g = chrome.storage.local.get("aiDescriptionVerboseLog", onRead);
      if (g?.then) {
        g.then(onRead, () => {
          logWriteBusy = false;
        });
      }
    } catch (e) {
      logWriteBusy = false;
    }
  }

  async function clearAiDescLog() {
    logGeneration++;
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
    logPendingLines.push(`[${new Date().toISOString()}] ${msg}\n`);
    flushLogQueue();
  }

  if (typeof window !== "undefined") {
    window.__batchAppendLog = appendAiDescLog;
  }

  function sleepMs(ms) {
    return typeof window !== "undefined" && window.WPhotoDomCaption?.sleep
      ? window.WPhotoDomCaption.sleep(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resolve429RetryDelayMs(resp, attemptIndex, customDelays) {
    const schedule =
      Array.isArray(customDelays) && customDelays.length > 0
        ? customDelays
        : typeof window !== "undefined" && Array.isArray(window.__wphotoRetryDelaysMs)
        ? window.__wphotoRetryDelaysMs
        : DEFAULT_429_BACKOFF_MS;
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

  async function fetchWithTimeout(url, init, timeoutMs) {
    if (typeof AbortController !== "function" || !timeoutMs) return fetch(url, init);
    const ctrl = new AbortController();
    const parentSignal = init?.signal;
    const onParentAbort = () => ctrl.abort();
    if (parentSignal) {
      if (parentSignal.aborted) ctrl.abort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    const nowFn = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const tStart = nowFn();
    const timer = setTimeout(() => {
      if (nowFn() - tStart >= timeoutMs * 0.5) ctrl.abort();
    }, timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      try {
        parentSignal?.removeEventListener("abort", onParentAbort);
      } catch (e) {}
    }
  }

  function toSizedGooglePhotosUrl(src) {
    if (!src || typeof src !== "string" || !src.includes("googleusercontent.com/")) return src;
    return src.replace(/=(?:w\d+-h\d+|s\d+)[^/]*$/, "=w768-h768");
  }

  async function callGeminiCloud({
    apiKey,
    model = DEFAULT_CLOUD_MODEL,
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
    const parts = [{ text: ((rules ? rules + "\n\n" : "") + instruction).trim() }];
    const isAborted = isBatchAbortedNow;

    let abortController = null;
    if (typeof AbortController === "function") {
      abortController = new AbortController();
      if (typeof window !== "undefined") window.__wphotoActiveAbortController = abortController;
    }

    try {
      if (imgSrc && typeof document !== "undefined") {
        let b64 = null;
        const drawSourceTo768 = (srcObj, sw, sh) => {
          const w = sw || 768;
          const h = sh || 768;
          const scale = Math.min(1, 768 / w, 768 / h);
          const dw = Math.max(1, Math.round(w * scale));
          const dh = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement("canvas");
          canvas.width = dw;
          canvas.height = dh;
          const ctx = canvas.getContext("2d");
          if (!ctx) return null;
          ctx.drawImage(srcObj, 0, 0, dw, dh);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          return dataUrl && dataUrl.includes(",") ? dataUrl.split(",")[1] : null;
        };

        try {
          const img = Array.from(document.querySelectorAll("img")).find(
            (el) => el.src === imgSrc && el.naturalWidth > 0
          );
          if (img) b64 = drawSourceTo768(img, img.naturalWidth, img.naturalHeight);
        } catch (e) {
          b64 = null;
        }

        if (!b64 && typeof fetch === "function" && typeof createImageBitmap === "function") {
          try {
            const sizedUrl = toSizedGooglePhotosUrl(imgSrc);
            const attempts = [
              [sizedUrl, "omit"],
              ...(sizedUrl !== imgSrc ? [[imgSrc, "omit"]] : []),
              [imgSrc, "include"]
            ];
            let imgResp = null;
            for (const [url, credentials] of attempts) {
              if (isAborted()) break;
              imgResp = await fetchWithTimeout(
                url,
                { credentials, ...(abortController ? { signal: abortController.signal } : {}) },
                6000
              ).catch(() => null);
              if (imgResp?.ok) break;
            }
            if (imgResp?.ok) {
              const bmp = await createImageBitmap(await imgResp.blob());
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

        if (isAborted()) return { error: "batch_aborted" };
        if (b64) parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
      }

      const buildUrl = (m) =>
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(m) +
        ":generateContent?key=" +
        encodeURIComponent(apiKey.trim());

      const tpl = getPromptConfig(lang);
      const sysInst = tpl.system ? { parts: [{ text: tpl.system }] } : undefined;
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

      let activeModel =
        model === DEFAULT_CLOUD_MODEL && cachedWorkingCloudModel ? cachedWorkingCloudModel : model;
      let resp = null;
      let retries429 = 0;
      const maxRetries429 =
        Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
          ? retryDelaysMs.length
          : DEFAULT_429_BACKOFF_MS.length;

      for (let attempt = 0; attempt <= maxRetries429; attempt++) {
        if (isAborted()) return { error: "batch_aborted", retries429 };
        resp = await fetchWithTimeout(buildUrl(activeModel), buildReqInit(thinkingConfigSupported), 15000);
        if (resp.status === 404 && activeModel === DEFAULT_CLOUD_MODEL) {
          activeModel = FALLBACK_CLOUD_MODEL;
          cachedWorkingCloudModel = activeModel;
          resp = await fetchWithTimeout(buildUrl(activeModel), buildReqInit(thinkingConfigSupported), 15000);
        }
        if (resp.status === 400 && thinkingConfigSupported) {
          const retryResp = await fetchWithTimeout(buildUrl(activeModel), buildReqInit(false), 15000);
          if (retryResp.ok || retryResp.status !== 400) thinkingConfigSupported = false;
          resp = retryResp;
        }
        if (resp.ok && activeModel === FALLBACK_CLOUD_MODEL) {
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
          if (isAborted()) return { error: "batch_aborted", retries429 };
          continue;
        }
        break;
      }

      if (isAborted()) return { error: "batch_aborted", retries429 };
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return { error: "gemini_api_error_" + resp.status + ": " + errText.slice(0, 150), retries429 };
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
      if (isAborted() || abortController?.signal?.aborted) return { error: "batch_aborted" };
      if (e?.name === "AbortError") return { error: "gemini_fetch_timeout" };
      return { error: "gemini_fetch_failed: " + String(e?.message || e) };
    } finally {
      if (typeof window !== "undefined" && abortController && window.__wphotoActiveAbortController === abortController) {
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
    } catch (e) {}
    return false;
  }

  async function sendNanoMessage(payload, timeoutMs, onProgress) {
    if (!(await ensureNanoInjected())) return null;
    const id = `n${++nanoMsgSeq}_${Date.now()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        nanoInjectedOrigin = null;
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
    const status = (await sendNanoMessage({ op: "probe" }, 3000))?.status;
    return status === "available" || status === "downloadable" || status === "downloading" ? status : "unavailable";
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

  function getInfoPanelLeft() {
    if (typeof document === "undefined") return Infinity;
    const dl = document.querySelector("dl");
    if (dl && dl.offsetParent !== null && typeof dl.getBoundingClientRect === "function") {
      const r = dl.getBoundingClientRect();
      const winW = typeof window !== "undefined" ? window.innerWidth || 1280 : 1280;
      if (r && r.width > 0 && r.left > winW * 0.45) return r.left - 16;
    }
    return Infinity;
  }

  function isInsideInfoPanel(el, panelLeft = Infinity) {
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest('dl, [aria-label="Info" i], [aria-label="Informations" i], [aria-label="Información" i]')) {
      return true;
    }
    if (panelLeft < Infinity && typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      if (r && r.left >= panelLeft) return true;
    }
    return false;
  }

  function hasThumbVisual(el) {
    if (!el) return false;
    if (el.tagName === "IMG") return true;
    if (el.querySelector?.("img") || el.querySelector?.('[style*="background-image"]')) return true;
    if (typeof el.style?.backgroundImage === "string" && el.style.backgroundImage.includes("url(")) return true;
    const p = el.parentElement;
    if (p?.querySelector) {
      const pRect = p.getBoundingClientRect?.();
      if ((!pRect || (pRect.width <= 165 && pRect.height <= 165)) && (p.querySelector("img") || p.querySelector('[style*="background-image"]'))) {
        return true;
      }
    }
    if (typeof getComputedStyle === "function" && el instanceof Element) {
      try {
        if (getComputedStyle(el).backgroundImage?.startsWith("url(")) return true;
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

  function isThumbVisible(el) {
    if (!el) return false;
    if (el.closest?.('[aria-hidden="true"], [hidden]')) return false;
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })) {
          return false;
        }
        const r = el.getBoundingClientRect?.();
        return !r || (r.width !== 0 && r.height !== 0);
      } catch (e) {}
    }
    return el.offsetParent !== null;
  }

  function extractThumbPhotoId(el) {
    if (!el) return null;
    if (el.hasAttribute?.("data-photo-id")) {
      const directId = el.getAttribute?.("data-photo-id")?.trim();
      if (directId) return directId;
    }
    const href =
      (el.hasAttribute?.("href") ? el.getAttribute("href") : "") ||
      el.querySelector?.('a[href*="/photo/"]')?.getAttribute?.("href") ||
      el.closest?.('a[href*="/photo/"]')?.getAttribute?.("href") ||
      "";
    if (typeof href === "string" && href.includes("/photo/")) {
      const mHref = href.match(/\/photo\/([^/?#]+)/);
      if (mHref?.[1]) return mHref[1];
    }
    const jsdata =
      (el.hasAttribute?.("jsdata") ? el.getAttribute("jsdata") : "") ||
      el.querySelector?.("[jsdata]")?.getAttribute?.("jsdata") ||
      el.closest?.("[jsdata]")?.getAttribute?.("jsdata") ||
      "";
    if (typeof jsdata === "string") {
      const mJs = jsdata.match(/\b(AF1Qip[A-Za-z0-9_-]{20,})\b/);
      if (mJs?.[1]) return mJs[1];
    }
    return null;
  }

  function filterStackThumbCandidates(nodes, minHeight = 0, panelLeft = Infinity) {
    return Array.from(nodes).filter((el) => {
      if (!isThumbVisible(el) || !hasThumbVisual(el) || isInsideInfoPanel(el, panelLeft)) return false;
      const r = el.getBoundingClientRect?.();
      if (!r) return true;
      const hOk = r.height === undefined || (r.height >= minHeight && r.height < 160);
      const wOk = minHeight === 0 || r.width === undefined || r.width < 160;
      return hOk && wOk;
    });
  }

  function findStackThumbs() {
    if (typeof document === "undefined") return [];
    const panelLeft = getInfoPanelLeft();

    let thumbs = filterStackThumbCandidates(
      document.querySelectorAll(
        'button[aria-label*="Photo "], button[aria-label*="photo "], [role="button"][data-stack-item], button[data-photo-id], [role="listitem"] button'
      ),
      0,
      panelLeft
    );
    if (thumbs.length > 1) return thumbs;

    thumbs = filterStackThumbCandidates(
      document.querySelectorAll(
        '[role="button"][aria-label*="Photo " i], [role="option"][aria-label*="Photo " i], [role="tab"][aria-label*="Photo " i], ' +
          'button[aria-label*="Foto " i], [role="button"][aria-label*="Foto " i], [role="option"][aria-label*="Foto " i], [role="tab"][aria-label*="Foto " i], ' +
          '[aria-label*="Top pick" i], [aria-label*="Meilleure photo" i], [aria-label*="Mejor foto" i], [aria-label*="Mejor toma" i], ' +
          '[data-stack-item], [data-photo-id], [role="listitem"] [role="button"], [role="option"], [role="tab"]'
      ),
      20,
      panelLeft
    );
    if (thumbs.length > 1) return thumbs;

    const strips = Array.from(
      document.querySelectorAll(
        '[role="region"][aria-label*="Photos in stack"], [aria-label*="stack" i], [aria-label*="pile" i], [aria-label*="pila" i], [jsname="bCqjTe"], [data-filmstrip], [role="listbox"], [role="tablist"]'
      )
    ).filter((s) => !isInsideInfoPanel(s, panelLeft));
    for (const strip of strips) {
      const stripItems = filterStackThumbCandidates(
        strip.querySelectorAll('button, [role="button"], [role="option"], [role="tab"], [role="listitem"], a, [jsaction], [tabindex]'),
        0,
        panelLeft
      );
      if (stripItems.length > 1) return stripItems;
    }

    const winH = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
    const rawVisuals = Array.from(
      document.querySelectorAll('img, [style*="background-image"], button, [role="button"], [role="option"], [role="tab"]')
    ).filter((el) => {
      if (!isThumbVisible(el) || isInsideInfoPanel(el, panelLeft) || !hasThumbVisual(el)) return false;
      const r = el.getBoundingClientRect?.();
      return (
        r &&
        typeof r.top === "number" &&
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
        for (let d = 0; d < 4 && cur?.parentElement; d++, cur = cur.parentElement) {
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
        if (!items.some((e) => e === best || e.contains?.(best) || best.contains?.(e))) {
          items.push(best);
        }
      }

      const boxes = items.map((el) => ({ el, r: el.getBoundingClientRect() }));
      for (const base of boxes) {
        const bcy = base.r.top + base.r.height / 2;
        const row = boxes
          .filter((o) => Math.abs(bcy - (o.r.top + o.r.height / 2)) <= 18)
          .sort((a, b) => a.r.left - b.r.left);

        const distinctRow = [];
        for (const item of row) {
          if (
            distinctRow.length === 0 ||
            Math.abs(item.r.left - distinctRow[distinctRow.length - 1].r.left) >= 16
          ) {
            distinctRow.push(item);
          }
        }
        if (distinctRow.length > 1) return distinctRow.map((d) => d.el);
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
          return el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true });
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

    const getPhotoId = () => options.photoId || parseCurrentPhotoId() || "unknown";
    const logStep = (step, details) => {
      if (!options.verbose) return;
      appendAiDescLog(
        `photo: ${getPhotoId()} | +${Math.round(performance.now() - t0)}ms | [${step}]${details ? " | " + details : ""}`
      );
    };

    let finalCaption = null;
    const logFinal = (success, err, det) => {
      if (!options.verbose) return;
      const resStr = success
        ? finalCaption
          ? `"${finalCaption}"`
          : "SUCCESS"
        : err
        ? err + (det ? ` (${det})` : "")
        : "failed";
      appendAiDescLog(
        `photo: ${getPhotoId()} | model: ${options.model || "cloud"} | ${
          success ? "response: " : "error: "
        }${resStr} | timing: panelOpen=${timing.panelOpenMs}ms metadata=${timing.metadataMs}ms generate=${timing.generateMs}ms focusInsert=${timing.focusToInsertMs}ms total=${Math.round(
          performance.now() - t0
        )}ms`
      );
    };

    const discoveredStackIds = new Set();
    const recordObservedPhotoId = (id) => {
      if (typeof id === "string" && id.trim().length > 0 && id !== "unknown") {
        discoveredStackIds.add(id.trim());
      }
    };
    const collectDomStackPhotoIds = () => {
      recordObservedPhotoId(parseCurrentPhotoId());
      for (const thumb of findStackThumbs()) {
        const pid = extractThumbPhotoId(thumb);
        if (pid) recordObservedPhotoId(pid);
      }
    };
    recordObservedPhotoId(options.photoId);
    collectDomStackPhotoIds();

    const onUserPageActivity = () => recordObservedPhotoId(parseCurrentPhotoId());
    try {
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("popstate", onUserPageActivity, true);
        window.addEventListener("click", onUserPageActivity, true);
      }
    } catch (e) {}

    const finish = (success, error, errorDetail) => {
      logFinal(success, error, errorDetail);
      timing.totalMs = Math.round(performance.now() - t0);
      return { success, error, errorDetail, timing };
    };

    try {
      if (typeof document !== "undefined" && document.querySelector("video")) {
        return finish(false, "skipped_video", "video items are not supported");
      }
      if (dom.isPhotoNotFoundPage?.()) {
        return finish(false, "skipped_unowned", "photo not found (not in your library)");
      }

      const entryUrlPhotoId = parseCurrentPhotoId();
      recordObservedPhotoId(entryUrlPhotoId);
      let photoImg = findMainPhotoImage();
      if (!photoImg) {
        const preHydrateStart = performance.now();
        let earlyStop = null;
        await dom.waitFor(() => {
          collectDomStackPhotoIds();
          if (typeof document !== "undefined" && document.querySelector("video")) {
            earlyStop = ["skipped_video", "video items are not supported"];
            return true;
          }
          if (dom.isPhotoNotFoundPage?.()) {
            earlyStop = ["skipped_unowned", "photo not found (not in your library)"];
            return true;
          }
          photoImg = findMainPhotoImage();
          if (photoImg) return true;
          if (performance.now() - preHydrateStart >= 1200 && !dom.findInfoButton?.() && !dom.isInfoPanelOpen?.()) {
            return true;
          }
          return null;
        }, 3500, 150);
        if (earlyStop) return finish(false, earlyStop[0], earlyStop[1]);
      }

      if (parseCurrentPhotoId() && entryUrlPhotoId && parseCurrentPhotoId() !== entryUrlPhotoId) {
        recordObservedPhotoId(parseCurrentPhotoId());
        await dom.sleep(300);
        photoImg = findMainPhotoImage() || photoImg;
      }
      const prePanelUrlPhotoId = parseCurrentPhotoId();
      recordObservedPhotoId(prePanelUrlPhotoId);

      logStep("panel_open_start");
      const panelStart = performance.now();
      const panelRes = await dom.ensureInfoPanelOpen();
      if (!panelRes.ok) {
        logStep("panel_open_failed", `${panelRes.error} (${panelRes.detail})`);
        if (panelRes.error === "info_button_not_found" && !photoImg) {
          return finish(false, "skipped_unowned", "photo not found or uneditable");
        }
        return finish(false, panelRes.error, panelRes.detail);
      }
      timing.panelOpenMs = Math.round(performance.now() - panelStart);
      logStep("panel_open_success", `${timing.panelOpenMs}ms`);
      collectDomStackPhotoIds();

      const shouldOverwrite = options.overwrite === true || options.overwrite === "yes";
      const hasExistingDescription = () => {
        const ta = dom.findVisibleDescriptionTextarea();
        return Boolean(ta && typeof ta.value === "string" && ta.value.trim().length > 0);
      };

      if (!shouldOverwrite) {
        if (!dom.findVisibleDescriptionTextarea()) {
          await dom.waitFor(() => dom.findVisibleDescriptionTextarea(), 1500, 150);
        }
        if (hasExistingDescription()) {
          return finish(false, "skipped_existing_description", "existing description preserved");
        }
      }

      const hasPrefilledCaption =
        typeof options.prefilledCaption === "string" && options.prefilledCaption.trim().length > 0;
      let metadata = { people: [], untaggedCount: 0, location: null, year: null };

      if (hasPrefilledCaption) {
        if (await dom.isInfoPanelReadOnlyUnowned?.()) {
          logStep("skipped_unowned", "info panel has no editable description field");
          return finish(false, "skipped_unowned", "photo cannot be edited (not owned by you)");
        }
        finalCaption = options.prefilledCaption.trim();
        timing.metadataMs = 0;
        timing.generateMs = 0;
        logStep("stack_caption_reused", `reusing stack caption (${finalCaption.length} chars)`);
      } else {
        logStep("metadata_fetch_start");
        const metaStart = performance.now();
        metadata = await dom.extractMetadataWithStabilization();

        if (parseCurrentPhotoId() && prePanelUrlPhotoId && parseCurrentPhotoId() !== prePanelUrlPhotoId) {
          recordObservedPhotoId(parseCurrentPhotoId());
          logStep("stack_redirect_settled", `${prePanelUrlPhotoId} -> ${parseCurrentPhotoId()}`);
          await dom.ensureInfoPanelOpen();
          metadata = await dom.extractMetadataWithStabilization();
        }

        timing.metadataMs = Math.round(performance.now() - metaStart);
        timing.peopleCount = metadata.people.length;
        timing.hadLocation = metadata.location !== null;
        logStep("metadata_fetch_done", `${timing.metadataMs}ms (people=${timing.peopleCount}, location=${timing.hadLocation})`);

        if (await dom.isInfoPanelReadOnlyUnowned?.()) {
          logStep("skipped_unowned", "info panel has no editable description field");
          return finish(false, "skipped_unowned", "photo cannot be edited (not owned by you)");
        }
        if (!shouldOverwrite && hasExistingDescription()) {
          return finish(false, "skipped_existing_description", "existing description preserved");
        }

        photoImg = findMainPhotoImage() || photoImg;
        if (!photoImg) {
          await dom.waitFor(() => (photoImg = findMainPhotoImage()), 2500, 150);
        }
        logStep("image_found", photoImg ? "ready" : "not_found");
      }

      wakeViewerControls();
      collectDomStackPhotoIds();
      const preGenStackCount = findStackThumbs().length;

      if (!hasPrefilledCaption) {
        const lang = options.lang || "en";
        const rulesText = buildRules(metadata, lang);
        const instrText = buildInstruction(metadata, lang);
        const genStart = performance.now();
        let genErrorDetail = null;

        if (options.model === "cloud") {
          let apiKeyVal = null;
          try {
            apiKeyVal = (await chrome.storage.local.get("geminiApiKey"))?.geminiApiKey;
          } catch (e) {}

          if (!apiKeyVal || typeof apiKeyVal !== "string" || !apiKeyVal.trim()) {
            genErrorDetail = "missing_gemini_api_key: Please configure your Google AI Studio API key";
          } else {
            const cloudRes = await callGeminiCloud({
              apiKey: apiKeyVal.trim(),
              model: DEFAULT_CLOUD_MODEL,
              rules: rulesText,
              instruction: instrText,
              imgSrc: photoImg,
              lang,
              onRetry: (attempt, waitMs) => logStep("cloud_retry_429", `attempt=${attempt} wait=${waitMs}ms`)
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
          if (!finalCaption) return finish(false, "skipped_cloud_error", genErrorDetail || "cloud model failed");
        } else {
          const avail = await probeNanoAvailability();
          if (avail === "available" && photoImg) {
            const nanoRes = await sendNanoMessage(
              { op: "generate", imgSrc: photoImg, rules: rulesText, instruction: instrText },
              GENERATE_TIMEOUT_MS + 15000
            );
            if (isBatchAbortedNow()) return finish(false, "batch_aborted", "cancelled by user");
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
      }

      collectDomStackPhotoIds();
      if (isBatchAbortedNow()) return finish(false, "batch_aborted", "cancelled by user");
      if (!shouldOverwrite && hasExistingDescription()) {
        return finish(false, "skipped_existing_description", "existing description preserved");
      }

      const activeIdBeforePrimary = parseCurrentPhotoId() || options.photoId;
      recordObservedPhotoId(activeIdBeforePrimary);

      const capRes = await dom.runCaption({
        text: finalCaption,
        overwrite: shouldOverwrite || hasPrefilledCaption,
        forceWrite: hasPrefilledCaption
      });
      if (!capRes.success) return finish(false, capRes.error, capRes.errorDetail);

      const primaryTaggedId = parseCurrentPhotoId() || activeIdBeforePrimary || options.photoId;
      recordObservedPhotoId(primaryTaggedId);
      const captionedIds = new Set([primaryTaggedId].filter(Boolean));
      const alreadyDoneSet = new Set([
        ...captionedIds,
        ...(Array.isArray(options.alreadyCompletedIds) ? options.alreadyCompletedIds : [])
      ]);
      const usedTextareas = new Set();
      if (capRes.textarea) usedTextareas.add(capRes.textarea);

      try {
        const hasSelAttr = (n) =>
          n?.getAttribute?.("aria-selected") === "true" ||
          n?.getAttribute?.("aria-current") === "true" ||
          n?.getAttribute?.("aria-pressed") === "true";

        const isThumbExplicitlySelected = (el, allThumbs = []) => {
          let cur = el;
          for (let d = 0; d < 3 && cur; d++, cur = cur.parentElement) {
            if (hasSelAttr(cur)) return true;
          }
          if (hasSelAttr(el.querySelector?.('[aria-selected="true"], [aria-current="true"], [aria-pressed="true"]'))) {
            return true;
          }
          return (
            allThumbs.length > 1 &&
            el.getAttribute?.("tabindex") === "0" &&
            allThumbs.some((t) => t !== el && t.getAttribute?.("tabindex") === "-1")
          );
        };

        wakeViewerControls();
        let stackThumbs = findStackThumbs();
        if (stackThumbs.length <= 1 && preGenStackCount > 1) {
          await dom.waitFor(() => {
            wakeViewerControls();
            stackThumbs = findStackThumbs();
            return stackThumbs.length > 1 ? stackThumbs : null;
          }, 700, 100);
        }

        if (stackThumbs.length > 1) {
          collectDomStackPhotoIds();
          logStep("stack_detected", `count=${stackThumbs.length} primary=${primaryTaggedId}`);
          for (let idx = 0; idx < stackThumbs.length; idx++) {
            if (isBatchAbortedNow()) break;
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
            if (!targetThumb || isThumbExplicitlySelected(targetThumb, curThumbs)) continue;

            const thumbKnownId = extractThumbPhotoId(targetThumb);
            if (thumbKnownId) {
              recordObservedPhotoId(thumbKnownId);
              if (alreadyDoneSet.has(thumbKnownId)) continue;
            }

            const beforeId = parseCurrentPhotoId();
            const beforeImg = findMainPhotoImage();
            const beforeTa = dom.findVisibleDescriptionTextarea();
            if (beforeTa) usedTextareas.add(beforeTa);

            if (dom.triggerDirectDomClick) dom.triggerDirectDomClick(targetThumb);
            else if (typeof targetThumb.click === "function") targetThumb.click();
            if (parseCurrentPhotoId() === beforeId) {
              const innerClickable = targetThumb.querySelector?.('button, [role="button"], a');
              if (innerClickable && innerClickable !== targetThumb && typeof innerClickable.click === "function") {
                try {
                  innerClickable.click();
                } catch (e) {}
              }
            }

            const hasSwitched = () => {
              const cid = parseCurrentPhotoId();
              if (cid && cid !== beforeId) return true;
              if (isThumbExplicitlySelected(targetThumb, findStackThumbs())) return true;
              const curImg = findMainPhotoImage();
              if (curImg && beforeImg && curImg !== beforeImg) return true;
              const newTa = dom.findVisibleDescriptionTextarea({ excludeEls: usedTextareas, strictExclude: true });
              return Boolean(newTa && !usedTextareas.has(newTa));
            };

            let switched = !!(await dom.waitFor(hasSwitched, 450, 75));
            let subPhotoId = parseCurrentPhotoId() || thumbKnownId;

            if (!switched && typeof targetThumb.getBoundingClientRect === "function" && !isBatchAbortedNow()) {
              const r = targetThumb.getBoundingClientRect();
              if (r && r.width > 0 && r.height > 0 && typeof r.left === "number" && typeof r.top === "number") {
                await dom.sendToBackground({
                  type: "BATCH_DISPATCH_CLICK_AT",
                  x: Math.round(r.left + r.width / 2),
                  y: Math.round(r.top + r.height / 2)
                });
                switched = !!(await dom.waitFor(hasSwitched, 700, 80));
                subPhotoId = parseCurrentPhotoId() || thumbKnownId;
              }
            }

            if (!switched && subPhotoId === beforeId) continue;
            if (subPhotoId) {
              recordObservedPhotoId(subPhotoId);
              if (alreadyDoneSet.has(subPhotoId)) continue;
            }

            logStep("stack_sub_start", `idx=${idx + 1}/${stackThumbs.length} id=${subPhotoId || "unknown"}`);
            if (usedTextareas.size > 0) {
              await dom.waitFor(() => {
                const distinctTa = dom.findVisibleDescriptionTextarea({
                  excludeEls: usedTextareas,
                  strictExclude: true
                });
                if (distinctTa) return distinctTa;
                const anyTa = dom.findVisibleDescriptionTextarea();
                return anyTa && (anyTa.value || "").trim() !== finalCaption.trim() ? anyTa : null;
              }, 700, 80);
            }

            if (isBatchAbortedNow()) break;
            await dom.ensureInfoPanelOpen();
            const subTa =
              dom.findVisibleDescriptionTextarea({ excludeEls: usedTextareas, strictExclude: true }) ||
              dom.findVisibleDescriptionTextarea({ excludeEls: usedTextareas });
            const subVal = subTa && typeof subTa.value === "string" ? subTa.value.trim() : "";
            const hasDifferentExisting =
              subTa && !usedTextareas.has(subTa) && subVal.length > 0 && subVal !== finalCaption.trim();

            if (shouldOverwrite || !hasDifferentExisting) {
              let subCapRes = await dom.runCaption({
                text: finalCaption,
                overwrite: true,
                forceWrite: true,
                excludeTextareas: usedTextareas
              });
              if (
                !subCapRes.success &&
                !isBatchAbortedNow() &&
                subCapRes.error !== "batch_aborted" &&
                !subCapRes.error?.startsWith("skipped_")
              ) {
                await dom.sleep(250);
                await dom.ensureInfoPanelOpen({ forceToggleIfNoTextarea: true });
                subCapRes = await dom.runCaption({
                  text: finalCaption,
                  overwrite: true,
                  forceWrite: true,
                  excludeTextareas: usedTextareas
                });
              }
              logStep("stack_sub_done", `idx=${idx + 1}/${stackThumbs.length} id=${subPhotoId || "unknown"} ok=${subCapRes.success}`);
              if (subCapRes.success) {
                if (subCapRes.textarea) usedTextareas.add(subCapRes.textarea);
                const doneId = parseCurrentPhotoId() || subPhotoId || `stack_idx_${idx}`;
                if (!doneId.startsWith("stack_idx_")) recordObservedPhotoId(doneId);
                captionedIds.add(doneId);
                alreadyDoneSet.add(doneId);
              }
            } else {
              logStep("stack_sub_skipped_existing", `idx=${idx + 1}/${stackThumbs.length} id=${subPhotoId || "unknown"}`);
              if (subPhotoId) alreadyDoneSet.add(subPhotoId);
            }
            await dom.sleep(200);
          }
        }
      } catch (e) {
        logStep("stack_error", String(e?.message || e));
      }

      timing.textareaVisibleMs = capRes.timing.textareaVisibleMs;
      timing.focusToInsertMs = capRes.timing.focusToInsertMs;
      timing.blurToSettleMs = capRes.timing.blurToSettleMs;
      timing.retried = capRes.timing.retried;

      const realCaptionedIds = Array.from(captionedIds).filter((id) => !id.startsWith("stack_idx_"));
      const extraStackPhotoIds =
        options.photoId && realCaptionedIds.includes(options.photoId)
          ? realCaptionedIds.filter((id) => id !== options.photoId)
          : realCaptionedIds.slice(1);
      const pendingStackIds = Array.from(discoveredStackIds).filter(
        (id) => !alreadyDoneSet.has(id) && !id.startsWith("stack_idx_")
      );

      const hasStackMeta = extraStackPhotoIds.length > 0 || pendingStackIds.length > 0;
      return finish(
        true,
        undefined,
        hasStackMeta
          ? JSON.stringify({
              extraCompletedIds: extraStackPhotoIds,
              pendingStackIds,
              captionedIds: realCaptionedIds,
              sharedCaption: finalCaption
            })
          : undefined
      );
    } finally {
      try {
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
          window.removeEventListener("popstate", onUserPageActivity, true);
          window.removeEventListener("click", onUserPageActivity, true);
        }
      } catch (e) {}
    }
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
